//! Presenting canvases into the app's surfaces. A run's GPU hands each canvas's newest texture to its [`Surfaces`]
//! and goes on: a thread of the run's own presents it into the canvas's attached surface (one copy, or a scaled draw
//! when the sizes or formats differ), so a slow, hidden or detached surface never holds up the run. Presents beyond
//! one per texture are skipped; detaching waits only for a present in progress.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use super::device::{self, Dev};
use super::{GpuStats, GpuSurface};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A canvas's newest image.
#[derive(Clone)]
pub(crate) struct Frame {
    pub texture: wgpu::Texture,
    pub alpha: widget_gpu::AlphaMode,
    pub dev: Arc<Dev>,
}

/// A surface attached to a canvas, made into a wgpu surface when first presented to.
pub(crate) struct Attached {
    native: Arc<GpuSurface>,
    width: u32,
    height: u32,
    surface: Option<Made>,
}

struct Made {
    // Dropped before `Attached::native`, which it presents into.
    surface: wgpu::Surface<'static>,
    /// The configuration, the device generation it is for, and the size asked for (larger than the configuration's
    /// when the device's textures are smaller).
    config: Option<(wgpu::SurfaceConfiguration, u64, (u32, u32))>,
}

impl Attached {
    pub(crate) fn new(native: Arc<GpuSurface>, width: u32, height: u32) -> Attached {
        Attached {
            native,
            width: width.max(1),
            height: height.max(1),
            surface: None,
        }
    }

    pub(crate) fn resize(&mut self, width: u32, height: u32) {
        (self.width, self.height) = (width.max(1), height.max(1));
    }

    /// Presents `frame`: copies it into the surface's next texture (scaled when the sizes differ).
    pub(crate) fn present(&mut self, frame: &Frame, blit: &mut Blit) -> Result<Shown, String> {
        let device = &frame.dev.device;
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let shown = match self.try_present(frame, blit) {
            // The surface changed under its configuration: once more, configured anew.
            Ok(Shown::Outdated) => self.try_present(frame, blit),
            shown => shown,
        };
        let errors = [internal.pop(), memory.pop(), validation.pop()].map(device::block);
        if let Some(e) = errors.into_iter().flatten().next() {
            // Configured anew next time.
            if let Some(made) = self.surface.as_mut() {
                made.config = None;
            }
            return Err(format!("the surface failed: {e}"));
        }
        shown
    }

    fn try_present(&mut self, frame: &Frame, blit: &mut Blit) -> Result<Shown, String> {
        let dev = &frame.dev;
        if self.surface.is_none() {
            // SAFETY: `native` holds the layer or window for as long as `self` holds the surface.
            let surface = unsafe { dev.instance.create_surface_unsafe(self.native.target()) }
                .map_err(|e| format!("the surface can't be used: {e}"))?;
            self.surface = Some(Made {
                surface,
                config: None,
            });
        }
        let made = self.surface.as_mut().expect("made");
        let size = frame.texture.size();
        let configured = made.config.as_ref().is_some_and(|(c, generation, asked)| {
            *generation == dev.generation
                && *asked == (self.width, self.height)
                && c.alpha_mode == alpha_mode(&made.surface, dev, frame.alpha)
        });
        if !configured {
            let config = configure(&made.surface, dev, self.width, self.height, frame.alpha)?;
            // Checked before going on: a surface left unconfigured can't give a texture.
            let scope = dev.device.push_error_scope(wgpu::ErrorFilter::Validation);
            let submits = device::submits();
            made.surface.configure(&dev.device, &config);
            drop(submits);
            if let Some(e) = device::block(scope.pop()) {
                return Err(format!("the surface can't be configured: {e}"));
            }
            if let Some(layer) = self.native.layer() {
                drawable_timeout(layer);
            }
            made.config = Some((config, dev.generation, (self.width, self.height)));
        }
        let (config, ..) = made.config.as_ref().expect("configured");
        let target = match made.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout => return Ok(Shown::Timeout),
            wgpu::CurrentSurfaceTexture::Occluded => return Ok(Shown::Hidden),
            wgpu::CurrentSurfaceTexture::Outdated => {
                made.config = None;
                return Ok(Shown::Outdated);
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                self.surface = None;
                return Ok(Shown::Outdated);
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err("the surface's texture can't be had".into());
            }
        };
        let mut encoder = dev.device.create_command_encoder(&Default::default());
        let same = (size.width, size.height) == (config.width, config.height);
        if same
            && config.format == frame.texture.format()
            && config.usage.contains(wgpu::TextureUsages::COPY_DST)
        {
            encoder.copy_texture_to_texture(
                frame.texture.as_image_copy(),
                target.texture.as_image_copy(),
                size,
            );
        } else {
            blit.draw(
                dev,
                &mut encoder,
                &frame.texture,
                &target.texture,
                config.format,
            );
        }
        let submits = device::submits();
        dev.queue.submit([encoder.finish()]);
        drop(submits);
        dev.queue.present(target);
        Ok(Shown::Yes)
    }
}

