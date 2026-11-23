//! GPU hangs (`widgets-gpu.md`, GPU hang): GPU work still unfinished 250 ms after its submit, below the ~0.5 s of a
//! GPU watchdog (macOS's may blame another queue and leave the killed work looking finished). Submits are tracked per
//! queue, process-wide, since runs share a device: on a queue only the oldest unfinished submit can be hung, its time
//! counted from when the one before it finished, so what waits behind a hung submit (another canvas's, another run's)
//! isn't blamed. Nothing here waits for the GPU.

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// GPU work unfinished this long after its submit hung.
pub const HANG: Duration = Duration::from_millis(250);
/// The client error a hang stops canvases with, and two strikes.
pub const HANG_MESSAGE: &str = "the GPU work hung; the canvas is stopped";
/// Two device losses this close, each with the run's GPU work in flight, stop every canvas of the run.
pub const STRIKE_WINDOW: Duration = Duration::from_secs(30);

/// A run's strikes: device losses while its GPU work was in flight. Only the last one's time matters.
#[derive(Default)]
pub(crate) struct Strikes {
    last: Option<Instant>,
}

impl Strikes {
    /// A strike at `now`; whether it is the second within [`STRIKE_WINDOW`].
    pub(crate) fn strike(&mut self, now: Instant) -> bool {
        let second = self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) <= STRIKE_WINDOW);
        self.last = Some(now);
        second
    }
}

/// A submit: when it was made, whether its work finished, whether it was found hung.
pub(crate) struct Submit {
    at: Instant,
    done: AtomicBool,
    hung: AtomicBool,
}

impl Submit {
    pub(crate) fn done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    pub(crate) fn hung(&self) -> bool {
        self.hung.load(Ordering::Acquire)
    }

    /// Its work won't be waited for (its device was lost).
    pub(crate) fn forget(&self) {
        self.done.store(true, Ordering::Release);
    }
}

/// A queue's unfinished submits in order, and when its oldest became the oldest.
struct Queue {
    submits: VecDeque<Arc<Submit>>,
    since: Instant,
}

static QUEUES: LazyLock<Mutex<HashMap<u64, Queue>>> = LazyLock::new(Mutex::default);
static KEYS: LazyLock<RandomState> = LazyLock::new(RandomState::new);

fn key(queue: &wgpu::Queue) -> u64 {
    KEYS.hash_one(queue)
}

/// Tracks the work submitted to `queue` so far.
pub(crate) fn submitted(queue: &wgpu::Queue) -> Arc<Submit> {
    let now = Instant::now();
    let submit = Arc::new(Submit {
        at: now,
        done: AtomicBool::new(false),
        hung: AtomicBool::new(false),
    });
    let mut queues = QUEUES.lock().unwrap_or_else(PoisonError::into_inner);
    let q = queues.entry(key(queue)).or_insert_with(|| Queue {
        submits: VecDeque::new(),
        since: now,
    });
    if q.submits.is_empty() {
        q.since = now;
    }
    q.submits.push_back(submit.clone());
    drop(queues);
    let flag = submit.clone();
    queue.on_submitted_work_done(move || flag.done.store(true, Ordering::Release));
    submit
}

/// Finds `queue`'s hung submit, if any: its oldest unfinished one, unfinished `after` ([`HANG`]) after its submit and
/// after the one before it finished.
pub(crate) fn judge(queue: &wgpu::Queue, after: Duration) {
    let mut queues = QUEUES.lock().unwrap_or_else(PoisonError::into_inner);
    let k = key(queue);
    let Some(q) = queues.get_mut(&k) else { return };
    if q.judge(Instant::now(), after) {
        queues.remove(&k);
    }
}

impl Queue {
    /// Drops the finished submits and marks the oldest left hung when it is; whether none is left.
    fn judge(&mut self, now: Instant, after: Duration) -> bool {
        let before = self.submits.len();
        while self.submits.front().is_some_and(|s| s.done()) {
            self.submits.pop_front();
        }
        // The oldest started when the one before it finished (as far as can be told: now).
        if self.submits.len() != before {
            self.since = now;
        }
        self.submits.retain(|s| !s.done());
        match self.submits.front() {
            None => true,
            Some(s) => {
                if now.duration_since(s.at.max(self.since)) >= after {
                    s.hung.store(true, Ordering::Release);
                }
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submit(at: Instant) -> Arc<Submit> {
        Arc::new(Submit {
            at,
            done: AtomicBool::new(false),
            hung: AtomicBool::new(false),
        })
    }

    /// The rule's logic at a threshold of 1 s (any works: `judge` takes it).
    const H: Duration = Duration::from_secs(1);

    #[test]
    fn the_thresholds() {
        assert_eq!(
            (HANG, STRIKE_WINDOW),
            (Duration::from_millis(250), Duration::from_secs(30))
        );
        assert_eq!(HANG_MESSAGE, "the GPU work hung; the canvas is stopped");
    }

    /// Only the oldest unfinished submit on a queue can hang: what waits behind it isn't blamed, and the next one's
    /// time counts from when the hung one finished.
    #[test]
    fn what_waits_behind_a_hung_submit_isnt_blamed() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let (first, second, third) = (submit(ms(0)), submit(ms(10)), submit(ms(20)));
        let mut q = Queue {
            submits: [&first, &second, &third].map(|s| (*s).clone()).into(),
            since: ms(0),
        };
        assert!(!q.judge(ms(900), H));
        assert!(!first.hung());
        assert!(!q.judge(ms(1001), H));
        assert!((first.hung(), second.hung(), third.hung()) == (true, false, false));
        // Long after, still waiting behind it: not hung.
        assert!(!q.judge(ms(5000), H));
        assert!(!second.hung() && !third.hung());
        // The hung one finishes: the next has its own second from then.
        first.forget();
        assert!(!q.judge(ms(6000), H));
        assert!(!second.hung());
        assert!(!q.judge(ms(6900), H));
        assert!(!second.hung());
        second.forget();
        third.forget();
        assert!(q.judge(ms(7000), H));
        // A submit made while the queue was idle counts from its own submit.
        let late = submit(ms(9000));
        let mut q = Queue {
            submits: [late.clone()].into(),
            since: ms(0),
        };
        assert!(!q.judge(ms(9500), H));
        assert!(!late.hung());
        assert!(!q.judge(ms(10_100), H));
        assert!(late.hung());
    }

    /// Two strikes within 30 s stop the run; a first one, or one after a longer gap, doesn't.
    #[test]
    fn two_strikes_within_30_s() {
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);
        let mut strikes = Strikes::default();
        assert!(!strikes.strike(s(0)));
        // 31 s later: it starts again from this one.
        assert!(!strikes.strike(s(31)));
        assert!(strikes.strike(s(61)));
        let mut strikes = Strikes::default();
        assert!(!strikes.strike(s(100)));
        assert!(strikes.strike(s(130)));
    }
}
