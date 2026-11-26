//! What the GPU tests share: a test-only encoder whose live posts own a [`LiveGpu`], with a plain post protocol, and
//! a handler that keeps what a run tells the app.
//!
//! The protocol (each field optional, handled in this order):
//! - `__host.post({ canvases: ["c", ...] })`: the canvases the program may draw (`LiveGpu::canvases`);
//! - `__host.post({ gpu: { ops, bytes } })`: a batch, `bytes` an `ArrayBuffer` (`LiveGpu::batch`), or
//!   `LiveGpu::shape_error` for one of the wrong shape;
//! - `__host.post({ frame: true })`: a frame request (`LiveGpu::end_frame`), handed to the app as `{"frame":true}`;
//! - `__host.post({ send: value })`: handed to the app as `{"send":value}`.
//!
//! `__input()` is the run's JSON input with `gpu` (`LiveGpu::input`) and the encoder's own fields added. A `canvas`
//! message the program receives gives the GPU its size (`LiveGpu::resize`).

#![allow(dead_code)]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psychoscript::{Data, HostValue, Json, TypedArray, TypedKind};
use psychoscript_gpu::{Arg, ErrorKind, SavedStop, SavedStops};
use psychoscript_mobile::gpu::LiveGpu;
use psychoscript_mobile::{
    EncodePosts, EncodeStep, EncodeValues, Failure, GpuCanvasState, LiveContext, LiveExit,
    LiveHandler, LiveOptions, LiveRun, LiveSurfaces, Program, Reject, ValueEncoder,
};
use serde_json::{Value, json};

/// The longest any wait for the run may take: a test fails then instead of hanging.
pub const WAIT: Duration = Duration::from_secs(20);

pub const CUBE: &str = include_str!("../../../psychoscript-gpu/tests/fixtures/gpu/cube.json");

/// The test encoder: `extra` are fields added to the program's input (values JSON can't carry, as `ArrayBuffer`s).
pub struct Encoder {
    extra: Vec<(String, HostValue)>,
}

pub fn encoder(extra: Vec<(String, HostValue)>) -> Arc<ValueEncoder> {
    ValueEncoder::new(Encoder { extra })
}

struct NoStep;

impl EncodeStep for NoStep {
    fn emit(&mut self, _args: &[HostValue]) -> Result<(), Reject> {
        Ok(())
    }
    fn failure(&self) -> Option<Failure> {
        None
    }
    fn finish(&self, _result: &Data) -> Result<Vec<u8>, Failure> {
        Ok(Vec::new())
    }
}

impl EncodeValues for Encoder {
    fn emit_name(&self) -> &str {
        "__emit"
    }
    fn step(&self, _input: &HostValue) -> Box<dyn EncodeStep> {
        Box::new(NoStep)
    }
    fn live(&self, ctx: LiveContext) -> Box<dyn EncodePosts> {
        Box::new(Posts {
            gpu: LiveGpu::new(ctx),
            keys: Vec::new(),
            extra: self.extra.clone(),
        })
    }
}

/// A live run's posts: what the program posts goes to its GPU.
struct Posts {
    gpu: Arc<LiveGpu>,
    /// The canvases last posted, for a snapshot.
    keys: Vec<String>,
    extra: Vec<(String, HostValue)>,
}

/// Left out of an object, `null` in a list, as JSON reads them.
fn skipped(v: &HostValue) -> bool {
    matches!(
        v,
        HostValue::Undefined
            | HostValue::Function(_)
            | HostValue::FunctionMarker
            | HostValue::Durable(_)
            | HostValue::Namespace(_)
    )
}

