//! The `wgsl` shorthand (`widgets.md`, GPU canvases): a full-screen triangle whose fragment stage is the widget
//! template's `shade`, fed the `widget` uniforms. It is a fixed batch replayed by its own [`Gpu`], so its errors,
//! limits and placeholder are a GPU canvas's.
//!
//! A shader that takes over 50 ms a frame three frames in a row stops and shows its last frame (`widgets.md`, GPU
//! canvases), a client error. A frame counts as slow when its GPU work is seen unfinished more than 50 ms after its
//! submit; a frame isn't drawn while the last one is still drawing, so a slow shader never queues work behind it.
//! Nothing here waits for the GPU.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;
use widget_wire::Arg;

use crate::{Canvas, ErrorKind, Gpu, GpuError, Stops};

/// A frame slower than this counts against a shader.
pub const SLOW_FRAME: Duration = Duration::from_millis(50);
/// Slow frames in a row that stop it.
pub const SLOW_FRAMES: u32 = 3;
/// Why a shader stopped on its last frame.
pub const SLOW_MESSAGE: &str = "the shader took over 50 ms a frame, three frames in a row";

/// What clients prepend to the widget template's `wgsl`.
pub const HEADER: &str = "struct Widget { resolution: vec2f, time: f32, scale: f32, pointer: vec4f, values: array<vec4f, 4> }
@group(0) @binding(0) var<uniform> widget: Widget;
";

/// What they append: the entry point, and the full-screen triangle's vertex stage.
const ENTRY: &str = "
@fragment fn widget_main(@builtin(position) p: vec4f) -> @location(0) vec4f { return shade(p.xy); }
@vertex fn widget_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}
";

const KEY: &str = "wgsl";

/// A frame's `widget` uniforms, all but `resolution` (the size [`Shorthand::render`] takes).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Uniforms {
    /// Seconds since the canvas appeared.
    pub time: f32,
    pub scale: f32,
    /// `(x, y, down, 0)`, physical pixels.
    pub pointer: [f32; 4],
    /// The node's `values`, zero padded.
    pub values: [f32; 16],
}

/// One `wgsl` canvas.
pub struct Shorthand {
    gpu: Gpu,
    source: String,
    frame: Vec<Arg>,
    lines: usize,
    /// The frame the GPU is drawing.
    drawing: Option<Drawing>,
    /// Slow frames in a row.
    slow: u32,
    /// It was too slow: stopped on its last frame.
    stopped: Option<GpuError>,
}

/// A frame submitted to the GPU.
struct Drawing {
    at: Instant,
    done: Arc<AtomicBool>,
    /// Seen unfinished past [`SLOW_FRAME`], and counted.
    slow: bool,
}

fn ops(v: serde_json::Value) -> Vec<Arg> {
    match Arg::from_json(&v) {
        Arg::List(l) => l,
        _ => Vec::new(),
    }
}

