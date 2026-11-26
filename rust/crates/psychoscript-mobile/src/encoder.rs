use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use psychoscript::{Data, Failure, HostError, HostValue};

use crate::error::PsychoScriptError;

/// Writes values a program hands its host as bytes for the app, instead of JSON: a step's output
/// ([`crate::Program::run_bytes`]) and a live run's posts ([`crate::LiveHandler::on_posts_bytes`]). The crate only
/// carries the bytes; their format is the encoder's. Runs with an encoder pass program functions as markers
/// (`translate: { functions: "mark" }`); a marker in an argument of a host function the encoder doesn't handle fails
/// the call with the runtime's `TypeError`, as a function does without markers.
pub trait EncodeValues: Send + Sync {
    /// Checks a program before it runs, from its first line: an `Err` refuses the run (`Runtime` of its kind and
    /// message, nothing run).
    fn check(&self, _first_line: &str) -> Result<(), Failure> {
        Ok(())
    }
    /// The host global `run_bytes` defines; the program passes its output, or part of it, to it.
    fn emit_name(&self) -> &str;
    /// The deepest nesting a value may have where it crosses to or from the host in runs with this encoder (the
    /// language's `max_value_depth`); `None` keeps its default, 32.
    fn max_value_depth(&self) -> Option<usize> {
        None
    }
    /// Whether runs with this encoder have the typed arrays besides `Uint8Array` (the language's `typed_arrays`, off
    /// by default). A snapshot resumes only with the same setting.
    fn typed_arrays(&self) -> bool {
        false
    }
    /// What one `run_bytes` keeps between its emit calls and its result, for a run with this input.
    fn step(&self, input: &HostValue) -> Box<dyn EncodeStep>;
    /// What a live run keeps between its posts, and what it may do with its run (`ctx`).
    fn live(&self, ctx: crate::LiveContext) -> Box<dyn EncodePosts>;
}

/// Why an encoder's call fails.
#[derive(Debug)]
pub enum Reject {
    /// A program error, thrown at the call: uncaught, the run fails with `Runtime` of its kind and message, at the
    /// call's line and column.
    Failure(Failure),
    /// A function in argument `arg` (from 1) where none may go: a `TypeError`
    /// `Argument <arg> to <name> contains a function, which cannot be passed to the host.`, located at the call.
    Function { arg: usize },
    /// Thrown as it is, for the program to catch.
    Throw(HostValue),
    /// A program error that isn't thrown: the live run ends at once with `Failed(Runtime)` of its kind and message.
    End(Failure),
}

/// One `run_bytes`: the emit global's calls, then the run's result.
pub trait EncodeStep: Send {
    /// The emit global's arguments.
    fn emit(&mut self, args: &[HostValue]) -> Result<(), Reject>;
    /// A program error the emitted values make, which fails the step whatever the run did.
    fn failure(&self) -> Option<Failure>;
    /// The bytes, from the run's result (program functions in it as markers).
    fn finish(&self, result: &Data) -> Result<Vec<u8>, Failure>;
}

