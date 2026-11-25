//! Host functions against the reference's behaviour recorded in `conformance/host.json` by `bun conformance/host.ts`:
//! call keys, sync, async and sync-thenable functions, constructible ones, functions that take functions, idempotent
//! and durable calls across a suspend, failures, namespaces, run metadata, translation, limits and compiled programs.
//! The globals are the generator's, with Rust's own (`scale`, `mesh`, `mistyped`, `bounded`) for the Rust-only
//! features at the end of this file, whose expected results are written here: located host errors, function markers,
//! typed arrays, the heap limit and the value depth limit.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use psychoscript::{
    Data, Diagnostic, DurableFunction, Failure, HostError, HostFunction, HostValue, Json, Limits,
    Namespace, Outcome, ProgramOptions, Resolved, Returned, RunOutcome, Runtime, Translate,
    TranslateFunctions, TranslatePromises, to_bytes,
};
use serde_json::json;

#[path = "../../../conformance/reference.rs"]
mod reference;

use reference::describe;

type Log = Arc<Mutex<Vec<Json>>>;

/// What an entry's globals share: the log, whether the entry resumed, how often the globals were made, and whether a
/// call reached a point that never settles before the resume.
#[derive(Clone, Default)]
struct State {
    log: Log,
    resumed: Arc<AtomicBool>,
    made: Arc<AtomicUsize>,
    started: Arc<AtomicBool>,
    wakers: Arc<Mutex<Vec<Waker>>>,
}

impl State {
    fn push(&self, entry: Json) {
        self.log.lock().unwrap().push(entry);
    }

    /// Settles with `value` once the entry resumed; until then it never settles, and says a call reached it.
    fn pending(&self, value: f64) -> Pending {
        if !self.resumed.load(Ordering::SeqCst) {
            self.started.store(true, Ordering::SeqCst);
        }
        Pending {
            state: self.clone(),
            value,
        }
    }
}

struct Pending {
    state: State,
    value: f64,
}

impl Future for Pending {
    type Output = psychoscript::HostResult;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.state.resumed.load(Ordering::SeqCst) {
            return Poll::Ready(Ok(HostValue::Number(self.value)));
        }
        self.state.wakers.lock().unwrap().push(cx.waker().clone());
        Poll::Pending
    }
}

fn described(args: &[HostValue]) -> Json {
    Json::Array(args.iter().map(describe).collect())
}

fn num(v: Option<&HostValue>) -> f64 {
    v.and_then(HostValue::as_f64).unwrap_or(f64::NAN)
}

