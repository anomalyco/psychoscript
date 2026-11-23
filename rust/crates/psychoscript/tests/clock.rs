//! `Limits::clock`: a timeout on the wall clock (the default) or on the CPU time of the threads running the program,
//! which a loaded machine doesn't use up, with waits on host calls counted on the wall clock against a backstop.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::{Duration, Instant};

use psychoscript::{
    Clock, DiagnosticKind, HostFunction, HostValue, Limits, ProgramOptions, Returned, RunOutcome,
    Runtime,
};
use serde_json::json;

fn limits(ms: u64, clock: Clock) -> Limits {
    Limits {
        timeout_ms: Some(ms),
        clock,
        ..Limits::default()
    }
}

fn timed_out(o: &psychoscript::Outcome) -> bool {
    matches!(&o.result, Err(d) if d.kind == DiagnosticKind::TimeoutExceeded)
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

#[test]
fn the_default_clock_is_the_wall_clock() {
    assert_eq!(Limits::default().clock, Clock::Wall);
    let o = Runtime::make()
        .limits(Limits {
            timeout_ms: Some(100),
            ..Limits::default()
        })
        .execute("while (true) {}");
    assert_eq!(
        o.result.unwrap_err().message_lossy(),
        "Execution timed out after 100ms."
    );
}

#[test]
fn a_busy_loop_is_stopped_at_its_cpu_budget() {
    let rt = Runtime::make().limits(limits(300, Clock::ThreadCpu));
    let before = thread_clock::ThreadClock::current().now();
    let o = rt.execute("while (true) {}");
    let used = thread_clock::ThreadClock::current().now() - before;
    assert_eq!(
        o.result.unwrap_err().message_lossy(),
        "Execution timed out after 300ms."
    );
    assert!(
        used >= Duration::from_millis(300) && used < Duration::from_millis(600),
        "{used:?}"
    );
}

#[test]
fn a_busy_loop_on_the_run_s_worker_is_stopped_at_its_cpu_budget() {
    // Driven as a future, the loop moves to the run's worker thread after a millisecond: its CPU time counts there.
    let rt = Runtime::make().limits(limits(200, Clock::ThreadCpu));
    let start = Instant::now();
    let o = drive(rt.execute_async("while (true) {}", &ProgramOptions::new())).unwrap();
    assert!(timed_out(&o));
    let took = start.elapsed();
    assert!(
        took >= Duration::from_millis(200) && took < Duration::from_secs(5),
        "{took:?}"
    );
}

#[test]
fn waiting_on_host_calls_is_not_cpu_time() {
    // Ten 30 ms waits: 300 ms on the wall clock, which a 100 ms wall-clock timeout doesn't allow.
    let rt = |clock| {
        Runtime::make().limits(limits(100, clock)).globals(|_| {
            [(
                "nap",
                HostFunction::new_async(|_, _| async {
                    thread::sleep(Duration::from_millis(30));
                    Ok(HostValue::Number(1.0))
                }),
            )]
        })
    };
    let code = "let n = 0; for (let i = 0; i < 10; i++) n += await nap(); return n";
    assert_eq!(
        rt(Clock::ThreadCpu).execute(code).result.unwrap(),
        json!(10)
    );
    assert!(timed_out(&rt(Clock::Wall).execute(code)));
}

#[test]
fn a_wait_that_never_ends_ends_at_the_wall_clock_backstop() {
    // Ten times the 50 ms timeout, on the wall clock: an async call, and a call the program blocks on.
    for (code, f) in [
        (
            "await never()",
            HostFunction::new_async(|_, _| std::future::pending()),
        ),
        (
            "never()",
            HostFunction::new(|_, _| Returned::Block(Box::pin(std::future::pending()))),
        ),
    ] {
        let rt = Runtime::make()
            .limits(limits(50, Clock::ThreadCpu))
            .globals(move |_| [("never", HostValue::from(f.clone()))]);
        let start = Instant::now();
        assert!(timed_out(&rt.execute(code)), "{code}");
        let took = start.elapsed();
        assert!(
            took >= Duration::from_millis(450) && took < Duration::from_secs(5),
            "{code}: {took:?}"
        );
    }
}

fn sliced(ms: u64, clock: Clock) -> Limits {
    Limits {
        slice_ms: Some(ms),
        clock,
        ..Limits::default()
    }
}

fn sliced_out(o: &psychoscript::Outcome) -> bool {
    matches!(&o.result, Err(d) if d.kind == DiagnosticKind::SliceExceeded)
}

/// A runtime whose `tick()` is an async host call that settles at once; `nap(ms)` a synchronous one that sleeps,
/// `burn(ms)` one that spins, `spend(ms)` one that spins until it has used that much CPU time, and `block(ms)` one that
/// the program blocks on while it sleeps.
fn ticking(limits: Limits) -> Runtime {
    let ms = |args: &[HostValue]| args.first().and_then(HostValue::as_f64).unwrap_or(0.0) as u64;
    Runtime::make().limits(limits).globals(move |_| {
        [
            (
                "tick",
                HostFunction::new_async(|_, _| async { Ok(HostValue::Number(1.0)) }),
            ),
            (
                "nap",
                HostFunction::new(move |args, _| {
                    thread::sleep(Duration::from_millis(ms(&args)));
                    HostValue::Undefined
                }),
            ),
            (
                "burn",
                HostFunction::new(move |args, _| {
                    let until = Instant::now() + Duration::from_millis(ms(&args));
                    while Instant::now() < until {
                        std::hint::spin_loop();
                    }
                    HostValue::Undefined
                }),
            ),
            (
                "spend",
                HostFunction::new(move |args, _| {
                    let clock = thread_clock::ThreadClock::current();
                    let until = clock.now() + Duration::from_millis(ms(&args));
                    while clock.now() < until {
                        std::hint::spin_loop();
                    }
                    HostValue::Undefined
                }),
            ),
            (
                "block",
                HostFunction::new(move |args, _| {
                    let ms = ms(&args);
                    Returned::Block(Box::pin(async move {
                        thread::sleep(Duration::from_millis(ms));
                        Ok(HostValue::Undefined)
                    }))
                }),
            ),
        ]
    })
}

#[test]
fn a_loop_that_never_awaits_stops_at_the_slice() {
    for clock in [Clock::Wall, Clock::ThreadCpu] {
        let start = Instant::now();
        let o = ticking(sliced(50, clock)).execute("await tick(); while (true) {}");
        let took = start.elapsed();
        assert!(sliced_out(&o), "{clock:?}: {:?}", o.result);
        assert_eq!(
            o.result.unwrap_err().message_lossy(),
            "The program ran longer than 50ms without awaiting."
        );
        assert!(
            took >= Duration::from_millis(50) && took < Duration::from_secs(2),
            "{clock:?}: {took:?}"
        );
    }
    // Promise jobs don't wait on the host: a loop of them is one stretch.
    let o = ticking(sliced(50, Clock::Wall)).execute("while (true) await null");
    assert!(sliced_out(&o), "{:?}", o.result);
}

#[test]
fn a_program_that_awaits_the_host_often_runs_past_the_slice() {
    // Fifty stretches of 10 ms, half a second in all, under a 50 ms slice.
    let code = "for (let i = 0; i < 50; i++) { const t = Date.now(); while (Date.now() - t < 10) {} await tick() } return 1";
    for clock in [Clock::Wall, Clock::ThreadCpu] {
        let start = Instant::now();
        let o = ticking(sliced(50, clock)).execute(code);
        assert_eq!(o.result.unwrap(), json!(1), "{clock:?}");
        assert!(start.elapsed() >= Duration::from_millis(400));
    }
}

#[test]
fn host_calls_are_not_counted_in_the_slice() {
    // 300 ms in host calls without awaiting, under a 50 ms slice: sleeping, spinning and blocking.
    for (clock, code) in [
        (Clock::Wall, "nap(100); nap(100); nap(100); return 1"),
        (
            Clock::ThreadCpu,
            "burn(100); burn(100); burn(100); return 1",
        ),
        (Clock::Wall, "burn(100); burn(100); burn(100); return 1"),
        (Clock::Wall, "block(100); block(100); block(100); return 1"),
    ] {
        let o = ticking(sliced(50, clock)).execute(code);
        assert_eq!(o.result.unwrap(), json!(1), "{clock:?}: {code}");
    }
}

/// Runs `code` on another thread and suspends it once it waits on a host call: the saved state.
fn suspend_waiting(rt: &Runtime, code: &str) -> psychoscript::Snapshot {
    let program = rt.program(code, &ProgramOptions::new());
    let suspender = program.suspender();
    thread::scope(|s| {
        let running = s.spawn(move || program.run_resumable().unwrap());
        let state = loop {
            match suspender.suspend(None) {
                Ok(RunOutcome::Suspended(s)) => break s.state,
                Ok(RunOutcome::Done(o)) => panic!("the run ended: {:?}", o.result),
                Err(_) => thread::sleep(Duration::from_millis(5)),
            }
        };
        running.join().unwrap();
        state
    })
}

/// A runtime whose `wait` never settles, an idempotent call a run can be suspended in.
fn waiting(limits: Limits) -> Runtime {
    Runtime::make().limits(limits).globals(|_| {
        [(
            "wait",
            HostValue::from(HostFunction::new_async(|_, _| std::future::pending()).idempotent()),
        )]
    })
}

#[test]
fn a_suspended_run_keeps_its_clock() {
    let code = "let n = 0; for (let i = 0; i < 1000; i++) n += i; await wait(); return n";
    let state = suspend_waiting(&waiting(limits(50, Clock::ThreadCpu)), code);
    assert_eq!(state.0["header"]["limits"]["clock"], json!("threadCpu"));
    let slice = suspend_waiting(
        &waiting(Limits {
            slice_ms: Some(50),
            ..limits(1000, Clock::ThreadCpu)
        }),
        code,
    );
    assert_eq!(slice.0["header"]["limits"]["sliceMs"], json!(50));
    // A runtime without limits resumes it with its own: the wait ends at the backstop, ten times the timeout.
    let start = Instant::now();
    let o = waiting(Limits::default())
        .resume(&state)
        .unwrap()
        .run()
        .unwrap();
    assert!(timed_out(&o));
    assert!(
        start.elapsed() >= Duration::from_millis(450),
        "{:?}",
        start.elapsed()
    );
    // A wall-clock run's header is as it was.
    let state = suspend_waiting(&waiting(limits(50, Clock::Wall)), "await wait()");
    assert_eq!(
        state.0["header"]["limits"],
        json!({ "timeoutMs": 50, "maxOutputBytes": null })
    );
}

/// The thread's CPU, and pinning to it, on Linux.
#[cfg(target_os = "linux")]
mod pin {
    /// The first CPU the calling thread may run on.
    pub fn first_cpu() -> Option<usize> {
        // SAFETY: a plain C bit set, for which all zeroes is empty; `set` is a valid out pointer of its size.
        let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::sched_getaffinity(0, size_of::<libc::cpu_set_t>(), &mut set) } != 0 {
            return None;
        }
        // SAFETY: `set` is initialized, and the index within its size.
        (0..libc::CPU_SETSIZE as usize).find(|&c| unsafe { libc::CPU_ISSET(c, &set) })
    }

    /// Pins the calling thread to `cpu`; false when the OS refuses.
    pub fn to(cpu: usize) -> bool {
        // SAFETY: as above; `set` holds `cpu` only, and is passed with its size.
        let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
        unsafe { libc::CPU_SET(cpu, &mut set) };
        unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &set) == 0 }
    }
}

