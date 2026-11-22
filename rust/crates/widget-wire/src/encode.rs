//! The host's encoder: the VM's value (a [`HostValue`] tree, as a host function receives it) straight into the binary
//! format, with no JSON text in between except for the generic data that stays JSON.

use std::borrow::Cow;
use std::time::{Duration, Instant};

use psychoscript::{Data, HostString, HostValue};

use crate::VERSION;
use crate::draw::{
    Cap, Color, Fill, Gradient, GradientShape, MAX_COMMANDS, Paint, TextAlign, TextOptions, Token,
};
use crate::json;
use crate::native::{Canvas, Found};
use crate::schema::*;

/// Why a value can't be written: a program error in the phase its kind names (`widgets-binary.md`, Errors).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodeError {
    /// `InvalidView`, `InvalidDraw` or `InvalidGpu` (phase `view`, `draw` or `gpu`); `InvalidDataValue` for a value
    /// that is none of those (an unknown post type, a step output that isn't an object).
    pub kind: &'static str,
    pub message: String,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for EncodeError {}

pub const INVALID_VIEW: &str = "InvalidView";
pub const INVALID_DRAW: &str = "InvalidDraw";
pub const INVALID_GPU: &str = "InvalidGpu";
pub const INVALID_DATA: &str = "InvalidDataValue";

/// A run's output, as one value: a draw step's `{ commands }` as `01 D`, an init or event step's
/// `{ state, view, submit?, dismiss?, send? }` as `01 S`, the view already the tree clients get. Fails for an invalid
/// draw (`InvalidDraw`) or a value that isn't a step output. (Protocol 1's output; a native host uses [`NativeStep`].)
pub fn encode_output(v: &HostValue) -> Result<Vec<u8>, EncodeError> {
    let v = &*as_json(v);
    let fail = |kind| move |message| EncodeError { kind, message };
    if !matches!(v, HostValue::Object(_)) {
        return Err(fail(INVALID_DATA)(
            "a step must return an object with state and view".into(),
        ));
    }
    let mut out = vec![VERSION];
    match field(v, "commands") {
        Some(commands) => draw_section(commands, &mut out).map_err(fail(INVALID_DRAW))?,
        None => {
            let send = field(v, "send")
                .filter(|s| matches!(s, HostValue::Object(_)))
                .map(|s| {
                    let value = field(s, "value").filter(|v| !json::skipped(v));
                    (
                        value.map_or_else(|| "null".into(), json::write),
                        !matches!(field(s, "wake"), Some(HostValue::Bool(false))),
                    )
                });
            step_head(
                &mut out,
                field(v, "state").map(json::write),
                field(v, "submit")
                    .filter(|s| !json::skipped(s))
                    .map(json::write),
                matches!(field(v, "dismiss"), Some(HostValue::Bool(true))),
                send,
            );
            let mut s = Streams::default();
            write_node(&mut s, field(v, "view").unwrap_or(&HostValue::Null), 0)
                .map_err(fail(INVALID_VIEW))?;
            s.finish_into(&mut out);
        }
    }
    Ok(out)
}

/// Why a native host's call fails, besides an invalid value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallError {
    /// A program error: the call throws it (uncaught, the run fails with its kind and message, at the call).
    Invalid(EncodeError),
    /// A function in argument `arg` (from 1) where none may go: the call throws the runtime's `TypeError`
    /// `Argument <arg> to <name> contains a function, which cannot be passed to the host.`
    Function { arg: usize },
    /// A key `encodeURIComponent` can't write: the call throws `URIError: URI malformed`.
    Uri,
    /// An `Error` with this message, which the program can catch (a draw for a key the last render has no canvas
    /// for, or a GPU canvas).
    Throw(String),
    /// The view breaks Keys and depth, or the prelude says so: a program error in phase `view` with this message,
    /// which ends a live run at once; the call doesn't throw.
    View(String),
    /// A program error that ends a live run at once, the call not throwing (a draw post without a string key).
    End(EncodeError),
}

impl From<crate::native::Stop> for CallError {
    fn from(s: crate::native::Stop) -> Self {
        match s {
            crate::native::Stop::View(m) => CallError::View(m.into()),
            crate::native::Stop::Function => CallError::Function { arg: 1 },
            crate::native::Stop::Uri => CallError::Uri,
        }
    }
}

/// A native host's step (`widgets.md`, Native hosts). In an `init` or `event` step, `__widget_emit(view, failure?)`
/// gives the view as built, which is walked as it is encoded, and the run's result the rest of the output
/// ([`NativeStep::finish`]). In a `draw` step, `__widget_emit(commands)` gives the commands, and the run has no result.
#[derive(Debug, Default)]
pub struct NativeStep {
    draw: bool,
    view: Option<Vec<u8>>,
    failure: Option<String>,
    commands: Option<Result<Vec<u8>, EncodeError>>,
}

impl NativeStep {
    /// A step of the phase the host asked for: `draw`, or `init` and `event`.
    pub fn new(draw: bool) -> NativeStep {
        NativeStep {
            draw,
            ..NativeStep::default()
        }
    }

