//! Replays the locale matrices: `conformance/date-locale.json`, the Date locale-formatting cases
//! `conformance/date-locale.ts` recorded from the reference, and `conformance/number-locale.json`, the Number and BigInt
//! ones `conformance/number-locale.ts` recorded. Each case — its string, or its error kind and message — is checked
//! against the reference, except the entries of the matrix's `.differences.json`, the hits where ICU4X can't express
//! the exact combination, or its data differs from the host's ICU, and renders its closest output; those are pinned to
//! the values the same generator recorded, so a change that makes one match (or drift) fails here until the recordings
//! are regenerated.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[path = "../date_locale_run.rs"]
mod run;

use run::{Case, Matrix, run_cases};

#[derive(Deserialize)]
struct Difference {
    index: usize,
    reference: String,
    rust: String,
}

#[derive(Deserialize)]
struct Differences {
    #[serde(default)]
    differences: Vec<Difference>,
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn date_locale() {
    check("date-locale");
}

#[test]
fn number_locale() {
    check("number-locale");
}

/// Replays the matrix `conformance/<name>.json` against its `<name>.differences.json`.
fn check(name: &str) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance");
    let matrix: Matrix = serde_json::from_str(&read(&dir.join(format!("{name}.json"))))
        .unwrap_or_else(|e| panic!("{name}.json: {e}"));
    let differences: Differences =
        serde_json::from_str(&read(&dir.join(format!("{name}.differences.json"))))
            .unwrap_or_else(|e| panic!("{name}.differences.json: {e}"));
    let known: HashMap<usize, &Difference> = differences
        .differences
        .iter()
        .map(|d| (d.index, d))
        .collect();

    let actual = run_cases(&matrix.cases);
    assert_eq!(actual.len(), matrix.cases.len(), "ran every case");
    let mut problems = Vec::new();
    for (i, case) in matrix.cases.iter().enumerate() {
        let Some(expected) = case.expected.as_ref() else {
            problems.push(format!("case {i}: missing expected value in the recording"));
            continue;
        };
        if case.error {
            // An error case is pinned exactly: its caught `[name, message]`.
            if &actual[i] != expected {
                problems.push(describe(
                    i,
                    case,
                    "error",
                    format_args!("{}", expected),
                    format_args!("{}", actual[i]),
                ));
            }
            continue;
        }
        let expected_str = expected
            .as_str()
            .unwrap_or_else(|| panic!("case {i}: expected is not a string"));
        let actual_str = actual[i]
            .as_str()
            .unwrap_or_else(|| panic!("case {i}: actual is not a string"));
        match known.get(&i) {
            Some(difference) => {
                if actual_str != difference.rust {
                    problems.push(format!(
                        "case {i}: the recorded difference drifted\n  reference: {}\n  recorded rust: {}\n  actual rust:   {}",
                        difference.reference, difference.rust, actual_str
                    ));
                } else if actual_str == expected_str {
                    problems.push(format!(
                        "case {i}: now matches the reference; regenerate {name}.differences.json to drop it"
                    ));
                }
            }
            None if actual_str != expected_str => {
                problems.push(describe(
                    i,
                    case,
                    "value",
                    format_args!("{expected_str}"),
                    format_args!("{actual_str}"),
                ));
            }
            None => {}
        }
    }
    for i in known.keys() {
        if i >= &matrix.cases.len() {
            problems.push(format!("difference index {i} is past the last case"));
        }
    }
    assert!(
        problems.is_empty(),
        "{} of {} {name} cases differ:\n{}",
        problems.len(),
        matrix.cases.len(),
        problems.join("\n\n")
    );
    println!(
        "{} {name} cases passed ({} recorded differences)",
        matrix.cases.len(),
        differences.differences.len()
    );
}

fn describe(
    i: usize,
    case: &Case,
    what: &str,
    expected: std::fmt::Arguments,
    actual: std::fmt::Arguments,
) -> String {
    let locale = if case
        .locale
        .as_object()
        .is_some_and(|o| o.contains_key("$$undef"))
    {
        "(default)".to_owned()
    } else {
        case.locale.to_string()
    };
    let receiver = case
        .value
        .clone()
        .unwrap_or_else(|| format!("new Date({})", case.instant));
    format!(
        "case {i} {} ({receiver}.{} {} {}):\n  reference: {expected}\n  rust:      {actual}",
        what, case.method, locale, case.options,
    )
}