/// The generator's globals for a run.
fn globals(state: &State, run: &psychoscript::Run) -> Vec<(String, HostValue)> {
    state.made.fetch_add(1, Ordering::SeqCst);
    let s = state.clone();
    let one = |f: HostFunction| HostValue::from(f.length(1));
    let read = || {
        HostFunction::new(|_, _| HostValue::from("called"))
            .named("read")
            .takes_functions()
    };
    let (note, post, never, grab, wait) = (s.clone(), s.clone(), s.clone(), s.clone(), s.clone());
    let scale = s.clone();
    let (start, waited, cancel) = (s.clone(), s.clone(), s.clone());
    let counting = run.clone();
    vec![
        (
            "double".into(),
            one(HostFunction::new(|args, _| {
                HostValue::Number(num(args.first()) * 2.0)
            })),
        ),
        (
            "inc".into(),
            one(HostFunction::new(|args, _| {
                HostValue::Number(num(args.first()) + 1.0)
            })),
        ),
        (
            "promised".into(),
            one(HostFunction::new(|args, _| {
                let n = args.first().cloned().unwrap_or_default();
                Returned::Pending(Box::pin(async move { Ok(n) }))
            })),
        ),
        (
            "load".into(),
            one(HostFunction::new_async(|args, _| async move {
                Ok(args.into_iter().next().unwrap_or_default())
            })),
        ),
        (
            "find".into(),
            one(HostFunction::new(|_, _| {
                HostValue::object([("items", HostValue::array([1.0.into(), 2.0.into()]))])
            })
            .thenable()),
        ),
        (
            "scale".into(),
            HostFunction::new(move |args, call| {
                scale.push(json!(["scale", call.key(), describe(&args[0])]));
                let k = num(args.get(1));
                match &args[0] {
                    HostValue::TypedArray(t) => {
                        let kind = t.kind();
                        t.with_bytes_mut(|bytes| {
                            for c in bytes.chunks_exact_mut(kind.size()) {
                                let v = kind.read(c);
                                kind.write(v * k, c);
                            }
                        });
                        args[0].clone()
                    }
                    // A Uint8Array is the host's own copy.
                    HostValue::Bytes(b) => {
                        HostValue::Bytes(b.iter().map(|x| (*x as f64 * k) as u8).collect())
                    }
                    other => other.clone(),
                }
            })
            .into(),
        ),
        (
            "mesh".into(),
            HostFunction::new(|_, _| {
                HostValue::TypedArray(psychoscript::TypedArray::from_f32(&[0.5, 1.5, 2.5]))
            })
            .into(),
        ),
        (
            "note".into(),
            HostFunction::new(move |args, call| {
                note.push(json!(["note", call.key(), described(&args)]));
                HostValue::Undefined
            })
            .length(2)
            .into(),
        ),
        (
            "post".into(),
            HostFunction::new_async(move |args, call| {
                let post = post.clone();
                async move {
                    post.push(json!(["post", call.key(), described(&args)]));
                    Ok(HostValue::Undefined)
                }
            })
            .length(2)
            .into(),
        ),
        (
            "never".into(),
            HostFunction::new_async(move |_, call| {
                never.push(json!(["never", call.key()]));
                let pending = never.pending(f64::NAN);
                async move {
                    let _ = pending.await;
                    std::future::pending().await
                }
            })
            .length(2)
            .into(),
        ),
        (
            "open".into(),
            one(HostFunction::new(move |_, _| {
                HostValue::object([("read", read().into())])
            })),
        ),
        (
            "takes".into(),
            one(HostFunction::new(|args, _| {
                let read = args.first().and_then(|a| a.get("read"));
                HostValue::Bool(matches!(read, Some(HostValue::Function(f)) if f.name() == "read"))
            })
            .takes_functions()),
        ),
        (
            "refuses".into(),
            one(HostFunction::new(|_, _| HostValue::Bool(true))),
        ),
        (
            "grab".into(),
            HostFunction::new_async(move |_, call| {
                grab.push(json!(["grab", call.key()]));
                grab.pending(3.0)
            })
            .idempotent()
            .takes_functions()
            .length(2)
            .into(),
        ),
        (
            "Box".into(),
            one(HostFunction::new(|args, _| {
                HostValue::object([("item", args.into_iter().next().unwrap_or_default())])
            })
            .constructible()),
        ),
        (
            "Later".into(),
            one(HostFunction::new(|args, _| {
                HostValue::object([("item", args.into_iter().next().unwrap_or_default())])
            })
            .constructible()),
        ),
        (
            "refuse".into(),
            one(HostFunction::new(|_, _| -> psychoscript::HostResult {
                Err(Failure::new("Refused", "Not today")
                    .suggestions(["Ask again."])
                    .into())
            })),
        ),
        (
            "mistyped".into(),
            one(HostFunction::new(|args, _| -> psychoscript::HostResult {
                let n = match args.first() {
                    Some(HostValue::Number(n)) => n.to_string(),
                    Some(HostValue::String(s)) => s.to_string_lossy().into_owned(),
                    _ => String::new(),
                };
                Err(HostError::located("TypeError", format!("Not a name: {n}")))
            })),
        ),
        (
            "bounded".into(),
            one(HostFunction::new_async(|args, _| async move {
                let name = match args.first() {
                    Some(HostValue::String(s)) => s.clone(),
                    _ => "".into(),
                };
                Err(HostError::located(name, "Out of range"))
            })),
        ),
        (
            "api".into(),
            Namespace::new(
                |path| {
                    Ok(match path.len() {
                        0 => vec!["issues".into()],
                        _ => vec!["list".into()],
                    })
                },
                |path| -> Resolved {
                    if reference::joined(path) == "issues.list" {
                        return HostFunction::new_async(|_, _| async {
                            Ok(HostValue::array(["#1".into()]))
                        })
                        .length(1)
                        .into();
                    }
                    Failure::missing(format!("No api.{}", reference::joined(path)))
                        .suggestions(["Try api.issues.list."])
                        .kind("NotFound")
                        .into()
                },
            )
            .into(),
        ),
        (
            "count".into(),
            one(HostFunction::new(move |_, _| {
                counting.update_metadata(|m| {
                    let mut j = m.to_json();
                    if j.is_null() {
                        j = json!({ "count": 0 });
                    }
                    let n = j["count"].as_i64().unwrap_or(0) + 1;
                    j["count"] = json!(n);
                    *m = j.into();
                    HostValue::Number(n as f64)
                })
            })),
        ),
        (
            "wait".into(),
            HostFunction::new_async(move |_, call| {
                wait.push(json!(["wait", call.key()]));
                wait.pending(7.0)
            })
            .idempotent()
            .length(2)
            .into(),
        ),
        (
            "job".into(),
            DurableFunction::new(
                move |args, call| {
                    start.push(json!(["job.start", call.key(), described(&args)]));
                    let key = call.key();
                    async move { Ok(key.into()) }
                },
                move |data, call| {
                    waited.push(json!([
                        "job.wait",
                        data.to_json(),
                        call.key(),
                        described(&call.args)
                    ]));
                    waited.pending(41.0)
                },
                move |data, call| {
                    cancel.push(json!(["job.cancel", data.to_json(), call.key()]));
                    async {}
                },
            )
            .into(),
        ),
    ]
}

