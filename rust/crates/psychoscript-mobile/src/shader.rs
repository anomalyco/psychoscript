//! WGSL translated with naga to the shading language a mobile GPU API takes: MSL for Metal (iOS),
//! GLSL ES 3.00 for OpenGL ES 3 (Android). Feature `shader` (on by default).
//!
//! Shaders may come from untrusted sources, so they are validated with baseline capabilities only,
//! indexing is bounds-checked (`Restrict`), and MSL loops are forced bounded. The entry point may
//! use uniform buffers only (no textures, samplers or storage buffers).

use std::error::Error as _;
use std::fmt;

use naga::back::{glsl, msl};
use naga::proc::{BoundsCheckPolicies, BoundsCheckPolicy};
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};
use naga::{AddressSpace, Module, ResourceBinding, SourceLocation};

/// The language to write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ShaderTarget {
    /// Metal Shading Language 2.3 (iOS 14, macOS 11 and later).
    Msl,
    /// GLSL ES 3.00 (`#version 300 es`, OpenGL ES 3.0 and later).
    GlslEs300,
}

/// The entry point's stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ShaderStage {
    Vertex,
    Fragment,
}

/// A uniform buffer the entry point reads, by its WGSL `@group` and `@binding`.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct UniformBlock {
    pub group: u32,
    pub binding: u32,
    /// GLSL: the uniform block's name, for `glGetUniformBlockIndex`. MSL: the WGSL variable's name.
    pub name: String,
    /// Where to bind it: MSL `[[buffer(slot)]]` (`setVertexBytes`/`setFragmentBytes` index); GLSL
    /// the binding point to give `glUniformBlockBinding`. Slots count from 0 in `(group, binding)`
    /// order.
    pub slot: u32,
}

/// One entry point, translated.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TranslatedShader {
    pub code: String,
    /// The entry function's name in `code`: the WGSL name in MSL (unless it's reserved there, then
    /// naga's), always `main` in GLSL.
    pub entry_name: String,
    pub uniform_blocks: Vec<UniformBlock>,
}

/// Why a shader didn't translate: `reason` is the message. `line` and `column` are 1-based (the column in bytes), in the
/// source given, when known.
#[derive(Debug, PartialEq, Eq, uniffi::Error)]
pub enum ShaderError {
    /// The WGSL doesn't parse.
    Parse {
        reason: String,
        line: Option<u32>,
        column: Option<u32>,
    },
    /// It parses but isn't valid (types, uses beyond baseline capabilities, ...).
    Validation {
        reason: String,
        line: Option<u32>,
        column: Option<u32>,
    },
    /// No entry point of that name and stage, or it uses a resource other than uniform buffers.
    Unsupported { reason: String },
    /// The target language can't express it.
    Translation { reason: String },
}

impl fmt::Display for ShaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShaderError::Parse {
                reason,
                line: Some(l),
                column: Some(c),
            }
            | ShaderError::Validation {
                reason,
                line: Some(l),
                column: Some(c),
            } => write!(f, "{reason} (line {l}, column {c})"),
            ShaderError::Parse { reason, .. }
            | ShaderError::Validation { reason, .. }
            | ShaderError::Unsupported { reason }
            | ShaderError::Translation { reason } => f.write_str(reason),
        }
    }
}

impl std::error::Error for ShaderError {}

