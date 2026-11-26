//! The host checks (`README.md`, Host checks; opencode `packages/widget/src/gpu.ts`, which this follows line for
//! line): every op's shape, the handles it names and the limits, without a GPU and with exact messages. A batch
//! that fails them isn't replayed.

use std::collections::HashMap;
use std::fmt;

use crate::Arg;

pub(crate) const OPS: usize = 20_000;
pub(crate) const BYTES: usize = 4 * 1024 * 1024;
pub(crate) const PASSES: u32 = 16;
pub(crate) const DRAWS: u32 = 10_000;
pub(crate) const HANDLES: usize = 4096;
pub(crate) const RESOURCES: f64 = 256.0 * 1024.0 * 1024.0;
pub(crate) const SHADER: f64 = 256.0 * 1024.0;
pub(crate) const BUFFER: f64 = 64.0 * 1024.0 * 1024.0;
pub(crate) const DIMENSION: f64 = 4096.0;
pub(crate) const LAYERS: f64 = 256.0;

const TEXTURE_FORMATS: [(&str, f64); 7] = [
    ("rgba8unorm", 4.0),
    ("rgba8unorm-srgb", 4.0),
    ("bgra8unorm", 4.0),
    ("r8unorm", 1.0),
    ("rgba16float", 8.0),
    ("depth24plus", 4.0),
    ("depth32float", 4.0),
];
const TEXTURE_FORMAT_NAMES: [&str; TEXTURE_FORMATS.len()] = {
    let mut names = [""; TEXTURE_FORMATS.len()];
    let mut i = 0;
    while i < names.len() {
        names[i] = TEXTURE_FORMATS[i].0;
        i += 1;
    }
    names
};
const COLOR_FORMATS: &[&str] = &[
    "rgba8unorm",
    "rgba8unorm-srgb",
    "bgra8unorm",
    "r8unorm",
    "rgba16float",
];
const DEPTH_FORMATS: &[&str] = &["depth24plus", "depth32float"];
const VERTEX_FORMATS: &[&str] = &[
    "uint8x2",
    "uint8x4",
    "sint8x2",
    "sint8x4",
    "unorm8x2",
    "unorm8x4",
    "snorm8x2",
    "snorm8x4",
    "uint16x2",
    "uint16x4",
    "sint16x2",
    "sint16x4",
    "unorm16x2",
    "unorm16x4",
    "snorm16x2",
    "snorm16x4",
    "float16x2",
    "float16x4",
    "float32",
    "float32x2",
    "float32x3",
    "float32x4",
    "uint32",
    "uint32x2",
    "uint32x3",
    "uint32x4",
    "sint32",
    "sint32x2",
    "sint32x3",
    "sint32x4",
];
const COMPARE: &[&str] = &[
    "never",
    "less",
    "equal",
    "less-equal",
    "greater",
    "not-equal",
    "greater-equal",
    "always",
];
const FACTORS: &[&str] = &[
    "zero",
    "one",
    "src",
    "one-minus-src",
    "src-alpha",
    "one-minus-src-alpha",
    "dst",
    "one-minus-dst",
    "dst-alpha",
    "one-minus-dst-alpha",
    "src-alpha-saturated",
    "constant",
    "one-minus-constant",
];
const BUFFER_USAGE: &[(&str, i32)] = &[
    ("COPY_SRC", 4),
    ("COPY_DST", 8),
    ("INDEX", 16),
    ("VERTEX", 32),
    ("UNIFORM", 64),
    ("STORAGE", 128),
];
const TEXTURE_USAGE: &[(&str, i32)] = &[
    ("COPY_SRC", 1),
    ("COPY_DST", 2),
    ("TEXTURE_BINDING", 4),
    ("RENDER_ATTACHMENT", 16),
];
const STAGES: &[(&str, i32)] = &[("VERTEX", 1), ("FRAGMENT", 2)];

/// The ops and their number of arguments after the name.
fn arity(name: &str) -> Option<usize> {
    Some(match name {
        "end" | "submit" => 0,
        "destroy" | "pass" | "setPipeline" | "error" => 1,
        "sampler" | "shader" | "bindGroupLayout" | "pipelineLayout" | "renderPipeline"
        | "bindGroup" => 2,
        "buffer" | "view" | "autoLayout" | "setBindGroup" => 3,
        "context" | "writeBuffer" | "setVertexBuffer" | "setIndexBuffer" | "setScissorRect"
        | "draw" => 4,
        "copyBufferToBuffer" | "drawIndexed" => 5,
        "setViewport" => 6,
        "copyTextureToTexture" => 7,
        "texture" | "writeTexture" | "copyBufferToTexture" => 8,
        _ => return None,
    })
}

fn in_pass(name: &str) -> bool {
    matches!(
        name,
        "setPipeline"
            | "setBindGroup"
            | "setVertexBuffer"
            | "setIndexBuffer"
            | "setViewport"
            | "setScissorRect"
            | "draw"
            | "drawIndexed"
            | "end"
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Context,
    Buffer,
    Texture,
    View,
    Sampler,
    Shader,
    BindGroupLayout,
    PipelineLayout,
    RenderPipeline,
    BindGroup,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Context => "context",
            Kind::Buffer => "buffer",
            Kind::Texture => "texture",
            Kind::View => "view",
            Kind::Sampler => "sampler",
            Kind::Shader => "shader",
            Kind::BindGroupLayout => "bindGroupLayout",
            Kind::PipelineLayout => "pipelineLayout",
            Kind::RenderPipeline => "renderPipeline",
            Kind::BindGroup => "bindGroup",
        }
    }
}

