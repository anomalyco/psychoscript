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

#[cfg(target_os = "linux")]
#[test]
fn a_run_starved_by_a_cpu_hog_is_not_timed_out() {
    thread::spawn(|| {
        let Some(cpu) = pin::first_cpu().filter(|&c| pin::to(c)) else {
            eprintln!("skipped: this thread can't be pinned to a CPU");
            return;
        };
        // A loop of about 80 ms of CPU time, measured on this thread before the hog starts.
        let program = |n: u64| {
            format!("let s = 0; for (let i = 0; i < {n}; i++) s = (s + i * 7) % 1000003; return s")
        };
        let probe = 200_000u64;
        let before = thread_clock::ThreadClock::current().now();
        Runtime::make().execute(&program(probe)).result.unwrap();
        let per =
            (thread_clock::ThreadClock::current().now() - before).as_secs_f64() / probe as f64;
        let n = ((0.08 / per) as u64).max(1000);
        let code = program(n);
        // Sixteen threads spinning on the same CPU, for a few seconds at most.
        let stop = Arc::new(AtomicBool::new(false));
        let hogs: Vec<_> = (0..16)
            .map(|_| {
                let stop = stop.clone();
                thread::spawn(move || {
                    pin::to(cpu);
                    let until = Instant::now() + Duration::from_secs(4);
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
        eprintln!(
            "a run of {n} iterations, about 80 ms of CPU time, took {took:?} on the starved CPU"
        );
    })
    .join()
    .unwrap();
}
