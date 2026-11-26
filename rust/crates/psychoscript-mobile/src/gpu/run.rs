//! A live run's GPU: its batches replayed on the app's device in the order the program posted them, its canvases
//! presented into the app's surfaces, what the program is told of its GPU (availability, canvas sizes), and device
//! loss. All but `LiveSurfaces::attach` and the loss callbacks run on the run's thread.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use psychoscript::HostValue;
use psychoscript_gpu::{Arg, ErrorKind, Gpu, GpuError, SavedStop, SavedStops, Stops};

#[cfg(feature = "test-hooks")]
use super::GpuStats;
use super::device::{self, Dev};
use super::present::{Frame, Surfaces};
use super::{GpuCanvasState, GpuErrorKind, GpuSurface};
use crate::{LiveContext, LiveSurfaces};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What waits for a new device after a loss, to replay in order.
enum Held {
    Batch(Vec<Arg>, Vec<u8>, Option<(u32, u32)>),
    Shape(Option<Vec<Arg>>, String, Option<(u32, u32)>),
    EndFrame,
    Canvases(Vec<String>),
    Resize(String, u32, u32),
}

#[derive(Default)]
struct State {
    gpu: Option<Gpu>,
    dev: Option<Arc<Dev>>,
    /// The `gpu: true` canvases of the last render posted.
    keys: Vec<String>,
    /// The canvas sizes the program received.
    sizes: HashMap<String, (u32, u32)>,
    /// Each canvas's version last presented, and whether it was opaque.
    versions: HashMap<String, (u64, bool)>,
    /// After a loss, until the new device (or until the first device is made): what the program posts meanwhile.
    held: Option<Vec<Held>>,
    /// The program was told it has a GPU while the device was still being made.
    waiting: bool,
    /// A restored run's greatest handle and stopped canvases, for its GPU once the device is there.
    restore: Option<(u64, SavedStops)>,
    /// The batches the GPU may still be on, oldest first.
    flights: VecDeque<Arc<device::Watch>>,
}

/// A live run's GPU, made by its encoder's live posts ([`crate::EncodeValues::live`]) and given to the run as its
/// surfaces ([`crate::EncodePosts::surfaces`]). The posts hand it what the program posts, in order: [`LiveGpu::batch`]
/// (or [`LiveGpu::shape_error`] for a batch that isn't one), [`LiveGpu::end_frame`] at each frame request, the canvases
/// that may be drawn ([`LiveGpu::canvases`]) and the sizes it told the program ([`LiveGpu::resize`]); and they call
/// [`LiveGpu::due`] when the run asks for what is due, [`LiveGpu::finish`] as the run ends and [`LiveGpu::ended`] once it
/// ended. The program is told of its GPU through the run's messages:
/// - the size of a canvas the app attached, `{ type: "canvas", key, width, height }` (clamped,
///   `psychoscript_gpu::clamp_size`), when it changes;
/// - a device loss, `{ type: "gpu", lost: reason, message? }`, before the app is told, and when a restored run starts.
///
/// Errors and losses reach the app as [`GpuCanvasState`]s (`LiveHandler::on_gpu_canvas`).
pub struct LiveGpu {
    ctx: LiveContext,
    surfaces: Arc<Surfaces>,
    state: Mutex<State>,
    /// The sizes sent to the program, by canvas key (from [`LiveGpu::attach`], on the app's thread).
    sent: Mutex<HashMap<String, (u32, u32)>>,
    loss: Mutex<Option<(String, String)>>,
    replaced: AtomicBool,
    /// GPU hangs found ([`device::Loss::tick`]), to tell on the run's thread.
    hangs: Mutex<Vec<GpuError>>,
}

impl LiveGpu {
    /// A run's GPU: its device is made from now on, off the run's thread, unless it is already.
    pub fn new(ctx: LiveContext) -> Arc<LiveGpu> {
        device::prepare();
        let run = Arc::new(LiveGpu {
            ctx,
            surfaces: Arc::default(),
            state: Mutex::default(),
            sent: Mutex::default(),
            loss: Mutex::new(None),
            replaced: AtomicBool::new(false),
            hangs: Mutex::default(),
        });
        let weak: std::sync::Weak<dyn device::Loss> =
            Arc::downgrade(&(run.clone() as Arc<dyn device::Loss>));
        device::subscribe(weak);
        run
    }