struct Handle {
    kind: Kind,
    /// A buffer's or texture's bytes as allocated.
    bytes: f64,
    /// A view's texture.
    texture: f64,
    /// A context's key.
    key: Option<String>,
    destroyed: bool,
}

/// Why a batch fails the checks.
pub(crate) enum Invalid {
    Msg(String),
    /// `no handle <h>`: as a batch's first failure, a batch from before a device loss when `h` is from 1 to the
    /// greatest handle made before it.
    Missing(f64),
}

type C<T> = Result<T, Invalid>;

fn fail<T>(m: impl Into<String>) -> C<T> {
    Err(Invalid::Msg(m.into()))
}

/// A value as JavaScript has it: `None` is `undefined` (a missing member), `Some(Null)` is `null`.
type V<'a> = Option<&'a Arg>;

/// Where a value is, for an error message (`"view" argument 3.dimension`): written out only when a check fails.
#[derive(Clone, Copy)]
enum Path<'a> {
    /// `"<op>" argument <i>`.
    Arg(&'a str, usize),
    /// What a limit counts, as it is.
    Text(&'a str),
    /// `<path>.<field>`.
    Field(&'a Path<'a>, &'a str),
    /// `<path>[<i>]`.
    Index(&'a Path<'a>, usize),
}

impl<'a> Path<'a> {
    fn field(&'a self, field: &'a str) -> Path<'a> {
        Path::Field(self, field)
    }
    fn index(&'a self, i: usize) -> Path<'a> {
        Path::Index(self, i)
    }
}

impl fmt::Display for Path<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Path::Arg(op, i) => write!(f, "\"{op}\" argument {i}"),
            Path::Text(t) => f.write_str(t),
            Path::Field(p, field) => write!(f, "{p}.{field}"),
            Path::Index(p, i) => write!(f, "{p}[{i}]"),
        }
    }
}

fn num(n: f64) -> String {
    format!("{n}")
}

fn whole(v: V, path: Path) -> C<f64> {
    match v {
        Some(Arg::Num(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 => Ok(*n),
        _ => fail(format!("{path} must be a whole number")),
    }
}

fn whole_or_all(v: V, path: Path) -> C<f64> {
    match v {
        Some(Arg::Num(n)) if *n == -1.0 || (n.is_finite() && n.fract() == 0.0 && *n >= 0.0) => {
            Ok(*n)
        }
        _ => fail(format!("{path} must be a whole number or -1")),
    }
}

fn integer(v: V, path: Path) -> C<f64> {
    match v {
        Some(Arg::Num(n)) if n.is_finite() && n.fract() == 0.0 => Ok(*n),
        _ => fail(format!("{path} must be an integer")),
    }
}

fn finite(v: V, path: Path) -> C<f64> {
    match v {
        Some(Arg::Num(n)) if n.is_finite() => Ok(*n),
        _ => fail(format!("{path} must be a finite number")),
    }
}

fn boolean(v: V, path: Path) -> C<bool> {
    match v {
        Some(Arg::Bool(b)) => Ok(*b),
        _ => fail(format!("{path} must be true or false")),
    }
}

fn text<'a>(v: V<'a>, path: Path) -> C<&'a str> {
    match v {
        Some(Arg::Str(s)) => Ok(s),
        _ => fail(format!("{path} must be a string")),
    }
}

fn one_of<'a>(v: V<'a>, options: &[&str], path: Path) -> C<&'a str> {
    match v {
        Some(Arg::Str(s)) if options.contains(&s.as_str()) => Ok(s),
        _ => fail(format!("{path} must be one of {}", options.join(", "))),
    }
}

/// `1` or `4` (a sample count).
fn samples(v: V, path: Path) -> C<f64> {
    match v {
        Some(Arg::Num(n)) if *n == 1.0 || *n == 4.0 => Ok(*n),
        _ => fail(format!("{path} must be one of 1, 4")),
    }
}

fn list<'a>(v: V<'a>, path: Path, length: Option<usize>) -> C<&'a [Arg]> {
    match (v, length) {
        (Some(Arg::List(l)), None) => Ok(l),
        (Some(Arg::List(l)), Some(n)) if l.len() == n => Ok(l),
        (_, None) => fail(format!("{path} must be a list")),
        (_, Some(n)) => fail(format!("{path} must be a list of {n}")),
    }
}

#[derive(Clone, Copy)]
struct Rec<'a>(&'a [(String, Arg)]);

impl<'a> Rec<'a> {
    fn get(self, k: &str) -> V<'a> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    fn has(self, k: &str) -> bool {
        self.0.iter().any(|(n, _)| n == k)
    }
}

fn record<'a>(v: V<'a>, path: Path) -> C<Rec<'a>> {
    match v {
        Some(Arg::Obj(o)) => Ok(Rec(o)),
        _ => fail(format!("{path} must be an object")),
    }
}

fn is_null(v: V) -> bool {
    matches!(v, Some(Arg::Null))
}

/// JavaScript's `ToInt32`, as `value & ~all` applies it.
fn int32(n: f64) -> i32 {
    n.rem_euclid(4_294_967_296.0) as u32 as i32
}

fn flags(v: V, names: &[(&str, i32)], path: Path) -> C<f64> {
    let all = names.iter().fold(0, |sum, (_, bit)| sum | bit);
    match v {
        Some(Arg::Num(n))
            if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && int32(*n) & !all == 0 =>
        {
            Ok(*n)
        }
        _ => {
            let names: Vec<_> = names.iter().map(|(n, _)| *n).collect();
            fail(format!("{path} must combine {}", names.join(", ")))
        }
    }
}

