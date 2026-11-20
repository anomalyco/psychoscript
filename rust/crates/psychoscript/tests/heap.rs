//! `Limits::max_heap_bytes`: a run stops with `MemoryLimitExceeded` once what it can still reach is over the limit,
//! in the size model it shares with the reference (`heap.rs`, `src/runtime/heap.ts` in the reference); garbage never counts.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use psychoscript::{DiagnosticKind, HostFunction, HostValue, Limits, Runtime};
use serde_json::json;

fn capped(bytes: u64) -> Runtime {
    Runtime::make().limits(Limits {
        max_heap_bytes: Some(bytes),
        ..Limits::default()
    })
}

fn kind(rt: &Runtime, code: &str) -> DiagnosticKind {
    rt.execute(code).result.unwrap_err().kind
}

#[test]
fn a_growing_heap_stops_the_run_and_no_handler_sees_it() {
    let rt = capped(1_000_000);
    let o = rt.execute(
        "console.log('start'); try { const a = []; while (true) a.push({ n: a.length }) } catch (e) { return 'caught' } finally { console.log('finally') }",
    );
    let error = o.result.unwrap_err();
    assert_eq!(error.kind, DiagnosticKind::MemoryLimitExceeded);
    assert_eq!(
        error.message_lossy(),
        "Execution exceeded its memory limit of 1000000 bytes."
    );
    assert_eq!(error.location, None);
    assert_eq!(o.logs.len(), 1);
    for code in [
        "const m = new Map(); for (let i = 0; ; i++) m.set('k' + i, i)",
        "let s = ''; for (let i = 0; ; i++) s += 'abcdefgh'",
        "const a = []; while (true) { a.push(new Array(100)); await null }",
        "const o = {}; for (let i = 0; ; i++) o['k' + i] = i",
    ] {
        assert_eq!(
            kind(&rt, code),
            DiagnosticKind::MemoryLimitExceeded,
            "{code}"
        );
    }
}

#[test]
fn garbage_is_collected_and_does_not_count() {
    // About 60 MB allocated in all, under a 1 MB limit: each object and string is garbage by the next iteration.
    let rt = capped(1_000_000);
    let o = rt.execute(
        "let n = 0; for (let i = 0; i < 300000; i++) { const o = { i, s: 'x' + i, a: [i, i, i] }; n += o.a.length } return n",
    );
    assert_eq!(o.result.unwrap(), json!(900000));
    // A large live set that churns stays as large.
    let o = rt.execute(
        "let kept = []; for (let round = 0; round < 50; round++) { kept = []; for (let i = 0; i < 5000; i++) kept.push({ round, i }) } return kept.length",
    );
    assert_eq!(o.result.unwrap(), json!(5000));
}

#[test]
fn the_heap_is_measured_in_the_shared_size_model() {
    // An array of 1000 holes: 64 bytes for the object and 16 per element, all the run keeps when it ends.
    let code = "Math.kept = new Array(1000); return 1";
    assert_eq!(capped(16_064).execute(code).result.unwrap(), json!(1));
    assert_eq!(
        kind(&capped(16_063), code),
        DiagnosticKind::MemoryLimitExceeded
    );
    // A string counts once however often it is kept: 16 bytes and 2 per code unit.
    let code = "Math.kept = new Array(1000).fill('y'.repeat(100000)); return 1";
    assert_eq!(capped(216_080).execute(code).result.unwrap(), json!(1));
    assert_eq!(
        kind(&capped(216_079), code),
        DiagnosticKind::MemoryLimitExceeded
    );
    // The value a run returns is measured when it ends.
    assert_eq!(
        kind(&capped(1_000_000), "return 'x'.repeat(600000)"),
        DiagnosticKind::MemoryLimitExceeded
    );
    assert!(
        capped(1_000_000)
            .execute("return 'x'.repeat(400000)")
            .result
            .is_ok()
    );
}

#[test]
fn a_run_handing_calls_to_the_host_is_measured_too_before_they_start() {
    let started = Arc::new(AtomicUsize::new(0));
    let count = started.clone();
    let rt = capped(1_000_000).globals(move |_| {
        let count = count.clone();
        [(
            "later",
            HostFunction::new_async(move |_, _| {
                count.fetch_add(1, Ordering::Relaxed);
                async { Ok(HostValue::from(1.0)) }
            }),
        )]
    });
    let o = rt.execute("const a = new Array(100000); await later(); return a.length");
    assert_eq!(
        o.result.unwrap_err().kind,
        DiagnosticKind::MemoryLimitExceeded
    );
    assert_eq!(started.load(Ordering::Relaxed), 0);
}

#[test]
fn no_limit_by_default() {
    let o = Runtime::make()
        .execute("const a = []; for (let i = 0; i < 100000; i++) a.push({ i }); return a.length");
    assert_eq!(o.result.unwrap(), json!(100000));
}

#[test]
#[should_panic(expected = "maxHeapBytes must be a safe integer greater than or equal to 1.")]
fn a_zero_limit_is_refused() {
    let _ = capped(0);
}
