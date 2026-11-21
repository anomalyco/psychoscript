use std::sync::{Arc, Mutex, PoisonError};

use psychoscript::{Compiled, HostFunction, HostString, HostValue, Limits, Runtime};

use crate::error::PsychoScriptError;
use crate::fetch::FetchTransport;
use crate::json::Input;
use crate::live::{LiveHandler, LiveOptions, LiveRun};

/// Limits for one run, all off by default.
#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct RunOptions {
    /// Active time the run may take, in ms (at least 1); past it the run fails with `Timeout`.
    #[uniffi(default)]
    pub timeout_ms: Option<u64>,
    /// Bytes of JSON the result may take; over it the run fails with `OutputTooLarge`.
    #[uniffi(default)]
    pub max_output_bytes: Option<u64>,
    /// Bytes the run's heap may hold (the language's size model: what the program can still reach); over it the run
    /// fails with `MemoryLimitExceeded`.
    #[uniffi(default)]
    pub max_heap_bytes: Option<u64>,
}

/// A program compiled once, to run as often as needed, from any thread, concurrently too: each run
/// has its own VM. A run reads its JSON input through one sync host function, `input_name`
/// (`__input` by default), and its result is the program's completion value: a top-level
/// `return`'s value, or the last expression statement's.
#[derive(Debug, uniffi::Object)]
pub struct Program {
    compiled: Compiled,
    input_name: String,
}

#[uniffi::export]
impl Program {
    /// Compiles `source`. Fails with `Syntax` when it doesn't parse.
    #[uniffi::constructor(default(input_name = "__input"))]
    pub fn new(source: String, input_name: String) -> Result<Program, PsychoScriptError> {
        let compiled = Runtime::make()
            .compile(&source)
            .map_err(|d| PsychoScriptError::from_diagnostic(d, None, None))?;
        Ok(Program {
            compiled,
            input_name,
        })
    }

    /// Runs the program with `input_json` behind its input function and returns its result as
    /// JSON (`undefined` as `null`).
    #[uniffi::method(default(options))]
    pub fn run(
        &self,
        input_json: String,
        options: RunOptions,
    ) -> Result<String, PsychoScriptError> {
        if options.timeout_ms == Some(0) {
            return Err(PsychoScriptError::InvalidInput {
                reason: "timeout_ms must be at least 1".into(),
            });
        }
        let first = Input::parse(&input_json).map_err(|e| PsychoScriptError::InvalidInput {
            reason: format!("the input isn't JSON: {e}"),
        })?;
        self.execute(
            Slot {
                source: Source::Text(input_json),
                first: Some(first),
            },
            options,
        )
    }

    /// A session of runs that share part of their input: `fields_json`, a JSON object parsed once, whose fields every
    /// run's input gets ahead of its own (`session.run`). For inputs with a large part that doesn't change, such as a
    /// widget's `data`.
    pub fn session(
        self: Arc<Self>,
        fields_json: String,
    ) -> Result<Arc<RunSession>, PsychoScriptError> {
        let fields = object(&fields_json, "the session's fields")?;
        Ok(Arc::new(RunSession {
            program: self,
            fields: Arc::new(fields),
        }))
    }
}

/// Runs of a [`Program`] whose inputs share fields parsed once ([`Program::session`]). Thread-safe, like the program.
#[derive(Debug, uniffi::Object)]
pub struct RunSession {
    program: Arc<Program>,
    fields: Arc<Vec<(HostString, HostValue)>>,
}

#[uniffi::export]
impl RunSession {
    /// Runs the program with the session's fields followed by `input_json`'s (a JSON object) as its input: the program
    /// sees the same input as `program.run` with the whole object. The shared fields are copied from their parsed
    /// value, not parsed again.
    #[uniffi::method(default(options))]
    pub fn run(
        &self,
        input_json: String,
        options: RunOptions,
    ) -> Result<String, PsychoScriptError> {
        if options.timeout_ms == Some(0) {
            return Err(PsychoScriptError::InvalidInput {
                reason: "timeout_ms must be at least 1".into(),
            });
        }
        let own = object(&input_json, "the input")?;
        let first = HostValue::Object(self.fields.iter().cloned().chain(own).collect());
        let source = Source::Parts {
            fields: self.fields.clone(),
            text: input_json,
        };
        self.program.execute(
            Slot {
                source,
                first: Some(first),
            },
            options,
        )
    }
}

