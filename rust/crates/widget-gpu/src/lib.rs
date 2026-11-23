//! OpenCode widgets' GPU canvases (opencode `specs/v2/widgets-gpu.md`): replays a live program's WebGPU batches on a
//! `wgpu` device. Host-agnostic: Rune shares its own device, psychoscript-mobile makes one (Metal, Vulkan).
//!
//! One [`Gpu`] per widget run. The host:
//! - calls [`Gpu::resize`] for each `gpu: true` canvas of the last render posted, when it sends the program that
//!   canvas's size (`{ type: "canvas", key, width, height }`, the size from [`clamp_size`]), and [`Gpu::remove`] for
//!   one that left the view;
//! - calls [`Gpu::apply`] with each batch's ops and bytes, and [`Gpu::end_frame`] at each frame request, after the
//!   batch it carries;
//! - calls [`Gpu::shape_error`] instead for a posted batch its conversion rejects (not an object, ops not a list,
//!   bytes not an `ArrayBuffer`);
//! - shows [`Gpu::canvas`]'s texture for each GPU canvas, presenting again when its `version` moves;
//! - on an `Err`, shows the placeholder with the error on the canvases it stops ([`GpuError::canvases`]) and
//!   reports it (phase [`PHASE`]) when it is the program's ([`ErrorKind::Program`]), else logs it. [`Gpu::error`]
//!   gives a canvas's;
//! - calls [`Gpu::poll`] each display frame, to stop the canvases of GPU work that hangs (`widgets-gpu.md`, GPU hang);
//! - on a device loss, calls [`Gpu::lost`] at once, then with a new device [`Gpu::reset`], and sends the program
//!   `{ type: "gpu", lost }`.
//!
//! A batch first gets the host checks (exact messages, as `packages/widget/src/gpu.ts`); one that passes is
//! replayed, and a WebGPU validation error from that is in wgpu's words. [`Shorthand`] runs a `wgsl` canvas on the
//! same path.
//!
//! Each canvas is a texture the crate owns at the canvas's size, which the host composites: Rune samples it in its
//! own frame, mobile copies it into its surface texture when it presents. Replay never waits on a surface.

mod check;
mod desc;
mod hang;
mod replay;
mod shorthand;

use std::collections::HashMap;
use std::future::Future;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Instant;

use check::{Checks, Failed};
pub use hang::{HANG, HANG_MESSAGE, STRIKE_WINDOW};
pub use shorthand::{HEADER, SLOW_FRAME, SLOW_FRAMES, SLOW_MESSAGE, Shorthand, Uniforms};
pub use widget_wire::Arg;

/// The phase a program's [`GpuError`] is reported in.
pub const PHASE: &str = "gpu";

/// The device limits the program sees (`device.limits`): WebGPU's defaults but `maxTextureDimension2D` and
/// `maxBufferSize`. A host that makes its own device requests these, so wgpu enforces every limit. A shared device
/// may have more: the host checks enforce the texture and buffer limits, replay the offset alignments, and wgpu the
/// rest against the device's own.
pub fn device_limits() -> wgpu::Limits {
    wgpu::Limits {
        max_texture_dimension_2d: check::DIMENSION as u32,
        max_buffer_size: check::BUFFER as u64,
        ..wgpu::Limits::default()
    }
}

/// A canvas's backing size (`widgets-gpu.md`, Canvas size): its physical pixels, or when the larger side is over
/// `maxTextureDimension2D` (4096), that side 4096 and the other ⌊side × 4096 / larger⌋, at least 1. The host sends
/// the program this size and passes it to [`Gpu::resize`].
pub fn clamp_size(width: u32, height: u32) -> (u32, u32) {
    let max = check::DIMENSION as u32;
    let long = width.max(height);
    if long <= max {
        return (width, height);
    }
    let fit = |side: u32| (side as u64 * max as u64 / long as u64).max(1) as u32;
    (fit(width), fit(height))
}

