//! One timer thread for every live run: it wakes sleeping runs at their deadlines and checks slice budgets. It waits
//! on a condition variable until the earliest deadline, so it costs nothing between them.

use std::collections::BinaryHeap;
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::task::Waker;
use std::time::Instant;

use crate::live::Control;

pub(crate) enum Fire {
    /// A sleep's deadline: wake its run.
    Wake(Waker),
    /// A slice's budget: stop the run if that slice is still computing.
    Watch(Weak<Control>),
    /// An encoder's held-back posts are due: wake the run to hand them over.
    Due(Weak<Control>),
}

struct Entry {
    at: Instant,
    seq: u64,
    fire: Fire,
}

impl PartialEq for Entry {
    fn eq(&self, other: &Self) -> bool {
        (self.at, self.seq) == (other.at, other.seq)
    }
}

impl Eq for Entry {}

impl PartialOrd for Entry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Entry {
    // Earliest first in a max-heap.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (other.at, other.seq).cmp(&(self.at, self.seq))
    }
}

#[derive(Default)]
struct Queue {
    heap: BinaryHeap<Entry>,
    seq: u64,
}

struct Timer {
    queue: Mutex<Queue>,
    signal: Condvar,
}

pub(crate) fn schedule(at: Instant, fire: Fire) {
    static TIMER: OnceLock<Option<Arc<Timer>>> = OnceLock::new();
    let timer = TIMER.get_or_init(|| {
        let timer = Arc::new(Timer {
            queue: Mutex::default(),
            signal: Condvar::new(),
        });
        let worker = timer.clone();
        std::thread::Builder::new()
            .name("psychoscript-live-timer".into())
            .spawn(move || run(&worker))
            .ok()
            .map(|_| timer)
    });
    match timer {
        Some(timer) => {
            let mut queue = timer.queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.seq += 1;
            let seq = queue.seq;
            let earliest = queue.heap.peek().is_none_or(|e| at < e.at);
            queue.heap.push(Entry { at, seq, fire });
            if earliest {
                timer.signal.notify_one();
            }
        }
        // No timer thread: fire now, so a sleeper polls again (and finds its deadline not reached: a spin rather than
        // a hang, on a platform that can't start threads).
        None => {
            if let Fire::Wake(w) = fire {
                w.wake();
            }
        }
    }
}

fn run(timer: &Timer) {
    let mut queue = timer.queue.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let now = Instant::now();
        let mut due = Vec::new();
        while queue.heap.peek().is_some_and(|e| e.at <= now) {
            if let Some(e) = queue.heap.pop() {
                due.push(e.fire);
            }
        }
        if !due.is_empty() {
            drop(queue);
            for fire in due {
                match fire {
                    Fire::Wake(w) => w.wake(),
                    Fire::Watch(control) => {
                        if let Some(control) = control.upgrade() {
                            control.watch();
                        }
                    }
                    Fire::Due(control) => {
                        if let Some(control) = control.upgrade() {
                            control.due();
                        }
                    }
                }
            }
            queue = timer.queue.lock().unwrap_or_else(|e| e.into_inner());
            continue;
        }
        queue = match queue.heap.peek().map(|e| e.at) {
            Some(at) => {
                timer
                    .signal
                    .wait_timeout(queue, at.saturating_duration_since(now))
                    .unwrap_or_else(|e| e.into_inner())
                    .0
            }
            None => timer.signal.wait(queue).unwrap_or_else(|e| e.into_inner()),
        };
    }
}
