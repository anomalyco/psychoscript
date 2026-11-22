use std::sync::{Arc, Mutex, PoisonError};

use psychoscript::{
    Compiled, Data, HostFunction, HostResult, HostString, HostValue, Limits, Runtime, Translate,
    TranslateFunctions,
};

use crate::encoder::{Thrown, ValueEncoder};
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
        self.json(Slot::text(input_json, &options)?, options)
    }

    /// Runs the program as [`Program::run`] does, with `encoder`'s emit global (`encoder.emit_name()`), and returns
    /// the bytes `encoder` wrote for the value the program passed to it (its last call's) instead of the completion
    /// value. Functions in that value are left out, as JSON leaves them out. Fails with `Runtime`
    /// (`InvalidDataValue`) when the encoder can't write the value or the program never called the global;
    /// `max_output_bytes` limits the bytes.
    #[uniffi::method(default(options))]
    pub fn run_bytes(
        &self,
        input_json: String,
        encoder: Arc<ValueEncoder>,
        options: RunOptions,
    ) -> Result<Vec<u8>, PsychoScriptError> {
        self.bytes(Slot::text(input_json, &options)?, options, &encoder)
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
        self.program.json(self.slot(input_json, &options)?, options)
    }

    /// [`Program::run_bytes`] with the session's fields ahead of `input_json`'s.
    #[uniffi::method(default(options))]
    pub fn run_bytes(
        &self,
        input_json: String,
        encoder: Arc<ValueEncoder>,
        options: RunOptions,
    ) -> Result<Vec<u8>, PsychoScriptError> {
        self.program
            .bytes(self.slot(input_json, &options)?, options, &encoder)
    }
}

impl RunSession {
    fn slot(&self, input_json: String, options: &RunOptions) -> Result<Slot, PsychoScriptError> {
        check(options)?;
        let own = object(&input_json, "the input")?;
        let first = HostValue::Object(self.fields.iter().cloned().chain(own).collect());
        Ok(Slot {
            source: Source::Parts {
                fields: self.fields.clone(),
                text: input_json,
            },
            first: Some(first),
        })
    }
}

fn check(options: &RunOptions) -> Result<(), PsychoScriptError> {
    if options.timeout_ms == Some(0) {
        return Err(PsychoScriptError::InvalidInput {
            reason: "timeout_ms must be at least 1".into(),
        });
    }
    Ok(())
}

/// Over `max_output_bytes`?
fn limit(len: usize, what: &str, options: &RunOptions) -> Result<(), PsychoScriptError> {
    match options.max_output_bytes {
        Some(max) if len as u64 > max => Err(PsychoScriptError::OutputTooLarge {
            reason: format!("the result is {len} bytes {what}, over the limit of {max}"),
            max_output_bytes: max,
        }),
        _ => Ok(()),
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

/// What a run's emit global wrote, and the encoder's failure it threw.
#[derive(Default)]
struct Emitted {
    bytes: Mutex<Option<Vec<u8>>>,
    thrown: Thrown,
}

impl Program {
    fn json(&self, slot: Slot, options: RunOptions) -> Result<String, PsychoScriptError> {
        let out = self.execute(slot, &options, None)?.to_json_string();
        limit(out.len(), "of JSON", &options)?;
        Ok(out)
    }

    fn bytes(
        &self,
        slot: Slot,
        options: RunOptions,
        encoder: &ValueEncoder,
    ) -> Result<Vec<u8>, PsychoScriptError> {
        let out = Arc::new(Emitted::default());
        if let Err(mut e) = self.execute(slot, &options, Some((encoder, out.clone()))) {
            out.thrown.name(&mut e);
            return Err(e);
        }
        let bytes = out
            .bytes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let bytes = bytes.ok_or_else(|| PsychoScriptError::Runtime {
            kind: "InvalidDataValue".into(),
            reason: format!("the program didn't call {}", encoder.0.emit_name()),
            line: None,
            column: None,
        })?;
        limit(bytes.len(), "encoded", &options)?;
        Ok(bytes)
    }

    /// Runs the program with its input function and, with `emit`, the encoder's emit global writing into its slot.
    fn execute(
        &self,
        slot: Slot,
        options: &RunOptions,
        emit: Option<(&ValueEncoder, Arc<Emitted>)>,
    ) -> Result<Data, PsychoScriptError> {
        let slot = Arc::new(Mutex::new(slot));
        let name = self.input_name.clone();
        let emit = emit.map(|(e, out)| (e.0.clone(), out));
        let translate = Translate {
            functions: match emit {
                Some(_) => TranslateFunctions::Drop,
                None => TranslateFunctions::Error,
            },
            ..Translate::default()
        };
        let runtime = Runtime::make()
            .translate(translate)
            .globals(move |_run| {
                let slot = slot.clone();
                let input = HostFunction::new(move |_args, _call| {
                    slot.lock().unwrap_or_else(PoisonError::into_inner).read()
                });
                let emit = emit.clone().map(|(encoder, out)| {
                    let name = encoder.emit_name().to_owned();
                    let f = HostFunction::new(move |args: Vec<HostValue>, _call| -> HostResult {
                        let v = args.first().unwrap_or(&HostValue::Undefined);
                        let bytes = encoder.encode_output(v).map_err(|f| out.thrown.throw(f))?;
                        *out.bytes.lock().unwrap_or_else(PoisonError::into_inner) = Some(bytes);
                        Ok(HostValue::Undefined)
                    });
                    (name, f)
                });
                std::iter::once((name.clone(), input)).chain(emit)
            })
            .limits(Limits {
                timeout_ms: options.timeout_ms,
                max_heap_bytes: options.max_heap_bytes,
                ..Default::default()
            });
        let outcome = runtime.execute(&self.compiled);
        drop(runtime);
        outcome.result.map_err(|d| {
            PsychoScriptError::from_diagnostic(d, options.timeout_ms, options.max_heap_bytes)
        })
    }
}

#[uniffi::export]
impl Program {
    /// Starts the program as a [`LiveRun`] on a thread of its own, with `input_json` behind its input function and
    /// `__host` (`post`, `receive`, `sleep`, `now`, `fetch`) to talk to `handler`; `fetch` goes through `transport`
    /// to the hosts `options.https_hosts` allows. With `encoder`, posts reach `handler.on_posts_bytes` as its bytes
    /// (never `on_posts`), and one it can't write throws `InvalidDataValue` at the post. Fails with `InvalidInput`.
    #[uniffi::method(default(transport = None, encoder = None, options))]
    pub fn start_live(
        &self,
        input_json: String,
        handler: Box<dyn LiveHandler>,
        options: LiveOptions,
        transport: Option<Arc<dyn FetchTransport>>,
        encoder: Option<Arc<ValueEncoder>>,
    ) -> Result<Arc<LiveRun>, PsychoScriptError> {
        LiveRun::start(
            self.compiled.clone(),
            self.input_name.clone(),
            input_json,
            handler,
            options,
            transport,
            encoder,
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
    fn text(input_json: String, options: &RunOptions) -> Result<Slot, PsychoScriptError> {
        check(options)?;
        let first = Input::parse(&input_json).map_err(|e| PsychoScriptError::InvalidInput {
            reason: format!("the input isn't JSON: {e}"),
        })?;
        Ok(Slot {
            source: Source::Text(input_json),
            first: Some(first),
        })
    }

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