fn runtime(entry: &Json, state: &State) -> Runtime {
    let translate = Translate {
        functions: match entry["translate"]["functions"].as_str() {
            Some("drop") => TranslateFunctions::Drop,
            Some("mark") => TranslateFunctions::Mark,
            _ => TranslateFunctions::Error,
        },
        promises: match entry["translate"]["promises"].as_str() {
            Some("await") => TranslatePromises::Await,
            _ => TranslatePromises::Error,
        },
    };
    let limits = Limits {
        timeout_ms: entry["limits"]["timeoutMs"].as_u64(),
        max_output_bytes: entry["limits"]["maxOutputBytes"]
            .as_u64()
            .map(|n| n as usize),
        max_heap_bytes: entry["limits"]["maxHeapBytes"].as_u64(),
        max_value_depth: entry["limits"]["maxValueDepth"]
            .as_u64()
            .map(|n| n as usize),
        ..Limits::default()
    };
    let state = state.clone();
    Runtime::make()
        .translate(translate)
        .limits(limits)
        .globals(move |run| globals(&state, run))
}

fn diagnostic(d: &Diagnostic) -> Json {
    let mut out = json!({ "kind": d.kind.name(), "message": d.message_lossy() });
    if let Some((line, column)) = d.location {
        out["location"] = json!({ "line": line, "column": column });
    }
    if !d.suggestions.is_empty() {
        out["suggestions"] = json!(d.suggestions_lossy());
    }
    out
}

/// A result as `shown` in `conformance/host.ts` writes it: each function marker as `{ functionMarker: true }`.
fn marks(d: &Data) -> Json {
    match d {
        Data::FunctionMarker => json!({ "functionMarker": true }),
        Data::Array(items) => Json::Array(items.iter().map(marks).collect()),
        Data::Object(fields) => Json::Object(
            fields
                .iter()
                .map(|(k, v)| (k.to_string_lossy().into_owned(), marks(v)))
                .collect(),
        ),
        other => other.to_json(),
    }
}

/// The run's `Result` as the reference gives it.
fn result(o: &Outcome) -> Json {
    let mut out = match &o.result {
        Ok(value) => json!({ "ok": true, "value": marks(value) }),
        Err(d) => json!({ "ok": false, "error": diagnostic(d) }),
    };
    if !o.warnings.is_empty() {
        out["warnings"] = Json::Array(o.warnings.iter().map(diagnostic).collect());
    }
    if !o.logs.is_empty() {
        out["logs"] = json!(o.log_lines());
    }
    if o.truncated {
        out["truncated"] = json!(true);
    }
    out["metadata"] = o.metadata.to_json();
    out
}

