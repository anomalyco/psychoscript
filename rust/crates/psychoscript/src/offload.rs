//! Moving long stretches of a run's compute off the thread that drives it. A run driven as a future that computes
//! past [`OFFLOAD_AFTER`] without stopping finishes that stretch on a worker thread of its own; the next stretch starts
//! where the run is driven again. Host code stays there: each tool call, extension call, host accessor and first poll
//! of a host future the worker meets is handed back and runs there while the worker waits, so host code runs on the
//! same thread, in the same order, as before. A handed-back call costs a few microseconds, which only stretches already
//! past the budget pay.
// A browser starts no worker threads: a run yields to its executor instead (`Program::advance`).
#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::program::Running;
use crate::run::{RUN_STACK_BUDGET, THREAD_STACK_BASE};
use crate::time::Instant;

/// How long a run may compute on the thread driving it, without stopping, before it moves to a worker thread.
pub const OFFLOAD_AFTER: Duration = Duration::from_millis(1);

type Job = Box<dyn FnOnce() + Send>;

/// A run's side of moving: when the stretch of compute in progress has run long enough to move, whether it stopped to,
/// where its host code runs while it is away, and any `Returned::Block` future suspended on the driving thread.
#[derive(Default)]
pub struct Offload {
    pub at: Option<Instant>,
    pub due: bool,
    pub home: Option<Home>,
    /// Whether the bytecode call frame currently executing can yield back to the executor on `Returned::Block`.
    pub can_yield: bool,
    /// A `Returned::Block` future yielded on the driving thread so the executor stays free while it completes.
    pub pending: Option<Box<crate::host::PendingBlock>>,
}

/// A `Returned::Block` future handed from the worker thread to the driving executor to poll without blocking.
pub struct AwaitBlock {
    pub tasks: crate::exec::Tasks<'static, crate::host::Settlement>,
    pub work: crate::exec::BoxFuture<'static, crate::HostResult>,
    pub deadline: Option<Instant>,
    pub settled: Vec<(crate::value::Id, crate::host::Settlement)>,
    pub armed: bool,
    pub reply: mpsc::SyncSender<AwaitResult>,
}

pub type AwaitResult = (
    crate::exec::Tasks<'static, crate::host::Settlement>,
    Vec<(crate::value::Id, crate::host::Settlement)>,
    Option<crate::HostResult>,
);

enum ToHome {
    /// Host code for the driving thread to run.
    Job(Job),
    /// A `Returned::Block` future for the driving thread to poll asynchronously without blocking its executor.
    Await(Box<AwaitBlock>),
    /// The run, back after a stretch of compute.
    Back(Box<Running>),
    /// The interpreter panicked on the worker; the panic continues where the run is driven, as it would have there.
    Panicked(Box<dyn std::any::Any + Send>),
}

/// Where host code runs while a run with this offload state computes on a worker thread.
pub fn home(offload: &Option<Box<Offload>>) -> Option<&Home> {
    offload.as_ref()?.home.as_ref()
}

/// The way back to the thread driving a run, for its host code.
#[derive(Clone)]
pub struct Home {
    tx: Sender<ToHome>,
    waker: Arc<Mutex<Option<Waker>>>,
}

impl Home {
    /// Runs `f` on the thread driving the run and waits for its result; `None` when the run is being dropped.
    pub fn run<R: Send + 'static>(&self, f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
        let (reply, answer) = mpsc::sync_channel(1);
        self.send(ToHome::Job(Box::new(move || {
            let _ = reply.send(f());
        })))
        .ok()?;
        answer.recv().ok()
    }

    /// Hands a `Returned::Block` future to the driving executor to poll without blocking its thread, waiting here on
    /// the worker until it finishes or the deadline expires; `None` when the run is being dropped.
    pub fn await_block(
        &self,
        tasks: crate::exec::Tasks<'static, crate::host::Settlement>,
        work: crate::exec::BoxFuture<'static, crate::HostResult>,
        deadline: Option<Instant>,
    ) -> Option<AwaitResult> {
        let (reply, answer) = mpsc::sync_channel(1);
        self.send(ToHome::Await(Box::new(AwaitBlock {
            tasks,
            work,
            deadline,
            settled: Vec::new(),
            armed: false,
            reply,
        })))
        .ok()?;
        answer.recv().ok()
    }

    fn send(&self, message: ToHome) -> Result<(), ToHome> {
        self.tx.send(message).map_err(|e| e.0)?;
        if let Some(w) = self
            .waker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            w.wake();
        }
        Ok(())
    }
}

