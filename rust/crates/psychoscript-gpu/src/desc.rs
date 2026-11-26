//! Reading op arguments and WebGPU descriptors (`README.md`, Transport) into wgpu's types. Only the subset's
//! values are accepted: anything else is the program's error.

use crate::Arg;
use wgpu::*;

/// Why an op failed: a message for the program, or a handle that doesn't exist (which may be one from before a
/// device loss, see `Gpu::reset`).
pub(crate) enum Fail {
    Msg(String),
    Missing(u32),
}

impl From<String> for Fail {
    fn from(m: String) -> Fail {
        Fail::Msg(m)
    }
}

pub(crate) type R<T> = Result<T, Fail>;

pub(crate) fn fail<T>(m: impl Into<String>) -> R<T> {
    Err(Fail::Msg(m.into()))
}

const MAX_SAFE: u64 = (1 << 53) - 1;

/// A non-negative integer up to `max`.
pub(crate) fn int(a: Option<&Arg>, what: &str, max: u64) -> R<u64> {
    match a {
        Some(Arg::Num(n)) if *n >= 0.0 && n.fract() == 0.0 && *n <= max as f64 => Ok(*n as u64),
        _ => fail(format!("{what} must be an integer from 0 to {max}")),
    }
}

pub(crate) fn u32_of(a: Option<&Arg>, what: &str) -> R<u32> {
    int(a, what, u32::MAX as u64).map(|n| n as u32)
}

pub(crate) fn u64_of(a: Option<&Arg>, what: &str) -> R<u64> {
    int(a, what, MAX_SAFE)
}

pub(crate) fn num(a: Option<&Arg>, what: &str) -> R<f64> {
    match a {
        Some(Arg::Num(n)) => Ok(*n),
        _ => fail(format!("{what} must be a number")),
    }
}

pub(crate) fn handle(a: Option<&Arg>, what: &str) -> R<u32> {
    match a {
        Some(Arg::Num(n)) if *n >= 1.0 && n.fract() == 0.0 && *n <= u32::MAX as f64 => {
            Ok(*n as u32)
        }
        _ => fail(format!("{what} must be a handle")),
    }
}

pub(crate) fn list<'a>(a: Option<&'a Arg>, what: &str) -> R<&'a [Arg]> {
    match a {
        Some(Arg::List(l)) => Ok(l),
        None | Some(Arg::Null) => Ok(&[]),
        _ => fail(format!("{what} must be a list")),
    }
}

/// `[x, y, z]` with missing items 0 (an origin), or with missing items 1 (a size).
pub(crate) fn triple(a: Option<&Arg>, what: &str, missing: u32) -> R<[u32; 3]> {
    let l = list(a, what)?;
    if l.len() > 3 {
        return fail(format!("{what} has more than 3 items"));
    }
    let mut out = [missing; 3];
    for (i, v) in l.iter().enumerate() {
        out[i] = u32_of(Some(v), what)?;
    }
    Ok(out)
}

/// A descriptor: WebGPU's dictionary, with handles for objects. A `null` field is an absent one.
#[derive(Clone, Copy)]
pub(crate) struct Obj<'a>(&'a [(String, Arg)]);