/// `text`'s fields, when it's a JSON object.
fn object(text: &str, what: &str) -> Result<Vec<(HostString, HostValue)>, PsychoScriptError> {
    match Input::parse(text) {
        Ok(HostValue::Object(fields)) => Ok(fields),
        Ok(_) => Err(PsychoScriptError::InvalidInput {
            reason: format!("{what} must be a JSON object"),
        }),
        Err(e) => Err(PsychoScriptError::InvalidInput {
            reason: format!("{what} isn't JSON: {e}"),
        }),
    }
}

impl Program {
    fn execute(&self, slot: Slot, options: RunOptions) -> Result<String, PsychoScriptError> {
        let slot = Arc::new(Mutex::new(slot));
        let name = self.input_name.clone();
        let runtime = Runtime::make()
            .globals(move |_run| {
                let slot = slot.clone();
                [(
                    name.clone(),
                    HostFunction::new(move |_args, _call| {
                        slot.lock().unwrap_or_else(PoisonError::into_inner).read()
                    }),
                )]
            })
            .limits(Limits {
                timeout_ms: options.timeout_ms,
                max_heap_bytes: options.max_heap_bytes,
                ..Default::default()
            });
        let outcome = runtime.execute(&self.compiled);
        drop(runtime);
        let data = outcome.result.map_err(|d| {
            PsychoScriptError::from_diagnostic(d, options.timeout_ms, options.max_heap_bytes)
        })?;
        let out = data.to_json_string();
        match options.max_output_bytes {
            Some(max) if out.len() as u64 > max => Err(PsychoScriptError::OutputTooLarge {
                reason: format!(
                    "the result is {} bytes of JSON, over the limit of {max}",
                    out.len()
                ),
                max_output_bytes: max,
            }),
            _ => Ok(out),
        }
    }
}

#[uniffi::export]
impl Program {
    /// Starts the program as a [`LiveRun`] on a thread of its own, with `input_json` behind its input function and
    /// `__host` (`post`, `receive`, `sleep`, `now`, `fetch`) to talk to `handler`; `fetch` goes through `transport`
    /// to the hosts `options.https_hosts` allows. Fails with `InvalidInput`.
    #[uniffi::method(default(transport = None, options))]
    pub fn start_live(
        &self,
        input_json: String,
        handler: Box<dyn LiveHandler>,
        options: LiveOptions,
        transport: Option<Arc<dyn FetchTransport>>,
    ) -> Result<Arc<LiveRun>, PsychoScriptError> {
        LiveRun::start(
            self.compiled.clone(),
            self.input_name.clone(),
            input_json,
            handler,
            options,
            transport,
        )
    }
}

/// A run's input: the parsed value, handed over whole on the first read, and where to build it again from on a later
/// one.
struct Slot {
    source: Source,
    first: Option<HostValue>,
}

enum Source {
    Text(String),
    /// A session's shared fields, then the run's own (a JSON object's text).
    Parts {
        fields: Arc<Vec<(HostString, HostValue)>>,
        text: String,
    },
}

impl Slot {
    fn read(&mut self) -> HostValue {
        if let Some(first) = self.first.take() {
            return first;
        }
        match &self.source {
            Source::Text(text) => Input::parse(text).unwrap_or_default(),
            Source::Parts { fields, text } => {
                let own = match Input::parse(text) {
                    Ok(HostValue::Object(own)) => own,
                    _ => Vec::new(),
                };
                HostValue::Object(fields.iter().cloned().chain(own).collect())
            }
        }
    }
}