/// The canvas format a backend's surfaces prefer: what the host passes as the live input's `gpu.format`.
pub fn preferred_format(backend: wgpu::Backend) -> wgpu::TextureFormat {
    match backend {
        wgpu::Backend::Metal | wgpu::Backend::Dx12 => wgpu::TextureFormat::Bgra8Unorm,
        _ => wgpu::TextureFormat::Rgba8Unorm,
    }
}

/// Whose error it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// The program's (phase [`PHASE`]): report it once, show the placeholder with it.
    Program,
    /// The client's (out of GPU memory, a driver failure): log it, show the placeholder.
    Client,
}

/// Why canvases stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuError {
    pub kind: ErrorKind,
    pub message: String,
    pub canvases: Stops,
}

/// The canvases an error stops.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stops {
    /// The ones its batch renders into (a pass's color attachment is a view of their texture), not stopped before.
    Canvases(Vec<String>),
    /// Every GPU canvas of the widget, and later batches are ignored: its batch renders into none.
    All,
}

/// The canvases errors stopped, to keep with a snapshot of the run ([`Gpu::saved_stops`]) and give the restored
/// run ([`Gpu::restore_stops`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SavedStops {
    /// The error that stopped every canvas, if one did.
    pub all: Option<SavedStop>,
    /// The canvases errors stopped, by key, in key order.
    pub canvases: Vec<(String, SavedStop)>,
}

/// An error that stopped canvases, as a snapshot keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedStop {
    pub kind: ErrorKind,
    pub message: String,
}

impl std::fmt::Display for GpuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GpuError {}

/// `context.configure`'s `alphaMode`: how the host composites the canvas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlphaMode {
    /// Alpha is ignored: the canvas is opaque.
    Opaque,
    /// Colors are premultiplied by alpha.
    Premultiplied,
}

/// A canvas's texture, to composite.
#[derive(Clone, Copy, Debug)]
pub struct Canvas<'a> {
    /// The canvas's current texture: its size the last [`Gpu::resize`] when last rendered, `RENDER_ATTACHMENT |
    /// TEXTURE_BINDING | COPY_SRC`, in the format the program configured.
    pub texture: &'a wgpu::Texture,
    pub alpha: AlphaMode,
    /// Moves each time a submitted render pass wrote to it: present when it changed.
    pub version: u64,
}

/// A widget run's GPU: its resources by handle and its canvases.
pub struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: wgpu::TextureFormat,
    checks: Checks,
    res: HashMap<u32, Res, BuildHasherDefault<Ids>>,
    canvases: Vec<Target>,
    /// Canvases an error stopped, by key, and the error that stopped them all.
    stopped: HashMap<String, GpuError>,
    all: Option<GpuError>,
    /// The batches' GPU work not known finished, with the canvases each draws into, and whether it was found hung.
    submits: Vec<Tracked>,
    /// Whether the batch being replayed submitted work.
    submitted: bool,
    /// Device losses while the run's GPU work was in flight, and whether work finished since the last.
    strikes: hang::Strikes,
    /// A hang found as the device was lost, for the next [`Gpu::poll`].
    hung: Option<GpuError>,
    /// The device is lost (until [`Gpu::reset`]).
    lost: bool,
}

enum Res {
    Buffer(wgpu::Buffer),
    Texture(wgpu::Texture),
    View(View),
    Sampler(wgpu::Sampler),
    Shader(wgpu::ShaderModule),
    BindGroupLayout(wgpu::BindGroupLayout),
    PipelineLayout(wgpu::PipelineLayout),
    Pipeline(wgpu::RenderPipeline),
    BindGroup(wgpu::BindGroup),
    /// A canvas's current texture (an index into `canvases`).
    Context(usize),
}

enum View {
    Texture(wgpu::TextureView),
    /// A view of a canvas's current texture, made again when that texture is.
    Canvas {
        canvas: usize,
        desc: wgpu::TextureViewDescriptor<'static>,
        made: Option<(u64, wgpu::TextureView)>,
    },
}

