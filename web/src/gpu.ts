// GPU canvases (widgets-gpu.md): a live program's WebGPU calls, recorded by the prelude into batches of ops and bytes,
// replayed here on the browser's WebGPU, on the page's thread where the canvases are. One device per widget; its
// resources stand in an array by handle. WebGPU validates (an error scope per batch); this host checks the subset's
// ops, handles and limits. A program error stops the canvases the batch drew (or every one), once.

/** A batch as the worker hands it over: the ops, and the bytes they name by `[byteOffset, byteLength]`. */
export interface Batch {
  ops: unknown[][]
  bytes: Uint8Array<ArrayBuffer>
}

/** What the replay needs of a GPU canvas on the page. */
export interface GpuCanvas {
  readonly canvas: HTMLCanvasElement
  /** Measures it now: whether it has a size to draw at. */
  sized(): boolean
  /** The key the program configured it by, for its size messages. */
  key: string | undefined
  /** Shows the placeholder: `poster`, else `alt`, else "GPU canvas not supported"; with a program error's message. */
  placeholder(message?: string): void
  /** Back from the placeholder: the canvas draws again. */
  shown(): void
}

export interface GpuHost {
  /** The GPU canvas with this key in the last rendered view. */
  canvas(key: string): GpuCanvas | undefined
  /** A program error (phase `gpu`), reported once by the host. */
  programError(message: string): void
  clientError(message: string, cause?: unknown): void
  /** The device was lost: `{ type: "gpu", lost: reason }` to the program. */
  lost(reason: string, message: string): void
  /** No WebGPU, or no device: every GPU canvas shows its placeholder (a client error, logged). */
  unavailable(): void
  /** How long a batch's replay took on this thread, in ms (the GPU's work runs after). */
  metric(ms: number): void
}

/** Limits (widgets-gpu.md, Limits). */
const MAX_TEXTURE = 4096
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_MEMORY = 256 * 1024 * 1024
const MAX_HANDLES = 4096
const MAX_BATCH_BYTES = 4 * 1024 * 1024
const MAX_BATCH_OPS = 20000
const MAX_PASSES = 16
const MAX_DRAWS = 10000
const MAX_SHADER = 256 * 1024

/** Bytes per texel of the subset's texture formats. */
const TEXEL: Record<string, number> = {
  rgba8unorm: 4,
  "rgba8unorm-srgb": 4,
  bgra8unorm: 4,
  r8unorm: 1,
  rgba16float: 8,
  depth24plus: 4,
  depth32float: 4,
}

/** A failure the program caused: reported as phase `gpu`, and the canvases stop. */
class ProgramError extends Error {}

type Obj =
  | {
      kind: "context"
      key: string
      format: GPUTextureFormat
      alphaMode: GPUCanvasAlphaMode
      view?: GpuCanvas
      ctx?: GPUCanvasContext
      stopped?: boolean
    }
  | { kind: "buffer"; gpu: GPUBuffer; bytes: number; live: boolean }
  | { kind: "texture"; gpu: GPUTexture; bytes: number; live: boolean }
  | { kind: "view"; gpu?: GPUTextureView; context?: number; descriptor?: GPUTextureViewDescriptor }
  | { kind: "sampler"; gpu: GPUSampler }
  | { kind: "shader"; gpu: GPUShaderModule }
  | { kind: "bindGroupLayout"; gpu: GPUBindGroupLayout }
  | { kind: "pipelineLayout"; gpu: GPUPipelineLayout }
  | { kind: "renderPipeline"; gpu: GPURenderPipeline }
  | { kind: "bindGroup"; gpu: GPUBindGroup }

const num = (v: unknown): number => (typeof v === "number" ? v : NaN)
const xyz = (v: unknown): GPUOrigin3DDict => {
  const a = Array.isArray(v) ? v : []
  return { x: num(a[0] ?? 0), y: num(a[1] ?? 0), z: num(a[2] ?? 0) }
}
const extent = (v: unknown): GPUExtent3DDict => {
  const a = Array.isArray(v) ? v : []
  return { width: num(a[0]), height: num(a[1] ?? 1), depthOrArrayLayers: num(a[2] ?? 1) }
}
const optional = (v: unknown): number | undefined => (typeof v === "number" && v >= 0 ? v : undefined)

