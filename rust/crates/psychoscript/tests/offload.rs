//! A run driven as a future moves long stretches of compute to a worker thread; host code never runs there.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use psychoscript::{
    Data, DurableFunction, HostFunction, HostString, HostValue, HttpBody, Namespace,
    ProgramOptions, Returned, RunOutcome, Runtime, StreamingResponse,
};
use serde_json::json;

/// Counts the host code that ran, and how much of it ran off the thread that drives the run.
#[derive(Clone)]
struct Witness {
    driver: ThreadId,
    ran: Arc<AtomicUsize>,
    strays: Arc<AtomicUsize>,
}

impl Witness {
    fn new() -> Self {
        Self {
            driver: thread::current().id(),
            ran: Arc::default(),
            strays: Arc::default(),
        }
    }

    fn check(&self) {
        self.ran.fetch_add(1, Ordering::SeqCst);
        if thread::current().id() != self.driver {
            self.strays.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn first(args: Vec<HostValue>) -> HostValue {
    args.into_iter().next().unwrap_or_default()
}

/// Every kind of host code a program can reach, each noting where it runs: synchronous functions, one blocking the
/// program on work and one leaving work pending, an asynchronous function, a durable one, and a namespace.
fn runtime(w: &Witness) -> Runtime {
    let w = w.clone();
    Runtime::make().globals(move |_| {
        let (a, b, c, d, e, f) = (
            w.clone(),
            w.clone(),
            w.clone(),
            w.clone(),
            w.clone(),
            w.clone(),
        );
        let (start, wait) = (w.clone(), w.clone());
        let (keys, resolve) = (w.clone(), w.clone());
        vec![
            (
                "sync",
                HostValue::from(HostFunction::new(move |args, _| {
                    a.check();
                    Ok::<_, HostValue>(first(args))
                })),
            ),
            (
                "slow",
                HostFunction::new_async(move |args, _| {
                    let b = b.clone();
                    async move {
                        b.check();
                        Ok(later(5, first(args)).await)
                    }
                })
                .into(),
            ),
            (
                "block",
                HostFunction::new(move |args, _| {
                    c.check();
                    let c = c.clone();
                    Returned::Block(Box::pin(async move {
                        c.check();
                        Ok(later(5, first(args)).await)
                    }))
                })
                .into(),
            ),
            (
                "pending",
                HostFunction::new(move |args, _| {
                    d.check();
                    let d = d.clone();
                    Returned::Pending(Box::pin(async move {
                        d.check();
                        Ok(first(args))
                    }))
                })
                .into(),
            ),
            (
                "durable",
                DurableFunction::new(
                    move |_, _| {
                        let start = start.clone();
                        async move {
                            start.check();
                            Ok(Data::Null)
                        }
                    },
                    move |_, _| {
                        let wait = wait.clone();
                        async move {
                            wait.check();
                            Ok(HostValue::Number(7.0))
                        }
                    },
                    |_, _| async {},
                )
                .into(),
            ),
            (
                "ns",
                Namespace::new(
                    move |_| {
                        keys.check();
                        Ok(vec![HostString::from("f")])
                    },
                    move |_| {
                        resolve.check();
                        let e = e.clone();
                        HostFunction::new(move |args, _| {
                            e.check();
                            Ok::<_, HostValue>(first(args))
                        })
                    },
                )
                .into(),
            ),
            (
                "spare",
                HostFunction::new(move |_, _| {
                    f.check();
                    Ok::<_, HostValue>(HostValue::Undefined)
                })
                .into(),
            ),
        ]
    })
}

/// Each host call follows a stretch of compute long enough to move to the worker.
const BUSY_THEN_HOST: &str = "
    const spin = (k) => { let n = 0; for (let i = 0; i < k; i++) n += i % 7; return n > 0 }
    const a = spin(2e6) && sync(1)
    const b = spin(2e6) && await slow(2)
    const c = spin(2e6) && block(3)
    const d = spin(2e6) && await pending(4)
    const e = spin(2e6) && await durable()
    const f = spin(2e6) && ns.f(5)
    const g = spin(2e6) && Object.keys(ns).length
    const h = spin(2e6) && await Promise.all([slow(6), sync(7)])
    return [a, b, c, d, e, f, g, h, spin(1e6)]";

#[test]
fn long_compute_leaves_the_executor_while_host_code_stays_on_it() {
    let w = Witness::new();
    let rt = runtime(&w);
    let options = ProgramOptions::new();
    let expected = json!([1, 2, 3, 4, 7, 5, 1, [6, 7], true]);
    let started = Instant::now();
    let blocking = rt.execute(BUSY_THEN_HOST);
    let whole = started.elapsed();
    assert_eq!(blocking.json().unwrap(), expected);
    let ran_blocking = w.ran.swap(0, Ordering::SeqCst);

    let mut run = Box::pin(rt.execute_async(BUSY_THEN_HOST, &options));
    let started = Instant::now();
    assert!(
        run.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    assert!(
        started.elapsed() < whole / 4,
        "the first poll held the executor for {:?} of {whole:?}",
        started.elapsed()
    );
    let outcome = drive(run).unwrap();
    assert_eq!(outcome.json().unwrap(), expected);
    assert_eq!(w.ran.load(Ordering::SeqCst), ran_blocking);
    assert_eq!(w.strays.load(Ordering::SeqCst), 0);
}

/// A future that never ends and notes the thread it is dropped on.
struct Forever(Arc<Mutex<Option<ThreadId>>>);

impl Future for Forever {
    type Output = Result<HostValue, HostValue>;

    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Pending
    }
}

impl Drop for Forever {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = Some(thread::current().id());
    }
}

#[test]
fn dropping_a_run_away_on_its_worker_ends_it_here() {
    let dropped = Arc::new(Mutex::new(None));
    let seen = dropped.clone();
    let rt = Runtime::make().globals(move |_| {
        let seen = seen.clone();
        [(
            "never",
            HostFunction::new_async(move |_, _| Forever(seen.clone())),
        )]
    });
    let options = ProgramOptions::new();
    let mut run = Box::pin(rt.execute_async("never(); while (true) {}", &options));
    let waker = Waker::noop();
    assert!(
        run.as_mut()
            .poll(&mut Context::from_waker(waker))
            .is_pending()
    );
    thread::sleep(Duration::from_millis(10));
    assert!(
        run.as_mut()
            .poll(&mut Context::from_waker(waker))
            .is_pending()
    );
    drop(run);
    assert_eq!(*dropped.lock().unwrap(), Some(thread::current().id()));
}

#[test]
fn a_run_away_on_its_worker_suspends_and_resumes() {
    let rt = Runtime::make();
    let code = "let n = 0; for (let i = 0; i < 2e9; i++) n++; return n > 0";
    let program = rt.program(code, &ProgramOptions::new());
    let suspender = program.suspender();
    let mut run = Box::pin(program.run_resumable_async());
    assert!(
        run.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let asked = thread::spawn(move || suspender.suspend(None));
    let outcome = drive(run).unwrap();
    let answer = asked.join().unwrap().unwrap();
    let (RunOutcome::Suspended(state), RunOutcome::Suspended(_)) = (outcome, answer) else {
        panic!("expected a suspended run");
    };
    assert!(rt.resume(&state.state).is_ok());
}

/// A body whose `cancel` notes where it ran.
struct Cancelled(Witness);

impl HttpBody for Cancelled {
    fn poll_chunk(&mut self, _: &mut Context<'_>) -> Poll<Option<Result<Vec<u8>, HostValue>>> {
        Poll::Ready(None)
    }

    fn cancel(&mut self, _: HostValue) {
        self.0.check();
    }
}

#[test]
fn a_body_cancelled_while_its_run_is_on_a_worker_cancels_on_the_executor() {
    let w = Witness::new();
    let body = w.clone();
    let rt = Runtime::make().globals(move |_| {
        let body = body.clone();
        [(
            "fetch",
            HostFunction::new_async(move |_, _| {
                let body = Cancelled(body.clone());
                async move {
                    Ok(HostValue::Response(StreamingResponse::new(
                        200,
                        Some(Box::new(body) as Box<dyn HttpBody>),
                    )))
                }
            }),
        )]
    });
    // A loop long enough to move to the worker, then a cancel queued there, which starts when the program next looks
    // at the body after the run has handed calls over: at the `bodyUsed` getter, still on the worker.
    let code = "const r = await fetch(); let n = 0
        for (let i = 0; i < 3e6; i++) n += i % 3
        r.body.cancel('stop')
        for (let i = 0; i < 1e5; i++) n += i % 3
        return r.bodyUsed && n > 0";
    let outcome = drive(rt.execute_async(code, &ProgramOptions::new())).unwrap();
    assert_eq!(outcome.json().unwrap(), json!(true));
    assert_eq!(w.ran.load(Ordering::SeqCst), 1);
    assert_eq!(w.strays.load(Ordering::SeqCst), 0);
}

/// A value that arrives after `ms` from another thread: an asynchronous host operation without an executor.
fn later<T: Send + 'static>(ms: u64, value: T) -> impl Future<Output = T> {
    let state = Arc::new(Mutex::new((None, None::<Waker>)));
    let shared = state.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(ms));
        let mut s = shared.lock().unwrap();
        s.0 = Some(value);
        if let Some(w) = s.1.take() {
            w.wake();
        }
    });
    std::future::poll_fn(move |cx| {
        let mut s = state.lock().unwrap();
        match s.0.take() {
            Some(v) => Poll::Ready(v),
            None => {
                s.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    })
}

/// Polls a future to its end on this thread, parking until it is woken.
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

/// Cooperative single-threaded executor: drives `main` and only pumps `tasks` between `Poll::Pending` returns.
/// If `main` ever blocks the thread waiting on a deferred future, `tasks` never runs and the test fails/deadlocks.
type CoopTask = Box<dyn FnOnce() + Send>;

#[derive(Clone, Default)]
struct CoopQueue {
    tasks: Arc<Mutex<Vec<CoopTask>>>,
}

#[derive(Default)]
struct DeferState {
    result: Option<Result<HostValue, HostValue>>,
    waker: Option<Waker>,
}

impl CoopQueue {
    fn defer_result(
        &self,
        result: Result<HostValue, HostValue>,
    ) -> impl Future<Output = Result<HostValue, HostValue>> + 'static {
        let state = Arc::new(Mutex::new(DeferState::default()));
        let queue = self.clone();
        let mut enqueued = false;
        let mut result = Some(result);
        std::future::poll_fn(move |cx| {
            let mut guard = state.lock().unwrap();
            if let Some(res) = guard.result.take() {
                return Poll::Ready(res);
            }
            guard.waker = Some(cx.waker().clone());
            if !enqueued {
                enqueued = true;
                let res = result.take().unwrap();
                let st = state.clone();
                queue.tasks.lock().unwrap().push(Box::new(move || {
                    let mut g = st.lock().unwrap();
                    g.result = Some(res);
                    if let Some(w) = g.waker.take() {
                        w.wake();
                    }
                }));
            }
            Poll::Pending
        })
    }

    fn drive<F: Future>(&self, future: F) -> F::Output {
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        let mut future = std::pin::pin!(future);
        for _ in 0..10_000 {
            if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
                return v;
            }
            let batch: Vec<CoopTask> = std::mem::take(&mut *self.tasks.lock().unwrap());
            if batch.is_empty() {
                // Worker thread may still be computing; yield briefly so it can send `ToHome::Await`/`Back`.
                thread::sleep(Duration::from_millis(1));
            } else {
                for task in batch {
                    task();
                }
            }
        }
        panic!("single-threaded cooperative executor stalled (future never completed)");
    }
}

