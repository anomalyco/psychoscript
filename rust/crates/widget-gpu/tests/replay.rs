//! Batches replayed on a real device (Vulkan: lavapipe on a machine without a GPU), checked by their pixels: what
//! the conformance fixtures don't cover (multisampling, copies, cube and array views, wgpu's own validation, device
//! loss, resizing, the `wgsl` shorthand) and the replay cost.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use widget_gpu::{
    Arg, ErrorKind, Gpu, GpuError, HANG_MESSAGE, SLOW_MESSAGE, SavedStop, SavedStops, Shorthand,
    Stops, Uniforms, clamp_size,
};

const W: u32 = 64;
const H: u32 = 64;
const RGBA: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

struct Fixture {
    device: wgpu::Device,
    queue: wgpu::Queue,
    gpu: Gpu,
}

fn fixture() -> Fixture {
    let (device, queue) = common::device();
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    gpu.resize("scene", W, H);
    Fixture { device, queue, gpu }
}

/// Fills `defaults`' members `v` lacks.
fn fill(v: &mut Value, defaults: Value) {
    let (Value::Object(v), Value::Object(d)) = (v, defaults) else {
        return;
    };
    for (k, d) in d {
        v.entry(k).or_insert(d);
    }
}

fn each(v: &mut Value, k: &str, f: impl Fn(&mut Value)) {
    if let Some(Value::Array(items)) = v.get_mut(k) {
        items.iter_mut().filter(|i| !i.is_null()).for_each(f);
    }
}

/// An op with its descriptor's defaults filled in, as the prelude posts it (`widgets-gpu.md`, Transport).
fn normal(mut op: Value) -> Value {
    let name = op[0].as_str().unwrap_or_default().to_owned();
    let d = match name.as_str() {
        "view" => &mut op[3],
        "sampler" | "bindGroupLayout" | "renderPipeline" | "bindGroup" => &mut op[2],
        "pass" => &mut op[1],
        _ => return op,
    };
    match name.as_str() {
        "view" => {
            let cube = d["dimension"] == "cube";
            fill(
                d,
                json!({ "dimension": "2d", "baseMipLevel": 0, "mipLevelCount": 1, "baseArrayLayer": 0,
                "arrayLayerCount": if cube { 6 } else { 1 } }),
            );
        }
        "sampler" => fill(
            d,
            json!({ "addressModeU": "clamp-to-edge", "addressModeV": "clamp-to-edge",
            "addressModeW": "clamp-to-edge", "magFilter": "nearest", "minFilter": "nearest", "mipmapFilter": "nearest",
            "lodMinClamp": 0, "lodMaxClamp": 32, "compare": null, "maxAnisotropy": 1 }),
        ),
        "bindGroupLayout" => each(d, "entries", |e| {
            fill(
                e,
                json!({ "buffer": null, "sampler": null, "texture": null }),
            );
            if !e["buffer"].is_null() {
                fill(
                    &mut e["buffer"],
                    json!({ "type": "uniform", "hasDynamicOffset": false, "minBindingSize": 0 }),
                );
            }
            if !e["sampler"].is_null() {
                fill(&mut e["sampler"], json!({ "type": "filtering" }));
            }
            if !e["texture"].is_null() {
                fill(
                    &mut e["texture"],
                    json!({ "sampleType": "float", "viewDimension": "2d", "multisampled": false }),
                );
            }
        }),
        "bindGroup" => each(d, "entries", |e| {
            if e["resource"].get("buffer").is_some() {
                fill(&mut e["resource"], json!({ "offset": 0, "size": -1 }));
            }
        }),
        "renderPipeline" => {
            fill(
                d,
                json!({ "fragment": null, "primitive": {}, "depthStencil": null, "multisample": {} }),
            );
            fill(
                &mut d["vertex"],
                json!({ "entryPoint": null, "buffers": [] }),
            );
            each(&mut d["vertex"], "buffers", |b| {
                fill(b, json!({ "stepMode": "vertex" }))
            });
            if !d["fragment"].is_null() {
                fill(&mut d["fragment"], json!({ "entryPoint": null }));
                each(&mut d["fragment"], "targets", |t| {
                    fill(t, json!({ "blend": null, "writeMask": 15 }))
                });
            }
            fill(
                &mut d["primitive"],
                json!({ "topology": "triangle-list", "stripIndexFormat": null,
                "frontFace": "ccw", "cullMode": "none" }),
            );
            if !d["depthStencil"].is_null() {
                fill(
                    &mut d["depthStencil"],
                    json!({ "depthWriteEnabled": false, "depthCompare": "always" }),
                );
            }
            fill(
                &mut d["multisample"],
                json!({ "count": 1, "mask": 4294967295u32, "alphaToCoverageEnabled": false }),
            );
        }
        _ => {
            each(d, "colorAttachments", |c| {
                fill(
                    c,
                    json!({ "resolveTarget": null, "clearValue": [0, 0, 0, 0] }),
                )
            });
            fill(d, json!({ "depthStencilAttachment": null }));
            if !d["depthStencilAttachment"].is_null() {
                fill(
                    &mut d["depthStencilAttachment"],
                    json!({ "depthClearValue": null, "depthLoadOp": null,
                    "depthStoreOp": null, "depthReadOnly": false }),
                );
            }
        }
    }
    op
}

#[derive(Default)]
struct Batch {
    ops: Vec<Arg>,
    bytes: Vec<u8>,
}

impl Batch {
    fn op(&mut self, v: Value) -> &mut Batch {
        self.ops.push(Arg::from_json(&normal(v)));
        self
    }

    fn data(&mut self, b: &[u8]) -> (usize, usize) {
        let at = self.bytes.len();
        self.bytes.extend_from_slice(b);
        (at, b.len())
    }

    fn write(&mut self, buffer: u32, offset: u64, data: &[u8]) -> &mut Batch {
        let (at, n) = self.data(data);
        self.op(json!(["writeBuffer", buffer, offset, at, n]))
    }
}

fn floats(f: &[f32]) -> Vec<u8> {
    f.iter().flat_map(|f| f.to_le_bytes()).collect()
}

impl Fixture {
    /// A batch in a frame request: applied, then the frame ends.
    fn apply(&mut self, b: &Batch) -> Result<(), GpuError> {
        let r = self.gpu.apply(&b.ops, &b.bytes);
        self.gpu.end_frame();
        r
    }

    fn pixels(&self, key: &str) -> Vec<[u8; 4]> {
        common::read(
            &self.device,
            &self.queue,
            self.gpu.canvas(key).expect("a drawn canvas").texture,
        )
    }

    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        self.pixels("scene")[(y * W + x) as usize]
    }
}

/// The canvas as context 1 and a view of it as 2.
fn context(b: &mut Batch) {
    b.op(json!(["context", 1, "scene", "rgba8unorm", "opaque"]));
    b.op(json!(["view", 2, 1, {}]));
}

fn pass_into(b: &mut Batch, view: u32, clear: [f64; 4]) {
    b.op(json!(["pass", { "colorAttachments": [{ "view": view, "clearValue": clear, "loadOp": "clear", "storeOp": "store" }] }]));
}

const RED: [u8; 4] = [255, 0, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const WHITE: [u8; 4] = [255, 255, 255, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

#[test]
fn a_gpu_moves_between_threads() {
    fn send<T: Send>() {}
    send::<Gpu>();
    send::<Shorthand>();
}

#[test]
fn clear() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    pass_into(&mut b, 2, [1.0, 0.0, 0.0, 1.0]);
    b.op(json!(["end"])).op(json!(["submit"]));
    assert!(f.gpu.canvas("scene").is_none());
    f.apply(&b).unwrap();
    assert_eq!(f.gpu.canvas("scene").unwrap().version, 1);
    assert!(f.pixels("scene").iter().all(|p| *p == RED));
}

const TRIANGLE: &str = "
@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }
";