/// How a present went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Shown {
    Yes,
    /// The surface gave no texture within its timeout: try again.
    Timeout,
    /// The surface isn't visible: nothing to show until the next image.
    Hidden,
    /// Its configuration is stale (made anew), or the surface was lost (made again).
    Outdated,
}

fn alpha_mode(
    surface: &wgpu::Surface<'_>,
    dev: &Dev,
    alpha: widget_gpu::AlphaMode,
) -> wgpu::CompositeAlphaMode {
    use wgpu::CompositeAlphaMode as M;
    let modes = surface.get_capabilities(&dev.adapter).alpha_modes;
    let want: &[M] = match alpha {
        widget_gpu::AlphaMode::Opaque => &[M::Opaque, M::Inherit, M::Auto],
        // A `CAMetalLayer` that isn't opaque composites premultiplied colors (wgpu calls it post-multiplied).
        widget_gpu::AlphaMode::Premultiplied => {
            &[M::PreMultiplied, M::PostMultiplied, M::Inherit, M::Auto]
        }
    };
    want.iter()
        .copied()
        .find(|m| modes.contains(m))
        .unwrap_or(M::Auto)
}

fn configure(
    surface: &wgpu::Surface<'_>,
    dev: &Dev,
    width: u32,
    height: u32,
    alpha: widget_gpu::AlphaMode,
) -> Result<wgpu::SurfaceConfiguration, String> {
    let caps = surface.get_capabilities(&dev.adapter);
    // A surface larger than the device's textures is configured smaller, its aspect kept: the system scales it.
    let max = dev.device.limits().max_texture_dimension_2d.max(1);
    let long = width.max(height);
    let (width, height) = match long > max {
        true => {
            let fit =
                |side: u32| ((side as u64 * max as u64) / long as u64).clamp(1, max as u64) as u32;
            (fit(width), fit(height))
        }
        false => (width, height),
    };
    // The canvas's own format, else another 8-bit one without sRGB encoding (colors are already sRGB-encoded).
    let format = [
        dev.format,
        wgpu::TextureFormat::Bgra8Unorm,
        wgpu::TextureFormat::Rgba8Unorm,
    ]
    .into_iter()
    .find(|f| caps.formats.contains(f))
    .or_else(|| caps.formats.iter().copied().find(|f| !f.is_srgb()))
    .or_else(|| caps.formats.first().copied())
    .ok_or("the surface takes no format")?;
    let mut usage = wgpu::TextureUsages::RENDER_ATTACHMENT;
    if caps.usages.contains(wgpu::TextureUsages::COPY_DST) {
        usage |= wgpu::TextureUsages::COPY_DST;
    }
    Ok(wgpu::SurfaceConfiguration {
        usage,
        format,
        color_space: wgpu::SurfaceColorSpace::Auto,
        width,
        height,
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: alpha_mode(surface, dev, alpha),
        view_formats: Vec::new(),
    })
}

/// wgpu has `nextDrawable` wait for ever; a hidden layer may never give one back. With the timeout (1 s) a present
/// gives up instead.
#[cfg(any(target_os = "ios", target_os = "macos"))]
fn drawable_timeout(layer: *mut std::ffi::c_void) {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }
    // SAFETY: `setAllowsNextDrawableTimeout:` is a `CAMetalLayer` method taking a BOOL; the layer is retained.
    unsafe {
        let set: unsafe extern "C" fn(*mut c_void, *const c_void, bool) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        set(
            layer,
            sel_registerName(c"setAllowsNextDrawableTimeout:".as_ptr()),
            true,
        );
    }
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn drawable_timeout(_layer: *mut std::ffi::c_void) {}

