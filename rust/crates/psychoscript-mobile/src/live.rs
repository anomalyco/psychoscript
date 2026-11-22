//! Long-running programs that talk to their host: a [`LiveRun`] runs on a thread of its own with these host
//! functions under `__host`, beside the input function:
//!
//! - `__host.post(message)` (sync): queues `message`, as JSON, for [`LiveHandler::on_posts`] (or, with a
//!   [`ValueEncoder`], as its bytes for [`LiveHandler::on_posts_bytes`]): every post of one wake-up of the program
//!   reaches the host in one call, in order, when the program next waits (or ends).
//! - `await __host.receive()` (async, idempotent): the next message [`LiveRun::deliver`] queued, in order.
//! - `await __host.sleep(ms)` (async, idempotent): resolves after `ms` (clamped to >= 0) of running time.
//! - `__host.now()` (sync): milliseconds the program has been running, paused time left out.
//! - `await __host.fetch(request)` (async): an HTTPS request through the app's [`FetchTransport`] (see `fetch`).
//!
//! The thread parks while the program waits: timers come from one shared timer thread, `receive` wakes only when a
//! message arrives, and a paused run has nothing scheduled.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak, mpsc};
use std::task::{Context, Poll, Waker};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use psychoscript::{
    Compiled, Data, Failure, HostFunction, HostResult, HostString, HostValue, Limits,
    ProgramOptions, Run, RunOutcome, Runtime, Snapshot, Suspender, from_bytes, to_bytes,
};

use crate::encoder::{EncodeValues, ValueEncoder};
use crate::error::PsychoScriptError;
use crate::fetch::{self, FetchTransport, Rejection, Request};
use crate::json::{self, Input};
use crate::timer::{self, Fire};

/// A live run's budgets and capabilities.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LiveOptions {
    /// Longest the program may compute without waiting on its host; past it the run stops with `SliceBudget`.
    #[uniffi(default = 50)]
    pub slice_budget_ms: u64,
    /// Posts beyond this many in a second are dropped, with one `on_warning` per second.
    #[uniffi(default = 240)]
    pub max_posts_per_second: u32,
    /// The `https` capability: hosts `__host.fetch` may reach (exact names, `*.` suffixes, `*` for any). `None`:
    /// every fetch is rejected with `CapabilityDenied`.
    #[uniffi(default)]
    pub https_hosts: Option<Vec<String>>,
    /// Dev mode: `fetch` may also reach loopback, private and link-local addresses, and plain `http:` to them,
    /// still only for `https_hosts` (with ports, e.g. `localhost:4097`). Never on in a release build unless the user
    /// turns it on.
    #[uniffi(default)]
    pub allow_local_network: bool,
    /// Bytes the run's heap may hold (the language's size model, not the process's memory); over it the run ends
    /// with `Failed(MemoryLimitExceeded)`. The spec's default for live widgets is 32 MB: set it.
    #[uniffi(default)]
    pub max_heap_bytes: Option<u64>,
}

impl Default for LiveOptions {
    fn default() -> Self {
        LiveOptions {
            slice_budget_ms: 50,
            max_posts_per_second: 240,
            https_hosts: None,
            allow_local_network: false,
            max_heap_bytes: None,
        }
    }
}

/// What a live run tells its host, on the run's own thread, so return quickly (hand the messages to your UI thread).
/// `on_posts` gets the posts of one wake-up of the program together, in order, as soon as it waits again (as
/// JSON; with a [`ValueEncoder`], `on_posts_bytes` gets them instead, as its bytes); `on_exit` is called once, after
/// the last posts (on the caller's thread for `stop` on a run suspended to a snapshot).
#[uniffi::export(callback_interface)]
pub trait LiveHandler: Send + Sync {
    fn on_posts(&self, messages_json: Vec<String>);
    fn on_posts_bytes(&self, messages: Vec<Vec<u8>>);
    fn on_warning(&self, message: String);
    fn on_exit(&self, exit: LiveExit);
}

/// How a live run ended.
#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum LiveExit {
    /// The program returned: its completion value as JSON.
    Finished { result_json: String },
    /// It threw, or went over a budget.
    Failed { error: PsychoScriptError },
    /// [`LiveRun::stop`] ended it.
    Stopped,
}

/// A program running on a thread of its own, talking to its host through `__host` (see the module docs).
#[derive(uniffi::Object)]
pub struct LiveRun {
    control: Arc<Control>,
}

impl std::fmt::Debug for LiveRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LiveRun")
    }
}

impl LiveRun {
    pub(crate) fn start(
        compiled: Compiled,
        input_name: String,
        input_json: String,
        handler: Box<dyn LiveHandler>,
        options: LiveOptions,
        transport: Option<Arc<dyn FetchTransport>>,
        encoder: Option<Arc<ValueEncoder>>,
    ) -> Result<Arc<LiveRun>, PsychoScriptError> {
        Input::parse(&input_json).map_err(|e| PsychoScriptError::InvalidInput {
            reason: format!("the input isn't JSON: {e}"),
        })?;
        let control = Control::new(handler, options, input_name, transport, encoder);
        control.spawn(Start::Fresh(compiled, input_json.into()))?;
        Ok(Arc::new(LiveRun { control }))
    }
}

