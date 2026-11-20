// The page side: workers, programs, and the widgets mounted into the DOM.

import type { Command } from "./canvas.js"
import { Images } from "./canvas.js"
import type { ErrorInfo, Frame, FromWorker, LiveExit, StepOutput, ToWorker, ViewNode, WidgetEvent } from "./protocol.js"
import { SLICE_BUDGET_MS } from "./protocol.js"
import type { RenderContext } from "./render.js"
import { CanvasView, ShaderView, Ticker, destroy as destroyTree, hasSurface, icon, reconcile, surfaces } from "./render.js"
import type { ShaderError } from "./shader.js"
import { stylesheet } from "./styles.js"
import type { Resolved, Theme } from "./theme.js"
import { apply, resolve } from "./theme.js"

export interface Capabilities {
  https?: { hosts: string[] }
}

export type WidgetStatus = "open" | "submitted" | "dismissed"

export interface MountOptions {
  /** The served program: prelude + "\n" + template source (`Program.program` from `opencode.widget/program`). */
  program: string
  /** The widget's data (the `widget` tool call's `data`). */
  data: unknown
  /** `"step"` (default) or `"live"`. */
  mode?: "step" | "live"
  /** The template's capabilities (live only); granted as declared, shown as a chip. */
  capabilities?: Capabilities
  /** The widget's state on the server: `"submitted"`/`"dismissed"` render read-only with a status line. */
  state?: WidgetStatus
  /** The submitted value, summarized under a submitted widget. */
  response?: unknown
  /** The user submitted `value`: post it with `opencode.widget/respond`. The widget turns read-only. */
  onSubmit?(value: unknown): void
  /** The user dismissed the widget: post `{ dismiss: true }` with `respond`. */
  onDismiss?(): void
  /** A non-final message for the agent (`opencode.widget/send`); more than 10 a second are dropped here. */
  onSend?(value: unknown, wake: boolean): void
  /** `"dark"` (default), `"light"`, or tokens. */
  theme?: Theme
  /**
   * Resolves an image `src` to a URL the page may load: `https:`/`http:`/`data:` pass by default; return the server's
   * file content URL for a path relative to the session's directory, or undefined to show `alt` instead.
   */
  resolveImage?(src: string): string | undefined
  /** A program error, a budget overrun, an unknown node: for logs. */
  onWarning?(message: string): void
  /** Timings: `compile`, `init` (first view on screen), `step`, `draw`, in ms. */
  onMetrics?(metric: { kind: "compile" | "init" | "step" | "draw"; ms: number }): void
  /** Text for the expand button and placeholders, if not English. */
  labels?: Partial<Labels>
}

export interface Labels {
  fullscreen: string
  exitFullscreen: string
  submitted: string
  dismissed: string
  restart: string
  retry: string
  network: string
  loading: string
}

const LABELS: Labels = {
  fullscreen: "Full screen",
  exitFullscreen: "Exit full screen",
  submitted: "Submitted",
  dismissed: "Dismissed",
  restart: "Restart",
  retry: "Try again",
  network: "Network",
  loading: "Loading widget",
}

/** A mounted widget. */
export interface MountedWidget {
  /** The element the widget renders into (a child of the mount point, with an open shadow root). */
  readonly element: HTMLElement
  setTheme(theme: Theme): void
  /** The server's state changed (from any client): a final state makes it read-only and stops a live program. */
  setState(state: WidgetStatus, response?: unknown): void
  /** Starts over: a fresh `init` (step) or a fresh `main` (live). */
  restart(): void
  /** Stops the program, frees everything, and removes the element. */
  destroy(): void
}

export interface HostOptions {
  /** URL of `psychoscript_web_bg.wasm` (default: next to this module). */
  wasmUrl?: string | URL
  /** URL of `psychoscript_web_shader_bg.wasm`, loaded only for WebGL2 shaders (default: next to this module). */
  shaderWasmUrl?: string | URL
  /** URL of `worker.js` (default: next to this module); a module worker. */
  workerUrl?: string | URL
  /** Live programs' slice budget, ms (default 50). */
  sliceBudgetMs?: number
}

// ---------- workers ----------

interface Program {
  pid: number
  refs: number
  compiled: Promise<{ error?: ErrorInfo; ms: number }>
}