    fn tell(&self, key: Option<&str>, state: GpuCanvasState) {
        self.ctx
            .handler(|h| h.on_gpu_canvas(key.map(str::to_owned), state));
    }

    /// `at`: the line and column of the post that carried the batch.
    fn stopped(&self, e: &GpuError, at: Option<(u32, u32)>) {
        let kind = match e.kind {
            ErrorKind::Program => GpuErrorKind::Program,
            ErrorKind::Client => GpuErrorKind::Client,
        };
        let state = |report: bool| GpuCanvasState::Stopped {
            kind,
            message: e.message.clone(),
            report: report && kind == GpuErrorKind::Program,
            line: at.map(|(l, _)| l),
            column: at.map(|(_, c)| c),
        };
        match &e.canvases {
            Stops::All => self.tell(None, state(true)),
            Stops::Canvases(keys) => {
                for (i, k) in keys.iter().enumerate() {
                    self.tell(Some(k), state(i == 0));
                }
            }
        }
    }

    /// The device, and the run's [`Gpu`] on it, or why there is none.
    fn start(&self, st: &mut State) -> Result<(), String> {
        let dev = device::get()?;
        let gpu =
            Gpu::new(dev.device.clone(), dev.queue.clone(), dev.format).map_err(|e| e.message)?;
        st.gpu = Some(gpu);
        st.dev = Some(dev);
        Ok(())
    }

    /// What to tell the program of its GPU as it starts, `{ available, format }` (`format` `"bgra8unorm"` or
    /// `"rgba8unorm"`, the canvas format to configure), at once: while the device is still being made, what the
    /// program posts waits for it. Without a device, every GPU canvas shows its placeholder.
    pub fn input(&self) -> HostValue {
        let mut st = lock(&self.state);
        // Why there is no GPU, when there is none.
        let mut unavailable = None;
        if st.gpu.is_none() && !st.waiting {
            unavailable = match device::ready() {
                Some(Ok(_)) => self.start(&mut st).err(),
                Some(Err(why)) => Some(why),
                None => match device::format() {
                    Ok(_) => {
                        st.waiting = true;
                        st.held = Some(Vec::new());
                        None
                    }
                    Err(why) => Some(why),
                },
            };
        }
        let available = st.gpu.is_some() || st.waiting;
        let format = match &st.gpu {
            Some(gpu) => gpu.preferred_format(),
            None => device::format().unwrap_or("rgba8unorm"),
        }
        .to_owned();
        #[cfg(feature = "test-hooks")]
        let format = lock(&super::FORMAT).clone().unwrap_or(format);
        drop(st);
        if let Some(reason) = unavailable {
            self.tell(None, GpuCanvasState::Unavailable { reason });
        }
        HostValue::Object(vec![
            ("available".into(), HostValue::Bool(available)),
            ("format".into(), HostValue::String(format.as_str().into())),
        ])
    }

    /// The greatest handle the program made and the canvases errors stopped, for a snapshot.
    pub fn saved(&self) -> (u64, SavedStops) {
        let st = lock(&self.state);
        match (&st.gpu, &st.restore) {
            (Some(gpu), _) => (gpu.last_handle(), gpu.saved_stops()),
            (None, Some(restore)) => restore.clone(),
            (None, None) => (0, SavedStops::default()),
        }
    }

    /// A run restored from a snapshot whose program made handles up to `last`, drew `keys` and had the canvases
    /// `stops` stopped (psychoscript-gpu's `README.md`, A run restored from a snapshot): to the program a device loss,
    /// told before it runs on; handles from before are dropped quietly, the stopped canvases stay stopped and aren't
    /// reported again. It doesn't wait for the device: while it is being made, what the program posts waits for it.
    pub fn restored(&self, last: u64, keys: Vec<String>, stops: SavedStops) {
        let mut st = lock(&self.state);
        for k in &keys {
            st.sizes.entry(k.clone()).or_insert((0, 0));
        }
        st.keys = keys;
        st.restore = Some((last, stops));
        let unavailable = match device::ready() {
            Some(Ok(_)) => self.start(&mut st).err(),
            Some(Err(why)) => Some(why),
            None => {
                st.waiting = true;
                st.held = Some(Vec::new());
                None
            }
        };
        let told = match st.gpu.is_some() {
            true => self.restore_in(&mut st),
            false => Vec::new(),
        };
        drop(st);
        self.ctx.deliver(lost_message("unknown", ""));
        if let Some(reason) = unavailable {
            return self.tell(None, GpuCanvasState::Unavailable { reason });
        }
        self.tell_restored(told);
    }