/// A green triangle: shader 10, pipeline 11, vertex buffer 12.
fn triangle(b: &mut Batch, samples: u32) {
    b.op(json!(["shader", 10, TRIANGLE]));
    b.op(json!(["renderPipeline", 11, {
        "layout": "auto",
        "vertex": { "module": 10, "entryPoint": "vs", "buffers": [{ "arrayStride": 8,
            "attributes": [{ "format": "float32x2", "offset": 0, "shaderLocation": 0 }] }] },
        "fragment": { "module": 10, "entryPoint": "fs", "targets": [{ "format": "rgba8unorm" }] },
        "multisample": { "count": samples },
    }]));
    b.op(json!(["buffer", 12, 24, 32 | 8]));
    b.write(12, 0, &floats(&[0.0, 0.8, -0.8, -0.8, 0.8, -0.8]));
}

fn draw_triangle(b: &mut Batch) {
    b.op(json!(["setPipeline", 11]))
        .op(json!(["setVertexBuffer", 0, 12, 0, -1]))
        .op(json!(["draw", 3, 1, 0, 0]))
        .op(json!(["end"]));
}

#[test]
fn a_triangle() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    triangle(&mut b, 1);
    pass_into(&mut b, 2, [0.0, 0.0, 0.0, 1.0]);
    draw_triangle(&mut b);
    b.op(json!(["submit"]));
    f.apply(&b).unwrap();
    assert_eq!(f.pixel(32, 32), GREEN);
    assert_eq!(f.pixel(2, 2), BLACK);
    assert_eq!(f.pixel(61, 2), BLACK);
}

#[test]
fn a_multisampled_triangle_resolves_into_the_canvas() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    triangle(&mut b, 4);
    b.op(json!(["texture", 13, W, H, 1, "rgba8unorm", 16, 1, 4]));
    b.op(json!(["view", 14, 13, {}]));
    b.op(json!(["pass", { "colorAttachments": [{ "view": 14, "resolveTarget": 2, "clearValue": [0, 0, 0, 1],
        "loadOp": "clear", "storeOp": "discard" }] }]));
    draw_triangle(&mut b);
    b.op(json!(["submit"]));
    f.apply(&b).unwrap();
    assert_eq!(f.gpu.canvas("scene").unwrap().version, 1);
    assert_eq!(f.pixel(32, 32), GREEN);
    assert_eq!(f.pixel(2, 2), BLACK);
    let edge = f
        .pixels("scene")
        .into_iter()
        .find(|p| p[1] > 0 && p[1] < 255);
    assert!(edge.is_some(), "no anti-aliased edge");
}

// Column-major 4×4 matrices, as WGSL reads them.
type M = [[f32; 4]; 4];

fn mul(a: M, b: M) -> M {
    let mut m = [[0.0; 4]; 4];
    for c in 0..4 {
        for r in 0..4 {
            m[c][r] = (0..4).map(|k| a[k][r] * b[c][k]).sum();
        }
    }
    m
}

fn camera(angle: f32) -> Vec<u8> {
    let (near, far, fy) = (0.1f32, 100.0f32, 1.0 / (0.5f32).tan());
    let p = [
        [fy, 0.0, 0.0, 0.0],
        [0.0, fy, 0.0, 0.0],
        [0.0, 0.0, far / (near - far), -1.0],
        [0.0, 0.0, near * far / (near - far), 0.0],
    ];
    let v = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, -4.0, 1.0],
    ];
    let (s, c) = angle.sin_cos();
    let m = [
        [c, 0.0, -s, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [s, 0.0, c, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    floats(&mul(p, mul(v, m)).concat())
}

const CUBE: &str = "
struct U { mvp: mat4x4f }
@group(0) @binding(0) var<uniform> u: U;
struct O { @builtin(position) p: vec4f, @location(0) c: vec3f }
@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec3f) -> O {
    var o: O;
    o.p = u.mvp * vec4f(p, 1.0);
    o.c = c;
    return o;
}
@fragment fn fs(o: O) -> @location(0) vec4f { return vec4f(o.c, 1.0); }
";

/// A unit cube's 24 vertices (position, color) and 36 indices, faces +x, -x, +y, -y, +z, -z (the back last, so
/// only the depth test keeps it behind).
fn cube() -> (Vec<f32>, Vec<u16>) {
    type Face = ([f32; 3], [f32; 3], [f32; 3], [f32; 3]);
    let faces: [Face; 6] = [
        (
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ),
        (
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ),
        (
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.0, 0.0, 1.0],
        ),
        (
            [0.0, -1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0],
        ),
        (
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
        ),
        (
            [0.0, 0.0, -1.0],
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 1.0, 1.0],
        ),
    ];
    let (mut v, mut i) = (Vec::new(), Vec::new());
    for (k, (n, u, w, c)) in faces.iter().enumerate() {
        for (su, sw) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            for a in 0..3 {
                v.push(0.5 * (n[a] + su * u[a] + sw * w[a]));
            }
            v.extend_from_slice(c);
        }
        let o = (k * 4) as u16;
        i.extend_from_slice(&[o, o + 1, o + 2, o, o + 2, o + 3]);
    }
    (v, i)
}

fn cube_pipeline(h: u32, cull: &str) -> Value {
    json!(["renderPipeline", h, {
        "layout": 10,
        "vertex": { "module": 8, "entryPoint": "vs", "buffers": [{ "arrayStride": 24, "attributes": [
            { "format": "float32x3", "offset": 0, "shaderLocation": 0 },
            { "format": "float32x3", "offset": 12, "shaderLocation": 1 }] }] },
        "fragment": { "module": 8, "entryPoint": "fs", "targets": [{ "format": "rgba8unorm" }] },
        "primitive": { "cullMode": cull },
        "depthStencil": { "format": "depth24plus", "depthWriteEnabled": true, "depthCompare": "less" },
    }])
}

/// Vertices 3, indices 4, uniforms 5, depth texture 6 and view 7, shader 8, an explicit layout 9 and 10, bind
/// group 11, pipeline 12.
fn cube_scene(f: &mut Fixture, cull: &str) {
    let mut b = Batch::default();
    context(&mut b);
    let (vertices, indices) = cube();
    let index_bytes: Vec<u8> = indices.iter().flat_map(|i| i.to_le_bytes()).collect();
    b.op(json!(["buffer", 3, vertices.len() * 4, 32 | 8]));
    b.write(3, 0, &floats(&vertices));
    b.op(json!(["buffer", 4, index_bytes.len(), 16 | 8]));
    b.write(4, 0, &index_bytes);
    b.op(json!(["buffer", 5, 64, 64 | 8]));
    b.op(json!(["texture", 6, W, H, 1, "depth24plus", 16, 1, 1]));
    b.op(json!(["view", 7, 6, {}]));
    b.op(json!(["shader", 8, CUBE]));
    b.op(json!(["bindGroupLayout", 9, { "entries": [{ "binding": 0, "visibility": 1, "buffer": {} }] }]));
    b.op(json!(["pipelineLayout", 10, [9]]));
    b.op(json!(["bindGroup", 11, { "layout": 9, "entries": [{ "binding": 0, "resource": { "buffer": 5 } }] }]));
    b.op(cube_pipeline(12, cull));
    f.apply(&b).unwrap();
}