impl<'a> Obj<'a> {
    pub fn of(a: Option<&'a Arg>, what: &str) -> R<Obj<'a>> {
        match a {
            Some(Arg::Obj(f)) => Ok(Obj(f)),
            None | Some(Arg::Null) => Ok(Obj(&[])),
            _ => fail(format!("{what} must be an object")),
        }
    }

    pub fn get(self, k: &str) -> Option<&'a Arg> {
        self.0
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v)
            .filter(|v| !matches!(v, Arg::Null))
    }

    pub fn has(self, k: &str) -> bool {
        self.get(k).is_some()
    }

    pub fn u32(self, k: &str, default: u32) -> R<u32> {
        self.get(k).map_or(Ok(default), |v| u32_of(Some(v), k))
    }

    pub fn u64(self, k: &str, default: u64) -> R<u64> {
        self.get(k).map_or(Ok(default), |v| u64_of(Some(v), k))
    }

    pub fn opt_u32(self, k: &str) -> R<Option<u32>> {
        self.get(k).map(|v| u32_of(Some(v), k)).transpose()
    }

    pub fn f64(self, k: &str, default: f64) -> R<f64> {
        self.get(k).map_or(Ok(default), |v| num(Some(v), k))
    }

    pub fn bool(self, k: &str, default: bool) -> R<bool> {
        match self.get(k) {
            None => Ok(default),
            Some(Arg::Bool(b)) => Ok(*b),
            Some(_) => fail(format!("{k} must be true or false")),
        }
    }

    pub fn obj(self, k: &str) -> R<Option<Obj<'a>>> {
        self.get(k).map(|v| Obj::of(Some(v), k)).transpose()
    }

    pub fn list(self, k: &str) -> R<&'a [Arg]> {
        list(self.get(k), k)
    }

    /// An enum string through `f`, `default` when absent.
    pub fn enumeration<T>(self, k: &str, default: T, f: fn(&str) -> Option<T>) -> R<T> {
        Ok(self.opt_enum(k, f)?.unwrap_or(default))
    }

    pub fn opt_enum<T>(self, k: &str, f: fn(&str) -> Option<T>) -> R<Option<T>> {
        match self.get(k) {
            None => Ok(None),
            Some(Arg::Str(s)) => match f(s) {
                Some(t) => Ok(Some(t)),
                None => fail(format!("{k} \"{s}\" is not in the subset")),
            },
            Some(_) => fail(format!("{k} must be a string")),
        }
    }

    pub fn str(self, k: &str) -> R<Option<&'a str>> {
        match self.get(k) {
            None => Ok(None),
            Some(Arg::Str(s)) => Ok(Some(s)),
            Some(_) => fail(format!("{k} must be a string")),
        }
    }
}

pub(crate) fn texture_format(s: &str) -> Option<TextureFormat> {
    Some(match s {
        "rgba8unorm" => TextureFormat::Rgba8Unorm,
        "rgba8unorm-srgb" => TextureFormat::Rgba8UnormSrgb,
        "bgra8unorm" => TextureFormat::Bgra8Unorm,
        "r8unorm" => TextureFormat::R8Unorm,
        "rgba16float" => TextureFormat::Rgba16Float,
        "depth24plus" => TextureFormat::Depth24Plus,
        "depth32float" => TextureFormat::Depth32Float,
        _ => return None,
    })
}

pub(crate) fn view_dimension(s: &str) -> Option<TextureViewDimension> {
    Some(match s {
        "2d" => TextureViewDimension::D2,
        "2d-array" => TextureViewDimension::D2Array,
        "cube" => TextureViewDimension::Cube,
        _ => return None,
    })
}

fn aspect(s: &str) -> Option<TextureAspect> {
    Some(match s {
        "all" => TextureAspect::All,
        "depth-only" => TextureAspect::DepthOnly,
        _ => return None,
    })
}

pub(crate) fn view(d: Obj) -> R<TextureViewDescriptor<'static>> {
    Ok(TextureViewDescriptor {
        label: None,
        format: d.opt_enum("format", texture_format)?,
        dimension: d.opt_enum("dimension", view_dimension)?,
        usage: None,
        aspect: d.enumeration("aspect", TextureAspect::All, aspect)?,
        base_mip_level: d.u32("baseMipLevel", 0)?,
        mip_level_count: d.opt_u32("mipLevelCount")?,
        base_array_layer: d.u32("baseArrayLayer", 0)?,
        array_layer_count: d.opt_u32("arrayLayerCount")?,
    })
}

fn address(s: &str) -> Option<AddressMode> {
    Some(match s {
        "clamp-to-edge" => AddressMode::ClampToEdge,
        "repeat" => AddressMode::Repeat,
        "mirror-repeat" => AddressMode::MirrorRepeat,
        _ => return None,
    })
}

fn filter(s: &str) -> Option<FilterMode> {
    Some(match s {
        "nearest" => FilterMode::Nearest,
        "linear" => FilterMode::Linear,
        _ => return None,
    })
}

fn mipmap_filter(s: &str) -> Option<MipmapFilterMode> {
    Some(match s {
        "nearest" => MipmapFilterMode::Nearest,
        "linear" => MipmapFilterMode::Linear,
        _ => return None,
    })
}

pub(crate) fn compare(s: &str) -> Option<CompareFunction> {
    Some(match s {
        "never" => CompareFunction::Never,
        "less" => CompareFunction::Less,
        "equal" => CompareFunction::Equal,
        "less-equal" => CompareFunction::LessEqual,
        "greater" => CompareFunction::Greater,
        "not-equal" => CompareFunction::NotEqual,
        "greater-equal" => CompareFunction::GreaterEqual,
        "always" => CompareFunction::Always,
        _ => return None,
    })
}

