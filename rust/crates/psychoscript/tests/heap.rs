//! `Limits::max_heap_bytes`: a run stops with `MemoryLimitExceeded` once what it can still reach is over the limit,
//! in the size model it shares with the reference (`heap.rs`, `src/runtime/heap.ts` in the reference); garbage never counts.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use psychoscript::{DiagnosticKind, HostFunction, HostValue, Limits, Runtime};
use serde_json::json;

mod support;

fn capped(bytes: u64) -> Runtime {
    Runtime::make().limits(Limits {
        max_heap_bytes: Some(bytes),
        ..Limits::default()
    })
}

/// The programs `tests/cases/heap-limit-*.js`, each under its cap: what it returns or how it fails, and what it logs.
#[test]
fn programs() {
    macro_rules! case {
        ($name:literal, $cap:expr, $expected:expr, $logs:expr) => {
            support::check(
                &capped($cap),
                $name,
                include_str!(concat!("cases/", $name, ".js")),
                $expected,
                $logs,
            )
        };
    }
    use DiagnosticKind::MemoryLimitExceeded as Over;
    case!(
        "heap-limit-async-calls",
        262_144,
        Ok(json!([20000, 20000, 20000, 20000])),
        &[]
    );
    case!("heap-limit-bulk-growth", 4_194_304, Err(Over), &[]);
    case!("heap-limit-collections", 2_000_000, Err(Over), &[]);
    case!("heap-limit-exact-over", 216_079, Err(Over), &[]);
    case!("heap-limit-exact-under", 216_080, Ok(json!(1000)), &[]);
    case!(
        "heap-limit-garbage",
        1_000_000,
        Ok(json!([150000, 4000])),
        &[]
    );
    case!("heap-limit-growth", 1_000_000, Err(Over), &["start"]);
    case!("heap-limit-result", 1_000_000, Err(Over), &[]);
    case!("heap-limit-top-level-over", 16_063, Err(Over), &[]);
    case!("heap-limit-top-level-under", 16_064, Ok(json!(1)), &[]);
}

#[test]
fn programs_in_the_round_trip_mode() {
    support::in_round_trip_mode("programs");
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
fn the_body_s_own_bindings_count_as_it_ends() {
    let code = "const kept = new Array(1000); return 1";
    assert_eq!(capped(16_064).execute(code).result.unwrap(), json!(1));
    assert_eq!(
        kind(&capped(16_063), code),
        DiagnosticKind::MemoryLimitExceeded
    );
    for code in [
        "const kept = []; for (let i = 0; i < 16; i++) kept.push(new Array(1 << 16).fill(i)); return kept.length",
        "const block = 'x'.repeat(1 << 15); const kept = []; for (let i = 0; i < 128; i++) kept.push(block + i); return kept.length",
        "const kept = []; await (async () => { await 0; kept.push(new Array(1 << 18)) })(); return kept.length",
    ] {
        assert_eq!(
            kind(&capped(4_000_000), code),
            DiagnosticKind::MemoryLimitExceeded,
            "{code}"
        );
    }
}

#[test]
fn bulk_growth_is_charged_as_it_happens() {
    // Each grows its heap far over the limit and lets it go before it ends: only a measurement on the way stops it.
    let big = "const big = new Array(4096).fill(0)";
    let block = "const block = 'x'.repeat(32768)";
    let props = "const props = {}; for (let k = 0; k < 2048; k++) props['p' + k] = k";
    for (setup, grown) in [
        (block, "block + i"),
        (block, "`${block}${i}`"),
        (big, "[...big]"),
        (big, "(() => { const t = []; t.push(...big); return t })()"),
        (
            big,
            "(() => { const t = []; t.unshift(...big); return t })()",
        ),
        (
            big,
            "(() => { const t = []; t.splice(0, 0, ...big); return t })()",
        ),
        ("", "(() => { const t = []; t.length = 4096; return t })()"),
        ("", "(() => { const t = []; t[4095] = i; return t })()"),
        (props, "Object.assign({}, props)"),
        (props, "({ ...props })"),
    ] {
        let code = format!(
            "{setup}; let keep = []; for (let i = 0; i < 2048; i++) keep.push({grown}); keep = null; return 1"
        );
        assert_eq!(
            kind(&capped(4_194_304), &code),
            DiagnosticKind::MemoryLimitExceeded,
            "{code}"
        );
    }
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

#[test]
fn finished_async_functions_dont_pile_up() {
    // Each call's record and promise go once it has finished: 100,000 calls fit in 256 KB.
    let rt = capped(256 * 1024);
    for code in [
        "let resolveNext = null; const frame = async () => new Promise((r) => { resolveNext = r }); let i = 0; async function main() { while (i < 100000) { const p = frame(); resolveNext(i); await p; i++ } return i } return await main()",
        "let resolveNext = null; const frame = () => new Promise((r) => { resolveNext = r }); let i = 0; async function main() { while (i < 100000) { const p = frame(); resolveNext(i); await p; i++ } return i } return await main()",
        "const f = async () => 1; let i = 0; while (i < 100000) { await f(); i++ } return i",
        "const f = async (i) => { try { await null; throw new Error('x' + i) } catch (e) { return i } }; let i = 0; while (i < 100000) { await f(i); i++ } return i",
    ] {
        let result = rt.execute(code).json().map_err(|d| d.message_lossy());
        assert_eq!(result, Ok(json!(100000)), "{code}");
    }
}