fn cube_frame(angle: f32, pipeline: u32) -> Batch {
    let mut b = Batch::default();
    b.write(5, 0, &camera(angle));
    b.op(json!(["pass", {
        "colorAttachments": [{ "view": 2, "clearValue": [0, 0, 0, 1], "loadOp": "clear", "storeOp": "store" }],
        "depthStencilAttachment": { "view": 7, "depthClearValue": 1, "depthLoadOp": "clear", "depthStoreOp": "store" },
    }]));
    b.op(json!(["setPipeline", pipeline]))
        .op(json!(["setBindGroup", 0, 11, []]))
        .op(json!(["setVertexBuffer", 0, 3, 0, -1]))
        .op(json!(["setIndexBuffer", 4, "uint16", 0, -1]))
        .op(json!(["drawIndexed", 36, 1, 0, 0, 0]))
        .op(json!(["end"]))
        .op(json!(["submit"]));
    b
}

const MAGENTA: [u8; 4] = [255, 0, 255, 255];
const CYAN: [u8; 4] = [0, 255, 255, 255];

#[test]
fn a_depth_tested_rotating_cube() {
    let mut f = fixture();
    cube_scene(&mut f, "none");
    let quarter = std::f32::consts::FRAC_PI_2;
    for (frame, (angle, front)) in [
        (0.0, MAGENTA),
        (quarter, GREEN),
        (2.0 * quarter, CYAN),
        (-quarter, RED),
    ]
    .into_iter()
    .enumerate()
    {
        f.apply(&cube_frame(angle, 12)).unwrap();
        assert_eq!(f.gpu.canvas("scene").unwrap().version, frame as u64 + 1);
        // Culling is off: only the depth test puts the front face over the ones drawn after it.
        assert_eq!(f.pixel(32, 32), front, "angle {angle}");
        assert_eq!(f.pixel(1, 1), BLACK);
    }
    // At 45° two faces show, split down the middle.
    f.apply(&cube_frame(quarter / 2.0, 12)).unwrap();
    assert_eq!(f.pixel(26, 32), GREEN);
    assert_eq!(f.pixel(38, 32), MAGENTA);
}

#[test]
fn back_face_culling() {
    let mut f = fixture();
    cube_scene(&mut f, "back");
    f.apply(&cube_frame(0.0, 12)).unwrap();
    assert_eq!(f.pixel(32, 32), MAGENTA);
    let mut b = Batch::default();
    b.op(cube_pipeline(13, "front"));
    f.apply(&b).unwrap();
    f.apply(&cube_frame(0.0, 13)).unwrap();
    // The front faces culled, the back face shows from inside.
    assert_eq!(f.pixel(32, 32), CYAN);
}

const QUAD: &str = "
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> O {
    let uv = vec2f(f32(i & 1u), f32(i >> 1u));
    var o: O;
    o.p = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    o.uv = uv;
    return o;
}
@fragment fn fs(o: O) -> @location(0) vec4f { return textureSample(t, s, o.uv); }
";

/// A full-canvas quad sampling texture view `view`: shader 40, pipeline 41, auto layout 42, sampler 43, bind group 44.
fn quad(b: &mut Batch, view: u32) {
    b.op(json!(["shader", 40, QUAD]));
    b.op(json!(["renderPipeline", 41, {
        "layout": "auto",
        "vertex": { "module": 40, "entryPoint": "vs" },
        "fragment": { "module": 40, "entryPoint": "fs", "targets": [{ "format": "rgba8unorm" }] },
        "primitive": { "topology": "triangle-strip" },
    }]));
    b.op(json!(["autoLayout", 42, 41, 0]));
    b.op(json!(["sampler", 43, {}]));
    b.op(json!(["bindGroup", 44, { "layout": 42, "entries": [
        { "binding": 0, "resource": { "view": view } }, { "binding": 1, "resource": { "sampler": 43 } }] }]));
}

fn draw_quad(b: &mut Batch) {
    pass_into(b, 2, [0.0, 0.0, 0.0, 1.0]);
    b.op(json!(["setPipeline", 41]))
        .op(json!(["setBindGroup", 0, 44, []]))
        .op(json!(["draw", 4, 1, 0, 0]))
        .op(json!(["end"]));
}

/// Red, green / blue, white.
const TEXELS: [[u8; 4]; 4] = [RED, GREEN, BLUE, WHITE];

fn quadrants(f: &Fixture) {
    assert_eq!(f.pixel(16, 16), RED);
    assert_eq!(f.pixel(48, 16), GREEN);
    assert_eq!(f.pixel(16, 48), BLUE);
    assert_eq!(f.pixel(48, 48), WHITE);
}

#[test]
fn render_to_texture_then_sample_it() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    triangle(&mut b, 1);
    b.op(json!([
        "texture",
        30,
        32,
        32,
        1,
        "rgba8unorm",
        16 | 4,
        1,
        1
    ]));
    b.op(json!(["view", 31, 30, {}]));
    quad(&mut b, 31);
    pass_into(&mut b, 31, [0.0, 0.0, 1.0, 1.0]);
    draw_triangle(&mut b);
    draw_quad(&mut b);
    b.op(json!(["submit"]));
    f.apply(&b).unwrap();
    assert_eq!(f.pixel(32, 32), GREEN);
    assert_eq!(f.pixel(1, 1), BLUE);
    assert_eq!(f.gpu.canvas("scene").unwrap().version, 1);
}

#[test]
fn the_copy_commands() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    // Two rows of two texels, 256 bytes apart as buffer copies need.
    let mut rows = vec![0u8; 512];
    rows[..8].copy_from_slice(TEXELS[..2].as_flattened());
    rows[256..264].copy_from_slice(TEXELS[2..].as_flattened());
    b.op(json!(["buffer", 30, 512, 8 | 4]));
    b.write(30, 0, &rows);
    b.op(json!(["buffer", 31, 512, 8 | 4]));
    b.op(json!(["texture", 32, 2, 2, 1, "rgba8unorm", 2 | 1, 1, 1]));
    b.op(json!(["texture", 33, 2, 2, 1, "rgba8unorm", 2 | 4, 1, 1]));
    b.op(json!(["view", 34, 33, {}]));
    quad(&mut b, 34);
    b.op(json!(["copyBufferToBuffer", 30, 0, 31, 0, 512]));
    b.op(json!([
        "copyBufferToTexture",
        31,
        0,
        256,
        2,
        32,
        0,
        [0, 0, 0],
        [2, 2, 1]
    ]));
    b.op(json!([
        "copyTextureToTexture",
        32,
        0,
        [0, 0, 0],
        33,
        0,
        [0, 0, 0],
        [2, 2, 1]
    ]));
    draw_quad(&mut b);
    b.op(json!(["submit"]));
    f.apply(&b).unwrap();
    quadrants(&f);
}

const LAYERS: &str = "
@group(0) @binding(0) var cube: texture_cube<f32>;
@group(0) @binding(1) var layers: texture_2d_array<f32>;
@group(0) @binding(2) var s: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let uv = vec2f(f32(i & 1u), f32(i >> 1u));
    return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let a = textureSample(cube, s, vec3f(0.0, 0.0, -1.0));
    let b = textureSample(layers, s, vec2f(0.5), 3);
    return select(b, a, p.x < 32.0);
}
";

