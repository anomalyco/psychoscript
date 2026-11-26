//! A regular expression's backtracking is bounded by the run's own limits: a search that backtracks without end stops
//! at the run's timeout or slice, with its diagnostic, in a run driven synchronously or as a future, and a search
//! that ends, however long it backtracks, gives its answer.

use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::{Duration, Instant};

use psychoscript::{Clock, DiagnosticKind, Limits, Outcome, ProgramOptions, Runtime};
use serde_json::json;

/// Searches that backtrack about 2^40 times: each way a search starts (`test` and `exec`, `search`, `split`,
/// `replace`), on each kind of subject (ASCII; other text, by code point and by code unit), and caught.
const CATASTROPHIC: &[&str] = &[
    r#"return /(a+)+$/.test("a".repeat(40) + "!")"#,
    r#"return /(a+)+$/u.test("é" + "a".repeat(40) + "!")"#,
    r#"return /(a+)+$/.test("é" + "a".repeat(40) + "!")"#,
    r#"return ("a".repeat(40) + "!").search(/(a+)+$/)"#,
    r#"return ("a".repeat(40) + "!").split(/(a+)+$/)"#,
    r#"return ("a".repeat(40) + "!").replace(/(a+)+$/g, "")"#,
    r#"try { return /(a+)+$/.test("a".repeat(40) + "!") } catch (e) { return String(e) }"#,
];

/// How far past its limit a run may end: the search measures its pace and stops short of the limit, but a debug
/// build on a busy machine measures loosely.
const SLACK: Duration = Duration::from_millis(150);

fn timeout(ms: u64, clock: Clock) -> Limits {
    Limits {
        timeout_ms: Some(ms),
        clock,
        ..Limits::default()
    }
}

fn slice(ms: u64) -> Limits {
    Limits {
        slice_ms: Some(ms),
        ..Limits::default()
    }
}

/// Drives a future on this thread, parking while it waits.
fn drive<F: Future>(future: F) -> F::Output {
    struct Unpark(thread::Thread);
    impl std::task::Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return v;
        }
        thread::park();
    }
}

/// Runs `code` under `limits`, synchronously or as a future, and checks it ends with `kind` within `ms` and the
/// slack.
fn stops(code: &str, limits: Limits, ms: u64, kind: DiagnosticKind, live: bool) {
    let rt = Runtime::make().limits(limits);
    let began = Instant::now();
    let o: Outcome = if live {
        drive(rt.execute_async(code, &ProgramOptions::new())).unwrap()
    } else {
        rt.execute(code)
    };
    let took = began.elapsed();
    assert!(
        matches!(&o.result, Err(d) if d.kind == kind),
        "{code}: {:?}",
        o.result
    );
    assert!(
        took < Duration::from_millis(ms) + SLACK,
        "{code} ({}): ended after {took:?}, past its {ms}ms",
        if live { "live" } else { "sync" }
    );
}

#[test]
fn a_search_without_end_stops_at_the_timeout() {
    for code in CATASTROPHIC {
        stops(
            code,
            timeout(200, Clock::Wall),
            200,
            DiagnosticKind::TimeoutExceeded,
            false,
        );
    }
    stops(
        CATASTROPHIC[0],
        timeout(200, Clock::Wall),
        200,
        DiagnosticKind::TimeoutExceeded,
        true,
    );
}

#[test]
fn a_search_without_end_stops_at_the_cpu_time_budget() {
    for live in [false, true] {
        stops(
            CATASTROPHIC[1],
            timeout(200, Clock::ThreadCpu),
            200,
            DiagnosticKind::TimeoutExceeded,
            live,
        );
    }
}

#[test]
fn a_search_without_end_stops_at_the_slice() {
    for live in [false, true] {
        stops(
            CATASTROPHIC[2],
            slice(50),
            50,
            DiagnosticKind::SliceExceeded,
            live,
        );
    }
}

#[test]
fn a_search_that_ends_gives_its_answer_however_long_it_backtracks() {
    // About 2^18 backtracks, past the first budget: the search is made again until it ends.
    let code = r#"const s = "a".repeat(18) + "!"
        const t = "a".repeat(18) + "c" + "aaab"
        return [/(a+)+$/.test(s), /(a+)+$/u.test("é" + s), s.search(/(a+)+$/), /(a+)+b/.exec(t), s.replace(/(a+)+$/, "-")]"#;
    let expected = json!([false, false, -1, ["aaab", "aaa"], "a".repeat(18) + "!"]);
    for limits in [
        Limits::default(),
        timeout(60_000, Clock::Wall),
        slice(60_000),
    ] {
        let o = Runtime::make().limits(limits).execute(code);
        assert_eq!(o.result.unwrap(), expected);
    }
}