/// A live run's posts (`__host.post(message)`). It may hold posts back (a rate) and hand them over later: the run asks
/// for them when [`EncodePosts::due`] says, as soon as the program waits, and takes them all when it ends unless the
/// app stopped it.
pub trait EncodePosts: Send {
    /// The bytes to hand to the app for a post at `now` (none, one or several), and what `post` returns.
    fn post(
        &mut self,
        message: &HostValue,
        now: Instant,
    ) -> Result<(Vec<Vec<u8>>, HostValue), Reject>;
    /// Posts held back that are due by `now`.
    fn due(&mut self, _now: Instant) -> Vec<Vec<u8>> {
        Vec::new()
    }
    /// When the next post held back is due, if one is.
    fn next_due(&self) -> Option<Instant> {
        None
    }
    /// Every post held back, as the run ends (not when the app stops it).
    fn release(&mut self) -> Vec<Vec<u8>> {
        Vec::new()
    }
    /// A message the app delivered to the program, told before the run's next post or receive.
    fn delivered(&mut self, _message: &HostValue) {}
    /// The run's input, as `__input()` returns it.
    fn input(&mut self, input: HostValue) -> HostValue {
        input
    }
    /// A message the program received; the bytes to hand to the app.
    fn received(&mut self, _message: &HostValue) -> Vec<Vec<u8>> {
        Vec::new()
    }
    /// Where the app's surfaces go ([`crate::LiveRun::attach_surface`]), asked once as the run starts.
    fn surfaces(&self) -> Option<Arc<dyn crate::LiveSurfaces>> {
        None
    }
    /// The run ended (it won't post again): release what it holds.
    fn ended(&mut self) {}
    /// See [`crate::LiveRun::gpu_posted`].
    #[cfg(feature = "test-hooks")]
    fn recorded(&self) -> Vec<String> {
        Vec::new()
    }
    /// What a snapshot keeps of it, for [`EncodePosts::load`] in the restored run.
    fn save(&self) -> Data {
        Data::Null
    }
    fn load(&mut self, _saved: &Data) {}
}

/// An encoder for [`crate::Program::run_bytes`] and live runs (see [`EncodeValues`]).
#[derive(Clone, uniffi::Object)]
pub struct ValueEncoder(pub(crate) Arc<dyn EncodeValues>);

impl ValueEncoder {
    pub fn new(encoder: impl EncodeValues + 'static) -> Arc<ValueEncoder> {
        Arc::new(ValueEncoder(Arc::new(encoder)))
    }
}

impl std::fmt::Debug for ValueEncoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ValueEncoder({})", self.0.emit_name())
    }
}

#[uniffi::export]
impl ValueEncoder {
    /// The host global `run_bytes` defines for the program's output.
    pub fn emit_name(&self) -> String {
        self.0.emit_name().to_owned()
    }
}

/// Whether `v` holds a function marker anywhere.
pub(crate) fn marked(v: &HostValue) -> bool {
    match v {
        HostValue::FunctionMarker => true,
        HostValue::Array(items) => items.iter().flatten().any(marked),
        HostValue::Object(fields) => fields.iter().any(|(_, v)| marked(v)),
        _ => false,
    }
}

/// What a call with an encoder threw, as the run's error names it. The language locates only its own kinds: an encoder's
/// failure is thrown as `InvalidDataValue` so the run's error is at the call, then given its own kind there.
#[derive(Default)]
pub(crate) struct Thrown(Mutex<Option<Named>>);

struct Named {
    message: String,
    kind: String,
}

impl Thrown {
    /// What the call throws for `reject` (an `End` is not thrown: `None`).
    pub(crate) fn throw(&self, reject: Reject, label: &str) -> Option<HostValue> {
        match reject {
            Reject::Throw(v) => Some(v),
            Reject::End(_) => None,
            Reject::Function { arg } => Some(HostError::located("TypeError", function(label, arg))),
            Reject::Failure(f) => {
                let message = f.message.to_string_lossy().into_owned();
                let thrown = Failure::new("InvalidDataValue", message.clone());
                *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(Named {
                    message,
                    kind: f.kind,
                });
                Some(HostValue::Failure(thrown))
            }
        }
    }

    /// A function where none may go in argument `arg` of the call `label`.
    pub(crate) fn function(&self, label: &str, arg: usize) -> HostValue {
        HostError::located("TypeError", function(label, arg))
    }

    /// Gives `error` the encoder's kind when it is the failure thrown.
    pub(crate) fn name(&self, error: &mut PsychoScriptError) {
        let Some(named) = self.0.lock().unwrap_or_else(PoisonError::into_inner).take() else {
            return;
        };
        if let PsychoScriptError::Runtime { kind, reason, .. } = error
            && kind == "InvalidDataValue"
            && reason.contains(&named.message)
        {
            *kind = named.kind;
        }
    }
}