/// JSON equality where numbers compare by value and object keys in any order.
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn fixture() -> Json {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/host.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn roundtrip() -> bool {
    std::env::var_os("PSYCHOSCRIPT_ROUNDTRIP").is_some_and(|v| v == "1")
}

/// What an `executes` entry gives, as the recording has it: `compile` and `again` for a compiled one, `outcome` and
/// `log`.
fn executed(entry: &Json) -> Json {
    let state = State::default();
    let rt = runtime(entry, &state);
    let code = entry["code"].as_str().unwrap();
    let options = ProgramOptions::new().run_id(entry["runId"].as_str().unwrap_or("run"));
    let mut actual = json!({});
    if entry["compiled"] == json!(true) {
        match rt.compile(code) {
            Ok(compiled) => {
                actual["compile"] = json!({ "ok": true });
                actual["outcome"] = result(&rt.execute_with(&compiled, &options));
                actual["again"] = result(&rt.execute_with(&compiled, &options));
            }
            Err(d) => {
                actual["compile"] = json!({ "ok": false, "error": diagnostic(&d) });
                actual["outcome"] = result(&rt.execute_with(code, &options));
            }
        }
    } else {
        actual["outcome"] = result(&rt.execute_with(code, &options));
    }
    actual["log"] = json!(*state.log.lock().unwrap());
    actual
}

/// Runs each entry with `run` and compares what it gives with what is expected (without `made` in the round-trip
/// mode, which makes the globals more often).
fn check(cases: impl IntoIterator<Item = (Json, Json)>, run: fn(&Json) -> Json) {
    let mut failures = Vec::new();
    for (entry, mut expected) in cases {
        if roundtrip()
            && let Some(fields) = expected.as_object_mut()
        {
            fields.remove("made");
        }
        let actual = run(&entry);
        if !same(&actual, &expected) {
            failures.push(format!(
                "{}\n  expected {expected}\n  actual   {actual}",
                entry["code"].as_str().unwrap()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The recorded fields of an entry that are what it gives.
fn recorded(entry: &Json, keys: &[&str]) -> (Json, Json) {
    let mut expected = json!({});
    for key in keys {
        if let Some(v) = entry.get(*key) {
            expected[*key] = v.clone();
        }
    }
    (entry.clone(), expected)
}

#[test]
fn host_functions_match_the_reference() {
    let fixture = fixture();
    let executes = fixture["executes"].as_array().unwrap();
    assert!(executes.len() >= 50);
    check(
        executes
            .iter()
            .map(|e| recorded(e, &["compile", "outcome", "again", "log"])),
        executed,
    );
}

/// Wakes the thread that drives a run.
struct Unpark(std::thread::Thread);

impl Wake for Unpark {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// What a `suspensions` entry gives, as the recording has it: `suspend`, `resume` once resumed, `made` (not in the
/// round-trip mode) and `log`.
fn suspended(entry: &Json) -> Json {
    let state = State::default();
    let rt = runtime(entry, &state);
    let code = entry["code"].as_str().unwrap();
    let options = ProgramOptions::new().run_id(entry["runId"].as_str().unwrap_or("run"));
    let compiled = (entry["compiled"] == json!(true)).then(|| rt.compile(code).unwrap());
    let program = match &compiled {
        Some(c) => rt.program(c, &options),
        None => rt.program(code, &options),
    };
    let suspender = program.suspender();
    // This thread drives the run, as the reference's fiber; another suspends it once a call reached a point that
    // never settles before the resume. A failed suspend interrupts the run, which drops it.
    let (suspend, ran) = std::thread::scope(|s| {
        let started = state.started.clone();
        let asking = s.spawn(move || {
            while !started.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            suspender.suspend(None)
        });
        let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let mut run = Box::pin(program.run_resumable_async());
        loop {
            if let Poll::Ready(ran) = run.as_mut().poll(&mut cx) {
                break (asking.join().unwrap(), Some(ran.unwrap()));
            }
            if asking.is_finished() {
                let answer = asking.join().unwrap();
                if answer.is_err() {
                    drop(run);
                    break (answer, None);
                }
                let ran = loop {
                    if let Poll::Ready(ran) = run.as_mut().poll(&mut cx) {
                        break ran.unwrap();
                    }
                    std::thread::park_timeout(Duration::from_millis(1));
                };
                break (answer, Some(ran));
            }
            std::thread::park_timeout(Duration::from_millis(1));
        }
    });
    let mut actual = json!({});
    match (&suspend, ran) {
        (Err(e), _) => {
            actual["suspend"] = json!({
                "ok": false,
                "message": e.message,
                "running": e.running.iter().map(|c| json!({ "key": c.key, "path": c.path })).collect::<Vec<_>>(),
            });
        }
        (Ok(RunOutcome::Done(o)), _) => {
            actual["suspend"] = json!({ "ok": false, "outcome": result(o) });
        }
        (Ok(RunOutcome::Suspended(answer)), Some(RunOutcome::Suspended(saved))) => {
            actual["suspend"] = json!({
                "ok": true,
                "metadata": answer.state.0["header"]["metadata"],
                "same": answer.state == saved.state,
            });
            state.resumed.store(true, Ordering::SeqCst);
            for w in state.wakers.lock().unwrap().drain(..) {
                w.wake();
            }
            let resumed = rt
                .resume_bytes(&to_bytes(&answer.state))
                .unwrap()
                .run_resumable()
                .unwrap();
            actual["resume"] = match resumed {
                RunOutcome::Done(o) => result(&o),
                RunOutcome::Suspended(_) => json!("suspended again"),
            };
        }
        (Ok(_), _) => actual["suspend"] = json!("suspended, but the run went on"),
    }
    // The reference's round-trip mode makes the globals more often.
    if !roundtrip() {
        actual["made"] = json!(state.made.load(Ordering::SeqCst));
    }
    actual["log"] = Json::Array(state.log.lock().unwrap().clone());
    actual
}

#[test]
fn suspending_runs_that_call_host_functions_matches_the_reference() {
    let fixture = fixture();
    let suspensions = fixture["suspensions"].as_array().unwrap();
    assert!(suspensions.len() >= 10);
    check(
        suspensions
            .iter()
            .map(|e| recorded(e, &["suspend", "resume", "made", "log"])),
        suspended,
    );
}

// Rust only: what the TypeScript implementation doesn't have, so `conformance/host.json` can't record it. The same
// globals and entries as the recording, with the expected results written here.

/// A value nested `n` levels, as the programs' `deep(n)` builds it: objects and arrays in turn around 0.
fn nest(n: usize) -> Json {
    (0..n).fold(json!(0), |v, i| {
        if i % 2 == 1 {
            json!([v])
        } else {
            json!({ "c": v })
        }
    })
}

/// `HostError::located` (`mistyped`, `bounded`): an error of its class, located at the call, also once resumed.
#[test]
fn located_host_errors() {
    check(
        [
            (
                json!({ "code": "const n = 1\n  mistyped(n)" }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "TypeError: Not a name: 1 (line 2, col 3)",
                            "location": { "line": 2, "column": 3 }
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({ "code": "await null\nawait bounded(\"RangeError\")" }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "RangeError: Out of range (line 2, col 7)",
                            "location": { "line": 2, "column": 7 }
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "try { mistyped(2) } catch (e) { return [e instanceof TypeError, e.constructor === TypeError, e.name, e.message, e.stack, Object.keys(e)] }"
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": [
                            true,
                            true,
                            "TypeError",
                            "Not a name: 2",
                            "TypeError: Not a name: 2\n    at <program>:1:7",
                            []
                        ],
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "const kinds = [\"Error\", \"TypeError\", \"RangeError\", \"SyntaxError\", \"ReferenceError\", \"EvalError\", \"URIError\", \"AggregateError\", \"Other\"]\nreturn await Promise.all(kinds.map((k) => bounded(k).catch((e) => [e.constructor.name, e.name, e.message, e.stack, e instanceof Error, Object.keys(e)])))"
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": [
                            [
                                "Error",
                                "Error",
                                "Out of range",
                                "Error: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "TypeError",
                                "TypeError",
                                "Out of range",
                                "TypeError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "RangeError",
                                "RangeError",
                                "Out of range",
                                "RangeError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "SyntaxError",
                                "SyntaxError",
                                "Out of range",
                                "SyntaxError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "ReferenceError",
                                "ReferenceError",
                                "Out of range",
                                "ReferenceError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "EvalError",
                                "EvalError",
                                "Out of range",
                                "EvalError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "URIError",
                                "URIError",
                                "Out of range",
                                "URIError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "AggregateError",
                                "AggregateError",
                                "Out of range",
                                "AggregateError: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ],
                            [
                                "Error",
                                "Error",
                                "Out of range",
                                "Error: Out of range\n    at <program>:2:43",
                                true,
                                []
                            ]
                        ],
                        "metadata": null
                    },
                    "log": []
                }),
            ),
        ],
        executed,
    );
    check(
        [
            (
                json!({
                    "code": "const n = await wait()\ntry { mistyped(n) } catch (e) { return [e.stack, await bounded(\"RangeError\").catch((e) => e.stack)] }",
                    "runId": "m"
                }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": {
                        "ok": true,
                        "value": [
                            "TypeError: Not a name: 7\n    at <program>:2:7",
                            "RangeError: Out of range\n    at <program>:2:56"
                        ],
                        "metadata": null
                    },
                    "made": 2,
                    "log": [["wait", "m:0"], ["wait", "m:0"]]
                }),
            ),
            (
                json!({ "code": "const n = await wait()\nawait bounded(\"RangeError\")", "runId": "m" }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "RangeError: Out of range (line 2, col 7)",
                            "location": { "line": 2, "column": 7 }
                        },
                        "metadata": null
                    },
                    "made": 2,
                    "log": [["wait", "m:0"], ["wait", "m:0"]]
                }),
            ),
        ],
        suspended,
    );
}