pub(crate) fn sampler(d: Obj) -> R<SamplerDescriptor<'static>> {
    let anisotropy = d.u32("maxAnisotropy", 1)?;
    Ok(SamplerDescriptor {
        label: None,
        address_mode_u: d.enumeration("addressModeU", AddressMode::ClampToEdge, address)?,
        address_mode_v: d.enumeration("addressModeV", AddressMode::ClampToEdge, address)?,
        address_mode_w: d.enumeration("addressModeW", AddressMode::ClampToEdge, address)?,
        mag_filter: d.enumeration("magFilter", FilterMode::Nearest, filter)?,
        min_filter: d.enumeration("minFilter", FilterMode::Nearest, filter)?,
        mipmap_filter: d.enumeration("mipmapFilter", MipmapFilterMode::Nearest, mipmap_filter)?,
        lod_min_clamp: d.f64("lodMinClamp", 0.0)? as f32,
        lod_max_clamp: d.f64("lodMaxClamp", 32.0)? as f32,
        compare: d.opt_enum("compare", compare)?,
        anisotropy_clamp: anisotropy.min(u16::MAX as u32) as u16,
        border_color: None,
    })
}

fn buffer_binding_type(s: &str) -> Option<BufferBindingType> {
    Some(match s {
        "uniform" => BufferBindingType::Uniform,
        "storage" => BufferBindingType::Storage { read_only: false },
        "read-only-storage" => BufferBindingType::Storage { read_only: true },
        _ => return None,
    })
}

fn sampler_binding_type(s: &str) -> Option<SamplerBindingType> {
    Some(match s {
        "filtering" => SamplerBindingType::Filtering,
        "non-filtering" => SamplerBindingType::NonFiltering,
        "comparison" => SamplerBindingType::Comparison,
        _ => return None,
    })
}

fn sample_type(s: &str) -> Option<TextureSampleType> {
    Some(match s {
        "float" => TextureSampleType::Float { filterable: true },
        "unfilterable-float" => TextureSampleType::Float { filterable: false },
        "depth" => TextureSampleType::Depth,
        "sint" => TextureSampleType::Sint,
        "uint" => TextureSampleType::Uint,
        _ => return None,
    })
}

/// A bind group layout entry: one of `buffer`, `sampler`, `texture`.
pub(crate) fn layout_entry(e: Obj) -> R<BindGroupLayoutEntry> {
    let visibility = e.u32("visibility", 0)?;
    let Some(visibility) = ShaderStages::from_bits(visibility).filter(|_| visibility <= 7) else {
        return fail(format!("visibility {visibility} is not in the subset"));
    };
    if e.has("storageTexture") || e.has("externalTexture") {
        return fail("storage and external textures are not in the subset");
    }
    let ty = if let Some(b) = e.obj("buffer")? {
        let min = b.u64("minBindingSize", 0)?;
        BindingType::Buffer {
            ty: b.enumeration("type", BufferBindingType::Uniform, buffer_binding_type)?,
            has_dynamic_offset: b.bool("hasDynamicOffset", false)?,
            min_binding_size: BufferSize::new(min),
        }
    } else if let Some(s) = e.obj("sampler")? {
        BindingType::Sampler(s.enumeration(
            "type",
            SamplerBindingType::Filtering,
            sampler_binding_type,
        )?)
    } else if let Some(t) = e.obj("texture")? {
        BindingType::Texture {
            sample_type: t.enumeration(
                "sampleType",
                TextureSampleType::Float { filterable: true },
                sample_type,
            )?,
            view_dimension: t.enumeration(
                "viewDimension",
                TextureViewDimension::D2,
                view_dimension,
            )?,
            multisampled: t.bool("multisampled", false)?,
        }
    } else {
        return fail("a bind group layout entry needs buffer, sampler or texture");
    };
    Ok(BindGroupLayoutEntry {
        binding: e.u32("binding", 0)?,
        visibility,
        ty,
        count: None,
    })
}

