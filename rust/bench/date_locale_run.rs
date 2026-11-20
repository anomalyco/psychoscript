//! The runner for the `conformance/date-locale.json` matrix, shared by the generator's helper (`examples/date_locale.rs`)
//! and the replay test (`tests/date_locale.rs`): runs each case — `new Date(instant).toLocale*(locale, options)` — and
//! answers it as JSON. A case's `locale` and `options` are JSON (absent, `null`, or the value), and a successful case
//! answers its string (or, for an error case, the caught `[name, message]` array), so the recorded error kinds and
//! messages are pinned too.

#![allow(dead_code)]

use serde::Deserialize;
use serde_json::{Value as Json, json};

use psychoscript::Runtime;

/// Absent (undefined) is distinct from JSON `null`, so the two serialize to a sentinel object.
fn missing() -> Json {
    json!({ "$$undef": true })
}

fn is_missing(value: &Json) -> bool {
    value.as_object().is_some_and(|o| o.contains_key("$$undef"))
}

#[derive(Deserialize)]
pub struct Case {
    pub method: String,
    #[serde(default = "missing")]
    pub locale: Json,
    #[serde(default = "missing")]
    pub options: Json,
    pub instant: i64,
    #[serde(default)]
    pub error: bool,
    #[serde(default)]
    pub expected: Option<Json>,
}

#[derive(Deserialize)]
pub struct Matrix {
    pub cases: Vec<Case>,
}

impl Case {
    /// The program the runtime runs for this case; an error case catches the throw and answers `[name, message]`.
    pub fn source(&self) -> String {
        let json = |value: &Json| serde_json::to_string(value).unwrap_or_default();
        let mut args = String::new();
        match (is_missing(&self.locale), is_missing(&self.options)) {
            (false, false) => {
                args.push_str(&json(&self.locale));
                args.push(',');
                args.push_str(&json(&self.options));
            }
            (false, true) => args.push_str(&json(&self.locale)),
            // The first argument as `undefined`, so the options stay the second argument.
            (true, false) => {
                args.push_str("undefined,");
                args.push_str(&json(&self.options));
            }
            (true, true) => {}
        }
        let call = format!(
            "new Date({})[{}]({})",
            self.instant,
            serde_json::to_string(&self.method).unwrap_or_default(),
            args,
        );
        if self.error {
            format!("try {{ {call} }} catch (e) {{ return [e.name, e.message] }}")
        } else {
            format!("return {call}")
        }
    }
}

/// Runs a case through one runtime and answers it as JSON.
pub fn run_case(runtime: &Runtime, case: &Case) -> Json {
    let outcome = runtime.execute(&case.source());
    match outcome.result {
        Ok(value) => value.to_json(),
        // A case should not throw uncaught (an error case catches its throw); keep this as a loud mismatch.
        Err(diagnostic) => json!({
            "error": {
                "kind": diagnostic.kind.name(),
                "message": diagnostic.message.as_str().unwrap_or(""),
            }
        }),
    }
}

/// Runs every case and answers each as JSON, in file order.
pub fn run_cases(cases: &[Case]) -> Vec<Json> {
    let runtime = Runtime::make();
    cases.iter().map(|case| run_case(&runtime, case)).collect()
}