struct Target {
    key: String,
    /// In the last render posted.
    present: bool,
    width: u32,
    height: u32,
    /// Set by the program's `context` op.
    format: Option<wgpu::TextureFormat>,
    alpha: AlphaMode,
    texture: Option<wgpu::Texture>,
    /// No pass has drawn into it since the frame began: the next one starts from transparent.
    fresh: bool,
    /// Counts textures made, for views of it.
    made: u64,
    version: u64,
}

impl Target {
    fn texture(&mut self, device: &wgpu::Device) -> Option<&wgpu::Texture> {
        let format = self.format?;
        if self.width == 0 || self.height == 0 {
            return None;
        }
        let fits = self.texture.as_ref().is_some_and(|t| {
            t.width() == self.width && t.height() == self.height && t.format() == format
        });
        if !fits {
            self.texture = Some(device.create_texture(&wgpu::TextureDescriptor {
                label: Some("canvas"),
                size: wgpu::Extent3d {
                    width: self.width,
                    height: self.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            }));
            self.made += 1;
        }
        self.texture.as_ref()
    }
}

/// Handles are small sequential integers: one multiply spreads them.
#[derive(Default)]
struct Ids(u64);

impl Hasher for Ids {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }
    fn write_u32(&mut self, n: u32) {
        self.0 = (n as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}

/// What a future resolves to at once, as wgpu's error scopes do on native.
fn now<T>(f: impl Future<Output = T>) -> Option<T> {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => Some(v),
        Poll::Pending => None,
    }
}

/// wgpu's validation message on one line: its error and the chain of causes under it, a WGSL error's source
/// snippet as its line and column.
fn message(description: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut at = None;
    for line in description.lines().map(str::trim) {
        if let Some(l) = line.strip_prefix("┌─ ") {
            let mut n = l.rsplit(':');
            if let (Some(column), Some(line)) = (n.next(), n.next()) {
                at.get_or_insert((line, column));
            }
            continue;
        }
        let snippet = line.starts_with(['│', '└', '·'])
            || line
                .split_once('│')
                .is_some_and(|(n, _)| n.trim().bytes().all(|b| b.is_ascii_digit()));
        let line = line.strip_prefix("= ").unwrap_or(line);
        if line.is_empty()
            || line == "Caused by:"
            || line == "Validation Error"
            || snippet
            || parts.contains(&line)
        {
            continue;
        }
        parts.push(line);
    }
    let mut out = parts.join(": ").replace("Shader '' ", "Shader ");
    if let Some((line, column)) = at {
        out.push_str(&format!(" (WGSL line {line}, column {column})"));
    }
    out
}

fn gpu_error(e: wgpu::Error) -> (ErrorKind, String) {
    match e {
        wgpu::Error::Validation { description, .. } => (ErrorKind::Program, message(&description)),
        wgpu::Error::OutOfMemory { .. } => (ErrorKind::Client, "out of GPU memory".into()),
        wgpu::Error::Internal { description, .. } => (ErrorKind::Client, message(&description)),
    }
}

fn client(message: String) -> GpuError {
    GpuError {
        kind: ErrorKind::Client,
        message,
        canvases: Stops::All,
    }
}

/// Polls `device` without waiting; false when it is lost. wgpu panics in `Device::poll` on a lost device (`Error in
/// Device::poll: ...`): that panic is the loss, not the host's crash. Any other panic goes on.
pub(crate) fn poll(device: &wgpu::Device) -> bool {
    caught(|| device.poll(wgpu::PollType::Poll))
}

fn caught(poll: impl FnOnce() -> Result<wgpu::PollStatus, wgpu::PollError>) -> bool {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(poll)) {
        Ok(_) => true,
        Err(panic) => {
            let message = (panic.downcast_ref::<String>().map(String::as_str))
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .unwrap_or("");
            if message.starts_with("Error in Device::poll") {
                return false;
            }
            std::panic::resume_unwind(panic)
        }
    }
}