class WorkerHandle {
  readonly worker: Worker
  readonly ready: Promise<void>
  private programs = new Map<string, Program>()
  private unused: string[] = []
  private compiled = new Map<number, (r: { error?: ErrorInfo; ms: number }) => void>()
  readonly widgets = new Map<number, Widget>()
  private requests = new Map<number, (m: FromWorker) => void>()
  private shaderSent = false
  dead = false

  constructor(
    private host: WidgetHost,
    module: Promise<WebAssembly.Module>,
  ) {
    const url = host.options.workerUrl
    this.worker = url
      ? new Worker(url, { type: "module", name: "psychoscript-widgets" })
      : new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "psychoscript-widgets" })
    let ready: () => void
    this.ready = new Promise((r) => (ready = r))
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      switch (m.t) {
        case "ready":
          ready()
          return
        case "compiled":
          this.compiled.get(m.pid)?.({ error: m.error, ms: m.ms })
          this.compiled.delete(m.pid)
          return
        case "translated":
        case "drawn": {
          const f = this.requests.get(m.req)
          this.requests.delete(m.req)
          f?.(m)
          return
        }
        case "crash":
          this.crash(m.message, m.wid)
          return
        default:
          this.widgets.get(m.wid)?.receive(m)
      }
    }
    this.worker.onerror = (e) => this.crash(e.message || "the worker failed to start")
    void module.then(
      (m) => this.send({ t: "init", module: m }),
      (e) => this.crash(`can't load the WebAssembly module: ${String(e?.message ?? e)}`),
    )
  }

  send(m: ToWorker) {
    if (!this.dead) this.worker.postMessage(m)
  }

  request(m: ToWorker & { req: number }): Promise<FromWorker> {
    return new Promise((resolve) => {
      this.requests.set(m.req, resolve)
      this.send(m)
    })
  }

  /** Compiles `text` (once per worker) for `live` or step runs. */
  acquire(text: string, live: boolean): Program {
    const key = (live ? "L" : "S") + text
    let p = this.programs.get(key)
    if (!p) {
      const pid = this.host.nextId()
      const compiled = new Promise<{ error?: ErrorInfo; ms: number }>((r) => this.compiled.set(pid, r))
      p = { pid, refs: 0, compiled }
      this.programs.set(key, p)
      void this.ready.then(() => this.send({ t: "compile", pid, program: text, live }))
    }
    const i = this.unused.indexOf(key)
    if (i >= 0) this.unused.splice(i, 1)
    p.refs++
    return p
  }

  /** Keeps up to 8 programs nobody uses compiled, for widgets that come back (scrolling). */
  release(text: string, live: boolean) {
    const key = (live ? "L" : "S") + text
    const p = this.programs.get(key)
    if (!p || --p.refs > 0) return
    this.unused.push(key)
    while (this.unused.length > 8) {
      const old = this.unused.shift()!
      const q = this.programs.get(old)
      this.programs.delete(old)
      if (q) this.send({ t: "release", pid: q.pid })
    }
  }

  async translate(wgsl: string): Promise<{ code: string; block: string } | ShaderError> {
    if (!this.shaderSent) {
      this.shaderSent = true
      this.send({ t: "shader", module: await this.host.shaderModule() })
    }
    await this.ready
    const m = await this.request({ t: "translate", req: this.host.nextId(), wgsl })
    if (m.t !== "translated") return { message: "no answer" }
    if (m.error) return { message: m.error.message, line: m.error.line, column: m.error.column }
    return { code: m.code!, block: m.block! }
  }

  private crash(message: string, wid?: number) {
    if (this.dead) return
    this.dead = true
    this.worker.terminate()
    for (const f of this.requests.values()) f({ t: "crash", message })
    this.requests.clear()
    for (const f of this.compiled.values()) f({ error: { type: "crash", message }, ms: 0 })
    this.host.lost(this, message, wid)
  }

  terminate() {
    this.dead = true
    this.worker.terminate()
  }
}

// ---------- the host ----------

/** Loads the WebAssembly once and runs every widget of a page: step widgets share one worker, each live widget has its own. */
export class WidgetHost {
  private ids = 0
  private module: Promise<WebAssembly.Module> | undefined
  private shader: Promise<WebAssembly.Module> | undefined
  private stepWorker: WorkerHandle | undefined
  readonly ticker = new Ticker()
  readonly images: Images
  private observer: IntersectionObserver | undefined
  private observed = new Map<Element, Widget>()
  private widgets = new Set<Widget>()
  private resolvers = new Set<(src: string) => string | undefined>()
  private translations = new Map<string, Promise<{ code: string; block: string } | ShaderError>>()

