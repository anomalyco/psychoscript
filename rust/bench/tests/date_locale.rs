//! Replays `conformance/date-locale.json`, the matrix of Date locale-formatting cases `conformance/date-locale.ts`
//! recorded from the reference, and checks each against the reference's string — except the entries of
//! `conformance/date-locale.differences.json`, the hits where ICU4X can't express the exact combination and renders
//! its closest output; those are pinned to the values the same generator recorded, so a change that makes one match
//! (or drift) fails here until the recordings are regenerated.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[path = "../date_locale_run.rs"]
mod run;

use run::{Matrix, run_cases};

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
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance");
    let matrix: Matrix = serde_json::from_str(&read(&dir.join("date-locale.json")))
        .unwrap_or_else(|e| panic!("date-locale.json: {e}"));
    let differences: Differences =
        serde_json::from_str(&read(&dir.join("date-locale.differences.json")))
            .unwrap_or_else(|e| panic!("date-locale.differences.json: {e}"));
    let known: HashMap<usize, &Difference> = differences
        .differences
        .iter()
        .map(|d| (d.index, d))
        .collect();

    let actual = run_cases(&matrix.cases);
    assert_eq!(actual.len(), matrix.cases.len(), "ran every case");
    let mut problems = Vec::new();
    for (i, case) in matrix.cases.iter().enumerate() {
        let Some(expected) = case.expected.as_deref() else {
            problems.push(format!("case {i}: missing expected value in the recording"));
            continue;
        };
        match known.get(&i) {
            Some(difference) => {
                if actual[i] != difference.rust {
                    problems.push(format!(
                        "case {i}: the recorded difference drifted\n  reference: {}\n  recorded rust: {}\n  actual rust:   {}",
                        difference.reference, difference.rust, actual[i]
                    ));
                } else if actual[i] == expected {
                    problems.push(format!(
                        "case {i}: now matches the reference; regenerate date-locale.differences.json to drop it"
                    ));
                }
            }
            None if actual[i] != expected => {
                problems.push(format!(
                    "case {i} ({} {} {}):\n  reference: {}\n  rust:      {}",
                    case.method,
                    case.locale.as_deref().unwrap_or("(default)"),
                    case.options
                        .as_ref()
                        .map_or_else(String::new, |o| o.to_string()),
                    expected,
                    actual[i],
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
        "{} of {} date-locale cases differ:\n{}",
        problems.len(),
        matrix.cases.len(),
        problems.join("\n\n")
    );
    println!(
        "{} date-locale cases passed ({} recorded differences)",
        matrix.cases.len(),
        differences.differences.len()
    );
}
