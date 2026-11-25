//! Prints a locale matrix's actual outputs as JSON (`conformance/date-locale.json` or `number-locale.json`), so its
//! generator (`conformance/date-locale.ts`, `number-locale.ts`) can record the differences from the
//! reference. Usage: `psychoscript-bench --example date_locale <matrix.json>`.
//!
//! Each line of stdout is a JSON array of the cases' strings, in file order.

#[path = "../date_locale_run.rs"]
mod run;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../conformance/date-locale.json".to_owned());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let matrix: run::Matrix = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"));
    let actual = run::run_cases(&matrix.cases);
    println!("{}", serde_json::to_string(&actual).unwrap_or_default());
}