    /// Gives the run's new GPU what a snapshot kept: the canvases it had the program draw, the handles from before,
    /// and the stops, which the app is told of again (not to report).
    fn restore_in(&self, st: &mut State) -> Vec<(Option<String>, SavedStop)> {
        let (Some(gpu), Some((last, stops))) = (st.gpu.as_mut(), st.restore.take()) else {
            return Vec::new();
        };
        gpu.restored(last);
        let mut told: Vec<(Option<String>, SavedStop)> = stops
            .canvases
            .iter()
            .map(|(k, s)| (Some(k.clone()), s.clone()))
            .collect();
        if let Some(all) = &stops.all {
            told.insert(0, (None, all.clone()));
        }
        gpu.restore_stops(stops);
        for k in &st.keys {
            let (w, h) = st.sizes.get(k).copied().unwrap_or((0, 0));
            gpu.resize(k, w, h);
        }
        told
    }

    fn tell_restored(&self, told: Vec<(Option<String>, SavedStop)>) {
        for (key, stop) in told {
            let kind = match stop.kind {
                ErrorKind::Program => GpuErrorKind::Program,
                ErrorKind::Client => GpuErrorKind::Client,
            };
            let state = GpuCanvasState::Stopped {
                kind,
                message: stop.message,
                report: false,
                line: None,
                column: None,
            };
            self.tell(key.as_deref(), state);
        }
    }

    /// What waits on the run's thread: a device loss and its new device, a surface that failed.
    pub fn due(&self) {
        if let Some((reason, message)) = lock(&self.loss).take() {
            let mut st = lock(&self.state);
            // A second strike stops every canvas (`Gpu::lost`, then `Gpu::poll` has its error).
            let hung = st.gpu.as_mut().and_then(|gpu| {
                gpu.lost();
                gpu.poll().err()
            });
            if let Some(gpu) = &st.gpu {
                // A canvas an error stopped keeps its placeholder (stopped stays stopped).
                let lost: Vec<String> = (st.keys.iter())
                    .filter(|k| gpu.error(k).is_none())
                    .cloned()
                    .collect();
                st.held.get_or_insert_with(Vec::new);
                st.versions.clear();
                st.flights.clear();
                drop(st);
                self.surfaces.clear();
                // The program first: when the app hears of it, its message is there.
                self.ctx.deliver(lost_message(&reason, &message));
                if let Some(e) = hung {
                    self.stopped(&e, None);
                }
                let why = match message.is_empty() {
                    true => format!("the GPU device was lost ({reason})"),
                    false => format!("the GPU device was lost ({reason}): {message}"),
                };
                for k in lost {
                    let reason = why.clone();
                    self.tell(Some(&k), GpuCanvasState::Lost { reason });
                }
            }
        }
        let hangs = std::mem::take(&mut *lock(&self.hangs));
        for e in hangs {
            self.stopped(&e, None);
        }
        if self.replaced.swap(false, Ordering::SeqCst) {
            self.replace();
        }
        for (key, why) in self.surfaces.failures() {
            self.tell(
                Some(&key),
                GpuCanvasState::Stopped {
                    kind: GpuErrorKind::Client,
                    message: why,
                    report: false,
                    line: None,
                    column: None,
                },
            );
        }
    }