/// An op's argument as JSON reads it, but with numbers as they are (`NaN` and the infinities too).
pub fn arg(v: &HostValue) -> Arg {
    match v {
        HostValue::Bool(b) => Arg::Bool(*b),
        HostValue::Number(n) => Arg::Num(*n),
        HostValue::String(s) => Arg::Str(s.to_string_lossy().into_owned()),
        HostValue::Array(items) => Arg::List(list(items)),
        HostValue::Object(fields) => Arg::Obj(
            fields
                .iter()
                .filter(|(_, v)| !skipped(v))
                .map(|(k, v)| (k.to_string_lossy().into_owned(), arg(v)))
                .collect(),
        ),
        HostValue::Null | HostValue::Undefined => Arg::Null,
        other => Arg::from_json(&other.to_json().unwrap_or(Json::Null)),
    }
}

/// A list's items: a hole, `undefined` or a function is `null`.
fn list(items: &[Option<HostValue>]) -> Vec<Arg> {
    (items.iter())
        .map(|i| match i {
            Some(i) if !skipped(i) => arg(i),
            _ => Arg::Null,
        })
        .collect()
}

type Shape = (Option<Vec<Arg>>, &'static str);

/// A posted batch as the host checks take it: its ops and bytes, or why it isn't one (with its ops when a list).
pub fn batch(b: &HostValue) -> Result<(Vec<Arg>, Vec<u8>), Shape> {
    if !matches!(b, HostValue::Object(_)) {
        return Err((None, "a batch must be an object"));
    }
    let Some(HostValue::Array(ops)) = b.get("ops") else {
        return Err((None, "a batch's ops must be a list"));
    };
    let ops = list(ops);
    match b.get("bytes") {
        Some(HostValue::TypedArray(t)) if t.kind() == TypedKind::ArrayBuffer => {
            Ok((ops, t.to_vec()))
        }
        _ => Err((Some(ops), "a batch's bytes must be an ArrayBuffer")),
    }
}

fn text(v: &Value) -> Vec<u8> {
    v.to_string().into_bytes()
}

impl EncodePosts for Posts {
    fn post(&mut self, m: &HostValue, _now: Instant) -> Result<(Vec<Vec<u8>>, HostValue), Reject> {
        if let Some(HostValue::Array(keys)) = m.get("canvases") {
            let keys: Vec<String> = (keys.iter().flatten())
                .filter_map(|k| k.as_str().map(str::to_owned))
                .collect();
            self.gpu.canvases(&keys);
            self.keys = keys;
        }
        if let Some(b) = m.get("gpu") {
            match batch(b) {
                Ok((ops, bytes)) => self.gpu.batch(&ops, &bytes),
                Err((ops, message)) => self.gpu.shape_error(ops.as_deref(), message.into()),
            }
        }
        let mut out = Vec::new();
        if matches!(m.get("frame"), Some(HostValue::Bool(true))) {
            self.gpu.end_frame();
            out.push(text(&json!({ "frame": true })));
        }
        if let Some(v) = m.get("send") {
            out.push(text(&json!({ "send": v.to_json() })));
        }
        Ok((out, HostValue::Undefined))
    }
    fn due(&mut self, _now: Instant) -> Vec<Vec<u8>> {
        self.gpu.due();
        Vec::new()
    }
    fn release(&mut self) -> Vec<Vec<u8>> {
        self.gpu.finish();
        Vec::new()
    }
    fn input(&mut self, input: HostValue) -> HostValue {
        let mut fields = match input {
            HostValue::Object(fields) => fields,
            _ => Vec::new(),
        };
        fields.push(("gpu".into(), self.gpu.input()));
        for (k, v) in &self.extra {
            fields.push((k.as_str().into(), v.clone()));
        }
        HostValue::Object(fields)
    }
    fn received(&mut self, m: &HostValue) -> Vec<Vec<u8>> {
        let size = |k| m.get(k).and_then(HostValue::as_f64).map(|n| n as u32);
        if m.get("type").and_then(HostValue::as_str) == Some("canvas")
            && let (Some(key), Some(w), Some(h)) = (
                m.get("key").and_then(HostValue::as_str),
                size("width"),
                size("height"),
            )
        {
            self.gpu.resize(key, w, h);
        }
        Vec::new()
    }
    fn surfaces(&self) -> Option<Arc<dyn LiveSurfaces>> {
        Some(self.gpu.clone())
    }
    fn ended(&mut self) {
        self.gpu.ended();
    }
    /// `{ last, keys, all: [kind, message] | null, canvases: [[key, kind, message], ...] }`.
    fn save(&self) -> Data {
        let (last, stops) = self.gpu.saved();
        let kind = |s: &SavedStop| match s.kind {
            ErrorKind::Program => "program",
            ErrorKind::Client => "client",
        };
        let canvases: Vec<Value> = (stops.canvases.iter())
            .map(|(k, s)| json!([k, kind(s), s.message]))
            .collect();
        Data::from_json(&json!({
            "last": last,
            "keys": self.keys,
            "all": stops.all.as_ref().map(|s| json!([kind(s), s.message])),
            "canvases": canvases,
        }))
    }
    fn load(&mut self, saved: &Data) {
        let saved = saved.to_json();
        let stop = |kind: &Value, message: &Value| SavedStop {
            kind: match kind.as_str() {
                Some("client") => ErrorKind::Client,
                _ => ErrorKind::Program,
            },
            message: message.as_str().unwrap_or_default().to_owned(),
        };
        let stops = SavedStops {
            all: saved["all"].as_array().map(|s| stop(&s[0], &s[1])),
            canvases: (saved["canvases"].as_array().into_iter().flatten())
                .map(|c| (c[0].as_str().unwrap().to_owned(), stop(&c[1], &c[2])))
                .collect(),
        };
        self.keys = (saved["keys"].as_array().into_iter().flatten())
            .filter_map(|k| k.as_str().map(str::to_owned))
            .collect();
        let last = saved["last"].as_u64().unwrap_or(0);
        self.gpu.restored(last, self.keys.clone(), stops);
    }
}

#[derive(Debug)]
pub enum Event {
    /// The posts of one wake-up, each as its JSON.
    Posts(Vec<Value>),
    Gpu(Option<String>, GpuCanvasState),
    Exit(LiveExit),
}

pub struct Handler(Mutex<Sender<Event>>);

impl LiveHandler for Handler {
    fn on_posts(&self, _messages_json: Vec<String>) {}
    fn on_posts_bytes(&self, messages: Vec<Vec<u8>>) {
        let posts = (messages.iter())
            .map(|m| serde_json::from_slice(m).unwrap())
            .collect();
        let _ = self.0.lock().unwrap().send(Event::Posts(posts));
    }
    fn on_warning(&self, _message: String) {}
    fn on_exit(&self, exit: LiveExit) {
        let _ = self.0.lock().unwrap().send(Event::Exit(exit));
    }
    fn on_gpu_canvas(&self, key: Option<String>, state: GpuCanvasState) {
        let _ = self.0.lock().unwrap().send(Event::Gpu(key, state));
    }
}

pub struct Run {
    pub run: Arc<LiveRun>,
    pub rx: Receiver<Event>,
    /// What came besides what a test waited for.
    pub seen: Vec<Event>,
}

fn options() -> LiveOptions {
    LiveOptions {
        slice_budget_ms: 60_000,
        ..Default::default()
    }
}

pub fn program(source: &str) -> Program {
    Program::new(source.into(), "__input".into()).unwrap()
}

/// A live run of `program` with the test encoder, its input `input` and the encoder's `extra` fields.
pub fn start(program: &Program, input: Value, extra: Vec<(String, HostValue)>) -> Run {
    start_with(program, input, extra, options())
}

/// [`start`] with `options`.
pub fn start_with(
    program: &Program,
    input: Value,
    extra: Vec<(String, HostValue)>,
    options: LiveOptions,
) -> Run {
    let (tx, rx) = channel();
    let run = program
        .start_live(
            input.to_string(),
            Box::new(Handler(Mutex::new(tx))),
            options,
            None,
            Some(encoder(extra)),
        )
        .unwrap();
    Run {
        run,
        rx,
        seen: Vec::new(),
    }
}

/// A run continued from `snapshot`, with a new handler.
pub fn restore(snapshot: Vec<u8>) -> Run {
    let (tx, rx) = channel();
    let run = LiveRun::restore(
        snapshot,
        Box::new(Handler(Mutex::new(tx))),
        "__input".into(),
        options(),
        None,
        Some(encoder(Vec::new())),
    )
    .unwrap();
    Run {
        run,
        rx,
        seen: Vec::new(),
    }
}

pub fn frame(i: usize) -> String {
    json!({ "type": "frame", "frame": { "t": i as f64 / 60.0, "dt": 1.0 / 60.0 } }).to_string()
}

pub fn canvas(key: &str, width: u32, height: u32) -> String {
    json!({ "type": "canvas", "key": key, "width": width, "height": height }).to_string()
}

impl Run {
    /// Waits for an event `want` picks (one that came already first), keeping the others.
    pub fn wait<T>(&mut self, mut want: impl FnMut(&Event) -> Option<T>) -> T {
        if let Some((i, t)) =
            (self.seen.iter().enumerate()).find_map(|(i, e)| want(e).map(|t| (i, t)))
        {
            self.seen.remove(i);
            return t;
        }
        let until = Instant::now() + WAIT;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            let Ok(e) = self.rx.recv_timeout(left) else {
                panic!("no event in time, after {:?}", self.seen);
            };
            if let Some(t) = want(&e) {
                return t;
            }
            if let Event::Exit(exit) = &e {
                panic!("the run ended: {exit:?} after {:?}", self.seen);
            }
            self.seen.push(e);
        }
    }

    /// The run's exit.
    pub fn exit(&mut self) -> LiveExit {
        let i = self.seen.iter().position(|e| matches!(e, Event::Exit(_)));
        if let Some(Event::Exit(exit)) = i.map(|i| self.seen.remove(i)) {
            return exit;
        }
        let until = Instant::now() + WAIT;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(Event::Exit(exit)) => return exit,
                Ok(e) => self.seen.push(e),
                Err(_) => panic!("the run didn't end in time, after {:?}", self.seen),
            }
        }
    }

    /// Takes the first post `want` picks (one that came already first), keeping the other posts of its wake-up and the
    /// other events; or the run's exit, if it came first.
    pub fn post_or_exit(&mut self, want: impl Fn(&Value) -> bool) -> Result<Value, LiveExit> {
        let take = |e: &mut Event| match e {
            Event::Posts(p) => p.iter().position(&want).map(|i| p.remove(i)),
            _ => None,
        };
        for i in 0..self.seen.len() {
            if matches!(self.seen[i], Event::Exit(_)) {
                let Event::Exit(exit) = self.seen.remove(i) else {
                    unreachable!()
                };
                return Err(exit);
            }
            if let Some(v) = take(&mut self.seen[i]) {
                if matches!(&self.seen[i], Event::Posts(p) if p.is_empty()) {
                    self.seen.remove(i);
                }
                return Ok(v);
            }
        }
        let until = Instant::now() + WAIT;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            let Ok(mut e) = self.rx.recv_timeout(left) else {
                panic!("no post in time, after {:?}", self.seen);
            };
            if let Event::Exit(exit) = e {
                return Err(exit);
            }
            let found = take(&mut e);
            if !matches!(&e, Event::Posts(p) if p.is_empty()) {
                self.seen.push(e);
            }
            if let Some(v) = found {
                return Ok(v);
            }
        }
    }

    /// Takes the first post `want` picks (see [`Run::post_or_exit`]).
    pub fn post(&mut self, want: impl Fn(&Value) -> bool) -> Value {
        self.post_or_exit(want)
            .unwrap_or_else(|exit| panic!("the run ended: {exit:?} after {:?}", self.seen))
    }

    /// The next value the program sent (`{ send }`).
    pub fn sent(&mut self) -> Value {
        self.post(|p| p.get("send").is_some())["send"].take()
    }

    pub fn frame_request(&mut self) {
        self.post(|p| p["frame"] == true);
    }

    /// Answers `n` frame requests.
    pub fn frames(&mut self, n: usize) {
        for i in 0..n {
            self.frame_request();
            self.run.deliver(frame(i)).unwrap();
        }
    }

    /// Waits until the canvas `key` has an image (the device may still be being made as the run starts).
    pub fn live(&mut self, key: &str) {
        let state = self.wait(|e| match e {
            Event::Gpu(Some(k), s @ GpuCanvasState::Live { .. }) if k == key => Some(s.clone()),
            _ => None,
        });
        self.seen.push(Event::Gpu(Some(key.into()), state));
    }

    /// Waits until the run has handled everything it was given: a `ping` it answers with `pong` comes after every
    /// event of what came before it (the program must answer pings).
    pub fn settle(&mut self) {
        self.run
            .deliver(json!({ "type": "ping" }).to_string())
            .unwrap();
        self.post(|p| p["send"] == "pong");
    }

    pub fn gpu_events(&self) -> Vec<(Option<String>, GpuCanvasState)> {
        (self.seen.iter())
            .filter_map(|e| match e {
                Event::Gpu(k, s) => Some((k.clone(), s.clone())),
                _ => None,
            })
            .collect()
    }

    /// Waits until the run has presented at least `n` images (presents beyond the surface's rate are skipped).
    pub fn presents(&self, n: u64) {
        let until = Instant::now() + WAIT;
        while self.run.gpu_stats().unwrap().presents < n {
            assert!(Instant::now() < until, "{:?}", self.run.gpu_stats());
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// The format `LiveGpu::input` tells the program on this platform.
pub fn platform_format() -> &'static str {
    match cfg!(any(target_os = "macos", target_os = "ios")) {
        true => "bgra8unorm",
        false => "rgba8unorm",
    }
}

fn base64(s: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let digits: Vec<u8> = s.bytes().filter(|&c| c != b'=').map(value).collect();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let n = (chunk.iter().enumerate()).fold(0u32, |n, (i, d)| n | (*d as u32) << (18 - 6 * i));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

/// A recorded op as the program posts it: `{ "$num": "NaN" | "Infinity" | "-Infinity" }` is that number.
fn carried(v: &Value) -> HostValue {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("$num") => {
            HostValue::Number(match o["$num"].as_str() {
                Some("Infinity") => f64::INFINITY,
                Some("-Infinity") => f64::NEG_INFINITY,
                _ => f64::NAN,
            })
        }
        Value::Object(o) => HostValue::object(o.iter().map(|(k, v)| (k.as_str(), carried(v)))),
        Value::Array(l) => HostValue::array(l.iter().map(carried)),
        v => HostValue::from_json(v),
    }
}

/// A fixture's recorded `batches` (`{ frame, ops, bytes }`), for [`FIXTURE_BATCHES`]'s input: `{ frame, gpu: { ops, bytes }
/// }`, the bytes an `ArrayBuffer` (a `Uint8Array` where the fixture's are `null`, not one); a frame request that
/// carried no batch (`ops` `[]`, `bytes` `""`) without `gpu`. Also how many are batches of the right shape.
pub fn recorded(batches: &[Value]) -> (HostValue, u64) {
    let mut valid = 0;
    let list = batches.iter().map(|b| {
        let mut fields = vec![("frame", HostValue::Bool(b["frame"] == true))];
        let bare = b["frame"] == true && b["ops"] == json!([]) && b["bytes"] == "";
        if !bare {
            let bytes = match b["bytes"].as_str() {
                Some(s) => TypedArray::new(TypedKind::ArrayBuffer, base64(s)),
                None => TypedArray::new(TypedKind::U8, vec![0; 8]),
            };
            valid += u64::from(b["ops"].is_array() && b["bytes"].is_string());
            fields.push((
                "gpu",
                HostValue::object([
                    ("ops", carried(&b["ops"])),
                    ("bytes", HostValue::TypedArray(bytes.unwrap())),
                ]),
            ));
        }
        HostValue::object(fields)
    });
    let list = HostValue::array(list.collect::<Vec<_>>());
    (list, valid)
}

/// The start of a fixture's program: it sends its `gpu` input, posts its canvases `keys` and waits until each has its
/// size. `next()` is the next message but a `ping` (answered with `pong`); `frame()` a frame request and its frame.
pub const FIXTURE_START: &str = r#"const { gpu, keys, batches, end } = __input()
const post = __host.post
post({ send: gpu })
post({ canvases: keys })
const next = async () => {
  for (;;) {
    const m = await __host.receive()
    if (m.type !== "ping") return m
    post({ send: "pong" })
  }
}
const sized = new Set()
while (sized.size < keys.length) {
  const m = await next()
  if (m.type === "canvas") sized.add(m.key)
}
const frame = async () => {
  post({ frame: true })
  for (;;) if ((await next()).type === "frame") return
}
"#;

/// After [`FIXTURE_START`]: posts a fixture's recorded batches in order (`batches`, from [`recorded`]), each frame
/// request waiting for its frame. Then by `end`: `"return"`, `"stop"` (it waits, answering pings), or `"repeat"` (the
/// last batch again each frame).
pub const FIXTURE_BATCHES: &str = r#"for (const b of batches) {
  if (b.gpu !== undefined) post({ gpu: b.gpu })
  if (b.frame) await frame()
}
if (end === "repeat") for (;;) { post({ gpu: batches[batches.length - 1].gpu }); await frame() }
if (end === "stop") for (;;) await next()
"#;