    /// `__widget_emit`'s arguments. A view breaking Keys and depth (or a failure the prelude passes) is kept for
    /// [`NativeStep::failure`], not thrown; so is a draw's failure, for [`NativeStep::finish`].
    pub fn emit(&mut self, args: &[HostValue]) -> Result<(), CallError> {
        if self.draw {
            // Read as JSON reads them (markers left out of objects, `null` in arrays), then checked as a draw output.
            let commands = args.first().unwrap_or(&HostValue::Undefined);
            let commands = match crate::native::marked(commands) {
                true => Cow::Owned(unmark(commands)),
                false => as_json(commands),
            };
            let mut out = vec![VERSION];
            self.commands = Some(draw_section(&commands, &mut out).map(|()| out).map_err(
                |message| EncodeError {
                    kind: INVALID_DRAW,
                    message,
                },
            ));
            return Ok(());
        }
        let view = args.first().unwrap_or(&HostValue::Undefined);
        let failure = args.get(1).unwrap_or(&HostValue::Undefined);
        if let Some(arg) = args.iter().skip(2).position(crate::native::marked) {
            return Err(CallError::Function { arg: arg + 3 });
        }
        if let HostValue::String(f) = failure {
            self.failure = Some(f.to_string_lossy().into_owned());
            return Ok(());
        }
        if crate::native::marked(failure) {
            return Err(CallError::Function { arg: 2 });
        }
        let mut s = Streams::default();
        match crate::native::walk(Some(&mut s), view) {
            Ok(_) => {
                let mut out = Vec::new();
                s.finish_into(&mut out);
                self.view = Some(out);
                self.failure = None;
                Ok(())
            }
            Err(crate::native::Stop::View(m)) => {
                self.failure = Some(m.into());
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// The view's failure, a program error in phase `view` that fails the step whatever the run did.
    pub fn failure(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    /// The step's bytes: `01 S` from the run's result (markers in it left out, as JSON leaves functions out) and the
    /// emitted view, or for a draw step `01 D` from the emitted commands.
    pub fn finish(&self, result: &Data) -> Result<Vec<u8>, EncodeError> {
        let fail = |kind| move |message| EncodeError { kind, message };
        if self.draw {
            return self
                .commands
                .clone()
                .unwrap_or_else(|| Err(fail(INVALID_DRAW)("draw commands must be a list".into())));
        }
        let mut out = vec![VERSION];
        let Some(view) = &self.view else {
            return Err(fail(INVALID_DATA)("The step gave no view".into()));
        };
        if !matches!(result, Data::Object(_)) {
            return Err(fail(INVALID_DATA)(
                "a step must return an object with state and view".into(),
            ));
        }
        let get = |d: &'_ Data, k: &str| {
            d.get(k)
                .filter(|v| !matches!(v, Data::FunctionMarker))
                .cloned()
        };
        let send = get(result, "send")
            .filter(|s| matches!(s, Data::Object(_)))
            .map(|s| {
                (
                    get(&s, "value").map_or_else(|| "null".into(), |v| v.to_json_string()),
                    !matches!(get(&s, "wake"), Some(Data::Bool(false))),
                )
            });
        step_head(
            &mut out,
            get(result, "state").map(|v| v.to_json_string()),
            get(result, "submit").map(|v| v.to_json_string()),
            matches!(get(result, "dismiss"), Some(Data::Bool(true))),
            send,
        );
        out.extend_from_slice(view);
        Ok(out)
    }
}

/// `v` as JSON reads it: function markers left out of objects and `null` in arrays, other values as their JSON.
fn unmark(v: &HostValue) -> HostValue {
    match v {
        HostValue::Array(items) => HostValue::Array(
            items
                .iter()
                .map(|i| match i {
                    Some(HostValue::FunctionMarker) => Some(HostValue::Null),
                    i => i.as_ref().map(unmark),
                })
                .collect(),
        ),
        HostValue::Object(fields) => HostValue::Object(
            fields
                .iter()
                .filter(|(_, v)| !matches!(v, HostValue::FunctionMarker))
                .map(|(k, v)| (k.clone(), unmark(v)))
                .collect(),
        ),
        HostValue::FunctionMarker => HostValue::Undefined,
        v => json_view(v),
    }
}

/// The post rate (`widgets-live.md`, Post rate): a bucket of this many tokens, refilled at [`POSTS_PER_SECOND`].
pub const BURST: f64 = 8.0;
pub const POSTS_PER_SECOND: f64 = 240.0;
const EPSILON: f64 = 1e-9;
/// The failure of a draw post without a canvas key (an invalid post, phase `main`).
pub const DRAW_KEY: &str = "A draw post needs a string key";

/// A native host's live posts (`widgets-live.md`): each render is walked as it is encoded, a draw names its canvas by
/// key, which the last render's canvases map to the canvas's id, and `render` and `draw` posts go to the client under
/// the post rate. Every post is checked and encoded when the program posts it; only its delivery waits.
#[derive(Debug)]
pub struct LivePosts {
    last: Found,
    per_second: f64,
    tokens: f64,
    at: Option<Instant>,
    /// The counted posts waiting for a token, oldest first: the render (`None`) and a draw per canvas key.
    waiting: Vec<(Option<String>, Vec<u8>)>,
    /// A frame request went out and no frame came since.
    frame: bool,
}

impl Default for LivePosts {
    fn default() -> Self {
        LivePosts::with_rate(POSTS_PER_SECOND)
    }
}

impl LivePosts {
    pub fn new() -> LivePosts {
        LivePosts::default()
    }

    /// Under a post rate of `per_second` (the spec's is [`POSTS_PER_SECOND`]).
    pub fn with_rate(per_second: f64) -> LivePosts {
        LivePosts {
            last: Found::default(),
            per_second,
            tokens: BURST,
            at: None,
            waiting: Vec::new(),
            frame: false,
        }
    }

    /// What the last render found: its handler ids and canvases.
    pub fn last_render(&self) -> &Found {
        &self.last
    }

    /// Takes the canvases of a render before a snapshot (`last_render().canvases`), for draws after a restore.
    pub fn restore_canvases(&mut self, canvases: Vec<Canvas>) {
        self.last.canvases = canvases;
    }

    /// `message`, posted at `now`: the bytes to hand to the client now (none, or several when a `submit` or `dismiss`
    /// releases the waiting posts ahead of itself), and for a render whether its view has a handler, which `post`
    /// returns.
    pub fn post(
        &mut self,
        m: &HostValue,
        now: Instant,
    ) -> Result<(Vec<Vec<u8>>, Option<bool>), CallError> {
        let invalid = |kind| {
            move |e: String| {
                CallError::Invalid(EncodeError {
                    kind,
                    message: format!("invalid post: {e}"),
                })
            }
        };
        let fields = match m {
            HostValue::Object(fields) => &fields[..],
            _ => &[],
        };
        let rest_marked = |skip: &[&str]| {
            fields.iter().any(|(k, v)| {
                !k.as_str().is_some_and(|k| skip.contains(&k)) && crate::native::marked(v)
            })
        };
        let ty = field(m, "type").and_then(HostValue::as_str);
        match ty {
            Some("render") => {
                if let Some(HostValue::String(f)) = field(m, "failure") {
                    return Err(CallError::View(f.to_string_lossy().into_owned()));
                }
                let node = field(m, "node").unwrap_or(&HostValue::Undefined);
                let mut s = Streams::default();
                let found = crate::native::walk(Some(&mut s), node)?;
                if rest_marked(&["node"]) {
                    return Err(CallError::Function { arg: 1 });
                }
                let handled = !found.handlers.is_empty();
                self.last = found;
                let mut out = vec![VERSION, RENDER];
                s.finish_into(&mut out);
                Ok((self.counted(None, out, now), Some(handled)))
            }
            Some("draw") => {
                let Some(HostValue::String(key)) = field(m, "key") else {
                    return Err(CallError::End(EncodeError {
                        kind: INVALID_DATA,
                        message: DRAW_KEY.into(),
                    }));
                };
                let key = key.to_string_lossy().into_owned();
                let Some(canvas) = self.last.canvases.iter().find(|c| c.key == key) else {
                    return Err(CallError::Throw(format!(
                        "No canvas with key \"{key}\" in the rendered view"
                    )));
                };
                if canvas.wgsl {
                    return Err(CallError::Throw(format!(
                        "Canvas \"{key}\" is drawn by its wgsl; it takes no draw commands"
                    )));
                }
                if rest_marked(&[]) {
                    return Err(CallError::Function { arg: 1 });
                }
                let m = &*as_json(m);
                let mut out = vec![VERSION, DRAW];
                put_str(&mut out, &canvas.id);
                let commands = field(m, "commands")
                    .ok_or_else(|| invalid(INVALID_DRAW)("a draw post needs commands".into()))?;
                draw_section(commands, &mut out).map_err(invalid(INVALID_DRAW))?;
                Ok((self.counted(Some(key), out, now), None))
            }
            _ if crate::native::marked(m) => Err(CallError::Function { arg: 1 }),
            // A frame request while one is pending changes nothing, but the GPU batch it carries still goes.
            Some("frame") if self.frame => {
                match field(m, "gpu").filter(|g| !matches!(g, HostValue::Null)) {
                    Some(batch) => {
                        let mut out = vec![VERSION, GPU];
                        crate::gpu::encode(batch, &mut out).map_err(invalid(INVALID_GPU))?;
                        Ok((vec![out], None))
                    }
                    None => Ok((Vec::new(), None)),
                }
            }
            _ => {
                let bytes = encode_post(m).map_err(CallError::Invalid)?;
                self.frame |= ty == Some("frame");
                let mut out = match ty {
                    Some("submit" | "dismiss") => self.release(),
                    _ => Vec::new(),
                };
                out.push(bytes);
                Ok((out, None))
            }
        }
    }

    /// A message the client delivered to the program: a `frame` answers the pending frame request.
    pub fn delivered(&mut self, m: &HostValue) {
        if field(m, "type").and_then(HostValue::as_str) == Some("frame") {
            self.frame = false;
        }
    }

    /// The waiting posts whose tokens came by `now`, in order.
    pub fn due(&mut self, now: Instant) -> Vec<Vec<u8>> {
        self.refill(now);
        let mut out = Vec::new();
        while !self.waiting.is_empty() && self.tokens >= 1.0 - EPSILON {
            self.tokens -= 1.0;
            out.push(self.waiting.remove(0).1);
        }
        out
    }

    /// When the next waiting post's token comes, if a post waits.
    pub fn next_due(&self) -> Option<Instant> {
        let at = self.at?;
        (!self.waiting.is_empty())
            .then(|| at + Duration::from_secs_f64((1.0 - self.tokens).max(0.0) / self.per_second))
    }

    /// Every waiting post, at once, in order: the run ends by `submit`, `dismiss`, `main` returning or a program error.
    pub fn release(&mut self) -> Vec<Vec<u8>> {
        self.waiting.drain(..).map(|(_, bytes)| bytes).collect()
    }

    fn refill(&mut self, now: Instant) {
        let at = *self.at.get_or_insert(now);
        let elapsed = now.saturating_duration_since(at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.per_second).min(BURST);
        self.at = Some(now.max(at));
    }

    /// A `render` (`key` `None`) or `draw` under the rate: out at once when nothing waits and a token is there, else
    /// in place of the waiting post of its kind, or last.
    fn counted(&mut self, key: Option<String>, bytes: Vec<u8>, now: Instant) -> Vec<Vec<u8>> {
        self.refill(now);
        if self.waiting.is_empty() && self.tokens >= 1.0 - EPSILON {
            self.tokens -= 1.0;
            return vec![bytes];
        }
        match self.waiting.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = bytes,
            None => self.waiting.push((key, bytes)),
        }
        Vec::new()
    }
}

/// A live post (`__host.post(message)`). Fails for an invalid post: a render's view (`InvalidView`), a draw
/// (`InvalidDraw`), a GPU batch, invalid or over a limit (`InvalidGpu`), or an unknown type.
pub fn encode_post(m: &HostValue) -> Result<Vec<u8>, EncodeError> {
    let kind = match field(m, "type").and_then(HostValue::as_str) {
        Some("render") => INVALID_VIEW,
        Some("draw") => INVALID_DRAW,
        Some("gpu") => INVALID_GPU,
        Some("frame") if !matches!(field(m, "gpu"), None | Some(HostValue::Null)) => INVALID_GPU,
        _ => INVALID_DATA,
    };
    post(m).map_err(|e| EncodeError {
        kind,
        message: format!("invalid post: {e}"),
    })
}

fn post(m: &HostValue) -> Result<Vec<u8>, String> {
    // A GPU batch keeps its bytes as they are; its ops are written as JSON reads them (`gpu::put_arg`).
    let gpu = match field(m, "type").and_then(HostValue::as_str) {
        Some("gpu") => true,
        Some("frame") => !matches!(field(m, "gpu"), None | Some(HostValue::Null)),
        _ => false,
    };
    let json;
    let m = if gpu {
        m
    } else {
        json = as_json(m);
        &*json
    };
    let Some(ty) = field(m, "type").and_then(HostValue::as_str) else {
        return Err("a post is an object with a type".into());
    };
    let mut out = vec![VERSION];
    match ty {
        "render" => {
            out.push(RENDER);
            let mut s = Streams::default();
            write_node(&mut s, field(m, "node").unwrap_or(&HostValue::Null), 0)?;
            s.finish_into(&mut out);
        }
        "draw" => {
            out.push(DRAW);
            let Some(HostValue::String(id)) = field(m, "id") else {
                return Err("a draw post needs its canvas's id".into());
            };
            put_str(&mut out, &id.to_string_lossy());
            let commands = field(m, "commands").ok_or("a draw post needs commands")?;
            draw_section(commands, &mut out)?;
        }
        "frame" => match field(m, "gpu").filter(|g| !matches!(g, HostValue::Null)) {
            Some(batch) => {
                out.push(FRAME_GPU);
                crate::gpu::encode(batch, &mut out)?;
            }
            None => out.push(FRAME),
        },
        "gpu" => {
            out.push(GPU);
            crate::gpu::encode(m, &mut out)?;
        }
        "submit" => {
            out.push(SUBMIT);
            put_str(
                &mut out,
                &json::write(field(m, "value").unwrap_or(&HostValue::Null)),
            );
        }
        "dismiss" => out.push(DISMISS),
        "send" => {
            out.push(SEND);
            out.push(!matches!(field(m, "wake"), Some(HostValue::Bool(false))) as u8);
            put_str(
                &mut out,
                &json::write(field(m, "value").unwrap_or(&HostValue::Null)),
            );
        }
        "capture" => {
            out.push(CAPTURE);
            out.push(matches!(field(m, "value"), Some(HostValue::Bool(true))) as u8);
        }
        other => return Err(format!("unknown post type \"{other}\"")),
    }
    Ok(out)
}

/// Whether JSON reads `v` as it is: it holds no value of a kind JSON writes as something else (a Date as its ISO
/// string, a URL as its href, a Set as an array, a Map or a typed array as an object).
fn plain(v: &HostValue) -> bool {
    match v {
        HostValue::Undefined
        | HostValue::Null
        | HostValue::Bool(_)
        | HostValue::Number(_)
        | HostValue::String(_)
        | HostValue::FunctionMarker => true,
        HostValue::Array(items) => items.iter().flatten().all(plain),
        HostValue::Object(fields) => fields.iter().all(|(_, v)| plain(v)),
        _ => false,
    }
}

/// `v` as the JSON path writes it (`HostValue::to_json`), so both read the same values.
pub(crate) fn json_value(v: &HostValue) -> Cow<'_, HostValue> {
    as_json(v)
}

fn as_json(v: &HostValue) -> Cow<'_, HostValue> {
    if plain(v) {
        Cow::Borrowed(v)
    } else {
        Cow::Owned(json_view(v))
    }
}

