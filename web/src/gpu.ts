// GPU canvases (widgets-gpu.md): a live program's WebGPU calls, recorded by the prelude into batches of ops and bytes,
// replayed here on the browser's WebGPU, on the page's thread where the canvases are. One device per widget; its
// resources stand in an array by handle. Each batch first passes the host checks (gpu-checks.ts: the ops' shapes,
// handles and limits, with the spec's messages); WebGPU validates what replays (an error scope per batch). An error is
// a program error in phase `gpu` that stops the canvases the batch renders into, else every one, once.

import { type Checked, gpuChecks, type GpuError } from "./gpu-checks.js"

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
  /** Shows the placeholder: `poster`, else `alt`, else "GPU canvas not supported"; with a program error's message. */
  placeholder(message?: string): void
  /** Back from the placeholder: the canvas draws again. */
  shown(): void
}

export interface GpuHost {
  /** The GPU canvas with this key in the last rendered view. */
  canvas(key: string): GpuCanvas | undefined
  /** The keys of the GPU canvases in the last rendered view. */
  keys(): ReadonlySet<string>
  /** A program error (phase `gpu`), reported once by the host. */
  programError(message: string): void
  clientError(message: string, cause?: unknown): void
  /** The device was lost: `{ type: "gpu", lost: reason, message }` to the program. */
  lost(reason: string, message: string): void
  /** No WebGPU, or no device: every GPU canvas shows its placeholder (a client error, logged). */
  unavailable(): void
  /** How long a batch's replay took on this thread, in ms (the GPU's work runs after). */
  metric(ms: number): void
}

type Context = {
  kind: "context"
  key: string
  format: GPUTextureFormat
  alphaMode: GPUCanvasAlphaMode
  view?: GpuCanvas
  ctx?: GPUCanvasContext
}
type Obj =
  | Context
  | { kind: "buffer"; gpu: GPUBuffer }
  | { kind: "texture"; gpu: GPUTexture }
  | { kind: "view"; gpu?: GPUTextureView; context?: number; descriptor?: GPUTextureViewDescriptor }
  | { kind: "sampler"; gpu: GPUSampler }
  | { kind: "shader"; gpu: GPUShaderModule }
  | { kind: "bindGroupLayout"; gpu: GPUBindGroupLayout }
  | { kind: "pipelineLayout"; gpu: GPUPipelineLayout }
  | { kind: "renderPipeline"; gpu: GPURenderPipeline }
  | { kind: "bindGroup"; gpu: GPUBindGroup }

const num = (v: unknown): number => v as number
const xyz = (v: unknown): GPUOrigin3DDict => {
  const [x, y, z] = v as [number, number, number]
  return { x, y, z }
}
const extent = (v: unknown): GPUExtent3DDict => {
  const [width, height, depthOrArrayLayers] = v as [number, number, number]
  return { width, height, depthOrArrayLayers }
}
const whole = (v: unknown): number | undefined => (v === -1 || v === null ? undefined : (v as number))