/// `TranslateFunctions::Mark`: a function marker where each function was, in arguments and results; it cannot come
/// back, and a call keeps its markers across a suspend.
#[test]
fn function_markers() {
    check(
        [
            (
                json!({
                    "code": "const e = new Error(\"x\"); e.f = () => 1\nnote({ q: \"x\", format(v) { return v }, nested: { f: Math.max, list: [class A {}, note.bind(null)] } }, [1, () => 2, note], () => 3, new Map([[\"k\", () => 1]]), new Set([() => 1]), e)",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "outcome": { "ok": true, "value": null, "metadata": null },
                    "log": [
                        [
                            "note",
                            "run:0",
                            [
                                {
                                    "object": [
                                        ["q", "x"],
                                        ["format", { "functionMarker": true }],
                                        [
                                            "nested",
                                            {
                                                "object": [
                                                    ["f", { "functionMarker": true }],
                                                    [
                                                        "list",
                                                        {
                                                            "array": [
                                                                { "functionMarker": true },
                                                                { "functionMarker": true }
                                                            ]
                                                        }
                                                    ]
                                                ]
                                            }
                                        ]
                                    ]
                                },
                                { "array": [1, { "functionMarker": true }, { "functionMarker": true }] },
                                { "functionMarker": true },
                                { "map": [["k", { "functionMarker": true }]] },
                                { "set": [{ "functionMarker": true }] },
                                {
                                    "error": {
                                        "name": "Error",
                                        "message": "x",
                                        "fields": [["f", { "functionMarker": true }]]
                                    }
                                }
                            ]
                        ]
                    ]
                }),
            ),
            (
                json!({
                    "code": "note({ f() {}, p: load(1) }, Promise.resolve([() => 2]))",
                    "translate": { "functions": "mark", "promises": "await" }
                }),
                json!({
                    "outcome": { "ok": true, "value": null, "metadata": null },
                    "log": [
                        [
                            "note",
                            "run:1",
                            [
                                { "object": [["f", { "functionMarker": true }], ["p", 1]] },
                                { "array": [{ "functionMarker": true }] }
                            ]
                        ]
                    ]
                }),
            ),
            (
                json!({ "code": "return await load({ f() {} })", "translate": { "functions": "mark" } }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "TypeError: load.f produced a function marker, which the program cannot hold. (line 1, col 14)",
                            "location": { "line": 1, "column": 14 }
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "try { await load([() => 1]) } catch (e) { return [e.name, e.message] }",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": [
                            "TypeError",
                            "load[0] produced a function marker, which the program cannot hold."
                        ],
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "return [takes({ read: open().read, f() {} }), takes(() => 1)]",
                    "translate": { "functions": "mark" }
                }),
                json!({ "outcome": { "ok": true, "value": [true, false], "metadata": null }, "log": [] }),
            ),
            (
                json!({ "code": "note({ p: Promise.resolve(1) })", "translate": { "functions": "mark" } }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "TypeError: Argument 1 to note contains an un-awaited Promise, which cannot be passed to the host. (line 1, col 1)",
                            "location": { "line": 1, "column": 1 }
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "const e = new Error(\"x\"); e.f = () => 1\nreturn { a: 1, f() {}, list: [() => 1, 2, double], s: new Set([() => 1]), e, m: new Map([[\"k\", () => 1]]), api: api.issues.list, read: open().read, n: { g: class {} } }",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": {
                            "a": 1,
                            "f": { "functionMarker": true },
                            "list": [{ "functionMarker": true }, 2, { "functionMarker": true }],
                            "s": [{ "functionMarker": true }],
                            "e": { "name": "Error", "message": "x", "f": { "functionMarker": true } },
                            "m": {},
                            "api": { "functionMarker": true },
                            "read": { "functionMarker": true },
                            "n": { "g": { "functionMarker": true } }
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({ "code": "return () => 1", "translate": { "functions": "mark" } }),
                json!({
                    "outcome": { "ok": true, "value": { "functionMarker": true }, "metadata": null },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "return [{ p: load(1).then(() => ({ f() {} })), t: { toJSON() { return () => 1 } } }, Promise.resolve([() => 1])]",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": [
                            {
                                "p": { "f": { "functionMarker": true } },
                                "t": { "functionMarker": true }
                            },
                            [{ "functionMarker": true }]
                        ],
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "return { f() {}, list: [() => 1, \"x\".repeat(20)] }",
                    "translate": { "functions": "mark" },
                    "limits": { "maxOutputBytes": 30 }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": "{\"list\":[null,\"xxxxxxxxxxxxxxx [result truncated: 38 bytes exceeds the 30-byte output limit; return a smaller value]",
                        "truncated": true,
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "return { f() {}, list: [() => 1, \"x\".repeat(10)] }",
                    "translate": { "functions": "mark" },
                    "limits": { "maxOutputBytes": 30 }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": {
                            "f": { "functionMarker": true },
                            "list": [{ "functionMarker": true }, "xxxxxxxxxx"]
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
        ],
        executed,
    );
    check(
        [
            (
                json!({
                    "code": "return (await job({ on() {} }, [() => 1, 2])) + 1",
                    "runId": "d",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": { "ok": true, "value": 42, "metadata": null },
                    "made": 2,
                    "log": [
                        [
                            "job.start",
                            "d:0",
                            [
                                { "object": [["on", { "functionMarker": true }]] },
                                { "array": [{ "functionMarker": true }, 2] }
                            ]
                        ],
                        [
                            "job.wait",
                            "d:0",
                            "d:0",
                            [
                                { "object": [["on", { "functionMarker": true }]] },
                                { "array": [{ "functionMarker": true }, 2] }
                            ]
                        ],
                        [
                            "job.wait",
                            "d:0",
                            "d:0",
                            [
                                { "object": [["on", { "functionMarker": true }]] },
                                { "array": [{ "functionMarker": true }, 2] }
                            ]
                        ]
                    ]
                }),
            ),
            (
                json!({
                    "code": "return [await wait({ on() {} }, [() => 1]), 1]",
                    "runId": "i",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": { "ok": true, "value": [7, 1], "metadata": null },
                    "made": 2,
                    "log": [["wait", "i:0"], ["wait", "i:0"]]
                }),
            ),
            (
                json!({
                    "code": "const on = () => 1; await wait(); return { on, list: [on, await load(1)] }",
                    "runId": "i",
                    "translate": { "functions": "mark" }
                }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": {
                        "ok": true,
                        "value": { "on": { "functionMarker": true }, "list": [{ "functionMarker": true }, 1] },
                        "metadata": null
                    },
                    "made": 2,
                    "log": [["wait", "i:0"], ["wait", "i:0"]]
                }),
            ),
        ],
        suspended,
    );
}