#[uniffi::export]
impl LiveRun {
    /// Continues a run from a [`LiveRun::snapshot`], in this process or a later one of the same build: the program
    /// first receives `{ type: "resumed", pausedMs }`. Its input, running time and timers come back with it; messages
    /// delivered but not yet received don't. Pass the `encoder` the run started with.
    #[uniffi::constructor(default(input_name = "__input", transport = None, encoder = None, options))]
    pub fn restore(
        snapshot: Vec<u8>,
        handler: Box<dyn LiveHandler>,
        input_name: String,
        options: LiveOptions,
        transport: Option<Arc<dyn FetchTransport>>,
        encoder: Option<Arc<ValueEncoder>>,
    ) -> Result<Arc<LiveRun>, PsychoScriptError> {
        let state =
            from_bytes(&snapshot).map_err(|e| PsychoScriptError::Snapshot { reason: e.message })?;
        let control = Control::new(handler, options, input_name, transport, encoder);
        control.spawn(Start::Restore(state))?;
        Ok(Arc::new(LiveRun { control }))
    }

    /// Queues a JSON message for `__host.receive()`; held while paused. Fails with `InvalidInput` for text that
    /// isn't JSON, `InvalidState` once the run ended.
    pub fn deliver(&self, message_json: String) -> Result<(), PsychoScriptError> {
        let message = Input::parse(&message_json).map_err(|e| PsychoScriptError::InvalidInput {
            reason: format!("the message isn't JSON: {e}"),
        })?;
        if matches!(*self.control.state(), State::Ended) {
            return Err(ended());
        }
        lock(&self.control.inbox).queue.push_back(message);
        self.control.wake_receive();
        Ok(())
    }

    /// Pauses the run in memory: `sleep` timers freeze with their remaining time, `now()` stops, delivered messages
    /// and finished fetches are held. A stretch of compute in progress finishes first (within the slice budget);
    /// after that the run uses no CPU. Doesn't block. No-op when already paused.
    pub fn pause(&self) -> Result<(), PsychoScriptError> {
        match &*self.control.state() {
            State::Running { .. } | State::Starting => {}
            State::Suspended(_) => return Ok(()),
            State::Ended => return Err(ended()),
        }
        self.control.pause();
        Ok(())
    }

    /// Continues a paused run (or one suspended by [`LiveRun::snapshot`], on a new thread); the program first
    /// receives `{ type: "resumed", pausedMs }`.
    pub fn resume(&self) -> Result<(), PsychoScriptError> {
        let snapshot = match &*self.control.state() {
            State::Suspended(s) => Some(s.clone()),
            State::Running { .. } | State::Starting => None,
            State::Ended => return Err(ended()),
        };
        let Some(paused_ms) = self.control.unpause_ms() else {
            return Err(PsychoScriptError::InvalidState {
                reason: "the run isn't paused".into(),
            });
        };
        self.control.greet(paused_ms);
        match snapshot {
            Some(s) => self.control.spawn(Start::Resume(s)),
            None => {
                self.control.wake_all();
                Ok(())
            }
        }
    }

    /// Suspends a paused run to its state and frees its VM and thread (for a long pause, or when the OS asks for
    /// memory), returning the state as bytes for [`LiveRun::restore`]; [`LiveRun::resume`] continues it here.
    /// Fails with `InvalidState` unless paused, with `Snapshot` (the run still paused, untouched) while a `fetch` is
    /// in flight or the state can't be saved: then `stop` it and start it again later.
    pub fn snapshot(&self) -> Result<Vec<u8>, PsychoScriptError> {
        if let State::Suspended(s) = &*self.control.state() {
            return Ok(to_bytes(s));
        }
        if !self.control.is_paused() {
            return Err(PsychoScriptError::InvalidState {
                reason: "pause the run first".into(),
            });
        }
        self.control.suspend_paused().map(|s| to_bytes(&s))
    }

    /// Ends the run (`on_exit(Stopped)`), whatever it's doing. Doesn't block.
    pub fn stop(&self) {
        self.control.stop();
    }

    /// Whether the run is going: not paused, suspended or ended.
    pub fn is_running(&self) -> bool {
        matches!(*self.control.state(), State::Running { .. }) && !self.control.is_paused()
    }
}

impl Drop for LiveRun {
    fn drop(&mut self) {
        self.control.stop();
    }
}