    /// The new device after a loss: the run's GPU starts again on it, and what the program posted meanwhile replays.
    fn replace(&self) {
        let mut st = lock(&self.state);
        let st = &mut *st;
        if st.held.is_none() {
            return;
        }
        let first = std::mem::take(&mut st.waiting);
        let started = match (device::current(), st.gpu.as_mut()) {
            (Some(dev), Some(gpu)) => gpu
                .reset(dev.device.clone(), dev.queue.clone())
                .map(|()| dev),
            (Some(dev), None) => {
                Gpu::new(dev.device.clone(), dev.queue.clone(), dev.format).map(|gpu| {
                    st.gpu = Some(gpu);
                    dev
                })
            }
            (None, _) => Err(psychoscript_gpu::GpuError {
                kind: ErrorKind::Client,
                message: match device::ready() {
                    Some(Err(why)) => why,
                    _ => "no GPU device could be made".into(),
                },
                canvases: Stops::All,
            }),
        };
        let held = st.held.take().unwrap_or_default();
        match started {
            Ok(dev) => st.dev = Some(dev),
            Err(e) => {
                st.gpu = None;
                // No device after all: as without a GPU from now on. A program told it had one (the first device
                // was still being made) loses it, as on a device loss; after a loss, or restored, it was told already.
                if first && st.restore.take().is_none() {
                    self.ctx.deliver(lost_message("unknown", &e.message));
                }
                return self.tell(None, GpuCanvasState::Unavailable { reason: e.message });
            }
        }
        // A restored run's handles and stops, before what it posted replays.
        let told = self.restore_in(st);
        self.tell_restored(told);
        for h in held {
            match h {
                Held::Batch(ops, bytes, at) => self.batch_in(st, &ops, &bytes, at),
                Held::Shape(ops, message, at) => self.shape_in(st, ops.as_deref(), message, at),
                Held::EndFrame => {
                    if let Some(g) = st.gpu.as_mut() {
                        g.end_frame();
                        #[cfg(feature = "test-hooks")]
                        lose_at_frame_end(g);
                    }
                }
                Held::Canvases(keys) => canvases_in(st, &keys),
                Held::Resize(key, w, h) => resize_in(st, &key, w, h),
            }
        }
    }

    /// A batch of the wrong shape ([`LiveGpu::shape_error`]): it stops canvases; nothing replays.
    fn shape_in(
        &self,
        st: &mut State,
        ops: Option<&[Arg]>,
        message: String,
        at: Option<(u32, u32)>,
    ) {
        let Some(gpu) = st.gpu.as_mut() else { return };
        if let Err(e) = gpu.shape_error(ops, message) {
            self.stopped(&e, at);
        }
    }

    fn batch_in(&self, st: &mut State, ops: &[Arg], bytes: &[u8], at: Option<(u32, u32)>) {
        let Some(gpu) = st.gpu.as_mut() else { return };
        #[cfg(feature = "test-hooks")]
        let started = std::time::Instant::now();
        let submits = device::submits();
        let applied = gpu.apply(ops, bytes);
        let watch = st.dev.as_ref().map(|dev| device::watch(dev, &submits));
        drop(submits);
        #[cfg(feature = "test-hooks")]
        (self.surfaces.stats()).replayed(started.elapsed().as_secs_f64() * 1e6);
        if let Err(e) = applied {
            // wgpu tells of a loss as the device is next used: an error then is the loss's, not the program's, and
            // the batch waits for the new device.
            if let Some(dev) = &st.dev {
                device::poll(&dev.device, false);
            }
            // Posted before the program learned of the loss: dropped quietly.
            if lock(&self.loss).is_some() {
                return;
            }
            self.stopped(&e, at);
        }
        st.flights.extend(watch);
        self.present(st);
    }

    /// The batch before the run's last, when the GPU is still on it: a new batch waits for it, so that at most one of
    /// the run's batches is in flight as the next replays.
    fn in_flight(st: &mut State) -> Option<(Arc<Dev>, Arc<device::Watch>)> {
        let dev = st.dev.clone()?;
        while st.flights.front().is_some_and(|w| w.done(&dev)) {
            st.flights.pop_front();
        }
        let n = st.flights.len();
        Some((dev, st.flights.get(n.checked_sub(2)?)?.clone()))
    }

    /// Hands each canvas whose texture a pass wrote to its surface.
    fn present(&self, st: &mut State) {
        let (Some(gpu), Some(dev)) = (st.gpu.as_ref(), st.dev.as_ref()) else {
            return;
        };
        for key in &st.keys {
            if gpu.error(key).is_some() {
                continue;
            }
            let Some(c) = gpu.canvas(key) else { continue };
            let opaque = c.alpha == psychoscript_gpu::AlphaMode::Opaque;
            let seen = st.versions.insert(key.clone(), (c.version, opaque));
            if seen.is_some_and(|(v, _)| v == c.version) {
                continue;
            }
            self.surfaces.frame(
                key,
                Frame {
                    texture: c.texture.clone(),
                    alpha: c.alpha,
                    dev: dev.clone(),
                },
            );
            if seen.is_none_or(|(_, o)| o != opaque) {
                self.tell(Some(key), GpuCanvasState::Live { opaque });
            }
        }
    }

