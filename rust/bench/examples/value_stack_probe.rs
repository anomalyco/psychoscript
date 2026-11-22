//! Measures the native stack each conversion of a value between the program and the host needs per level of nesting,
//! by running it on threads of different stack sizes in child processes and bisecting for the smallest that does not
//! overflow (as `stack_probe` does for compiling).
//!
//! `value_stack_probe` prints, for each path, the smallest stack at two depths and the bytes per level.
//! `value_stack_probe <path> <depth> <stack bytes>` runs one path once and exits 0 when it succeeded.
//!
//! Paths: `args` (a host call's argument), `returns` (what a host call returns), `args-json` (an argument the host
//! reads with `HostValue::to_json`), `result` (the run's result, also as
//! JSON and JSON text), `result-walk` (a result the walk copies, as it holds a promise), `stringify` (`JSON.stringify`
//! in the program), `stringify-walk` (`JSON.stringify` with a replacer), `snapshot` (a call's argument saved, read
//! back and given to the call again on resume), `bindings` (data bound into the program), and `args-edge`,
//! `returns-edge`, `stringify-edge`: the same at the deepest native re-entry the run allows, where the run's stack
//! budget is spent.

use std::sync::mpsc;
use std::time::Duration;

use psychoscript::{
    Data, HostFunction, HostValue, Limits, ProgramOptions, RunOutcome, Runtime, from_bytes,
    to_bytes,
};

const PATHS: &[&str] = &[
    "args",
    "returns",
    "args-json",
    "result",
    "result-walk",
    "stringify",
    "stringify-walk",
    "snapshot",
    "heap",
    "bindings",
];

/// A program value nested `depth` levels: objects and arrays in turn around a number.
fn build(depth: usize) -> String {
    format!("let v = 0; for (let i = 0; i < {depth}; i++) v = i % 2 ? [v] : {{ c: v }};")
}

/// The same as a host value.
fn host(depth: usize) -> HostValue {
    let mut v = HostValue::Number(0.0);
    for i in 0..depth {
        v = if i % 2 == 1 {
            HostValue::array([v])
        } else {
            HostValue::object([("c", v)])
        };
    }
    v
}

fn runtime(depth: usize) -> Runtime {
    Runtime::make()
        .limits(Limits {
            max_value_depth: Some(depth.max(1)),
            ..Limits::default()
        })
        .globals(move |_| {
            [
                ("take", HostFunction::new(|_, _| HostValue::Undefined)),
                (
                    "read",
                    HostFunction::new(|args, _| HostValue::Bool(args[0].to_json().is_some())),
                ),
                ("give", HostFunction::new(move |_, _| host(depth))),
            ]
        })
}

fn path(name: &str, depth: usize) -> bool {
    let ok = |code: String| runtime(depth).execute(code.as_str()).result.is_ok();
    match name {
        "args" => ok(format!("{} take(v); return 1", build(depth))),
        "returns" => ok("give(); return 1".into()),
        "args-json" => ok(format!("{} read(v); return 1", build(depth))),
        "result" => {
            let outcome = runtime(depth).execute(format!("{} return v", build(depth)).as_str());
            outcome.json().is_ok() && outcome.result.is_ok_and(|d| !d.to_json_string().is_empty())
        }
        "result-walk" => ok(format!(
            "{} return [Promise.resolve(0), v]",
            build(depth - 1)
        )),
        "stringify" => ok(format!("{} return JSON.stringify(v).length", build(depth))),
        "stringify-walk" => ok(format!(
            "{} return JSON.stringify(v, (k, x) => x).length",
            build(depth)
        )),
        "bindings" => {
            let mut d = Data::Number(0.into());
            for _ in 0..depth {
                d = Data::Array(vec![d]);
            }
            let options = ProgramOptions::new().bindings([("v", d)]);
            runtime(depth)
                .execute_with("return Array.isArray(v)", &options)
                .result
                .is_ok()
        }
        "snapshot" => snapshot(depth),
        "heap" => heap(depth),
        other => panic!("unknown path {other}"),
    }
}

/// An idempotent call holding a value nested `depth` levels is saved, read back, and made again on resume.
fn snapshot(depth: usize) -> bool {
    snapshot_of(depth, "await wait(v)")
}

/// A run holding a value nested `depth` levels, suspended while `wait` pends and resumed, which crosses nothing.
fn heap(depth: usize) -> bool {
    snapshot_of(depth, "await wait(0)")
}

fn snapshot_of(depth: usize, call: &str) -> bool {
    let limits = Limits {
        max_value_depth: Some(depth),
        ..Limits::default()
    };
    let (started, ready) = mpsc::channel();
    let pending = Runtime::make().limits(limits).globals(move |_| {
        let started = started.clone();
        [(
            "wait",
            HostFunction::new_async(move |_, _| {
                let _ = started.send(());
                std::future::pending()
            })
            .idempotent(),
        )]
    });
    let code = format!("{} {call}; return 1", build(depth));
    let program = pending.program(code.as_str(), &ProgramOptions::new());
    let suspender = program.suspender();
    let outcome = std::thread::scope(|s| {
        s.spawn(move || {
            let _ = ready.recv();
            for _ in 0..1000 {
                match suspender.suspend(None) {
                    Err(e) if !e.running.is_empty() => std::thread::sleep(Duration::from_millis(1)),
                    _ => break,
                }
            }
        });
        program.run_resumable()
    });
    let Ok(RunOutcome::Suspended(suspended)) = outcome else {
        return false;
    };
    let Ok(state) = from_bytes(&to_bytes(&suspended.state)) else {
        eprintln!("the state can't be read back");
        return false;
    };
    let answering = Runtime::make().limits(limits).globals(|_| {
        [(
            "wait",
            HostFunction::new_async(|args, _| async move {
                drop(args);
                Ok(HostValue::Undefined)
            })
            .idempotent(),
        )]
    });
    match answering.resume(&state) {
        Ok(program) => program.run().is_ok_and(|o| o.result.is_ok()),
        Err(e) => {
            eprintln!("{e}");
            false
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() >= 3 {
        let (name, depth, stack): (String, usize, usize) = (
            args[0].clone(),
            args[1].parse().unwrap(),
            args[2].parse().unwrap(),
        );
        let ok = std::thread::Builder::new()
            .stack_size(stack)
            .spawn(move || path(&name, depth))
            .unwrap()
            .join()
            .unwrap();
        std::process::exit(if ok { 0 } else { 2 });
    }
    let only: Vec<&str> = args.iter().map(String::as_str).collect();
    let (lo, hi) = (100, 250);
    for name in PATHS.iter().filter(|p| only.is_empty() || only.contains(p)) {
        let a = smallest(name, lo);
        let b = smallest(name, hi);
        let per = (b as f64 - a as f64) / (hi - lo) as f64;
        let at200 = smallest(name, 200);
        println!(
            "{name:15} {lo}: {a:>9} B  200: {at200:>9} B  {hi}: {b:>9} B  per level: {per:>6.0} B"
        );
    }
}

/// The smallest thread stack, to 1 KiB, that runs the path at that depth.
fn smallest(name: &str, depth: usize) -> usize {
    let exe = std::env::current_exe().unwrap();
    let ok = |stack: usize| {
        std::process::Command::new(&exe)
            .args([name, &depth.to_string(), &stack.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    let (mut lo, mut hi) = (16 << 10, 64 << 20);
    assert!(ok(hi), "{name} at {depth} fails even with {hi} bytes");
    while hi - lo > 1024 {
        let mid = (lo + hi) / 2;
        if ok(mid) { hi = mid } else { lo = mid }
    }
    hi
}