fn ended() -> PsychoScriptError {
    PsychoScriptError::InvalidState {
        reason: "the run has ended".into(),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn wall_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

enum Start {
    Fresh(Compiled, Arc<str>),
    /// A state this run suspended.
    Resume(Snapshot),
    /// A state from bytes: its metadata says how long it has been paused.
    Restore(Snapshot),
}

enum State {
    /// Between `spawn` and the thread's first report.
    Starting,
    Running {
        thread: Option<JoinHandle<()>>,
        suspender: Suspender,
    },
    /// Paused and saved: no VM, no thread.
    Suspended(Snapshot),
    Ended,
}

/// Why a suspend was asked for: the run thread reads it when its run returns suspended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Why {
    None,
    Snapshot,
    Overrun,
    Stop,
}

#[derive(Default)]
struct Inbox {
    queue: VecDeque<HostValue>,
    waker: Option<Waker>,
}

struct Sleep {
    /// Running time it ends at.
    deadline: f64,
    waker: Option<Waker>,
}

/// Running time: `offset_ms`, plus the time since `base` unless paused.
struct Clock {
    base: Instant,
    offset_ms: f64,
    /// Paused at this instant and wall-clock time (ms since the epoch).
    paused: Option<(Instant, f64)>,
}

/// The VM's stretches of compute. Host calls tell when the VM computes: a sync call, or an async one's first poll,
/// happens inside the VM's run; a later poll happens while the VM is stopped between runs, and one that resolves
/// starts a stretch. That a stretch has ended (the VM waits) is confirmed by a probe: the budget check wakes the
/// program's pending host calls, which the VM polls as soon as it stops, and can't while it computes.
struct Slice {
    busy: bool,
    /// Counts stretches.
    n: u64,
    start: Instant,
    /// A budget check is on the timer.
    armed: bool,
    /// The stretch a probe is out for.
    probe: Option<u64>,
    /// Host code running on the run's thread (host functions, polls of host calls, the handler's callbacks) doesn't
    /// count as the VM's compute: how deep in it the run's thread is, since when, and how long it spent there in this
    /// stretch.
    host_depth: u32,
    host_since: Instant,
    host_time: Duration,
}

impl Slice {
    /// How long the VM itself has computed in this stretch.
    fn vm_time(&self, now: Instant) -> Duration {
        let host = self.host_time
            + if self.host_depth > 0 {
                now.saturating_duration_since(self.host_since)
            } else {
                Duration::ZERO
            };
        now.saturating_duration_since(self.start)
            .saturating_sub(host)
    }
}

/// A stretch of host code on the run's thread, ended when dropped (also on an early return).
struct HostSection<'a>(&'a Control);

impl<'a> HostSection<'a> {
    fn enter(control: &'a Control) -> HostSection<'a> {
        control.enter_host();
        HostSection(control)
    }
}

impl Drop for HostSection<'_> {
    fn drop(&mut self) {
        self.0.leave_host();
    }
}

/// Where a host call's poll happens.
#[derive(Clone, Copy, PartialEq, Eq)]
enum At {
    /// Its first poll, inside the VM's run: the VM is computing.
    Inside,
    /// A later poll, while the VM is stopped between runs.
    Between,
}

/// How long a probed run thread has to answer: wake, and poll its pending calls.
const PROBE_GRACE: Duration = Duration::from_millis(30);

struct Posts {
    window: Instant,
    count: u32,
    warned: bool,
}

/// One wake-up's posts: JSON, or an encoder's bytes.
#[derive(Default)]
struct Outbox {
    json: Vec<String>,
    bytes: Vec<Vec<u8>>,
}

impl Outbox {
    fn is_empty(&self) -> bool {
        self.json.is_empty() && self.bytes.is_empty()
    }
}

pub(crate) struct Control {
    me: Weak<Control>,
    handler: Box<dyn LiveHandler>,
    options: LiveOptions,
    input_name: String,
    transport: Option<Arc<dyn FetchTransport>>,
    /// Posts as its bytes, not JSON.
    encoder: Option<Arc<dyn EncodeValues>>,
    state: Mutex<State>,
    /// The psychoscript run of the current thread, for its metadata.
    run: Mutex<Option<Run>>,
    inbox: Mutex<Inbox>,
    /// Posts of the current wake-up, not yet handed over.
    outbox: Mutex<Outbox>,
    sleeps: Mutex<HashMap<String, Sleep>>,
    fetches: Mutex<Vec<Weak<Mutex<fetch::Slot>>>>,
    fetch_budget: Mutex<fetch::Budget>,
    clock: Mutex<Clock>,
    posts: Mutex<Posts>,
    /// Set by `stop`: host calls interrupt the run.
    stopping: AtomicBool,
    /// Whether the VM is computing, for the slice budget.
    slice: Mutex<Slice>,
    why: Mutex<Why>,
    /// One suspend at a time.
    suspending: Mutex<()>,
}

