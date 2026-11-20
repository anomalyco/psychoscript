// `shader` nodes on the GPU: WGSL straight to WebGPU where the browser has it, else WebGL2 with the WGSL translated to
// GLSL ES 3.00 by naga in the worker (widgets.md, Shader).

/** What clients prepend to a template's WGSL. */
export const HEADER =
  "struct Widget { resolution: vec2f, time: f32, scale: f32, pointer: vec4f, values: array<vec4f, 4> }\n@group(0) @binding(0) var<uniform> widget: Widget;\n"
const HEADER_LINES = 2
const ENTRY =
  "\n@fragment fn widget_main(@builtin(position) p: vec4f) -> @location(0) vec4f { return shade(p.xy); }\n" +
  "@vertex fn widget_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n" +
  "  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));\n  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);\n}\n"

/** The uniform block: resolution, time, scale, pointer, values (std140 and WGSL agree: 96 bytes). */
export const UNIFORM_FLOATS = 24

export interface ShaderError {
  message: string
  line?: number
  column?: number
}

/** One shader on one canvas. */
export interface Surface {
  readonly backend: "webgpu" | "webgl2"
  /** Draws a frame with `uniforms`; resolves with how long the GPU took when the backend can tell, else undefined. */
  render(uniforms: Float32Array): Promise<number | undefined> | undefined
  destroy(): void
}

// ---------- WebGPU ----------

interface Gpu {
  /** Held: Chromium drops the instance (and fails every call) once its adapter is collected. */
  adapter: GPUAdapter
  device: GPUDevice
  format: GPUTextureFormat
  pipelines: Map<string, Promise<GPURenderPipeline | ShaderError>>
  layout: GPUBindGroupLayout
}

let gpu: Promise<Gpu | undefined> | undefined
let forceWebGL = false

/** Use WebGL2 even where WebGPU works (tests, or a host that wants it). */
export function preferWebGL(on: boolean) {
  forceWebGL = on
}

export function webgpu(): Promise<Gpu | undefined> {
  if (forceWebGL) return Promise.resolve(undefined)
  gpu ??= (async () => {
    const nav = navigator as Navigator & { gpu?: GPU }
    if (!nav.gpu) return undefined
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: "low-power" })
      if (!adapter) return undefined
      const device = await adapter.requestDevice()
      void device.lost.then(() => {
        gpu = undefined
      })
      const layout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
      })
      return { adapter, device, format: nav.gpu.getPreferredCanvasFormat(), pipelines: new Map(), layout }
    } catch {
      return undefined
    }
  })()
  return gpu
}

async function pipeline(g: Gpu, wgsl: string): Promise<GPURenderPipeline | ShaderError> {
  let p = g.pipelines.get(wgsl)
  if (!p) {
    p = (async () => {
      const code = HEADER + wgsl + ENTRY
      g.device.pushErrorScope("validation")
      const module = g.device.createShaderModule({ code })
      const info = await module.getCompilationInfo()
      const error = info.messages.find((m) => m.type === "error")
      if (error) {
        await g.device.popErrorScope()
        const line = error.lineNum > HEADER_LINES ? error.lineNum - HEADER_LINES : undefined
        return { message: error.message, line, column: line ? error.linePos : undefined }
      }
      try {
        const made = await g.device.createRenderPipelineAsync({
          layout: g.device.createPipelineLayout({ bindGroupLayouts: [g.layout] }),
          vertex: { module, entryPoint: "widget_vertex" },
          fragment: { module, entryPoint: "widget_main", targets: [{ format: g.format }] },
          primitive: { topology: "triangle-list" },
        })
        const scoped = await g.device.popErrorScope()
        if (scoped) return { message: scoped.message }
        return made
      } catch (e) {
        await g.device.popErrorScope()
        return { message: String((e as Error)?.message ?? e) }
      }
    })()
    g.pipelines.set(wgsl, p)
  }
  return p
}

async function gpuSurface(g: Gpu, canvas: HTMLCanvasElement, wgsl: string): Promise<Surface | ShaderError> {
  const made = await pipeline(g, wgsl)
  if ("message" in made) return made
  const context = canvas.getContext("webgpu")
  if (!context) return { message: "no WebGPU context" }
  context.configure({ device: g.device, format: g.format, alphaMode: "premultiplied" })
  const buffer = g.device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const bind = g.device.createBindGroup({ layout: g.layout, entries: [{ binding: 0, resource: { buffer } }] })
  let destroyed = false
  let timing = true
  let measuring = false
  return {
    backend: "webgpu",
    render(uniforms) {
      if (destroyed || canvas.width === 0 || canvas.height === 0) return undefined
      g.device.queue.writeBuffer(buffer, 0, uniforms.buffer, uniforms.byteOffset, uniforms.byteLength)
      const encoder = g.device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
        ],
      })
      pass.setPipeline(made)
      pass.setBindGroup(0, bind)
      pass.draw(3)
      pass.end()
      const started = performance.now()
      g.device.queue.submit([encoder.finish()])
      // One frame measured at a time, so the time is this frame's rather than a queue of them.
      if (!timing || measuring) return undefined
      measuring = true
      return g.device.queue.onSubmittedWorkDone().then(
        () => {
          measuring = false
          return performance.now() - started
        },
        () => {
          // Some implementations (SwiftShader in headless Chromium) can't tell: no GPU-time budget there.
          timing = false
          return undefined
        },
      )
    },
    destroy() {
      destroyed = true
      buffer.destroy()
      context.unconfigure()
    },
  }
}

// ---------- WebGL2 ----------

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

function glSurface(canvas: HTMLCanvasElement, translated: { code: string; block: string }): Surface | ShaderError {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  })
  if (!gl) return { message: "this browser has neither WebGPU nor WebGL2" }
  const compile = (type: number, source: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) ?? "compile error"
      gl.deleteShader(s)
      throw new Error(log)
    }
    return s
  }
  let program: WebGLProgram
  try {
    const vs = compile(gl.VERTEX_SHADER, VERTEX)
    const fs = compile(gl.FRAGMENT_SHADER, translated.code)
    program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error")
  } catch (e) {
    return { message: String((e as Error).message) }
  }
  const ubo = gl.createBuffer()
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
  gl.bufferData(gl.UNIFORM_BUFFER, UNIFORM_FLOATS * 4, gl.DYNAMIC_DRAW)
  const index = translated.block ? gl.getUniformBlockIndex(program, translated.block) : gl.INVALID_INDEX
  if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, 0)
  const vao = gl.createVertexArray()
  let destroyed = false
  return {
    backend: "webgl2",
    render(uniforms) {
      if (destroyed || gl.isContextLost()) return undefined
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, uniforms)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return undefined
    },
    destroy() {
      destroyed = true
      gl.deleteProgram(program)
      gl.deleteBuffer(ubo)
      gl.deleteVertexArray(vao)
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    },
  }
}

/** Makes a surface for `wgsl` on `canvas`: WebGPU, else WebGL2 with `translate` (naga in the worker). */
export async function surface(
  canvas: HTMLCanvasElement,
  wgsl: string,
  translate: (wgsl: string) => Promise<{ code: string; block: string } | ShaderError>,
): Promise<Surface | ShaderError> {
  const g = await webgpu()
  if (g) return gpuSurface(g, canvas, wgsl)
  const translated = await translate(wgsl)
  if ("message" in translated) return translated
  return glSurface(canvas, translated)
}