/// Where this thread runs, and the threads that will keep that CPU busy: on Linux the thread and sixteen spinners
/// pinned to one CPU; elsewhere (macOS has no pinning) sixteen spinners for every core.
#[cfg(target_os = "linux")]
fn starve() -> Option<(usize, fn())> {
    static CPU: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let cpu = pin::first_cpu().filter(|&c| pin::to(c))?;
    CPU.set(cpu).ok();
    Some((16, || {
        pin::to(*CPU.get().unwrap());
    }))
}

#[cfg(not(target_os = "linux"))]
fn starve() -> Option<(usize, fn())> {
    let cores = thread::available_parallelism().map_or(8, |n| n.get());
    Some((16 * cores, || {}))
}

#[test]
fn a_run_starved_by_a_cpu_hog_is_not_timed_out() {
    thread::spawn(|| {
        let Some((spinners, place)) = starve() else {
            eprintln!("skipped: this thread can't be pinned to a CPU");
            return;
        };
        // A loop of about 80 ms of CPU time, measured on this thread before the hog starts.
        let program = |n: u64| {
            format!("let s = 0; for (let i = 0; i < {n}; i++) s = (s + i * 7) % 1000003; return s")
        };
        let probe = 200_000u64;
        let clock = thread_clock::ThreadClock::current();
        let before = clock.now();
        Runtime::make().execute(&program(probe)).result.unwrap();
        let per = (clock.now() - before).as_secs_f64() / probe as f64;
        let n = ((0.08 / per) as u64).max(1000);
        let code = program(n);
        // Two stretches of half that, awaiting the host in between. The first calls the host when its CPU time is
        // measured, after an eighth, and the call spends 70 ms of CPU time.
        let part = |k: u64| format!("for (let i = 0; i < {k}; i++) s = (s + i * 7) % 1000003;");
        let stretches = format!(
            "let s = 0; {} spend(70); {} await tick(); {} return s",
            part(n / 8),
            part(n * 3 / 8),
            part(n / 2)
        );
        // The spinners, for a few seconds at most.
        let stop = Arc::new(AtomicBool::new(false));
        let hogs: Vec<_> = (0..spinners)
            .map(|_| {
                let stop = stop.clone();
                thread::spawn(move || {
                    place();
                    let until = Instant::now() + Duration::from_secs(8);
                    while !stop.load(Ordering::Relaxed) && Instant::now() < until {
                        std::hint::spin_loop();
                    }
                })
            })
            .collect();
        thread::sleep(Duration::from_millis(20));
        // The wall clock runs out on this thread's share of the CPU; its CPU time doesn't.
        let wall = Runtime::make()
            .limits(limits(400, Clock::Wall))
            .execute(&code);
        let start = Instant::now();
        let cpu_run = Runtime::make()
            .limits(limits(400, Clock::ThreadCpu))
            .execute(&code);
        let took = start.elapsed();
        // The same for a 100 ms slice: each stretch's wall time is over it, its own CPU time isn't, and with the host
        // call's it would be.
        let wall_slice = ticking(sliced(100, Clock::Wall)).execute(&stretches);
        let cpu_slice = ticking(sliced(100, Clock::ThreadCpu)).execute(&stretches);
        stop.store(true, Ordering::Relaxed);
        for h in hogs {
            h.join().unwrap();
        }
        assert!(
            cpu_run.result.is_ok(),
            "{:?} after {took:?}",
            cpu_run.result
        );
        assert!(
            timed_out(&wall),
            "the hog didn't starve the run: {:?}",
            wall.result
        );
        assert!(cpu_slice.result.is_ok(), "{:?}", cpu_slice.result);
        assert!(
            sliced_out(&wall_slice),
            "the hog didn't starve the run: {:?}",
            wall_slice.result
        );
        eprintln!(
            "{spinners} spinners: a run of {n} iterations, about 80 ms of CPU time, took {took:?}"
        );
    })
    .join()
    .unwrap();
}