const BLIT: &str = "
@group(0) @binding(0) var canvas: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;
struct Out { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return Out(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
}
@fragment fn fs(o: Out) -> @location(0) vec4f { return textureSample(canvas, linear, o.uv); }
";

/// Draws a canvas into a surface texture of another size or format, filtered: one full-screen triangle.
#[derive(Default)]
pub(crate) struct Blit {
    made: Option<(
        u64,
        wgpu::BindGroupLayout,
        wgpu::Sampler,
        wgpu::ShaderModule,
    )>,
    pipelines: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
}

impl Blit {
    fn draw(
        &mut self,
        dev: &Dev,
        encoder: &mut wgpu::CommandEncoder,
        from: &wgpu::Texture,
        to: &wgpu::Texture,
        format: wgpu::TextureFormat,
    ) {
        if self
            .made
            .as_ref()
            .is_none_or(|(g, ..)| *g != dev.generation)
        {
            let d = &dev.device;
            let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("blit"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
            let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let module = d.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("blit"),
                source: wgpu::ShaderSource::Wgsl(BLIT.into()),
            });
            self.made = Some((dev.generation, layout, sampler, module));
            self.pipelines.clear();
        }
        let (_, layout, sampler, module) = self.made.as_ref().expect("made");
        let pipeline = self.pipelines.entry(format).or_insert_with(|| {
            let pl = dev
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("blit"),
                    bind_group_layouts: &[Some(layout)],
                    immediate_size: 0,
                });
            dev.device
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("blit"),
                    layout: Some(&pl),
                    vertex: wgpu::VertexState {
                        module,
                        entry_point: Some("vs"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module,
                        entry_point: Some("fs"),
                        compilation_options: Default::default(),
                        targets: &[Some(format.into())],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                })
        });
        let view = from.create_view(&Default::default());
        let group = dev.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blit"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        });
        let target = to.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// A canvas key's surface: the presenter holds it while presenting, so detaching waits for that present alone.
type Slot = Arc<Mutex<Option<Attached>>>;

#[derive(Default)]
struct Queue {
    slots: HashMap<String, Slot>,
    /// Each canvas's newest image, kept for a surface attached later.
    latest: HashMap<String, Frame>,
    /// Canvases with an image their surface hasn't shown.
    dirty: HashSet<String>,
    started: bool,
    stop: bool,
}

/// A run's surfaces and the thread that presents into them.
#[derive(Default)]
pub(crate) struct Surfaces {
    queue: Mutex<Queue>,
    wake: Condvar,
    /// Present failures, by key, for the run's thread to report.
    failed: Mutex<Vec<(String, String)>>,
    stats: Mutex<GpuStats>,
}

impl Surfaces {
    /// `surface` shows the canvas `key`, `width` × `height` physical pixels (again with a new size: resized).
    pub(crate) fn attach(
        self: &Arc<Self>,
        key: String,
        surface: Arc<GpuSurface>,
        width: u32,
        height: u32,
    ) {
        let mut q = lock(&self.queue);
        let slot = q.slots.get(&key).cloned();
        match slot {
            Some(slot) => {
                drop(q);
                let mut s = lock(&slot);
                match s.as_mut() {
                    Some(a) if Arc::ptr_eq(&a.native, &surface) => a.resize(width, height),
                    _ => *s = Some(Attached::new(surface, width, height)),
                }
                drop(s);
                q = lock(&self.queue);
            }
            None => {
                let slot = Arc::new(Mutex::new(Some(Attached::new(surface, width, height))));
                q.slots.insert(key.clone(), slot);
            }
        }
        q.dirty.insert(key);
        if !q.started {
            q.started = true;
            let me = Arc::downgrade(self);
            let spawned = std::thread::Builder::new()
                .name("psychoscript-gpu-present".into())
                .spawn(move || present_loop(me));
            if spawned.is_err() {
                q.started = false;
            }
        }
        drop(q);
        self.wake.notify_one();
    }

    /// The canvas `key` is no longer shown: once this returns, its surface is never presented to again (a present in
    /// progress finishes first) and is released.
    pub(crate) fn detach(&self, key: &str) {
        let slot = lock(&self.queue).slots.remove(key);
        if let Some(slot) = slot {
            let attached = lock(&slot).take();
            drop(attached);
        }
    }