/// Typed arrays: other than Uint8Array, they cross to a sync host function (`scale`) as views of the same bytes, which
/// it reads and writes in place; a Uint8Array as a copy. What a host function returns (`mesh`) stays a view of its
/// bytes.
#[test]
fn typed_arrays() {
    check(
        [
            (
                json!({
                    "code": "const v = new Float32Array([1, 2, 3]); const r = scale(v, 2); return [Array.from(v), r instanceof Float32Array, Array.from(r), r === v]"
                }),
                json!({
                    "outcome": { "ok": true, "value": [[2, 4, 6], true, [2, 4, 6], false], "metadata": null },
                    "log": [["scale", "run:0", { "typed": ["Float32Array", [1, 2, 3]] }]]
                }),
            ),
            (
                json!({
                    "code": "const b = new ArrayBuffer(8); const f = new Float32Array(b); scale(f.subarray(1), 3); f[1] = 4; scale(f, 1); note(b, new Int32Array(b, 4, 1)); return Array.from(f)"
                }),
                json!({
                    "outcome": { "ok": true, "value": [0, 4], "metadata": null },
                    "log": [
                        ["scale", "run:0", { "typed": ["Float32Array", [0]] }],
                        ["scale", "run:1", { "typed": ["Float32Array", [0, 4]] }],
                        [
                            "note",
                            "run:2",
                            [
                                { "arrayBuffer": [0, 0, 0, 0, 0, 0, 128, 64] },
                                { "typed": ["Int32Array", [1082130432]] }
                            ]
                        ]
                    ]
                }),
            ),
            (
                json!({
                    "code": "const u = new Uint8Array([1, 2]); scale(u, 2); return Array.from(u)"
                }),
                json!({
                    "outcome": { "ok": true, "value": [1, 2], "metadata": null },
                    "log": [["scale", "run:0", { "bytes": [1, 2] }]]
                }),
            ),
            (
                json!({
                    "code": "const m = mesh(); m[0] = 9; return [m.constructor.name, Array.from(m), m.byteLength, m.buffer.byteLength]"
                }),
                json!({
                    "outcome": { "ok": true, "value": ["Float32Array", [9, 1.5, 2.5], 12, 12], "metadata": null },
                    "log": []
                }),
            ),
            (
                json!({ "code": "return mesh()" }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "InvalidDataValue",
                            "message": "TypeError: A Float32Array cannot cross to the host as data; pass it to a host function, or its values, e.g. `Array.from(values)`."
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
        ],
        executed,
    );
}

/// `Limits::max_heap_bytes`: measured where the calls are handed over, which then never start, and when the body ends;
/// a resumed run keeps its limit.
#[test]
fn heap_limit() {
    check(
        [
            (
                json!({
                    "code": "note(1); const a = new Array(100000); await load(1); return a.length",
                    "limits": { "maxHeapBytes": 1000000 }
                }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "MemoryLimitExceeded",
                            "message": "Execution exceeded its memory limit of 1000000 bytes."
                        },
                        "metadata": null
                    },
                    "log": [["note", "run:0", [1]]]
                }),
            ),
            (
                json!({
                    "code": "const a = []; while (true) a.push(inc(a.length))",
                    "limits": { "maxHeapBytes": 1000000 }
                }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "MemoryLimitExceeded",
                            "message": "Execution exceeded its memory limit of 1000000 bytes."
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "note(1); Math.kept = new Array(1000).fill(\"y\".repeat(100000)); return 1",
                    "limits": { "maxHeapBytes": 216080 }
                }),
                json!({
                    "outcome": { "ok": true, "value": 1, "metadata": null },
                    "log": [["note", "run:0", [1]]]
                }),
            ),
            (
                json!({
                    "code": "note(1); Math.kept = new Array(1000).fill(\"y\".repeat(100000)); return 1",
                    "limits": { "maxHeapBytes": 216079 }
                }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "MemoryLimitExceeded",
                            "message": "Execution exceeded its memory limit of 216079 bytes."
                        },
                        "metadata": null
                    },
                    "log": [["note", "run:0", [1]]]
                }),
            ),
        ],
        executed,
    );
    check(
        [(
            json!({
                "code": "const kept = []; for (let i = 0; i < 1000; i++) kept.push({ i }); await wait(); while (true) kept.push({})",
                "runId": "h",
                "limits": { "maxHeapBytes": 1000000 }
            }),
            json!({
                "suspend": { "ok": true, "metadata": null, "same": true },
                "resume": {
                    "ok": false,
                    "error": {
                        "kind": "MemoryLimitExceeded",
                        "message": "Execution exceeded its memory limit of 1000000 bytes."
                    },
                    "metadata": null
                },
                "made": 2,
                "log": [["wait", "h:0"], ["wait", "h:0"]]
            }),
        )],
        suspended,
    );
}