export class GpuReplay {
  private device: GPUDevice | undefined
  private starting: Promise<GPUDevice | undefined> | undefined
  /** Batches waiting for the device, in order. */
  private waiting: Batch[] = []
  private unavailable = false
  private objects: Array<Obj | undefined> = []
  private live = 0
  private memory = 0
  private passes = 0
  private draws = 0
  /** Every canvas stopped by a program error: later batches are ignored. */
  private stopped = false
  private closed = false
  private encoder: GPUCommandEncoder | undefined
  private pass: GPURenderPassEncoder | undefined
  /** The contexts the batch being replayed drew into, for its errors. */
  private touched = new Set<Obj & { kind: "context" }>()

  constructor(private readonly host: GpuHost) {}

  /** Replays `batch` in order after the ones before it. */
  batch(batch: Batch) {
    if (this.closed || this.stopped || this.unavailable) return
    if (this.device && this.waiting.length === 0) return this.replay(this.device, batch)
    this.waiting.push(batch)
    void this.start()
  }

  /** A frame went to the program: the per-frame limits start again (between two `widget.frame()`). */
  frame() {
    this.passes = 0
    this.draws = 0
  }

  /** Every configured canvas: the placeholder shows while the device is missing or lost. */
  private contexts(): Array<Obj & { kind: "context" }> {
    return this.objects.filter((o): o is Obj & { kind: "context" } => o?.kind === "context")
  }

  private async start() {
    this.starting ??= (async () => {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
      try {
        const adapter = gpu ? await gpu.requestAdapter() : null
        const device = adapter ? await adapter.requestDevice() : undefined
        if (!device) throw new Error(gpu ? "no WebGPU adapter" : "no WebGPU in this browser")
        return device
      } catch (e) {
        this.host.clientError(`GPU canvas: ${String((e as Error)?.message ?? e)}`, e)
        return undefined
      }
    })()
    const device = await this.starting
    this.starting = undefined
    if (this.closed) return device?.destroy()
    if (!device) {
      // Unavailable is not an error: the placeholder shows, the program's calls are dropped.
      this.unavailable = true
      this.waiting = []
      return this.host.unavailable()
    }
    if (this.device !== device) this.adopt(device)
    for (const batch of this.waiting.splice(0)) this.replay(device, batch)
  }

  private adopt(device: GPUDevice) {
    this.device = device
    device.onuncapturederror = (e) => this.programError(e.error.message, [...this.contexts()])
    void device.lost.then((info) => {
      if (this.closed || this.device !== device) return
      // Every handle is gone; the program may ask for a device again and make its resources anew. Until it does, its
      // canvases show their placeholders.
      for (const c of this.contexts()) {
        c.ctx?.unconfigure()
        c.view?.placeholder()
      }
      this.device = undefined
      this.objects = []
      this.live = 0
      this.memory = 0
      this.encoder = undefined
      this.pass = undefined
      this.host.lost(info.reason ?? "unknown", info.message)
    })
  }

  private replay(device: GPUDevice, batch: Batch) {
    if (this.stopped) return
    const started = performance.now()
    this.touched.clear()
    device.pushErrorScope("out-of-memory")
    device.pushErrorScope("validation")
    try {
      if (batch.bytes.byteLength > MAX_BATCH_BYTES)
        throw new ProgramError(`a GPU batch of ${batch.bytes.byteLength} bytes is over the limit of 4 MB`)
      if (batch.ops.length > MAX_BATCH_OPS)
        throw new ProgramError(`a GPU batch of ${batch.ops.length} ops is over the limit of ${MAX_BATCH_OPS}`)
      for (const op of batch.ops) this.op(device, op, batch.bytes)
    } catch (e) {
      this.encoder = undefined
      this.pass = undefined
      const message = String((e as Error)?.message ?? e)
      // A WebGPU call that throws (a wrong type, an offset out of range) is the program's too.
      this.programError(message, [...this.touched])
    }
    this.host.metric(performance.now() - started)
    const touched = [...this.touched]
    void device.popErrorScope().then((e) => e && this.programError(e.message, touched))
    void device.popErrorScope().then((e) => {
      if (!e || this.closed) return
      this.host.clientError(`GPU canvas: out of GPU memory: ${e.message}`)
      this.stop(touched, "out of GPU memory")
    })
  }

  /** A program error: reported once, and the canvases it concerns (or every one) stop, with the error shown. */
  private programError(message: string, touched: Array<Obj & { kind: "context" }>) {
    if (this.closed || this.stopped) return
    this.host.programError(message)
    this.stop(touched, message)
  }