fn limit(value: f64, max: f64, what: Path) -> C<f64> {
    if value > max {
        fail(format!("{what} is over the limit of {}", num(max)))
    } else {
        Ok(value)
    }
}

fn triple(v: V, path: Path) -> C<()> {
    for (i, item) in list(v, path, Some(3))?.iter().enumerate() {
        whole(Some(item), path.index(i))?;
    }
    Ok(())
}

/// A texture's bytes as allocated: texels × bytes per texel × layers × samples, over the mips (with JavaScript's
/// shifts, which take the count modulo 32).
fn texture_bytes(width: f64, height: f64, layers: f64, texel: f64, samples: f64, mips: f64) -> f64 {
    let level = |mip: u32| {
        let w = ((width as u32) >> (mip & 31)).max(1) as f64;
        let h = ((height as u32) >> (mip & 31)).max(1) as f64;
        w * h * layers * texel * samples
    };
    let period: f64 = (0..32).map(level).sum();
    let full = (mips / 32.0).floor();
    let rest = (mips - full * 32.0) as u32;
    full * period + (0..rest).map(level).sum::<f64>()
}

/// A batch's first error: its message, and whether it named a handle from before a device loss.
pub(crate) enum Failed {
    /// The message, and how many ops came before the failure (they take effect, as separate calls would); `None`
    /// for the batch itself (it doesn't replay).
    Message(String, Option<usize>),
    Stale,
}

#[derive(Default)]
pub(crate) struct Checks {
    handles: HashMap<u64, Handle>,
    last: f64,
    live: usize,
    pub(crate) resources: f64,
    passes: u32,
    draws: u32,
    /// Handles up to this one are from before the last device loss.
    stale: f64,
}

impl Checks {
    /// The greatest handle made.
    pub(crate) fn last(&self) -> f64 {
        self.last
    }

    /// Handles up to `last` were made before (a run restored from a snapshot): new ones count up from it.
    pub(crate) fn made(&mut self, last: f64) {
        self.last = self.last.max(last);
    }

    /// The device is lost: every handle is gone; new ones keep counting up.
    pub(crate) fn lost(&mut self) {
        self.handles.clear();
        self.live = 0;
        self.resources = 0.0;
        self.stale = self.last;
    }

    fn find(&self, v: V, path: Path, kinds: &[Kind]) -> C<&Handle> {
        let h = whole(v, path)?;
        let Some(found) = self.handles.get(&(h as u64)) else {
            return Err(Invalid::Missing(h));
        };
        if !kinds.contains(&found.kind) {
            let names: Vec<_> = kinds.iter().map(|k| k.name()).collect();
            return fail(format!(
                "handle {} is a {}, not a {}",
                num(h),
                found.kind.name(),
                names.join(" or ")
            ));
        }
        if found.destroyed {
            return fail(format!("handle {} was destroyed", num(h)));
        }
        Ok(found)
    }

    /// A canvas's texture has usage `RENDER_ATTACHMENT` alone: no copy, write or binding may use it.
    fn not_canvas(&self, h: f64, path: Path) -> C<()> {
        match self.handles.get(&(h as u64)) {
            Some(Handle {
                kind: Kind::Context,
                key: Some(key),
                ..
            }) => fail(format!(
                "{path} uses canvas \"{key}\"'s texture, which can only be rendered into"
            )),
            _ => Ok(()),
        }
    }

    /// A texture a copy or a write takes.
    fn copied(&self, v: V, path: Path) -> C<()> {
        self.not_canvas(whole(v, path)?, path)?;
        self.find(v, path, &[Kind::Texture]).map(|_| ())
    }

    fn create(&mut self, v: V, path: Path, made: Handle) -> C<()> {
        let h = whole(v, path)?;
        if h <= self.last {
            return fail(format!("handle {} was already used", num(h)));
        }
        self.last = h;
        let bytes = made.bytes;
        self.handles.insert(h as u64, made);
        self.live += 1;
        limit(
            self.live as f64,
            HANDLES as f64,
            Path::Text("the number of live handles"),
        )?;
        if bytes != 0.0 {
            self.resources += bytes;
            limit(
                self.resources,
                RESOURCES,
                Path::Text("the size of buffers and textures"),
            )?;
        }
        Ok(())
    }

    fn make(kind: Kind) -> Handle {
        Handle {
            kind,
            bytes: 0.0,
            texture: 0.0,
            key: None,
            destroyed: false,
        }
    }

    fn free(&mut self, h: f64) {
        let Some(found) = self.handles.get_mut(&(h as u64)) else {
            return;
        };
        found.destroyed = true;
        self.live -= 1;
        self.resources -= found.bytes;
        for other in self.handles.values_mut() {
            if other.kind == Kind::View && other.texture == h && !other.destroyed {
                other.destroyed = true;
                self.live -= 1;
            }
        }
    }

    /// The keys of the canvases a batch renders into, in order: a pass's color attachment or resolve target that is
    /// a view of a context, made in this batch or earlier.
    pub(crate) fn rendered(&self, ops: &[Arg]) -> Vec<String> {
        let mut keys = Vec::new();
        self.rendered_into(ops, &mut keys);
        keys
    }

