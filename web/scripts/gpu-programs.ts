// Live programs on the prelude's `widget.gpu` (widgets-gpu.md), for the browser checks: a clear, a triangle, a
// depth-tested cube and an invalid pipeline, each on a GPU canvas keyed "scene" 64 x 64 logical pixels under a text
// layer; and opencode's four example widget templates (rust/crates/psychoscript-web/tests/fixtures/gpu/templates).

import path from "node:path"

const dir = path.resolve(import.meta.dir, "../../rust/crates/psychoscript-web/tests/fixtures/gpu/templates")
export const templates = {
  cube: await Bun.file(path.join(dir, "cube.js")).text(),
  "textured-quad": await Bun.file(path.join(dir, "textured-quad.js")).text(),
  "post-process": await Bun.file(path.join(dir, "post-process.js")).text(),
  maze: await Bun.file(path.join(dir, "maze.js")).text(),
}

const scene = `ui.stack([ui.canvas({ key: "scene", gpu: true, height: 64, width: 64, alt: "A GPU scene" }), ui.text("over the scene", { place: "bottom" })])`

/** The device and the canvas's context; `draw(encoder, view)` each frame, the first `frames` frames. */
const frame = (setup: string, draw: string, frames = 3) => `async function main() {
  widget.render(${scene})
  const device = await widget.gpu.requestDevice()
  const format = widget.gpu.getPreferredCanvasFormat()
  const context = widget.gpu.getContext("scene")
  context.configure({ device, format, alphaMode: "opaque" })
  ${setup}
  for (let n = 0; n < ${frames}; n++) {
    await widget.frame()
    const encoder = device.createCommandEncoder()
    const view = context.getCurrentTexture().createView()
    ${draw}
    device.queue.submit([encoder.finish()])
  }
  await widget.sleep(100000)
}`

/** The canvas cleared to red. */
export const clear = frame(
  "",
  `encoder.beginRenderPass({ colorAttachments: [{ view, clearValue: [1, 0, 0, 1], loadOp: "clear", storeOp: "store" }] }).end()`,
)