/// The program that posts a fixture's recorded batches.
pub fn fixture_program() -> Program {
    program(&format!("{FIXTURE_START}{FIXTURE_BATCHES}"))
}

/// The cube fixture's batches, and its canvas.
pub fn cube() -> (HostValue, (u32, u32)) {
    let f: Value = serde_json::from_str(CUBE).unwrap();
    let c = &f["canvases"][0];
    let size = (
        c["width"].as_u64().unwrap() as u32,
        c["height"].as_u64().unwrap() as u32,
    );
    (recorded(f["batches"].as_array().unwrap()).0, size)
}

/// A run drawing the cube's batches into canvas `cube`, the last one again each frame.
pub fn start_cube() -> Run {
    let (batches, _) = cube();
    start(
        &fixture_program(),
        json!({ "keys": ["cube"], "end": "repeat" }),
        vec![("batches".into(), batches)],
    )
}

/// The cube's image: the clear color in the corners, the lit blue in the middle (as psychoscript-gpu's own test has
/// it).
pub fn assert_cube(w: u32, h: u32, p: &[u8]) {
    let at =
        |x: u32, y: u32| -> [u8; 4] { p[((y * w + x) * 4) as usize..][..4].try_into().unwrap() };
    assert_eq!(at(2, 2), [13, 13, 20, 255]);
    assert_eq!(at(w - 3, h - 3), [13, 13, 20, 255]);
    let [r, g, b, a] = at(w / 2, h / 2);
    assert_eq!(a, 255);
    assert!(b > 60 && b > g && g > r, "{:?}", at(w / 2, h / 2));
    let lit = (w / 2 - 30..w / 2 + 30)
        .filter(|&x| at(x, h / 2)[2] > 40)
        .count();
    assert_eq!(lit, 60);
}