    /// The run ends (not stopped by the app): what waits for a device (the first, or a new one after a loss) replays
    /// on it now, so the program's errors are checked and told before the end.
    pub fn finish(&self) {
        if lock(&self.state).held.is_some() {
            let _ = device::get();
            self.replaced.store(false, Ordering::SeqCst);
            self.replace();
        }
    }

    /// The run ended: its device resources and surfaces go.
    pub fn ended(&self) {
        let mut st = lock(&self.state);
        st.gpu = None;
        st.dev = None;
        st.held = None;
        drop(st);
        self.surfaces.stop();
    }
}

fn lost_message(reason: &str, message: &str) -> HostValue {
    let mut m = vec![
        ("type".into(), HostValue::String("gpu".into())),
        ("lost".into(), HostValue::String(reason.into())),
    ];
    if !message.is_empty() {
        m.push(("message".into(), HostValue::String(message.into())));
    }
    HostValue::Object(m)
}

/// A test's loss at a frame's end, its work in flight: also a frame held for the new device, at its end as it
/// replays.
#[cfg(feature = "test-hooks")]
fn lose_at_frame_end(gpu: &mut Gpu) {
    match super::LOSE_AT_FRAME_END.swap(0, Ordering::SeqCst) {
        0 => {}
        with => {
            if with == 2 {
                gpu.work_finished();
            }
            // In flight, as the fixture says, though its small batch may be seen finished already.
            gpu.work_in_flight();
            gpu.lost();
            super::gpu_lose_device();
        }
    }
}

fn canvases_in(st: &mut State, keys: &[String]) {
    let Some(gpu) = st.gpu.as_mut() else {
        st.keys = keys.to_vec();
        return;
    };
    for k in &st.keys {
        if !keys.contains(k) {
            gpu.remove(k);
        }
    }
    for k in keys {
        if !st.keys.contains(k) {
            let (w, h) = st.sizes.get(k).copied().unwrap_or((0, 0));
            gpu.resize(k, w, h);
        }
    }
    st.versions.retain(|k, _| keys.contains(k));
    st.keys = keys.to_vec();
}

fn resize_in(st: &mut State, key: &str, w: u32, h: u32) {
    st.sizes.insert(key.to_owned(), (w, h));
    if let (true, Some(gpu)) = (st.keys.iter().any(|k| k == key), st.gpu.as_mut()) {
        gpu.resize(key, w, h);
    }
}

/// What the program posts, in order.
impl LiveGpu {
    /// A batch the program posted, its ops and bytes, replayed now (or when the device is there). Its errors are at the
    /// post's line and column ([`LiveContext::post_location`]).
    pub fn batch(&self, ops: &[Arg], bytes: &[u8]) {
        let at = self.ctx.post_location();
        // A batch replays once the GPU is done with the run's batch before the last: the GPU draws one while the next
        // replays (on a Pixel the CPU and GPU took turns, the GPU idle a third of the time at a third of its clock),
        // and a program whose frames take the GPU longer than the display's waits for it, on the run's thread, with
        // at most one batch queued behind the GPU, never building up GPU work (which holds up every canvas; a Metal
        // queue then gives up) nor inside a submit (some drivers wait there; `Gpu::poll` looks for a hang meanwhile,
        // counting a submit's time from when the one before it finished, so the batch queued behind a hung one isn't
        // blamed; a hang stops its canvases, and the run waits on behind it, adding nothing).
        let wait = LiveGpu::in_flight(&mut lock(&self.state));
        if let Some((dev, watch)) = wait {
            device::settle(&dev, &watch, || self.ctx.interrupted());
        }
        let mut st = lock(&self.state);
        if let Some(held) = st.held.as_mut() {
            held.push(Held::Batch(ops.to_vec(), bytes.to_vec(), at));
            return;
        }
        self.batch_in(&mut st, ops, bytes, at);
    }