#[test]
fn returned_block_yields_to_single_threaded_executor_before_and_after_offload() {
    let queue = CoopQueue::default();
    let q1 = queue.clone();
    let q2 = queue.clone();
    let q3 = queue.clone();

    let rt = Runtime::make()
        .limits(psychoscript::Limits {
            timeout_ms: Some(2_000),
            ..Default::default()
        })
        .globals(move |_| {
            let q1 = q1.clone();
            let q2 = q2.clone();
            let q3 = q3.clone();
            let block_ok = HostFunction::new(move |args, _| {
                let val = first(args);
                Returned::Block(Box::pin(q1.defer_result(Ok(val))))
            })
            .thenable();
            let block_err = HostFunction::new(move |_, _| {
                Returned::Block(Box::pin(q2.defer_result(Err(
                    psychoscript::HostError::new("deferred boom").into(),
                ))))
            });
            let ns = Namespace::new(
                |_| Ok(vec![HostString::from("read")]),
                move |_| {
                    let q3 = q3.clone();
                    HostFunction::new(move |args, _| {
                        let val = first(args);
                        Returned::Block(Box::pin(q3.defer_result(Ok(val))))
                    })
                },
            );
            vec![
                ("blockOk", HostValue::from(block_ok)),
                ("blockErr", HostValue::from(block_err)),
                ("ns", HostValue::from(ns)),
            ]
        });

    // 1) Immediate (<1ms, before offload): direct call, thenable await, namespace call, and try/catch error.
    // 2) Post-offload (>1ms, on worker thread): spin long enough to move to the worker, then call `blockOk` again.
    let code = r#"
        const a = blockOk(1);
        const b = await blockOk(2);
        const c = ns.read(3);
        let caught = null;
        try {
            blockErr();
        } catch (e) {
            caught = e.message;
        }
        let n = 0;
        for (let i = 0; i < 2e6; i++) n += i % 7;
        const d = blockOk(4);
        return [a, b, c, caught, d, n > 0];
    "#;

    let outcome = queue
        .drive(rt.execute_async(code, &ProgramOptions::new()))
        .unwrap();
    assert_eq!(
        outcome.json().unwrap(),
        json!([1, 2, 3, "deferred boom", 4, true])
    );
}