#[test]
fn cube_and_array_views() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    let colors: [[u8; 4]; 6] = [RED, GREEN, BLUE, [255, 255, 0, 255], MAGENTA, CYAN];
    b.op(json!(["texture", 30, 1, 1, 6, "rgba8unorm", 2 | 4, 1, 1]));
    let (at, n) = b.data(colors.as_flattened());
    b.op(json!([
        "writeTexture",
        30,
        0,
        [0, 0, 0],
        at,
        n,
        4,
        1,
        [1, 1, 6]
    ]));
    b.op(json!(["view", 31, 30, { "dimension": "cube" }]));
    b.op(json!(["view", 32, 30, { "dimension": "2d-array", "arrayLayerCount": 6 }]));
    b.op(json!(["sampler", 33, {}]));
    b.op(json!(["shader", 34, LAYERS]));
    b.op(json!(["renderPipeline", 35, {
        "layout": "auto",
        "vertex": { "module": 34 },
        "fragment": { "module": 34, "targets": [{ "format": "rgba8unorm" }] },
        "primitive": { "topology": "triangle-strip" },
    }]));
    b.op(json!(["autoLayout", 36, 35, 0]));
    b.op(json!(["bindGroup", 37, { "layout": 36, "entries": [{ "binding": 0, "resource": { "view": 31 } },
        { "binding": 1, "resource": { "view": 32 } }, { "binding": 2, "resource": { "sampler": 33 } }] }]));
    pass_into(&mut b, 2, [0.0, 0.0, 0.0, 1.0]);
    b.op(json!(["setPipeline", 35]))
        .op(json!(["setBindGroup", 0, 37, []]))
        .op(json!(["draw", 4, 1, 0, 0]))
        .op(json!(["end"]))
        .op(json!(["submit"]));
    f.apply(&b).unwrap();
    // -z is the cube's sixth face; layer 3 the fourth.
    assert_eq!(f.pixel(16, 32), CYAN);
    assert_eq!(f.pixel(48, 32), [255, 255, 0, 255]);
}

/// wgpu's validation, past the host checks: program errors in wgpu's words, stopping the canvases the batch renders
/// into, or all.
#[test]
fn wgpu_validation_errors_are_program_errors() {
    let render = |extra: Vec<Value>| {
        let mut ops = vec![
            json!(["context", 1, "scene", "rgba8unorm", "opaque"]),
            json!(["view", 2, 1, {}]),
            json!(["pass", { "colorAttachments": [{ "view": 2, "loadOp": "clear", "storeOp": "store" }] }]),
        ];
        ops.extend(extra);
        ops.extend([json!(["end"]), json!(["submit"])]);
        ops
    };
    let cases: Vec<(Vec<Value>, &str, Stops)> = vec![
        (
            vec![json!(["shader", 1, "fn main( {"])],
            "In Device::create_shader_module: Shader parsing error: expected identifier, found \"{\" (WGSL line 1, column 10)",
            Stops::All,
        ),
        (
            vec![json!([
                "shader",
                1,
                "\n@fragment fn fs() -> @location(0) vec4f {\n  return 1;\n}"
            ])],
            "(WGSL line 3, column 10)",
            Stops::All,
        ),
        (
            vec![
                json!(["shader", 1, TRIANGLE]),
                json!(["renderPipeline", 2, { "layout": "auto",
                "vertex": { "module": 1, "entryPoint": "vs" },
                "fragment": { "module": 1, "entryPoint": "fs", "targets": [{ "format": "rgba8unorm" }] } }]),
            ],
            "In Device::create_render_pipeline",
            Stops::All,
        ),
        (
            vec![
                json!(["buffer", 1, 16, 8]),
                json!(["writeBuffer", 1, 2, 0, 4]),
            ],
            "In Queue::write_buffer: Buffer offset 2 is not aligned",
            Stops::All,
        ),
        (
            vec![json!(["texture", 1, 0, 4, 1, "rgba8unorm", 4, 1, 1])],
            "In Device::create_texture: Dimension X is zero",
            Stops::All,
        ),
        (
            vec![json!(["texture", 1, 4, 4, 1, "rgba8unorm", 4, 0, 1])],
            "In Device::create_texture: Texture descriptor mip level count 0 is invalid",
            Stops::All,
        ),
        (
            vec![
                json!(["buffer", 1, 16, 4]),
                json!(["buffer", 2, 16, 8]),
                json!(["copyBufferToBuffer", 1, 0, 2, 0, 3]),
                json!(["submit"]),
            ],
            "Copy size 3 does not respect `COPY_BUFFER_ALIGNMENT`",
            Stops::All,
        ),
        (
            render(vec![json!(["draw", 3, 1, 0, 0])]),
            "In a draw command, kind: Draw: Render pipeline must be set",
            Stops::Canvases(vec!["scene".into()]),
        ),
    ];
    let (device, queue) = common::device();
    for (ops, expected, canvases) in cases {
        let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
        gpu.resize("scene", W, H);
        let mut b = Batch::default();
        for op in ops {
            b.op(op);
        }
        b.bytes = vec![0; 4];
        let e = gpu.apply(&b.ops, &b.bytes).unwrap_err();
        eprintln!("{} {:?}", e.message, e.canvases);
        assert_eq!(e.kind, ErrorKind::Program);
        assert!(
            e.message.contains(expected),
            "{:?} lacks {expected:?}",
            e.message
        );
        assert_eq!(e.canvases, canvases);
        assert_eq!(gpu.error("scene"), Some(&e));
        // The canvas is stopped: nothing more is reported for it.
        assert_eq!(gpu.apply(&b.ops, &b.bytes), Ok(()));
    }
}

#[test]
fn device_loss_and_reset() {
    let mut f = fixture();
    let lost = Arc::new(AtomicBool::new(false));
    let flag = lost.clone();
    f.device
        .set_device_lost_callback(move |_, _| flag.store(true, Ordering::SeqCst));
    let mut b = Batch::default();
    context(&mut b);
    pass_into(&mut b, 2, [1.0, 0.0, 0.0, 1.0]);
    b.op(json!(["end"])).op(json!(["submit"]));
    f.apply(&b).unwrap();
    assert_eq!(f.pixel(5, 5), RED);

    f.device.destroy();
    let _ = f.device.poll(wgpu::PollType::wait_indefinitely());
    assert!(lost.load(Ordering::SeqCst));
    // Replay on the lost device is no error, as in WebGPU.
    let mut frame = Batch::default();
    pass_into(&mut frame, 2, [0.0, 0.0, 1.0, 1.0]);
    frame.op(json!(["end"])).op(json!(["submit"]));
    assert_eq!(f.apply(&frame), Ok(()));

    let (device, queue) = common::device();
    f.device = device.clone();
    f.queue = queue.clone();
    f.gpu.reset(device, queue).unwrap();
    assert!(f.gpu.canvas("scene").is_none());
    // A frame posted before the program learned of the loss names old handles: dropped, not an error.
    assert_eq!(f.apply(&frame), Ok(()));
    assert!(f.gpu.canvas("scene").is_none());
    assert_eq!(f.gpu.error("scene"), None);
    // The program recreates its resources with new handles.
    let mut b = Batch::default();
    b.op(json!(["context", 50, "scene", "rgba8unorm", "opaque"]));
    b.op(json!(["view", 51, 50, {}]));
    pass_into(&mut b, 51, [0.0, 1.0, 0.0, 1.0]);
    b.op(json!(["end"])).op(json!(["submit"]));
    f.apply(&b).unwrap();
    assert_eq!(f.pixel(5, 5), GREEN);
    assert_eq!(f.gpu.memory(), 0);
}

#[test]
fn resizing_remakes_the_canvas_and_its_views() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    pass_into(&mut b, 2, [1.0, 0.0, 0.0, 1.0]);
    b.op(json!(["end"])).op(json!(["submit"]));
    f.apply(&b).unwrap();
    f.gpu.resize("scene", 20, 10);
    let mut b = Batch::default();
    pass_into(&mut b, 2, [0.0, 0.0, 1.0, 1.0]);
    b.op(json!(["end"])).op(json!(["submit"]));
    f.apply(&b).unwrap();
    let c = f.gpu.canvas("scene").unwrap();
    assert_eq!(
        (c.texture.width(), c.texture.height(), c.version),
        (20, 10, 2)
    );
    assert!(f.pixels("scene").iter().all(|p| *p == BLUE));
    // A canvas that left the view: its passes are skipped, and a context op can't name it.
    f.gpu.remove("scene");
    f.apply(&b).unwrap();
    assert_eq!(f.gpu.canvas("scene").unwrap().version, 2);
    let mut b = Batch::default();
    b.op(json!(["context", 3, "scene", "rgba8unorm", "opaque"]));
    assert_eq!(
        f.apply(&b).unwrap_err().message,
        "gpu op 0: no GPU canvas with key \"scene\""
    );
}