impl Control {
    fn new(
        handler: Box<dyn LiveHandler>,
        options: LiveOptions,
        input_name: String,
        transport: Option<Arc<dyn FetchTransport>>,
        encoder: Option<Arc<ValueEncoder>>,
    ) -> Arc<Control> {
        let now = Instant::now();
        Arc::new_cyclic(|me| Control {
            me: me.clone(),
            handler,
            options,
            input_name,
            transport,
            encoder: encoder.map(|e| e.0.clone()),
            state: Mutex::new(State::Starting),
            run: Mutex::new(None),
            inbox: Mutex::default(),
            outbox: Mutex::default(),
            sleeps: Mutex::default(),
            fetches: Mutex::default(),
            fetch_budget: Mutex::default(),
            clock: Mutex::new(Clock {
                base: now,
                offset_ms: 0.0,
                paused: None,
            }),
            posts: Mutex::new(Posts {
                window: now,
                count: 0,
                warned: false,
            }),
            stopping: AtomicBool::new(false),
            slice: Mutex::new(Slice {
                busy: false,
                n: 0,
                start: now,
                armed: false,
                probe: None,
                host_depth: 0,
                host_since: now,
                host_time: Duration::ZERO,
            }),
            why: Mutex::new(Why::None),
            suspending: Mutex::new(()),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// Starts the run's thread and waits until its program is set up (or failed to restore).
    fn spawn(self: &Arc<Self>, start: Start) -> Result<(), PsychoScriptError> {
        self.stopping.store(false, Ordering::SeqCst);
        *lock(&self.why) = Why::None;
        *self.state() = State::Starting;
        let (ready, started) = mpsc::channel();
        let control = self.clone();
        let thread = std::thread::Builder::new()
            .name("psychoscript-live".into())
            // The VM's stack budget (512 KB) and room for the host's callbacks.
            .stack_size(1 << 20)
            .spawn(move || control.thread(start, ready))
            .map_err(|e| PsychoScriptError::InvalidState {
                reason: format!("can't start a thread: {e}"),
            })?;
        match started.recv() {
            Ok(Ok(suspender)) => {
                let mut state = self.state();
                if let State::Starting = *state {
                    *state = State::Running {
                        thread: Some(thread),
                        suspender,
                    };
                }
                Ok(())
            }
            Ok(Err(e)) => {
                *self.state() = State::Ended;
                Err(e)
            }
            Err(_) => {
                *self.state() = State::Ended;
                Err(PsychoScriptError::InvalidState {
                    reason: "the run's thread ended before it started".into(),
                })
            }
        }
    }

    fn thread(
        self: Arc<Self>,
        start: Start,
        ready: mpsc::Sender<Result<Suspender, PsychoScriptError>>,
    ) {
        let input = match &start {
            Start::Fresh(_, input) => Some(input.clone()),
            Start::Resume(_) | Start::Restore(_) => None,
        };
        let runtime = self.runtime(input, matches!(start, Start::Restore(_)));
        let program = match &start {
            Start::Fresh(compiled, _) => runtime.program(compiled, &ProgramOptions::new()),
            Start::Resume(state) | Start::Restore(state) => match runtime.resume(state) {
                Ok(p) => p,
                Err(e) => {
                    let _ = ready.send(Err(PsychoScriptError::Snapshot { reason: e.message }));
                    return;
                }
            },
        };
        let _ = ready.send(Ok(program.suspender()));
        drop(start);
        self.computing();
        let outcome = program.run_resumable();
        lock(&self.slice).busy = false;
        let why = *lock(&self.why);
        let exit = match outcome {
            Ok(RunOutcome::Suspended(_)) => match why {
                // `snapshot` keeps the state and joins this thread.
                Why::Snapshot => return self.flush(),
                Why::Overrun => LiveExit::Failed {
                    error: PsychoScriptError::SliceBudget {
                        reason: format!(
                            "the program computed for more than {} ms without waiting",
                            self.options.slice_budget_ms
                        ),
                        budget_ms: self.options.slice_budget_ms,
                    },
                },
                Why::Stop | Why::None => LiveExit::Stopped,
            },
            Ok(RunOutcome::Done(outcome)) => match outcome.result {
                Ok(data) => LiveExit::Finished {
                    result_json: data.to_json_string(),
                },
                Err(_) if why == Why::Stop => LiveExit::Stopped,
                Err(d) => LiveExit::Failed {
                    error: PsychoScriptError::from_diagnostic(d, None, self.options.max_heap_bytes),
                },
            },
            Err(_interrupted) => LiveExit::Stopped,
        };
        self.flush();
        self.end();
        self.handler.on_exit(exit);
    }

    fn end(&self) {
        *self.state() = State::Ended;
        lock(&self.inbox).waker = None;
        lock(&self.sleeps).clear();
        *lock(&self.run) = None;
    }

    /// The runtime for one thread's run: the input function and `__host`.
    fn runtime(self: &Arc<Self>, input: Option<Arc<str>>, restored: bool) -> Runtime {
        let control = self.clone();
        let name = self.input_name.clone();
        let limits = Limits {
            max_heap_bytes: self.options.max_heap_bytes,
            ..Default::default()
        };
        Runtime::make().limits(limits).globals(move |run| {
            let text: Arc<str> = match &input {
                Some(text) => {
                    run.set_metadata(control.metadata(text));
                    text.clone()
                }
                None => control.restore_metadata(&run.metadata(), restored),
            };
            *lock(&control.run) = Some(run.clone());
            let c = control.clone();
            let input = HostFunction::new(move |_args, _call| -> HostResult {
                c.interrupted()?;
                c.computing();
                let _host = HostSection::enter(&c);
                Ok(Input::parse(&text).unwrap_or_default())
            });
            let c = control.clone();
            let post = HostFunction::new(move |args: Vec<HostValue>, _call| -> HostResult {
                c.interrupted()?;
                c.computing();
                let _host = HostSection::enter(&c);
                c.post(args.first().unwrap_or(&HostValue::Undefined))?;
                Ok(HostValue::Undefined)
            });
            let c = control.clone();
            let now = HostFunction::new(move |_args, _call| -> HostResult {
                c.interrupted()?;
                c.computing();
                let _host = HostSection::enter(&c);
                Ok(HostValue::Number(c.now_ms()))
            });
            let c = control.clone();
            let receive = HostFunction::new_async(move |_args, _call| {
                let c = c.clone();
                let mut at = At::Inside;
                std::future::poll_fn(move |cx| {
                    let at = std::mem::replace(&mut at, At::Between);
                    c.around(at, cx, |cx| c.poll_receive(cx, at))
                })
            })
            .idempotent();
            let c = control.clone();
            let sleep = HostFunction::new_async(move |args: Vec<HostValue>, call| {
                let c = c.clone();
                let ms = args
                    .first()
                    .and_then(HostValue::as_f64)
                    .filter(|n| !n.is_nan())
                    .unwrap_or(0.0)
                    .max(0.0);
                let key = call.key();
                let mut at = At::Inside;
                std::future::poll_fn(move |cx| {
                    let at = std::mem::replace(&mut at, At::Between);
                    c.around(at, cx, |cx| c.poll_sleep(&key, ms, cx, at))
                })
            })
            .idempotent();
            let c = control.clone();
            let fetch = HostFunction::new_async(move |args: Vec<HostValue>, _call| {
                let slot = c.start_fetch(args.first());
                let c = c.clone();
                let mut at = At::Inside;
                std::future::poll_fn(move |cx| {
                    let at = std::mem::replace(&mut at, At::Between);
                    c.around(at, cx, |cx| c.poll_fetch(&slot, cx, at))
                })
            });
            let host = HostValue::object([
                ("post", HostValue::Function(post.named("post").length(1))),
                ("receive", HostValue::Function(receive.named("receive"))),
                ("sleep", HostValue::Function(sleep.named("sleep").length(1))),
                ("now", HostValue::Function(now.named("now"))),
                ("fetch", HostValue::Function(fetch.named("fetch").length(1))),
            ]);
            [
                (name.clone(), HostValue::Function(input.named(name.clone()))),
                ("__host".to_owned(), host),
            ]
        })
    }

    fn interrupted(&self) -> Result<(), HostValue> {
        if self.stopping.load(Ordering::SeqCst) {
            Err(HostValue::Interrupt)
        } else {
            Ok(())
        }
    }

    // ---------- time and pause ----------

    fn now_ms(&self) -> f64 {
        let clock = lock(&self.clock);
        match clock.paused {
            Some(_) => clock.offset_ms,
            None => clock.offset_ms + clock.base.elapsed().as_secs_f64() * 1000.0,
        }
    }

    fn is_paused(&self) -> bool {
        lock(&self.clock).paused.is_some()
    }

    fn pause(&self) {
        let mut clock = lock(&self.clock);
        if clock.paused.is_none() {
            clock.offset_ms += clock.base.elapsed().as_secs_f64() * 1000.0;
            clock.paused = Some((Instant::now(), wall_ms()));
        }
    }

    /// Ends a pause: how long it lasted, or `None` when not paused.
    fn unpause_ms(&self) -> Option<f64> {
        let mut clock = lock(&self.clock);
        let (at, _) = clock.paused.take()?;
        clock.base = Instant::now();
        Some(at.elapsed().as_secs_f64() * 1000.0)
    }

    /// Queues `{ type: "resumed", pausedMs }` ahead of every other message.
    fn greet(&self, paused_ms: f64) {
        let message = HostValue::object([
            ("type", HostValue::String("resumed".into())),
            ("pausedMs", HostValue::Number(paused_ms.round())),
        ]);
        lock(&self.inbox).queue.push_front(message);
    }

    fn wake_receive(&self) {
        let waker = lock(&self.inbox).waker.take();
        if let Some(w) = waker {
            w.wake();
        }
    }

    /// Wakes every host call the program waits on, to look again: after a resume, or to interrupt on stop.
    fn wake_all(&self) {
        self.wake_receive();
        let mut wakers: Vec<Waker> = lock(&self.sleeps)
            .values_mut()
            .filter_map(|s| s.waker.take())
            .collect();
        lock(&self.fetches).retain(|slot| match slot.upgrade() {
            Some(slot) => {
                wakers.extend(lock(&slot).waker.take());
                true
            }
            None => false,
        });
        for w in wakers {
            w.wake();
        }
    }

    // ---------- slices ----------

    /// The VM computes (a sync call, or a host call's first poll): a stretch starts unless one is going.
    fn computing(&self) {
        let mut slice = lock(&self.slice);
        if !slice.busy {
            self.start_stretch(&mut slice);
        }
    }

    /// A host call resolved: polled between runs, the VM computes from now.
    fn resolved(&self, at: At) {
        let mut slice = lock(&self.slice);
        if at == At::Between || !slice.busy {
            self.start_stretch(&mut slice);
        }
    }

    /// A host call is still pending. Polled between runs in answer to a probe for the current stretch (nothing
    /// resolved since the probe went out), it means the VM waits: the stretch is over.
    fn pending(&self, at: At) {
        if at == At::Inside {
            return self.computing();
        }
        let mut slice = lock(&self.slice);
        if slice.probe == Some(slice.n) {
            slice.busy = false;
            slice.probe = None;
        }
    }

    fn start_stretch(&self, slice: &mut Slice) {
        let now = Instant::now();
        slice.n += 1;
        slice.start = now;
        slice.busy = true;
        slice.probe = None;
        slice.host_time = Duration::ZERO;
        if slice.host_depth > 0 {
            slice.host_since = now;
        }
        if !std::mem::replace(&mut slice.armed, true) {
            timer::schedule(now + self.budget(), Fire::Watch(self.me.clone()));
        }
    }

    fn budget(&self) -> Duration {
        Duration::from_millis(self.options.slice_budget_ms.max(1))
    }

    /// Host code starts on the run's thread: its time isn't the VM's.
    fn enter_host(&self) {
        let mut slice = lock(&self.slice);
        if slice.host_depth == 0 {
            slice.host_since = Instant::now();
        }
        slice.host_depth += 1;
    }

    fn leave_host(&self) {
        let mut slice = lock(&self.slice);
        slice.host_depth = slice.host_depth.saturating_sub(1);
        if slice.host_depth == 0 {
            let spent = slice.host_since.elapsed();
            slice.host_time += spent;
            // A probe that went out meanwhile couldn't be answered: the next check sends another.
            slice.probe = None;
        }
    }

    /// The timer's check. A stretch past its budget of VM time gets a probe (its pending host calls woken); one still
    /// going a grace period after its probe is stopped. Time in host code doesn't count, and no probe goes out while
    /// the run's thread is in it (it couldn't answer).
    pub(crate) fn watch(&self) {
        let mut slice = lock(&self.slice);
        slice.armed = false;
        if !slice.busy {
            return;
        }
        let now = Instant::now();
        let vm = slice.vm_time(now);
        let left = self.budget().saturating_sub(vm);
        let over = left.is_zero();
        let at = match slice.probe {
            _ if slice.host_depth > 0 => Some(now + left.max(Duration::from_millis(5))),
            // Unanswered: the VM is still computing.
            Some(n) if n == slice.n && over => None,
            _ if !over => Some(now + left),
            _ => {
                slice.probe = Some(slice.n);
                Some(Instant::now() + PROBE_GRACE)
            }
        };
        let Some(at) = at else {
            drop(slice);
            return self.overrun();
        };
        slice.armed = true;
        let probing = slice.probe == Some(slice.n);
        drop(slice);
        timer::schedule(at, Fire::Watch(self.me.clone()));
        if probing {
            self.wake_all();
        }
    }

    /// Over budget: suspend the run from a thread of its own (the timer thread mustn't block on it).
    fn overrun(&self) {
        let Some(control) = self.me.upgrade() else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("psychoscript-live-stop".into())
            .spawn(move || {
                if lock(&control.slice).busy && control.suspend(Why::Overrun).is_err() {
                    // In a host call that can't be suspended: check again in a slice.
                    let mut slice = lock(&control.slice);
                    slice.probe = None;
                    if !std::mem::replace(&mut slice.armed, true) {
                        timer::schedule(
                            Instant::now() + control.budget(),
                            Fire::Watch(control.me.clone()),
                        );
                    }
                }
            });
    }

    /// Suspends the running program for `why`, one suspend at a time.
    fn suspend(&self, why: Why) -> Result<RunOutcome, PsychoScriptError> {
        let _one = lock(&self.suspending);
        let suspender = match &*self.state() {
            State::Running { suspender, .. } => suspender.clone(),
            _ => {
                return Err(PsychoScriptError::InvalidState {
                    reason: "the run isn't running".into(),
                });
            }
        };
        {
            let mut current = lock(&self.why);
            if *current != Why::None && *current != why {
                return Err(PsychoScriptError::InvalidState {
                    reason: "the run is already stopping".into(),
                });
            }
            *current = why;
        }
        let result = suspender.suspend(None);
        if !matches!(result, Ok(RunOutcome::Suspended(_))) && why != Why::Stop {
            *lock(&self.why) = Why::None;
        }
        result.map_err(|e| PsychoScriptError::Snapshot { reason: e.message })
    }

    /// Saves a paused run and lets its thread end.
    fn suspend_paused(&self) -> Result<Snapshot, PsychoScriptError> {
        // Running time, pending sleeps and when the pause began go into the metadata, which the snapshot keeps.
        if let Some(run) = &*lock(&self.run) {
            let clock = self.now_ms();
            let paused_at = lock(&self.clock)
                .paused
                .map_or_else(wall_ms, |(_, wall)| wall);
            let sleeps = self.sleeps_data();
            run.update_metadata(|m| {
                set_field(m, "clock", number(clock));
                set_field(m, "pausedAt", number(paused_at));
                set_field(m, "sleeps", sleeps);
            });
        }
        match self.suspend(Why::Snapshot)? {
            RunOutcome::Suspended(s) => {
                let thread = match &mut *self.state() {
                    State::Running { thread, .. } => thread.take(),
                    _ => None,
                };
                if let Some(t) = thread {
                    let _ = t.join();
                }
                *lock(&self.why) = Why::None;
                lock(&self.slice).busy = false;
                lock(&self.inbox).waker = None;
                for sleep in lock(&self.sleeps).values_mut() {
                    sleep.waker = None;
                }
                *lock(&self.run) = None;
                *self.state() = State::Suspended(s.state.clone());
                Ok(s.state)
            }
            RunOutcome::Done(_) => Err(ended()),
        }
    }

    fn stop(&self) {
        let busy = {
            let mut state = self.state();
            match &*state {
                State::Running { .. } | State::Starting => {}
                State::Suspended(_) => {
                    *state = State::Ended;
                    drop(state);
                    self.handler.on_exit(LiveExit::Stopped);
                    return;
                }
                State::Ended => return,
            }
            self.stopping.store(true, Ordering::SeqCst);
            let mut why = lock(&self.why);
            if *why == Why::None {
                *why = Why::Stop;
            }
            lock(&self.slice).busy
        };
        // A waiting program wakes to an interrupted host call; a computing one is suspended at its next step.
        self.wake_all();
        if busy && let Some(control) = self.me.upgrade() {
            let _ = std::thread::Builder::new()
                .name("psychoscript-live-stop".into())
                .spawn(move || {
                    let _ = control.suspend(Why::Stop);
                });
        }
    }

    // ---------- host functions ----------

    /// Queues a post; an encoder's failure is thrown at it, as an invalid post is a program error.
    fn post(&self, message: &HostValue) -> Result<(), HostValue> {
        {
            let mut posts = lock(&self.posts);
            if posts.window.elapsed() >= Duration::from_secs(1) {
                *posts = Posts {
                    window: Instant::now(),
                    count: 0,
                    warned: false,
                };
            }
            posts.count += 1;
            if posts.count > self.options.max_posts_per_second {
                let warn = !std::mem::replace(&mut posts.warned, true);
                drop(posts);
                if warn {
                    self.handler.on_warning(format!(
                        "the program posted more than {} messages in a second; later ones this second are dropped",
                        self.options.max_posts_per_second
                    ));
                }
                return Ok(());
            }
        }
        let first = match &self.encoder {
            Some(encoder) => {
                let bytes = encoder
                    .encode_post(message)
                    .map_err(|e| HostValue::Failure(Failure::new("InvalidDataValue", e)))?;
                let mut outbox = lock(&self.outbox);
                outbox.bytes.push(bytes);
                outbox.bytes.len() == 1
            }
            None => {
                let text = json::write(message);
                let mut outbox = lock(&self.outbox);
                outbox.json.push(text);
                outbox.json.len() == 1
            }
        };
        // The host calls the program waits on now get polled again once it stops, which hands the posts over.
        if first {
            self.wake_all();
        }
        Ok(())
    }

    /// Hands the queued posts to the host in one call.
    fn flush(&self) {
        let Outbox { json, bytes } = std::mem::take(&mut *lock(&self.outbox));
        if !json.is_empty() {
            self.handler.on_posts(json);
        }
        if !bytes.is_empty() {
            self.handler.on_posts_bytes(bytes);
        }
    }

    /// Polls a host call for the program: a poll between the VM's runs first hands over the posts of the run that
    /// ended; a call started with posts queued is polled again once the VM stops, to hand them over then.
    fn around(
        &self,
        at: At,
        cx: &mut Context<'_>,
        poll: impl FnOnce(&mut Context<'_>) -> Poll<HostResult>,
    ) -> Poll<HostResult> {
        let _host = HostSection::enter(self);
        if at == At::Between {
            self.flush();
        }
        let result = poll(cx);
        if at == At::Inside && result.is_pending() && !lock(&self.outbox).is_empty() {
            cx.waker().wake_by_ref();
        }
        result
    }

    fn poll_receive(&self, cx: &mut Context<'_>, at: At) -> Poll<HostResult> {
        if self.stopping.load(Ordering::SeqCst) {
            return Poll::Ready(Err(HostValue::Interrupt));
        }
        let paused = self.is_paused();
        let mut inbox = lock(&self.inbox);
        match if paused {
            None
        } else {
            inbox.queue.pop_front()
        } {
            Some(message) => {
                drop(inbox);
                self.resolved(at);
                Poll::Ready(Ok(message))
            }
            None => {
                inbox.waker = Some(cx.waker().clone());
                drop(inbox);
                self.pending(at);
                Poll::Pending
            }
        }
    }

    fn poll_sleep(&self, key: &str, ms: f64, cx: &mut Context<'_>, at: At) -> Poll<HostResult> {
        if self.stopping.load(Ordering::SeqCst) {
            return Poll::Ready(Err(HostValue::Interrupt));
        }
        let paused = self.is_paused();
        let now = self.now_ms();
        let mut sleeps = lock(&self.sleeps);
        let sleep = sleeps.entry(key.to_owned()).or_insert(Sleep {
            deadline: now + ms,
            waker: None,
        });
        if now >= sleep.deadline && !paused {
            sleeps.remove(key);
            drop(sleeps);
            self.resolved(at);
            return Poll::Ready(Ok(HostValue::Undefined));
        }
        let left = Duration::from_secs_f64(((sleep.deadline - now) / 1000.0).max(0.0));
        sleep.waker = Some(cx.waker().clone());
        drop(sleeps);
        // Paused: no timer; resuming wakes the sleep to schedule the rest.
        if !paused {
            timer::schedule(Instant::now() + left, Fire::Wake(cx.waker().clone()));
        }
        self.pending(at);
        Poll::Pending
    }

    /// Checks a fetch against the capability and budget and starts it on a worker; its result arrives in the slot.
    fn start_fetch(self: &Arc<Self>, request: Option<&HostValue>) -> Arc<Mutex<fetch::Slot>> {
        let slot = Arc::new(Mutex::new(fetch::Slot::default()));
        let reject = |r: Rejection| {
            lock(&slot).result = Some(Err(r.value()));
            slot.clone()
        };
        let (Some(hosts), Some(transport)) =
            (self.options.https_hosts.clone(), self.transport.clone())
        else {
            return reject(Rejection::denied("this widget has no https capability"));
        };
        let request = match Request::parse(request) {
            Ok(r) => r,
            Err(r) => return reject(r),
        };
        if let Err(r) = lock(&self.fetch_budget).admit() {
            return reject(r);
        }
        {
            let mut fetches = lock(&self.fetches);
            fetches.retain(|f| f.strong_count() > 0);
            fetches.push(Arc::downgrade(&slot));
        }
        let control = self.clone();
        let worker_slot = slot.clone();
        let spawned = std::thread::Builder::new()
            .name("psychoscript-fetch".into())
            .spawn(move || {
                let stopping = || control.stopping.load(Ordering::SeqCst);
                let local_network = control.options.allow_local_network;
                let result = fetch::perform(
                    transport.as_ref(),
                    &hosts,
                    local_network,
                    request,
                    &stopping,
                )
                .map_err(Rejection::value);
                lock(&control.fetch_budget).in_flight -= 1;
                let waker = {
                    let mut slot = lock(&worker_slot);
                    slot.result = Some(result);
                    slot.waker.take()
                };
                if let Some(w) = waker {
                    w.wake();
                }
            });
        if spawned.is_err() {
            lock(&self.fetch_budget).in_flight -= 1;
            return reject(Rejection::rate_limited("can't start a request"));
        }
        slot
    }

    fn poll_fetch(
        &self,
        slot: &Mutex<fetch::Slot>,
        cx: &mut Context<'_>,
        at: At,
    ) -> Poll<HostResult> {
        if self.stopping.load(Ordering::SeqCst) {
            return Poll::Ready(Err(HostValue::Interrupt));
        }
        let paused = self.is_paused();
        let mut slot = lock(slot);
        match slot.result.take() {
            Some(result) if !paused => {
                drop(slot);
                self.resolved(at);
                Poll::Ready(result)
            }
            held => {
                slot.result = held;
                slot.waker = Some(cx.waker().clone());
                drop(slot);
                self.pending(at);
                Poll::Pending
            }
        }
    }

    // ---------- metadata: what a snapshot keeps of the host ----------

    fn metadata(&self, input: &str) -> Data {
        Data::Object(vec![
            (HostString::from("input"), Data::String(input.into())),
            (HostString::from("clock"), number(self.now_ms())),
            (HostString::from("sleeps"), Data::Object(Vec::new())),
        ])
    }

    /// Takes running time and sleeps back from a resumed run's metadata; for a restored one, also queues
    /// `resumed` with the time since it paused. Returns the input.
    fn restore_metadata(&self, meta: &Data, restored: bool) -> Arc<str> {
        let field = |name: &str| match meta {
            Data::Object(fields) => fields
                .iter()
                .find(|(k, _)| k.as_str() == Some(name))
                .map(|(_, v)| v),
            _ => None,
        };
        let as_f64 = |d: &Data| match d {
            Data::Number(n) => n.as_f64(),
            _ => None,
        };
        if let Some(clock) = field("clock").and_then(as_f64) {
            let mut c = lock(&self.clock);
            c.offset_ms = clock;
            c.base = Instant::now();
            c.paused = None;
        }
        if let Some(Data::Object(sleeps)) = field("sleeps") {
            let mut mine = lock(&self.sleeps);
            for (k, v) in sleeps {
                if let Some(deadline) = as_f64(v) {
                    mine.insert(
                        k.to_string_lossy().into_owned(),
                        Sleep {
                            deadline,
                            waker: None,
                        },
                    );
                }
            }
        }
        if restored {
            let paused_at = field("pausedAt").and_then(as_f64).unwrap_or_else(wall_ms);
            self.greet((wall_ms() - paused_at).max(0.0));
        }
        match field("input") {
            Some(Data::String(s)) => Arc::from(s.to_string_lossy().as_ref()),
            _ => Arc::from("null"),
        }
    }

    fn sleeps_data(&self) -> Data {
        Data::Object(
            lock(&self.sleeps)
                .iter()
                .map(|(k, s)| (HostString::from(k.as_str()), number(s.deadline)))
                .collect(),
        )
    }
}

fn number(n: f64) -> Data {
    serde_json::Number::from_f64(n).map_or(Data::Null, Data::Number)
}

fn set_field(meta: &mut Data, name: &str, value: Data) {
    if let Data::Object(fields) = meta {
        match fields.iter_mut().find(|(k, _)| k.as_str() == Some(name)) {
            Some((_, v)) => *v = value,
            None => fields.push((HostString::from(name), value)),
        }
    }
}
