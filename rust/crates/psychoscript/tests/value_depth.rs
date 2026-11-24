//! `Limits::max_value_depth`, and that every conversion of a value between the program and the host fits the stack a
//! run has at depth 200 (a view of about 100 nested nodes) and at the bound. These conversions recurse once a level;
//! a native stack overflow aborts this test process instead of failing a test. `bench/examples/value_stack_probe.rs`
//! measures what each needs per level.

use std::sync::mpsc;
use std::time::Duration;

use psychoscript::{
    Data, DurableFunction, HostFunction, HostValue, Limits, MAX_VALUE_DEPTH_LIMIT, ProgramOptions,
    RunOutcome, Runtime, Snapshot, from_bytes, to_bytes,
};
use serde_json::json;

/// The live-run thread of the mobile wrapper.
const MOBILE_THREAD: usize = 1 << 20;
/// Half of it, as margin.
const HALF: usize = 512 << 10;
/// The thread a run moves to past 1 ms of compute: the run's stack budget and room beyond it.
const WORKER_THREAD: usize = 768 << 10;

/// A program value nested `depth` levels: objects and arrays in turn around a number.
fn build(depth: usize) -> String {
    format!("let v = 0; for (let i = 0; i < {depth}; i++) v = i % 2 ? [v] : {{ c: v }};")
}

/// The same as host data.
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

/// The same as JSON.
fn json_of(depth: usize) -> serde_json::Value {
    let mut v = json!(0);
    for i in 0..depth {
        v = if i % 2 == 1 {
            json!([v])
        } else {
            json!({ "c": v })
        };
    }
    v
}

fn limited(depth: usize) -> Limits {
    Limits {
        max_value_depth: Some(depth),
        ..Limits::default()
    }
}

/// Runs `f` on a thread with `stack` bytes of stack.
fn on_stack<T: Send + 'static>(stack: usize, f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(stack)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap()
}

/// Every conversion at `depth`, each as the host sees it.
fn every_path(depth: usize) {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = seen.clone();
    let rt = Runtime::make().limits(limited(depth)).globals(move |_| {
        let kept = kept.clone();
        [
            (
                "take",
                HostFunction::new(move |args, _| {
                    // A host reads its argument as JSON too.
                    let json = args[0].to_json();
                    kept.lock().unwrap().push((args[0].clone(), json));
                    HostValue::Undefined
                }),
            ),
            ("give", HostFunction::new(move |_, _| host(depth))),
        ]
    });
    let code = build(depth);
    // A host call's argument, and what a host call returns.
    let outcome = rt.execute(format!("{code} take(v); const g = give(); return 1").as_str());
    assert!(outcome.result.is_ok(), "{depth}: {:?}", outcome.result);
    let (arg, json) = seen.lock().unwrap().pop().unwrap();
    assert_eq!(
        arg.to_json(),
        Some(json_of(depth)),
        "the argument at {depth} arrived whole"
    );
    assert_eq!(json, Some(json_of(depth)));
    // The result, as data, JSON and JSON text.
    let outcome = rt.execute(format!("{code} return v").as_str());
    assert_eq!(outcome.json().unwrap(), json_of(depth));
    let text = outcome.result.unwrap().to_json_string();
    assert_eq!(text, json_of(depth).to_string());
    // A result the walk copies, as it holds a promise.
    let outcome =
        rt.execute(format!("{} return [Promise.resolve(1), v]", build(depth - 1)).as_str());
    assert_eq!(outcome.json().unwrap(), json!([1, json_of(depth - 1)]));
    // `JSON.stringify` in the program.
    let outcome = rt.execute(format!("{code} return JSON.stringify(v)").as_str());
    assert_eq!(outcome.json().unwrap(), json!(json_of(depth).to_string()));
    // A call's argument saved with the run, read back, and given to the call again on resume.
    assert_eq!(resumed_argument(depth).to_json(), Some(json_of(depth)));
}