impl Shorthand {
    /// Compiles the widget template's `wgsl`. A WGSL error is the program's, its line and column the template's.
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        format: wgpu::TextureFormat,
        wgsl: &str,
    ) -> Result<Shorthand, GpuError> {
        let mut s = Shorthand {
            gpu: Gpu::new(device, queue, format)?,
            source: format!("{HEADER}{wgsl}{ENTRY}"),
            frame: ops(json!([
                ["writeBuffer", 4, 0, 0, 96],
                ["pass", { "colorAttachments": [{ "view": 2, "resolveTarget": null, "clearValue": [0, 0, 0, 0], "loadOp": "clear", "storeOp": "store" }], "depthStencilAttachment": null }],
                ["setPipeline", 7],
                ["setBindGroup", 0, 8, []],
                ["draw", 3, 1, 0, 0],
                ["end"],
                ["submit"],
            ])),
            lines: wgsl.lines().count(),
            drawing: None,
            slow: 0,
            stopped: None,
        };
        s.gpu.resize(KEY, 0, 0);
        s.setup()?;
        Ok(s)
    }

    fn setup(&mut self) -> Result<(), GpuError> {
        let format = self.gpu.preferred_format();
        let setup = ops(json!([
            ["context", 1, KEY, format, "premultiplied"],
            ["view", 2, 1, { "dimension": "2d", "baseMipLevel": 0, "mipLevelCount": 1, "baseArrayLayer": 0, "arrayLayerCount": 1 }],
            ["shader", 3, self.source],
            ["buffer", 4, 96, 64 | 8],
            ["bindGroupLayout", 5, { "entries": [{ "binding": 0, "visibility": 3, "sampler": null, "texture": null,
                "buffer": { "type": "uniform", "hasDynamicOffset": false, "minBindingSize": 0 } }] }],
            ["pipelineLayout", 6, [5]],
            ["renderPipeline", 7, {
                "layout": 6,
                "vertex": { "module": 3, "entryPoint": "widget_vertex", "buffers": [] },
                "fragment": { "module": 3, "entryPoint": "widget_main",
                    "targets": [{ "format": format, "blend": null, "writeMask": 15 }] },
                "primitive": { "topology": "triangle-list", "stripIndexFormat": null, "frontFace": "ccw", "cullMode": "none" },
                "depthStencil": null,
                "multisample": { "count": 1, "mask": 4294967295u32, "alphaToCoverageEnabled": false },
            }],
            ["bindGroup", 8, { "layout": 5, "entries": [{ "binding": 0, "resource": { "buffer": 4, "offset": 0, "size": -1 } }] }],
        ]));
        self.gpu.apply(&setup, &[]).map_err(|e| self.relocate(e))
    }

    /// A WGSL position in the template's lines, or none when it falls outside them.
    fn relocate(&self, mut e: GpuError) -> GpuError {
        let header = HEADER.lines().count();
        if let Some(at) = e.message.rfind(" (WGSL line ") {
            let line = e.message[at + 12..]
                .split(',')
                .next()
                .and_then(|l| l.parse::<usize>().ok());
            match line {
                Some(l) if l > header && l <= header + self.lines => {
                    let rest = e.message[at..].replacen(
                        &format!("line {l},"),
                        &format!("line {},", l - header),
                        1,
                    );
                    e.message.replace_range(at.., &rest);
                }
                _ => e.message.truncate(at),
            }
        }
        e
    }

    /// Draws a frame at `width` × `height` physical pixels, unless the last one is still drawing (it is skipped) or
    /// the shader stopped. Never waits for the GPU.
    pub fn render(&mut self, width: u32, height: u32, u: &Uniforms) -> Result<(), GpuError> {
        if self.stopped.is_some() || self.drawing() {
            return Ok(());
        }
        self.gpu.resize(KEY, width, height);
        let mut f = [0f32; 24];
        f[..4].copy_from_slice(&[width as f32, height as f32, u.time, u.scale]);
        f[4..8].copy_from_slice(&u.pointer);
        f[8..].copy_from_slice(&u.values);
        let mut bytes = [0u8; 96];
        for (b, f) in bytes.as_chunks_mut::<4>().0.iter_mut().zip(f) {
            b.copy_from_slice(&f.to_le_bytes());
        }
        let r = self.gpu.apply(&self.frame, &bytes);
        self.gpu.end_frame();
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        self.gpu
            .queue()
            .on_submitted_work_done(move || flag.store(true, Ordering::Release));
        self.drawing = Some(Drawing {
            at: Instant::now(),
            done,
            slow: false,
        });
        r
    }

    /// Whether the last frame is still drawing, counting it slow once it is past [`SLOW_FRAME`]; the third slow
    /// frame in a row stops the shader.
    fn drawing(&mut self) -> bool {
        let Some(d) = &mut self.drawing else {
            return false;
        };
        let _ = self.gpu.device().poll(wgpu::PollType::Poll);
        if d.done.load(Ordering::Acquire) {
            // Done between two looks, unseen past the limit: as fast as can be told.
            if !d.slow {
                self.slow = 0;
            }
            self.drawing = None;
            return false;
        }
        if !d.slow && d.at.elapsed() > SLOW_FRAME {
            d.slow = true;
            self.slow += 1;
            if self.slow >= SLOW_FRAMES {
                self.stopped = Some(GpuError {
                    kind: ErrorKind::Client,
                    message: SLOW_MESSAGE.into(),
                    canvases: Stops::All,
                });
            }
        }
        true
    }

    /// Whether it stopped for being too slow ([`Shorthand::error`] is then a client error): show its last frame
    /// ([`Shorthand::canvas`]), not the placeholder.
    pub fn too_slow(&self) -> bool {
        self.stopped.is_some()
    }

    /// The canvas's texture, once rendered: premultiplied, sRGB-encoded colors.
    pub fn canvas(&self) -> Option<Canvas<'_>> {
        self.gpu.canvas(KEY)
    }

    /// The error that stopped it: the program's or the client's, or a client error for a shader too slow
    /// ([`Shorthand::too_slow`]).
    pub fn error(&self) -> Option<&GpuError> {
        self.stopped.as_ref().or_else(|| self.gpu.error(KEY))
    }

    /// After a device loss: the same shader on `device`. One that stopped for being too slow stays stopped.
    pub fn reset(&mut self, device: wgpu::Device, queue: wgpu::Queue) -> Result<(), GpuError> {
        self.drawing = None;
        self.slow = 0;
        self.gpu.reset(device, queue)?;
        self.setup()
    }
}