#[test]
fn dropping_a_run_awaiting_returned_block_cancels_on_the_executor() {
    use std::sync::atomic::AtomicBool;
    for spin in [false, true] {
        let entered = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(Mutex::new(None));
        let seen = dropped.clone();
        let flag = entered.clone();
        let rt = Runtime::make().globals(move |_| {
            let seen = seen.clone();
            let flag = flag.clone();
            [(
                "blockNever",
                HostFunction::new(move |_, _| {
                    flag.store(true, Ordering::SeqCst);
                    Returned::Block(Box::pin(Forever(seen.clone())))
                }),
            )]
        });
        let code = if spin {
            "let n = 0; for (let i = 0; i < 2e5; i++) n += i % 7; return blockNever()"
        } else {
            "return blockNever()"
        };
        let options = ProgramOptions::new();
        let mut run = Box::pin(rt.execute_async(code, &options));
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        assert!(run.as_mut().poll(&mut cx).is_pending());
        while !entered.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
            assert!(run.as_mut().poll(&mut cx).is_pending());
        }
        // Poll once more so `ToHome::Await` is handed to `Worker::awaiting`.
        assert!(run.as_mut().poll(&mut cx).is_pending());
        drop(run);
        assert_eq!(
            *dropped.lock().unwrap(),
            Some(thread::current().id()),
            "spin={spin}"
        );
    }
}