/// Suspends a run while an idempotent call holding a value `depth` deep is in progress, and resumes it from bytes:
/// what the call gets again.
fn resumed_argument(depth: usize) -> HostValue {
    let (started, ready) = mpsc::channel();
    let pending = Runtime::make().limits(limited(depth)).globals(move |_| {
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
    let code = format!("{} await wait(v); return 1", build(depth));
    let program = pending.program(code.as_str(), &ProgramOptions::new());
    let state = suspend(program, ready);
    let state = from_bytes(&to_bytes(&state)).unwrap();
    let (got, arg) = mpsc::channel();
    let answering = Runtime::make().limits(limited(depth)).globals(move |_| {
        let got = got.clone();
        [(
            "wait",
            HostFunction::new_async(move |args, _| {
                let _ = got.send(args.into_iter().next().unwrap_or_default());
                async { Ok(HostValue::Undefined) }
            })
            .idempotent(),
        )]
    });
    let outcome = answering.resume(&state).unwrap().run().unwrap();
    assert!(outcome.result.is_ok(), "{:?}", outcome.result);
    arg.recv().unwrap()
}

/// Suspends `program` once `ready` says its call has started.
fn suspend(program: psychoscript::Program<'_>, ready: mpsc::Receiver<()>) -> Snapshot {
    let suspender = program.suspender();
    let outcome = std::thread::scope(|s| {
        s.spawn(move || {
            ready.recv().unwrap();
            for _ in 0..1000 {
                match suspender.suspend(None) {
                    Err(e) if !e.running.is_empty() => std::thread::sleep(Duration::from_millis(1)),
                    _ => break,
                }
            }
        });
        program.run_resumable().unwrap()
    });
    match outcome {
        RunOutcome::Suspended(s) => s.state,
        RunOutcome::Done(o) => panic!("the run ended: {:?}", o.result),
    }
}

#[test]
fn every_conversion_at_depth_200_fits_the_mobile_thread() {
    on_stack(MOBILE_THREAD, || every_path(200));
}

#[test]
fn every_conversion_at_depth_200_fits_half_of_it() {
    on_stack(HALF, || every_path(200));
}

#[test]
fn every_conversion_at_the_bound_fits_the_worker_thread() {
    on_stack(WORKER_THREAD, || every_path(MAX_VALUE_DEPTH_LIMIT));
}

#[test]
fn values_one_level_past_the_limit_fail_each_way() {
    for depth in [1, 32, 200, MAX_VALUE_DEPTH_LIMIT] {
        let rt = Runtime::make().limits(limited(depth)).globals(move |_| {
            [
                ("take", HostFunction::new(|_, _| HostValue::Undefined)),
                ("give", HostFunction::new(move |_, _| host(depth + 1))),
            ]
        });
        let code = build(depth + 1);
        let message = |code: &str| rt.execute(code).result.unwrap_err().message_lossy();
        assert!(message(&format!("{code} take(v)")).starts_with(&format!(
            "TypeError: Argument 1 to take exceeds the maximum value depth of {depth}."
        )));
        let returned = message("give()");
        assert!(returned.starts_with("TypeError: give"), "{returned}");
        assert!(returned.contains(&format!(" exceeds the maximum value depth of {depth}.")));
        assert_eq!(
            message(&format!("{code} return v")),
            format!("RangeError: Value exceeds the maximum depth of {depth}.")
        );
        assert!(
            message(&format!("{code} JSON.stringify(v)")).starts_with(&format!(
                "RangeError: Value exceeds the maximum depth of {depth}."
            ))
        );
    }
}

#[test]
#[should_panic(expected = "maxValueDepth must be an integer from 1 to 256.")]
fn a_depth_of_0_is_refused() {
    let _ = Runtime::make().limits(limited(0));
}

#[test]
#[should_panic(expected = "maxValueDepth must be an integer from 1 to 256.")]
fn a_depth_past_the_bound_is_refused() {
    let _ = Runtime::make().limits(limited(MAX_VALUE_DEPTH_LIMIT + 1));
}

/// A saved state holding host data nested deeper than any value a run may cross is refused when read back, instead
/// of recursing that deep: here a durable function's data, which the host makes.
#[test]
fn saved_data_nested_past_the_bound_is_refused() {
    let deep = |n: usize| {
        let mut d = Data::Number(0.into());
        for _ in 0..n {
            d = Data::Array(vec![d]);
        }
        d
    };
    let suspended = |n: usize| {
        let (started, ready) = mpsc::channel();
        let rt = Runtime::make().globals(move |_| {
            let started = started.clone();
            [(
                "job",
                DurableFunction::new(
                    move |_, _| {
                        let data = deep(n);
                        async move { Ok(data) }
                    },
                    move |_, _| {
                        let _ = started.send(());
                        std::future::pending()
                    },
                    |_, _| async {},
                ),
            )]
        });
        let program = rt.program("return await job()", &ProgramOptions::new());
        to_bytes(&suspend(program, ready))
    };
    let rt = Runtime::make().globals(|_| {
        [(
            "job",
            DurableFunction::new(
                |_, _| async { Ok(Data::Null) },
                |_, _| async { Ok(HostValue::Number(1.0)) },
                |_, _| async {},
            ),
        )]
    });
    assert!(rt.resume_bytes(&suspended(MAX_VALUE_DEPTH_LIMIT)).is_ok());
    let refused = rt
        .resume_bytes(&suspended(MAX_VALUE_DEPTH_LIMIT + 1))
        .err()
        .unwrap();
    assert!(
        refused
            .to_string()
            .contains("a host value is nested too deeply"),
        "{refused}"
    );
}
