//! What a run holds: the bytes one waiting run keeps live, by what its program made, and what one `execute` allocates.
//! Each program builds its data, then waits in `await wait()`, which never settles.
//!
//! Usage: `mem_probe [--runs N]`. Prints one JSON line per scenario: live bytes per waiting run (what the allocator
//! was asked for, so a vector's spare capacity counts), and per unit of what the program made beyond an idle run.

use std::alloc::{GlobalAlloc, Layout, System};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

use psychoscript::{HostFunction, HostValue, Limits, ProgramOptions, Runtime};
use serde_json::json;

/// (name, program, units made, what a unit is)
const SCENARIOS: [(&str, &str, usize, &str); 9] = [
    ("idle", "await wait(); return 1", 0, ""),
    (
        "objects",
        "const a = []; for (let i = 0; i < 20000; i++) a.push({ id: i, name: 'n', score: i % 97, live: true }); await wait(); return a.length",
        20000,
        "4-property object",
    ),
    (
        "small-arrays",
        "const a = []; for (let i = 0; i < 20000; i++) a.push([i, i + 1]); await wait(); return a.length",
        20000,
        "2-element array",
    ),
    (
        "numbers",
        "const a = []; for (let i = 0; i < 200000; i++) a.push(i * 0.5); await wait(); return a.length",
        200000,
        "number in an array",
    ),
    (
        "strings",
        "const a = []; for (let i = 0; i < 20000; i++) a.push('item-' + i); await wait(); return a.length",
        20000,
        "distinct 9-character string",
    ),
    (
        "closures",
        "const a = []; for (let i = 0; i < 20000; i++) { const j = i * 2; a.push(() => i + j) } await wait(); return a.length",
        20000,
        "closure over 2 bindings",
    ),
    (
        "map",
        "const m = new Map(); for (let i = 0; i < 20000; i++) m.set(i, i); await wait(); return m.size",
        20000,
        "Map entry, number to number",
    ),
    (
        "promises",
        "const a = []; for (let i = 0; i < 2000; i++) a.push(wait()); await wait(); return a.length",
        2000,
        "pending host call",
    ),
    (
        "instances",
        "class P { constructor(x, y) { this.x = x; this.y = y } } const a = []; for (let i = 0; i < 20000; i++) a.push(new P(i, i)); await wait(); return a.length",
        20000,
        "2-field class instance",
    ),
];

struct Never;

impl Future for Never {
    type Output = Result<HostValue, HostValue>;
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Pending
    }
}

fn main() {
    let mut runs = 20usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--runs" => runs = args.next().and_then(|n| n.parse().ok()).expect("--runs N"),
            other => panic!("unknown argument {other}"),
        }
    }
    let runtime: &'static Runtime = Box::leak(Box::new(
        Runtime::make()
            .limits(Limits {
                timeout_ms: None,
                ..Limits::default()
            })
            .globals(|_| [("wait", HostFunction::new_async(|_, _| Never))]),
    ));
    let options: &'static ProgramOptions = Box::leak(Box::new(ProgramOptions::new()));
    let mut cx = Context::from_waker(Waker::noop());
    let mut idle = 0usize;
    for (name, code, units, unit) in SCENARIOS {
        // One untimed run first, so what the process sets up once is not counted.
        let mut warm = Box::pin(runtime.program(code, options).run_async());
        assert!(warm.as_mut().poll(&mut cx).is_pending(), "{name} ended");
        drop(warm);
        let before = LIVE.load(Ordering::Relaxed);
        PEAK.store(before, Ordering::Relaxed);
        let mut held = Vec::with_capacity(runs);
        for _ in 0..runs {
            let mut run = Box::pin(runtime.program(code, options).run_async());
            assert!(run.as_mut().poll(&mut cx).is_pending(), "{name} ended");
            held.push(run);
        }
        let live = (LIVE.load(Ordering::Relaxed) - before) / runs;
        let peak = (PEAK.load(Ordering::Relaxed) - before) / runs;
        if units == 0 {
            idle = live;
        }
        let per_unit = match units {
            0 => json!(null),
            n => json!((live.saturating_sub(idle)) as f64 / n as f64),
        };
        println!(
            "{}",
            json!({ "scenario": name, "live_bytes_per_run": live, "peak_bytes_per_run": peak, "unit": unit, "bytes_per_unit": per_unit })
        );
        drop(held);
    }
    // What one `execute` of a trivial program allocates.
    let _ = runtime.execute("return 1");
    let (bytes, count) = (TOTAL.load(Ordering::Relaxed), COUNT.load(Ordering::Relaxed));
    let n = 1000;
    for _ in 0..n {
        let _ = runtime.execute("return 1");
    }
    println!(
        "{}",
        json!({
            "scenario": "execute return 1",
            "allocated_bytes": (TOTAL.load(Ordering::Relaxed) - bytes) / n,
            "allocations": (COUNT.load(Ordering::Relaxed) - count) / n,
        })
    );
}

/// Counts the bytes the process holds and has allocated.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static COUNT: AtomicUsize = AtomicUsize::new(0);

fn grew(n: usize) {
    let now = LIVE.fetch_add(n, Ordering::Relaxed) + n;
    PEAK.fetch_max(now, Ordering::Relaxed);
    TOTAL.fetch_add(n, Ordering::Relaxed);
    COUNT.fetch_add(1, Ordering::Relaxed);
}

// SAFETY: every call forwards to the system allocator unchanged; the counters only observe sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        grew(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;
