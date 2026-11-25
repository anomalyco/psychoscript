//! The run's clock under `Clock::ThreadCpu`: the CPU time of the threads while they run it, so a busy machine, which
//! leaves a thread waiting for a core, never counts against the program. Each stretch of the run on a thread (a poll,
//! a stretch on its worker) reads that thread's clock as it starts and ends; what the thread does in between, for
//! other tasks, is not the run's.
//!
//! Nor are synchronous host calls, left out by their wall-clock duration: between two readings of the clock, the
//! program used at least the CPU time less the host calls' wall time, as the host can have used no more than that.
//! This can only count too little (a host call that sleeps, or whose thread waits for a core, is left out in full),
//! and the program then counts nothing for that interval, but never less than nothing. So that what it misses stays
//! bounded, the thread's whole CPU time, host calls included, ends the run at `WAIT_BACKSTOP` times the budget.
//!
//! Waiting on host calls takes no CPU time, so waits count on the wall clock instead, against a backstop of
//! `WAIT_BACKSTOP` times the timeout: a wait that never ends still ends the run.

use std::time::{Duration, Instant};

use crate::thread_clock::ThreadClock;

/// `Limits::slice_ms`: the stretch in progress.
///
/// On the wall clock, `wall` is where it began, moved on by the host calls since, so its elapsed time is the
/// stretch's own. Under `Clock::ThreadCpu`, `wall` is where it began until `from` is read, once the stretch has run
/// `SLICE_SLACK` of the slice: the run's CPU time without host calls and with them (`CpuMeter::read`). The stretch is
/// measured from there, against the slice and, with host calls, `WAIT_BACKSTOP` times it; `wall` is then the
/// earliest it could be over either, as a thread uses no more CPU time than passes, and the clock isn't read before.
pub(crate) struct Slice {
    pub(crate) from: Option<(Duration, Duration)>,
    pub(crate) wall: Instant,
}

/// The part of the slice a stretch runs before its CPU time is measured (so that the many short ones never read the
/// thread's clock); what it used meanwhile isn't counted, so a stretch may run up to that much past the slice.
pub(crate) const SLICE_SLACK: u32 = 16;

/// How many times the budget a run may spend waiting on host calls, on the wall clock, or use with its host calls, on
/// the thread's clock.
pub(crate) const WAIT_BACKSTOP: u32 = 10;

pub(crate) struct CpuMeter {
    /// CPU time used before the stretch in progress, and before the run was resumed, without host calls.
    used: Duration,
    /// CPU time used since the run started or resumed, with host calls.
    total: Duration,
    /// The stretch in progress: its thread's clock, and that clock and the wall clock at its last reading.
    mark: Option<(ThreadClock, Duration, Instant)>,
    /// The wall-clock time of the host calls since the last reading.
    host: Duration,
    /// Wall-clock time spent waiting on host calls.
    waited: Duration,
    /// When the wait in progress began.
    wait_since: Option<Instant>,
    /// When the timer last armed for a wait fires.
    pub(crate) armed: Option<Instant>,
}

impl CpuMeter {
    /// A meter for a run that hasn't started: no time used, and no stretch in progress.
    pub(crate) fn new() -> Self {
        CpuMeter {
            used: Duration::ZERO,
            total: Duration::ZERO,
            mark: None,
            host: Duration::ZERO,
            waited: Duration::ZERO,
            wait_since: None,
            armed: None,
        }
    }

    /// The run starts, having used `used` before it was resumed.
    pub(crate) fn start(&mut self, used: Duration) {
        self.used = used;
    }

    /// A stretch of the run starts on the calling thread; a wait in progress ends.
    pub(crate) fn enter(&mut self) {
        if let Some(since) = self.wait_since.take() {
            self.waited += since.elapsed();
        }
        if self.mark.is_none() {
            let clock = ThreadClock::current();
            let cpu = clock.now();
            self.mark = Some((clock, cpu, Instant::now()));
            self.host = Duration::ZERO;
        }
    }

    /// The stretch on the calling thread ends; `waiting` when the run now waits on host calls.
    pub(crate) fn leave(&mut self, waiting: bool) {
        self.fold();
        self.mark = None;
        if waiting {
            self.wait_since = Some(Instant::now());
        }
    }

    /// A synchronous host call took `wall` on the wall clock, which the run's CPU time leaves out.
    pub(crate) fn host(&mut self, wall: Duration) {
        self.host += wall;
    }

    /// Adds the CPU time the stretch in progress used since its last reading, less its host calls' wall time.
    fn fold(&mut self) {
        if let Some((clock, cpu, wall)) = &mut self.mark {
            let now = clock.now();
            let spent = now.saturating_sub(*cpu);
            self.used += spent.saturating_sub(self.host);
            self.total += spent;
            self.host = Duration::ZERO;
            (*cpu, *wall) = (now, Instant::now());
        }
    }

    /// The CPU time the run used, without host calls.
    pub(crate) fn used(&mut self) -> Duration {
        self.fold();
        self.used
    }

    /// The CPU time the run used without host calls, and since it started or resumed with them.
    pub(crate) fn read(&mut self) -> (Duration, Duration) {
        self.fold();
        (self.used, self.total)
    }

    /// Wall-clock time spent in a wait on the calling thread, which used no CPU time meanwhile.
    pub(crate) fn waited(&mut self, wait: Duration) {
        self.waited += wait;
    }

    /// How much longer the run may wait on host calls under a timeout of `limit`.
    pub(crate) fn wait_left(&self, limit: Duration) -> Duration {
        (limit * WAIT_BACKSTOP).saturating_sub(self.waited)
    }

    /// Whether the run is over a timeout of `limit`: its CPU time, its CPU time with host calls past the backstop, or
    /// its waits past the backstop. The thread's clock is read only once the wall-clock time since its last reading
    /// could have taken the run over, as a thread can use no more CPU time than passes.
    pub(crate) fn over(&mut self, limit: Duration) -> bool {
        if self.wait_left(limit).is_zero() {
            return true;
        }
        let backstop = limit * WAIT_BACKSTOP;
        if let Some((_, _, wall)) = &self.mark {
            let passed = wall.elapsed();
            if self.used + passed < limit && self.total + passed < backstop {
                return false;
            }
        }
        let (used, total) = self.read();
        used >= limit || total >= backstop
    }
}
