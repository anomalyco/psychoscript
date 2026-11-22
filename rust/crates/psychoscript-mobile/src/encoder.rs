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
    /// What one `run_bytes` keeps between its emit calls and its result, for a run with this input.
    fn step(&self, input: &HostValue) -> Box<dyn EncodeStep>;
    /// What a live run keeps between its posts.
    fn live(&self) -> Box<dyn EncodePosts>;
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
    /// A message the app delivered to the program.
    fn delivered(&mut self, _message: &HostValue) {}
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
        fn step(&self, input: &HostValue) -> Box<dyn EncodeStep> {
            let draw = input.get("phase").and_then(HostValue::as_str) == Some("draw");
            Box::new(widget_wire::NativeStep::new(draw))
        }
        fn live(&self) -> Box<dyn EncodePosts> {
            Box::new(widget_wire::LivePosts::new())
        }
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

    impl EncodePosts for widget_wire::LivePosts {
        fn post(
            &mut self,
            message: &HostValue,
            now: Instant,
        ) -> Result<(Vec<Vec<u8>>, HostValue), Reject> {
            let (bytes, handled) =
                widget_wire::LivePosts::post(self, message, now).map_err(reject)?;
            Ok((bytes, handled.map_or(HostValue::Undefined, HostValue::Bool)))
        }
        fn due(&mut self, now: Instant) -> Vec<Vec<u8>> {
            widget_wire::LivePosts::due(self, now)
        }
        fn next_due(&self) -> Option<Instant> {
            widget_wire::LivePosts::next_due(self)
        }
        fn release(&mut self) -> Vec<Vec<u8>> {
            widget_wire::LivePosts::release(self)
        }
        fn delivered(&mut self, message: &HostValue) {
            widget_wire::LivePosts::delivered(self, message)
        }
        /// The last render's canvases, `[[key, id, wgsl], ...]`.
        fn save(&self) -> Data {
            Data::Array(
                self.last_render()
                    .canvases
                    .iter()
                    .map(|c| {
                        Data::Array(vec![
                            Data::String(c.key.as_str().into()),
                            Data::String(c.id.as_str().into()),
                            Data::Bool(c.wgsl),
                        ])
                    })
                    .collect(),
            )
        }
        fn load(&mut self, saved: &Data) {
            let Data::Array(list) = saved else { return };
            let text = |d: &Data| d.as_string().map(|s| s.to_string_lossy().into_owned());
            let canvases = list
                .iter()
                .filter_map(|c| match c {
                    Data::Array(f) if f.len() == 3 => Some(widget_wire::Canvas {
                        key: text(&f[0])?,
                        id: text(&f[1])?,
                        wgsl: matches!(f[2], Data::Bool(true)),
                    }),
                    _ => None,
                })
                .collect();
            self.restore_canvases(canvases);
        }
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