/// What the hand-made programs share: the input's `gpu`, a view and a clearing pass, and `next()`, the next message
/// other than a `canvas` size (which the encoder takes) or a `ping` (answered with `pong`).
pub const COMMON: &str = r#"const { gpu } = __input()
const post = __host.post
const none = new ArrayBuffer(0)
const view = (h, of) => ["view", h, of, { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0,
  arrayLayerCount: 1 }]
const clear = (view, color) => ["pass", { colorAttachments: [{ view, resolveTarget: null, clearValue: color,
  loadOp: "clear", storeOp: "store" }], depthStencilAttachment: null }]
const next = async () => {
  for (;;) {
    const m = await __host.receive()
    if (m.type === "ping") post({ send: "pong" })
    else if (m.type !== "canvas") return m
  }
}
"#;

/// Red into canvas `c`, every frame; on a device loss it sends the message on and starts again with new handles.
pub const RED: &str = r#"post({ canvases: ["c"] })
let handle = 1
const setup = () => {
  const c = handle
  handle += 2
  post({ gpu: { ops: [["context", c, "c", gpu.format, "opaque"], view(c + 1, c)], bytes: none } })
  return c + 1
}
let target = setup()
post({ frame: true })
for (;;) {
  const m = await next()
  if (m.type === "gpu" && m.lost) {
    post({ send: m })
    target = setup()
    continue
  }
  if (m.type !== "frame") continue
  post({ frame: true, gpu: { ops: [clear(target, [1, 0, 0, 1]), ["end"], ["submit"]], bytes: none } })
}
"#;

