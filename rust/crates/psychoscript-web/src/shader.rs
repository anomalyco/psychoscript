//! A `shader` node's WGSL for WebGL2: the contract's header, the template's `shade`, and an entry point that flips
//! `frag` to a top-left origin (GL's fragment coordinates start bottom-left), translated with naga to a GLSL ES 3.00
//! fragment shader. Feature `shader`.
//!
//! Shaders come from untrusted programs, so they are validated with baseline capabilities only, indexing is
//! bounds-checked (`Restrict`), and only the `widget` uniform buffer may be used.

use std::error::Error as _;
use std::fmt;

use naga::back::glsl;
use naga::proc::{BoundsCheckPolicies, BoundsCheckPolicy};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::{AddressSpace, SourceLocation};

/// The contract's cap on a shader's source.
pub const MAX_SOURCE_BYTES: usize = 16 * 1024;

/// What clients prepend to a template's WGSL (`widgets.md`, Shader).
pub const HEADER: &str = "struct Widget { resolution: vec2f, time: f32, scale: f32, pointer: vec4f, values: array<vec4f, 4> }\n@group(0) @binding(0) var<uniform> widget: Widget;\n";

/// The entry point for WebGPU, as the contract writes it.
pub const ENTRY: &str = "\n@fragment fn widget_main(@builtin(position) p: vec4f) -> @location(0) vec4f { return shade(p.xy); }\n";

/// The entry point for GL: `frag` measured from the top.
const GL_ENTRY: &str = "\n@fragment fn widget_main(@builtin(position) p: vec4f) -> @location(0) vec4f { return shade(vec2f(p.x, widget.resolution.y - p.y)); }\n";

/// One fragment shader, translated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Translated {
    /// GLSL ES 3.00 (`#version 300 es`).
    pub code: String,
    /// The `widget` uniform block's name, for `getUniformBlockIndex` (std140, 96 bytes).
    pub block: String,
}

/// Why a shader didn't translate. `line` and `column` are 1-based, in the template's WGSL, when known. `program`: the
/// template's WGSL is at fault (it doesn't parse or validate, or breaks the node's contract), a program error to report
/// (widgets.md, Failures); otherwise naga couldn't write valid WGSL as GLSL, a client error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShaderError {
    pub reason: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub program: bool,
}

impl fmt::Display for ShaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.line, self.column) {
            (Some(l), Some(c)) => write!(f, "{} (line {l}, column {c})", self.reason),
            _ => f.write_str(&self.reason),
        }
    }
}

impl std::error::Error for ShaderError {}

impl ShaderError {
    fn new(reason: impl Into<String>) -> ShaderError {
        ShaderError {
            reason: reason.into(),
            line: None,
            column: None,
            program: true,
        }
    }

    fn client(reason: impl Into<String>) -> ShaderError {
        ShaderError {
            program: false,
            ..ShaderError::new(reason)
        }
    }

    /// `{ message, line?, column?, program }`, as JSON.
    pub fn to_json(&self) -> String {
        let mut out = serde_json::Map::new();
        out.insert("message".into(), self.reason.as_str().into());
        out.insert("program".into(), self.program.into());
        if let (Some(l), Some(c)) = (self.line, self.column) {
            out.insert("line".into(), l.into());
            out.insert("column".into(), c.into());
        }
        serde_json::Value::Object(out).to_string()
    }
}