pub(crate) fn vertex_format(s: &str) -> Option<VertexFormat> {
    use VertexFormat::*;
    Some(match s {
        "uint8" => Uint8,
        "uint8x2" => Uint8x2,
        "uint8x4" => Uint8x4,
        "sint8" => Sint8,
        "sint8x2" => Sint8x2,
        "sint8x4" => Sint8x4,
        "unorm8" => Unorm8,
        "unorm8x2" => Unorm8x2,
        "unorm8x4" => Unorm8x4,
        "snorm8" => Snorm8,
        "snorm8x2" => Snorm8x2,
        "snorm8x4" => Snorm8x4,
        "uint16" => Uint16,
        "uint16x2" => Uint16x2,
        "uint16x4" => Uint16x4,
        "sint16" => Sint16,
        "sint16x2" => Sint16x2,
        "sint16x4" => Sint16x4,
        "unorm16" => Unorm16,
        "unorm16x2" => Unorm16x2,
        "unorm16x4" => Unorm16x4,
        "snorm16" => Snorm16,
        "snorm16x2" => Snorm16x2,
        "snorm16x4" => Snorm16x4,
        "float16" => Float16,
        "float16x2" => Float16x2,
        "float16x4" => Float16x4,
        "float32" => Float32,
        "float32x2" => Float32x2,
        "float32x3" => Float32x3,
        "float32x4" => Float32x4,
        "uint32" => Uint32,
        "uint32x2" => Uint32x2,
        "uint32x3" => Uint32x3,
        "uint32x4" => Uint32x4,
        "sint32" => Sint32,
        "sint32x2" => Sint32x2,
        "sint32x3" => Sint32x3,
        "sint32x4" => Sint32x4,
        "unorm10-10-10-2" => Unorm10_10_10_2,
        "unorm8x4-bgra" => Unorm8x4Bgra,
        _ => return None,
    })
}

fn step_mode(s: &str) -> Option<VertexStepMode> {
    Some(match s {
        "vertex" => VertexStepMode::Vertex,
        "instance" => VertexStepMode::Instance,
        _ => return None,
    })
}

/// A vertex buffer layout, its attributes in `attrs` (wgpu borrows them).
pub(crate) fn vertex_buffer(b: Obj, attrs: &mut Vec<VertexAttribute>) -> R<(u64, VertexStepMode)> {
    for a in b.list("attributes")? {
        let a = Obj::of(Some(a), "an attribute")?;
        attrs.push(VertexAttribute {
            format: a.enumeration("format", VertexFormat::Float32, vertex_format)?,
            offset: a.u64("offset", 0)?,
            shader_location: a.u32("shaderLocation", 0)?,
        });
    }
    Ok((
        b.u64("arrayStride", 0)?,
        b.enumeration("stepMode", VertexStepMode::Vertex, step_mode)?,
    ))
}

fn topology(s: &str) -> Option<PrimitiveTopology> {
    Some(match s {
        "point-list" => PrimitiveTopology::PointList,
        "line-list" => PrimitiveTopology::LineList,
        "line-strip" => PrimitiveTopology::LineStrip,
        "triangle-list" => PrimitiveTopology::TriangleList,
        "triangle-strip" => PrimitiveTopology::TriangleStrip,
        _ => return None,
    })
}

pub(crate) fn index_format(s: &str) -> Option<IndexFormat> {
    Some(match s {
        "uint16" => IndexFormat::Uint16,
        "uint32" => IndexFormat::Uint32,
        _ => return None,
    })
}

fn front_face(s: &str) -> Option<FrontFace> {
    Some(match s {
        "ccw" => FrontFace::Ccw,
        "cw" => FrontFace::Cw,
        _ => return None,
    })
}

fn cull(s: &str) -> Option<Option<Face>> {
    Some(match s {
        "none" => None,
        "front" => Some(Face::Front),
        "back" => Some(Face::Back),
        _ => return None,
    })
}

pub(crate) fn primitive(p: Obj) -> R<PrimitiveState> {
    if p.bool("unclippedDepth", false)? {
        return fail("unclippedDepth is not in the subset");
    }
    Ok(PrimitiveState {
        topology: p.enumeration("topology", PrimitiveTopology::TriangleList, topology)?,
        strip_index_format: p.opt_enum("stripIndexFormat", index_format)?,
        front_face: p.enumeration("frontFace", FrontFace::Ccw, front_face)?,
        cull_mode: p.enumeration("cullMode", None, cull)?,
        unclipped_depth: false,
        polygon_mode: PolygonMode::Fill,
        conservative: false,
    })
}

