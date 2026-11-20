//! The runner for the `conformance/date-locale.json` matrix, shared by the generator's helper (`examples/date_locale.rs`)
//! and the replay test (`tests/date_locale.rs`): runs each case — `new Date(instant).toLocale*(locale, options)` — and
//! answers its string. A case's `locale` and `options` are JSON (a string, or `null` for the host default), and
//! `method` is one of `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`.

#![allow(dead_code)]

use serde::Deserialize;
use serde_json::Value as Json;

use psychoscript::Runtime;

#[derive(Deserialize)]
pub struct Case {
    pub method: String,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub options: Option<Json>,
    pub instant: i64,
    #[serde(default)]
    pub expected: Option<String>,
}

#[derive(Deserialize)]
pub struct Matrix {
    pub cases: Vec<Case>,
}

impl Case {
    /// The program the runtime runs for this case.
    pub fn source(&self) -> String {
        let mut args = String::new();
        match (&self.locale, &self.options) {
            (Some(locale), Some(options)) => {
                args.push_str(&serde_json::to_string(locale).unwrap_or_default());
                args.push(',');
                args.push_str(&serde_json::to_string(options).unwrap_or_default());
            }
            (Some(locale), None) => {
                args.push_str(&serde_json::to_string(locale).unwrap_or_default());
            }
            (None, Some(options)) => {
                // The first argument as `undefined`, so the options stay the second argument.
                args.push_str("undefined,");
                args.push_str(&serde_json::to_string(options).unwrap_or_default());
            }
            (None, None) => {}
        }
        format!(
            "return new Date({})[{}]({})",
            self.instant,
            serde_json::to_string(&self.method).unwrap_or_default(),
            args,
        )
    }
}

/// Runs every case through one runtime and answers their strings; a diagnostic reads as its kind and message.
pub fn run_cases(cases: &[Case]) -> Vec<String> {
    let runtime = Runtime::make();
    cases.iter().map(|case| run(&runtime, case)).collect()
}

fn run(runtime: &Runtime, case: &Case) -> String {
    let outcome = runtime.execute(&case.source());
    match outcome.result {
        Ok(value) => value
            .as_string()
            .and_then(|s| s.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string()),
        Err(diagnostic) => format!("{}: {}", diagnostic.kind.name(), diagnostic.message),
    }
}
