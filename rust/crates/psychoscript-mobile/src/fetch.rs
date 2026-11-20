//! `__host.fetch(request)`: HTTPS requests under the live-widget capability rules, carried by the app's transport
//! (URLSession, OkHttp), so the system's TLS and proxies apply.
//!
//! The crate enforces the rules: `https:` only; the host on the run's allow-list (exact names, `*.` suffix wildcards,
//! `*` for any), checked again for every redirect, which the crate follows itself (at most 5); methods GET, POST, PUT,
//! PATCH, DELETE, HEAD; no `Cookie` header out and no `Set-Cookie` back; no localhost, private or link-local
//! destination; request body <= 256 KB, response body <= 2 MB; 15 s per request, redirects included; at most 4 in
//! flight and 10 a second per run. Rejections are errors with `kind` (`CapabilityDenied`, `Network`, `Timeout`,
//! `TooLarge`, `RateLimited`) and `message`.
//!
//! Destinations: a literal IP is checked as is; a name is resolved by the crate first and refused if any of its
//! addresses isn't public, and the address the transport reports having connected to (`remote_address`) is checked
//! again before the program sees the response. The transport resolves the name again itself, so a DNS answer that
//! changes in between (rebinding) can reach a private address; a transport that can resolve through
//! [`is_public_address`] (OkHttp's `Dns`) closes that gap.

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
    /// An `https:` URL whose host is allowed and resolves to public addresses.
    pub url: String,
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

    pub(crate) fn rate_limited(message: impl Into<String>) -> Rejection {
        Rejection::new("RateLimited", message)
    }

    pub(crate) fn value(self) -> HostValue {
        HostValue::Error(Box::new(
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

/// Whether `host` is on `allowed`: exact names, `*.` suffixes (not the bare domain), `*`.
pub(crate) fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    allowed.iter().any(|entry| {
        let entry = entry.trim().trim_end_matches('.').to_ascii_lowercase();
        match entry.strip_prefix("*.") {
            _ if entry == "*" => true,
            Some(suffix) => {
                host.len() > suffix.len() + 1
                    && host.ends_with(suffix)
                    && host[..host.len() - suffix.len()].ends_with('.')
            }
            None => host == entry,
        }
    })
}

/// A URL the run may reach: https, an allowed host, a public destination.
fn check_url(url: &Url, allowed: &[String]) -> Result<(), Rejection> {
    if url.scheme() != "https" {
        return Err(Rejection::denied(format!(
            "only https: URLs, not {}:",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Rejection::denied("URLs with credentials aren't allowed"));
    }
    let Some(host) = url.host() else {
        return Err(Rejection::denied("the URL has no host"));
    };
    let name = match host {
        url::Host::Domain(d) => d.to_owned(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    };
    if !host_allowed(&name, allowed) {
        return Err(Rejection::denied(format!(
            "{name} isn't among the hosts this widget may reach"
        )));
    }
    let port = url.port_or_known_default().unwrap_or(443);
    match host {
        url::Host::Ipv4(ip) if !public_v4(ip) => {
            Err(Rejection::denied(format!("{ip} isn't a public address")))
        }
        url::Host::Ipv6(ip) if !public(IpAddr::V6(ip)) => {
            Err(Rejection::denied(format!("{ip} isn't a public address")))
        }
        url::Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") {
                return Err(Rejection::denied(format!("{d} is a local name")));
            }
            let addresses: Vec<_> = (d.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| Rejection::new("Network", format!("can't resolve {d}: {e}")))?
                .collect();
            match addresses.iter().find(|a| !public(a.ip())) {
                Some(a) => Err(Rejection::denied(format!(
                    "{d} resolves to {}, which isn't a public address",
                    a.ip()
                ))),
                None => Ok(()),
            }
        }
        _ => Ok(()),
    }
}

/// One fetch's place between its worker and the program's call.
#[derive(Default)]
pub(crate) struct Slot {
    pub(crate) result: Option<HostResult>,
    pub(crate) waker: Option<Waker>,
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
        check_url(&url, allowed)?;
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
        if let Some(addr) = &response.remote_address
            && !is_public_address(addr.clone())
        {
            return Err(Rejection::denied(format!(
                "{} connected to {addr}, which isn't a public address",
                url.host_str().unwrap_or("")
            )));
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