  constructor(readonly options: HostOptions = {}) {
    this.images = new Images((src) => defaultImage(src))
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", () => {
        for (const w of this.widgets) w.visibility()
      })
  }

  nextId(): number {
    return ++this.ids
  }

  /** Loads and compiles the WebAssembly and starts (and warms) the step worker now rather than at the first mount. */
  preload(): Promise<void> {
    return this.steps().ready
  }

  languageModule(): Promise<WebAssembly.Module> {
    this.module ??= compile(this.options.wasmUrl ?? new URL("./psychoscript_web_bg.wasm", import.meta.url))
    return this.module
  }

  shaderModule(): Promise<WebAssembly.Module> {
    this.shader ??= compile(this.options.shaderWasmUrl ?? new URL("./psychoscript_web_shader_bg.wasm", import.meta.url))
    return this.shader
  }

  steps(): WorkerHandle {
    if (!this.stepWorker || this.stepWorker.dead) this.stepWorker = new WorkerHandle(this, this.languageModule())
    return this.stepWorker
  }

  live(): WorkerHandle {
    return new WorkerHandle(this, this.languageModule())
  }

  translate(wgsl: string): Promise<{ code: string; block: string } | ShaderError> {
    let t = this.translations.get(wgsl)
    if (!t) {
      t = this.steps().translate(wgsl)
      this.translations.set(wgsl, t)
      if (this.translations.size > 32) this.translations.delete(this.translations.keys().next().value!)
    }
    return t
  }

  /** A worker died: its widgets start again, but the one whose program crashed it shows the error. */
  lost(worker: WorkerHandle, message: string, culprit?: number) {
    if (worker === this.stepWorker) this.stepWorker = undefined
    this.translations.clear()
    for (const w of [...worker.widgets.values()]) w.crashed(message, w.wid === culprit || worker.widgets.size === 1)
  }

  mount(el: HTMLElement, options: MountOptions): MountedWidget {
    const w = new Widget(this, el, options)
    this.widgets.add(w)
    return w
  }

  observe(el: Element, w: Widget) {
    this.observer ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) this.observed.get(e.target)?.intersecting(e.isIntersecting)
      },
      { rootMargin: "200px 0px" },
    )
    this.observed.set(el, w)
    this.observer.observe(el)
  }

  forget(w: Widget) {
    this.widgets.delete(w)
    this.observed.delete(w.element)
    this.observer?.unobserve(w.element)
  }

  /** Stops every widget and worker. */
  destroy() {
    for (const w of [...this.widgets]) w.destroy()
    this.stepWorker?.terminate()
    this.stepWorker = undefined
    this.observer?.disconnect()
  }
}

async function compile(url: string | URL): Promise<WebAssembly.Module> {
  const response = fetch(url, { credentials: "same-origin" })
  try {
    return await WebAssembly.compileStreaming(response)
  } catch {
    // A server that doesn't send `application/wasm`.
    const r = await fetch(url, { credentials: "same-origin" })
    if (!r.ok) throw new Error(`${r.status} for ${String(url)}`)
    return WebAssembly.compile(await r.arrayBuffer())
  }
}

function defaultImage(src: string): string | undefined {
  return /^(https?:|data:image\/)/i.test(src) ? src : undefined
}

// ---------- one widget ----------

class Widget implements MountedWidget {
  readonly element: HTMLElement
  readonly wid: number
  private shadow: ShadowRoot
  private root: HTMLDivElement
  private viewEl: HTMLDivElement
  private errorEl: HTMLDivElement
  private statusEl: HTMLDivElement
  private expand: HTMLButtonElement
  private theme: Resolved
  private status: WidgetStatus
  private response: unknown
  private worker: WorkerHandle | undefined
  private program: { text: string; live: boolean } | undefined
  private view: ViewNode | undefined
  private started = false
  private visible = false
  private inView = false
  private destroyed = false
  private paused = false
  private ctx: RenderContext
  private draws = new Map<number, (r: { commands?: Command[]; error?: string; ms: number }) => void>()
  private live: {
    commands: Map<string | null, Command[]>
    frameWanted: boolean
    startedAt: number
    pausedAt: number | undefined
    pausedTotal: number
    lastFrame: number
    running: boolean
  } = { commands: new Map(), frameWanted: false, startedAt: 0, pausedAt: undefined, pausedTotal: 0, lastFrame: 0, running: false }
  private sends: number[] = []
  private mountedAt = performance.now()
  private firstView = false
  private warned = new Set<string>()
  private isFullscreen = false
  private onFullscreen = () => this.fullscreenChanged()