    /// [`Checks::rendered`] into `keys`, its strings written over (no allocation once they have room).
    pub(crate) fn rendered_into(&self, ops: &[Arg], keys: &mut Vec<String>) {
        let mut textures = HashMap::new();
        let mut contexts = HashMap::new();
        let mut count = 0;
        let num_at = |o: &[Arg], i: usize| match o.get(i) {
            Some(Arg::Num(n)) => Some(*n),
            _ => None,
        };
        for o in ops {
            let Arg::List(o) = o else { continue };
            let Some(h) = num_at(o, 1) else { continue };
            match (o.first(), o.get(2)) {
                (Some(Arg::Str(n)), Some(Arg::Str(key))) if n == "context" => {
                    contexts.insert(h.to_bits(), key.as_str());
                }
                (Some(Arg::Str(n)), Some(Arg::Num(t))) if n == "view" => {
                    textures.insert(h.to_bits(), *t);
                }
                _ => {}
            }
        }
        let context = |h: f64| {
            contexts.get(&h.to_bits()).copied().or_else(|| {
                self.handles
                    .get(&(h as u64))
                    .filter(|f| f.kind == Kind::Context && h.fract() == 0.0 && h >= 0.0)
                    .and_then(|f| f.key.as_deref())
            })
        };
        for o in ops {
            let Arg::List(o) = o else { continue };
            let (Some(Arg::Str(n)), Some(Arg::Obj(d))) = (o.first(), o.get(1)) else {
                continue;
            };
            if n != "pass" {
                continue;
            }
            let Some(Arg::List(attachments)) = Rec(d).get("colorAttachments") else {
                continue;
            };
            for a in attachments {
                let Arg::Obj(a) = a else { continue };
                for member in ["view", "resolveTarget"] {
                    let Some(Arg::Num(view)) = Rec(a).get(member) else {
                        continue;
                    };
                    let texture = textures.get(&view.to_bits()).copied().or_else(|| {
                        self.handles
                            .get(&(*view as u64))
                            .filter(|f| f.kind == Kind::View && view.fract() == 0.0 && *view >= 0.0)
                            .map(|f| f.texture)
                    });
                    if let Some(key) = texture.and_then(context)
                        && !keys[..count].iter().any(|k| k == key)
                    {
                        match keys.get_mut(count) {
                            Some(k) => {
                                k.clear();
                                k.push_str(key);
                            }
                            None => keys.push(key.to_owned()),
                        }
                        count += 1;
                    }
                }
            }
        }
        keys.truncate(count);
    }

    /// A frame request: the per-frame counts start again.
    pub(crate) fn end_frame(&mut self) {
        self.passes = 0;
        self.draws = 0;
    }

    /// Checks a batch.
    pub(crate) fn batch(
        &mut self,
        ops: &[Arg],
        bytes: usize,
        canvas: &dyn Fn(&str) -> bool,
    ) -> Result<(), Failed> {
        self.ops(ops, bytes, canvas)
    }

    fn ops(
        &mut self,
        ops: &[Arg],
        bytes: usize,
        canvas: &dyn Fn(&str) -> bool,
    ) -> Result<(), Failed> {
        let stale = self.stale;
        let failed = move |e: Invalid, at: Option<usize>| {
            let prefix = at.map_or(String::new(), |i| format!("gpu op {i}: "));
            match e {
                Invalid::Missing(h) if h >= 1.0 && h <= stale => Failed::Stale,
                Invalid::Missing(h) => Failed::Message(format!("{prefix}no handle {}", num(h)), at),
                Invalid::Msg(m) => Failed::Message(format!("{prefix}{m}"), at),
            }
        };
        limit(
            ops.len() as f64,
            OPS as f64,
            Path::Text("the number of ops in a batch"),
        )
        .map_err(|e| failed(e, None))?;
        limit(
            bytes as f64,
            BYTES as f64,
            Path::Text("the size of a batch's bytes"),
        )
        .map_err(|e| failed(e, None))?;
        let mut open = false;
        for (index, o) in ops.iter().enumerate() {
            self.op(o, &mut open, bytes, canvas)
                .map_err(|e| failed(e, Some(index)))?;
        }
        if open {
            return Err(Failed::Message(
                "a render pass is still open at the end of the batch".into(),
                Some(ops.len()),
            ));
        }
        Ok(())
    }

    fn op(
        &mut self,
        o: &Arg,
        open: &mut bool,
        bytes: usize,
        canvas: &dyn Fn(&str) -> bool,
    ) -> C<()> {
        let (name, o) = match o {
            Arg::List(l) => match l.first() {
                Some(Arg::Str(name)) => (name.as_str(), l.as_slice()),
                _ => return fail("an op is a list that starts with its name"),
            },
            _ => return fail("an op is a list that starts with its name"),
        };
        let Some(arity) = arity(name) else {
            return fail(format!("unknown op \"{name}\""));
        };
        if o.len() != arity + 1 {
            return fail(format!("\"{name}\" takes {arity} arguments"));
        }
        if name == "error" {
            return fail(text(o.get(1), Path::Arg(name, 1))?);
        }
        if name == "pass" {
            if *open {
                return fail("\"pass\" inside a render pass");
            }
            self.pass(o.get(1))?;
            *open = true;
            return Ok(());
        }
        if in_pass(name) && !*open {
            return fail(format!("\"{name}\" outside a render pass"));
        }
        if !in_pass(name) && *open {
            return fail(format!("\"{name}\" inside a render pass"));
        }
        if name == "end" {
            *open = false;
            return Ok(());
        }
        self.args(name, o, bytes, canvas)
    }