/// Translates WGSL `source`'s entry point `entry` (of `stage`) to `target`.
#[uniffi::export]
pub fn translate_wgsl(
    source: String,
    target: ShaderTarget,
    stage: ShaderStage,
    entry: String,
) -> Result<TranslatedShader, ShaderError> {
    let module = naga::front::wgsl::parse_str(&source).map_err(|e| {
        let mut message = e.message().to_owned();
        for (_, label) in e.labels() {
            if !label.is_empty() && !message.contains(label) {
                message.push_str(": ");
                message.push_str(label);
            }
        }
        let (line, column) = place(e.location(&source));
        ShaderError::Parse {
            reason: message,
            line,
            column,
        }
    })?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|e| {
            let mut message = e.as_inner().to_string();
            let mut cause = e.as_inner().source();
            while let Some(c) = cause {
                message.push_str(": ");
                message.push_str(&c.to_string());
                cause = c.source();
            }
            let (line, column) = place(e.location(&source));
            ShaderError::Validation {
                reason: message,
                line,
                column,
            }
        })?;
    let stage = match stage {
        ShaderStage::Vertex => naga::ShaderStage::Vertex,
        ShaderStage::Fragment => naga::ShaderStage::Fragment,
    };
    let Some(index) = module
        .entry_points
        .iter()
        .position(|ep| ep.stage == stage && ep.name == entry)
    else {
        return Err(ShaderError::Unsupported {
            reason: format!("no {stage:?} entry point named `{entry}`"),
        });
    };
    let uniforms = uniforms(&module, &info, index)?;
    let policies = BoundsCheckPolicies {
        index: BoundsCheckPolicy::Restrict,
        buffer: BoundsCheckPolicy::Restrict,
        image_load: BoundsCheckPolicy::Restrict,
        binding_array: BoundsCheckPolicy::Restrict,
    };
    let failed = |e: &dyn fmt::Display| ShaderError::Translation {
        reason: e.to_string(),
    };
    match target {
        ShaderTarget::Msl => {
            let mut resources = msl::EntryPointResources::default();
            for (slot, (_, binding)) in uniforms.iter().enumerate() {
                let target = msl::BindTarget {
                    buffer: Some(slot as u8),
                    ..Default::default()
                };
                resources.resources.insert(*binding, target);
            }
            let options = msl::Options {
                lang_version: (2, 3),
                per_entry_point_map: [(entry.clone(), resources)].into(),
                fake_missing_bindings: false,
                bounds_check_policies: policies,
                ..Default::default()
            };
            let pipeline = msl::PipelineOptions {
                entry_point: Some((stage, entry.clone())),
                ..Default::default()
            };
            let (code, translated) =
                msl::write_string(&module, &info, &options, &pipeline).map_err(|e| failed(&e))?;
            let entry_name = translated
                .entry_point_names
                .into_iter()
                .find_map(Result::ok)
                .unwrap_or(entry);
            let uniform_blocks = blocks(&module, &uniforms, |h| {
                module.global_variables[h].name.clone()
            });
            Ok(TranslatedShader {
                code,
                entry_name,
                uniform_blocks,
            })
        }
        ShaderTarget::GlslEs300 => {
            let options = glsl::Options {
                version: glsl::Version::new_gles(300),
                writer_flags: glsl::WriterFlags::empty(),
                ..Default::default()
            };
            let pipeline = glsl::PipelineOptions {
                shader_stage: stage,
                entry_point: entry,
                multiview: None,
            };
            let mut code = String::new();
            let reflection =
                glsl::Writer::new(&mut code, &module, &info, &options, &pipeline, policies)
                    .and_then(|mut w| w.write())
                    .map_err(|e| failed(&e))?;
            let uniform_blocks =
                blocks(&module, &uniforms, |h| reflection.uniforms.get(&h).cloned());
            Ok(TranslatedShader {
                code,
                entry_name: "main".into(),
                uniform_blocks,
            })
        }
    }
}

type Global = naga::Handle<naga::GlobalVariable>;

/// The uniform buffers entry point `index` uses, in `(group, binding)` order; an error for any
/// other resource it uses.
fn uniforms(
    module: &Module,
    info: &ModuleInfo,
    index: usize,
) -> Result<Vec<(Global, ResourceBinding)>, ShaderError> {
    let uses = info.get_entry_point(index);
    let mut out = Vec::new();
    for (handle, global) in module.global_variables.iter() {
        let Some(binding) = &global.binding else {
            continue;
        };
        if uses[handle].is_empty() {
            continue;
        }
        if global.space != AddressSpace::Uniform {
            let name = global.name.as_deref().unwrap_or("?");
            return Err(ShaderError::Unsupported {
                reason: format!(
                    "`{name}` is a {:?} resource: only uniform buffers are supported",
                    global.space
                ),
            });
        }
        out.push((handle, *binding));
    }
    out.sort_by_key(|(_, b)| (b.group, b.binding));
    Ok(out)
}

fn blocks(
    module: &Module,
    uniforms: &[(Global, ResourceBinding)],
    name: impl Fn(Global) -> Option<String>,
) -> Vec<UniformBlock> {
    uniforms
        .iter()
        .enumerate()
        .map(|(slot, (handle, b))| UniformBlock {
            group: b.group,
            binding: b.binding,
            name: name(*handle)
                .or_else(|| module.global_variables[*handle].name.clone())
                .unwrap_or_default(),
            slot: slot as u32,
        })
        .collect()
}

fn place(at: Option<SourceLocation>) -> (Option<u32>, Option<u32>) {
    at.map_or((None, None), |at| {
        (Some(at.line_number), Some(at.line_position))
    })
}