/// A batch's GPU work being watched for a hang: the canvases it draws into, and whether its hang was found.
struct Tracked {
    submit: Arc<hang::Submit>,
    keys: Vec<String>,
    reported: bool,
}

fn check_device(device: &wgpu::Device, format: wgpu::TextureFormat) -> Result<(), GpuError> {
    if !matches!(
        format,
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
    ) {
        return Err(client(format!("{format:?} is not a canvas format")));
    }
    let mut low = Vec::new();
    device_limits().check_limits_with_fail_fn(&device.limits(), false, |name, _, _| low.push(name));
    // The iOS Simulator's GPU is under some of them (`max_inter_stage_shader_variables` 15): there a host requests
    // the adapter's where they fall short, and a program over them gets wgpu's validation error. Real devices keep
    // the check (decided as the crate is built).
    if cfg!(all(target_os = "ios", target_abi = "sim")) {
        low.clear();
    }
    if !low.is_empty() {
        return Err(client(format!(
            "the device's limits are under the spec's: {}",
            low.join(", ")
        )));
    }
    Ok(())
}

impl Gpu {
    /// A widget run's GPU on `device`, its canvases in `format` (`Bgra8Unorm` or `Rgba8Unorm`, see
    /// [`preferred_format`]). Fails (a client error) when the device's limits are under [`device_limits`].
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        format: wgpu::TextureFormat,
    ) -> Result<Gpu, GpuError> {
        check_device(&device, format)?;
        Ok(Gpu {
            device,
            queue,
            format,
            checks: Checks::default(),
            res: HashMap::default(),
            canvases: Vec::new(),
            stopped: HashMap::new(),
            all: None,
            submits: Vec::new(),
            submitted: false,
            strikes: hang::Strikes::default(),
            hung: None,
            lost: false,
        })
    }

    pub(crate) fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub(crate) fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    /// The live input's `gpu.format`: `"bgra8unorm"` or `"rgba8unorm"`.
    pub fn preferred_format(&self) -> &'static str {
        match self.format {
            wgpu::TextureFormat::Bgra8Unorm => "bgra8unorm",
            _ => "rgba8unorm",
        }
    }

    /// The error that stopped the canvas with that key. A canvas an error stopped stays stopped for the run: after
    /// [`Gpu::remove`] and a later [`Gpu::resize`] under the same key, and after [`Gpu::reset`].
    pub fn error(&self, key: &str) -> Option<&GpuError> {
        self.stopped.get(key).or(self.all.as_ref())
    }

    /// Bytes of buffers and textures the program holds, as the limits count them.
    pub fn memory(&self) -> u64 {
        self.checks.resources as u64
    }

    /// A `gpu: true` canvas of the last render posted, and its size in physical pixels: call it when sending the
    /// program its `canvas` message (after applying every batch posted before). Passes into a canvas 0 wide or
    /// high are skipped.
    pub fn resize(&mut self, key: &str, width: u32, height: u32) {
        let t = self.target(key);
        t.present = true;
        t.width = width;
        t.height = height;
    }

    /// A canvas that left the view: `context` ops can't name it, passes into it are skipped.
    pub fn remove(&mut self, key: &str) {
        if let Some(t) = self.canvases.iter_mut().find(|t| t.key == key) {
            t.present = false;
            t.width = 0;
            t.height = 0;
        }
    }

    /// The canvas with that key, once a render pass has drawn to it.
    pub fn canvas(&self, key: &str) -> Option<Canvas<'_>> {
        let t = self.canvases.iter().find(|t| t.key == key)?;
        Some(Canvas {
            texture: t.texture.as_ref()?,
            alpha: t.alpha,
            version: t.version,
        })
    }

    /// After a device loss: every handle is gone, replay goes on with `device`; new handles keep counting up. The
    /// canvases the loss stopped (every canvas's texture is dropped) draw again once the program renders into them;
    /// a canvas an error or a GPU hang stopped stays stopped, and so does a run two strikes stopped ([`Gpu::lost`],
    /// which it calls if the host didn't). A batch the program posted before it learned of the loss is dropped quietly: one
    /// whose first failure is `no handle <h>`, `h` from 1 to the greatest handle made before the loss. Canvas sizes
    /// are kept.
    pub fn reset(&mut self, device: wgpu::Device, queue: wgpu::Queue) -> Result<(), GpuError> {
        check_device(&device, self.format)?;
        self.lost();
        self.lost = false;
        self.device = device;
        self.queue = queue;
        self.res.clear();
        self.checks.lost();
        for t in &mut self.canvases {
            t.format = None;
            t.texture = None;
        }
        Ok(())
    }

    /// The greatest handle the program has made: what a snapshot of the run keeps, for [`Gpu::restored`].
    pub fn last_handle(&self) -> u64 {
        self.checks.last() as u64
    }

    /// A run restored from a snapshot, whose program had made handles up to `last` ([`Gpu::last_handle`]): as after a
    /// device loss, those handles are gone and a batch naming one is dropped quietly. Its stopped canvases come back
    /// with [`Gpu::restore_stops`].
    pub fn restored(&mut self, last: u64) {
        self.checks.made(last as f64);
        self.checks.lost();
    }

    /// The canvases errors stopped, for a snapshot of the run.
    pub fn saved_stops(&self) -> SavedStops {
        let saved = |e: &GpuError| SavedStop {
            kind: e.kind,
            message: e.message.clone(),
        };
        let mut canvases: Vec<_> = (self.stopped.iter())
            .map(|(k, e)| (k.clone(), saved(e)))
            .collect();
        canvases.sort_by(|a, b| a.0.cmp(&b.0));
        SavedStops {
            all: self.all.as_ref().map(saved),
            canvases,
        }
    }

    /// A run restored from a snapshot keeps the canvases errors stopped ([`Gpu::saved_stops`]), with their errors:
    /// they stay stopped, [`Gpu::error`] gives their errors, and they are never reported again. Call it with
    /// [`Gpu::restored`].
    pub fn restore_stops(&mut self, stops: SavedStops) {
        let error = |s: SavedStop, canvases| GpuError {
            kind: s.kind,
            message: s.message,
            canvases,
        };
        for (key, s) in stops.canvases {
            let e = error(s, Stops::Canvases(vec![key.clone()]));
            self.stopped.insert(key, e);
        }
        if let Some(s) = stops.all {
            self.all = Some(error(s, Stops::All));
        }
    }

    /// A frame request (`widget.frame()`), with a batch or without, after applying the batch: the per-frame limits
    /// count again, and the canvases are cleared to transparent for the next frame. The texture is kept, so the clear
    /// happens at the frame's first pass into each canvas (its load becomes a transparent clear): a frame with no
    /// pass into a canvas leaves the last presented image showing.
    pub fn end_frame(&mut self) {
        self.checks.end_frame();
        for t in &mut self.canvases {
            t.fresh = true;
        }
    }

    /// Checks and replays a batch: its creation ops, writes and submitted commands, in order. An error ends the
    /// batch and stops canvases ([`Stops`]); one that would only stop canvases already stopped isn't returned again.
    /// What stopped canvases draw isn't replayed: a pass into one (up to its `end`; the batch's other canvases draw),
    /// or the whole batch when every canvas it renders into is stopped, as the web host does.
    pub fn apply(&mut self, ops: &[Arg], bytes: &[u8]) -> Result<(), GpuError> {
        if self.all.is_some() {
            return Ok(());
        }
        let keys = self.checks.rendered(ops);
        let present: Vec<&str> = self
            .canvases
            .iter()
            .filter(|t| t.present)
            .map(|t| t.key.as_str())
            .collect();
        // Every canvas it renders into was stopped: none of it replays, its passes into other textures included (a
        // hung canvas's heavy work never runs again).
        let skip = !keys.is_empty() && keys.iter().all(|k| self.stopped.contains_key(k));
        let checked = self
            .checks
            .batch(ops, bytes.len(), &|k| present.contains(&k));
        // A batch that fails at an op stops its canvases, and the ops before it take effect, as separate calls would
        // (what it created and wrote, what it submitted); a pass or encoder open at the failure isn't submitted.
        let (count, checked) = match checked {
            Ok(()) => (ops.len(), Ok(())),
            Err(Failed::Stale) => return Ok(()),
            Err(Failed::Message(m, None)) => return self.stop(keys, ErrorKind::Program, m),
            Err(Failed::Message(m, Some(count))) => {
                (count, self.stop(keys.clone(), ErrorKind::Program, m))
            }
        };
        if skip {
            return checked;
        }
        self.submitted = false;
        let replayed = self.replay(&ops[..count], bytes).err();
        if self.submitted {
            self.submits.push(Tracked {
                submit: hang::submitted(&self.queue),
                keys: keys.clone(),
                reported: false,
            });
        }
        let replayed = match replayed {
            None => Ok(()),
            Some((kind, message)) => self.stop(keys, kind, message),
        };
        checked.and(replayed)
    }

    /// Watches the batches' GPU work for a hang (`widgets-gpu.md`, GPU hang): work still unfinished 250 ms after its
    /// submit stops the canvases its batch draws into, or every canvas when it draws into none, for the rest of the
    /// run, with a client error ([`HANG_MESSAGE`]). Call it often, as each display frame: it never waits. A hang is
    /// returned once; one that would only stop canvases already stopped isn't returned.
    pub fn poll(&mut self) -> Result<(), GpuError> {
        if let Some(e) = self.hung.take() {
            return Err(e);
        }
        if self.submits.is_empty() || self.lost {
            return Ok(());
        }
        if !poll(&self.device) {
            self.lost();
            return self.hung.take().map_or(Ok(()), Err);
        }
        self.hangs(HANG)
    }

    /// The device is lost: call it as soon as the host knows, before [`Gpu::reset`] (which calls it if the host
    /// didn't, and [`Gpu::poll`] does when it finds the device lost). A loss while the run's GPU work is in flight
    /// (submitted, not seen finished) is a strike if some of its work finished on a device (its
    /// `on_submitted_work_done` fired) since the last strike or the run's start: losses in a row with none in between
    /// are one reset, one strike. The second strike within [`STRIKE_WINDOW`] stops every canvas of the run for the
    /// rest of the run, with [`HANG_MESSAGE`], and the next [`Gpu::poll`] returns the error. A first strike, or a loss
    /// that is none, changes nothing visible.
    pub fn lost(&mut self) {
        self.lost_at(Instant::now());
    }

    /// Test hook (feature `test-hooks`): the run's GPU work finished on the current device, as an
    /// `on_submitted_work_done` that fired tells [`Gpu::lost`]. For a fixture's driver, which may need work finished
    /// and work in flight at a loss that followed one submit.
    #[cfg(feature = "test-hooks")]
    #[doc(hidden)]
    pub fn work_finished(&mut self) {
        self.strikes.finished();
    }

    /// [`Gpu::lost`], the loss at `now` (a test's clock).
    pub fn lost_at(&mut self, now: Instant) {
        if self.lost {
            return;
        }
        self.lost = true;
        let in_flight = self.submits.iter().any(|t| !t.submit.done());
        if self.submits.iter().any(|t| t.submit.done()) {
            self.strikes.finished();
        }
        for t in self.submits.drain(..) {
            t.submit.forget();
        }
        if in_flight
            && self.strikes.strike(now)
            && self.all.is_none()
            && let Err(e) = self.stop(Vec::new(), ErrorKind::Client, HANG_MESSAGE.into())
        {
            self.hung = Some(e);
        }
    }

    /// Finds hung work: unfinished `after` its submit.
    fn hangs(&mut self, after: std::time::Duration) -> Result<(), GpuError> {
        if self.submits.is_empty() {
            return Ok(());
        }
        hang::judge(&self.queue, after);
        let mut keys: Vec<String> = Vec::new();
        let (mut found, mut none) = (false, false);
        for t in &mut self.submits {
            if t.submit.hung() && !t.reported {
                t.reported = true;
                found = true;
                none |= t.keys.is_empty();
                keys.extend(t.keys.iter().cloned());
            }
        }
        let before = self.submits.len();
        self.submits.retain(|t| !t.submit.done());
        if self.submits.len() < before {
            self.strikes.finished();
        }
        if !found || self.all.is_some() {
            return Ok(());
        }
        if none {
            keys.clear();
        }
        keys.sort();
        keys.dedup();
        self.stop(keys, ErrorKind::Client, HANG_MESSAGE.into())
    }

    /// A posted batch whose shape the host's conversion rejected, with the spec's message (`a batch must be an
    /// object`, `a batch's ops must be a list`, `a batch's bytes must be an ArrayBuffer`): it stops canvases as
    /// [`Gpu::apply`]'s errors do. `ops`: the batch's ops when they are a list (they decide which canvases it renders
    /// into), else `None`, which stops every canvas. Nothing is replayed.
    pub fn shape_error(
        &mut self,
        ops: Option<&[Arg]>,
        message: impl Into<String>,
    ) -> Result<(), GpuError> {
        if self.all.is_some() {
            return Ok(());
        }
        let keys = ops.map(|ops| self.checks.rendered(ops)).unwrap_or_default();
        self.stop(keys, ErrorKind::Program, message.into())
    }

    /// Stops the canvases `keys` (those the batch renders into), or all of them when it renders into none.
    fn stop(
        &mut self,
        keys: Vec<String>,
        kind: ErrorKind,
        message: String,
    ) -> Result<(), GpuError> {
        if !keys.is_empty() {
            let fresh: Vec<String> = keys
                .into_iter()
                .filter(|k| !self.stopped.contains_key(k))
                .collect();
            if fresh.is_empty() {
                return Ok(());
            }
            let e = GpuError {
                kind,
                message,
                canvases: Stops::Canvases(fresh.clone()),
            };
            for k in fresh {
                self.stopped.insert(k, e.clone());
            }
            return Err(e);
        }
        let e = GpuError {
            kind,
            message,
            canvases: Stops::All,
        };
        self.all = Some(e.clone());
        let fresh = self
            .canvases
            .iter()
            .any(|t| t.present && !self.stopped.contains_key(&t.key));
        if fresh || self.stopped.is_empty() {
            Err(e)
        } else {
            Ok(())
        }
    }

    fn target(&mut self, key: &str) -> &mut Target {
        let at = match self.canvases.iter().position(|t| t.key == key) {
            Some(at) => at,
            None => {
                self.canvases.push(Target {
                    key: key.to_owned(),
                    present: false,
                    width: 0,
                    height: 0,
                    format: None,
                    alpha: AlphaMode::Opaque,
                    texture: None,
                    fresh: true,
                    made: 0,
                    version: 0,
                });
                self.canvases.len() - 1
            }
        };
        &mut self.canvases[at]
    }
}

#[cfg(test)]
mod tests {
    use super::caught;

    /// wgpu's panic in `Device::poll` on a lost device is the loss; any other panic goes on.
    #[test]
    fn a_poll_panicking_on_a_lost_device_is_the_loss() {
        assert!(caught(|| Ok(wgpu::PollStatus::QueueEmpty)));
        assert!(caught(|| Err(wgpu::PollError::Timeout)));
        assert!(!caught(|| panic!(
            "Error in Device::poll: Parent device is lost"
        )));
        let other = std::panic::catch_unwind(|| caught(|| panic!("something else")));
        let message = other.unwrap_err().downcast::<&str>().ok().map(|m| *m);
        assert_eq!(message, Some("something else"));
    }
}
