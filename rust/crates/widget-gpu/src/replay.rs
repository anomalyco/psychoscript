//! Replaying a checked batch on the device. wgpu validates it, under error scopes; the few rules wgpu can't check
//! on a shared device with larger limits, or on the canvas's texture, are checked here.

use widget_wire::Arg;

use crate::desc::{self, Fail, Obj, R, fail, handle, list, num, triple, u32_of, u64_of};
use crate::{AlphaMode, ErrorKind, Gpu, Res, View, gpu_error, now};

/// WebGPU's `minUniformBufferOffsetAlignment` and `minStorageBufferOffsetAlignment`.
const ALIGNMENT: u64 = 256;

const CANVAS_ONLY: &str = "a canvas's texture can only be a render pass attachment";

/// A batch's command encoding: the commands before the next `submit`, and the canvases its passes wrote.
#[derive(Default)]
struct Run {
    encoder: Option<wgpu::CommandEncoder>,
    written: Vec<usize>,
}

/// An op's name and arguments.
fn parts(op: &Arg) -> R<(&str, &[Arg])> {
    match op {
        Arg::List(l) => match l.split_first() {
            Some((Arg::Str(name), args)) => Ok((name, args)),
            _ => fail("an op is a list that starts with its name"),
        },
        _ => fail("an op is a list that starts with its name"),
    }
}

fn opt_u32(a: Option<&Arg>, what: &str) -> R<Option<u32>> {
    match a {
        None | Some(Arg::Null) => Ok(None),
        v => u32_of(v, what).map(Some),
    }
}

fn extent(a: Option<&Arg>) -> R<wgpu::Extent3d> {
    let [width, height, depth_or_array_layers] = triple(a, "size", 1)?;
    Ok(wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers,
    })
}

fn data<'b>(bytes: &'b [u8], offset: Option<&Arg>, len: Option<&Arg>) -> R<&'b [u8]> {
    let o = u64_of(offset, "byteOffset")? as usize;
    let n = u64_of(len, "byteLength")? as usize;
    match o.checked_add(n) {
        Some(end) if end <= bytes.len() => Ok(&bytes[o..end]),
        _ => fail("bytes outside the batch"),
    }
}

fn encoder<'r>(device: &wgpu::Device, run: &'r mut Run) -> &'r mut wgpu::CommandEncoder {
    run.encoder
        .get_or_insert_with(|| device.create_command_encoder(&Default::default()))
}

impl Gpu {
    /// Replays a batch that passed the checks; its first error, wgpu's or this replay's.
    pub(crate) fn replay(&mut self, ops: &[Arg], bytes: &[u8]) -> Result<(), (ErrorKind, String)> {
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let mut run = Run::default();
        let mut i = 0;
        let mut failed = None;
        while i < ops.len() {
            if let Err(f) = self.op(ops, &mut i, bytes, &mut run) {
                failed = Some(f);
                break;
            }
            i += 1;
        }
        drop(run);
        let internal = now(internal.pop()).flatten();
        let memory = now(memory.pop()).flatten();
        let validation = now(validation.pop()).flatten();
        if let Some(e) = validation.or(memory).or(internal) {
            return Err(gpu_error(e));
        }
        match failed {
            None => Ok(()),
            Some(f) => Err((
                ErrorKind::Program,
                format!(
                    "gpu op {i}: {}",
                    match f {
                        Fail::Msg(m) => m,
                        Fail::Missing(h) => format!("no handle {h}"),
                    }
                ),
            )),
        }
    }

    fn get(&self, h: u32) -> R<&Res> {
        self.res.get(&h).ok_or(Fail::Missing(h))
    }

    fn buffer(&self, a: Option<&Arg>) -> R<&wgpu::Buffer> {
        let h = handle(a, "a buffer")?;
        match self.get(h)? {
            Res::Buffer(b) => Ok(b),
            _ => fail(format!("{h} is not a buffer")),
        }
    }

    fn texture(&self, a: Option<&Arg>) -> R<&wgpu::Texture> {
        let h = handle(a, "a texture")?;
        match self.get(h)? {
            Res::Texture(t) => Ok(t),
            Res::Context(_) => fail(CANVAS_ONLY),
            _ => fail(format!("{h} is not a texture")),
        }
    }