/// Arrays and objects as they are, other values as their JSON.
fn json_view(v: &HostValue) -> HostValue {
    match v {
        HostValue::Array(items) => {
            HostValue::Array(items.iter().map(|i| i.as_ref().map(json_view)).collect())
        }
        HostValue::Object(fields) => HostValue::Object(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), json_view(v)))
                .collect(),
        ),
        HostValue::Undefined
        | HostValue::Null
        | HostValue::Bool(_)
        | HostValue::Number(_)
        | HostValue::String(_)
        | HostValue::FunctionMarker => v.clone(),
        other => other
            .to_json()
            .map_or(HostValue::Undefined, |j| HostValue::from_json(&j)),
    }
}

/// An object's field, absent when `undefined` (as JSON leaves it out).
pub(crate) fn field<'a>(v: &'a HostValue, key: &str) -> Option<&'a HostValue> {
    v.get(key).filter(|v| !matches!(v, HostValue::Undefined))
}

/// A field unless JSON writes it as `null` or leaves it out (`undefined`, `null`, a non-finite number).
fn present<'a>(v: &'a HostValue, key: &str) -> Option<&'a HostValue> {
    field(v, key).filter(|v| match v {
        HostValue::Null => false,
        HostValue::Number(n) => n.is_finite(),
        _ => true,
    })
}