    /// The canvas's newest image, to present.
    pub(crate) fn frame(&self, key: &str, frame: Frame) {
        let mut q = lock(&self.queue);
        q.latest.insert(key.to_owned(), frame);
        q.dirty.insert(key.to_owned());
        let wake = q.slots.contains_key(key);
        drop(q);
        if wake {
            self.wake.notify_one();
        }
    }

    /// Forgets the images (a device loss made them stale).
    pub(crate) fn clear(&self) {
        let mut q = lock(&self.queue);
        q.latest.clear();
        q.dirty.clear();
    }

    pub(crate) fn stats(&self) -> MutexGuard<'_, GpuStats> {
        lock(&self.stats)
    }

    /// The canvas's newest image as RGBA8, read back (waits for the GPU).
    pub(crate) fn pixels(&self, key: &str) -> Option<(u32, u32, Vec<u8>)> {
        let frame = lock(&self.queue).latest.get(key)?.clone();
        let (d, t) = (&frame.dev, &frame.texture);
        let (w, h) = (t.width(), t.height());
        let row = (w * 4).div_ceil(256) * 256;
        let buffer = d.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("read"),
            size: (row * h) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut e = d.device.create_command_encoder(&Default::default());
        e.copy_texture_to_buffer(
            t.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: None,
                },
            },
            t.size(),
        );
        let submits = device::submits();
        d.queue.submit([e.finish()]);
        drop(submits);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        d.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
        let data = buffer.slice(..).get_mapped_range().ok()?;
        let bgra = t.format() == wgpu::TextureFormat::Bgra8Unorm;
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for px in data[(y * row) as usize..][..(w * 4) as usize]
                .as_chunks::<4>()
                .0
            {
                match bgra {
                    true => out.extend_from_slice(&[px[2], px[1], px[0], px[3]]),
                    false => out.extend_from_slice(px),
                }
            }
        }
        Some((w, h, out))
    }

    pub(crate) fn failures(&self) -> Vec<(String, String)> {
        std::mem::take(&mut *lock(&self.failed))
    }

    /// The run ended: the presenter stops; surfaces still attached are released.
    pub(crate) fn stop(&self) {
        let mut q = lock(&self.queue);
        q.stop = true;
        q.latest.clear();
        let slots: Vec<Slot> = q.slots.drain().map(|(_, s)| s).collect();
        drop(q);
        self.wake.notify_all();
        for s in slots {
            drop(lock(&s).take());
        }
    }
}

fn present_loop(surfaces: std::sync::Weak<Surfaces>) {
    let mut blit = Blit::default();
    loop {
        let Some(s) = surfaces.upgrade() else { return };
        let work: Vec<(String, Slot, Frame)> = {
            let mut q = lock(&s.queue);
            loop {
                if q.stop {
                    return;
                }
                let ready: Vec<String> = q
                    .dirty
                    .iter()
                    .filter(|k| q.slots.contains_key(*k) && q.latest.contains_key(*k))
                    .cloned()
                    .collect();
                if !ready.is_empty() {
                    break ready
                        .into_iter()
                        .map(|k| {
                            q.dirty.remove(&k);
                            let slot = q.slots[&k].clone();
                            let frame = q.latest[&k].clone();
                            (k, slot, frame)
                        })
                        .collect();
                }
                q = s.wake.wait(q).unwrap_or_else(PoisonError::into_inner);
            }
        };
        for (key, slot, frame) in work {
            // Only a frame of the device in use: a lost one's textures are gone.
            if device::current().is_none_or(|d| d.generation != frame.dev.generation) {
                continue;
            }
            let mut attached = lock(&slot);
            let Some(a) = attached.as_mut() else { continue };
            let started = std::time::Instant::now();
            let shown = a.present(&frame, &mut blit);
            if let Ok(Shown::Yes) = shown {
                s.stats().presented(started.elapsed().as_secs_f64() * 1e6);
            }
            match shown {
                Ok(Shown::Yes | Shown::Hidden | Shown::Outdated) => {}
                // It waited for a texture already: try again, unless a newer image came.
                Ok(Shown::Timeout) => {
                    drop(attached);
                    lock(&s.queue).dirty.insert(key);
                }
                Err(why) => {
                    // A surface that fails is dropped; attaching it again tries again.
                    *attached = None;
                    lock(&s.failed).push((key, why));
                }
            }
        }
    }
}