  private stop(touched: Array<Obj & { kind: "context" }>, message: string) {
    const all = this.contexts()
    const hit = touched.length > 0 ? touched : all
    for (const c of hit) {
      c.view?.placeholder(message)
      c.ctx?.unconfigure()
      c.ctx = undefined
      c.view = undefined
      c.stopped = true
    }
    if (all.every((c) => c.stopped)) this.stopped = true
  }

  /** A new handle's slot: a positive integer the prelude hasn't used. */
  private slot(h: unknown): number {
    if (typeof h !== "number" || !Number.isInteger(h) || h < 1) throw new ProgramError(`a GPU handle must be a positive integer`)
    if (++this.live > MAX_HANDLES) throw new ProgramError(`more than ${MAX_HANDLES} live GPU handles`)
    return h
  }

  private get<K extends Obj["kind"]>(h: unknown, ...kinds: K[]): Obj & { kind: K } {
    const o = typeof h === "number" ? this.objects[h] : undefined
    if (!o) throw new ProgramError(`no GPU object with handle ${String(h)}`)
    if (kinds.length > 0 && !kinds.includes(o.kind as K)) throw new ProgramError(`GPU handle ${String(h)} is a ${o.kind}, not a ${kinds.join(" or ")}`)
    return o as Obj & { kind: K }
  }

  /** The context's canvas, configured: it may have been rendered anew since. */
  private context(o: Obj & { kind: "context" }, device: GPUDevice): GPUCanvasContext {
    const view = this.host.canvas(o.key)
    if (!view) throw new ProgramError(`No GPU canvas with key "${o.key}" in the rendered view`)
    if (o.view !== view || !o.ctx) {
      // Sized before it is configured: its texture is the canvas's size in physical pixels.
      view.sized()
      const ctx = view.canvas.getContext("webgpu")
      if (!ctx) throw new Error("the canvas has no WebGPU context")
      ctx.configure({
        device,
        format: o.format,
        alphaMode: o.alphaMode,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      })
      view.shown()
      view.key = o.key
      o.view = view
      o.ctx = ctx
    }
    return o.ctx
  }

  /** A texture by handle: a context's stands for its canvas's current texture. */
  private texture(h: unknown, device: GPUDevice): GPUTexture {
    const o = this.get(h, "texture", "context")
    if (o.kind === "texture") return o.gpu
    this.touched.add(o)
    return this.context(o, device).getCurrentTexture()
  }

  private view(h: unknown, device: GPUDevice): GPUTextureView {
    const o = this.get(h, "view")
    if (o.gpu) return o.gpu
    const c = this.get(o.context, "context")
    this.touched.add(c)
    return this.context(c, device).getCurrentTexture().createView(o.descriptor)
  }

  private encode(device: GPUDevice): GPUCommandEncoder {
    return (this.encoder ??= device.createCommandEncoder())
  }

  private inPass(): GPURenderPassEncoder {
    if (!this.pass) throw new ProgramError("a render pass command outside a render pass")
    return this.pass
  }

  private allocate(bytes: number) {
    this.memory += bytes
    if (this.memory > MAX_MEMORY) throw new ProgramError(`more than 256 MB of GPU buffers and textures`)
  }