/// `Limits::max_value_depth`: a value N deep crosses, N + 1 deep fails, each way; the walk the result takes for a
/// promise allows at least 100; JSON.stringify copies to the same depth. A raised limit: a deep argument is saved and
/// the call made again on resume, and the resumed run keeps the limit.
#[test]
fn value_depth() {
    check(
        [
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; note(deep(4)); try { note(deep(5)) } catch (e) { return [e.name, e.message] }",
                    "limits": { "maxValueDepth": 4 }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": ["TypeError", "Argument 1 to note exceeds the maximum value depth of 4."],
                        "metadata": null
                    },
                    "log": [
                        [
                            "note",
                            "run:0",
                            [
                                {
                                    "array": [{ "object": [["c", { "array": [{ "object": [["c", 0]] }] }]] }]
                                }
                            ]
                        ]
                    ]
                }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; const a = new Box(deep(3)).item; try { Box(deep(4)) } catch (e) { return [a, e.name, e.message] }",
                    "limits": { "maxValueDepth": 4 }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": [
                            { "c": [{ "c": 0 }] },
                            "TypeError",
                            "Box.item[0].c[0].c exceeds the maximum value depth of 4."
                        ],
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(4)",
                    "limits": { "maxValueDepth": 4 }
                }),
                json!({
                    "outcome": { "ok": true, "value": [{ "c": [{ "c": 0 }] }], "metadata": null },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(5)",
                    "limits": { "maxValueDepth": 4 }
                }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "RangeError: Value exceeds the maximum depth of 4."
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return [Promise.resolve(1), deep(60)]",
                    "limits": { "maxValueDepth": 4 }
                }),
                json!({ "outcome": { "ok": true, "value": [1, nest(60)], "metadata": null }, "log": [] }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return [Promise.resolve(1), deep(109)]",
                    "limits": { "maxValueDepth": 110 }
                }),
                json!({ "outcome": { "ok": true, "value": [1, nest(109)], "metadata": null }, "log": [] }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; const ok = JSON.stringify(deep(4)).length; try { JSON.stringify(deep(5)) } catch (e) { return [ok, e.name, e.message] }",
                    "limits": { "maxValueDepth": 4 }
                }),
                json!({
                    "outcome": {
                        "ok": true,
                        "value": [17, "RangeError", "Value exceeds the maximum depth of 4."],
                        "metadata": null
                    },
                    "log": []
                }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; refuses(deep(256)); const back = await load(deep(256)); return [JSON.stringify(back).length, JSON.stringify(deep(256)) === JSON.stringify(back)]",
                    "limits": { "maxValueDepth": 256 }
                }),
                json!({ "outcome": { "ok": true, "value": [1025, true], "metadata": null }, "log": [] }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(100)",
                    "limits": { "maxValueDepth": 100 }
                }),
                json!({ "outcome": { "ok": true, "value": nest(100), "metadata": null }, "log": [] }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(257)",
                    "limits": { "maxValueDepth": 256 }
                }),
                json!({
                    "outcome": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "RangeError: Value exceeds the maximum depth of 256."
                        },
                        "metadata": null
                    },
                    "log": []
                }),
            ),
        ],
        executed,
    );
    check(
        [
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; await wait(deep(200)); return JSON.stringify(await load(deep(200))).length",
                    "runId": "i",
                    "limits": { "maxValueDepth": 200 }
                }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": { "ok": true, "value": 801, "metadata": null },
                    "made": 2,
                    "log": [["wait", "i:0"], ["wait", "i:0"]]
                }),
            ),
            (
                json!({
                    "code": "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; await wait(); return deep(201)",
                    "runId": "i",
                    "limits": { "maxValueDepth": 200 }
                }),
                json!({
                    "suspend": { "ok": true, "metadata": null, "same": true },
                    "resume": {
                        "ok": false,
                        "error": {
                            "kind": "ExecutionFailure",
                            "message": "RangeError: Value exceeds the maximum depth of 200."
                        },
                        "metadata": null
                    },
                    "made": 2,
                    "log": [["wait", "i:0"], ["wait", "i:0"]]
                }),
            ),
        ],
        suspended,
    );
}
