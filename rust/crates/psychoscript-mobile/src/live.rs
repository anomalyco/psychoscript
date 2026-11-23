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
    Compiled, Data, HostFunction, HostResult, HostString, HostValue, Limits, ProgramOptions, Run,
    RunOutcome, Runtime, Snapshot, Suspender, Translate, TranslateFunctions, from_bytes, to_bytes,
};

use crate::cpu::ThreadClock;
use crate::encoder::{EncodePosts, Reject, Thrown, ValueEncoder, marked};
use crate::error::PsychoScriptError;
use crate::fetch::{self, FetchTransport, Rejection, Request};
#[cfg(feature = "test-hooks")]
use crate::gpu::GpuStats;
use crate::gpu::{GpuCanvasState, GpuSurface};
use crate::json::{self, Input};
use crate::timer::{self, Fire};

/// A live run's budgets and capabilities.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LiveOptions {
    /// Longest the program may compute without waiting on its host; past it the run stops with `SliceBudget`.
    #[uniffi(default = 50)]
    pub slice_budget_ms: u64,
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
    /// A GPU canvas's state (widget runs, `widgets-gpu.md`): the canvas `key`, or `None` for every GPU canvas of the
    /// run (now and later).
    fn on_gpu_canvas(&self, key: Option<String>, state: GpuCanvasState);
}

/// What an encoder's live posts ([`crate::EncodeValues::live`]) may do with their run.
#[derive(Clone)]
pub struct LiveContext(Weak<Control>);

impl LiveContext {
    /// Queues a message for the program, as [`LiveRun::deliver`] does; nothing once the run ended.
    pub fn deliver(&self, message: HostValue) {
        let Some(c) = self.0.upgrade() else { return };
        if matches!(*c.state(), State::Ended) {
            return;
        }
        lock(&c.inbox).queue.push_back(message);
        c.wake_receive();
    }

    /// Whether the app paused or stopped the run, or it is gone: a wait on the run's thread ends then (a snapshot
    /// waits for the posts in progress).
    pub fn interrupted(&self) -> bool {
        self.0
            .upgrade()
            .is_none_or(|c| c.is_paused() || c.stopping.load(Ordering::SeqCst))
    }

    /// Wakes the run: its encoder's [`EncodePosts::due`] is called soon, on the run's thread.
    pub fn wake(&self) {
        if let Some(c) = self.0.upgrade() {
            c.woken.store(true, Ordering::SeqCst);
            c.wake_all();
        }
    }

    /// The run's handler (call it on the run's thread), unless the run is gone.
    pub fn handler<R>(&self, f: impl FnOnce(&dyn LiveHandler) -> R) -> Option<R> {
        self.0.upgrade().map(|c| f(&*c.handler))
    }
}

/// Where a live run's GPU canvases are presented ([`LiveRun::attach_surface`]).
pub trait LiveSurfaces: Send + Sync {
    fn attach(&self, key: String, surface: Arc<GpuSurface>, width: u32, height: u32);
    fn detach(&self, key: &str);
    /// See [`LiveRun::gpu_stats`].
    #[cfg(feature = "test-hooks")]
    fn stats(&self) -> GpuStats {
        GpuStats::default()
    }
    /// See [`LiveRun::gpu_pixels`].
    #[cfg(feature = "test-hooks")]
    fn pixels(&self, _key: &str) -> Option<(u32, u32, Vec<u8>)> {
        None
    }
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

/// Rust only, for tests and benchmarks (feature `test-hooks`).
#[cfg(feature = "test-hooks")]
impl LiveRun {
    /// The run's GPU work so far, with feature `widget-gpu`.
    pub fn gpu_stats(&self) -> Option<GpuStats> {
        self.control.surfaces.as_ref().map(|s| s.stats())
    }

    /// The GPU batches the program posted, as the conformance fixtures write them (`{ frame, ops, bytes }` JSON), when
    /// the run started after [`crate::gpu_record_batches`].
    pub fn gpu_posted(&self) -> Vec<String> {
        self.control
            .encoded
            .as_ref()
            .map(|e| lock(e).recorded())
            .unwrap_or_default()
    }

    /// The newest image of the GPU canvas `key`: its width, height and RGBA8 pixels, row by row (it waits for the
    /// GPU).
    pub fn gpu_pixels(&self, key: &str) -> Option<(u32, u32, Vec<u8>)> {
        self.control.surfaces.as_ref()?.pixels(key)
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
        if self.control.encoded.is_some() {
            lock(&self.control.delivered).push(message.clone());
        }
        lock(&self.control.inbox).queue.push_back(message);
        self.control.wake_receive();
        Ok(())
    }

