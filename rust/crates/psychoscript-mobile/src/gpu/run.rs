//! A widget run's GPU (`widgets-gpu.md`): its batches replayed on the app's device in the order the program posted
//! them (`widget_wire::GpuHost`), its canvases presented into the app's surfaces, the live input's `gpu`, canvas
//! sizes, and device loss. All but [`RunGpu::attach`] and the loss callbacks run on the run's thread.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use psychoscript::HostValue;
use widget_gpu::{Arg, ErrorKind, Gpu, GpuError, Stops};

use super::device::{self, Dev};
use super::present::{Frame, Surfaces};
use super::{GpuCanvasState, GpuErrorKind, GpuStats, GpuSurface};
use crate::{LiveContext, LiveSurfaces};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What waits for a new device after a loss, to replay in order.
enum Held {
    Batch(Vec<Arg>, Vec<u8>),
    Shape(Option<Vec<Arg>>, String),
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
    /// Each canvas's version last presented.
    versions: HashMap<String, u64>,
    /// After a loss, until the new device (or until the first device is made): what the program posts meanwhile.
    held: Option<Vec<Held>>,
    /// The program was told it has a GPU while the device was still being made.
    waiting: bool,
}

/// A widget run's GPU.
pub(crate) struct RunGpu {
    ctx: LiveContext,
    surfaces: Arc<Surfaces>,
    state: Mutex<State>,
    /// The sizes sent to the program, by canvas key (from [`RunGpu::attach`], on the app's thread).
    sent: Mutex<HashMap<String, (u32, u32)>>,
    loss: Mutex<Option<(String, String)>>,
    replaced: AtomicBool,
}