#[test]
fn returned_block_inside_builtin_conversions_does_not_corrupt_state() {
    let rt = Runtime::make().globals(|_| {
        let block_str = HostFunction::new(|_, _| {
            Returned::Block(Box::pin(async {
                Ok(later(5, HostValue::from("123")).await)
            }))
        });
        let block_neg = HostFunction::new(|_, _| {
            Returned::Block(Box::pin(async {
                Ok(later(5, HostValue::Number(-5.0)).await)
            }))
        });
        let block_four = HostFunction::new(|_, _| {
            Returned::Block(Box::pin(async {
                Ok(later(5, HostValue::Number(4.0)).await)
            }))
        });
        let block_nine = HostFunction::new(|_, _| {
            Returned::Block(Box::pin(async {
                Ok(later(5, HostValue::Number(9.0)).await)
            }))
        });
        let block_len = HostFunction::new(|_, _| {
            Returned::Block(Box::pin(async {
                Ok(later(5, HostValue::Number(2.0)).await)
            }))
        });
        vec![
            ("blockStr", HostValue::from(block_str)),
            ("blockNeg", HostValue::from(block_neg)),
            ("blockFour", HostValue::from(block_four)),
            ("blockNine", HostValue::from(block_nine)),
            ("blockLen", HostValue::from(block_len)),
        ]
    });

    // Built-ins invoking direct `HostFunction`s as `{ valueOf }` inline must not observe `can_yield`:
    // - `Number` must return numeric 123 (not raw string "123")
    // - `Math.abs` must return +5 (not raw -5)
    // - `Math.max` with two direct `HostFunction` conversions must return 9 without overwriting pending state
    // - `Array.from` with a mapper must return [7, 7] without pushing onto the wrong frame
    let code = r#"
        const n = Number({ valueOf: blockStr });
        const a = Math.abs({ valueOf: blockNeg });
        const m = Math.max({ valueOf: blockFour }, { valueOf: blockNine });
        const arr = Array.from({ length: { valueOf: blockLen } }, () => 7);
        return [typeof n, n, a, m, arr];
    "#;
    let outcome = drive(rt.execute_async(code, &ProgramOptions::new())).unwrap();
    assert_eq!(
        outcome.json().unwrap(),
        json!(["number", 123, 5, 9, [7, 7]])
    );
}