pub(crate) fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

pub(crate) fn put_str(out: &mut Vec<u8>, s: &str) {
    varint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn lossy(s: &HostString) -> Cow<'_, str> {
    s.to_string_lossy()
}

// ---- steps and views ----

/// `S`, its flags and its JSON: `state`, then `submit` and `send`'s value when present, each as JSON text.
fn step_head(
    out: &mut Vec<u8>,
    state: Option<String>,
    submit: Option<String>,
    dismiss: bool,
    send: Option<(String, bool)>,
) {
    let wake = send.as_ref().is_some_and(|(_, wake)| *wake);
    out.push(STEP);
    out.push(
        submit.is_some() as u8
            | (dismiss as u8) << 1
            | (send.is_some() as u8) << 2
            | (wake as u8) << 3,
    );
    put_str(out, state.as_deref().unwrap_or("null"));
    if let Some(submit) = submit {
        put_str(out, &submit);
    }
    if let Some((value, _)) = send {
        put_str(out, &value);
    }
}

/// Section `N`'s three streams.
#[derive(Default)]
pub(crate) struct Streams {
    ints: Vec<u8>,
    floats: Vec<u8>,
    strs: Vec<u8>,
}

impl Streams {
    pub(crate) fn int(&mut self, v: u32) {
        varint(&mut self.ints, v as u64);
    }
    fn f64(&mut self, v: f64) {
        self.floats.extend_from_slice(&v.to_le_bytes());
    }
    pub(crate) fn str(&mut self, s: &str) {
        put_str(&mut self.strs, s);
    }
    pub(crate) fn tag(&mut self, id: u32, kind: u32) {
        self.int(id << 3 | kind);
    }
    pub(crate) fn finish_into(&self, out: &mut Vec<u8>) {
        out.reserve(31 + self.ints.len() + self.floats.len() + self.strs.len());
        out.push(b'N');
        varint(out, self.ints.len() as u64);
        varint(out, self.floats.len() as u64);
        varint(out, self.strs.len() as u64);
        out.extend_from_slice(&self.ints);
        out.extend_from_slice(&self.floats);
        out.extend_from_slice(&self.strs);
    }
}