    /// A batch the program posted that isn't one (`psychoscript_gpu::Gpu::shape_error`'s messages): `ops` its ops when
    /// they are a list.
    pub fn shape_error(&self, ops: Option<&[Arg]>, message: String) {
        let at = self.ctx.post_location();
        let mut st = lock(&self.state);
        if let Some(held) = st.held.as_mut() {
            held.push(Held::Shape(ops.map(<[Arg]>::to_vec), message, at));
            return;
        }
        self.shape_in(&mut st, ops, message, at);
    }

    /// A frame request, after the batch it carries.
    pub fn end_frame(&self) {
        let mut st = lock(&self.state);
        let st = &mut *st;
        match (st.held.as_mut(), st.gpu.as_mut()) {
            (Some(held), _) => held.push(Held::EndFrame),
            (None, Some(gpu)) => {
                gpu.end_frame();
                #[cfg(feature = "test-hooks")]
                lose_at_frame_end(gpu);
            }
            (None, None) => {}
        }
    }

    /// The canvases the program may draw now, by key (each is drawn at the size [`LiveGpu::resize`] last gave it).
    pub fn canvases(&self, keys: &[String]) {
        let mut st = lock(&self.state);
        match st.held.as_mut() {
            Some(held) => held.push(Held::Canvases(keys.to_vec())),
            None => canvases_in(&mut st, keys),
        }
    }

    /// The size the program received for canvas `key`.
    pub fn resize(&self, key: &str, width: u32, height: u32) {
        let mut st = lock(&self.state);
        match st.held.as_mut() {
            Some(held) => held.push(Held::Resize(key.to_owned(), width, height)),
            None => resize_in(&mut st, key, width, height),
        }
    }
}

impl device::Loss for LiveGpu {
    fn lost(&self, reason: &str, message: &str) {
        // At once (`Gpu::lost`: the work running 250 ms hung), unless the run's thread is replaying, in which wgpu
        // may be telling of it: that thread does, before the program is told.
        match self.state.try_lock() {
            Ok(mut st) => st.gpu.as_mut().map(Gpu::lost),
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner().gpu.as_mut().map(Gpu::lost),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        *lock(&self.loss) = Some((reason.to_owned(), message.to_owned()));
        self.ctx.wake();
    }

    fn replaced(&self) {
        self.replaced.store(true, Ordering::SeqCst);
        self.ctx.wake();
    }

    /// A GPU hang (`widgets-gpu.md`): `Gpu::poll`, skipped while the run's thread is replaying (it can't be stuck
    /// in a submit, at most two batches being on the GPU).
    fn tick(&self) {
        // A test's loss at the next frame end is to find that frame's work not seen finished.
        #[cfg(feature = "test-hooks")]
        if super::LOSE_AT_FRAME_END.load(Ordering::SeqCst) != 0 {
            return;
        }
        let mut st = match self.state.try_lock() {
            Ok(st) => st,
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return,
        };
        let Some(gpu) = st.gpu.as_mut() else { return };
        if let Err(e) = gpu.poll() {
            drop(st);
            lock(&self.hangs).push(e);
            self.ctx.wake();
        }
    }
}

impl LiveSurfaces for LiveGpu {
    fn attach(&self, key: String, surface: Arc<GpuSurface>, width: u32, height: u32) {
        // A surface not laid out yet (0 × 0): attached, but the program's size waits for a real one.
        let size = psychoscript_gpu::clamp_size(width.max(1), height.max(1));
        let changed =
            width > 0 && height > 0 && lock(&self.sent).insert(key.clone(), size) != Some(size);
        if changed {
            self.ctx.deliver(HostValue::Object(vec![
                ("type".into(), HostValue::String("canvas".into())),
                ("key".into(), HostValue::String(key.as_str().into())),
                ("width".into(), HostValue::Number(size.0 as f64)),
                ("height".into(), HostValue::Number(size.1 as f64)),
            ]));
        }
        self.surfaces.attach(key, surface, width, height);
    }

    fn detach(&self, key: &str) {
        self.surfaces.detach(key);
    }

    #[cfg(feature = "test-hooks")]
    fn stats(&self) -> GpuStats {
        self.surfaces.stats().clone()
    }

    #[cfg(feature = "test-hooks")]
    fn pixels(&self, key: &str) -> Option<(u32, u32, Vec<u8>)> {
        self.surfaces.pixels(key)
    }
}
