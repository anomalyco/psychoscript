use std::sync::{Arc, Mutex, PoisonError};

use psychoscript::{Compiled, HostFunction, HostValue, Limits, Runtime};

use crate::error::PsychoScriptError;
use crate::fetch::FetchTransport;
use crate::json::Input;
use crate::live::{LiveHandler, LiveOptions, LiveRun};

/// Limits for one run. Both default to none.
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
        let slot = Arc::new(Mutex::new(Slot {
            text: input_json,
            first: Some(first),
        }));
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

/// A run's input: the parsed value, handed over whole on the first read, and the text to read it
/// again from on a later one.
struct Slot {
    text: String,
    first: Option<HostValue>,
}

impl Slot {
    fn read(&mut self) -> HostValue {
        self.first
            .take()
            .unwrap_or_else(|| Input::parse(&self.text).unwrap_or_default())
    }
}