    fn shader(&self, a: Option<&Arg>) -> R<&wgpu::ShaderModule> {
        let h = handle(a, "module")?;
        match self.get(h)? {
            Res::Shader(s) => Ok(s),
            _ => fail(format!("{h} is not a shader module")),
        }
    }

    fn bind_group_layout(&self, a: Option<&Arg>) -> R<&wgpu::BindGroupLayout> {
        let h = handle(a, "a bind group layout")?;
        match self.get(h)? {
            Res::BindGroupLayout(l) => Ok(l),
            _ => fail(format!("{h} is not a bind group layout")),
        }
    }

    fn pipeline(&self, a: Option<&Arg>) -> R<&wgpu::RenderPipeline> {
        let h = handle(a, "a pipeline")?;
        match self.get(h)? {
            Res::Pipeline(p) => Ok(p),
            _ => fail(format!("{h} is not a render pipeline")),
        }
    }

    fn copy_texture<'t>(&'t self, a: &[Arg], at: usize) -> R<wgpu::TexelCopyTextureInfo<'t>> {
        let [x, y, z] = triple(a.get(at + 2), "origin", 0)?;
        Ok(wgpu::TexelCopyTextureInfo {
            texture: self.texture(a.get(at))?,
            mip_level: u32_of(a.get(at + 1), "mipLevel")?,
            origin: wgpu::Origin3d { x, y, z },
            aspect: wgpu::TextureAspect::All,
        })
    }

    fn op(&mut self, ops: &[Arg], i: &mut usize, bytes: &[u8], run: &mut Run) -> R<()> {
        let (name, a) = parts(&ops[*i])?;
        let h = || handle(a.first(), "the handle");
        let made = match name {
            "context" => {
                let (Some(Arg::Str(key)), Some(Arg::Str(format)), Some(Arg::Str(alpha))) =
                    (a.get(1), a.get(2), a.get(3))
                else {
                    return fail("a context op's shape");
                };
                let format = match format.as_str() {
                    "bgra8unorm" => wgpu::TextureFormat::Bgra8Unorm,
                    _ => wgpu::TextureFormat::Rgba8Unorm,
                };
                let t = self.target(key);
                t.format = Some(format);
                t.alpha = match alpha.as_str() {
                    "premultiplied" => AlphaMode::Premultiplied,
                    _ => AlphaMode::Opaque,
                };
                let at = self
                    .canvases
                    .iter()
                    .position(|t| t.key == *key)
                    .unwrap_or_default();
                Some(Res::Context(at))
            }
            "buffer" => {
                let usage = u32_of(a.get(2), "usage")?;
                Some(Res::Buffer(self.device.create_buffer(
                    &wgpu::BufferDescriptor {
                        label: None,
                        size: u64_of(a.get(1), "size")?,
                        usage: wgpu::BufferUsages::from_bits_truncate(usage),
                        mapped_at_creation: false,
                    },
                )))
            }
            "texture" => {
                let format = match a.get(4) {
                    Some(Arg::Str(f)) => desc::texture_format(f),
                    _ => None,
                };
                let Some(format) = format else {
                    return fail("a texture's format");
                };
                Some(Res::Texture(self.device.create_texture(
                    &wgpu::TextureDescriptor {
                        label: None,
                        size: wgpu::Extent3d {
                            width: u32_of(a.get(1), "width")?,
                            height: u32_of(a.get(2), "height")?,
                            depth_or_array_layers: u32_of(a.get(3), "depthOrArrayLayers")?,
                        },
                        mip_level_count: u32_of(a.get(6), "mipLevelCount")?,
                        sample_count: u32_of(a.get(7), "sampleCount")?,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage: wgpu::TextureUsages::from_bits_truncate(u32_of(a.get(5), "usage")?),
                        view_formats: &[],
                    },
                )))
            }
            "view" => {
                let t = handle(a.get(1), "texture")?;
                let d = desc::view(Obj::of(a.get(2), "the descriptor")?)?;
                Some(Res::View(match self.get(t)? {
                    Res::Texture(t) => View::Texture(t.create_view(&d)),
                    Res::Context(c) => View::Canvas {
                        canvas: *c,
                        desc: d,
                        made: None,
                    },
                    _ => return fail(format!("{t} is not a texture")),
                }))
            }
            "sampler" => {
                let d = desc::sampler(Obj::of(a.get(1), "the descriptor")?)?;
                Some(Res::Sampler(self.device.create_sampler(&d)))
            }
            "shader" => {
                let Some(Arg::Str(code)) = a.get(1) else {
                    return fail("a shader's code");
                };
                Some(Res::Shader(self.device.create_shader_module(
                    wgpu::ShaderModuleDescriptor {
                        label: None,
                        source: wgpu::ShaderSource::Wgsl(code.as_str().into()),
                    },
                )))
            }
            "bindGroupLayout" => {
                let d = Obj::of(a.get(1), "the descriptor")?;
                let entries = d
                    .list("entries")?
                    .iter()
                    .map(|e| desc::layout_entry(Obj::of(Some(e), "an entry")?))
                    .collect::<R<Vec<_>>>()?;
                Some(Res::BindGroupLayout(self.device.create_bind_group_layout(
                    &wgpu::BindGroupLayoutDescriptor {
                        label: None,
                        entries: &entries,
                    },
                )))
            }
            "pipelineLayout" => {
                let layouts = list(a.get(1), "bindGroupLayouts")?
                    .iter()
                    .map(|l| self.bind_group_layout(Some(l)).map(Some))
                    .collect::<R<Vec<_>>>()?;
                Some(Res::PipelineLayout(self.device.create_pipeline_layout(
                    &wgpu::PipelineLayoutDescriptor {
                        label: None,
                        bind_group_layouts: &layouts,
                        immediate_size: 0,
                    },
                )))
            }
            "renderPipeline" => Some(Res::Pipeline(
                self.render_pipeline(Obj::of(a.get(1), "the descriptor")?)?,
            )),
            "autoLayout" => Some(Res::BindGroupLayout(
                self.pipeline(a.get(1))?
                    .get_bind_group_layout(u32_of(a.get(2), "index")?),
            )),
            "bindGroup" => Some(Res::BindGroup(
                self.bind_group(Obj::of(a.get(1), "the descriptor")?)?,
            )),
            "destroy" => {
                match self.res.remove(&h()?) {
                    Some(Res::Buffer(b)) => b.destroy(),
                    Some(Res::Texture(t)) => t.destroy(),
                    _ => {}
                }
                None
            }
            "writeBuffer" => {
                let buffer = self.buffer(a.first())?;
                let offset = u64_of(a.get(1), "offset")?;
                self.queue
                    .write_buffer(buffer, offset, data(bytes, a.get(2), a.get(3))?);
                None
            }
            "writeTexture" => {
                let layout = wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: opt_u32(a.get(5), "bytesPerRow")?,
                    rows_per_image: opt_u32(a.get(6), "rowsPerImage")?,
                };
                self.queue.write_texture(
                    self.copy_texture(a, 0)?,
                    data(bytes, a.get(3), a.get(4))?,
                    layout,
                    extent(a.get(7))?,
                );
                None
            }
            "copyBufferToBuffer" => {
                let src = self.buffer(a.first())?;
                let src_offset = u64_of(a.get(1), "sourceOffset")?;
                let dst = self.buffer(a.get(2))?;
                let dst_offset = u64_of(a.get(3), "destinationOffset")?;
                let size = u64_of(a.get(4), "size")?;
                encoder(&self.device, run)
                    .copy_buffer_to_buffer(src, src_offset, dst, dst_offset, size);
                None
            }
            "copyBufferToTexture" => {
                let src = wgpu::TexelCopyBufferInfo {
                    buffer: self.buffer(a.first())?,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: u64_of(a.get(1), "offset")?,
                        bytes_per_row: opt_u32(a.get(2), "bytesPerRow")?,
                        rows_per_image: opt_u32(a.get(3), "rowsPerImage")?,
                    },
                };
                let dst = self.copy_texture(a, 4)?;
                encoder(&self.device, run).copy_buffer_to_texture(src, dst, extent(a.get(7))?);
                None
            }
            "copyTextureToTexture" => {
                let src = self.copy_texture(a, 0)?;
                let dst = self.copy_texture(a, 3)?;
                encoder(&self.device, run).copy_texture_to_texture(src, dst, extent(a.get(6))?);
                None
            }
            "pass" => {
                self.pass(ops, i, run)?;
                None
            }
            "submit" => {
                self.queue
                    .submit(run.encoder.take().map(wgpu::CommandEncoder::finish));
                self.submitted = true;
                for c in run.written.drain(..) {
                    self.canvases[c].version += 1;
                }
                None
            }
            _ => return fail(format!("\"{name}\" can't be replayed here")),
        };
        if let Some(r) = made {
            // A context op repeating its handle reconfigures the canvas.
            self.res.insert(h()?, r);
        }
        Ok(())
    }

    fn render_pipeline(&self, d: Obj) -> R<wgpu::RenderPipeline> {
        let layout = match d.get("layout") {
            Some(Arg::Str(s)) if s == "auto" => None,
            l => {
                let h = handle(l, "layout")?;
                match self.get(h)? {
                    Res::PipelineLayout(l) => Some(l),
                    _ => return fail(format!("{h} is not a pipeline layout")),
                }
            }
        };
        let v = Obj::of(d.get("vertex"), "vertex")?;
        let mut attrs = Vec::new();
        let mut shapes = Vec::new();
        for b in v.list("buffers")? {
            shapes.push(match b {
                Arg::Null => None,
                b => {
                    let start = attrs.len();
                    let (stride, step) =
                        desc::vertex_buffer(Obj::of(Some(b), "a vertex buffer")?, &mut attrs)?;
                    Some((stride, step, start, attrs.len()))
                }
            });
        }
        let buffers: Vec<_> = shapes
            .iter()
            .map(|s| {
                s.map(
                    |(array_stride, step_mode, start, end)| wgpu::VertexBufferLayout {
                        array_stride,
                        step_mode,
                        attributes: &attrs[start..end],
                    },
                )
            })
            .collect();
        let f = d.obj("fragment")?;
        let targets = match f {
            None => Vec::new(),
            Some(f) => f
                .list("targets")?
                .iter()
                .map(|t| match t {
                    Arg::Null => Ok(None),
                    t => desc::color_target(Obj::of(Some(t), "a target")?).map(Some),
                })
                .collect::<R<Vec<_>>>()?,
        };
        let fragment = match f {
            None => None,
            Some(f) => Some(wgpu::FragmentState {
                module: self.shader(f.get("module"))?,
                entry_point: f.str("entryPoint")?,
                compilation_options: Default::default(),
                targets: &targets,
            }),
        };
        Ok(self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout,
                vertex: wgpu::VertexState {
                    module: self.shader(v.get("module"))?,
                    entry_point: v.str("entryPoint")?,
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive: desc::primitive(Obj::of(d.get("primitive"), "primitive")?)?,
                depth_stencil: d
                    .obj("depthStencil")?
                    .map(desc::depth_stencil)
                    .transpose()?,
                multisample: desc::multisample(Obj::of(d.get("multisample"), "multisample")?)?,
                fragment,
                multiview_mask: None,
                cache: None,
            }))
    }

    fn bind_group(&self, d: Obj) -> R<wgpu::BindGroup> {
        let layout = self.bind_group_layout(d.get("layout"))?;
        let mut entries = Vec::new();
        for e in d.list("entries")? {
            let e = Obj::of(Some(e), "an entry")?;
            let r = Obj::of(e.get("resource"), "resource")?;
            let resource = if r.has("buffer") {
                let offset = r.u64("offset", 0)?;
                if !offset.is_multiple_of(ALIGNMENT) {
                    return fail(format!(
                        "a buffer binding's offset {offset} is not a multiple of {ALIGNMENT}"
                    ));
                }
                let size = match r.get("size") {
                    None | Some(Arg::Num(-1.0)) => None,
                    s => match wgpu::BufferSize::new(u64_of(s, "size")?) {
                        Some(s) => Some(s),
                        None => return fail("a buffer binding's size must be over 0"),
                    },
                };
                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: self.buffer(r.get("buffer"))?,
                    offset,
                    size,
                })
            } else if r.has("sampler") {
                let h = handle(r.get("sampler"), "sampler")?;
                match self.get(h)? {
                    Res::Sampler(s) => wgpu::BindingResource::Sampler(s),
                    _ => return fail(format!("{h} is not a sampler")),
                }
            } else {
                let h = handle(r.get("view"), "view")?;
                match self.get(h)? {
                    Res::View(View::Texture(v)) => wgpu::BindingResource::TextureView(v),
                    Res::View(View::Canvas { .. }) => return fail(CANVAS_ONLY),
                    _ => return fail(format!("{h} is not a view")),
                }
            };
            entries.push(wgpu::BindGroupEntry {
                binding: e.u32("binding", 0)?,
                resource,
            });
        }
        Ok(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout,
            entries: &entries,
        }))
    }

    /// A view to render to; `None` for a canvas that can't be drawn now (no size, or stopped). A canvas's is noted
    /// in `written`.
    fn attachment(
        &mut self,
        a: Option<&Arg>,
        written: &mut Vec<usize>,
    ) -> R<Option<wgpu::TextureView>> {
        let h = handle(a, "view")?;
        match self.res.get_mut(&h) {
            None => Err(Fail::Missing(h)),
            Some(Res::View(View::Texture(v))) => Ok(Some(v.clone())),
            Some(Res::View(View::Canvas { canvas, desc, made })) => {
                let t = &mut self.canvases[*canvas];
                if self.stopped.contains_key(&t.key) {
                    return Ok(None);
                }
                let Some(texture) = t.texture(&self.device).cloned() else {
                    return Ok(None);
                };
                let view = match made {
                    Some((n, v)) if *n == t.made => v.clone(),
                    _ => {
                        let v = texture.create_view(desc);
                        *made = Some((t.made, v.clone()));
                        v
                    }
                };
                written.push(*canvas);
                Ok(Some(view))
            }
            Some(_) => fail(format!("{h} is not a texture view")),
        }
    }

    /// `["pass", descriptor]` and its commands, up to `["end"]`; `i` ends on the `end`. A pass into a canvas that
    /// can't be drawn now is skipped.
    fn pass(&mut self, ops: &[Arg], i: &mut usize, run: &mut Run) -> R<()> {
        let (_, a) = parts(&ops[*i])?;
        let d = Obj::of(a.first(), "the descriptor")?;
        let mut written = Vec::new();
        let mut drawable = true;
        let mut colors = Vec::new();
        for c in d.list("colorAttachments")? {
            if matches!(c, Arg::Null) {
                colors.push(None);
                continue;
            }
            let c = Obj::of(Some(c), "a color attachment")?;
            let before = written.len();
            let view = self.attachment(c.get("view"), &mut written)?;
            // A canvas's first pass of a frame loads transparent, not the last frame.
            let fresh = written.len() > before && self.canvases[written[before]].fresh;
            let resolve = match c.get("resolveTarget") {
                None => None,
                r => Some(self.attachment(r, &mut written)?),
            };
            let clear = c.enumeration("loadOp", false, desc::load_op)?;
            let store = c.enumeration("storeOp", wgpu::StoreOp::Store, desc::store_op)?;
            let load = if clear {
                wgpu::LoadOp::Clear(desc::color(c.get("clearValue"))?)
            } else if fresh {
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
            } else {
                wgpu::LoadOp::Load
            };
            drawable &= view.is_some() && resolve.as_ref().is_none_or(Option::is_some);
            colors.push(Some((
                view,
                resolve.flatten(),
                wgpu::Operations { load, store },
            )));
        }
        let depth = match d.obj("depthStencilAttachment")? {
            None => None,
            Some(z) => {
                let view = self.attachment(z.get("view"), &mut written)?;
                drawable &= view.is_some();
                let load = z.opt_enum("depthLoadOp", desc::load_op)?;
                let store = z.opt_enum("depthStoreOp", desc::store_op)?;
                let ops = match (z.bool("depthReadOnly", false)?, load, store) {
                    (false, Some(clear), Some(store)) => Some(wgpu::Operations {
                        load: if clear {
                            wgpu::LoadOp::Clear(z.f64("depthClearValue", 0.0)? as f32)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store,
                    }),
                    (true, None, None) => None,
                    _ => {
                        return fail(
                            "a depth attachment needs its load and store ops, unless read-only",
                        );
                    }
                };
                Some((view, ops))
            }
        };
        if !drawable {
            loop {
                *i += 1;
                match ops.get(*i).map(parts) {
                    // Cut off by a failing op: what it began isn't submitted.
                    None => {
                        run.encoder = None;
                        return Ok(());
                    }
                    Some(Ok(("end", _))) => return Ok(()),
                    _ => {}
                }
            }
        }
        let attachments: Vec<_> = colors
            .iter()
            .map(|c| {
                c.as_ref().and_then(|(view, resolve, ops)| {
                    Some(wgpu::RenderPassColorAttachment {
                        view: view.as_ref()?,
                        depth_slice: None,
                        resolve_target: resolve.as_ref(),
                        ops: *ops,
                    })
                })
            })
            .collect();
        let depth_stencil_attachment = match &depth {
            Some((Some(view), ops)) => Some(wgpu::RenderPassDepthStencilAttachment {
                view,
                depth_ops: *ops,
                stencil_ops: None,
            }),
            _ => None,
        };
        let mut pass = encoder(&self.device, run).begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &attachments,
            depth_stencil_attachment,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        loop {
            *i += 1;
            let Some(op) = ops.get(*i) else {
                // Cut off by a failing op (the ops before it take effect): the pass and its encoder aren't submitted.
                drop(pass);
                run.encoder = None;
                return Ok(());
            };
            let (name, a) = parts(op)?;
            let n = |k: usize, what: &str| u32_of(a.get(k), what);
            match name {
                "end" => break,
                "setPipeline" => pass.set_pipeline(self.pipeline(a.first())?),
                "setBindGroup" => {
                    let index = n(0, "index")?;
                    let h = handle(a.get(1), "a bind group")?;
                    let Res::BindGroup(group) = self.get(h)? else {
                        return fail(format!("{h} is not a bind group"));
                    };
                    let offsets = list(a.get(2), "dynamicOffsets")?
                        .iter()
                        .map(|o| u32_of(Some(o), "a dynamic offset"))
                        .collect::<R<Vec<_>>>()?;
                    if let Some(o) = offsets
                        .iter()
                        .find(|o| !(**o as u64).is_multiple_of(ALIGNMENT))
                    {
                        return fail(format!(
                            "dynamic offset {o} is not a multiple of {ALIGNMENT}"
                        ));
                    }
                    pass.set_bind_group(index, group, &offsets);
                }
                "setVertexBuffer" | "setIndexBuffer" => {
                    let vertex = name == "setVertexBuffer";
                    let buffer = self.buffer(if vertex { a.get(1) } else { a.first() })?;
                    let offset = u64_of(a.get(2), "offset")?;
                    let whole = buffer.size();
                    let size = match a.get(3) {
                        Some(Arg::Num(-1.0)) if offset <= whole => whole - offset,
                        s => match u64_of(s, "size")? {
                            s if offset.checked_add(s).is_some_and(|end| end <= whole) => s,
                            _ => {
                                return fail(format!(
                                    "offset {offset} and size are outside the buffer's {whole} bytes"
                                ));
                            }
                        },
                    };
                    // wgpu takes no empty slice; one that's never read is as good as none.
                    if size > 0 {
                        let slice = buffer.slice(offset..offset + size);
                        if vertex {
                            pass.set_vertex_buffer(n(0, "slot")?, slice);
                        } else {
                            let format = match a.get(1) {
                                Some(Arg::Str(f)) => desc::index_format(f),
                                _ => None,
                            };
                            let Some(format) = format else {
                                return fail("an index format");
                            };
                            pass.set_index_buffer(slice, format);
                        }
                    }
                }
                "setViewport" => {
                    let mut v = [0f32; 6];
                    for (k, v) in v.iter_mut().enumerate() {
                        *v = num(a.get(k), "a viewport value")? as f32;
                    }
                    pass.set_viewport(v[0], v[1], v[2], v[3], v[4], v[5]);
                }
                "setScissorRect" => {
                    pass.set_scissor_rect(n(0, "x")?, n(1, "y")?, n(2, "width")?, n(3, "height")?)
                }
                "draw" | "drawIndexed" => {
                    let indexed = name == "drawIndexed";
                    let (count, instances, first) =
                        (n(0, "count")?, n(1, "instanceCount")?, n(2, "first")?);
                    let first_instance = n(if indexed { 4 } else { 3 }, "firstInstance")?;
                    let (Some(end), Some(instance_end)) = (
                        first.checked_add(count),
                        first_instance.checked_add(instances),
                    ) else {
                        return fail("the draw's range is past 2^32");
                    };
                    if indexed {
                        let base = match a.get(3) {
                            Some(Arg::Num(b)) if *b >= i32::MIN as f64 && *b <= i32::MAX as f64 => {
                                *b as i32
                            }
                            _ => return fail("baseVertex is outside 32 bits"),
                        };
                        pass.draw_indexed(first..end, base, first_instance..instance_end);
                    } else {
                        pass.draw(first..end, first_instance..instance_end);
                    }
                }
                _ => return fail(format!("\"{name}\" inside a render pass")),
            }
        }
        drop(pass);
        for &c in &written {
            self.canvases[c].fresh = false;
        }
        run.written.extend(written);
        Ok(())
    }
}