pub(crate) fn depth_stencil(d: Obj) -> R<DepthStencilState> {
    Ok(DepthStencilState {
        format: d.enumeration("format", TextureFormat::Depth24Plus, texture_format)?,
        depth_write_enabled: d
            .get("depthWriteEnabled")
            .map(|_| d.bool("depthWriteEnabled", false))
            .transpose()?,
        depth_compare: d.opt_enum("depthCompare", compare)?,
        stencil: StencilState::default(),
        bias: DepthBiasState {
            constant: match d.get("depthBias") {
                None => 0,
                Some(Arg::Num(n))
                    if n.fract() == 0.0 && *n >= i32::MIN as f64 && *n <= i32::MAX as f64 =>
                {
                    *n as i32
                }
                Some(_) => return fail("depthBias must be an integer"),
            },
            slope_scale: d.f64("depthBiasSlopeScale", 0.0)? as f32,
            clamp: d.f64("depthBiasClamp", 0.0)? as f32,
        },
    })
}

fn blend_factor(s: &str) -> Option<BlendFactor> {
    use BlendFactor::*;
    Some(match s {
        "zero" => Zero,
        "one" => One,
        "src" => Src,
        "one-minus-src" => OneMinusSrc,
        "src-alpha" => SrcAlpha,
        "one-minus-src-alpha" => OneMinusSrcAlpha,
        "dst" => Dst,
        "one-minus-dst" => OneMinusDst,
        "dst-alpha" => DstAlpha,
        "one-minus-dst-alpha" => OneMinusDstAlpha,
        "src-alpha-saturated" => SrcAlphaSaturated,
        "constant" => Constant,
        "one-minus-constant" => OneMinusConstant,
        _ => return None,
    })
}

fn blend_operation(s: &str) -> Option<BlendOperation> {
    Some(match s {
        "add" => BlendOperation::Add,
        "subtract" => BlendOperation::Subtract,
        "reverse-subtract" => BlendOperation::ReverseSubtract,
        "min" => BlendOperation::Min,
        "max" => BlendOperation::Max,
        _ => return None,
    })
}

fn blend_component(c: Obj) -> R<BlendComponent> {
    Ok(BlendComponent {
        src_factor: c.enumeration("srcFactor", BlendFactor::One, blend_factor)?,
        dst_factor: c.enumeration("dstFactor", BlendFactor::Zero, blend_factor)?,
        operation: c.enumeration("operation", BlendOperation::Add, blend_operation)?,
    })
}

pub(crate) fn color_target(t: Obj) -> R<ColorTargetState> {
    let blend = match t.obj("blend")? {
        None => None,
        Some(b) => Some(BlendState {
            color: blend_component(Obj::of(b.get("color"), "color")?)?,
            alpha: blend_component(Obj::of(b.get("alpha"), "alpha")?)?,
        }),
    };
    let mask = t.u32("writeMask", 0xF)?;
    let Some(write_mask) = ColorWrites::from_bits(mask) else {
        return fail(format!("writeMask {mask} is not a color write mask"));
    };
    Ok(ColorTargetState {
        format: t.enumeration("format", TextureFormat::Rgba8Unorm, texture_format)?,
        blend,
        write_mask,
    })
}

pub(crate) fn multisample(m: Obj) -> R<MultisampleState> {
    Ok(MultisampleState {
        count: m.u32("count", 1)?,
        mask: m.u64("mask", 0xFFFF_FFFF)?,
        alpha_to_coverage_enabled: m.bool("alphaToCoverageEnabled", false)?,
    })
}

pub(crate) fn color(a: Option<&Arg>) -> R<Color> {
    let c = match a {
        None | Some(Arg::Null) => [0.0; 4],
        Some(Arg::List(l)) if l.len() == 4 => {
            let mut c = [0.0; 4];
            for (i, v) in l.iter().enumerate() {
                c[i] = num(Some(v), "clearValue")?;
            }
            c
        }
        Some(Arg::Obj(_)) => {
            let o = Obj::of(a, "clearValue")?;
            let mut c = [0.0; 4];
            for (i, k) in ["r", "g", "b", "a"].into_iter().enumerate() {
                c[i] = num(o.get(k), "clearValue")?;
            }
            c
        }
        Some(_) => return fail("clearValue must be 4 numbers"),
    };
    Ok(Color {
        r: c[0],
        g: c[1],
        b: c[2],
        a: c[3],
    })
}

pub(crate) fn load_op(s: &str) -> Option<bool> {
    match s {
        "clear" => Some(true),
        "load" => Some(false),
        _ => None,
    }
}

pub(crate) fn store_op(s: &str) -> Option<StoreOp> {
    Some(match s {
        "store" => StoreOp::Store,
        "discard" => StoreOp::Discard,
        _ => return None,
    })
}