/// A run's worker thread.
pub struct Worker {
    to_worker: Option<Sender<Box<Running>>>,
    from_worker: Receiver<ToHome>,
    waker: Arc<Mutex<Option<Waker>>>,
    awaiting: Option<Box<AwaitBlock>>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    pub fn spawn() -> std::io::Result<Self> {
        let (to_worker, runs) = mpsc::channel::<Box<Running>>();
        let (tx, from_worker) = mpsc::channel();
        let waker = Arc::new(Mutex::new(None));
        let home = Home {
            tx,
            waker: waker.clone(),
        };
        let thread = std::thread::Builder::new()
            .name("psychoscript-run".into())
            .stack_size(RUN_STACK_BUDGET + THREAD_STACK_BASE)
            .spawn(move || {
                while let Ok(mut r) = runs.recv() {
                    let message = match std::panic::catch_unwind(AssertUnwindSafe(|| {
                        compute(&mut r, &home);
                    })) {
                        Ok(()) => ToHome::Back(r),
                        Err(panic) => ToHome::Panicked(panic),
                    };
                    if home.send(message).is_err() {
                        return;
                    }
                }
            })?;
        Ok(Self {
            to_worker: Some(to_worker),
            from_worker,
            waker,
            awaiting: None,
            thread: Some(thread),
        })
    }

    /// Hands the run to the worker for its next stretch of compute.
    pub fn compute(&self, r: Box<Running>) {
        if let Some(tx) = &self.to_worker {
            // The worker only stops when this sender is dropped, so it is there to receive.
            let _ = tx.send(r);
        }
    }

    /// Runs the host code the worker hands back, until the run comes back.
    pub fn poll(&mut self, cx: &mut Context<'_>) -> Poll<Box<Running>> {
        let mut registered = false;
        loop {
            if let Some(mut b) = self.awaiting.take() {
                b.tasks.set_parent(Some(cx.waker()));
                b.settled.extend(b.tasks.poll_ready());
                let done = if let Poll::Ready(r) = b.work.as_mut().poll(cx) {
                    Some(Some(r))
                } else {
                    match b.deadline {
                        Some(at) if Instant::now() >= at => Some(None),
                        Some(at) if !b.armed => {
                            b.armed = true;
                            crate::exec::wake_at(at, &b.tasks.parent_waker());
                            None
                        }
                        _ => None,
                    }
                };
                if let Some(outcome) = done {
                    b.tasks.set_parent(None);
                    let _ = b.reply.send((b.tasks, b.settled, outcome));
                    registered = false;
                    continue;
                }
                self.awaiting = Some(b);
                return Poll::Pending;
            }
            match self.from_worker.try_recv() {
                Ok(ToHome::Job(job)) => job(),
                Ok(ToHome::Await(b)) => {
                    self.awaiting = Some(b);
                }
                Ok(ToHome::Back(r)) => return Poll::Ready(r),
                Ok(ToHome::Panicked(panic)) => std::panic::resume_unwind(panic),
                Err(TryRecvError::Disconnected) => {
                    unreachable!("the worker only stops once its run is back or abandoned")
                }
                Err(TryRecvError::Empty) if registered => return Poll::Pending,
                // Look again after registering, for a message sent in between.
                Err(TryRecvError::Empty) => {
                    *self.waker.lock().unwrap_or_else(PoisonError::into_inner) =
                        Some(cx.waker().clone());
                    registered = true;
                }
            }
        }
    }

    /// Waits for the run to come back, running none of its host code, so it is dropped on the driving thread. The run
    /// was asked to stop, which it does at its next safe point.
    pub fn reclaim(&mut self) -> Option<Box<Running>> {
        // Drop any awaited `Returned::Block` future on the driving thread first so its worker unblocks immediately.
        self.awaiting = None;
        loop {
            match self.from_worker.recv() {
                Ok(ToHome::Job(job)) => drop(job),
                Ok(ToHome::Await(b)) => drop(b),
                Ok(ToHome::Back(r)) => return Some(r),
                Ok(ToHome::Panicked(_)) | Err(_) => return None,
            }
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.awaiting = None;
        self.to_worker = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// One stretch of compute: until the run ends, waits on the host, or stops at a safe point.
fn compute(r: &mut Running, home: &Home) {
    // Under `Clock::ThreadCpu`, a stretch of the run on this thread (see `cpu.rs`).
    if let Some(c) = &mut r.vm.cpu {
        c.enter();
    }
    let probe = 0u8;
    r.vm.stack_base = &probe as *const u8 as usize;
    r.vm.stack_budget = RUN_STACK_BUDGET;
    r.vm.host.offload().home = Some(home.clone());
    let _ = r.vm.continue_frames();
    if !r.vm.suspended {
        let _ = r.vm.drive();
    }
    r.vm.host.offload().home = None;
    if let Some(c) = &mut r.vm.cpu {
        c.leave(false);
    }
}
