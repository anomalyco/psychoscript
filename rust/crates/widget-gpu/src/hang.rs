//! GPU hangs (`widgets-gpu.md`, GPU hang): GPU work still unfinished 1 s after its submit. Submits are tracked per
//! queue, process-wide, since runs share a device: on a queue only the oldest unfinished submit can be hung, its second
//! counted from when the one before it finished, so what waits behind a hung submit (another canvas's, another run's)
//! isn't blamed. Nothing here waits for the GPU.

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// GPU work unfinished this long after its submit hung.
pub const HANG: Duration = Duration::from_secs(1);
/// The client error a hang stops canvases with.
pub const HANG_MESSAGE: &str = "the GPU work took over 1 s; the canvas is stopped";

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

/// Finds `queue`'s hung submit, if any: its oldest unfinished one, unfinished [`HANG`] after its submit and after the
/// one before it finished.
pub(crate) fn judge(queue: &wgpu::Queue) {
    let mut queues = QUEUES.lock().unwrap_or_else(PoisonError::into_inner);
    let k = key(queue);
    let Some(q) = queues.get_mut(&k) else { return };
    if q.judge(Instant::now()) {
        queues.remove(&k);
    }
}

impl Queue {
    /// Drops the finished submits and marks the oldest left hung when it is; whether none is left.
    fn judge(&mut self, now: Instant) -> bool {
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
                if now.duration_since(s.at.max(self.since)) > HANG {
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

    /// Only the oldest unfinished submit on a queue can hang: what waits behind it isn't blamed, and the next one's
    /// second counts from when the hung one finished.
    #[test]
    fn what_waits_behind_a_hung_submit_isnt_blamed() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let (first, second, third) = (submit(ms(0)), submit(ms(10)), submit(ms(20)));
        let mut q = Queue {
            submits: [&first, &second, &third].map(|s| (*s).clone()).into(),
            since: ms(0),
        };
        assert!(!q.judge(ms(900)));
        assert!(!first.hung());
        assert!(!q.judge(ms(1001)));
        assert!((first.hung(), second.hung(), third.hung()) == (true, false, false));
        // Long after, still waiting behind it: not hung.
        assert!(!q.judge(ms(5000)));
        assert!(!second.hung() && !third.hung());
        // The hung one finishes: the next has its own second from then.
        first.forget();
        assert!(!q.judge(ms(6000)));
        assert!(!second.hung());
        assert!(!q.judge(ms(6900)));
        assert!(!second.hung());
        second.forget();
        third.forget();
        assert!(q.judge(ms(7000)));
        // A submit made while the queue was idle counts from its own submit.
        let late = submit(ms(9000));
        let mut q = Queue {
            submits: [late.clone()].into(),
            since: ms(0),
        };
        assert!(!q.judge(ms(9500)));
        assert!(!late.hung());
        assert!(!q.judge(ms(10_100)));
        assert!(late.hung());
    }
}