const TRIANGLE = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(0.0, 0.8), vec2f(-0.8, -0.8), vec2f(0.8, -0.8));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }`

/** A green triangle on black. */
export const triangle = frame(
  `const module = device.createShaderModule({ code: ${JSON.stringify(TRIANGLE)} })
  const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] } })`,
  `const pass = encoder.beginRenderPass({ colorAttachments: [{ view, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] })
    pass.setPipeline(pipeline)
    pass.draw(3)
    pass.end()`,
)

const CUBE = `struct U { mvp: mat4x4f }
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) p: vec4f, @location(0) c: vec3f }
@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec3f) -> V { return V(u.mvp * vec4f(p, 1.0), c); }
@fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(v.c, 1.0); }`

/**
 * A cube with a colour per face, seen from the front (+z) with depth testing and no culling: the front face (red) must
 * cover the middle, though the back face (blue) is drawn last. Without the depth test the back face would show.
 */
export const cube = frame(
  `const faces = [[[0, 0, 1], [1, 0, 0]], [[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [1, 1, 0]], [[0, 1, 0], [1, 0, 1]], [[0, -1, 0], [0, 1, 1]], [[0, 0, -1], [0, 0, 1]]]
  const data = []
  for (const [n, c] of faces) {
    const axis = n.findIndex((v) => v !== 0)
    const [u, v] = [0, 1, 2].filter((i) => i !== axis)
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) { const p = [0, 0, 0]; p[axis] = n[axis]; p[u] = a; p[v] = b; data.push(...p, ...c) }
  }
  const vertices = device.createBuffer({ size: data.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(vertices, 0, new Float32Array(data))
  const f = 1 / Math.tan(Math.PI / 8), near = 0.1, far = 10
  const mvp = new Float32Array([f, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far) - 4 * far / (near - far), 4])
  const uniforms = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(uniforms, 0, mvp)
  const module = device.createShaderModule({ code: ${JSON.stringify(CUBE)} })
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  })
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniforms } }] })
  let depth = null`,
  `if (!depth || depth.width !== context.width || depth.height !== context.height)
      depth = device.createTexture({ size: [context.width, context.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.setVertexBuffer(0, vertices)
    pass.draw(36)
    pass.end()`,
)

/** A pipeline whose vertex entry point doesn't exist: a WebGPU validation error, a program error for the canvas. */
export const invalid = `async function main() {
  widget.render(${scene})
  const device = await widget.gpu.requestDevice()
  const format = widget.gpu.getPreferredCanvasFormat()
  widget.gpu.getContext("scene").configure({ device, format })
  const module = device.createShaderModule({ code: ${JSON.stringify(TRIANGLE)} })
  device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "nope" }, fragment: { module, entryPoint: "fs", targets: [{ format }] } })
  await widget.frame()
  widget.render(ui.column([${scene}, ui.button("still here", { onPress: () => widget.render(ui.text("pressed")) })]))
  await widget.sleep(100000)
}`

/** Two GPU canvases, "a" and "b", 64 x 64 side by side, the device and their contexts. */
const two = (body: string) => `async function main(data) {
  widget.render(ui.row([ui.canvas({ key: "a", gpu: true, width: 64, height: 64, alt: "A" }), ui.canvas({ key: "b", gpu: true, width: 64, height: 64, alt: "B" })]))
  let device = await widget.gpu.requestDevice()
  const format = widget.gpu.getPreferredCanvasFormat()
  const ctx = {}
  const configure = () => {
    for (const k of ["a", "b"]) {
      ctx[k] = widget.gpu.getContext(k)
      ctx[k].configure({ device, format, alphaMode: "opaque" })
    }
  }
  configure()
  const gone = () => {
    const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.VERTEX })
    buffer.destroy()
    return buffer
  }
  // A pass into canvas k cleared to color; with a destroyed vertex buffer set, a host-check error.
  const pass = (encoder, k, color, broken) => {
    const buffer = broken ? gone() : null
    const p = encoder.beginRenderPass({ colorAttachments: [{ view: ctx[k].getCurrentTexture().createView(), clearValue: color, loadOp: "clear", storeOp: "store" }] })
    if (buffer) p.setVertexBuffer(0, buffer)
    p.end()
  }
  const submit = (f) => {
    const encoder = device.createCommandEncoder()
    f(encoder)
    device.queue.submit([encoder.finish()])
  }
  ${body}
  await widget.sleep(100000)
}`

/**
 * One batch a frame into both canvases (a red, b green) until frame 3, whose batch makes a view of a but renders only
 * into b, and fails: b stops, a draws on (yellow; b's passes skipped). Frame 8's batch renders into both and fails in
 * a's pass: only a stops, b keeps its first error. `data.until`: the last frame.
 */
export const isolated = two(`for (let n = 0; n <= data.until; n++) {
    await widget.frame()
    submit((e) => {
      if (n < 3) {
        pass(e, "a", [1, 0, 0, 1])
        pass(e, "b", [0, 1, 0, 1])
      } else if (n === 3) {
        pass(e, "b", [0, 0, 1, 1])
        ctx.a.getCurrentTexture().createView()
        pass(e, "b", [0, 0, 1, 1], true)
      } else {
        pass(e, "a", [1, 1, 0, 1], n === 8)
        pass(e, "b", [0, 1, 1, 1])
      }
    })
  }`)

/**
 * a is drawn through a resolve target (a 4x multisampled pass resolved into it), b directly, in batches of their own;
 * frame 2's batch for a fails: only a stops, b draws on (blue from frame 3).
 */
export const resolved = two(`let msaa
  for (let n = 0; n < 8; n++) {
    await widget.frame()
    const target = ctx.a.getCurrentTexture()
    msaa ??= device.createTexture({ size: [target.width, target.height], sampleCount: 4, format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    submit((e) => {
      const buffer = n === 2 ? gone() : null
      const p = e.beginRenderPass({ colorAttachments: [{ view: msaa.createView(), resolveTarget: target.createView(), clearValue: [1, 0, 0, 1], loadOp: "clear", storeOp: "store" }] })
      if (buffer) p.setVertexBuffer(0, buffer)
      p.end()
    })
    await widget.sleep(1)
    submit((e) => pass(e, "b", n < 3 ? [0, 1, 0, 1] : [0, 0, 1, 1]))
  }`)

/**
 * a and b in batches of their own; frame 2's batch for a fails (a stops). Then it waits for the device's loss, asks
 * for a new device, configures both again and draws both blue: only b, which the loss stopped, starts again.
 */
export const restarted = two(`for (let n = 0; n < 5; n++) {
    await widget.frame()
    submit((e) => pass(e, "a", [1, 0, 0, 1], n === 2))
    await widget.sleep(1)
    submit((e) => pass(e, "b", [0, 1, 0, 1]))
  }
  widget.render(ui.column([ui.row([ui.canvas({ key: "a", gpu: true, width: 64, height: 64, alt: "A" }), ui.canvas({ key: "b", gpu: true, width: 64, height: 64, alt: "B" })]), ui.text("waiting")]))
  await device.lost
  device = await widget.gpu.requestDevice()
  configure()
  widget.render(ui.column([ui.row([ui.canvas({ key: "a", gpu: true, width: 64, height: 64, alt: "A" }), ui.canvas({ key: "b", gpu: true, width: 64, height: 64, alt: "B" })]), ui.text("restarted")]))
  for (let n = 0; n < 5; n++) {
    await widget.frame()
    submit((e) => pass(e, "a", [0, 0, 1, 1]))
    await widget.sleep(1)
    submit((e) => pass(e, "b", [0, 0, 1, 1]))
  }`)

/** a red for three frames, then frames with no GPU work: the last image stays. */
export const kept = two(`for (let n = 0; n < 3; n++) {
    await widget.frame()
    submit((e) => pass(e, "a", [1, 0, 0, 1]))
  }
  for (let n = 0; n < 60; n++) await widget.frame()`)

/** A GPU canvas whose physical width is over 4096: the program shows the size it was given, and a texture that size. */
export const clamped = `async function main() {
  widget.render(ui.canvas({ key: "big", gpu: true, height: 200, alt: "big" }))
  const device = await widget.gpu.requestDevice()
  const format = widget.gpu.getPreferredCanvasFormat()
  const context = widget.gpu.getContext("big")
  context.configure({ device, format, alphaMode: "opaque" })
  for (let n = 0; n < 4; n++) {
    await widget.frame()
    const depth = device.createTexture({ size: [context.width, context.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const encoder = device.createCommandEncoder()
    encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: [0, 1, 0, 1], loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    }).end()
    device.queue.submit([encoder.finish()])
    depth.destroy()
    widget.render(ui.column([ui.canvas({ key: "big", gpu: true, height: 200, alt: "big" }), ui.text(context.width + "x" + context.height)]))
  }
  await widget.sleep(100000)
}`