  constructor(
    private host: WidgetHost,
    mountPoint: HTMLElement,
    private options: MountOptions,
  ) {
    this.wid = host.nextId()
    this.status = options.state ?? "open"
    this.response = options.response
    this.theme = resolve(options.theme)
    const doc = mountPoint.ownerDocument
    this.element = doc.createElement("div")
    this.element.className = "psychoscript-widget"
    this.shadow = this.element.attachShadow({ mode: "open" })
    this.shadow.adoptedStyleSheets = [stylesheet()]
    apply(this.element, this.theme)
    this.root = doc.createElement("div")
    this.root.className = "pw-root"
    this.viewEl = doc.createElement("div")
    this.viewEl.className = "pw-view"
    this.errorEl = doc.createElement("div")
    this.errorEl.className = "pw-error"
    this.errorEl.hidden = true
    this.statusEl = doc.createElement("div")
    this.statusEl.className = "pw-status"
    this.statusEl.hidden = true
    this.expand = doc.createElement("button")
    this.expand.type = "button"
    this.expand.className = "pw-expand"
    this.expand.hidden = true
    this.expand.addEventListener("click", () => void this.toggleFullscreen())
    const hosts = options.mode === "live" ? options.capabilities?.https?.hosts : undefined
    if (hosts?.length) {
      const chip = doc.createElement("div")
      chip.className = "pw-chip"
      chip.textContent = `${this.label("network")}: ${hosts.join(", ")}`
      chip.title = chip.textContent
      this.root.append(chip)
    }
    this.root.append(this.expand, this.viewEl, this.errorEl, this.statusEl)
    this.shadow.append(this.root)
    this.loading()
    mountPoint.append(this.element)
    doc.addEventListener("fullscreenchange", this.onFullscreen)
    this.ctx = {
      doc,
      emit: (e) => this.emit(e),
      readOnly: () => this.status !== "open",
      theme: () => this.theme,
      visible: () => this.visible,
      fullscreen: () => this.isFullscreen,
      images: host.images,
      resolveImage: (src) => (options.resolveImage ? options.resolveImage(src) : defaultImage(src)),
      draw: this.mode() === "step" ? (frame) => this.draw(frame) : undefined,
      liveCommands: (id) => this.live.commands.get(id),
      translate: (wgsl) => host.translate(wgsl),
      warn: (m) => this.warn(m),
      ticker: host.ticker,
    }
    if (options.resolveImage) {
      // Images on canvases resolve through this widget's resolver.
      this.ctx.images = new Images(options.resolveImage)
    }
    this.renderStatus()
    host.observe(this.element, this)
  }

  private mode(): "step" | "live" {
    return this.options.mode === "live" ? "live" : "step"
  }

  private label(k: keyof Labels): string {
    return this.options.labels?.[k] ?? LABELS[k]
  }

  private warn(message: string) {
    if (this.warned.size < 50 && !this.warned.has(message)) {
      this.warned.add(message)
      this.options.onWarning?.(message)
    }
  }

  private metric(kind: "compile" | "init" | "step" | "draw", ms: number) {
    this.options.onMetrics?.({ kind, ms })
  }

  // ---------- visibility ----------

  intersecting(on: boolean) {
    this.inView = on
    this.visibility()
  }

  visibility() {
    const visible = this.inView && !document.hidden
    if (visible === this.visible) return
    this.visible = visible
    if (visible) {
      if (!this.started) this.start()
      for (const s of surfaces(this.viewEl)) s.wake()
    }
    if (this.mode() === "live") this.livePause(!visible)
  }

  // ---------- start ----------

