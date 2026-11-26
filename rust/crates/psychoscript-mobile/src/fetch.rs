//! `__host.fetch(request)`: HTTPS requests under the live-widget capability rules, carried by the app's transport
//! (URLSession, OkHttp), so the system's TLS and proxies apply.
//!
//! The crate enforces the rules: `https:` only; the host on the run's allow-list (exact names, `*.` suffix wildcards,
//! `*` for any, each optionally with a `:port`), checked again for every redirect, which the crate follows itself (at
//! most 5); methods GET, POST, PUT, PATCH, DELETE, HEAD; no `Cookie` header out and no `Set-Cookie` back; no
//! localhost, private or link-local destination; request body <= 256 KB, response body <= 2 MB; 15 s per request,
//! redirects included; at most 4 in flight and 10 a second per run. Rejections are errors with `kind`
//! (`CapabilityDenied`, `Network`, `Timeout`, `TooLarge`, `RateLimited`) and `message`.
//!
//! Dev mode (`LiveOptions::allow_local_network`) also allows loopback, private and link-local destinations, and plain
//! `http:` to them, still only for declared hosts.
//!
//! Destinations are resolved once, by the crate: a literal IP is checked as is, a name's addresses must all pass, and
//! the transport gets them in [`FetchRequest::addresses`] to connect to and nothing else (OkHttp: a `Dns` returning
//! them). The address the transport reports having connected to (`remote_address`) is checked again before the
//! program sees the response; a transport that resolves the name itself (URLSession) can't promise to connect to a
//! checked address, so that report is its only check.

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::task::Waker;
use std::time::{Duration, Instant};

use psychoscript::{HostError, HostResult, HostString, HostValue};
use url::Url;

pub(crate) const MAX_REQUEST_BYTES: usize = 256 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const MAX_IN_FLIGHT: usize = 4;
pub(crate) const MAX_PER_SECOND: usize = 10;
const MAX_REDIRECTS: usize = 5;
const METHODS: [&str; 6] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
/// Request headers the program can't set: cookies, and what the transport owns.
const DROPPED_HEADERS: [&str; 12] = [
    "cookie",
    "cookie2",
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-connection",
];

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

/// One HTTP exchange for the transport to carry out.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FetchRequest {
    /// Pass it to [`FetchTransport::cancel`]'s calls' matching.
    pub id: u64,
    /// An `https:` URL (or `http:` to a local address in dev mode) whose host is allowed.
    pub url: String,
    /// The addresses the crate resolved the URL's host to and checked: connect to one of these, not to what the name
    /// resolves to later.
    pub addresses: Vec<String>,
    pub method: String,
    pub headers: Vec<HttpHeader>,
    pub body: Option<Vec<u8>>,
    /// Give up after this long.
    pub timeout_ms: u64,
    /// Stop reading the body past this many bytes (the crate refuses a longer one).
    pub max_response_bytes: u64,
}

/// What the transport got back, without following redirects.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FetchResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
    /// The IP address the transport connected to, when it knows it (URLSession's transaction metrics, OkHttp's
    /// `Connection`): checked to be public before the program sees anything.
    pub remote_address: Option<String>,
}

/// The app's HTTP transport. Implement it on an ephemeral session: no cookie store, no credential store, no client
/// certificates, redirects not followed (the crate follows them after checking each).
#[uniffi::export(with_foreign)]
pub trait FetchTransport: Send + Sync {
    /// Starts `request` and calls `completion` once, from any thread.
    fn start(&self, request: FetchRequest, completion: Arc<FetchCompletion>);
    /// The run no longer wants request `id` (timed out, or the run stopped): cancel it if it's still going.
    fn cancel(&self, id: u64);
}

/// Where a transport reports how a request went: exactly one of `succeed` or `fail`; later calls are ignored.
#[derive(Debug, uniffi::Object)]
pub struct FetchCompletion {
    tx: Mutex<Option<mpsc::Sender<Result<FetchResponse, String>>>>,
}

#[uniffi::export]
impl FetchCompletion {
    pub fn succeed(&self, response: FetchResponse) {
        if let Some(tx) = self.tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(Ok(response));
        }
    }

    /// The request failed before a response: no connection, TLS, cancelled. `message` reaches the program.
    pub fn fail(&self, message: String) {
        if let Some(tx) = self.tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(Err(message));
        }
    }
}

/// Whether `address` (an IPv4 or IPv6 literal) is a public unicast address a widget may reach: not loopback,
/// private, link-local, shared (CGNAT), unspecified, multicast or reserved. For transports that resolve names
/// themselves (OkHttp `Dns`).
#[uniffi::export]
pub fn is_public_address(address: String) -> bool {
    address
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(public)
}

fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => public_v4(v4),
            None => public_v6(v6),
        },
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && ip.octets()[2] == 0)
        || a >= 240)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xffc0) == 0xfec0
        || (first == 0x2001 && ip.segments()[1] == 0x0db8)
        || ip.to_ipv4().is_some_and(|v4| !public_v4(v4)))
}

/// A loopback, private (RFC 1918, CGNAT, IPv6 unique local) or link-local address: what dev mode adds.
fn local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => local_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => local_v4(v4),
            None => {
                let first = v6.segments()[0];
                v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
            }
        },
    }
}

fn local_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || (a == 100 && (64..128).contains(&b))
}

/// Whether a run may reach `ip`: public, or local in dev mode.
fn reachable(ip: IpAddr, local_network: bool) -> bool {
    public(ip) || (local_network && local(ip))
}

/// A rejection the program sees: an error with `kind` and `message`.
pub(crate) struct Rejection {
    kind: &'static str,
    message: String,
}

impl Rejection {
    fn new(kind: &'static str, message: impl Into<String>) -> Rejection {
        Rejection {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn denied(message: impl Into<String>) -> Rejection {
        Rejection::new("CapabilityDenied", message)
    }

    /// What the app's `on_warning` is told of a denial, `CapabilityDenied: <message>`; `None` for other rejections.
    pub(crate) fn denial(&self) -> Option<String> {
        (self.kind == "CapabilityDenied").then(|| format!("{}: {}", self.kind, self.message))
    }

    pub(crate) fn rate_limited(message: impl Into<String>) -> Rejection {
        Rejection::new("RateLimited", message)
    }

    /// What the program gets: an error with `kind` and `message`, located at the `fetch` call, and uncaught the run's
    /// error of kind `kind` (`thrown`).
    pub(crate) fn value(self, thrown: &crate::encoder::Thrown) -> HostValue {
        thrown.named(self.kind, &self.message);
        HostValue::Located(Box::new(
            HostError::named(self.kind, self.message.as_str())
                .with_field("kind", HostValue::String(self.kind.into())),
        ))
    }
}

/// A request as the program gave it, checked for shape.
pub(crate) struct Request {
    url: Url,
    method: String,
    headers: Vec<HttpHeader>,
    body: Option<Vec<u8>>,
}

impl Request {
    pub(crate) fn parse(value: Option<&HostValue>) -> Result<Request, Rejection> {
        let bad = |m: &str| Rejection::new("Network", format!("invalid request: {m}"));
        let Some(value) = value else {
            return Err(bad("expected { url, method?, headers?, body? }"));
        };
        let url = match value {
            HostValue::String(s) => s.to_string_lossy().into_owned(),
            _ => value
                .get("url")
                .and_then(HostValue::as_str)
                .ok_or_else(|| bad("no url"))?
                .to_owned(),
        };
        let url = Url::parse(&url).map_err(|e| bad(&format!("{url}: {e}")))?;
        let method = match value.get("method") {
            None | Some(HostValue::Undefined | HostValue::Null) => "GET".to_owned(),
            Some(m) => m
                .as_str()
                .ok_or_else(|| bad("method isn't a string"))?
                .to_ascii_uppercase(),
        };
        if !METHODS.contains(&method.as_str()) {
            return Err(Rejection::denied(format!(
                "method {method} isn't allowed (GET, POST, PUT, PATCH, DELETE, HEAD)"
            )));
        }
        let mut headers = Vec::new();
        if let Some(HostValue::Object(fields)) = value.get("headers") {
            for (name, v) in fields {
                let name = name.to_string_lossy().to_ascii_lowercase();
                let value = match v {
                    HostValue::String(s) => s.to_string_lossy().into_owned(),
                    HostValue::Number(n) => n.to_string(),
                    HostValue::Bool(b) => b.to_string(),
                    _ => continue,
                };
                if !DROPPED_HEADERS.contains(&name.as_str()) {
                    headers.push(HttpHeader { name, value });
                }
            }
        }
        let body = match (value.get("body"), value.get("body64")) {
            (Some(HostValue::String(s)), _) => Some(s.to_string_lossy().into_owned().into_bytes()),
            (_, Some(HostValue::String(s))) => Some(
                base64_decode(&s.to_string_lossy()).ok_or_else(|| bad("body64 isn't base64"))?,
            ),
            _ => None,
        };
        if body.as_ref().is_some_and(|b| b.len() > MAX_REQUEST_BYTES) {
            return Err(Rejection::new(
                "TooLarge",
                format!("the request body is over {} KB", MAX_REQUEST_BYTES / 1024),
            ));
        }
        Ok(Request {
            url,
            method,
            headers,
            body,
        })
    }
}

/// Whether `host` (and `port`) is on `allowed`: exact names, `*.` suffixes (not the bare domain), `*`; an entry with
/// a `:port` matches that port only.
pub(crate) fn host_allowed(host: &str, port: u16, allowed: &[String]) -> bool {
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    allowed.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        let (name, entry_port) = match entry.rsplit_once(':') {
            Some((name, p)) if !name.contains(':') || name.ends_with(']') => {
                (name, p.parse::<u16>().ok())
            }
            _ => (entry.as_str(), None),
        };
        if entry_port.is_some_and(|p| p != port) {
            return false;
        }
        let name = name.trim_matches(['[', ']']).trim_end_matches('.');
        match name.strip_prefix("*.") {
            _ if name == "*" => true,
            Some(suffix) => {
                host.len() > suffix.len() + 1
                    && host.ends_with(suffix)
                    && host[..host.len() - suffix.len()].ends_with('.')
            }
            None => host == name,
        }
    })
}