const PLASMA: &str = "fn shade(frag: vec2f) -> vec4f {
    let uv = frag / widget.resolution;
    return vec4f(uv.x * widget.values[0].x, widget.values[0].y, widget.pointer.z, 1.0);
}";

#[test]
fn the_wgsl_shorthand() {
    let (device, queue) = common::device();
    let mut s = Shorthand::new(device.clone(), queue.clone(), RGBA, PLASMA).unwrap();
    let mut values = [0.0; 16];
    values[0] = 1.0;
    values[1] = 0.5;
    let u = Uniforms {
        time: 1.0,
        scale: 2.0,
        pointer: [0.0, 0.0, 1.0, 0.0],
        values,
    };
    s.render(W, H, &u).unwrap();
    // A frame isn't drawn while the last one still is.
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    s.render(W, H, &u).unwrap();
    let canvas = s.canvas().unwrap();
    assert_eq!(
        (canvas.alpha, canvas.version),
        (widget_gpu::AlphaMode::Premultiplied, 2)
    );
    let p = common::read(&device, &queue, canvas.texture);
    let (left, right) = (p[(32 * W) as usize], p[(32 * W + W - 1) as usize]);
    assert_eq!((left[1], left[2], left[3]), (128, 255, 255));
    assert!(left[0] < 5 && right[0] > 250, "{left:?} {right:?}");

    let wgsl = "fn shade(frag: vec2f) -> vec4f {\n  return vec4f(frag, 0.0 1.0);\n}";
    let Err(e) = Shorthand::new(device, queue, RGBA, wgsl) else {
        panic!("compiled")
    };
    assert_eq!(e.kind, ErrorKind::Program);
    assert!(
        e.message.ends_with("(WGSL line 2, column 26)"),
        "{}",
        e.message
    );
}

#[test]
fn a_resolve_target_counts_as_rendering_into_its_canvas() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    b.op(json!(["texture", 3, W, H, 1, "rgba8unorm", 16, 1, 4]));
    b.op(json!(["view", 4, 3, {}]));
    b.op(json!(["pass", { "colorAttachments": [{ "view": 4, "resolveTarget": 2, "clearValue": [0, 0, 0, 1],
        "loadOp": "clear", "storeOp": "discard" }] }]));
    b.op(json!(["draw", 3, 1, 0, 0]))
        .op(json!(["end"]))
        .op(json!(["submit"]));
    let e = f.apply(&b).unwrap_err();
    assert!(
        e.message.contains("Render pipeline must be set"),
        "{}",
        e.message
    );
    assert_eq!(e.canvases, Stops::Canvases(vec!["scene".into()]));
}

#[test]
fn each_frame_starts_from_a_transparent_canvas() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    pass_into(&mut b, 2, [1.0, 0.0, 0.0, 1.0]);
    b.op(json!(["end"])).op(json!(["submit"]));
    f.apply(&b).unwrap();
    assert_eq!(f.pixel(5, 5), RED);
    // A pass that loads, in a frame of its own: last frame's red is gone.
    let load = |b: &mut Batch| {
        b.op(json!(["pass", { "colorAttachments": [{ "view": 2, "loadOp": "load", "storeOp": "store" }] }]))
            .op(json!(["end"]))
            .op(json!(["submit"]));
    };
    let mut b = Batch::default();
    load(&mut b);
    f.apply(&b).unwrap();
    assert_eq!(f.pixel(5, 5), [0, 0, 0, 0]);
    // Within a frame, a later batch (one posted before a sleep) loads what earlier passes drew.
    let mut first = Batch::default();
    pass_into(&mut first, 2, [0.0, 1.0, 0.0, 1.0]);
    first.op(json!(["end"])).op(json!(["submit"]));
    f.gpu.apply(&first.ops, &first.bytes).unwrap();
    let mut then = Batch::default();
    load(&mut then);
    f.gpu.apply(&then.ops, &then.bytes).unwrap();
    assert_eq!(f.pixel(5, 5), GREEN);
    // And in one batch, the second pass loads the first's.
    f.gpu.end_frame();
    let mut both = Batch::default();
    pass_into(&mut both, 2, [0.0, 0.0, 1.0, 1.0]);
    both.op(json!(["end"]));
    load(&mut both);
    f.apply(&both).unwrap();
    assert_eq!(f.pixel(5, 5), BLUE);
    assert_eq!(f.gpu.canvas("scene").unwrap().version, 6);
}

#[test]
fn the_frame_counts_start_again_at_every_frame_request() {
    let mut f = fixture();
    let mut b = Batch::default();
    context(&mut b);
    f.gpu.apply(&b.ops, &b.bytes).unwrap();
    let passes = |n: usize| {
        let mut b = Batch::default();
        for _ in 0..n {
            pass_into(&mut b, 2, [0.0; 4]);
            b.op(json!(["end"]));
        }
        b.op(json!(["submit"]));
        b
    };
    // 16 in a frame, over three batches; a frame request with no batch still ends the frame.
    f.gpu.apply(&passes(10).ops, &[]).unwrap();
    f.gpu.apply(&passes(6).ops, &[]).unwrap();
    f.gpu.end_frame();
    f.gpu.apply(&passes(16).ops, &[]).unwrap();
    let e = f.gpu.apply(&passes(1).ops, &[]).unwrap_err();
    assert_eq!(
        e.message,
        "gpu op 0: the number of render passes in a frame is over the limit of 16"
    );
}

#[test]
fn clamping_a_canvas_size() {
    assert_eq!(clamp_size(1920, 1080), (1920, 1080));
    assert_eq!(clamp_size(4096, 4096), (4096, 4096));
    assert_eq!(clamp_size(5120, 2880), (4096, 2304));
    assert_eq!(clamp_size(2880, 5120), (2304, 4096));
    assert_eq!(clamp_size(100, 9000), (45, 4096));
    assert_eq!(clamp_size(9000, 1000), (4096, 455));
    assert_eq!(clamp_size(100_000, 1), (4096, 1));
    assert_eq!(clamp_size(0, 0), (0, 0));
}