  private start() {
    if (this.destroyed) return
    this.started = true
    const live = this.mode() === "live"
    if (live && this.status !== "open") {
      // A finished live widget has nothing to run: its last view lived on the client that ran it.
      this.viewEl.replaceChildren()
      this.renderStatus()
      return
    }
    const worker = live ? this.host.live() : this.host.steps()
    this.worker = worker
    worker.widgets.set(this.wid, this)
    const text = this.options.program
    this.program = { text, live }
    const p = worker.acquire(text, live)
    const data = JSON.stringify(this.options.data ?? null)
    void p.compiled.then((r) => {
      if (this.worker !== worker || this.destroyed) return
      if (r.ms > 0) this.metric("compile", r.ms)
      if (r.error) return this.fatal(r.error)
      if (live) {
        this.live = { ...this.live, commands: new Map(), frameWanted: false, startedAt: performance.now(), pausedAt: undefined, pausedTotal: 0, running: true }
        this.paused = false
        worker.send({
          t: "live",
          wid: this.wid,
          pid: p.pid,
          data,
          hosts: this.options.capabilities?.https?.hosts,
          sliceBudgetMs: this.host.options.sliceBudgetMs ?? SLICE_BUDGET_MS,
        })
        if (!this.visible) this.livePause(true)
      } else worker.send({ t: "open", wid: this.wid, pid: p.pid, data })
    })
  }

  private stopWorker() {
    const worker = this.worker
    if (!worker) return
    this.worker = undefined
    worker.widgets.delete(this.wid)
    if (this.program) worker.release(this.program.text, this.program.live)
    if (this.program?.live) {
      worker.send({ t: "stop", wid: this.wid })
      // Let the stop's cancellations go out, then end the worker and its memory.
      setTimeout(() => worker.terminate(), 50)
    } else worker.send({ t: "close", wid: this.wid })
    for (const f of this.draws.values()) f({ error: "stopped", ms: 0 })
    this.draws.clear()
    this.live.running = false
  }

  restart() {
    if (this.destroyed) return
    this.stopWorker()
    this.errorEl.hidden = true
    this.firstView = false
    this.mountedAt = performance.now()
    this.started = false
    if (this.visible) this.start()
  }

  crashed(message: string, culprit: boolean) {
    this.worker = undefined
    this.live.running = false
    if (culprit) this.fatal({ type: "crash", message: `The widget runtime crashed: ${message}` })
    else this.restart()
  }

  // ---------- from the worker ----------

  receive(m: FromWorker) {
    if (this.destroyed) return
    switch (m.t) {
      case "step":
        return this.stepped(m)
      case "posts":
        for (const p of m.messages) this.posted(p as { type?: string; [k: string]: unknown })
        return
      case "warning":
        return this.warn(m.message)
      case "exit":
        return this.exited(m.exit)
    }
  }

  private stepped(m: Extract<FromWorker, { t: "step" }>) {
    if (m.error) {
      if (!this.view) return this.fatal(m.error)
      this.inlineError(m.error)
      this.warn(describe(m.error))
      return
    }
    this.metric("step", m.ms)
    this.errorEl.hidden = true
    const out = m.output as StepOutput
    this.render(out.view)
    if (out.send !== undefined) this.send(out.send.value, out.send.wake !== false)
    if (out.submit !== undefined) this.finish("submitted", out.submit)
    else if (out.dismiss) this.finish("dismissed")
  }

  private posted(p: { type?: string; [k: string]: unknown }) {
    switch (p.type) {
      case "render":
        if (p.node && typeof p.node === "object") this.render(p.node as ViewNode)
        return
      case "draw": {
        const id = typeof p.id === "string" ? p.id : null
        const commands = Array.isArray(p.commands) ? (p.commands as Command[]) : []
        this.live.commands.set(id, commands)
        for (const s of surfaces(this.viewEl)) if (s instanceof CanvasView && s.id === id) s.setCommands(commands)
        return
      }
      case "frame":
        this.live.frameWanted = true
        this.host.ticker.add(this.liveTick)
        return
      case "submit":
        this.finish("submitted", p.value ?? null)
        return
      case "dismiss":
        this.finish("dismissed")
        return
      case "send":
        this.send(p.value ?? null, p.wake !== false)
        return
    }
  }

  private exited(exit: LiveExit) {
    this.live.running = false
    if (exit.type === "failed" && this.status === "open") this.inlineError(exit.error, true)
    if (exit.type === "failed") this.warn(describe(exit.error))
  }

  // ---------- rendering ----------

