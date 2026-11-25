//! Runs the programs of `tests/cases` (Rust-only features, which the conformance recordings of the TypeScript
//! implementation can't cover) the way `bench/tests/conformance.rs` runs a conformance case: blocking and as a future,
//! checking the value or the kind of the failure, the logs and the metadata. `in_round_trip_mode` runs a test again in
//! the round-trip test mode, as CI runs the conformance cases.

use std::process::Command;

use psychoscript::{DiagnosticKind, Json, Outcome, ProgramOptions, Runtime};

/// Runs `code` in `rt` blocking and as a future; each run must give `expected` (the value, or the kind of the
/// failure), log `logs` and leave no metadata.
pub fn check(
    rt: &Runtime,
    name: &str,
    code: &str,
    expected: Result<Json, DiagnosticKind>,
    logs: &[&str],
) {
    let options = ProgramOptions::new();
    let blocking = rt.execute_with(code, &options);
    let future = drive(rt.execute_async(code, &options)).expect("not interrupted");
    for (how, outcome) in [("blocking", blocking), ("as a future", future)] {
        if let Err(problem) = compare(&outcome, &expected, logs) {
            panic!("{name} ({how}): {problem}");
        }
    }
}

fn compare(
    outcome: &Outcome,
    expected: &Result<Json, DiagnosticKind>,
    logs: &[&str],
) -> Result<(), String> {
    match (&outcome.result, expected) {
        (Ok(value), Ok(want)) if same(&value.to_json(), want) => {}
        (Err(d), Err(kind)) if d.kind == *kind => {}
        (Ok(value), _) => return Err(format!("expected {expected:?}, got {value}")),
        (Err(d), _) => {
            return Err(format!(
                "expected {expected:?}, got {}: {}",
                d.kind.name(),
                d.message_lossy()
            ));
        }
    }
    let actual = outcome.log_lines();
    if actual != logs {
        return Err(format!("logs: expected {logs:?}, got {actual:?}"));
    }
    if !outcome.metadata.to_json().is_null() {
        return Err(format!("metadata: expected null, got {}", outcome.metadata));
    }
    Ok(())
}

/// JSON equality where numbers compare by value, so `3` equals `3.0`.
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((kx, vx), (ky, vy))| kx == ky && same(vx, vy))
        }
        _ => a == b,
    }
}

/// Runs the test `name` of this test binary again, in a child process in the round-trip test mode
/// (`PSYCHOSCRIPT_ROUNDTRIP=1`, which the runtime reads once per process): every run is saved to bytes and restored in
/// a brand-new VM at each host stop and every so many loop iterations. Nothing to do when this process is in it.
pub fn in_round_trip_mode(name: &str) {
    if std::env::var_os("PSYCHOSCRIPT_ROUNDTRIP").is_some_and(|v| v == "1") {
        return;
    }
    let exe = std::env::current_exe().expect("the test binary");
    let out = Command::new(exe)
        .args([name, "--exact", "--test-threads=1"])
        .env("PSYCHOSCRIPT_ROUNDTRIP", "1")
        .output()
        .expect("the test binary runs");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && stdout.contains("1 passed"),
        "{name} in the round-trip mode:\n{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Polls a future to its end on this thread, parking until it is woken.
fn drive<F: std::future::Future>(future: F) -> F::Output {
    struct Unpark(std::thread::Thread);
    impl std::task::Wake for Unpark {
        fn wake(self: std::sync::Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(std::sync::Arc::new(Unpark(std::thread::current())));
    let mut cx = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let std::task::Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park();
    }
}