    fn args(
        &mut self,
        name: &str,
        o: &[Arg],
        bytes: usize,
        canvas: &dyn Fn(&str) -> bool,
    ) -> C<()> {
        let a = |i: usize| Path::Arg(name, i);
        let at = |i: usize| o.get(i);
        match name {
            "context" => {
                let key = text(at(2), a(2))?;
                one_of(at(3), &["bgra8unorm", "rgba8unorm"], a(3))?;
                one_of(at(4), &["opaque", "premultiplied"], a(4))?;
                if !canvas(key) {
                    return fail(format!("no GPU canvas with key \"{key}\""));
                }
                let h = whole(at(1), a(1))?;
                if let Some(e) = self.handles.get(&(h as u64))
                    && e.kind == Kind::Context
                    && e.key.as_deref() == Some(key)
                {
                    return Ok(());
                }
                self.create(
                    at(1),
                    a(1),
                    Handle {
                        key: Some(key.to_owned()),
                        ..Self::make(Kind::Context)
                    },
                )
            }
            "buffer" => {
                let size = limit(whole(at(2), a(2))?, BUFFER, a(2))?;
                flags(at(3), BUFFER_USAGE, a(3))?;
                self.create(
                    at(1),
                    a(1),
                    Handle {
                        bytes: size,
                        ..Self::make(Kind::Buffer)
                    },
                )
            }
            "texture" => {
                let width = limit(whole(at(2), a(2))?, DIMENSION, a(2))?;
                let height = limit(whole(at(3), a(3))?, DIMENSION, a(3))?;
                let layers = limit(whole(at(4), a(4))?, LAYERS, a(4))?;
                let format = one_of(at(5), &TEXTURE_FORMAT_NAMES, a(5))?;
                flags(at(6), TEXTURE_USAGE, a(6))?;
                let mips = whole(at(7), a(7))?;
                let samples = samples(at(8), a(8))?;
                let texel = TEXTURE_FORMATS
                    .iter()
                    .find(|(n, _)| *n == format)
                    .map_or(4.0, |(_, b)| *b);
                let bytes = texture_bytes(width, height, layers, texel, samples, mips);
                self.create(
                    at(1),
                    a(1),
                    Handle {
                        bytes,
                        ..Self::make(Kind::Texture)
                    },
                )
            }
            "view" => {
                let texture = whole(at(2), a(2))?;
                self.find(at(2), a(2), &[Kind::Texture, Kind::Context])?;
                let p = a(3);
                let d = record(at(3), p)?;
                one_of(
                    d.get("dimension"),
                    &["2d", "2d-array", "cube"],
                    p.field("dimension"),
                )?;
                for field in [
                    "baseMipLevel",
                    "mipLevelCount",
                    "baseArrayLayer",
                    "arrayLayerCount",
                ] {
                    whole(d.get(field), p.field(field))?;
                }
                self.create(
                    at(1),
                    a(1),
                    Handle {
                        texture,
                        ..Self::make(Kind::View)
                    },
                )
            }
            "sampler" => {
                let p = a(2);
                let d = record(at(2), p)?;
                for f in ["addressModeU", "addressModeV", "addressModeW"] {
                    one_of(
                        d.get(f),
                        &["clamp-to-edge", "repeat", "mirror-repeat"],
                        p.field(f),
                    )?;
                }
                for f in ["magFilter", "minFilter", "mipmapFilter"] {
                    one_of(d.get(f), &["nearest", "linear"], p.field(f))?;
                }
                finite(d.get("lodMinClamp"), p.field("lodMinClamp"))?;
                finite(d.get("lodMaxClamp"), p.field("lodMaxClamp"))?;
                if !is_null(d.get("compare")) {
                    one_of(d.get("compare"), COMPARE, p.field("compare"))?;
                }
                whole(d.get("maxAnisotropy"), p.field("maxAnisotropy"))?;
                self.create(at(1), a(1), Self::make(Kind::Sampler))
            }
            "shader" => {
                limit(text(at(2), a(2))?.len() as f64, SHADER, a(2))?;
                self.create(at(1), a(1), Self::make(Kind::Shader))
            }
            "bindGroupLayout" => {
                let arg = a(2);
                let d = record(at(2), arg)?;
                let entries = arg.field("entries");
                for (i, item) in list(d.get("entries"), entries, None)?.iter().enumerate() {
                    let p = entries.index(i);
                    let e = record(Some(item), p)?;
                    whole(e.get("binding"), p.field("binding"))?;
                    flags(e.get("visibility"), STAGES, p.field("visibility"))?;
                    let present = ["buffer", "sampler", "texture"]
                        .iter()
                        .filter(|k| !is_null(e.get(k)))
                        .count();
                    if present != 1 {
                        return fail(format!(
                            "{p} needs exactly one of buffer, sampler and texture"
                        ));
                    }
                    if !is_null(e.get("buffer")) {
                        let w = p.field("buffer");
                        let b = record(e.get("buffer"), w)?;
                        one_of(
                            b.get("type"),
                            &["uniform", "storage", "read-only-storage"],
                            w.field("type"),
                        )?;
                        boolean(b.get("hasDynamicOffset"), w.field("hasDynamicOffset"))?;
                        whole(b.get("minBindingSize"), w.field("minBindingSize"))?;
                    }
                    if !is_null(e.get("sampler")) {
                        let w = p.field("sampler");
                        let s = record(e.get("sampler"), w)?;
                        one_of(
                            s.get("type"),
                            &["filtering", "non-filtering", "comparison"],
                            w.field("type"),
                        )?;
                    }
                    if !is_null(e.get("texture")) {
                        let w = p.field("texture");
                        let t = record(e.get("texture"), w)?;
                        one_of(
                            t.get("sampleType"),
                            &["float", "unfilterable-float", "depth", "sint", "uint"],
                            w.field("sampleType"),
                        )?;
                        one_of(
                            t.get("viewDimension"),
                            &["2d", "2d-array", "cube"],
                            w.field("viewDimension"),
                        )?;
                        boolean(t.get("multisampled"), w.field("multisampled"))?;
                    }
                }
                self.create(at(1), a(1), Self::make(Kind::BindGroupLayout))
            }
            "pipelineLayout" => {
                let p = a(2);
                for (i, item) in list(at(2), p, None)?.iter().enumerate() {
                    self.find(Some(item), p.index(i), &[Kind::BindGroupLayout])?;
                }
                self.create(at(1), a(1), Self::make(Kind::PipelineLayout))
            }
            "renderPipeline" => {
                self.pipeline(record(at(2), a(2))?, a(2))?;
                self.create(at(1), a(1), Self::make(Kind::RenderPipeline))
            }
            "autoLayout" => {
                self.find(at(2), a(2), &[Kind::RenderPipeline])?;
                whole(at(3), a(3))?;
                self.create(at(1), a(1), Self::make(Kind::BindGroupLayout))
            }
            "bindGroup" => {
                let arg = a(2);
                let d = record(at(2), arg)?;
                self.find(
                    d.get("layout"),
                    arg.field("layout"),
                    &[Kind::BindGroupLayout],
                )?;
                let entries = arg.field("entries");
                for (i, item) in list(d.get("entries"), entries, None)?.iter().enumerate() {
                    let p = entries.index(i);
                    let e = record(Some(item), p)?;
                    whole(e.get("binding"), p.field("binding"))?;
                    let w = p.field("resource");
                    let r = record(e.get("resource"), w)?;
                    if r.has("buffer") {
                        self.find(r.get("buffer"), w.field("buffer"), &[Kind::Buffer])?;
                        whole(r.get("offset"), w.field("offset"))?;
                        whole_or_all(r.get("size"), w.field("size"))?;
                    } else if r.has("sampler") {
                        self.find(r.get("sampler"), w.field("sampler"), &[Kind::Sampler])?;
                    } else if r.has("view") {
                        let path = w.field("view");
                        let texture = self.find(r.get("view"), path, &[Kind::View])?.texture;
                        self.not_canvas(texture, path)?;
                    } else {
                        return fail(format!("{w} must be a buffer binding, a sampler or a view"));
                    }
                }
                self.create(at(1), a(1), Self::make(Kind::BindGroup))
            }
            "destroy" => {
                let h = whole(at(1), a(1))?;
                self.find(at(1), a(1), &[Kind::Buffer, Kind::Texture])?;
                self.free(h);
                Ok(())
            }
            "writeBuffer" => {
                self.find(at(1), a(1), &[Kind::Buffer])?;
                whole(at(2), a(2))?;
                range(whole(at(3), a(3))?, whole(at(4), a(4))?, bytes)
            }
            "writeTexture" => {
                self.copied(at(1), a(1))?;
                whole(at(2), a(2))?;
                triple(at(3), a(3))?;
                range(whole(at(4), a(4))?, whole(at(5), a(5))?, bytes)?;
                whole(at(6), a(6))?;
                if !is_null(at(7)) {
                    whole(at(7), a(7))?;
                }
                triple(at(8), a(8))
            }
            "copyBufferToBuffer" => {
                self.find(at(1), a(1), &[Kind::Buffer])?;
                whole(at(2), a(2))?;
                self.find(at(3), a(3), &[Kind::Buffer])?;
                whole(at(4), a(4))?;
                whole(at(5), a(5)).map(|_| ())
            }
            "copyBufferToTexture" => {
                self.find(at(1), a(1), &[Kind::Buffer])?;
                whole(at(2), a(2))?;
                whole(at(3), a(3))?;
                if !is_null(at(4)) {
                    whole(at(4), a(4))?;
                }
                self.copied(at(5), a(5))?;
                whole(at(6), a(6))?;
                triple(at(7), a(7))?;
                triple(at(8), a(8))
            }
            "copyTextureToTexture" => {
                self.copied(at(1), a(1))?;
                whole(at(2), a(2))?;
                triple(at(3), a(3))?;
                self.copied(at(4), a(4))?;
                whole(at(5), a(5))?;
                triple(at(6), a(6))?;
                triple(at(7), a(7))
            }
            "setPipeline" => self.find(at(1), a(1), &[Kind::RenderPipeline]).map(|_| ()),
            "setBindGroup" => {
                whole(at(1), a(1))?;
                self.find(at(2), a(2), &[Kind::BindGroup])?;
                let p = a(3);
                for (i, item) in list(at(3), p, None)?.iter().enumerate() {
                    whole(Some(item), p.index(i))?;
                }
                Ok(())
            }
            "setVertexBuffer" => {
                whole(at(1), a(1))?;
                self.find(at(2), a(2), &[Kind::Buffer])?;
                whole(at(3), a(3))?;
                whole_or_all(at(4), a(4)).map(|_| ())
            }
            "setIndexBuffer" => {
                self.find(at(1), a(1), &[Kind::Buffer])?;
                one_of(at(2), &["uint16", "uint32"], a(2))?;
                whole(at(3), a(3))?;
                whole_or_all(at(4), a(4)).map(|_| ())
            }
            "setViewport" => (1..=6).try_for_each(|i| finite(at(i), a(i)).map(|_| ())),
            "setScissorRect" => (1..=4).try_for_each(|i| whole(at(i), a(i)).map(|_| ())),
            "draw" | "drawIndexed" => {
                for i in 1..o.len() {
                    if name == "drawIndexed" && i == 4 {
                        integer(at(i), a(i))?
                    } else {
                        whole(at(i), a(i))?
                    };
                }
                self.draws += 1;
                limit(
                    self.draws as f64,
                    DRAWS as f64,
                    Path::Text("the number of draws in a frame"),
                )
                .map(|_| ())
            }
            "submit" => Ok(()),
            _ => unreachable!("every op with an arity is checked"),
        }
    }