/// A URL the run may reach: https (or http to the local network in dev mode), an allowed host, a reachable
/// destination. Returns the checked addresses, resolved once.
fn check_url(url: &Url, allowed: &[String], local_network: bool) -> Result<Vec<IpAddr>, Rejection> {
    let http = match url.scheme() {
        "https" => false,
        "http" if local_network => true,
        scheme => {
            return Err(Rejection::denied(format!(
                "only https: URLs, not {scheme}:"
            )));
        }
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Rejection::denied("URLs with credentials aren't allowed"));
    }
    let Some(host) = url.host() else {
        return Err(Rejection::denied("the URL has no host"));
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let name = match &host {
        url::Host::Domain(d) => d.trim_end_matches('.').to_ascii_lowercase(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    };
    if !host_allowed(&name, port, allowed) {
        return Err(Rejection::denied(format!(
            "{name} isn't among the hosts this widget may reach"
        )));
    }
    let addresses: Vec<IpAddr> = match host {
        url::Host::Ipv4(ip) => vec![IpAddr::V4(ip)],
        url::Host::Ipv6(ip) => vec![IpAddr::V6(ip)],
        url::Host::Domain(_) => {
            if !local_network
                && (name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local"))
            {
                return Err(Rejection::denied(format!("{name} is a local name")));
            }
            let mut addresses: Vec<IpAddr> = (name.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| Rejection::new("Network", format!("can't resolve {name}: {e}")))?
                .map(|a| a.ip())
                .collect();
            addresses.dedup();
            addresses
        }
    };
    if addresses.is_empty() {
        return Err(Rejection::new("Network", format!("{name} has no address")));
    }
    for ip in &addresses {
        if !reachable(*ip, local_network) {
            let what = if local_network {
                "a public or local"
            } else {
                "a public"
            };
            return Err(Rejection::denied(format!(
                "{name} is at {ip}, which isn't {what} address"
            )));
        }
        if http && !local(*ip) {
            return Err(Rejection::denied(format!(
                "http: only to the local network, and {name} is at {ip}"
            )));
        }
    }
    Ok(addresses)
}

/// One fetch's place between its worker and the program's call.
#[derive(Default)]
pub(crate) struct Slot {
    pub(crate) result: Option<HostResult>,
    pub(crate) waker: Option<Waker>,
    /// A denial ([`Rejection::denial`]), told to the app with the result.
    pub(crate) denied: Option<String>,
}

/// A run's fetch budget: in flight, and started in the last second.
#[derive(Default)]
pub(crate) struct Budget {
    pub(crate) in_flight: usize,
    pub(crate) recent: VecDeque<Instant>,
}

impl Budget {
    pub(crate) fn admit(&mut self) -> Result<(), Rejection> {
        let now = Instant::now();
        while self
            .recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(1))
        {
            self.recent.pop_front();
        }
        if self.in_flight >= MAX_IN_FLIGHT {
            return Err(Rejection::rate_limited(format!(
                "at most {MAX_IN_FLIGHT} requests in flight"
            )));
        }
        if self.recent.len() >= MAX_PER_SECOND {
            return Err(Rejection::rate_limited(format!(
                "at most {MAX_PER_SECOND} requests a second"
            )));
        }
        self.in_flight += 1;
        self.recent.push_back(now);
        Ok(())
    }
}

static IDS: AtomicU64 = AtomicU64::new(1);

/// Carries out `request` through `transport` on the calling (worker) thread: checks, redirects, limits. `cancelled`
/// is checked between hops.
pub(crate) fn perform(
    transport: &dyn FetchTransport,
    allowed: &[String],
    local_network: bool,
    request: Request,
    cancelled: &dyn Fn() -> bool,
) -> Result<HostValue, Rejection> {
    let deadline = Instant::now() + TIMEOUT;
    let Request {
        mut url,
        mut method,
        mut headers,
        mut body,
    } = request;
    for hop in 0..=MAX_REDIRECTS {
        let addresses = check_url(&url, allowed, local_network)?;
        let id = IDS.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let completion = Arc::new(FetchCompletion {
            tx: Mutex::new(Some(tx)),
        });
        let left = deadline.saturating_duration_since(Instant::now());
        transport.start(
            FetchRequest {
                id,
                url: url.to_string(),
                addresses: addresses.iter().map(IpAddr::to_string).collect(),
                method: method.clone(),
                headers: headers.clone(),
                body: body.clone(),
                timeout_ms: left.as_millis() as u64,
                max_response_bytes: MAX_RESPONSE_BYTES as u64,
            },
            completion,
        );
        // Wait in short steps so a stopped run cancels promptly.
        let response = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                transport.cancel(id);
                return Err(Rejection::new(
                    "Timeout",
                    format!("no response within {} s", TIMEOUT.as_secs()),
                ));
            }
            if cancelled() {
                transport.cancel(id);
                return Err(Rejection::new("Network", "the run stopped"));
            }
            match rx.recv_timeout(left.min(Duration::from_millis(100))) {
                Ok(Ok(r)) => break r,
                Ok(Err(message)) => return Err(Rejection::new("Network", message)),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(Rejection::new(
                        "Network",
                        "the transport dropped the request",
                    ));
                }
            }
        };
        if let Some(addr) = &response.remote_address {
            // `[::1]`, `fe80::1%en0`: the address alone.
            let ip = addr
                .trim_matches(['[', ']'])
                .split('%')
                .next()
                .unwrap_or("")
                .parse::<IpAddr>()
                .ok();
            let http = url.scheme() == "http";
            if !ip.is_some_and(|ip| reachable(ip, local_network) && (!http || local(ip))) {
                return Err(Rejection::denied(format!(
                    "{} connected to {addr}, which this widget may not reach",
                    url.host_str().unwrap_or("")
                )));
            }
        }
        if response.body.len() > MAX_RESPONSE_BYTES {
            return Err(Rejection::new(
                "TooLarge",
                format!("the response body is over {} MB", MAX_RESPONSE_BYTES >> 20),
            ));
        }
        let location = response
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("location"))
            .map(|h| h.value.clone());
        match (response.status, location) {
            (301 | 302 | 303 | 307 | 308, Some(location)) => {
                if hop == MAX_REDIRECTS {
                    return Err(Rejection::new(
                        "Network",
                        format!("more than {MAX_REDIRECTS} redirects"),
                    ));
                }
                url = url.join(&location).map_err(|e| {
                    Rejection::new("Network", format!("bad redirect to {location}: {e}"))
                })?;
                if response.status == 303
                    || (matches!(response.status, 301 | 302) && method == "POST")
                {
                    method = if method == "HEAD" {
                        method
                    } else {
                        "GET".to_owned()
                    };
                    body = None;
                    headers.retain(|h| !h.name.starts_with("content-"));
                }
            }
            _ => return Ok(response_value(&url, response)),
        }
    }
    Err(Rejection::new(
        "Network",
        format!("more than {MAX_REDIRECTS} redirects"),
    ))
}