  private op(device: GPUDevice, op: unknown[], bytes: Uint8Array<ArrayBuffer>) {
    if (!Array.isArray(op)) throw new ProgramError("a GPU op is an array")
    const [name, a, b, c, d, e, f, g, h] = op
    switch (name) {
      case "context": {
        const o: Obj = { kind: "context", key: String(b), format: c as GPUTextureFormat, alphaMode: d as GPUCanvasAlphaMode }
        this.objects[this.slot(a)] = o
        this.context(o, device)
        return
      }
      case "buffer": {
        const size = num(b)
        if (size > MAX_BUFFER) throw new ProgramError(`a GPU buffer of ${size} bytes is over the limit of 64 MB`)
        const h = this.slot(a)
        this.allocate(size)
        this.objects[h] = { kind: "buffer", gpu: device.createBuffer({ size, usage: num(c) }), bytes: size, live: true }
        return
      }
      case "texture": {
        const [width, height, layers, format, usage, mips, samples] = [num(b), num(c), num(d), String(e), num(f), num(g ?? 1), num(h ?? 1)]
        if (width > MAX_TEXTURE || height > MAX_TEXTURE)
          throw new ProgramError(`a GPU texture of ${width}x${height} is over the limit of ${MAX_TEXTURE}`)
        const texel = TEXEL[format]
        if (texel === undefined) throw new ProgramError(`GPU texture format "${format}" isn't in the subset`)
        let size = 0
        for (let level = 0; level < mips; level++) size += Math.max(1, width >> level) * Math.max(1, height >> level)
        size *= layers * texel * samples
        const slot = this.slot(a)
        this.allocate(size)
        const gpu = device.createTexture({ size: [width, height, layers], format: format as GPUTextureFormat, usage, mipLevelCount: mips, sampleCount: samples })
        this.objects[slot] = { kind: "texture", gpu, bytes: size, live: true }
        return
      }
      case "view": {
        const slot = this.slot(a)
        const o = this.get(b, "texture", "context")
        const descriptor = (c ?? undefined) as GPUTextureViewDescriptor | undefined
        // A context's views stand for its current texture: made anew from the descriptor each time.
        this.objects[slot] = o.kind === "texture" ? { kind: "view", gpu: o.gpu.createView(descriptor) } : { kind: "view", context: b as number, descriptor }
        return
      }
      case "sampler":
        this.objects[this.slot(a)] = { kind: "sampler", gpu: device.createSampler((b ?? undefined) as GPUSamplerDescriptor | undefined) }
        return
      case "shader": {
        const code = String(b)
        if (code.length > MAX_SHADER / 3 && new TextEncoder().encode(code).length > MAX_SHADER)
          throw new ProgramError(`a WGSL module over 256 KB`)
        this.objects[this.slot(a)] = { kind: "shader", gpu: device.createShaderModule({ code }) }
        return
      }
      case "bindGroupLayout":
        this.objects[this.slot(a)] = { kind: "bindGroupLayout", gpu: device.createBindGroupLayout(b as GPUBindGroupLayoutDescriptor) }
        return
      case "pipelineLayout": {
        const layouts = (Array.isArray(b) ? b : []).map((l) => this.get(l, "bindGroupLayout").gpu)
        this.objects[this.slot(a)] = { kind: "pipelineLayout", gpu: device.createPipelineLayout({ bindGroupLayouts: layouts }) }
        return
      }
      case "renderPipeline": {
        const slot = this.slot(a)
        const d = (b ?? {}) as Record<string, unknown>
        const stage = (s: unknown) => (s && typeof s === "object" ? { ...(s as object), module: this.get((s as { module?: unknown }).module, "shader").gpu } : s)
        const descriptor = {
          ...d,
          layout: d.layout === "auto" ? "auto" : this.get(d.layout, "pipelineLayout").gpu,
          vertex: stage(d.vertex),
          ...(d.fragment ? { fragment: stage(d.fragment) } : {}),
        } as GPURenderPipelineDescriptor
        this.objects[slot] = { kind: "renderPipeline", gpu: device.createRenderPipeline(descriptor) }
        return
      }
      case "autoLayout":
        this.objects[this.slot(a)] = { kind: "bindGroupLayout", gpu: this.get(b, "renderPipeline").gpu.getBindGroupLayout(num(c)) }
        return
      case "bindGroup": {
        const slot = this.slot(a)
        const d = (b ?? {}) as { layout?: unknown; entries?: unknown[] }
        const entries = (Array.isArray(d.entries) ? d.entries : []).map((entry) => {
          const { binding, resource } = (entry ?? {}) as { binding?: number; resource?: unknown }
          if (resource && typeof resource === "object") {
            const r = resource as { buffer?: unknown; offset?: number; size?: number }
            return { binding, resource: { ...r, buffer: this.get(r.buffer, "buffer").gpu } }
          }
          const o = this.get(resource, "sampler", "view")
          return { binding, resource: o.kind === "sampler" ? o.gpu : this.view(resource, device) }
        }) as GPUBindGroupEntry[]
        this.objects[slot] = { kind: "bindGroup", gpu: device.createBindGroup({ layout: this.get(d.layout, "bindGroupLayout").gpu, entries }) }
        return
      }
      case "destroy": {
        const o = this.get(a)
        if ((o.kind === "buffer" || o.kind === "texture") && o.live) {
          o.live = false
          o.gpu.destroy()
          this.memory -= o.bytes
          this.live--
        }
        return
      }
      case "writeBuffer":
        device.queue.writeBuffer(this.get(a, "buffer").gpu, num(b), bytes, num(c), num(d))
        return
      case "writeTexture": {
        const [mip, origin, offset, length, bytesPerRow, rowsPerImage, size] = [b, c, d, e, f, g, h]
        if (num(offset) + num(length) > bytes.byteLength || num(offset) < 0) throw new ProgramError("writeTexture's bytes are out of the batch's range")
        device.queue.writeTexture(
          { texture: this.texture(a, device), mipLevel: num(mip), origin: xyz(origin) },
          bytes.subarray(num(offset), num(offset) + num(length)),
          { offset: 0, bytesPerRow: num(bytesPerRow), rowsPerImage: optional(rowsPerImage) },
          extent(size),
        )
        return
      }
      case "copyBufferToBuffer":
        this.encode(device).copyBufferToBuffer(this.get(a, "buffer").gpu, num(b), this.get(c, "buffer").gpu, num(d), num(e))
        return
      case "copyBufferToTexture":
        this.encode(device).copyBufferToTexture(
          { buffer: this.get(a, "buffer").gpu, offset: num(b), bytesPerRow: num(c), rowsPerImage: optional(d) },
          { texture: this.texture(e, device), mipLevel: num(f), origin: xyz(g) },
          extent(h),
        )
        return
      case "copyTextureToTexture":
        this.encode(device).copyTextureToTexture(
          { texture: this.texture(a, device), mipLevel: num(b), origin: xyz(c) },
          { texture: this.texture(d, device), mipLevel: num(e), origin: xyz(f) },
          extent(g),
        )
        return
      case "pass": {
        if (++this.passes > MAX_PASSES) throw new ProgramError(`more than ${MAX_PASSES} render passes in a frame`)
        const d = (a ?? {}) as { colorAttachments?: unknown[]; depthStencilAttachment?: Record<string, unknown> }
        const colorAttachments = (Array.isArray(d.colorAttachments) ? d.colorAttachments : []).map((attachment) => {
          if (!attachment) return null
          const at = attachment as Record<string, unknown>
          return { ...at, view: this.view(at.view, device), ...(at.resolveTarget !== undefined && at.resolveTarget !== null ? { resolveTarget: this.view(at.resolveTarget, device) } : {}) }
        }) as GPURenderPassColorAttachment[]
        const depth = d.depthStencilAttachment ? { ...d.depthStencilAttachment, view: this.view(d.depthStencilAttachment.view, device) } : undefined
        this.pass = this.encode(device).beginRenderPass({
          colorAttachments,
          ...(depth ? { depthStencilAttachment: depth as unknown as GPURenderPassDepthStencilAttachment } : {}),
        })
        return
      }
      case "setPipeline":
        this.inPass().setPipeline(this.get(a, "renderPipeline").gpu)
        return
      case "setBindGroup":
        this.inPass().setBindGroup(num(a), this.get(b, "bindGroup").gpu, Array.isArray(c) ? (c as number[]) : [])
        return
      case "setVertexBuffer":
        this.inPass().setVertexBuffer(num(a), this.get(b, "buffer").gpu, num(c ?? 0), optional(d))
        return
      case "setIndexBuffer":
        this.inPass().setIndexBuffer(this.get(a, "buffer").gpu, b as GPUIndexFormat, num(c ?? 0), optional(d))
        return
      case "setViewport":
        this.inPass().setViewport(num(a), num(b), num(c), num(d), num(e), num(f))
        return
      case "setScissorRect":
        this.inPass().setScissorRect(num(a), num(b), num(c), num(d))
        return
      case "draw":
        if (++this.draws > MAX_DRAWS) throw new ProgramError(`more than ${MAX_DRAWS} draws in a frame`)
        this.inPass().draw(num(a), num(b), num(c), num(d))
        return
      case "drawIndexed":
        if (++this.draws > MAX_DRAWS) throw new ProgramError(`more than ${MAX_DRAWS} draws in a frame`)
        this.inPass().drawIndexed(num(a), num(b), num(c), num(d), num(e))
        return
      case "end":
        this.inPass().end()
        this.pass = undefined
        return
      case "submit": {
        if (this.pass) throw new ProgramError("submit inside a render pass")
        const encoder = this.encoder
        this.encoder = undefined
        device.queue.submit(encoder ? [encoder.finish()] : [])
        return
      }
      default:
        throw new ProgramError(`unknown GPU op ${JSON.stringify(name)}`)
    }
  }

  /** The widget stopped: its device and everything on it go. */
  destroy() {
    this.closed = true
    this.waiting = []
    for (const c of this.contexts()) c.ctx?.unconfigure()
    this.objects = []
    this.device?.destroy()
    this.device = undefined
  }
}