    fn pipeline(&self, d: Rec, at: Path) -> C<()> {
        if !matches!(d.get("layout"), Some(Arg::Str(s)) if s == "auto") {
            self.find(d.get("layout"), at.field("layout"), &[Kind::PipelineLayout])?;
        }
        let p = at.field("vertex");
        let vertex = record(d.get("vertex"), p)?;
        self.find(vertex.get("module"), p.field("module"), &[Kind::Shader])?;
        if !is_null(vertex.get("entryPoint")) {
            text(vertex.get("entryPoint"), p.field("entryPoint"))?;
        }
        let buffers = p.field("buffers");
        for (i, item) in list(vertex.get("buffers"), buffers, None)?
            .iter()
            .enumerate()
        {
            if is_null(Some(item)) {
                continue;
            }
            let path = buffers.index(i);
            let b = record(Some(item), path)?;
            whole(b.get("arrayStride"), path.field("arrayStride"))?;
            one_of(
                b.get("stepMode"),
                &["vertex", "instance"],
                path.field("stepMode"),
            )?;
            let attributes = path.field("attributes");
            for (j, attribute) in list(b.get("attributes"), attributes, None)?
                .iter()
                .enumerate()
            {
                let w = attributes.index(j);
                let t = record(Some(attribute), w)?;
                one_of(t.get("format"), VERTEX_FORMATS, w.field("format"))?;
                whole(t.get("offset"), w.field("offset"))?;
                whole(t.get("shaderLocation"), w.field("shaderLocation"))?;
            }
        }
        if !is_null(d.get("fragment")) {
            let p = at.field("fragment");
            let fragment = record(d.get("fragment"), p)?;
            self.find(fragment.get("module"), p.field("module"), &[Kind::Shader])?;
            if !is_null(fragment.get("entryPoint")) {
                text(fragment.get("entryPoint"), p.field("entryPoint"))?;
            }
            let targets = p.field("targets");
            for (i, item) in list(fragment.get("targets"), targets, None)?
                .iter()
                .enumerate()
            {
                if is_null(Some(item)) {
                    continue;
                }
                let path = targets.index(i);
                let t = record(Some(item), path)?;
                one_of(t.get("format"), COLOR_FORMATS, path.field("format"))?;
                if !is_null(t.get("blend")) {
                    let blend = path.field("blend");
                    let b = record(t.get("blend"), blend)?;
                    for part in ["color", "alpha"] {
                        let w = blend.field(part);
                        let c = record(b.get(part), w)?;
                        one_of(
                            c.get("operation"),
                            &["add", "subtract", "reverse-subtract", "min", "max"],
                            w.field("operation"),
                        )?;
                        one_of(c.get("srcFactor"), FACTORS, w.field("srcFactor"))?;
                        one_of(c.get("dstFactor"), FACTORS, w.field("dstFactor"))?;
                    }
                }
                let mask = path.field("writeMask");
                limit(whole(t.get("writeMask"), mask)?, 15.0, mask)?;
            }
        }
        let p = at.field("primitive");
        let primitive = record(d.get("primitive"), p)?;
        one_of(
            primitive.get("topology"),
            &[
                "point-list",
                "line-list",
                "line-strip",
                "triangle-list",
                "triangle-strip",
            ],
            p.field("topology"),
        )?;
        if !is_null(primitive.get("stripIndexFormat")) {
            one_of(
                primitive.get("stripIndexFormat"),
                &["uint16", "uint32"],
                p.field("stripIndexFormat"),
            )?;
        }
        one_of(
            primitive.get("frontFace"),
            &["ccw", "cw"],
            p.field("frontFace"),
        )?;
        one_of(
            primitive.get("cullMode"),
            &["none", "front", "back"],
            p.field("cullMode"),
        )?;
        if !is_null(d.get("depthStencil")) {
            let p = at.field("depthStencil");
            let depth = record(d.get("depthStencil"), p)?;
            one_of(depth.get("format"), DEPTH_FORMATS, p.field("format"))?;
            boolean(depth.get("depthWriteEnabled"), p.field("depthWriteEnabled"))?;
            one_of(depth.get("depthCompare"), COMPARE, p.field("depthCompare"))?;
        }
        let p = at.field("multisample");
        let multisample = record(d.get("multisample"), p)?;
        samples(multisample.get("count"), p.field("count"))?;
        whole(multisample.get("mask"), p.field("mask"))?;
        boolean(
            multisample.get("alphaToCoverageEnabled"),
            p.field("alphaToCoverageEnabled"),
        )?;
        Ok(())
    }

