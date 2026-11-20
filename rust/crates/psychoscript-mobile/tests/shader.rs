#![cfg(feature = "shader")]

use psychoscript_mobile::{ShaderError, ShaderStage, ShaderTarget, UniformBlock, translate_wgsl};

const SHADER: &str = "struct Globals { resolution: vec2f, time: f32, scale: f32 }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(2) var<uniform> tint: vec4f;

fn shade(frag: vec2f) -> vec4f {
  return vec4f(frag / globals.resolution, 0.5 + 0.5 * sin(globals.time), 1.0) * tint;
}

@fragment fn main_fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return shade(p.xy); }

@vertex fn main_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}
";

fn translate(
    source: &str,
    target: ShaderTarget,
    stage: ShaderStage,
    entry: &str,
) -> Result<psychoscript_mobile::TranslatedShader, ShaderError> {
    translate_wgsl(source.into(), target, stage, entry.into())
}

#[test]
fn msl() {
    let out = translate(SHADER, ShaderTarget::Msl, ShaderStage::Fragment, "main_fs").unwrap();
    assert_eq!(out.entry_name, "main_fs");
    assert!(out.code.contains("fragment main_fsOutput main_fs("));
    assert!(out.code.contains("constant Globals& globals [[buffer(0)]]"));
    assert!(out.code.contains("[[buffer(1)]]"));
    assert_eq!(
        out.uniform_blocks,
        [
            UniformBlock {
                group: 0,
                binding: 0,
                name: "globals".into(),
                slot: 0
            },
            UniformBlock {
                group: 1,
                binding: 2,
                name: "tint".into(),
                slot: 1
            },
        ]
    );
    let vertex = translate(SHADER, ShaderTarget::Msl, ShaderStage::Vertex, "main_vs").unwrap();
    assert!(vertex.code.contains("vertex main_vsOutput main_vs("));
    assert!(vertex.uniform_blocks.is_empty());
}

#[test]
fn glsl() {
    let out = translate(
        SHADER,
        ShaderTarget::GlslEs300,
        ShaderStage::Fragment,
        "main_fs",
    )
    .unwrap();
    assert_eq!(out.entry_name, "main");
    assert!(out.code.starts_with("#version 300 es"));
    assert!(out.code.contains("gl_FragCoord"));
    let names: Vec<_> = out
        .uniform_blocks
        .iter()
        .map(|b| (b.name.as_str(), b.slot))
        .collect();
    assert_eq!(
        names,
        [
            ("Globals_block_0Fragment", 0),
            ("type_2_block_1Fragment", 1)
        ]
    );
    for (name, _) in names {
        assert!(out.code.contains(&format!("uniform {name} ")));
    }
    let vertex = translate(
        SHADER,
        ShaderTarget::GlslEs300,
        ShaderStage::Vertex,
        "main_vs",
    )
    .unwrap();
    assert!(vertex.code.contains("gl_VertexID"));
}

#[test]
fn errors() {
    let parse = translate(
        "fn f() -> f32 {\n  return 1.0\n}",
        ShaderTarget::Msl,
        ShaderStage::Fragment,
        "f",
    );
    assert_eq!(
        parse,
        Err(ShaderError::Parse {
            reason: "expected `;`, found \"}\"".into(),
            line: Some(3),
            column: Some(1)
        })
    );
    let mistyped = translate(
        "@fragment fn f() -> @location(0) vec4f {\n  return 1.0;\n}",
        ShaderTarget::Msl,
        ShaderStage::Fragment,
        "f",
    );
    assert!(
        matches!(mistyped, Err(ShaderError::Parse { .. })),
        "{mistyped:?}"
    );
    let invalid = translate(
        "@fragment fn f() -> vec4f {\n  return vec4f(1.0);\n}",
        ShaderTarget::Msl,
        ShaderStage::Fragment,
        "f",
    );
    assert!(
        matches!(invalid, Err(ShaderError::Validation { .. })),
        "{invalid:?}"
    );
    let missing = translate(SHADER, ShaderTarget::Msl, ShaderStage::Vertex, "main_fs");
    assert!(matches!(missing, Err(ShaderError::Unsupported { .. })));
    let texture = "@group(0) @binding(0) var t: texture_2d<f32>;
@fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f { return textureLoad(t, vec2i(p.xy), 0); }";
    assert!(matches!(
        translate(texture, ShaderTarget::GlslEs300, ShaderStage::Fragment, "f"),
        Err(ShaderError::Unsupported { .. })
    ));
}