/// Canvases `a` and `b` cleared red each frame (handles the program counts); at frame 1 a batch into `b` names no
/// pipeline, which stops `b`. On a loss it sends the message on, posts a batch naming a handle from before, and starts
/// again with new handles.
pub const TWO: &str = r#"post({ canvases: ["a", "b"] })
let handle = 1
const setup = () => {
  const a = handle, b = handle + 2
  handle += 4
  post({ gpu: { ops: [["context", a, "a", gpu.format, "opaque"], view(a + 1, a),
    ["context", b, "b", gpu.format, "opaque"], view(b + 1, b)], bytes: none } })
  return [a + 1, b + 1]
}
let views = setup()
let frame = 0
post({ frame: true })
for (;;) {
  const m = await next()
  if (m.type === "gpu" && m.lost) {
    post({ gpu: { ops: [["destroy", 2]], bytes: none } })
    post({ send: m })
    views = setup()
    continue
  }
  if (m.type !== "frame") continue
  if (frame === 1) post({ gpu: { ops: [clear(views[1], [1, 0, 0, 1]), ["setPipeline", 999], ["end"], ["submit"]],
    bytes: none } })
  frame++
  post({ frame: true, gpu: { ops: [clear(views[0], [1, 0, 0, 1]), ["end"], clear(views[1], [1, 0, 0, 1]), ["end"],
    ["submit"]], bytes: none } })
}
"#;