/// A canvas an error stopped stays stopped for the run: out of the view and back under its key, and after a device
/// loss, which restarts only the canvases it stopped.
#[test]
fn a_canvas_an_error_stopped_stays_stopped() {
    let (device, queue) = common::device();
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    gpu.resize("a", 8, 8);
    gpu.resize("b", 8, 8);
    let mut b = Batch::default();
    b.op(json!(["context", 1, "a", "rgba8unorm", "opaque"]))
        .op(json!(["view", 2, 1, {}]));
    b.op(json!(["context", 3, "b", "rgba8unorm", "opaque"]))
        .op(json!(["view", 4, 3, {}]));
    gpu.apply(&b.ops, &[]).unwrap();
    let clear = |view: u32, draw: bool| {
        let mut b = Batch::default();
        pass_into(&mut b, view, [0.0, 1.0, 0.0, 1.0]);
        if draw {
            b.op(json!(["draw", 3, 1, 0, 0]));
        }
        b.op(json!(["end"])).op(json!(["submit"]));
        b
    };
    let e = gpu.apply(&clear(2, true).ops, &[]).unwrap_err();
    assert_eq!(e.canvases, Stops::Canvases(vec!["a".into()]));
    let version = gpu.canvas("a").map(|c| c.version);
    gpu.remove("a");
    gpu.resize("a", 8, 8);
    assert_eq!(gpu.error("a"), Some(&e));
    // Its passes are skipped.
    gpu.apply(&clear(2, false).ops, &[]).unwrap();
    assert_eq!(gpu.canvas("a").map(|c| c.version), version);

    // A device loss: `b` restarts once the program draws into it again; `a` doesn't.
    gpu.apply(&clear(4, false).ops, &[]).unwrap();
    gpu.reset(device.clone(), queue.clone()).unwrap();
    assert!(gpu.canvas("b").is_none());
    let mut b = Batch::default();
    b.op(json!(["context", 5, "a", "rgba8unorm", "opaque"]))
        .op(json!(["view", 6, 5, {}]));
    b.op(json!(["context", 7, "b", "rgba8unorm", "opaque"]))
        .op(json!(["view", 8, 7, {}]));
    gpu.apply(&b.ops, &[]).unwrap();
    gpu.apply(&clear(6, false).ops, &[]).unwrap();
    gpu.apply(&clear(8, false).ops, &[]).unwrap();
    assert_eq!(gpu.error("a"), Some(&e));
    assert!(gpu.canvas("a").is_none());
    assert_eq!(gpu.error("b"), None);
    assert_eq!(
        common::read(&device, &queue, gpu.canvas("b").unwrap().texture)[0],
        GREEN
    );
}

/// Only `no handle <h>` with `h` from 1 to the last handle before a loss drops a batch: handle 0, and handles
/// before any loss, stay program errors.
#[test]
fn only_handles_from_before_a_loss_drop_a_batch() {
    let (device, queue) = common::device();
    let destroy = |h: u32| Batch {
        ops: vec![Arg::from_json(&json!(["destroy", h]))],
        bytes: Vec::new(),
    };
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    assert_eq!(
        gpu.apply(&destroy(1).ops, &[]).unwrap_err().message,
        "gpu op 0: no handle 1"
    );
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    let mut b = Batch::default();
    b.op(json!(["buffer", 1, 16, 8]))
        .op(json!(["buffer", 2, 16, 8]));
    gpu.apply(&b.ops, &[]).unwrap();
    gpu.reset(device.clone(), queue.clone()).unwrap();
    assert_eq!(gpu.apply(&destroy(2).ops, &[]), Ok(()));
    assert_eq!(gpu.apply(&destroy(1).ops, &[]), Ok(()));
    assert_eq!(
        gpu.apply(&destroy(0).ops, &[]).unwrap_err().message,
        "gpu op 0: no handle 0"
    );
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    gpu.apply(&b.ops, &[]).unwrap();
    gpu.reset(device, queue).unwrap();
    assert_eq!(
        gpu.apply(&destroy(3).ops, &[]).unwrap_err().message,
        "gpu op 0: no handle 3"
    );
}

/// A batch the host's conversion rejected stops canvases as `gpu.ts` does: those its ops render into (contexts and
/// views made in it or before), or every canvas when its ops aren't a list or render into none.
#[test]
fn shape_errors_stop_the_canvases_the_batch_renders_into() {
    let (device, queue) = common::device();
    let gpu = || {
        let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
        gpu.resize("a", 8, 8);
        gpu.resize("b", 8, 8);
        gpu
    };
    const BYTES: &str = "a batch's bytes must be an ArrayBuffer";
    let ops = |v: Value| -> Vec<Arg> {
        let mut b = Batch::default();
        for op in v.as_array().unwrap() {
            b.op(op.clone());
        }
        b.ops
    };
    let contexts = ops(json!([
        ["context", 1, "a", "rgba8unorm", "opaque"],
        ["view", 2, 1, {}],
        ["context", 3, "b", "rgba8unorm", "opaque"],
        ["view", 4, 3, {}],
    ]));
    let into = |view: u32| {
        ops(
            json!([["pass", { "colorAttachments": [{ "view": view, "loadOp": "clear", "storeOp": "store" }] }],
            ["end"], ["submit"]]),
        )
    };

    // Ops that aren't a list: every canvas, and later batches are ignored.
    let mut g = gpu();
    let e = g
        .shape_error(None, "a batch's ops must be a list")
        .unwrap_err();
    assert_eq!(
        (e.kind, e.message.as_str(), &e.canvases),
        (
            ErrorKind::Program,
            "a batch's ops must be a list",
            &Stops::All
        )
    );
    assert_eq!(g.error("a"), Some(&e));
    assert_eq!(g.apply(&contexts, &[]), Ok(()));
    assert_eq!(g.shape_error(None, BYTES), Ok(()));

    // Ops that render into nothing: every canvas.
    let mut g = gpu();
    assert_eq!(
        g.shape_error(Some(&contexts), BYTES).unwrap_err().canvases,
        Stops::All
    );

    // Ops that render into `a`, through a context and a view made in an earlier batch: `a` alone.
    let mut g = gpu();
    g.apply(&contexts, &[]).unwrap();
    let e = g.shape_error(Some(&into(2)), BYTES).unwrap_err();
    assert_eq!(e.canvases, Stops::Canvases(vec!["a".into()]));
    assert_eq!(g.error("b"), None);
    // `a` again: already stopped, not reported again; `b` still draws.
    assert_eq!(g.shape_error(Some(&into(2)), BYTES), Ok(()));
    g.apply(&into(4), &[]).unwrap();
    assert_eq!(g.canvas("b").unwrap().version, 1);

    // Contexts and views made in the rejected batch count too (their keys, as in `gpu.ts`).
    let mut g = gpu();
    let mut both = contexts.clone();
    both.extend(into(2));
    both.extend(into(4));
    let e = g.shape_error(Some(&both), BYTES).unwrap_err();
    assert_eq!(e.canvases, Stops::Canvases(vec!["a".into(), "b".into()]));
}

#[test]
fn a_restored_run_drops_batches_naming_handles_from_before() {
    let mut f = fixture();
    let mut b = Batch::default();
    b.op(json!(["buffer", 1, 16, 8]))
        .op(json!(["buffer", 5, 16, 8]));
    f.gpu.apply(&b.ops, &[]).unwrap();
    assert_eq!(f.gpu.last_handle(), 5);
    let (device, queue) = common::device();
    let mut restored = Gpu::new(device, queue, RGBA).unwrap();
    restored.restored(5);
    let destroy = |h: u32| vec![Arg::from_json(&json!(["destroy", h]))];
    assert_eq!(restored.apply(&destroy(5), &[]), Ok(()));
    assert_eq!(
        restored.apply(&destroy(6), &[]).unwrap_err().message,
        "gpu op 0: no handle 6"
    );
    // New handles count up from the program's last.
    let (device, queue) = common::device();
    let mut restored = Gpu::new(device, queue, RGBA).unwrap();
    restored.restored(5);
    let mut b = Batch::default();
    b.op(json!(["buffer", 3, 16, 8]));
    assert_eq!(
        restored.apply(&b.ops, &[]).unwrap_err().message,
        "gpu op 0: handle 3 was already used"
    );
}