/// `{ status, url, headers, body | body64 }`: the body as text when it's UTF-8, else base64.
fn response_value(url: &Url, response: FetchResponse) -> HostValue {
    let mut headers: Vec<(HostString, HostValue)> = Vec::new();
    for h in response.headers {
        let name = h.name.to_ascii_lowercase();
        if name == "set-cookie" || name == "set-cookie2" {
            continue;
        }
        match headers
            .iter_mut()
            .find(|(k, _)| k.as_str() == Some(name.as_str()))
        {
            Some((_, HostValue::String(v))) => {
                *v = format!("{}, {}", v.to_string_lossy(), h.value).into()
            }
            _ => headers.push((name.into(), HostValue::String(h.value.into()))),
        }
    }
    let body = match String::from_utf8(response.body) {
        Ok(text) => ("body", HostValue::String(text.into())),
        Err(e) => (
            "body64",
            HostValue::String(base64_encode(e.as_bytes()).into()),
        ),
    };
    HostValue::object([
        ("status", HostValue::Number(response.status.into())),
        ("url", HostValue::String(url.as_str().into())),
        ("headers", HostValue::Object(headers)),
        body,
    ])
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut n, mut bits) = (0u32, 0);
    for c in text
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
    {
        let v = ALPHABET.iter().position(|a| *a == c)? as u32;
        n = (n << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
        }
    }
    Some(out)
}