    /// Presents the GPU canvas `key` (a `gpu: true` canvas of the view, `widgets-gpu.md`) into `surface`, which is
    /// `width` × `height` physical pixels: the program gets that size (clamped to 4096 a side) before its next frame,
    /// and the canvas is scaled to the surface when clamped. Call it again with the new size when the canvas's size
    /// changes, or with another surface. Presenting happens on a thread of the run's own. No-op for runs without the
    /// widget encoder's GPU.
    pub fn attach_surface(&self, key: String, surface: Arc<GpuSurface>, width: u32, height: u32) {
        if let Some(s) = &self.control.surfaces {
            s.attach(key, surface, width, height);
        }
    }

    /// Stops presenting the canvas `key`: once this returns (a present in progress finishes first, at most a frame),
    /// its surface is never touched again and is released, so the app may destroy it (Android `surfaceDestroyed`,
    /// a view leaving). Call it before destroying the surface.
    pub fn detach_surface(&self, key: String) {
        if let Some(s) = &self.control.surfaces {
            s.detach(&key);
        }
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
/// Times are the run thread's CPU time ([`ThreadClock`]), so time the OS doesn't schedule it isn't compute.
struct Slice {
    busy: bool,
    /// Counts stretches.
    n: u64,
    /// The thread computing the stretch, and its CPU time when it started.
    clock: ThreadClock,
    start: Duration,
    /// A budget check is on the timer.
    armed: bool,
    /// The stretch a probe is out for, and the thread's CPU time when it went out.
    probe: Option<u64>,
    probe_cpu: Duration,
    /// Host code running on the run's thread (host functions, polls of host calls, the handler's callbacks) doesn't
    /// count as the VM's compute: how deep in it the run's thread is, since when, and how long it spent there in this
    /// stretch.
    host_depth: u32,
    host_since: Duration,
    host_time: Duration,
}

impl Slice {
    /// How long the VM itself has computed in this stretch.
    fn vm_time(&self, now: Duration) -> Duration {
        let host = self.host_time
            + if self.host_depth > 0 {
                now.saturating_sub(self.host_since)
            } else {
                Duration::ZERO
            };
        now.saturating_sub(self.start).saturating_sub(host)
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
    /// With an encoder, posts as its bytes, not JSON; the failure it threw at a post.
    encoded: Option<Mutex<Box<dyn EncodePosts>>>,
    /// Messages delivered that the encoder hasn't been told of (it is told on the run's thread, not the app's).
    delivered: Mutex<Vec<HostValue>>,
    /// The encoder's surfaces.
    surfaces: Option<Arc<dyn LiveSurfaces>>,
    /// The encoder's boundary depth.
    max_value_depth: Option<usize>,
    /// Whether the encoder's runs have typed arrays.
    typed_arrays: bool,
    /// When the timer asks for the encoder's held-back posts next.
    due_at: Mutex<Option<Instant>>,
    /// [`LiveContext::wake`] asked for the encoder's [`EncodePosts::due`]: a host call that waits on is polled again
    /// between the VM's runs, where it is called (the wake may have come while no call was waiting yet).
    woken: AtomicBool,
    /// A program error that ended the run at once (a view the encoder refused).
    ended: Mutex<Option<PsychoScriptError>>,
    thrown: Thrown,
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
        Arc::new_cyclic(|me| {
            let encoded = encoder.as_ref().map(|e| e.0.live(LiveContext(me.clone())));
            Control {
                me: me.clone(),
                handler,
                options,
                input_name,
                transport,
                max_value_depth: encoder.as_ref().and_then(|e| e.0.max_value_depth()),
                typed_arrays: encoder.as_ref().is_some_and(|e| e.0.typed_arrays()),
                surfaces: encoded.as_ref().and_then(|e| e.surfaces()),
                encoded: encoded.map(Mutex::new),
                delivered: Mutex::new(Vec::new()),
                ended: Mutex::new(None),
                due_at: Mutex::new(None),
                woken: AtomicBool::new(false),
                thrown: Thrown::default(),
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
                stopping: AtomicBool::new(false),
                slice: Mutex::new(Slice {
                    busy: false,
                    n: 0,
                    clock: ThreadClock::current(),
                    start: Duration::ZERO,
                    armed: false,
                    probe: None,
                    probe_cpu: Duration::ZERO,
                    host_depth: 0,
                    host_since: Duration::ZERO,
                    host_time: Duration::ZERO,
                }),
                why: Mutex::new(Why::None),
                suspending: Mutex::new(()),
            }
        })
    }

    /// The encoder, told first of the messages delivered since.
    fn encoder(&self) -> Option<MutexGuard<'_, Box<dyn EncodePosts>>> {
        let mut encoder = lock(self.encoded.as_ref()?);
        let delivered = std::mem::take(&mut *lock(&self.delivered));
        for m in &delivered {
            encoder.delivered(m);
        }
        Some(encoder)
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
        let ended = lock(&self.ended).take();
        let exit = match outcome {
            _ if ended.is_some() => LiveExit::Failed {
                error: ended.unwrap_or(PsychoScriptError::InvalidState {
                    reason: String::new(),
                }),
            },
            Ok(RunOutcome::Suspended(_)) => match why {
                // `snapshot` keeps the state and joins this thread.
                Why::Snapshot => {
                    self.take_held(true);
                    return self.flush();
                }
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
                Err(d) => {
                    let mut error =
                        PsychoScriptError::from_diagnostic(d, None, self.options.max_heap_bytes);
                    self.thrown.name(&mut error);
                    LiveExit::Failed { error }
                }
            },
            Err(_interrupted) => LiveExit::Stopped,
        };
        // The final view is never lost: what an encoder holds back goes out, unless the app stopped the run, which
        // drops it.
        match exit {
            LiveExit::Stopped => self.hand_over(),
            _ => {
                self.take_held(true);
                self.flush();
            }
        }
        self.end();
        self.handler.on_exit(exit);
    }

    fn end(&self) {
        if let Some(mut encoder) = self.encoder() {
            encoder.ended();
        }
        *self.state() = State::Ended;
        lock(&self.inbox).waker = None;
        lock(&self.sleeps).clear();
        *lock(&self.run) = None;
    }

    /// The runtime for one thread's run: the input function and `__host`.
    fn runtime(self: &Arc<Self>, input: Option<Arc<str>>, restored: bool) -> Runtime {
        let control = self.clone();
        let name = self.input_name.clone();
        let translate = Translate {
            functions: match self.encoded {
                Some(_) => TranslateFunctions::Mark,
                None => TranslateFunctions::Error,
            },
            ..Translate::default()
        };
        let limits = Limits {
            max_heap_bytes: self.options.max_heap_bytes,
            max_value_depth: self.max_value_depth,
            ..Default::default()
        };
        Runtime::make()
            .limits(limits)
            .translate(translate)
            .typed_arrays(self.typed_arrays)
            .globals(move |run| {
                let text: Arc<str> = match &input {
                    Some(text) => {
                        run.set_metadata(control.metadata(text));
                        text.clone()
                    }
                    None => control.restore_metadata(&run.metadata(), restored),
                };
                *lock(&control.run) = Some(run.clone());
                let c = control.clone();
                let label = name.clone();
                let input = HostFunction::new(move |args: Vec<HostValue>, _call| -> HostResult {
                    c.interrupted()?;
                    c.computing();
                    let _host = HostSection::enter(&c);
                    c.unmarked(&args, 0, &label)?;
                    let input = Input::parse(&text).unwrap_or_default();
                    Ok(match c.encoder() {
                        Some(mut encoder) => encoder.input(input),
                        None => input,
                    })
                });
                let c = control.clone();
                let post = HostFunction::new(move |args: Vec<HostValue>, _call| -> HostResult {
                    c.interrupted()?;
                    c.computing();
                    let _host = HostSection::enter(&c);
                    c.unmarked(&args, 1, "__host.post")?;
                    c.post(args.first().unwrap_or(&HostValue::Undefined))
                });
                let c = control.clone();
                let now = HostFunction::new(move |args: Vec<HostValue>, _call| -> HostResult {
                    c.interrupted()?;
                    c.computing();
                    let _host = HostSection::enter(&c);
                    c.unmarked(&args, 0, "__host.now")?;
                    Ok(HostValue::Number(c.now_ms()))
                });
                let c = control.clone();
                let receive = HostFunction::new_async(move |args: Vec<HostValue>, _call| {
                    let c = c.clone();
                    let mut at = At::Inside;
                    let mut marked = c.unmarked(&args, 0, "__host.receive").err();
                    std::future::poll_fn(move |cx| {
                        if let Some(e) = marked.take() {
                            return Poll::Ready(Err(e));
                        }
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
                    let mut marked = c.unmarked(&args, 0, "__host.sleep").err();
                    std::future::poll_fn(move |cx| {
                        if let Some(e) = marked.take() {
                            return Poll::Ready(Err(e));
                        }
                        let at = std::mem::replace(&mut at, At::Between);
                        c.around(at, cx, |cx| c.poll_sleep(&key, ms, cx, at))
                    })
                })
                .idempotent();
                let c = control.clone();
                let fetch = HostFunction::new_async(move |args: Vec<HostValue>, _call| {
                    let mut marked = c.unmarked(&args, 0, "__host.fetch").err();
                    let slot = match marked {
                        Some(_) => Arc::default(),
                        None => c.start_fetch(args.first()),
                    };
                    let c = c.clone();
                    let mut at = At::Inside;
                    std::future::poll_fn(move |cx| {
                        if let Some(e) = marked.take() {
                            return Poll::Ready(Err(e));
                        }
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

    /// On the run's thread.
    fn start_stretch(&self, slice: &mut Slice) {
        slice.clock = ThreadClock::current();
        let now = slice.clock.now();
        slice.n += 1;
        slice.start = now;
        slice.busy = true;
        slice.probe = None;
        slice.host_time = Duration::ZERO;
        if slice.host_depth > 0 {
            slice.host_since = now;
        }
        if !std::mem::replace(&mut slice.armed, true) {
            timer::schedule(Instant::now() + self.budget(), Fire::Watch(self.me.clone()));
        }
    }

    fn budget(&self) -> Duration {
        Duration::from_millis(self.options.slice_budget_ms.max(1))
    }

    /// Host code starts on the run's thread: its time isn't the VM's.
    fn enter_host(&self) {
        let mut slice = lock(&self.slice);
        if slice.host_depth == 0 {
            slice.host_since = ThreadClock::current().now();
        }
        slice.host_depth += 1;
    }

    fn leave_host(&self) {
        let mut slice = lock(&self.slice);
        slice.host_depth = slice.host_depth.saturating_sub(1);
        if slice.host_depth == 0 {
            let spent = ThreadClock::current()
                .now()
                .saturating_sub(slice.host_since);
            slice.host_time += spent;
            // A probe that went out meanwhile couldn't be answered: the next check sends another.
            slice.probe = None;
        }
    }

    /// The timer's check. A stretch past its budget of VM time gets a probe (its pending host calls woken); one still
    /// going a grace period after its probe, its thread having run meanwhile, is stopped. Time in host code doesn't
    /// count, and no probe goes out while the run's thread is in it (it couldn't answer).
    pub(crate) fn watch(&self) {
        let mut slice = lock(&self.slice);
        slice.armed = false;
        if !slice.busy {
            return;
        }
        let (now, cpu) = (Instant::now(), slice.clock.now());
        let vm = slice.vm_time(cpu);
        let left = self.budget().saturating_sub(vm);
        let over = left.is_zero();
        let probed = slice.probe == Some(slice.n);
        let at = match slice.probe {
            _ if slice.host_depth > 0 => Some(now + left.max(Duration::from_millis(5))),
            // Unanswered though its thread ran: the VM is still computing.
            _ if probed && over && cpu > slice.probe_cpu => None,
            // Its thread hasn't run since: another grace.
            _ if probed && over => Some(now + PROBE_GRACE),
            _ if !over => Some(now + left),
            _ => {
                slice.probe = Some(slice.n);
                slice.probe_cpu = cpu;
                Some(now + PROBE_GRACE)
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
            let encoded = self.encoded.as_ref().map(|e| lock(e).save());
            run.update_metadata(|m| {
                set_field(m, "clock", number(clock));
                set_field(m, "pausedAt", number(paused_at));
                set_field(m, "sleeps", sleeps);
                if let Some(saved) = encoded {
                    set_field(m, "encoder", saved);
                }
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

    /// What a call throws for an encoder's rejection; a program error that ends the run at once interrupts it.
    fn reject(&self, r: Reject) -> HostValue {
        if let Reject::End(f) = r {
            lock(&self.ended).get_or_insert(crate::program::refused(f));
            self.stopping.store(true, Ordering::SeqCst);
            return HostValue::Interrupt;
        }
        self.thrown
            .throw(r, "__host.post")
            .unwrap_or(HostValue::Undefined)
    }

    /// With an encoder (functions crossing as markers), a marker in an argument from `from` on fails the call as a
    /// function does without markers.
    fn unmarked(&self, args: &[HostValue], from: usize, label: &str) -> Result<(), HostValue> {
        if self.encoded.is_none() {
            return Ok(());
        }
        match args.iter().skip(from).position(marked) {
            Some(i) => Err(self.thrown.function(label, from + i + 1)),
            None => Ok(()),
        }
    }

    /// Queues a post and returns what `post` gives the program: `undefined`, or with an encoder what it says (a
    /// native widget render: whether the view has handlers). An encoder's failure is thrown at the post.
    fn post(&self, message: &HostValue) -> HostResult {
        let (first, ret) = match self.encoder() {
            Some(mut encoder) => {
                let posted = encoder.post(message, Instant::now());
                drop(encoder);
                let (bytes, ret) = posted.map_err(|r| self.reject(r))?;
                self.arm_due();
                if bytes.is_empty() {
                    return Ok(ret);
                }
                let mut outbox = lock(&self.outbox);
                let first = outbox.bytes.is_empty();
                outbox.bytes.extend(bytes);
                (first, ret)
            }
            None => {
                let text = json::write(message);
                let mut outbox = lock(&self.outbox);
                outbox.json.push(text);
                (outbox.json.len() == 1, HostValue::Undefined)
            }
        };
        // The host calls the program waits on now get polled again once it stops, which hands the posts over.
        if first {
            self.wake_all();
        }
        Ok(ret)
    }

    /// Asks the encoder again when its next held-back post is due: the timer then wakes the run's pending calls, whose
    /// poll hands it over.
    fn arm_due(&self) {
        let Some(encoded) = &self.encoded else { return };
        let Some(at) = lock(encoded).next_due() else {
            return;
        };
        let mut armed = lock(&self.due_at);
        if armed.is_some_and(|armed| armed <= at) {
            return;
        }
        *armed = Some(at);
        drop(armed);
        timer::schedule(at, Fire::Due(self.me.clone()));
    }

    /// The timer's call for held-back posts that are due.
    pub(crate) fn due(&self) {
        *lock(&self.due_at) = None;
        self.wake_all();
    }

    /// Moves the encoder's due posts, or with `all` every held-back one, into the outbox.
    fn take_held(&self, all: bool) {
        if !all {
            self.woken.store(false, Ordering::SeqCst);
        }
        let Some(mut encoder) = self.encoder() else {
            return;
        };
        let bytes = match all {
            true => encoder.release(),
            false => encoder.due(Instant::now()),
        };
        drop(encoder);
        if !bytes.is_empty() {
            lock(&self.outbox).bytes.extend(bytes);
        }
        if !all {
            self.arm_due();
        }
    }

    /// Hands the queued posts (and the encoder's held-back ones that are due) to the host in one call.
    fn flush(&self) {
        self.take_held(false);
        self.hand_over();
    }

    /// Hands the queued posts to the host in one call.
    fn hand_over(&self) {
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
        let posts = at == At::Inside && !lock(&self.outbox).is_empty();
        if result.is_pending() && (posts || self.woken.load(Ordering::SeqCst)) {
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
                if let Some(mut encoder) = self.encoder() {
                    let bytes = encoder.received(&message);
                    drop(encoder);
                    if !bytes.is_empty() {
                        lock(&self.outbox).bytes.extend(bytes);
                    }
                }
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
            let mut s = lock(&slot);
            s.denied = r.denial();
            s.result = Some(Err(r.value()));
            drop(s);
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
                );
                let denied = result.as_ref().err().and_then(Rejection::denial);
                let result = result.map_err(Rejection::value);
                lock(&control.fetch_budget).in_flight -= 1;
                let waker = {
                    let mut slot = lock(&worker_slot);
                    slot.denied = denied;
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
                let denied = slot.denied.take();
                drop(slot);
                self.resolved(at);
                // A denied fetch reaches the program, and the app too, once (for dev mode); the crate logs nothing.
                if let Some(message) = denied {
                    self.handler.on_warning(message);
                }
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
        if let (Some(encoded), Some(saved)) = (&self.encoded, field("encoder")) {
            lock(encoded).load(saved);
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