/** A normalised descriptor as WebGPU takes it: members that are `null` (absent, in the transport) left out. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean)
  if (!v || typeof v !== "object") return v
  const out: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(v)) if (item !== null) out[k] = clean(item)
  return out
}

export class GpuReplay {
  private device: GPUDevice | undefined
  private starting = false
  /** Checked batches waiting for the device, in order. */
  private waiting: Array<{ batch: Batch; checked: Checked }> = []
  private unavailable = false
  private objects: Array<Obj | undefined> = []
  private closed = false
  private encoder: GPUCommandEncoder | undefined
  private pass: GPURenderPassEncoder | undefined
  private readonly checks: ReturnType<typeof gpuChecks>
  /** The stopped canvases' errors by key, and the error that stopped every one: a canvas rendered anew stays stopped. */
  private readonly stopped = new Map<string, string>()
  private all: string | undefined

  constructor(private readonly host: GpuHost) {
    this.checks = gpuChecks(() => host.keys())
  }

  /** Checks `batch` now, in order, and replays what passes after the batches before it. */
  batch(batch: unknown, frame: boolean) {
    if (this.closed || this.unavailable) return
    const checked = this.checks.batch(batch, frame)
    if (checked.error) this.fail(checked.error)
    // Ignored: every canvas it renders into stopped, or it failed before its first op.
    if (checked.skip || (checked.error && checked.at === undefined)) return
    const b = batch as Batch
    if (this.device && this.waiting.length === 0) return this.replay(this.device, b, checked)
    this.waiting.push({ batch: b, checked })
    void this.start()
  }

  /** A program error: reported once; its canvases (or every one) stop and show their placeholder with it. */
  private fail(error: GpuError) {
    this.host.programError(error.message)
    if (error.canvases === "all") this.all ??= error.message
    const keys = error.canvases === "all" ? [...this.host.keys()] : error.canvases
    for (const key of keys) if (!this.stopped.has(key)) this.stopped.set(key, error.message)
    for (const key of keys) {
      for (const o of this.objects) {
        if (o?.kind !== "context" || o.key !== key) continue
        o.ctx?.unconfigure()
        o.ctx = undefined
        o.view = undefined
      }
      this.host.canvas(key)?.placeholder(error.message)
    }
  }

  private async start() {
    if (this.starting) return
    this.starting = true
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
    let device: GPUDevice | undefined
    try {
      const adapter = gpu ? await gpu.requestAdapter() : null
      device = adapter ? await adapter.requestDevice() : undefined
      if (!device) throw new Error(gpu ? "no WebGPU adapter" : "no WebGPU in this browser")
    } catch (e) {
      this.host.clientError(`GPU canvas: ${String((e as Error)?.message ?? e)}`, e)
    }
    this.starting = false
    if (this.closed) return device?.destroy()
    if (!device) {
      // Unavailable is not an error: the placeholder shows, the program's batches are dropped.
      this.unavailable = true
      this.waiting = []
      return this.host.unavailable()
    }
    this.adopt(device)
    for (const { batch, checked } of this.waiting.splice(0)) this.replay(device, batch, checked)
  }

  private adopt(device: GPUDevice) {
    this.device = device
    device.onuncapturederror = (e) => {
      const error = this.checks.scoped(e.error.message, [])
      if (error) this.fail(error)
    }
    void device.lost.then((info) => {
      if (this.closed || this.device !== device) return
      // Every handle is gone; the program may ask for a device again and make its resources anew (new handles). Until
      // it configures a canvas again, the canvas shows its placeholder.
      for (const o of this.objects) {
        if (o?.kind !== "context") continue
        o.ctx?.unconfigure()
        o.view?.placeholder()
      }
      this.device = undefined
      this.objects = []
      this.encoder = undefined
      this.pass = undefined
      this.checks.lost()
      this.host.lost(info.reason ?? "unknown", info.message)
    })
  }

  private replay(device: GPUDevice, batch: Batch, checked: Checked) {
    const started = performance.now()
    // The ops that passed the checks: all of them, or those before the one that failed.
    const count = checked.at ?? batch.ops.length
    device.pushErrorScope("out-of-memory")
    device.pushErrorScope("validation")
    try {
      for (let i = 0; i < count; i++) this.op(device, batch.ops[i]!, batch.bytes)
    } catch (e) {
      // A WebGPU call that throws (a value it refuses) is the program's too, in WebGPU's words.
      const error = this.checks.scoped(String((e as Error)?.message ?? e), checked.keys)
      if (error) this.fail(error)
    }
    // A failed batch ends there: what it began isn't submitted.
    if (count < batch.ops.length || this.pass) {
      this.encoder = undefined
      this.pass = undefined
    }
    this.host.metric(performance.now() - started)
    const keys = checked.keys
    void device.popErrorScope().then((e) => {
      const error = e && !this.closed ? this.checks.scoped(e.message, keys) : undefined
      if (error) this.fail(error)
    })
    void device.popErrorScope().then((e) => {
      if (!e || this.closed) return
      // Out of GPU memory under the limits: this host's (a client error); the canvases stop.
      this.host.clientError(`GPU canvas: out of GPU memory: ${e.message}`)
      for (const key of keys.length > 0 ? keys : this.host.keys()) this.host.canvas(key)?.placeholder()
    })
  }

  private get<K extends Obj["kind"]>(h: unknown): Obj & { kind: K } {
    return this.objects[h as number] as Obj & { kind: K }
  }

  /** The context's canvas, configured: it may have been rendered anew since. */
  private context(o: Context, device: GPUDevice): GPUCanvasContext {
    const view = this.host.canvas(o.key)
    if (!view) throw new Error(`no GPU canvas with key "${o.key}" on the page`)
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
      o.view = view
      o.ctx = ctx
    }
    return o.ctx
  }

  /** A texture by handle: a context's stands for its canvas's current texture. */
  private texture(h: unknown, device: GPUDevice): GPUTexture {
    const o = this.get<"texture" | "context">(h)
    return o.kind === "texture" ? o.gpu : this.context(o, device).getCurrentTexture()
  }

  private view(h: unknown, device: GPUDevice): GPUTextureView {
    const o = this.get<"view">(h)
    if (o.gpu) return o.gpu
    return this.context(this.get<"context">(o.context), device).getCurrentTexture().createView(o.descriptor)
  }

  private encode(device: GPUDevice): GPUCommandEncoder {
    return (this.encoder ??= device.createCommandEncoder())
  }

  private op(device: GPUDevice, op: unknown[], bytes: Uint8Array<ArrayBuffer>) {
    const [name, a, b, c, d, e, f, g, h] = op
    switch (name) {
      case "context": {
        // A context op may repeat its handle to configure the canvas again.
        const o: Context = { kind: "context", key: b as string, format: c as GPUTextureFormat, alphaMode: d as GPUCanvasAlphaMode }
        const old = this.objects[a as number]
        if (old?.kind === "context") old.ctx?.unconfigure()
        this.objects[a as number] = o
        this.context(o, device)
        return
      }
      case "buffer":
        this.objects[a as number] = { kind: "buffer", gpu: device.createBuffer({ size: num(b), usage: num(c) }) }
        return
      case "texture":
        this.objects[a as number] = {
          kind: "texture",
          gpu: device.createTexture({
            size: [num(b), num(c), num(d)],
            format: e as GPUTextureFormat,
            usage: num(f),
            mipLevelCount: num(g),
            sampleCount: num(h),
          }),
        }
        return
      case "view": {
        const o = this.get<"texture" | "context">(b)
        const descriptor = clean(c) as GPUTextureViewDescriptor
        // A context's views stand for its current texture: made anew from the descriptor each time.
        this.objects[a as number] =
          o.kind === "texture" ? { kind: "view", gpu: o.gpu.createView(descriptor) } : { kind: "view", context: b as number, descriptor }
        return
      }
      case "sampler":
        this.objects[a as number] = { kind: "sampler", gpu: device.createSampler(clean(b) as GPUSamplerDescriptor) }
        return
      case "shader":
        this.objects[a as number] = { kind: "shader", gpu: device.createShaderModule({ code: b as string }) }
        return
      case "bindGroupLayout":
        this.objects[a as number] = { kind: "bindGroupLayout", gpu: device.createBindGroupLayout(clean(b) as GPUBindGroupLayoutDescriptor) }
        return
      case "pipelineLayout":
        this.objects[a as number] = {
          kind: "pipelineLayout",
          gpu: device.createPipelineLayout({ bindGroupLayouts: (b as number[]).map((l) => this.get<"bindGroupLayout">(l).gpu) }),
        }
        return
      case "renderPipeline": {
        const d = clean(b) as Record<string, unknown>
        const stage = (s: unknown) => (s ? { ...(s as object), module: this.get<"shader">((s as { module: number }).module).gpu } : undefined)
        const descriptor = {
          ...d,
          layout: d.layout === "auto" ? "auto" : this.get<"pipelineLayout">(d.layout).gpu,
          vertex: stage(d.vertex),
          ...(d.fragment ? { fragment: stage(d.fragment) } : {}),
        } as GPURenderPipelineDescriptor
        this.objects[a as number] = { kind: "renderPipeline", gpu: device.createRenderPipeline(descriptor) }
        return
      }
      case "autoLayout":
        this.objects[a as number] = { kind: "bindGroupLayout", gpu: this.get<"renderPipeline">(b).gpu.getBindGroupLayout(num(c)) }
        return
      case "bindGroup": {
        const d = b as { layout: number; entries: Array<{ binding: number; resource: Record<string, unknown> }> }
        const entries = d.entries.map(({ binding, resource: r }) => ({
          binding,
          resource:
            "buffer" in r
              ? { buffer: this.get<"buffer">(r.buffer).gpu, offset: num(r.offset), size: whole(r.size) }
              : "sampler" in r
                ? this.get<"sampler">(r.sampler).gpu
                : this.view(r.view, device),
        })) as GPUBindGroupEntry[]
        this.objects[a as number] = { kind: "bindGroup", gpu: device.createBindGroup({ layout: this.get<"bindGroupLayout">(d.layout).gpu, entries }) }
        return
      }
      case "destroy":
        // Destroying a texture destroys its views (their uses fail as WebGPU's would).
        this.get<"buffer" | "texture">(a).gpu.destroy()
        return
      case "writeBuffer":
        device.queue.writeBuffer(this.get<"buffer">(a).gpu, num(b), bytes, num(c), num(d))
        return
      case "writeTexture":
        device.queue.writeTexture(
          { texture: this.texture(a, device), mipLevel: num(b), origin: xyz(c) },
          bytes.subarray(num(d), num(d) + num(e)),
          { offset: 0, bytesPerRow: num(f), rowsPerImage: whole(g) },
          extent(h),
        )
        return
      case "copyBufferToBuffer":
        this.encode(device).copyBufferToBuffer(this.get<"buffer">(a).gpu, num(b), this.get<"buffer">(c).gpu, num(d), num(e))
        return
      case "copyBufferToTexture":
        this.encode(device).copyBufferToTexture(
          { buffer: this.get<"buffer">(a).gpu, offset: num(b), bytesPerRow: num(c), rowsPerImage: whole(d) },
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
        const d = clean(a) as { colorAttachments: Array<Record<string, unknown> | null>; depthStencilAttachment?: Record<string, unknown> }
        const colorAttachments = d.colorAttachments.map((at) =>
          at
            ? { ...at, view: this.view(at.view, device), ...(at.resolveTarget !== undefined ? { resolveTarget: this.view(at.resolveTarget, device) } : {}) }
            : null,
        ) as GPURenderPassColorAttachment[]
        const depth = d.depthStencilAttachment
        this.pass = this.encode(device).beginRenderPass({
          colorAttachments,
          ...(depth ? { depthStencilAttachment: { ...depth, view: this.view(depth.view, device) } as GPURenderPassDepthStencilAttachment } : {}),
        })
        return
      }
      case "setPipeline":
        this.pass!.setPipeline(this.get<"renderPipeline">(a).gpu)
        return
      case "setBindGroup":
        this.pass!.setBindGroup(num(a), this.get<"bindGroup">(b).gpu, c as number[])
        return
      case "setVertexBuffer":
        this.pass!.setVertexBuffer(num(a), this.get<"buffer">(b).gpu, num(c), whole(d))
        return
      case "setIndexBuffer":
        this.pass!.setIndexBuffer(this.get<"buffer">(a).gpu, b as GPUIndexFormat, num(c), whole(d))
        return
      case "setViewport":
        this.pass!.setViewport(num(a), num(b), num(c), num(d), num(e), num(f))
        return
      case "setScissorRect":
        this.pass!.setScissorRect(num(a), num(b), num(c), num(d))
        return
      case "draw":
        this.pass!.draw(num(a), num(b), num(c), num(d))
        return
      case "drawIndexed":
        this.pass!.drawIndexed(num(a), num(b), num(c), num(d), num(e))
        return
      case "end":
        this.pass!.end()
        this.pass = undefined
        return
      case "submit": {
        const encoder = this.encoder
        this.encoder = undefined
        device.queue.submit(encoder ? [encoder.finish()] : [])
        return
      }
    }
  }

  /** The error a stopped canvas shows, or undefined while it draws. */
  stoppedBy(key: string): string | undefined {
    return this.stopped.get(key) ?? this.all
  }

  /** The widget stopped: its device and everything on it go. */
  destroy() {
    this.closed = true
    this.waiting = []
    for (const o of this.objects) if (o?.kind === "context") o.ctx?.unconfigure()
    this.objects = []
    this.device?.destroy()
    this.device = undefined
  }
}