    /// A pass's descriptor.
    fn pass(&mut self, v: V) -> C<()> {
        let at = Path::Arg("pass", 1);
        let d = record(v, at)?;
        let attachments = at.field("colorAttachments");
        for (i, item) in list(d.get("colorAttachments"), attachments, None)?
            .iter()
            .enumerate()
        {
            if is_null(Some(item)) {
                continue;
            }
            let path = attachments.index(i);
            let c = record(Some(item), path)?;
            self.find(c.get("view"), path.field("view"), &[Kind::View])?;
            if !is_null(c.get("resolveTarget")) {
                self.find(
                    c.get("resolveTarget"),
                    path.field("resolveTarget"),
                    &[Kind::View],
                )?;
            }
            let clear = path.field("clearValue");
            for (j, part) in list(c.get("clearValue"), clear, Some(4))?
                .iter()
                .enumerate()
            {
                finite(Some(part), clear.index(j))?;
            }
            one_of(c.get("loadOp"), &["load", "clear"], path.field("loadOp"))?;
            one_of(
                c.get("storeOp"),
                &["store", "discard"],
                path.field("storeOp"),
            )?;
        }
        if !is_null(d.get("depthStencilAttachment")) {
            let path = at.field("depthStencilAttachment");
            let depth = record(d.get("depthStencilAttachment"), path)?;
            self.find(depth.get("view"), path.field("view"), &[Kind::View])?;
            if !is_null(depth.get("depthClearValue")) {
                finite(depth.get("depthClearValue"), path.field("depthClearValue"))?;
            }
            if !is_null(depth.get("depthLoadOp")) {
                one_of(
                    depth.get("depthLoadOp"),
                    &["load", "clear"],
                    path.field("depthLoadOp"),
                )?;
            }
            if !is_null(depth.get("depthStoreOp")) {
                one_of(
                    depth.get("depthStoreOp"),
                    &["store", "discard"],
                    path.field("depthStoreOp"),
                )?;
            }
            boolean(depth.get("depthReadOnly"), path.field("depthReadOnly"))?;
        }
        self.passes += 1;
        limit(
            self.passes as f64,
            PASSES as f64,
            Path::Text("the number of render passes in a frame"),
        )
        .map(|_| ())
    }
}