/// A hand-made program: [`COMMON`] and `source`.
pub fn hand_made(source: &str) -> Program {
    program(&format!("{COMMON}{source}"))
}

/// A real surface for `w` × `h`: a `CAMetalLayer` on macOS, an `AImageReader`'s window on Android.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
pub mod real {
    use std::ffi::c_void;
    use std::sync::Arc;

    use psychoscript_mobile::GpuSurface;

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub struct Surface {
        pub surface: Arc<GpuSurface>,
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub fn surface(_w: u32, _h: u32) -> Surface {
        use std::ffi::c_char;
        #[link(name = "QuartzCore", kind = "framework")]
        unsafe extern "C" {}
        #[link(name = "objc")]
        unsafe extern "C" {
            fn objc_getClass(name: *const c_char) -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *const c_void;
            fn objc_msgSend();
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFRelease(cf: *const c_void);
        }
        // SAFETY: `[CAMetalLayer new]`, a +1 reference the surface retains again.
        unsafe {
            let send: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let layer = send(
                objc_getClass(c"CAMetalLayer".as_ptr()),
                sel_registerName(c"new".as_ptr()),
            );
            let surface = GpuSurface::metal_layer(layer as u64).unwrap();
            CFRelease(layer);
            Surface { surface }
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    impl Surface {
        /// A presented image can't be read back from a `CAMetalLayer`.
        pub fn pixels(&self) -> Option<(u32, u32, Vec<u8>)> {
            None
        }
    }

    #[cfg(target_os = "android")]
    pub struct Surface {
        pub surface: Arc<GpuSurface>,
        reader: *mut c_void,
    }

    #[cfg(target_os = "android")]
    #[link(name = "mediandk")]
    unsafe extern "C" {
        fn AImageReader_newWithUsage(
            width: i32,
            height: i32,
            format: i32,
            usage: u64,
            max_images: i32,
            reader: *mut *mut c_void,
        ) -> i32;
        fn AImageReader_getWindow(reader: *mut c_void, window: *mut *mut c_void) -> i32;
        fn AImageReader_acquireLatestImage(reader: *mut c_void, image: *mut *mut c_void) -> i32;
        fn AImageReader_delete(reader: *mut c_void);
        fn AImage_getPlaneData(
            image: *mut c_void,
            plane: i32,
            data: *mut *mut u8,
            len: *mut i32,
        ) -> i32;
        fn AImage_getPlaneRowStride(image: *mut c_void, plane: i32, stride: *mut i32) -> i32;
        fn AImage_getWidth(image: *mut c_void, width: *mut i32) -> i32;
        fn AImage_getHeight(image: *mut c_void, height: *mut i32) -> i32;
        fn AImage_delete(image: *mut c_void);
    }

    #[cfg(target_os = "android")]
    #[link(name = "android")]
    unsafe extern "C" {
        fn ANativeWindow_acquire(window: *mut c_void);
    }

    #[cfg(target_os = "android")]
    pub fn surface(w: u32, h: u32) -> Surface {
        // RGBA_8888, read by the CPU.
        const RGBA: i32 = 1;
        const CPU_READ_OFTEN: u64 = 3;
        // SAFETY: the NDK's calls with valid out pointers; the window gets a reference of the surface's own.
        unsafe {
            let mut reader = std::ptr::null_mut();
            assert_eq!(
                AImageReader_newWithUsage(w as i32, h as i32, RGBA, CPU_READ_OFTEN, 4, &mut reader),
                0
            );
            let mut window = std::ptr::null_mut();
            assert_eq!(AImageReader_getWindow(reader, &mut window), 0);
            ANativeWindow_acquire(window);
            let surface = GpuSurface::android_window(window as u64).unwrap();
            Surface { surface, reader }
        }
    }

    #[cfg(target_os = "android")]
    impl Surface {
        /// The image last presented into the window, as RGBA8.
        pub fn pixels(&self) -> Option<(u32, u32, Vec<u8>)> {
            // SAFETY: as above.
            unsafe {
                let mut image = std::ptr::null_mut();
                for _ in 0..200 {
                    if AImageReader_acquireLatestImage(self.reader, &mut image) == 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                if image.is_null() {
                    return None;
                }
                let (mut w, mut h, mut stride, mut len) = (0, 0, 0, 0);
                let mut data = std::ptr::null_mut();
                AImage_getWidth(image, &mut w);
                AImage_getHeight(image, &mut h);
                AImage_getPlaneRowStride(image, 0, &mut stride);
                AImage_getPlaneData(image, 0, &mut data, &mut len);
                let bytes = std::slice::from_raw_parts(data, len as usize);
                let mut out = Vec::with_capacity((w * h * 4) as usize);
                for y in 0..h as usize {
                    out.extend_from_slice(&bytes[y * stride as usize..][..w as usize * 4]);
                }
                AImage_delete(image);
                Some((w as u32, h as u32, out))
            }
        }
    }

    #[cfg(target_os = "android")]
    impl Drop for Surface {
        fn drop(&mut self) {
            // SAFETY: made in `surface`; the window it gave has a reference of its own until the surface drops.
            unsafe { AImageReader_delete(self.reader) };
        }
    }
}
