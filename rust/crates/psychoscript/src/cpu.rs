//! The run's clock under `Clock::ThreadCpu`: the CPU time of the threads while they run it, so a busy machine, which
//! leaves a thread waiting for a core, never counts against the program. Each stretch of the run on a thread (a poll,
//! a stretch on its worker) reads that thread's clock as it starts and ends; what the thread does in between, for
//! other tasks, is not the run's. Nor is a synchronous host call's: the clock is read as it starts and ends too.
//!
//! Waiting on host calls takes no CPU time, so waits count on the wall clock instead, against a backstop of
//! `WAIT_BACKSTOP` times the timeout: a wait that never ends still ends the run.

use std::time::{Duration, Instant};

use thread_clock::ThreadClock;

/// `Limits::slice_ms`: the stretch in progress. `wall` is where it began on the wall clock, moved on by the host work
/// since, so its elapsed time is the stretch's own. Under `Clock::ThreadCpu`, `from` is the run's CPU time
/// (`CpuMeter::used`, which leaves host work out) where it is measured from; it is first read once the stretch has
/// run `SLICE_SLACK` of the slice, and `wall` then restarts from it. As a thread uses no more CPU time than passes,
/// the CPU time since `from` is at most `wall`'s elapsed time, and the clock is read only once that reaches the slice.
pub(crate) struct Slice {
    pub(crate) from: Option<Duration>,
    pub(crate) wall: Instant,
}

/// The part of the slice a stretch runs before its CPU time is measured (so that the many short ones never read the
/// thread's clock); what it used meanwhile isn't counted, so a stretch may run up to that much past the slice.
pub(crate) const SLICE_SLACK: u32 = 16;

/// How many times the timeout a run may spend waiting on host calls, on the wall clock.
pub(crate) const WAIT_BACKSTOP: u32 = 10;

pub(crate) struct CpuMeter {
    /// CPU time used before the stretch in progress, and before the run was resumed.
    used: Duration,
    /// The stretch in progress: its thread's clock, and that clock and the wall clock at its last reading.
    mark: Option<(ThreadClock, Duration, Instant)>,
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
            mark: None,
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

    /// A synchronous host call starts: the time the stretch used until now is the run's.
    pub(crate) fn pause(&mut self) {
        self.fold();
    }

    /// The host call ends: what the thread used meanwhile isn't the run's.
    pub(crate) fn resume(&mut self) {
        if let Some((clock, cpu, wall)) = &mut self.mark {
            (*cpu, *wall) = (clock.now(), Instant::now());
        }
    }

    /// Adds the CPU time the stretch in progress used since its last reading.
    fn fold(&mut self) {
        if let Some((clock, cpu, wall)) = &mut self.mark {
            let now = clock.now();
            self.used += now.saturating_sub(*cpu);
            (*cpu, *wall) = (now, Instant::now());
        }
    }

    /// The CPU time the run used.
    pub(crate) fn used(&mut self) -> Duration {
        self.fold();
        self.used
    }

    /// Wall-clock time spent in a wait on the calling thread, which used no CPU time meanwhile.
    pub(crate) fn waited(&mut self, wait: Duration) {
        self.waited += wait;
    }

    /// How much longer the run may wait on host calls under a timeout of `limit`.
    pub(crate) fn wait_left(&self, limit: Duration) -> Duration {
        (limit * WAIT_BACKSTOP).saturating_sub(self.waited)
    }

    /// Whether the run is over a timeout of `limit`: its CPU time, or its waits past the backstop. The thread's clock
    /// is read only once the wall-clock time since its last reading could have taken the run over, as a thread can
    /// use no more CPU time than passes.
    pub(crate) fn over(&mut self, limit: Duration) -> bool {
        if self.wait_left(limit).is_zero() {
            return true;
        }
        if let Some((_, _, wall)) = &self.mark
            && self.used + wall.elapsed() < limit
        {
            return false;
        }
        self.used() >= limit
    }
}
