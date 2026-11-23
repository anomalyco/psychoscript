//! OpenCode widgets' GPU canvases (opencode `specs/v2/widgets-gpu.md`): replays a live program's WebGPU batches on a
//! `wgpu` device. Host-agnostic: Rune shares its own device, psychoscript-mobile makes one (Metal, Vulkan).
//!
//! One [`Gpu`] per widget run. The host:
//! - calls [`Gpu::resize`] for each `gpu: true` canvas of the last render posted, when it sends the program that
//!   canvas's size (`{ type: "canvas", key, width, height }`, the size from [`clamp_size`]), and [`Gpu::remove`] for
//!   one that left the view;
//! - calls [`Gpu::apply`] with each batch's ops and bytes, and [`Gpu::end_frame`] at each frame request, after the
//!   batch it carries;
//! - shows [`Gpu::canvas`]'s texture for each GPU canvas, presenting again when its `version` moves;
//! - on an `Err`, shows the placeholder with the error on the canvases it stops ([`GpuError::canvases`]) and
//!   reports it (phase [`PHASE`]) when it is the program's ([`ErrorKind::Program`]), else logs it. [`Gpu::error`]
//!   gives a canvas's;
//! - on a device loss, gets a new device, calls [`Gpu::reset`] and sends the program `{ type: "gpu", lost }`.
//!
//! A batch first gets the host checks (exact messages, as `packages/widget/src/gpu.ts`); one that passes is
//! replayed, and a WebGPU validation error from that is in wgpu's words. [`Shorthand`] runs a `wgsl` canvas on the
//! same path.
//!
//! Each canvas is a texture the crate owns at the canvas's size, which the host composites: Rune samples it in its
//! own frame, mobile copies it into its surface texture when it presents. Replay never waits on a surface.

mod check;
mod desc;
mod replay;
mod shorthand;

use std::collections::HashMap;
use std::future::Future;
use std::hash::{BuildHasherDefault, Hasher};
use std::task::{Context, Poll, Waker};

use check::{Checks, Failed};
pub use shorthand::{HEADER, Shorthand, Uniforms};
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

fn check_device(device: &wgpu::Device, format: wgpu::TextureFormat) -> Result<(), GpuError> {
    if !matches!(
        format,
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
    ) {
        return Err(client(format!("{format:?} is not a canvas format")));
    }
    let mut low = Vec::new();
    device_limits().check_limits_with_fail_fn(&device.limits(), false, |name, _, _| low.push(name));
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
        })
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
    /// a canvas an error stopped stays stopped. A batch the program posted before it learned of the loss is dropped
    /// quietly: one whose first failure is `no handle <h>`, `h` from 1 to the greatest handle made before the loss.
    /// Canvas sizes are kept.
    pub fn reset(&mut self, device: wgpu::Device, queue: wgpu::Queue) -> Result<(), GpuError> {
        check_device(&device, self.format)?;
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
        let checked = self
            .checks
            .batch(ops, bytes.len(), &|k| present.contains(&k));
        let failed = match checked {
            Err(Failed::Stale) => return Ok(()),
            Err(Failed::Message(m)) => Some((ErrorKind::Program, m)),
            Ok(()) => self.replay(ops, bytes).err(),
        };
        match failed {
            None => Ok(()),
            Some((kind, message)) => self.stop(keys, kind, message),
        }
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