/// A restored run keeps its stopped canvases and their errors, and never reports them again; the others draw on.
#[test]
fn a_restored_run_keeps_its_stopped_canvases() {
    let (device, queue) = common::device();
    let run = || {
        let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
        gpu.resize("a", 8, 8);
        gpu.resize("b", 8, 8);
        gpu
    };
    let contexts = |first: u32| {
        let mut b = Batch::default();
        b.op(json!(["context", first, "a", "rgba8unorm", "opaque"]))
            .op(json!(["view", first + 1, first, {}]));
        b.op(json!(["context", first + 2, "b", "rgba8unorm", "opaque"]))
            .op(json!(["view", first + 3, first + 2, {}]));
        b
    };
    let into = |view: u32, broken: bool| {
        let mut b = Batch::default();
        pass_into(&mut b, view, [0.0, 1.0, 0.0, 1.0]);
        if broken {
            b.op(json!(["draw", 3, 1, 0, 0]));
        }
        b.op(json!(["end"])).op(json!(["submit"]));
        b
    };

    // The run: an error stops `a`.
    let mut gpu = run();
    gpu.apply(&contexts(1).ops, &[]).unwrap();
    let e = gpu.apply(&into(2, true).ops, &[]).unwrap_err();
    let saved = gpu.saved_stops();
    assert_eq!(
        saved,
        SavedStops {
            all: None,
            canvases: vec![(
                "a".into(),
                SavedStop {
                    kind: ErrorKind::Program,
                    message: e.message.clone()
                }
            )],
        }
    );
    let last = gpu.last_handle();

    // Restored: `a` stays stopped with its error, its errors aren't reported again; `b` draws.
    let mut restored = run();
    restored.restored(last);
    restored.restore_stops(saved.clone());
    assert_eq!(restored.saved_stops(), saved);
    let shown = restored.error("a").unwrap();
    assert_eq!(
        (shown.kind, &shown.message),
        (ErrorKind::Program, &e.message)
    );
    assert_eq!(restored.error("b"), None);
    // The program, told of the loss, recreates its contexts with new handles.
    restored.apply(&contexts(5).ops, &[]).unwrap();
    assert_eq!(restored.apply(&into(6, true).ops, &[]), Ok(()));
    assert!(restored.canvas("a").is_none());
    restored.apply(&into(8, false).ops, &[]).unwrap();
    assert_eq!(
        common::read(&device, &queue, restored.canvas("b").unwrap().texture)[0],
        GREEN
    );
    // A batch from before the snapshot (an old handle) is dropped quietly.
    assert_eq!(restored.apply(&into(4, true).ops, &[]), Ok(()));

    // An error that stopped every canvas: restored, every canvas stays stopped and later batches are ignored.
    let mut gpu = run();
    let mut bad = Batch::default();
    bad.op(json!(["buffer", 1, 6, 8])).write(1, 0, &[0; 6]);
    let e = gpu.apply(&bad.ops, &bad.bytes).unwrap_err();
    let saved = gpu.saved_stops();
    assert_eq!(
        saved.all,
        Some(SavedStop {
            kind: ErrorKind::Program,
            message: e.message.clone()
        })
    );
    let mut restored = run();
    restored.restored(gpu.last_handle());
    restored.restore_stops(saved);
    assert_eq!(restored.error("b").map(|e| &e.message), Some(&e.message));
    assert_eq!(
        restored.error("later").map(|e| e.canvases.clone()),
        Some(Stops::All)
    );
    assert_eq!(restored.apply(&contexts(2).ops, &[]), Ok(()));
    assert_eq!(restored.apply(&bad.ops, &bad.bytes), Ok(()));
    assert!(restored.canvas("b").is_none());
}

/// Renders `s` every 5 ms for at most `seconds`, or until it stops for being too slow: how many calls, and the
/// longest one took.
fn run_for(s: &mut Shorthand, seconds: f64) -> (u32, std::time::Duration) {
    let start = std::time::Instant::now();
    let (mut calls, mut longest) = (0, std::time::Duration::ZERO);
    let u = Uniforms {
        scale: 1.0,
        ..Default::default()
    };
    while start.elapsed().as_secs_f64() < seconds && !s.too_slow() {
        let at = std::time::Instant::now();
        s.render(256, 256, &u).unwrap();
        longest = longest.max(at.elapsed());
        calls += 1;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    (calls, longest)
}

/// Over 50 ms a frame three frames in a row: the shader stops on its last frame, a client error; `render` never
/// waits for the GPU.
#[test]
fn a_shader_too_slow_stops_on_its_last_frame() {
    let (device, queue) = common::device();
    let heavy = "fn shade(frag: vec2f) -> vec4f {
    var v = frag.x * 0.001 + frag.y;
    for (var i = 0; i < 6000; i++) { v = fract(sin(v + f32(i)) * 43758.5453); }
    return vec4f(v, 0.0, 0.0, 1.0);
}";
    let mut s = Shorthand::new(device.clone(), queue.clone(), RGBA, heavy).unwrap();
    let (calls, longest) = run_for(&mut s, 30.0);
    assert!(s.too_slow(), "not stopped after {calls} calls");
    let e = s.error().unwrap();
    assert_eq!(
        (e.kind, e.message.as_str()),
        (ErrorKind::Client, SLOW_MESSAGE)
    );
    // Three frames drew (or were drawing): one at a time, never queued behind each other.
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let version = s.canvas().unwrap().version;
    assert_eq!(version, 3, "{calls} calls");
    // It keeps its last frame, and draws no more.
    s.render(256, 256, &Uniforms::default()).unwrap();
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert_eq!(s.canvas().unwrap().version, version);
    assert!(
        longest < std::time::Duration::from_millis(40),
        "a render took {longest:?}"
    );
    eprintln!("stopped after {calls} calls; the longest took {longest:?}");

    // A light shader at the same pace doesn't stop.
    let mut s = Shorthand::new(device, queue, RGBA, PLASMA).unwrap();
    let (calls, _) = run_for(&mut s, 1.0);
    assert!(!s.too_slow() && s.error().is_none());
    assert!(s.canvas().unwrap().version > 10, "{calls} calls");
}

/// A fragment shader of `widget.values[0].x` steps a pixel: about 150 ms a 256 × 256 frame on lavapipe at 6,000, over 1 s
/// at 100,000.
const COSTLY: &str = "fn shade(frag: vec2f) -> vec4f {
    var v = frag.x * 0.001 + frag.y;
    for (var i = 0; i < i32(widget.values[0].x); i++) { v = fract(sin(v + f32(i)) * 43758.5453); }
    return vec4f(v, 0.0, 0.0, 1.0);
}";