#[test]
fn returned_block_yields_across_new_callbacks_promises_and_getters() {
    let queue = CoopQueue::default();
    let q1 = queue.clone();
    let q2 = queue.clone();
    let q3 = queue.clone();
    let q4 = queue.clone();

    let rt = Runtime::make()
        .limits(psychoscript::Limits {
            timeout_ms: Some(2_000),
            ..Default::default()
        })
        .globals(move |_| {
            let q1 = q1.clone();
            let q2 = q2.clone();
            let q3 = q3.clone();
            let q4 = q4.clone();
            let block_ok = HostFunction::new(move |args, _| {
                let val = first(args);
                Returned::Block(Box::pin(q1.defer_result(Ok(val))))
            });
            let block_ctor = HostFunction::new(move |args, _| {
                let val = first(args);
                Returned::Block(Box::pin(q2.defer_result(Ok(val))))
            })
            .constructible();
            let block_err = HostFunction::new(move |_, _| {
                Returned::Block(Box::pin(
                    q3.defer_result(Err(psychoscript::HostError::new("cb boom").into())),
                ))
            });
            let ns = Namespace::new(
                |_| Ok(vec![HostString::from("echo")]),
                move |_| {
                    let q4 = q4.clone();
                    HostFunction::new(move |args, _| {
                        let val = first(args);
                        Returned::Block(Box::pin(q4.defer_result(Ok(val))))
                    })
                },
            );
            vec![
                ("blockOk", HostValue::from(block_ok)),
                ("BlockCtor", HostValue::from(block_ctor)),
                ("blockErr", HostValue::from(block_err)),
                ("ns", HostValue::from(ns)),
            ]
        });

    let code = r#"
        const n1 = new BlockCtor({ v: 1 });
        const n2 = new BlockCtor(...[{ v: 2 }]);
        const mapped = [10, 20].map(blockOk);
        const called = blockOk.call(null, 30);
        const applied = blockOk.apply(null, [40]);
        const bound = blockOk.bind(null, 50)();
        const promised = await Promise.resolve(60).then(blockOk);
        const fromGetter = blockOk({ get x() { return 70; } });
        const nsGetter = ns.echo({ get y() { return 80; } });
        let mapCaught = null;
        try {
            [1].map(blockErr);
        } catch (e) {
            mapCaught = e.message;
        }
        const promCaught = await Promise.resolve(1).then(blockErr).catch(e => e.message);
        return [n1.v, n2.v, mapped, called, applied, bound, promised, fromGetter.x, nsGetter.y, mapCaught, promCaught];
    "#;

    let outcome = queue
        .drive(rt.execute_async(code, &ProgramOptions::new()))
        .unwrap();
    assert_eq!(
        outcome.json().unwrap(),
        json!([1, 2, [10, 20], 30, 40, 50, 60, 70, 80, "cb boom", "cb boom"])
    );
}

#[test]
fn returned_block_timeout_wakes_updated_waker_after_migration() {
    use std::sync::atomic::AtomicBool;
    struct FlagWake {
        woken: AtomicBool,
        thread: thread::Thread,
    }
    impl std::task::Wake for FlagWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.woken.store(true, Ordering::SeqCst);
            self.thread.unpark();
        }
    }

    for spin in [false, true] {
        let entered = Arc::new(AtomicBool::new(false));
        let flag = entered.clone();
        let rt = Runtime::make()
            .limits(psychoscript::Limits {
                timeout_ms: Some(80),
                ..Default::default()
            })
            .globals(move |_| {
                let flag = flag.clone();
                [(
                    "blockNever",
                    HostFunction::new(move |_, _| {
                        flag.store(true, Ordering::SeqCst);
                        Returned::Block(Box::pin(std::future::pending()))
                    }),
                )]
            });
        let code = if spin {
            "let n = 0; for (let i = 0; i < 2e5; i++) n += i % 7; return blockNever()"
        } else {
            "return blockNever()"
        };
        let options = ProgramOptions::new();
        let mut run = Box::pin(rt.execute_async(code, &options));

        // First polls use Waker A (which arms the deadline timer).
        let waker_a = Waker::noop();
        let mut cx_a = Context::from_waker(waker_a);
        assert!(run.as_mut().poll(&mut cx_a).is_pending());
        while !entered.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
            assert!(run.as_mut().poll(&mut cx_a).is_pending());
        }
        if spin {
            // Ensure the worker has delivered `ToHome::Await` and armed the timer under Waker A.
            assert!(run.as_mut().poll(&mut cx_a).is_pending());
        }

        // Migrate the future to Waker B before the deadline fires.
        let wake_b = Arc::new(FlagWake {
            woken: AtomicBool::new(false),
            thread: thread::current(),
        });
        let waker_b = Waker::from(wake_b.clone());
        let mut cx_b = Context::from_waker(&waker_b);
        let outcome = loop {
            match run.as_mut().poll(&mut cx_b) {
                Poll::Ready(res) => break res.unwrap(),
                Poll::Pending => thread::park_timeout(Duration::from_secs(2)),
            }
            assert!(
                wake_b.woken.load(Ordering::SeqCst),
                "spin={spin}: deadline timer did not wake migrated Waker B"
            );
        };
        assert_eq!(
            outcome.result.unwrap_err().kind,
            psychoscript::DiagnosticKind::TimeoutExceeded,
            "spin={spin}"
        );
    }
}