/// Translates a `shader` node's `wgsl` (the template's part, defining `shade`) to a GLSL ES 3.00 fragment shader.
pub fn translate(wgsl: &str) -> Result<Translated, ShaderError> {
    if wgsl.len() > MAX_SOURCE_BYTES {
        return Err(ShaderError::new(format!(
            "the shader is {} bytes, over the limit of {MAX_SOURCE_BYTES}",
            wgsl.len()
        )));
    }
    let source = format!("{HEADER}{wgsl}{GL_ENTRY}");
    let header_lines = HEADER.matches('\n').count() as u32;
    // Places in the template's own source; one in the header or the entry point has none there.
    let place = |at: Option<SourceLocation>| match at {
        Some(at) if at.line_number > header_lines => {
            (Some(at.line_number - header_lines), Some(at.line_position))
        }
        _ => (None, None),
    };
    let module = naga::front::wgsl::parse_str(&source).map_err(|e| {
        let mut reason = e.message().to_owned();
        for (_, label) in e.labels() {
            if !label.is_empty() && !reason.contains(label) {
                reason.push_str(": ");
                reason.push_str(label);
            }
        }
        let (line, column) = place(e.location(&source));
        ShaderError {
            reason,
            line,
            column,
            program: true,
        }
    })?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|e| {
            let mut reason = e.as_inner().to_string();
            let mut cause = e.as_inner().source();
            while let Some(c) = cause {
                reason.push_str(": ");
                reason.push_str(&c.to_string());
                cause = c.source();
            }
            let (line, column) = place(e.location(&source));
            ShaderError {
                reason,
                line,
                column,
                program: true,
            }
        })?;
    let Some(index) = module
        .entry_points
        .iter()
        .position(|ep| ep.stage == naga::ShaderStage::Fragment && ep.name == "widget_main")
    else {
        return Err(ShaderError::new("the shader defines its own widget_main"));
    };
    let uses = info.get_entry_point(index);
    for (handle, global) in module.global_variables.iter() {
        if global.binding.is_some()
            && !uses[handle].is_empty()
            && global.space != AddressSpace::Uniform
        {
            let name = global.name.as_deref().unwrap_or("?");
            return Err(ShaderError::new(format!(
                "`{name}` is a {:?} resource: only the widget uniform buffer is supported",
                global.space
            )));
        }
        if global.binding.is_some()
            && global.name.as_deref() != Some("widget")
            && !uses[handle].is_empty()
        {
            return Err(ShaderError::new(
                "only the widget uniform buffer is supported",
            ));
        }
    }
    let policies = BoundsCheckPolicies {
        index: BoundsCheckPolicy::Restrict,
        buffer: BoundsCheckPolicy::Restrict,
        image_load: BoundsCheckPolicy::Restrict,
        binding_array: BoundsCheckPolicy::Restrict,
    };
    let options = glsl::Options {
        version: glsl::Version::new_gles(300),
        writer_flags: glsl::WriterFlags::empty(),
        ..Default::default()
    };
    let pipeline = glsl::PipelineOptions {
        shader_stage: naga::ShaderStage::Fragment,
        entry_point: "widget_main".into(),
        multiview: None,
    };
    let mut code = String::new();
    let reflection = glsl::Writer::new(&mut code, &module, &info, &options, &pipeline, policies)
        .and_then(|mut w| w.write())
        .map_err(|e| ShaderError::client(e.to_string()))?;
    let block = module
        .global_variables
        .iter()
        .find(|(_, g)| g.name.as_deref() == Some("widget"))
        .and_then(|(h, _)| reflection.uniforms.get(&h).cloned())
        .unwrap_or_default();
    Ok(Translated { code, block })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_a_shade_function() {
        let t = translate(
            "fn shade(frag: vec2f) -> vec4f { let uv = frag / widget.resolution; return vec4f(uv, widget.values[1].x, 1.0); }",
        )
        .unwrap();
        assert!(t.code.starts_with("#version 300 es"), "{}", t.code);
        assert!(!t.block.is_empty());
        assert!(t.code.contains(&t.block));
    }

    #[test]
    fn errors_point_into_the_template() {
        let e = translate("fn shade(frag: vec2f) -> vec4f {\n  return vec4f(nope, 1.0);\n}")
            .unwrap_err();
        assert_eq!(e.line, Some(2), "{e}");
        assert!(e.program);
        let e = translate("fn other() {}").unwrap_err();
        assert!(e.reason.contains("shade"), "{e}");
        assert!(e.program);
    }

    #[test]
    fn caps_the_source() {
        assert!(translate(&" ".repeat(MAX_SOURCE_BYTES + 1)).is_err());
    }
}
