use std::sync::{Arc, Mutex, PoisonError};

use psychoscript::{Compiled, Data, HostFunction, HostValue, Limits, Runtime};

use crate::error::Error;
use crate::json::Input;
use crate::live::{LiveOptions, LiveRun, MARK};
use crate::tree::Walk;

/// A program compiled once, to run as often as needed: each run has its own VM. A run reads its JSON input through
/// one sync host function, `input_name` (`__input` by default), and its result is the program's completion value.
#[derive(Debug, Clone)]
pub struct Program {
    compiled: Compiled,
    input_name: String,
}

impl Program {
    /// Compiles `source`. Fails with `Syntax` when it doesn't parse.
    pub fn new(source: &str, input_name: Option<String>) -> Result<Program, Error> {
        let compiled = Runtime::make()
            .compile(source)
            .map_err(|d| Error::from_diagnostic(d, None))?;
        Ok(Program {
            compiled,
            input_name: input_name.unwrap_or_else(|| "__input".to_owned()),
        })
    }

    /// Runs the program to its end with `input_json` behind its input function, under `timeout_ms` of active time,
    /// and returns its result as JSON (`undefined` as `null`), at most `max_output_bytes` of it.
    pub fn run(
        &self,
        input_json: &str,
        timeout_ms: Option<u64>,
        max_output_bytes: Option<u64>,
    ) -> Result<String, Error> {
        let out = self
            .execute(input_json, timeout_ms, false)?
            .to_json_string();
        limit(out, max_output_bytes)
    }

    /// [`Program::run`] for a widget step run natively (`__widget_step(__input(), true)`, widgets.md, "Native hosts"):
    /// the result's `view` is the view as the program built it, and goes out as the tree clients get, built while it
    /// is written ([`crate::tree`]). A key it can't encode is a runtime error (`URIError`), as in the prelude.
    pub fn run_step(
        &self,
        input_json: &str,
        timeout_ms: Option<u64>,
        max_output_bytes: Option<u64>,
    ) -> Result<String, Error> {
        let data = self.execute(input_json, timeout_ms, true)?;
        let mut out = String::new();
        match &data {
            Data::Object(fields) => {
                out.push('{');
                for (i, (name, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Data::String(name.clone()).to_json_string());
                    out.push(':');
                    if name == "view" {
                        Walk::new()
                            .run(value, &mut out)
                            .map_err(|e| Error::Runtime {
                                kind: "ExecutionFailure".into(),
                                reason: e.0,
                                line: None,
                                column: None,
                            })?;
                    } else {
                        out.push_str(&value.to_json_string());
                    }
                }
                out.push('}');
            }
            other => out.push_str(&other.to_json_string()),
        }
        limit(out, max_output_bytes)
    }

    /// One run's result; `mark`: functions in it cross as markers (a native step).
    fn execute(
        &self,
        input_json: &str,
        timeout_ms: Option<u64>,
        mark: bool,
    ) -> Result<Data, Error> {
        if timeout_ms == Some(0) {
            return Err(Error::invalid_input("timeout_ms must be at least 1"));
        }
        let first = Input::parse(input_json)
            .map_err(|e| Error::invalid_input(format!("the input isn't JSON: {e}")))?;
        let slot = Arc::new(Mutex::new(Slot {
            text: input_json.into(),
            first: Some(first),
        }));
        let name = self.input_name.clone();
        let mut runtime = Runtime::make()
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
                timeout_ms,
                ..Limits::default()
            });
        if mark {
            runtime = runtime.translate(MARK);
        }
        let outcome = runtime.execute(&self.compiled);
        drop(runtime);
        outcome
            .result
            .map_err(|d| Error::from_diagnostic(d, timeout_ms))
    }
}

/// `out`, unless it's over `max_output_bytes`.
fn limit(out: String, max_output_bytes: Option<u64>) -> Result<String, Error> {
    match max_output_bytes {
        Some(max) if out.len() as u64 > max => Err(Error::OutputTooLarge {
            reason: format!(
                "the result is {} bytes of JSON, over the limit of {max}",
                out.len()
            ),
            max_output_bytes: max,
        }),
        _ => Ok(out),
    }
}

impl Program {
    /// Starts the program as a [`LiveRun`] with `input_json` behind its input function and `__host`.
    pub fn start_live(&self, input_json: &str, options: LiveOptions) -> Result<LiveRun, Error> {
        LiveRun::start(
            self.compiled.clone(),
            self.input_name.clone(),
            input_json,
            options,
        )
    }
}

/// A run's input: the parsed value, handed over whole on the first read, and the text to read it again from.
struct Slot {
    text: Arc<str>,
    first: Option<HostValue>,
}

impl Slot {
    fn read(&mut self) -> HostValue {
        self.first
            .take()
            .unwrap_or_else(|| Input::parse(&self.text).unwrap_or_default())
    }
}