fn range(offset: f64, length: f64, bytes: usize) -> C<()> {
    if offset + length > bytes as f64 {
        return fail(format!(
            "bytes [{}, {}) are outside the batch's {bytes} bytes",
            num(offset),
            num(offset + length)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The host checks' cost for a typical frame's batch: 10 writes, a pass of 8 meshes (`cargo test --release -p
    /// psychoscript-gpu --lib -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn bench_checks() {
        let ops = |v: serde_json::Value| -> Vec<Arg> {
            v.as_array().unwrap().iter().map(Arg::from_json).collect()
        };
        let mut c = Checks::default();
        let setup = ops(json!([
            ["context", 1, "scene", "rgba8unorm", "opaque"],
            ["view", 2, 1, { "dimension": "2d", "baseMipLevel": 0, "mipLevelCount": 1, "baseArrayLayer": 0, "arrayLayerCount": 1 }],
            ["buffer", 3, 65536, 72], ["buffer", 4, 1024, 40], ["buffer", 5, 1024, 24],
            ["texture", 6, 64, 64, 1, "depth24plus", 16, 1, 1],
            ["view", 7, 6, { "dimension": "2d", "baseMipLevel": 0, "mipLevelCount": 1, "baseArrayLayer": 0, "arrayLayerCount": 1 }],
            ["shader", 8, "code"],
            ["bindGroupLayout", 9, { "entries": [{ "binding": 0, "visibility": 1, "sampler": null, "texture": null,
                "buffer": { "type": "uniform", "hasDynamicOffset": false, "minBindingSize": 0 } }] }],
            ["pipelineLayout", 10, [9]],
            ["bindGroup", 11, { "layout": 9, "entries": [{ "binding": 0, "resource": { "buffer": 3, "offset": 0, "size": -1 } }] }],
            ["renderPipeline", 12, { "layout": 10,
                "vertex": { "module": 8, "entryPoint": "vs", "buffers": [{ "arrayStride": 24, "stepMode": "vertex",
                    "attributes": [{ "format": "float32x3", "offset": 0, "shaderLocation": 0 }] }] },
                "fragment": { "module": 8, "entryPoint": "fs", "targets": [{ "format": "rgba8unorm", "blend": null, "writeMask": 15 }] },
                "primitive": { "topology": "triangle-list", "stripIndexFormat": null, "frontFace": "ccw", "cullMode": "back" },
                "depthStencil": { "format": "depth24plus", "depthWriteEnabled": true, "depthCompare": "less" },
                "multisample": { "count": 1, "mask": 4294967295u32, "alphaToCoverageEnabled": false } }],
        ]));
        let canvas = |k: &str| k == "scene";
        assert!(c.batch(&setup, 0, &canvas).is_ok());
        let mut frame = Vec::new();
        for k in 0..10 {
            frame.push(json!(["writeBuffer", 3, k * 6400, k * 6400, 6400]));
        }
        frame.push(json!(["pass", { "colorAttachments": [{ "view": 2, "resolveTarget": null, "clearValue": [0, 0, 0, 1],
            "loadOp": "clear", "storeOp": "store" }], "depthStencilAttachment": { "view": 7, "depthClearValue": 1,
            "depthLoadOp": "clear", "depthStoreOp": "store", "depthReadOnly": false } }]));
        frame.push(json!(["setPipeline", 12]));
        frame.push(json!(["setViewport", 0, 0, 64, 64, 0, 1]));
        frame.push(json!(["setScissorRect", 0, 0, 64, 64]));
        for _ in 0..8 {
            frame.push(json!(["setBindGroup", 0, 11, []]));
            frame.push(json!(["setVertexBuffer", 0, 4, 0, -1]));
            frame.push(json!(["setIndexBuffer", 5, "uint16", 0, -1]));
            frame.push(json!(["drawIndexed", 36, 1, 0, 0, 0]));
        }
        frame.push(json!(["end"]));
        frame.push(json!(["submit"]));
        let frame = ops(json!(frame));
        assert_eq!(frame.len(), 48);
        let n = 20_000;
        let start = std::time::Instant::now();
        for _ in 0..n {
            assert!(c.batch(&frame, 65536, &canvas).is_ok());
            c.end_frame();
            assert_eq!(c.rendered(&frame), ["scene"]);
        }
        eprintln!("host checks of a 48-op batch: {:?}", start.elapsed() / n);
    }
}