fn finite(v: &HostValue) -> Option<f64> {
    match v {
        HostValue::Number(n) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn strings(items: &[Option<HostValue>]) -> Option<Vec<Cow<'_, str>>> {
    items
        .iter()
        .map(|i| match i {
            Some(HostValue::String(s)) => Some(lossy(s)),
            _ => None,
        })
        .collect()
}

/// A select option's value, label and description.
type SelectOption<'a> = (Cow<'a, str>, Cow<'a, str>, Option<Cow<'a, str>>);

/// A select option's fields, when it has the shape the format writes.
fn option(o: &Option<HostValue>) -> Option<SelectOption<'_>> {
    let o = o.as_ref()?;
    if !matches!(o, HostValue::Object(_)) {
        return None;
    }
    let text = |k: &str| match field(o, k) {
        Some(HostValue::String(s)) => Some(lossy(s)),
        _ => None,
    };
    let description = match field(o, "description") {
        None | Some(HostValue::Null) => None,
        Some(HostValue::String(s)) => Some(lossy(s)),
        Some(_) => return None,
    };
    Some((text("value")?, text("label")?, description))
}

/// One prop, when the format knows its key and its value has a shape the prop takes; otherwise it's left out.
pub(crate) fn prop(s: &mut Streams, key: &str, v: &HostValue) {
    let id = prop_id(key);
    if id == 0 {
        return;
    }
    match (shape(id), v) {
        (Shape::F64 | Shape::Value | Shape::Inset, HostValue::Number(n)) if n.is_finite() => {
            s.tag(id, K_F64);
            s.f64(*n);
        }
        (Shape::Bool, HostValue::Bool(b)) => {
            s.tag(id, K_INT);
            s.int(*b as u32);
        }
        (Shape::Str | Shape::Value, HostValue::String(t)) => {
            s.tag(id, K_STR);
            s.str(&lossy(t));
        }
        (Shape::Enum(table), HostValue::String(t)) => {
            if let Some(i) = t.as_str().and_then(|t| table.iter().position(|e| *e == t)) {
                s.tag(id, K_INT);
                s.int(i as u32);
            }
        }
        (Shape::Value, HostValue::Array(items)) => {
            if let Some(list) = strings(items) {
                s.tag(id, K_STRS);
                s.int(list.len() as u32);
                for t in list {
                    s.str(&t);
                }
            }
        }
        (Shape::F64s, HostValue::Array(items)) => {
            if let Some(list) = items
                .iter()
                .map(|i| i.as_ref().and_then(finite))
                .collect::<Option<Vec<f64>>>()
            {
                s.tag(id, K_F64S);
                s.int(list.len() as u32);
                for n in list {
                    s.f64(n);
                }
            }
        }
        (Shape::Inset, HostValue::Object(_)) => {
            let side = |k: &str| match field(v, k) {
                None => Some(0.0),
                Some(n) => finite(n),
            };
            if let (Some(t), Some(r), Some(b), Some(l)) =
                (side("top"), side("right"), side("bottom"), side("left"))
            {
                s.tag(id, K_F64S);
                s.int(4);
                for n in [t, r, b, l] {
                    s.f64(n);
                }
            }
        }
        (Shape::Options, HostValue::Array(items)) => {
            if let Some(list) = items.iter().map(option).collect::<Option<Vec<_>>>() {
                s.tag(id, K_OPTS);
                s.int(list.len() as u32);
                for (value, label, description) in list {
                    s.int(description.is_some() as u32);
                    s.str(&value);
                    s.str(&label);
                    if let Some(d) = description {
                        s.str(&d);
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn too_deep() -> String {
    format!("the view nests deeper than {MAX_DEPTH} levels")
}

/// Children flattened, with `null`, `false`, `undefined` and holes dropped, as clients read them.
fn flat_children<'a>(
    items: &'a [Option<HostValue>],
    out: &mut Vec<&'a HostValue>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(too_deep());
    }
    for i in items {
        match i {
            Some(HostValue::Array(nested)) => flat_children(nested, out, depth + 1)?,
            None | Some(HostValue::Null | HostValue::Undefined | HostValue::Bool(false)) => {}
            Some(v) => out.push(v),
        }
    }
    Ok(())
}

pub(crate) fn write_node(s: &mut Streams, v: &HostValue, depth: usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(too_deep());
    }
    let HostValue::Object(fields) = v else {
        s.int(T_UNKNOWN);
        s.int(0);
        s.str("");
        return Ok(());
    };
    let name = match field(v, "type") {
        Some(HostValue::String(t)) => lossy(t),
        _ => Cow::Borrowed(""),
    };
    let t = type_id(&name);
    s.int(t);
    if t == T_UNKNOWN {
        s.int(0);
        s.str(&name);
        return Ok(());
    }
    let mut kids: &[Option<HostValue>] = &[];
    for (k, v) in fields {
        let Some(k) = k.as_str() else { continue };
        match k {
            "type" => {}
            "children" => {
                if let HostValue::Array(items) = v {
                    kids = items;
                }
            }
            _ => prop(s, k, v),
        }
    }
    s.int(0);
    if is_container(t) {
        let mut list = Vec::new();
        flat_children(kids, &mut list, depth + 1)?;
        s.int(list.len() as u32);
        for c in list {
            write_node(s, c, depth + 1)?;
        }
    }
    Ok(())
}

// ---- draw commands ----

/// Section `D`'s streams.
#[derive(Default)]
struct DrawStreams {
    ints: Vec<u8>,
    floats: Vec<u8>,
    strs: Vec<u8>,
    commands: u32,
}

impl DrawStreams {
    fn i(&mut self, v: u32) {
        self.ints.extend_from_slice(&v.to_le_bytes());
    }
    fn f(&mut self, v: f32) {
        self.floats.extend_from_slice(&v.to_le_bytes());
    }
    fn s(&mut self, t: &str) {
        put_str(&mut self.strs, t);
    }
    fn finish_into(&self, out: &mut Vec<u8>) -> Result<(), String> {
        let count = |n: usize| u32::try_from(n).map_err(|_| "the drawing is too large".to_owned());
        out.reserve(17 + self.ints.len() + self.floats.len() + self.strs.len());
        out.push(b'D');
        for n in [
            self.commands,
            count(self.ints.len() / 4)?,
            count(self.floats.len() / 4)?,
            count(self.strs.len())?,
        ] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        out.extend_from_slice(&self.ints);
        out.extend_from_slice(&self.floats);
        out.extend_from_slice(&self.strs);
        Ok(())
    }
}

/// A command list as section `D`, held to the budget and to Rune's rules for commands (`Command::from_value`).
pub(crate) fn draw_section(commands: &HostValue, out: &mut Vec<u8>) -> Result<(), String> {
    let HostValue::Array(list) = commands else {
        return Err("draw commands must be a list".into());
    };
    if list.len() > MAX_COMMANDS {
        return Err(format!(
            "{} draw commands is over the budget of {MAX_COMMANDS} per frame",
            list.len()
        ));
    }
    let mut d = DrawStreams::default();
    for (i, c) in list.iter().enumerate() {
        command(&mut d, c).map_err(|e| format!("draw command {i}: {e}"))?;
    }
    d.finish_into(out)
}

fn num(v: Option<&Option<HostValue>>, what: &str) -> Result<f32, String> {
    match v {
        Some(Some(HostValue::Number(n))) if n.is_finite() => Ok(*n as f32),
        _ => Err(format!("{what} must be a finite number")),
    }
}

fn color(v: &HostValue) -> Result<Color, String> {
    match v {
        HostValue::String(s) => Color::parse(&lossy(s)),
        _ => None,
    }
    .ok_or_else(|| "not a color".to_owned())
}

fn gradient(m: &HostValue) -> Result<Gradient, String> {
    let coords = |key: &str, n: usize| -> Result<Option<Vec<f32>>, String> {
        let Some(a) = field(m, key) else {
            return Ok(None);
        };
        match a {
            HostValue::Array(a) if a.len() == n => a
                .iter()
                .map(|x| num(Some(x), key))
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            _ => Err(format!("a {key} gradient takes {n} numbers")),
        }
    };
    let shape = match (coords("linear", 4)?, coords("radial", 3)?) {
        (Some(c), _) => GradientShape::Linear([c[0], c[1], c[2], c[3]]),
        (None, Some(c)) => GradientShape::Radial([c[0], c[1], c[2]]),
        (None, None) => return Err("a gradient needs linear or radial".into()),
    };
    let Some(HostValue::Array(stops)) = field(m, "stops") else {
        return Err("a gradient needs stops".into());
    };
    let stops = stops
        .iter()
        .map(|s| match s {
            Some(HostValue::Array(p)) if p.len() == 2 => Ok((
                num(p.first(), "a stop's offset")?.clamp(0.0, 1.0),
                color(p[1].as_ref().unwrap_or(&HostValue::Null))?,
            )),
            _ => Err("a stop is [offset, color]".to_owned()),
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Gradient { shape, stops })
}

fn paint(v: Option<&Option<HostValue>>) -> Result<Paint, String> {
    let Some(Some(m @ HostValue::Object(_))) = v else {
        return Err("a paint is an object".into());
    };
    let fill = match present(m, "fill") {
        None => None,
        Some(g @ HostValue::Object(_)) => Some(Fill::Gradient(gradient(g)?)),
        Some(c) => Some(Fill::Color(color(c)?)),
    };
    let stroke = present(m, "stroke").map(color).transpose()?;
    let width = match present(m, "width") {
        None => 1.0,
        Some(HostValue::Number(n)) => (*n as f32).max(0.0),
        Some(_) => return Err("a stroke's width must be a finite number".into()),
    };
    let cap = if field(m, "cap").and_then(HostValue::as_str) == Some("round") {
        Cap::Round
    } else {
        Cap::Butt
    };
    Ok(Paint {
        fill,
        stroke,
        width,
        cap,
    })
}

fn text_options(v: Option<&Option<HostValue>>) -> Result<TextOptions, String> {
    let m = match v {
        Some(Some(m @ HostValue::Object(_))) => m,
        _ => &HostValue::Null,
    };
    let g = |k: &str| present(m, k);
    Ok(TextOptions {
        size: match g("size") {
            Some(HostValue::Number(n)) => (*n as f32).clamp(1.0, 512.0),
            Some(_) => return Err("a text size must be a finite number".into()),
            None => 13.0,
        },
        // As JSON reads it: an integer JSON writes as one (below 9e15), else 400.
        weight: g("weight")
            .and_then(HostValue::as_f64)
            .filter(|w| *w >= 0.0 && w.fract() == 0.0 && *w < 9.0e15)
            .map_or(400, |w| ((w as u64).clamp(100, 900) / 100 * 100) as u16),
        align: match g("align").and_then(HostValue::as_str) {
            Some("center") => TextAlign::Center,
            Some("right") => TextAlign::Right,
            _ => TextAlign::Left,
        },
        color: g("color").map(color).transpose()?,
        mono: matches!(g("mono"), Some(HostValue::Bool(true))),
    })
}

fn token_id(t: Token) -> u32 {
    match t {
        Token::Text => 1,
        Token::Muted => 2,
        Token::Accent => 3,
        Token::Bg => 4,
        Token::Surface => 5,
        Token::Border => 6,
        Token::Success => 7,
        Token::Warning => 8,
        Token::Error => 9,
    }
}

fn put_color(d: &mut DrawStreams, c: Color) {
    match c {
        Color::Rgba(rgba) => {
            d.i(0);
            d.i(u32::from_be_bytes(rgba));
        }
        Color::Token(t) => {
            d.i(token_id(t));
            d.i(0);
        }
    }
}

fn put_paint(d: &mut DrawStreams, p: &Paint) {
    match &p.fill {
        None => d.i(0),
        Some(Fill::Color(c)) => {
            d.i(1);
            put_color(d, *c);
        }
        Some(Fill::Gradient(g)) => {
            match g.shape {
                GradientShape::Linear(c) => {
                    d.i(2);
                    d.i(g.stops.len() as u32);
                    c.iter().for_each(|v| d.f(*v));
                }
                GradientShape::Radial(c) => {
                    d.i(3);
                    d.i(g.stops.len() as u32);
                    c.iter().for_each(|v| d.f(*v));
                }
            }
            for (o, c) in &g.stops {
                d.f(*o);
                put_color(d, *c);
            }
        }
    }
    match p.stroke {
        None => d.i(0),
        Some(c) => {
            d.i(1);
            put_color(d, c);
        }
    }
    d.i((p.cap == Cap::Round) as u32);
    d.f(p.width);
}

fn command(d: &mut DrawStreams, v: &Option<HostValue>) -> Result<(), String> {
    let Some(HostValue::Array(a)) = v else {
        return Err("a command is an array".into());
    };
    let op = a
        .first()
        .and_then(|v| v.as_ref())
        .and_then(HostValue::as_str)
        .ok_or("a command starts with its name")?;
    let n = |i: usize| num(a.get(i), &format!("\"{op}\" argument {i}"));
    match op {
        "save" => d.i(1),
        "restore" => d.i(2),
        "translate" | "scale" => {
            let (x, y) = (n(1)?, n(2)?);
            d.i(if op == "translate" { 3 } else { 5 });
            d.f(x);
            d.f(y);
        }
        "rotate" => {
            let r = n(1)?;
            d.i(4);
            d.f(r);
        }
        "alpha" => {
            let a = n(1)?.clamp(0.0, 1.0);
            d.i(6);
            d.f(a);
        }
        "rect" | "rrect" | "circle" | "line" => {
            let (code, count) = match op {
                "rect" => (7, 4),
                "rrect" => (8, 5),
                "circle" => (9, 3),
                _ => (10, 4),
            };
            let coords = (1..=count).map(n).collect::<Result<Vec<_>, _>>()?;
            let paint = paint(a.get(count + 1))?;
            d.i(code);
            coords.into_iter().for_each(|c| d.f(c));
            put_paint(d, &paint);
        }
        "path" => {
            let Some(Some(HostValue::Array(segments))) = a.get(1) else {
                return Err("\"path\" takes a list of segments".into());
            };
            let mut verbs = Vec::with_capacity(segments.len());
            let mut coords = Vec::with_capacity(segments.len() * 2);
            for s in segments {
                let Some(HostValue::Array(s)) = s else {
                    return Err("a path segment is an array".into());
                };
                let (verb, count) = match s
                    .first()
                    .and_then(|v| v.as_ref())
                    .and_then(HostValue::as_str)
                {
                    Some("M") => (1, 2),
                    Some("L") => (2, 2),
                    Some("Q") => (3, 4),
                    Some("C") => (4, 6),
                    Some("Z") => (5, 0),
                    _ => return Err("unknown path segment".into()),
                };
                verbs.push(verb);
                for i in 1..=count {
                    coords.push(num(s.get(i), "a path coordinate")?);
                }
            }
            let paint = paint(a.get(2))?;
            d.i(11);
            d.i(verbs.len() as u32);
            verbs.into_iter().for_each(|v| d.i(v));
            coords.into_iter().for_each(|c| d.f(c));
            put_paint(d, &paint);
        }
        "text" => {
            let (x, y) = (n(1)?, n(2)?);
            let text = match a.get(3) {
                Some(Some(HostValue::String(t))) => lossy(t),
                Some(Some(other)) => Cow::Owned(json::write(other)),
                Some(None) => Cow::Borrowed("null"),
                None => return Err("\"text\" is missing argument 3".into()),
            };
            let style = text_options(a.get(4))?;
            d.i(12);
            d.f(x);
            d.f(y);
            d.s(&text);
            d.i(style.weight as u32);
            d.i(match style.align {
                TextAlign::Left => 0,
                TextAlign::Center => 1,
                TextAlign::Right => 2,
            });
            match style.color {
                None => d.i(0),
                Some(c) => {
                    d.i(1);
                    put_color(d, c);
                }
            }
            d.i(style.mono as u32);
            d.f(style.size);
        }
        "image" => {
            let src = match a.get(1) {
                Some(Some(HostValue::String(s))) => lossy(s),
                _ => return Err("\"image\" takes a src".into()),
            };
            let coords = (2..=5).map(n).collect::<Result<Vec<_>, _>>()?;
            d.i(13);
            d.s(&src);
            coords.into_iter().for_each(|c| d.f(c));
        }
        _ => return Err(format!("unknown draw command \"{op}\"")),
    }
    d.commands += 1;
    Ok(())
}