/// Polls `f` every 10 ms until it gives something, for at most `seconds`.
fn until<T>(seconds: f64, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let start = std::time::Instant::now();
    while start.elapsed().as_secs_f64() < seconds {
        if let Some(t) = f() {
            return Some(t);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

/// A frame still drawing 1 s after its submit stops the shader with its placeholder, before and whatever the 50 ms
/// rule counted: here two slow frames, then one that hangs (stopped on its last frame at 50 ms, then by the hang).
#[test]
fn a_shader_frame_that_hangs_stops_the_canvas() {
    let (device, queue) = common::device();
    let mut s = Shorthand::new(device.clone(), queue.clone(), RGBA, COSTLY).unwrap();
    let start = std::time::Instant::now();
    let mut longest = std::time::Duration::ZERO;
    let mut was_slow = false;
    let hung = until(20.0, || {
        let drawn = s.canvas().map_or(0, |c| c.version);
        let mut u = Uniforms {
            scale: 1.0,
            ..Default::default()
        };
        u.values[0] = if drawn < 2 { 6000.0 } else { 100_000.0 };
        let at = std::time::Instant::now();
        s.render(256, 256, &u).unwrap();
        longest = longest.max(at.elapsed());
        was_slow |= s.too_slow();
        s.error().filter(|e| e.message == HANG_MESSAGE).cloned()
    });
    let e = hung.expect("no hang");
    assert_eq!(e.kind, ErrorKind::Client);
    assert!(
        was_slow,
        "the third slow frame should have stopped it on its last frame first"
    );
    assert!(!s.too_slow(), "a hang shows the placeholder");
    assert!(start.elapsed() > std::time::Duration::from_secs(1));
    assert!(
        longest < std::time::Duration::from_millis(40),
        "a render took {longest:?}"
    );
    // Stopped for good, a device loss included.
    s.reset(device.clone(), queue.clone()).unwrap();
    s.poll();
    assert_eq!(s.error().map(|e| e.message.as_str()), Some(HANG_MESSAGE));
}

/// A live batch whose work hangs stops the canvases it draws into, and not the others; a device loss doesn't restart
/// the hung canvas. One drawing into no canvas stops them all. (What waits behind a hung submit on a queue isn't
/// blamed: `hang`'s unit test. On lavapipe a submit waits for the work before it, so it can't be shown here.)
#[test]
fn a_batch_that_hangs_stops_its_canvases() {
    let (device, queue) = common::device();
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    gpu.resize("a", 256, 256);
    gpu.resize("b", 256, 256);
    let costly = COSTLY.replace("i32(widget.values[0].x)", "100000");
    let module = |body: &str| {
        format!(
            "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {{
    return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}}
{body}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {{ return shade(p.xy); }}"
        )
    };
    let mut b = Batch::default();
    b.op(json!(["context", 1, "a", "rgba8unorm", "opaque"]))
        .op(json!(["view", 2, 1, {}]));
    b.op(json!(["context", 3, "b", "rgba8unorm", "opaque"]))
        .op(json!(["view", 4, 3, {}]));
    for (h, body) in [
        (5, costly.as_str()),
        (
            7,
            "fn shade(p: vec2f) -> vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }",
        ),
    ] {
        b.op(json!(["shader", h, module(body)]));
        b.op(
            json!(["renderPipeline", h + 1, { "layout": "auto", "vertex": { "module": h },
            "fragment": { "module": h, "targets": [{ "format": "rgba8unorm" }] } }]),
        );
    }
    b.op(json!(["texture", 9, 256, 256, 1, "rgba8unorm", 16, 1, 1]))
        .op(json!(["view", 10, 9, {}]));
    gpu.apply(&b.ops, &[]).unwrap();
    let draw = |view: u32, pipeline: u32| {
        let mut b = Batch::default();
        pass_into(&mut b, view, [0.0; 4]);
        b.op(json!(["setPipeline", pipeline]))
            .op(json!(["draw", 3, 1, 0, 0]))
            .op(json!(["end"]))
            .op(json!(["submit"]));
        b
    };
    // Both draw; then a batch into `a` hangs. (lavapipe makes a submit wait for its work when other work runs, and
    // when it first draws into a texture: the queue is idle, and each target drawn once, first.)
    gpu.apply(&draw(2, 8).ops, &[]).unwrap();
    gpu.apply(&draw(4, 8).ops, &[]).unwrap();
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let at = std::time::Instant::now();
    gpu.apply(&draw(2, 6).ops, &[]).unwrap();
    let e = until(20.0, || gpu.poll().err()).expect("no hang");
    assert!(at.elapsed() > std::time::Duration::from_secs(1));
    assert_eq!(
        (e.kind, e.message.as_str()),
        (ErrorKind::Client, HANG_MESSAGE)
    );
    assert_eq!(e.canvases, Stops::Canvases(vec!["a".into()]));
    assert_eq!(gpu.error("b"), None);
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert_eq!(gpu.poll(), Ok(()));
    gpu.apply(&draw(4, 8).ops, &[]).unwrap();
    assert_eq!(gpu.canvas("b").unwrap().version, 2);
    assert_eq!(gpu.canvas("a").unwrap().version, 2);
    // After a device loss `a` stays stopped; `b` draws on.
    gpu.reset(device.clone(), queue.clone()).unwrap();
    assert_eq!(gpu.poll(), Ok(()));
    assert_eq!(
        gpu.error("a").map(|e| e.message.as_str()),
        Some(HANG_MESSAGE)
    );

    // Into an offscreen texture alone: every canvas.
    let mut gpu = Gpu::new(device.clone(), queue.clone(), RGBA).unwrap();
    gpu.resize("a", 256, 256);
    gpu.resize("b", 256, 256);
    gpu.apply(&b.ops, &[]).unwrap();
    gpu.apply(&draw(10, 8).ops, &[]).unwrap();
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    gpu.apply(&draw(10, 6).ops, &[]).unwrap();
    let e = until(20.0, || gpu.poll().err()).expect("no hang");
    assert_eq!(
        (e.message.as_str(), &e.canvases),
        (HANG_MESSAGE, &Stops::All)
    );
    assert!(gpu.error("b").is_some());
}

/// Replay cost of a typical frame: 48 ops, 64 KB of writes (`cargo test --release -p widget-gpu -- --ignored`).
#[test]
#[ignore]
fn bench_frame() {
    let mut f = fixture();
    cube_scene(&mut f, "back");
    // Eight bind groups over one 64 KB uniform buffer, 8 KB apart.
    let mut setup = Batch::default();
    setup.op(json!(["buffer", 40, 64 << 10, 64 | 8]));
    for k in 0..8u32 {
        setup.op(json!(["bindGroup", 41 + k, { "layout": 9, "entries": [
            { "binding": 0, "resource": { "buffer": 40, "offset": k * 8192, "size": 64 } }] }]));
    }
    f.apply(&setup).unwrap();

    let mut b = Batch::default();
    for k in 0..10u64 {
        b.write(
            40,
            k * 6400,
            &vec![0u8; if k < 9 { 6400 } else { 65536 - 9 * 6400 }],
        );
    }
    for k in 0..8usize {
        b.bytes[k * 8192..k * 8192 + 64].copy_from_slice(&camera(k as f32));
    }
    b.op(json!(["pass", {
        "colorAttachments": [{ "view": 2, "clearValue": [0, 0, 0, 1], "loadOp": "clear", "storeOp": "store" }],
        "depthStencilAttachment": { "view": 7, "depthClearValue": 1, "depthLoadOp": "clear", "depthStoreOp": "store" },
    }]));
    b.op(json!(["setPipeline", 12]));
    b.op(json!(["setViewport", 0, 0, W, H, 0, 1]));
    b.op(json!(["setScissorRect", 0, 0, W, H]));
    for k in 0..8u32 {
        b.op(json!(["setBindGroup", 0, 41 + k, []]))
            .op(json!(["setVertexBuffer", 0, 3, 0, -1]))
            .op(json!(["setIndexBuffer", 4, "uint16", 0, -1]))
            .op(json!(["drawIndexed", 36, 1, 0, 0, 0]));
    }
    b.op(json!(["end"])).op(json!(["submit"]));
    assert_eq!(b.ops.len(), 48);
    assert_eq!(b.bytes.len(), 64 << 10);

    let time = |f: &mut Fixture, b: &Batch, frames: u32, wait: bool| {
        f.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let start = std::time::Instant::now();
        for _ in 0..frames {
            f.apply(b).unwrap();
            let _ = f.device.poll(if wait {
                wgpu::PollType::wait_indefinitely()
            } else {
                wgpu::PollType::Poll
            });
        }
        start.elapsed() / frames
    };
    time(&mut f, &b, 100, false);
    let apply = time(&mut f, &b, 2000, false);
    let finished = time(&mut f, &b, 200, true);
    let writes = Batch {
        ops: b.ops[..10].to_vec(),
        bytes: b.bytes.clone(),
    };
    let writes = time(&mut f, &writes, 2000, false);
    let commands = Batch {
        ops: b.ops[10..].to_vec(),
        bytes: Vec::new(),
    };
    let commands = time(&mut f, &commands, 2000, false);
    eprintln!(
        "48 ops, 64 KB: apply {apply:?} per frame (CPU); finished on the device {finished:?}; \
         the 10 writes {writes:?}; the pass and submit {commands:?}"
    );
}