  private loading() {
    const l = this.element.ownerDocument.createElement("div")
    l.className = "pw-loading"
    l.setAttribute("aria-label", this.label("loading"))
    l.setAttribute("role", "progressbar")
    this.viewEl.replaceChildren(l)
  }

  private render(node: ViewNode) {
    if (this.view === undefined) this.viewEl.replaceChildren()
    this.view = node
    reconcile(this.ctx, this.viewEl, [node])
    this.updateExpand()
    if (!this.firstView) {
      this.firstView = true
      const at = performance.now()
      requestAnimationFrame(() => this.metric("init", at - this.mountedAt))
    }
  }

  private updateExpand() {
    const want = this.view?.fullscreen
    const offer =
      this.status === "open" &&
      document.fullscreenEnabled !== false &&
      typeof this.element.requestFullscreen === "function" &&
      (want === true || (want !== false && (this.mode() === "live" || hasSurface(this.view))))
    this.expand.hidden = !offer && !this.isFullscreen
    const label = this.label(this.isFullscreen ? "exitFullscreen" : "fullscreen")
    if (this.expand.title !== label) {
      this.expand.title = label
      this.expand.setAttribute("aria-label", label)
      this.expand.replaceChildren(
        icon(this.ctx, this.isFullscreen ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"),
      )
    }
  }

  private inlineError(e: ErrorInfo, restart = false) {
    this.errorEl.replaceChildren(describe(e))
    if (restart) this.errorEl.append(this.button(this.label("restart"), () => this.restart()))
    this.errorEl.hidden = false
  }

  private button(text: string, f: () => void): HTMLButtonElement {
    const b = this.element.ownerDocument.createElement("button")
    b.type = "button"
    b.className = "pw-btn pw-secondary"
    b.style.marginTop = "6px"
    b.style.display = "block"
    b.textContent = text
    b.addEventListener("click", f)
    return b
  }

  /** The first step failed (or the program didn't compile): an error card instead of a view. */
  private fatal(e: ErrorInfo) {
    for (const el of this.viewEl.children) destroyTree(el)
    this.view = undefined
    const card = this.element.ownerDocument.createElement("div")
    card.className = "pw-error-card"
    const msg = this.element.ownerDocument.createElement("div")
    msg.className = "pw-error"
    msg.style.marginTop = "0"
    msg.textContent = describe(e)
    card.append(msg)
    if (this.status === "open") card.append(this.button(this.label(this.mode() === "live" ? "restart" : "retry"), () => this.restart()))
    this.viewEl.replaceChildren(card)
    this.errorEl.hidden = true
    this.updateExpand()
    this.warn(describe(e))
  }

  private renderStatus() {
    if (this.status === "open") {
      this.statusEl.hidden = true
      this.root.classList.remove("pw-readonly")
      return
    }
    this.root.classList.add("pw-readonly")
    let text = this.label(this.status === "submitted" ? "submitted" : "dismissed")
    if (this.status === "submitted" && this.response !== undefined) text += `: ${summary(this.response)}`
    this.statusEl.textContent = text
    this.statusEl.hidden = false
  }

  // ---------- events ----------

  private emit(e: WidgetEvent) {
    if (this.status !== "open" || !this.worker) return
    this.worker.send({ t: "event", wid: this.wid, event: e })
  }

  private draw(frame: Frame): Promise<{ commands?: Command[]; error?: string; ms: number }> {
    const worker = this.worker
    if (!worker || !this.view) return Promise.resolve({ error: "not running", ms: 0 })
    const req = this.host.nextId()
    return new Promise((resolve) => {
      this.draws.set(req, resolve)
      void worker.request({ t: "draw", wid: this.wid, req, frame }).then((m) => {
        this.draws.delete(req)
        if (m.t !== "drawn") return resolve({ error: "the runtime stopped", ms: 0 })
        this.metric("draw", m.ms)
        resolve({ commands: m.commands as Command[] | undefined, error: m.error ? describe(m.error) : undefined, ms: m.ms })
      })
    })
  }

  private send(value: unknown, wake: boolean) {
    const now = performance.now()
    this.sends = this.sends.filter((t) => now - t < 1000)
    if (this.sends.length >= 10) return this.warn("more than 10 sends in a second: dropped")
    this.sends.push(now)
    this.options.onSend?.(value, wake)
  }

  private finish(status: "submitted" | "dismissed", value?: unknown) {
    if (this.status !== "open") return
    this.status = status
    this.response = value
    if (this.isFullscreen) void document.exitFullscreen().catch(() => {})
    if (status === "submitted") this.options.onSubmit?.(value)
    else this.options.onDismiss?.()
    if (this.mode() === "live") this.stopWorker()
    this.refreshControls()
    this.renderStatus()
  }

  setState(state: WidgetStatus, response?: unknown) {
    if (state === this.status) {
      if (response !== undefined) {
        this.response = response
        this.renderStatus()
      }
      return
    }
    this.status = state
    if (response !== undefined) this.response = response
    if (state !== "open" && this.mode() === "live") this.stopWorker()
    this.refreshControls()
    this.renderStatus()
    if (state === "open") this.restart()
  }

  private refreshControls() {
    if (this.view) reconcile(this.ctx, this.viewEl, [this.view])
    this.updateExpand()
  }

  setTheme(theme: Theme) {
    this.theme = resolve(theme)
    apply(this.element, this.theme)
    for (const s of surfaces(this.viewEl)) {
      if (s instanceof CanvasView) {
        s.repaint()
        s.invalidate()
      }
    }
  }

  // ---------- live ----------

  private livePause(pause: boolean) {
    if (!this.worker || !this.live.running || pause === this.paused) return
    this.paused = pause
    if (pause) this.live.pausedAt = performance.now()
    else if (this.live.pausedAt !== undefined) {
      this.live.pausedTotal += performance.now() - this.live.pausedAt
      this.live.pausedAt = undefined
    }
    this.worker.send({ t: pause ? "pause" : "resume", wid: this.wid })
    if (!pause && this.live.frameWanted) this.host.ticker.add(this.liveTick)
  }

  private liveTick = (now: number) => {
    if (!this.live.frameWanted || !this.worker || !this.live.running) return this.host.ticker.delete(this.liveTick)
    if (!this.visible || this.paused) return this.host.ticker.delete(this.liveTick)
    this.live.frameWanted = false
    this.host.ticker.delete(this.liveTick)
    const surface = surfaces(this.viewEl).find((s): s is CanvasView => s instanceof CanvasView)
    const t = (now - this.live.startedAt - this.live.pausedTotal) / 1000
    const dt = this.live.lastFrame ? (now - this.live.lastFrame) / 1000 : 0
    this.live.lastFrame = now
    const rect = this.viewEl.getBoundingClientRect()
    const frame: Frame = surface
      ? { ...surface.frame(dt), t }
      : {
          id: null,
          t,
          dt,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scale: globalThis.devicePixelRatio || 1,
          pointer: null,
          dark: this.theme.dark,
          fullscreen: this.isFullscreen,
        }
    this.worker.send({ t: "deliver", wid: this.wid, message: { type: "frame", frame } })
  }

  // ---------- full screen ----------

  private async toggleFullscreen() {
    try {
      if (this.isFullscreen) await document.exitFullscreen()
      else await this.element.requestFullscreen({ navigationUI: "hide" })
    } catch (e) {
      this.warn(`full screen: ${String((e as Error)?.message ?? e)}`)
    }
  }

  private fullscreenChanged() {
    const on = document.fullscreenElement === this.element
    if (on === this.isFullscreen) return
    this.isFullscreen = on
    this.updateExpand()
    // Surfaces with `fill` grow or shrink; resizes reach their draws through their ResizeObservers.
    if (this.view) reconcile(this.ctx, this.viewEl, [this.view])
    this.emit({ id: "", type: "fullscreen", value: on })
  }

  destroy() {
    if (this.destroyed) return
    if (this.isFullscreen) void document.exitFullscreen().catch(() => {})
    this.stopWorker()
    this.destroyed = true
    this.host.ticker.delete(this.liveTick)
    this.element.ownerDocument.removeEventListener("fullscreenchange", this.onFullscreen)
    for (const el of this.viewEl.children) destroyTree(el)
    this.host.forget(this)
    this.element.remove()
  }
}

function describe(e: ErrorInfo): string {
  const where = e.line ? ` (line ${e.line}${e.column ? `, column ${e.column}` : ""})` : ""
  return `${e.message}${where}`
}

function summary(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? value.slice(0, 79) + "…" : value
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > 80 ? text.slice(0, 79) + "…" : text
}

export { ShaderView }