/// The runtime's message for a function in a host call's argument.
fn function(label: &str, arg: usize) -> String {
    format!("Argument {arg} to {label} contains a function, which cannot be passed to the host.")
}

#[cfg(feature = "widget-wire")]
mod widget {
    use super::*;

    fn failure(e: widget_wire::EncodeError) -> Failure {
        Failure::new(e.kind, e.message)
    }

    fn reject(e: widget_wire::CallError) -> Reject {
        match e {
            widget_wire::CallError::Invalid(e) => Reject::Failure(failure(e)),
            widget_wire::CallError::Function { arg } => Reject::Function { arg },
            widget_wire::CallError::Uri => {
                Reject::Throw(HostError::located("URIError", "URI malformed"))
            }
            widget_wire::CallError::Throw(m) => {
                Reject::Throw(HostValue::Error(Box::new(psychoscript::HostError::new(m))))
            }
            widget_wire::CallError::View(m) => {
                Reject::End(Failure::new(widget_wire::INVALID_VIEW, m))
            }
            widget_wire::CallError::End(e) => Reject::End(failure(e)),
        }
    }

    pub(super) struct Widget;

    impl EncodeValues for Widget {
        fn check(&self, first_line: &str) -> Result<(), Failure> {
            match widget_wire::protocol(first_line) {
                widget_wire::PROTOCOL => Ok(()),
                p if p < widget_wire::PROTOCOL => {
                    Err(Failure::new("OlderProtocol", widget_wire::OLDER))
                }
                _ => Err(Failure::new("NewerProtocol", widget_wire::NEWER)),
            }
        }
        fn emit_name(&self) -> &str {
            widget_wire::EMIT
        }
        fn max_value_depth(&self) -> Option<usize> {
            Some(widget_wire::MAX_VALUE_DEPTH)
        }
        // A GPU batch's bytes are an `ArrayBuffer` (`widgets-gpu.md`).
        fn typed_arrays(&self) -> bool {
            true
        }
        fn step(&self, input: &HostValue) -> Box<dyn EncodeStep> {
            let draw = input.get("phase").and_then(HostValue::as_str) == Some("draw");
            Box::new(widget_wire::NativeStep::new(draw))
        }
        fn live(&self, ctx: crate::LiveContext) -> Box<dyn EncodePosts> {
            #[cfg_attr(
                not(any(feature = "widget-gpu", feature = "test-hooks")),
                allow(unused_mut)
            )]
            let mut posts = widget_wire::LivePosts::new();
            #[cfg(feature = "test-hooks")]
            if crate::gpu::RECORD.load(std::sync::atomic::Ordering::SeqCst) {
                posts.record_batches();
            }
            #[cfg(feature = "widget-gpu")]
            let gpu = {
                let gpu = crate::gpu::run::RunGpu::new(ctx);
                posts.set_gpu(gpu.host());
                gpu
            };
            #[cfg(not(feature = "widget-gpu"))]
            let _ = ctx;
            Box::new(WidgetLive {
                posts,
                #[cfg(feature = "widget-gpu")]
                gpu,
            })
        }
    }

    /// A widget run's posts ([`widget_wire::LivePosts`]) and, with feature `widget-gpu`, its GPU.
    struct WidgetLive {
        posts: widget_wire::LivePosts,
        #[cfg(feature = "widget-gpu")]
        gpu: Arc<crate::gpu::run::RunGpu>,
    }

    impl EncodeStep for widget_wire::NativeStep {
        fn emit(&mut self, args: &[HostValue]) -> Result<(), Reject> {
            widget_wire::NativeStep::emit(self, args).map_err(reject)
        }
        fn failure(&self) -> Option<Failure> {
            widget_wire::NativeStep::failure(self)
                .map(|m| Failure::new(widget_wire::INVALID_VIEW, m))
        }
        fn finish(&self, result: &Data) -> Result<Vec<u8>, Failure> {
            widget_wire::NativeStep::finish(self, result).map_err(failure)
        }
    }

    impl EncodePosts for WidgetLive {
        fn post(
            &mut self,
            message: &HostValue,
            now: Instant,
        ) -> Result<(Vec<Vec<u8>>, HostValue), Reject> {
            let (bytes, handled) = self.posts.post(message, now).map_err(reject)?;
            Ok((bytes, handled.map_or(HostValue::Undefined, HostValue::Bool)))
        }
        fn due(&mut self, now: Instant) -> Vec<Vec<u8>> {
            #[cfg(feature = "widget-gpu")]
            self.gpu.due();
            self.posts.due(now)
        }
        fn next_due(&self) -> Option<Instant> {
            self.posts.next_due()
        }
        fn release(&mut self) -> Vec<Vec<u8>> {
            let released = self.posts.release();
            #[cfg(feature = "widget-gpu")]
            self.gpu.finish();
            released
        }
        fn delivered(&mut self, message: &HostValue) {
            self.posts.delivered(message)
        }
        fn received(&mut self, message: &HostValue) -> Vec<Vec<u8>> {
            self.posts.received(message)
        }
        /// `{ data, gpu: { available, format } }` (`widgets-gpu.md`).
        fn input(&mut self, input: HostValue) -> HostValue {
            #[cfg(feature = "widget-gpu")]
            if let HostValue::Object(mut fields) = input {
                fields.retain(|(k, _)| k != "gpu");
                fields.push(("gpu".into(), self.gpu.input()));
                return HostValue::Object(fields);
            }
            input
        }
        fn surfaces(&self) -> Option<Arc<dyn crate::LiveSurfaces>> {
            #[cfg(feature = "widget-gpu")]
            return Some(self.gpu.clone());
            #[cfg(not(feature = "widget-gpu"))]
            None
        }
        fn ended(&mut self) {
            #[cfg(feature = "widget-gpu")]
            self.gpu.ended();
        }
        #[cfg(feature = "test-hooks")]
        fn recorded(&self) -> Vec<String> {
            self.posts
                .recorded()
                .iter()
                .map(|v| v.to_string())
                .collect()
        }
        /// `{ canvases: [[key, id, wgsl, gpu], ...], gpu: <the program's last GPU handle>, stops: { all: [kind,
        /// message] | null, canvases: [[key, kind, message], ...] } }` (the canvases errors stopped).
        fn save(&self) -> Data {
            let canvases = Data::Array(
                self.posts
                    .last_render()
                    .canvases
                    .iter()
                    .map(|c| {
                        Data::Array(vec![
                            Data::String(c.key.as_str().into()),
                            Data::String(c.id.as_str().into()),
                            Data::Bool(c.wgsl),
                            Data::Bool(c.gpu),
                        ])
                    })
                    .collect(),
            );
            #[cfg(feature = "widget-gpu")]
            let (last, stops) = {
                let (last, stops) = self.gpu.saved();
                (last, save_stops(&stops))
            };
            #[cfg(not(feature = "widget-gpu"))]
            let (last, stops) = (0, Data::Null);
            Data::Object(vec![
                ("canvases".into(), canvases),
                ("gpu".into(), Data::Number(last.into())),
                ("stops".into(), stops),
            ])
        }
        fn load(&mut self, saved: &Data) {
            // Snapshots from before GPU canvases are the canvases alone.
            let (list, last) = match saved {
                Data::Array(list) => (list, 0),
                Data::Object(_) => match (saved.get("canvases"), saved.get("gpu")) {
                    (Some(Data::Array(list)), Some(Data::Number(n))) => {
                        (list, n.as_u64().unwrap_or(0))
                    }
                    _ => return,
                },
                _ => return,
            };
            let text = |d: &Data| d.as_string().map(|s| s.to_string_lossy().into_owned());
            let canvases: Vec<widget_wire::Canvas> = list
                .iter()
                .filter_map(|c| match c {
                    Data::Array(f) if f.len() == 3 || f.len() == 4 => Some(widget_wire::Canvas {
                        key: text(&f[0])?,
                        id: text(&f[1])?,
                        wgsl: matches!(f[2], Data::Bool(true)),
                        gpu: matches!(f.get(3), Some(Data::Bool(true))),
                    }),
                    _ => None,
                })
                .collect();
            #[cfg(feature = "widget-gpu")]
            self.gpu.restored(
                last,
                canvases
                    .iter()
                    .filter(|c| c.gpu)
                    .map(|c| c.key.clone())
                    .collect(),
                saved.get("stops").map(load_stops).unwrap_or_default(),
            );
            #[cfg(not(feature = "widget-gpu"))]
            let _ = last;
            self.posts.restore_canvases(canvases);
        }
    }

    #[cfg(feature = "widget-gpu")]
    fn save_stops(stops: &widget_gpu::SavedStops) -> Data {
        let stop = |s: &widget_gpu::SavedStop| {
            let kind = match s.kind {
                widget_gpu::ErrorKind::Program => "program",
                widget_gpu::ErrorKind::Client => "client",
            };
            vec![
                Data::String(kind.into()),
                Data::String(s.message.as_str().into()),
            ]
        };
        Data::Object(vec![
            (
                "all".into(),
                stops
                    .all
                    .as_ref()
                    .map_or(Data::Null, |s| Data::Array(stop(s))),
            ),
            (
                "canvases".into(),
                Data::Array(
                    stops
                        .canvases
                        .iter()
                        .map(|(k, s)| {
                            let mut f = vec![Data::String(k.as_str().into())];
                            f.extend(stop(s));
                            Data::Array(f)
                        })
                        .collect(),
                ),
            ),
        ])
    }

    #[cfg(feature = "widget-gpu")]
    fn load_stops(d: &Data) -> widget_gpu::SavedStops {
        let text = |d: &Data| d.as_string().map(|s| s.to_string_lossy().into_owned());
        let stop = |kind: &Data, message: &Data| {
            Some(widget_gpu::SavedStop {
                kind: match text(kind)?.as_str() {
                    "client" => widget_gpu::ErrorKind::Client,
                    _ => widget_gpu::ErrorKind::Program,
                },
                message: text(message)?,
            })
        };
        let all = match d.get("all") {
            Some(Data::Array(f)) if f.len() == 2 => stop(&f[0], &f[1]),
            _ => None,
        };
        let canvases = match d.get("canvases") {
            Some(Data::Array(list)) => list
                .iter()
                .filter_map(|c| match c {
                    Data::Array(f) if f.len() == 3 => Some((text(&f[0])?, stop(&f[1], &f[2])?)),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        widget_gpu::SavedStops { all, canvases }
    }

    #[uniffi::export]
    impl ValueEncoder {
        /// OpenCode widgets' binary format (`widget-wire`, opencode `specs/v2/widgets-binary.md`) for a native host
        /// of widget protocol 2 (`widgets.md`, Native hosts): steps run `<program>\nreturn
        /// __widget_native_step(__input())` with `run_bytes`, live runs `<program>\nreturn await
        /// __widget_live(__input(), true)`. A program of another protocol isn't run: `Runtime` of kind
        /// `OlderProtocol` (a program error) or `NewerProtocol` (a client error). A value it can't write fails with
        /// `Runtime` of kind `InvalidView`, `InvalidDraw` or `InvalidGpu` (the spec's phase `view`, `draw` or `gpu`),
        /// else `InvalidDataValue`.
        #[uniffi::constructor]
        pub fn widget() -> Arc<ValueEncoder> {
            ValueEncoder::new(Widget)
        }
    }
}
