// Live programs that post GPU batches (widgets-gpu.md, Transport) themselves, for the browser checks until the
// prelude's `widget.gpu` records them: a clear, a triangle and a depth-tested cube, each into a GPU canvas keyed
// "scene", 64 x 64 logical pixels.

/** Packs typed arrays into one ArrayBuffer: `[buffer, [offset, length] per array]`. */
const PACK = `const pack = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0)
  const out = new Uint8Array(total)
  const at = []
  let n = 0
  for (const a of arrays) { out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), n); at.push([n, a.byteLength]); n += a.byteLength }
  return [out.buffer, at]
}`

const scene = (height = 64) => `ui.stack([ui.canvas({ key: "scene", gpu: true, height: ${height}, width: 64, alt: "A GPU scene" }), ui.text("over the scene", { place: "bottom" })])`

/** The canvas cleared to red. */
export const clear = `${PACK}
async function main() {
  widget.render(${scene()})
  __host.post({ type: "gpu", bytes: new ArrayBuffer(0), ops: [
    ["context", 1, "scene", "rgba8unorm", "opaque"],
    ["view", 2, 1, {}],
    ["pass", { colorAttachments: [{ view: 2, clearValue: [1, 0, 0, 1], loadOp: "clear", storeOp: "store" }] }],
    ["end"],
    ["submit"],
  ] })
  await widget.sleep(100000)
}`

const TRIANGLE_WGSL = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(0.0, 0.8), vec2f(-0.8, -0.8), vec2f(0.8, -0.8));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }`

/** A green triangle on black. */
export const triangle = `${PACK}
async function main() {
  widget.render(${scene()})
  __host.post({ type: "gpu", bytes: new ArrayBuffer(0), ops: [
    ["context", 1, "scene", "rgba8unorm", "opaque"],
    ["view", 2, 1, {}],
    ["shader", 3, ${JSON.stringify(TRIANGLE_WGSL)}],
    ["renderPipeline", 4, { layout: "auto", vertex: { module: 3, entryPoint: "vs" }, fragment: { module: 3, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } }],
    ["pass", { colorAttachments: [{ view: 2, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] }],
    ["setPipeline", 4],
    ["draw", 3, 1, 0, 0],
    ["end"],
    ["submit"],
  ] })
  await widget.sleep(100000)
}`

const CUBE_WGSL = `struct U { mvp: mat4x4f }
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) p: vec4f, @location(0) c: vec3f }
@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec3f) -> V { return V(u.mvp * vec4f(p, 1.0), c); }
@fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(v.c, 1.0); }`

/**
 * A cube with a colour per face, seen from the front (+z) with depth testing: the front face (red) must cover the
 * middle, though the back face (blue) is drawn last. Without the depth test the back face would show.
 */
export const cube = `${PACK}
const FACES = [
  // The back face last, so only the depth test keeps the front face in front.
  [[0, 0, 1], [1, 0, 0]], [[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [1, 1, 0]], [[0, 1, 0], [1, 0, 1]], [[0, -1, 0], [0, 1, 1]], [[0, 0, -1], [0, 0, 1]],
]
function cubeVertices() {
  const out = []
  for (const [n, c] of FACES) {
    const axis = n.findIndex((v) => v !== 0)
    const [u, v] = [0, 1, 2].filter((i) => i !== axis)
    const corner = (a, b) => { const p = [0, 0, 0]; p[axis] = n[axis]; p[u] = a; p[v] = b; return [...p, ...c] }
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) out.push(...corner(a, b))
  }
  return new Float32Array(out)
}
// A perspective camera at z = 4 looking down -z (column-major, WebGPU depth 0..1).
function mvp() {
  const f = 1 / Math.tan(Math.PI / 8), near = 0.1, far = 10
  const proj = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -4, 1]
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k]; out[c * 4 + r] = s }
  return out
}
async function main() {
  widget.render(${scene()})
  const [bytes, [verts, matrix]] = pack(cubeVertices(), mvp())
  __host.post({ type: "gpu", bytes, ops: [
    ["context", 1, "scene", "rgba8unorm", "opaque"],
    ["view", 2, 1, {}],
    ["buffer", 3, verts[1], 32 | 8],
    ["writeBuffer", 3, 0, verts[0], verts[1]],
    ["buffer", 4, 64, 64 | 8],
    ["writeBuffer", 4, 0, matrix[0], matrix[1]],
    ["texture", 5, 64, 64, 1, "depth24plus", 16, 1, 1],
    ["view", 6, 5, {}],
    ["shader", 7, ${JSON.stringify(CUBE_WGSL)}],
    ["renderPipeline", 8, { layout: "auto",
      vertex: { module: 7, entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] },
      fragment: { module: 7, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" } }],
    ["autoLayout", 9, 8, 0],
    ["bindGroup", 10, { layout: 9, entries: [{ binding: 0, resource: { buffer: 4 } }] }],
    ["pass", { colorAttachments: [{ view: 2, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: 6, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } }],
    ["setPipeline", 8],
    ["setBindGroup", 0, 10, []],
    ["setVertexBuffer", 0, 3, 0, -1],
    ["draw", 36, 1, 0, 0],
    ["end"],
    ["submit"],
  ] })
  await widget.sleep(100000)
}`

/**
 * The cube spinning: its resources in one batch, then each frame a batch that writes its matrix and draws it, as a
 * game's loop does (a render pass and a draw a frame). It counts frames in the text over the canvas.
 */
export const spinning = cube
  .replace("function mvp() {", "function mvp(angle = 0) {")
  .replace(
    "const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -4, 1]",
    "const [s, c] = [Math.sin(angle), Math.cos(angle)]\n  const view = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -4, 1]",
  )
  .replace(
    "  await widget.sleep(100000)\n}",
    `  for (let n = 1; ; n++) {
    const frame = await widget.frame()
    const m = mvp(frame.t)
    __host.post({ type: "gpu", bytes: m.buffer, ops: [
      ["writeBuffer", 4, 0, 0, 64],
      ["pass", { colorAttachments: [{ view: 2, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: 6, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } }],
      ["setPipeline", 8], ["setBindGroup", 0, 10, []], ["setVertexBuffer", 0, 3, 0, -1], ["draw", 36, 1, 0, 0], ["end"], ["submit"],
    ] })
    if (n % 30 === 0) widget.render(ui.stack([ui.canvas({ key: "scene", gpu: true, height: 64, width: 64, alt: "A GPU scene" }), ui.text("frame " + n, { place: "bottom" })]))
  }
}`,
  )

/** A batch with an invalid pipeline (a vertex entry point that doesn't exist): a program error for the canvas. */
export const invalid = `async function main() {
  widget.render(${scene()})
  __host.post({ type: "gpu", bytes: new ArrayBuffer(0), ops: [
    ["context", 1, "scene", "rgba8unorm", "opaque"],
    ["shader", 2, ${JSON.stringify(TRIANGLE_WGSL)}],
    ["renderPipeline", 3, { layout: "auto", vertex: { module: 2, entryPoint: "nope" }, fragment: { module: 2, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] } }],
  ] })
  widget.render(ui.column([${scene()}, ui.button("still here", { onPress: () => widget.render(ui.text("pressed")) })]))
  await widget.sleep(100000)
}`