impl RunGpu {
    /// A run's GPU: its device is made from now on, off the run's thread, unless it is already.
    pub(crate) fn new(ctx: LiveContext) -> Arc<RunGpu> {
        device::prepare();
        let run = Arc::new(RunGpu {
            ctx,
            surfaces: Arc::default(),
            state: Mutex::default(),
            sent: Mutex::default(),
            loss: Mutex::new(None),
            replaced: AtomicBool::new(false),
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

    fn stopped(&self, e: &GpuError) {
        let kind = match e.kind {
            ErrorKind::Program => GpuErrorKind::Program,
            ErrorKind::Client => GpuErrorKind::Client,
        };
        let state = |report: bool| GpuCanvasState::Stopped {
            kind,
            message: e.message.clone(),
            report: report && kind == GpuErrorKind::Program,
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

    /// The live input's `gpu`: `{ available, format }`, at once: while the device is still being made, what the
    /// program posts waits for it. Without a device, every GPU canvas shows its placeholder.
    pub(crate) fn input(&self) -> HostValue {
        let mut st = lock(&self.state);
        if st.gpu.is_none() && !st.waiting {
            match device::ready() {
                Some(Ok(_)) => {
                    let _ = self.start(&mut st);
                }
                Some(Err(_)) => {}
                None => {
                    if device::format().is_ok() {
                        st.waiting = true;
                        st.held = Some(Vec::new());
                    }
                }
            }
        }
        let available = st.gpu.is_some() || st.waiting;
        let format = match &st.gpu {
            Some(gpu) => gpu.preferred_format(),
            None => device::format().unwrap_or("rgba8unorm"),
        };
        drop(st);
        if !available {
            self.tell(None, GpuCanvasState::Unavailable);
        }
        HostValue::Object(vec![
            ("available".into(), HostValue::Bool(available)),
            ("format".into(), HostValue::String(format.into())),
        ])
    }

    /// The greatest handle the program made, for a snapshot.
    pub(crate) fn last_handle(&self) -> u64 {
        lock(&self.state).gpu.as_ref().map_or(0, Gpu::last_handle)
    }

    /// A run restored from a snapshot whose program made handles up to `last` and drew `keys`: a new device for it,
    /// which to the program is a device loss.
    pub(crate) fn restored(&self, last: u64, keys: Vec<String>) {
        let mut st = lock(&self.state);
        for k in &keys {
            st.sizes.entry(k.clone()).or_insert((0, 0));
        }
        if last == 0 || self.start(&mut st).is_err() {
            st.keys = keys;
            return;
        }
        let gpu = st.gpu.as_mut().expect("started");
        gpu.restored(last);
        for k in &keys {
            gpu.resize(k, 0, 0);
        }
        st.keys = keys;
        drop(st);
        self.ctx.deliver(lost_message("unknown", ""));
    }

    /// What waits on the run's thread: a device loss and its new device, a surface that failed.
    pub(crate) fn due(&self) {
        if let Some((reason, message)) = lock(&self.loss).take() {
            let mut st = lock(&self.state);
            if st.gpu.is_some() {
                st.held.get_or_insert_with(Vec::new);
                st.versions.clear();
                drop(st);
                self.surfaces.clear();
                self.ctx.deliver(lost_message(&reason, &message));
                self.tell(None, GpuCanvasState::Lost);
            }
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
            (None, _) => Err(widget_gpu::GpuError {
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
                // was still being made) loses it, as on a device loss; after a loss it was told already.
                if first {
                    self.ctx.deliver(lost_message("unknown", &e.message));
                }
                return self.tell(None, GpuCanvasState::Unavailable);
            }
        }
        for h in held {
            match h {
                Held::Batch(ops, bytes) => self.batch_in(st, &ops, &bytes),
                Held::Shape(ops, message) => self.shape_in(st, ops.as_deref(), message),
                Held::EndFrame => {
                    if let Some(g) = st.gpu.as_mut() {
                        g.end_frame();
                    }
                }
                Held::Canvases(keys) => canvases_in(st, &keys),
                Held::Resize(key, w, h) => resize_in(st, &key, w, h),
            }
        }
    }

    /// A batch of the wrong shape (`widget_wire::GpuHost::shape_error`): it stops canvases; nothing replays.
    fn shape_in(&self, st: &mut State, ops: Option<&[Arg]>, message: String) {
        let Some(gpu) = st.gpu.as_mut() else { return };
        if let Err(e) = gpu.shape_error(ops, message) {
            self.stopped(&e);
        }
    }

    fn batch_in(&self, st: &mut State, ops: &[Arg], bytes: &[u8]) {
        let Some(gpu) = st.gpu.as_mut() else { return };
        let started = std::time::Instant::now();
        let submits = device::submits();
        let applied = gpu.apply(ops, bytes);
        drop(submits);
        (self.surfaces.stats()).replayed(started.elapsed().as_secs_f64() * 1e6);
        if let Err(e) = applied {
            // wgpu tells of a loss as the device is next used: an error then is the loss's, not the program's, and
            // the batch waits for the new device.
            if let Some(dev) = &st.dev {
                let _ = dev.device.poll(wgpu::PollType::Poll);
            }
            if lock(&self.loss).is_some() {
                let held = Held::Batch(ops.to_vec(), bytes.to_vec());
                st.held.get_or_insert_with(Vec::new).push(held);
                return;
            }
            self.stopped(&e);
        }
        self.present(st);
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
            let seen = st.versions.insert(key.clone(), c.version);
            if seen == Some(c.version) {
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
            if seen.is_none() {
                self.tell(Some(key), GpuCanvasState::Live);
            }
        }
    }

    /// The run ends (not stopped by the app): what waits for a device (the first, or a new one after a loss) replays
    /// on it now, so the program's errors are checked and told before the end.
    pub(crate) fn finish(&self) {
        if lock(&self.state).held.is_some() {
            let _ = device::get();
            self.replaced.store(false, Ordering::SeqCst);
            self.replace();
        }
    }

    /// The run ended: its device resources and surfaces go.
    pub(crate) fn ended(&self) {
        let mut st = lock(&self.state);
        st.gpu = None;
        st.dev = None;
        st.held = None;
        drop(st);
        self.surfaces.stop();
    }

    /// The `widget_wire::GpuHost` for the run's posts.
    pub(crate) fn host(self: &Arc<Self>) -> Box<dyn widget_wire::GpuHost> {
        Box::new(Host(self.clone()))
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

struct Host(Arc<RunGpu>);

impl widget_wire::GpuHost for Host {
    fn batch(&mut self, ops: &[Arg], bytes: &[u8]) {
        let mut st = lock(&self.0.state);
        if let Some(held) = st.held.as_mut() {
            held.push(Held::Batch(ops.to_vec(), bytes.to_vec()));
            return;
        }
        self.0.batch_in(&mut st, ops, bytes);
    }

    fn shape_error(&mut self, ops: Option<&[Arg]>, message: String) {
        let mut st = lock(&self.0.state);
        if let Some(held) = st.held.as_mut() {
            held.push(Held::Shape(ops.map(<[Arg]>::to_vec), message));
            return;
        }
        self.0.shape_in(&mut st, ops, message);
    }

    fn end_frame(&mut self) {
        let mut st = lock(&self.0.state);
        let st = &mut *st;
        match (st.held.as_mut(), st.gpu.as_mut()) {
            (Some(held), _) => held.push(Held::EndFrame),
            (None, Some(gpu)) => gpu.end_frame(),
            (None, None) => {}
        }
    }

    fn canvases(&mut self, keys: &[String]) {
        let mut st = lock(&self.0.state);
        match st.held.as_mut() {
            Some(held) => held.push(Held::Canvases(keys.to_vec())),
            None => canvases_in(&mut st, keys),
        }
    }

    fn resize(&mut self, key: &str, width: u32, height: u32) {
        let mut st = lock(&self.0.state);
        match st.held.as_mut() {
            Some(held) => held.push(Held::Resize(key.to_owned(), width, height)),
            None => resize_in(&mut st, key, width, height),
        }
    }
}

impl device::Loss for RunGpu {
    fn lost(&self, reason: &str, message: &str) {
        *lock(&self.loss) = Some((reason.to_owned(), message.to_owned()));
        self.ctx.wake();
    }

    fn replaced(&self) {
        self.replaced.store(true, Ordering::SeqCst);
        self.ctx.wake();
    }
}

impl LiveSurfaces for RunGpu {
    fn attach(&self, key: String, surface: Arc<GpuSurface>, width: u32, height: u32) {
        let size = widget_gpu::clamp_size(width.max(1), height.max(1));
        let changed = lock(&self.sent).insert(key.clone(), size) != Some(size);
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

    fn stats(&self) -> GpuStats {
        self.surfaces.stats().clone()
    }

    fn pixels(&self, key: &str) -> Option<(u32, u32, Vec<u8>)> {
        self.surfaces.pixels(key)
    }
}
