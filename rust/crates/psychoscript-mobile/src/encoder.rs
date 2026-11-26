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

/// What a call with an encoder threw, as the run's error names it. The language locates only the errors a host throws
/// as [`HostError::located`], which have no kind of their own: an encoder's failure is thrown as a located `Error`, so
/// the run's error is at the call, then given its own kind there.
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
                let thrown = HostError::located("Error", message.as_str());
                *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(Named {
                    message,
                    kind: f.kind,
                });
                Some(thrown)
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
            && kind == "ExecutionFailure"
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
