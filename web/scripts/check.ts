#!/usr/bin/env bun
// Checks the demo in a real Chromium: every fixture renders, controls submit what they should, canvases draw, shaders
// run on WebGPU and WebGL2, live widgets pause out of view, full screen, the slice budget and the fetch rules; prints
// timings and memory. Needs the demo server (bun scripts/serve.ts).
//
//   xvfb-run -a bun scripts/check.ts      # headful under Xvfb: headless screenshots leave WebGPU canvases blank
//
// Env: CHROMIUM (executable), DEMO (base URL), SHOTS (directory for web-*.png screenshots; none when unset).
import { chromium, type Locator, type Page } from "playwright-core"

const exe = process.env.CHROMIUM ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`
const base = process.env.DEMO ?? "http://localhost:4173/demo/"
const shots = process.env.SHOTS
const browser = await chromium.launch({
  executablePath: exe,
  headless: !process.env.DISPLAY,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"],
})

let failures = 0
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}
const shot = async (target: Page | Locator, name: string, fullPage = false) => {
  if (!shots) return
  const path = `${shots}/web-${name}.png`
  if ("goto" in target) await target.screenshot({ path, fullPage })
  else await target.screenshot({ path })
}

async function open(query: string, viewport = { width: 1280, height: 900 }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text())
  })
  await page.goto(base + query)
  return { page, errors }
}

const log = (page: Page) => page.evaluate(() => (window as unknown as { __demo: { log: string[] } }).__demo.log)
const widget = (page: Page, name: string) => page.locator(`.slot[data-name="${name}"] .psychoscript-widget`)

async function waitLog(page: Page, match: (line: string) => boolean, ms = 3000): Promise<string | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = (await log(page)).find(match)
    if (hit) return hit
    await page.waitForTimeout(50)
  }
  return undefined
}

/** Scrolls `w` into view and waits for its first view (or error card). */
async function rendered(w: Locator): Promise<"view" | "error" | "timeout"> {
  await w.scrollIntoViewIfNeeded()
  try {
    await w.locator(".pw-view > :not(.pw-loading)").first().waitFor({ timeout: 5000 })
  } catch {
    return "timeout"
  }
  return (await w.locator(".pw-error-card").count()) > 0 ? "error" : "view"
}

/** Painted pixels on each Canvas2D canvas of `w` (WebGPU/WebGL canvases are skipped). */
const painted = (w: Locator) =>
  w.evaluate((el) =>
    [...el.shadowRoot!.querySelectorAll(".pw-surface[data-kind='2d'] canvas")].flatMap((c) => {
      const ctx = c.getContext("2d")
      if (!ctx || c.width === 0) return []
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++
      return [n]
    }),
  )

const expandShown = (w: Locator) =>
  w.evaluate((el) => getComputedStyle(el.shadowRoot!.querySelector(".pw-expand")!).display !== "none")

// ---------- every fixture, dark and light ----------
{
  const { page, errors } = await open("", { width: 1400, height: 1000 })
  const names = await page.evaluate(() => Object.keys((window as unknown as { __demo: { widgets: object } }).__demo.widgets))
  const surfaces = new Set(["chart", "backdrop", "minigame", "fullscreen-demo"])
  for (const name of names) {
    const w = widget(page, name)
    const state = await rendered(w)
    check(state === "view", `${name}: renders`, state === "view" ? undefined : state)
    if ((await w.locator(".pw-surface").count()) > 0) surfaces.add(name)
    if ((await w.locator(".pw-surface[data-kind='2d']").count()) > 0 && name !== "minigame") {
      await page.waitForTimeout(150)
      const px = await painted(w)
      check(px.length > 0 && px.every((n) => n > 100), `${name}: canvas drawn`, px)
    }
  }
  for (const name of names) {
    const live = await page.evaluate((n) => (window as unknown as { __demo: { fixtures: Record<string, { mode: string }> } }).__demo.fixtures[n]!.mode === "live", name)
    const want = name === "fetch-demo" || name === "local-demo" || name === "keys-live" ? false : surfaces.has(name) || live
    check((await expandShown(widget(page, name))) === want, `${name}: full-screen button ${want ? "offered" : "not offered"}`)
  }
  check(errors.length === 0, "all: no page errors", errors.slice(0, 3))
  // Only program errors reach the report hook: here only the shader that doesn't validate. The backdrop shader that
  // SwiftShader can't run at 50 ms a frame is this device's problem, a client error.
  const reports = (await log(page)).filter((l) => / report /.test(l))
  check(
    reports.length === 1 && /^shader-broken report \{"phase":"shader","message":".*WGSL line 2/.test(reports[0]!),
    "failures: rendering every fixture reports only the broken shader's WGSL",
    reports,
  )
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  await shot(page, "all-dark", true)

  // Mounting into a warm page: the worker and module are loaded, the interpreter compiled.
  const warm: number[] = []
  for (const name of ["confirm", "form", "chart", "pie", "suggestions"])
    warm.push(await page.evaluate((n) => (window as unknown as { __demo: { mount(n: string): Promise<number> } }).__demo.mount(n), name))
  const stats = await page.evaluate(() => (window as unknown as { __demo: { host: { stats(): Promise<unknown> } } }).__demo.host.stats())
  const metrics = await page.evaluate(() => (window as unknown as { __demo: { metrics: Record<string, number[]> } }).__demo.metrics)
  const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
  await page.evaluate(() => {
    for (const w of (window as unknown as { __demo: { extra: { destroy(): void }[] } }).__demo.extra) w.destroy()
    for (const s of document.querySelectorAll(".slot:not([data-name])")) s.remove()
    window.scrollTo(0, 0)
  })

  await page.locator("#theme").click()
  await page.waitForTimeout(800)
  await shot(page, "all-light", true)
  check(
    await widget(page, "confirm").evaluate((el) => getComputedStyle(el).getPropertyValue("--pw-bg").trim() === "#ffffff"),
    "theme: light tokens applied",
  )

  const q = (v: number[], p: number) => {
    const s = [...v].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
  }
  const fmt = (v: number[] = []) =>
    v.length ? `median ${q(v, 0.5).toFixed(1)}  p95 ${q(v, 0.95).toFixed(1)}  max ${Math.max(...v).toFixed(1)}  (n=${v.length})` : "-"
  console.log("\ntimings in ms (Chromium, this VM, software GPU)")
  console.log("  first view, warm page :", fmt(warm), "(mount -> view on screen, worker running)")
  console.log("  compile               :", fmt(metrics.compile))
  console.log("  step (init/update)    :", fmt(metrics.step))
  console.log("  draw                  :", fmt(metrics.draw))
  console.log("memory:", JSON.stringify(stats), `page JS heap ${(heap / 1048576).toFixed(1)} MB`, "\n")
  await page.close()
}

// ---------- first view on a fresh page: the module fetched and compiled, a worker started and warmed ----------
{
  const runs: Record<string, number[]> = {}
  for (const name of ["confirm", "chart", "confirm", "chart", "confirm", "chart"]) {
    const { page } = await open(`?only=${name}`)
    const ms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const d = (window as unknown as { __demo: { metrics: Record<string, number[]> } }).__demo
          const t = setInterval(() => {
            if (d.metrics.init?.length) {
              clearInterval(t)
              resolve(d.metrics.init[0]!)
            }
          }, 5)
        }),
    )
    ;(runs[name] ??= []).push(ms)
    await page.close()
  }
  console.log("first view on a fresh page, ms (mount -> view on screen; 1st run cold, then HTTP and code cache warm):")
  for (const [name, v] of Object.entries(runs)) console.log(`  ${name.padEnd(8)} ${v.map((n) => n.toFixed(0)).join(", ")}`)
  console.log()
}

// ---------- controls submit ----------
{
  const { page, errors } = await open("?only=confirm")
  const w = widget(page, "confirm")
  await rendered(w)
  await shot(w, "confirm")
  await w.locator("button.pw-btn", { hasText: "Delete" }).click()
  const line = await waitLog(page, (l) => l.startsWith("confirm submit"))
  check(line === 'confirm submit {"confirmed":true}', "confirm: pressing Delete submits { confirmed: true }", line)
  check(await w.locator(".pw-status").textContent().then((t) => t?.startsWith("Submitted") ?? false), "confirm: read-only with a status line")
  check(errors.length === 0, "confirm: no page errors", errors)
  await page.close()
}
{
  const { page, errors } = await open("?only=suggestions")
  const w = widget(page, "suggestions")
  await rendered(w)
  await w.locator(".pw-card").nth(0).locator(".pw-next").click()
  await page.waitForTimeout(350)
  await w.locator(".pw-card").nth(1).click()
  await w.locator(".pw-card.pw-selected").first().waitFor({ timeout: 3000 })
  await w.locator("input.pw-input").fill("ship it")
  await w.locator("input.pw-input").press("Enter")
  await page.waitForTimeout(200)
  await shot(w, "suggestions")
  await w.locator("button.pw-btn", { hasText: "Choose" }).click()
  const line = await waitLog(page, (l) => l.startsWith("suggestions submit"))
  check(line === 'suggestions submit {"choice":"Minimal","index":1,"note":"ship it"}', "suggestions: carousel arrow, card, note and Choose submit", line)
  check(errors.length === 0, "suggestions: no page errors", errors)
  await page.close()
}
{
  const { page, errors } = await open("?only=form&theme=light")
  const w = widget(page, "form")
  await rendered(w)
  await w.locator("input.pw-input").first().fill("v2.0")
  await w.locator("input.pw-input").first().blur()
  const slider = w.locator("input.pw-slider")
  await slider.focus()
  await slider.press("ArrowRight")
  await w.locator(".pw-check input").click()
  await w.locator(".pw-option", { hasText: "EU West" }).click()
  await page.waitForTimeout(200)
  await shot(w, "form-light")
  await w.locator("button.pw-btn", { hasText: "Deploy" }).click()
  const line = await waitLog(page, (l) => l.startsWith("form submit"))
  const value = line ? JSON.parse(line.slice("form submit ".length)) : undefined
  check(
    value?.name === "v2.0" && value?.replicas === 3 && value?.canary === false && value?.region === "eu-west",
    "form: text, slider, checkbox and select reach the submitted value",
    value,
  )
  check(errors.length === 0, "form: no page errors", errors)
  await page.close()
}

// ---------- chart: pointer down shows the value, a tap submits ----------
{
  const { page, errors } = await open("?only=chart")
  const w = widget(page, "chart")
  await rendered(w)
  await page.waitForTimeout(900)
  const box = (await w.locator("canvas").boundingBox())!
  const before = await painted(w)
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.6)
  await page.mouse.down()
  await page.waitForTimeout(400)
  const caption = await w.locator(".pw-text").allTextContents()
  await shot(w, "chart-pointer")
  await page.mouse.up()
  const line = await waitLog(page, (l) => l.startsWith("chart submit"))
  check(before[0]! > 1000, "chart: animated in and drawn", before)
  check(caption.some((t) => /\d/.test(t) && /s\b/.test(t)), "chart: holding the pointer shows the value", caption)
  check(line !== undefined && /"series":"(Linux|macOS)"/.test(line), "chart: a tap submits { series, index, value }", line)
  check(errors.length === 0, "chart: no page errors", errors)
  await page.close()
}

// ---------- backdrop on WebGPU and on WebGL2 ----------
for (const [query, backend] of [["?only=backdrop", "webgpu"], ["?only=backdrop&gl=1", "webgl2"]] as const) {
  const { page, errors } = await open(query)
  const w = widget(page, "backdrop")
  await rendered(w)
  await w.locator(`.pw-surface[data-backend="${backend}"]`).waitFor({ timeout: 8000 }).catch(() => {})
  const got = await w.evaluate((el) => (el.shadowRoot!.querySelector(".pw-surface") as HTMLElement).dataset.backend)
  check(got === backend, `backdrop: shader runs on ${backend}`, got)
  await page.waitForTimeout(600)
  await shot(w, `backdrop-${backend}`)
  // The slider sets the speed (values[0]) on release.
  const slider = w.locator("input.pw-slider")
  await slider.focus()
  await slider.press("ArrowLeft")
  await page.waitForTimeout(200)
  check((await w.locator(".pw-slider-value").textContent()) !== "1", "backdrop: speed slider updates the view")
  check(errors.length === 0, `backdrop (${backend}): no page errors`, errors)
  await page.close()
}

// ---------- shader pointer events, values-only updates ----------
for (const [query, backend] of [["?only=shader-demo", "webgpu"], ["?only=shader-demo&gl=1", "webgl2"]] as const) {
  const { page, errors } = await open(query)
  const w = widget(page, "shader-demo")
  await rendered(w)
  await w.locator(`.pw-surface[data-backend="${backend}"]`).waitFor({ timeout: 8000 }).catch(() => {})
  await w.evaluate((el) => ((el.shadowRoot!.querySelector(".pw-surface canvas") as HTMLCanvasElement & { mark?: number }).mark = 1))
  const caption = async () => (await w.locator(".pw-caption").textContent()) ?? ""
  const frames = async () => Number(/frames (\d+)/.exec(await caption())?.[1] ?? 0)
  const f0 = await frames()
  await page.waitForTimeout(1000)
  const f1 = await frames()
  const box = (await w.locator("canvas").boundingBox())!
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * (0.3 + i * 0.05), box.y + box.height * 0.5)
    await page.waitForTimeout(30)
  }
  await page.waitForTimeout(150)
  await shot(w, `shader-pointer-${backend}`)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const text = await caption()
  const same = await w.evaluate((el) => {
    const s = el.shadowRoot!.querySelector(".pw-surface") as HTMLElement
    return { mark: (s.querySelector("canvas") as HTMLCanvasElement & { mark?: number }).mark, builds: s.dataset.builds, backend: s.dataset.backend }
  })
  check(same.backend === backend, `shader (${backend}): runs`, same.backend)
  check(f1 - f0 > 10, `shader (${backend}): the live program re-renders it every frame (${f1 - f0} frames in 1 s)`)
  check(same.mark === 1 && same.builds === "1", `shader (${backend}): new values reuse the element and the GPU pipeline`, same)
  const m = /down (\d+) · move (\d+) · up (\d+)/.exec(text)
  check(m !== null && m[1] === "1" && m[3] === "1" && Number(m[2]) >= 1 && Number(m[2]) <= 8, `shader (${backend}): pointer down, moves (at most one a frame) and up reach the program`, text)
  check(/hover [1-9]/.test(text), `shader (${backend}): hover moves (down: false) before the press`, text)
  check(errors.length === 0, `shader (${backend}): no page errors`, errors)
  await page.close()
}

// ---------- stack: a HUD over a GPU canvas ----------
{
  const { page, errors } = await open("?only=hud-demo")
  const w = widget(page, "hud-demo")
  await rendered(w)
  await w.locator(".pw-surface[data-backend]").waitFor({ timeout: 8000 }).catch(() => {})
  const geo = () =>
    w.evaluate((el) => {
      const r = (e: Element | null) => {
        const b = e!.getBoundingClientRect()
        return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }
      }
      const root = el.shadowRoot!
      return {
        stack: r(root.querySelector(".pw-stack")),
        canvas: r(root.querySelector(".pw-stack > .pw-surface")),
        glass: (root.querySelectorAll(".pw-stack > .pw-surface")[1] as HTMLElement | undefined)?.hasAttribute("data-pointer"),
        sky: (root.querySelector(".pw-stack > .pw-surface") as HTMLElement).hasAttribute("data-pointer"),
        hud: r(root.querySelector(".pw-stack > .pw-col")),
        button: r(root.querySelector(".pw-stack > .pw-btn")),
        kind: (root.querySelector(".pw-surface") as HTMLElement).dataset.kind,
      }
    })
  const g = await geo()
  check(g.kind === "gpu", "stack: a canvas with wgsl is a GPU canvas", g.kind)
  check(
    JSON.stringify(g.canvas) === JSON.stringify(g.stack) && g.stack.b - g.stack.y === 220,
    "stack: the fill canvas takes the whole stack, as tall as the tallest child (220)",
    g,
  )
  check(g.hud.x === g.stack.x + 12 && g.hud.y === g.stack.y + 12, "stack: the HUD sits top-left, inset 12", g.hud)
  check(g.sky === true && g.glass === false, "stack: only the canvas with onPointer takes input (pointer: true); the keyed vignette doesn't", g)
  check(g.button.r === g.stack.r - 12 && g.button.b === g.stack.b - 12, "stack: the button sits bottom-right, inset 12", g.button)
  const caption = async () => (await w.locator(".pw-code").textContent()) ?? ""
  const until = async (re: RegExp) => {
    const end = Date.now() + 3000
    let t = await caption()
    while (Date.now() < end && !re.test(t)) {
      await page.waitForTimeout(50)
      t = await caption()
    }
    return t
  }
  await w.locator(".pw-stack > .pw-btn").click()
  let t = await until(/button presses 1/)
  check(/canvas taps 0 · button presses 1/.test(t), "stack: the button on top takes its tap", t)
  await page.mouse.click((g.stack.x + g.stack.r) / 2, (g.stack.y + g.stack.b) / 2)
  t = await until(/canvas taps 1/)
  check(/canvas taps 1 · button presses 1/.test(t), "stack: a tap on empty space passes the keyed canvas and reaches the one with onPointer", t)
  const title = (await w.locator(".pw-stack .pw-title").boundingBox())!
  await page.mouse.click(title.x + 10, title.y + title.height / 2)
  t = await until(/canvas taps 2/)
  check(/canvas taps 2 · button presses 1/.test(t), "stack: text lets taps through to the canvas", t)
  // Clicked away first: no focus ring or hint in the picture.
  await page.mouse.click(5, 5)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
  if (shots) await page.locator('.slot[data-name="hud-demo"]').screenshot({ path: `${shots}/canvas-stack/web.png` })
  // Directions are physical: right-to-left doesn't move top-left or bottom-right.
  await w.evaluate((el) => (el.dir = "rtl"))
  await page.waitForTimeout(200)
  const rtl = await geo()
  check(rtl.hud.x === rtl.stack.x + 12 && rtl.button.r === rtl.stack.r - 12, "stack: place and inset don't flip right-to-left", rtl)
  await w.evaluate((el) => el.removeAttribute("dir"))
  // Full screen: the stack grows like a canvas and its fill canvas with it; the button stays in its corner.
  await w.hover()
  await w.locator(".pw-expand").click()
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(800)
  const f = await geo()
  check(
    f.stack.b - f.stack.y > 500 && JSON.stringify(f.canvas) === JSON.stringify(f.stack) && f.button.b === f.stack.b - 12 && f.button.r === f.stack.r - 12,
    "stack: in full screen it grows, its fill canvas with it, the button still bottom-right",
    f,
  )
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  check(errors.length === 0, "stack: no page errors", errors)
  await page.close()
}

// ---------- stack: a HUD over a plain GPU canvas, as tall as its canvas at any width ----------
{
  // Console's HUD artifact: a wgsl canvas with no key or handler fills the stack; the canvas element's own aspect
  // (300 x 150 until sized) once set the stack's height when wide.
  const source = `const WGSL = \`fn shade(frag: vec2f) -> vec4f { return vec4f(frag / widget.resolution, 0.5, 1.0); }\`
function init() { return { boost: 0 } }
function view(state, data) {
  return ui.stack({}, [
    ui.canvas({ wgsl: WGSL, height: 220, values: [state.boost, 0, 0, 0], fps: 60, place: "fill", alt: "Waves" }),
    ui.column({ place: "top-left", inset: 14, gap: 0 }, [
      ui.text(data.title, { style: "title" }),
      ui.text("Boost level " + state.boost, { style: "caption", tone: "muted" }),
    ]),
    ui.button("Boost", { place: "bottom-right", inset: 14, variant: "primary", onPress: (s) => ({ ...s, boost: s.boost + 1 }) }),
  ])
}`
  for (const width of [1280, 700]) {
    const { page, errors } = await open("?only=confirm", { width, height: 900 })
    await page.evaluate((source) => {
      const d = (window as unknown as { __demo: { host: { mount(el: HTMLElement, o: object): unknown }; prelude: string } }).__demo
      const slot = document.createElement("div")
      slot.className = "slot"
      slot.dataset.name = "hud-shape"
      slot.style.gridColumn = "1 / -1"
      document.getElementById("widgets")!.prepend(slot)
      d.host.mount(slot, { program: d.prelude + "\n" + source, data: { title: "HUD" }, mode: "step", theme: "dark" })
    }, source)
    const w = widget(page, "hud-shape")
    await rendered(w)
    await w.locator(".pw-surface[data-backend]").waitFor({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
    const geo = () =>
      w.evaluate((el) => {
        const r = (e: Element | null) => {
          const b = e!.getBoundingClientRect()
          return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }
        }
        const root = el.shadowRoot!
        return {
          stack: r(root.querySelector(".pw-stack")),
          canvas: r(root.querySelector(".pw-stack > .pw-surface")),
          hud: r(root.querySelector(".pw-stack > .pw-col")),
          button: r(root.querySelector(".pw-stack > .pw-btn")),
        }
      })
    const placed = (g: Awaited<ReturnType<typeof geo>>) =>
      JSON.stringify(g.canvas) === JSON.stringify(g.stack) &&
      g.hud.x === g.stack.x + 14 && g.hud.y === g.stack.y + 14 &&
      g.button.r === g.stack.r - 14 && g.button.b === g.stack.b - 14
    const g = await geo()
    check(g.stack.b - g.stack.y === 220 && placed(g), `stack (HUD, ${width} px): 220 tall like its fill canvas, HUD and button in their corners`, g)
    await w.hover()
    await w.locator(".pw-expand").click()
    await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(800)
    const f = await geo()
    check(f.stack.b - f.stack.y > 500 && placed(f), `stack (HUD, ${width} px): in full screen it grows with its canvas, corners kept`, f)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(500)
    const back = await geo()
    check(back.stack.b - back.stack.y === 220 && placed(back), `stack (HUD, ${width} px): back inline at 220`, back)
    check(errors.length === 0, `stack (HUD, ${width} px): no page errors`, errors)
    await page.close()
  }
}

// ---------- never draw at zero size ----------
{
  const { page, errors } = await open("?only=confirm")
  const got = await page.evaluate(async () => {
    const d = (window as unknown as { __demo: { host: { mount(el: HTMLElement, o: object): { setTheme(t: string): void; destroy(): void } }; fixtures: Record<string, { source: string; data: unknown; mode: string }>; prelude: string } }).__demo
    const slot = document.createElement("div")
    slot.style.width = "420px"
    document.body.prepend(slot)
    const draws: number[] = []
    const f = d.fixtures.chart!
    const w = d.host.mount(slot, { program: d.prelude + "\n" + f.source, data: f.data, onMetrics: (m: { kind: string }) => m.kind === "draw" && draws.push(1) })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await sleep(1500)
    const before = draws.length
    slot.style.width = "0px"
    await sleep(300)
    const zeroStart = draws.length
    w.setTheme("light") // asks every canvas to draw again
    await sleep(800)
    const whileZero = draws.length - zeroStart
    slot.style.width = "420px"
    await sleep(800)
    const after = draws.length - zeroStart - whileZero
    w.destroy()
    slot.remove()
    return { before, whileZero, after }
  })
  check(got.before > 0 && got.whileZero === 0 && got.after > 0, "canvas: no draw while it has zero width; it draws again once sized", got)
  check(errors.length === 0, "zero size: no page errors", errors)
  await page.close()
}

// ---------- minigame (live) ----------
{
  const { page, errors } = await open("?only=minigame")
  const w = widget(page, "minigame")
  await rendered(w)
  await page.waitForTimeout(500)
  const box = (await w.locator("canvas").boundingBox())!
  check((await painted(w))[0]! > 500, "minigame: the ready screen is drawn")
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(1500)
  for (let i = 0; i < 6; i++) {
    await page.mouse.click(box.x + box.width * (0.2 + 0.12 * i), box.y + box.height * (0.35 + 0.08 * (i % 4)))
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(300)
  await shot(w, "minigame")
  check((await painted(w))[0]! > 500, "minigame: frames drawn while playing")
  check(errors.length === 0, "minigame: no page errors", errors)
  await page.close()
}

// ---------- pause out of view ----------
{
  const { page, errors } = await open("?only=clock-demo")
  const w = widget(page, "clock-demo")
  await rendered(w)
  await page.evaluate(() => {
    const spacer = document.createElement("div")
    spacer.style.height = "5000px"
    document.body.append(spacer)
  })
  await page.waitForTimeout(1000)
  const started = Date.now()
  await page.evaluate(() => window.scrollTo(0, 4000))
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(500)
  const texts = await w.locator(".pw-text").allTextContents()
  const running = Number(/running ([\d.]+) s/.exec(texts.join(" "))?.[1])
  const paused = Number(/paused (\d+) ms/.exec(texts.join(" "))?.[1])
  const wall = (Date.now() - started) / 1000 + 1
  check(/resumed 1x/.test(texts.join(" ")) && paused >= 1200, "live: out of view it pauses, and gets { type: resumed, pausedMs } back", texts)
  check(running < wall - 1.1, `live: now() leaves the pause out (running ${running} s of ~${wall.toFixed(1)} s)`)
  await shot(w, "clock-resumed")
  check(errors.length === 0, "clock: no page errors", errors)
  await page.close()
}

// ---------- full screen ----------
{
  const { page, errors } = await open("?only=fullscreen-demo")
  const w = widget(page, "fullscreen-demo")
  await rendered(w)
  const heights = () =>
    w.evaluate((el) =>
      Object.fromEntries(
        [...el.shadowRoot!.querySelectorAll(".pw-surface")].map((s, i) => [["pulse", "echo", "strip"][i]!, Math.round(s.getBoundingClientRect().height)]),
      ),
    )
  const caption = async () => (await w.locator(".pw-caption").textContent()) ?? ""
  const enter = async () => {
    await w.hover()
    await w.locator(".pw-expand").click()
    await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(800)
  }
  const inFull = () => page.evaluate(() => document.fullscreenElement !== null)
  const inline = await heights()
  check(inline.pulse === 140 && inline.echo === 80 && inline.strip === 40, "full screen: inline, canvases keep their heights", inline)
  const historyBefore = await page.evaluate(() => history.length)
  await enter()
  const title = await w.locator(".pw-text").first().textContent()
  const full = await heights()
  check((await page.evaluate(() => document.fullscreenElement?.className)) === "psychoscript-widget", "full screen: the widget's element goes full screen")
  check(title?.includes("(full screen)") ?? false, "full screen: onFullscreen gets { type: 'fullscreen', value: true }", title)
  check(
    full.pulse! > 300 && Math.abs(full.pulse! - full.echo!) <= 2 && full.strip === 40,
    "full screen: canvases share the free height equally by default, fill: false keeps its height",
    full,
  )
  // The close button floats over the root's top-right corner: 32 x 32, 8 px from the top and right edges.
  const geo = await w.evaluate((el) => {
    const root = el.shadowRoot!
    const b = (root.querySelector(".pw-expand") as HTMLElement).getBoundingClientRect()
    const node = (root.querySelector(".pw-view") as HTMLElement).firstElementChild!.getBoundingClientRect()
    const pulse = root.querySelector(".pw-surface canvas") as HTMLCanvasElement
    const c = pulse.getBoundingClientRect()
    const scale = pulse.width / c.width
    const px = pulse.getContext("2d")!.getImageData(Math.round((b.left + b.width / 2 - c.left) * scale), Math.round((b.top + b.height / 2 - c.top) * scale), 1, 1).data
    const chrome = [...root.querySelectorAll(".pw-root > :not(.pw-view):not(.pw-expand):not(.pw-hint)")].filter((e) => getComputedStyle(e).display !== "none").length
    return {
      button: { w: b.width, h: b.height, screenTop: Math.round(b.top), screenRight: Math.round(innerWidth - b.right) },
      root: { left: Math.round(node.left), top: Math.round(node.top), right: Math.round(innerWidth - node.right), width: Math.round(node.width) },
      inRoot: [Math.round(b.left - node.left), Math.round(b.top - node.top), b.width, b.height].join(","),
      inPulse: [Math.round(b.left - c.left), Math.round(b.top - c.top), b.width, b.height].join(","),
      pixel: [...px.slice(0, 3)],
      label: el.shadowRoot!.querySelector(".pw-expand")!.getAttribute("aria-label"),
      visible: getComputedStyle(root.querySelector(".pw-expand")!).opacity,
      chrome,
    }
  })
  check(
    geo.button.w === 32 && geo.button.h === 32 && geo.button.screenTop === 8 && geo.button.screenRight === 8 && geo.visible === "1" &&
      geo.label === "Exit full screen" && geo.chrome === 0,
    "full screen: the close button floats 32 x 32, 8 px from the screen's top and right, always visible, the only chrome",
    geo,
  )
  check(
    geo.root.left === 16 && geo.root.top === 16 && geo.root.right === 16,
    "full screen: the root sits inside a 16 px padding, canvases included",
    geo.root,
  )
  check(geo.inRoot === `${geo.root.width - 24},-8,32,32`, `full screen: close is { x: W - 24, y: -8, 32, 32 } in root coordinates (${geo.inRoot})`)
  let text = await caption()
  check(text.includes("· close " + geo.inRoot + " ·"), `full screen: the fullscreen event carries close in root coordinates (${geo.inRoot})`, text)
  check(geo.pixel.join(",") === "255,0,255", "full screen: Frame.close is the button's area on the canvas under it (drawn magenta there)", geo.pixel)
  const pulseBox = (await w.locator(".pw-surface canvas").first().boundingBox())!
  await page.mouse.click(pulseBox.x + pulseBox.width / 2, pulseBox.y + pulseBox.height / 2)
  await page.waitForTimeout(300)
  text = await caption()
  check(text.endsWith("pointer close " + geo.inPulse), `full screen: pointer values from that canvas carry the same close (${geo.inPulse})`, text)
  await shot(page, "fullscreen")
  // Esc closes full screen even while the widget holds the keyboard, and releases it.
  check(await w.evaluate((el) => "focused" in el.dataset), "full screen: the click gave the widget keyboard focus")
  check(
    await w.evaluate((el) => getComputedStyle(el.shadowRoot!.querySelector(".pw-hint")!).display === "none"),
    "full screen: no focus hint over the widget (the close button is the only chrome)",
  )
  await page.keyboard.press("Escape")
  await page.waitForTimeout(600)
  const afterEsc = { full: await inFull(), focused: await w.evaluate((el) => "focused" in el.dataset), text: await caption() }
  check(!afterEsc.full && !afterEsc.focused && afterEsc.text.includes("close none ·"), "full screen: Esc closes it (keyboard focused), releases focus, and leaving sends close: null", afterEsc)
  const back = await heights()
  check(back.pulse === 140 && back.echo === 80 && back.strip === 40, "full screen: leaving it restores the heights", back)
  check(
    (await page.evaluate((k) => history.state?.[k], "psychoscriptWidgetFullscreen")) === undefined,
    "full screen: closing it takes its history entry back off",
  )
  // The browser's back closes it too, whatever holds the keyboard.
  await enter()
  check((await page.evaluate((k) => history.state?.[k] !== undefined, "psychoscriptWidgetFullscreen")) && (await page.evaluate(() => history.length)) > historyBefore, "full screen: entering pushes a history entry")
  await page.mouse.click(pulseBox.x + pulseBox.width / 2, pulseBox.y + 200)
  await page.goBack()
  await page.waitForTimeout(600)
  check(!(await inFull()) && !(await w.evaluate((el) => "focused" in el.dataset)) && page.url().includes("only=fullscreen-demo"), "full screen: the browser's back closes it and releases focus, staying on the page")
  // The close button closes it as well.
  await enter()
  await w.locator(".pw-expand").click()
  await page.waitForTimeout(600)
  check(!(await inFull()), "full screen: the close button closes it")
  check(errors.length === 0, "full screen: no page errors", errors)
  await page.close()
}
{
  // A canvas without any fill prop (the chart) grows in full screen too; the close button takes it back.
  const { page, errors } = await open("?only=chart")
  const w = widget(page, "chart")
  await rendered(w)
  const height = () => w.evaluate((el) => Math.round(el.shadowRoot!.querySelector(".pw-surface")!.getBoundingClientRect().height))
  const before = await height()
  await w.hover()
  await w.locator(".pw-expand").click()
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(800)
  const grown = await height()
  check(grown > before + 200, `full screen: the chart's canvas fills by default (${before} -> ${grown} px)`)
  await shot(page, "fullscreen-chart")
  await w.locator(".pw-expand").click()
  await page.waitForTimeout(600)
  check((await page.evaluate(() => document.fullscreenElement === null)) && (await height()) === before, "full screen: the close button exits and the canvas is back to its height")
  check(errors.length === 0, "full screen (chart): no page errors", errors)
  await page.close()
}

// ---------- slice budget ----------
{
  const { page, errors } = await open("?only=runaway-demo")
  const w = widget(page, "runaway-demo")
  await rendered(w)
  await w.locator("button.pw-btn", { hasText: "Spin" }).click()
  const error = w.locator(".pw-error")
  await error.waitFor({ timeout: 5000 }).catch(() => {})
  const text = (await error.textContent()) ?? ""
  check(/more than 50 ms without waiting/.test(text), "live: a run computing over 50 ms without awaiting is stopped", text)
  await shot(w, "slice-budget")
  await w.locator(".pw-error button", { hasText: "Restart" }).click()
  await w.locator("button.pw-btn", { hasText: "Spin" }).waitFor({ timeout: 5000 })
  check(await error.isHidden(), "live: Restart starts it again")
  const sliced = (await log(page)).filter((l) => l.startsWith("runaway-demo report"))
  check(sliced.length === 1 && /"phase":"main".*50 ms/.test(sliced[0]!), "failures: the slice budget is a program error (phase main)", sliced)
  check(errors.length === 0, "runaway: no page errors", errors)
  await page.close()
}

// ---------- fetch rules ----------
{
  const { page, errors } = await open("?only=fetch-demo")
  const w = widget(page, "fetch-demo")
  await rendered(w)
  check((await w.locator(".pw-chip").textContent()) === "Network: api.github.com", "fetch: the capability chip shows the declared host")
  const lines = async () => (await w.locator(".pw-text").allTextContents()).join(" | ")
  const until = async (re: RegExp) => {
    const end = Date.now() + 16000
    while (Date.now() < end && !re.test(await lines())) await page.waitForTimeout(100)
    return lines()
  }
  const first = await until(/status \d+|Network:|Timeout:/)
  check(/status 200/.test(first) || /Network:/.test(first), "fetch: an allowed host goes through the browser (200, or Network without connectivity)", first)
  await w.locator("button.pw-btn", { hasText: "localhost" }).click()
  const local = await until(/http:\/\/localhost[\s\S]*CapabilityDenied/)
  check(/CapabilityDenied: only https/.test(local), "fetch: http: is denied", local)
  await w.locator("button.pw-btn", { hasText: "example.com" }).click()
  const other = await until(/example\.com[\s\S]*CapabilityDenied/)
  check(/isn't among the hosts/.test(other), "fetch: an undeclared host is denied", other)
  check(!(await log(page)).some((l) => / report /.test(l)), "failures: fetch errors the program handles are never reported")
  await shot(w, "fetch")
  check(errors.length === 0, "fetch: no page errors", errors)
  await page.close()
}

// ---------- keyboard focus and pointer capture ----------
{
  const { page, errors } = await open("?only=keys-demo")
  const w = widget(page, "keys-demo")
  await rendered(w)
  await page.evaluate(() => {
    const spacer = document.createElement("div")
    spacer.style.height = "3000px"
    document.body.append(spacer)
  })
  const text = async () => (await w.locator(".pw-text").allTextContents()).join(" | ")
  const until = async (re: RegExp, ms = 3000) => {
    const end = Date.now() + ms
    let t = await text()
    while (Date.now() < end && !re.test(t)) {
      await page.waitForTimeout(50)
      t = await text()
    }
    return t
  }
  const hint = () => w.evaluate((el) => getComputedStyle(el.shadowRoot!.querySelector(".pw-hint")!).display !== "none")
  const pad = (await w.locator("canvas").boundingBox())!
  // Hover: moves over a canvas with an id and no button held, at most one a frame.
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(pad.x + 30 + i * 40, pad.y + pad.height / 2)
    await page.waitForTimeout(60)
  }
  let t = await until(/hover [3-9]/)
  const hovered = Number(/hover (\d+)/.exec(t)?.[1] ?? 0)
  check(hovered >= 3 && hovered <= 5, `hover: moves with down: false reach update without a button held (${hovered} for 5 moves)`, t)
  // 40 moves in one task (Chromium already aligns real input to frames, so send them at once).
  await w.evaluate((el) => {
    const c = el.shadowRoot!.querySelector("canvas")!
    const r = c.getBoundingClientRect()
    for (let i = 0; i < 40; i++)
      c.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 20 + i * 5, clientY: r.top + 30, pointerType: "mouse", bubbles: true, composed: true }))
  })
  await page.waitForTimeout(300)
  const burst = Number(/hover (\d+)/.exec(await text())?.[1] ?? 0) - hovered
  check(burst === 1, `hover: at most one a frame (${burst} sent for 40 moves in one frame)`)
  await page.mouse.click(pad.x + pad.width / 2, pad.y + pad.height / 2)
  t = await until(/focus true/)
  check(/focus true/.test(t), "keys: a click inside gives the widget keyboard focus ({ type: focus, value: true })", t)
  check((await hint()) && (await w.evaluate((el) => "focused" in el.dataset)), "keys: focus ring and the Esc-to-release hint show")
  const hintShape = () =>
    w.evaluate((el) => {
      const h = el.shadowRoot!.querySelector(".pw-hint") as HTMLElement
      return { mode: h.dataset.mode, icon: h.querySelector("svg") !== null, text: h.textContent, label: h.getAttribute("aria-label") }
    })
  const focusedHint = await hintShape()
  check(focusedHint.mode === "keyboard" && focusedHint.icon && focusedHint.text === "Esc", "keys: the hint is a keyboard icon plus Esc", focusedHint)
  const scrolled = await page.evaluate(() => window.scrollY)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("x")
  t = await until(/last up x · keys 4/)
  check(/last up x · keys 4/.test(t), "keys: down and up reach update, with key and code", t)
  check((await page.evaluate(() => window.scrollY)) === scrolled, "keys: the page doesn't scroll on the widget's arrow keys")
  const slot = page.locator('.slot[data-name="keys-demo"]')
  await shot(slot, "keys-focused")
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a")
  await page.waitForTimeout(300)
  check(/keys 4/.test(await text()), "keys: Cmd/Ctrl chords go to the page, not the widget")
  // The chord was the page's select-all: clear it for the screenshots.
  await page.evaluate(() => getSelection()?.removeAllRanges())
  await page.keyboard.press("Escape")
  t = await until(/focus false/)
  check(/focus false/.test(t) && /keys 4/.test(t), "keys: Esc releases focus and is never delivered", t)
  check(!(await hint()), "keys: the hint goes with the focus")
  await w.focus()
  t = await until(/focus true/)
  check(/focus true/.test(t), "keys: tabbing to the widget (focus) gives it the keyboard too", t)
  await page.keyboard.press("Escape")
  await until(/focus false/)

  // Pointer capture: the root asks with capture: "pointer"; the next click grants it.
  await w.locator("button.pw-btn", { hasText: "Ask for the mouse" }).click()
  await w.locator("button.pw-btn", { hasText: "Stop asking" }).waitFor({ timeout: 3000 })
  const locked = () => w.evaluate((el) => document.pointerLockElement === el)
  check(!(await locked()), "capture: not granted before the next click")
  await page.mouse.click(pad.x + pad.width / 2, pad.y + pad.height / 2)
  t = await until(/captured true/)
  check((await locked()) && /captured true/.test(t), "capture: the next click locks the pointer ({ type: capture, value: true })", t)
  const capturedHint = await hintShape()
  check(capturedHint.mode === "pointer" && capturedHint.icon && capturedHint.text === "Esc", "capture: the hint turns into a cursor icon plus Esc", capturedHint)
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(pad.x + pad.width / 2 + i * 12, pad.y + pad.height / 2 + i * 3)
    await page.waitForTimeout(40)
  }
  await page.mouse.down()
  await page.mouse.up()
  t = await until(/buttons 2/)
  const moved = Number(/moved (\d+)/.exec(t)?.[1] ?? 0)
  check(moved > 0 && /buttons 2/.test(t), `capture: relative moves (dx, dy) and buttons reach the program (moved ${moved})`, t)
  await shot(slot, "keys-captured")
  await page.keyboard.press("Escape")
  t = await until(/focus false · captured false/)
  check(!(await locked()) && /focus false · captured false/.test(t), "capture: one Esc releases the pointer and the keyboard", t)
  check(errors.length === 0, "keys: no page errors", errors)
  await page.close()
}
{
  const { page, errors } = await open("?only=keys-live")
  const w = widget(page, "keys-live")
  await rendered(w)
  const text = async () => (await w.locator(".pw-text").allTextContents()).join(" | ")
  const until = async (re: RegExp) => {
    const end = Date.now() + 3000
    let t = await text()
    while (Date.now() < end && !re.test(t)) {
      await page.waitForTimeout(50)
      t = await text()
    }
    return t
  }
  const pad = (await w.locator("canvas").boundingBox())!
  await page.mouse.click(pad.x + 20, pad.y + pad.height / 2)
  await until(/focus true/)
  await page.keyboard.press("k")
  let t = await until(/last up k/)
  check(/focus true/.test(t) && /last up k · keys 2/.test(t), "keys (live): focus and keys reach widget.event()", t)
  await w.locator("button.pw-btn", { hasText: "Capture the mouse" }).click()
  await page.waitForTimeout(200)
  await page.mouse.click(pad.x + 40, pad.y + pad.height / 2)
  t = await until(/captured true/)
  check(/captured true/.test(t), "capture (live): capturePointer() is granted on the next click", t)
  await page.keyboard.press("Escape")
  t = await until(/focus false · captured false/)
  check(/focus false · captured false/.test(t), "capture (live): Esc releases both", t)
  check(errors.length === 0, "keys (live): no page errors", errors)
  await page.close()
}

// ---------- failures: program vs client errors, reports, Ask agent to fix it ----------
for (const query of ["?only=broken-demo", "?only=broken-demo&nosource=1"]) {
  const { page, errors } = await open(query)
  const w = widget(page, "broken-demo")
  await rendered(w)
  await w.locator("button.pw-btn", { hasText: "Break it" }).click()
  const line = await waitLog(page, (l) => l.startsWith("broken-demo report"))
  const report = line ? JSON.parse(line.slice("broken-demo report ".length)) : undefined
  check(
    report?.phase === "event" &&
      /TypeError/.test(report?.message) &&
      !/\(line \d+/.test(report?.message) &&
      report?.line === 4 &&
      typeof report?.column === "number",
    `failures: a handler's exception is reported once, with its widget-template-relative position${query.includes("nosource") ? " (prelude found without source)" : ""}`,
    report,
  )
  check(/\(line 4/.test((await w.locator(".pw-error").textContent()) ?? ""), "failures: the inline error shows the widget template's line too")
  const failure = w.locator(".pw-failure")
  const ask = failure.locator("button", { hasText: "Ask agent to fix it" })
  await ask.waitFor({ timeout: 3000 }).catch(() => {})
  check(await ask.isVisible(), "failures: a failure with sent: false offers Ask agent to fix it")
  check((await failure.locator(".pw-failure-text").count()) === 0, "failures: the failure's text isn't repeated under the same local error")
  await w.locator("button.pw-btn", { hasText: "Break it" }).click()
  await page.waitForTimeout(300)
  check((await log(page)).filter((l) => l.startsWith("broken-demo report")).length === 1, "failures: the same error isn't reported twice")
  await ask.click()
  const asked = await waitLog(page, (l) => l.startsWith("broken-demo ask"))
  check(asked !== undefined && asked.slice("broken-demo ask ".length) === JSON.stringify(report), "failures: Ask calls the embedder's onAsk with the same error", asked)
  await failure.locator(".pw-failure-told").waitFor({ timeout: 3000 }).catch(() => {})
  check(
    (await failure.locator(".pw-failure-told").textContent()) === "The agent was told about this error." && (await ask.count()) === 0,
    "failures: with sent: true it says the agent was told",
  )
  if (!query.includes("nosource")) await shot(page.locator('.slot[data-name="broken-demo"]'), "failure-told")
  check(!(await log(page)).some((l) => / client-error /.test(l)), "failures: a program error is no client error")
  check(errors.length === 0, "failures: no page errors", errors)
  await page.close()
}
{
  // An artifact (no agent session): no ask handler, so a failure shows without the button.
  const { page, errors } = await open("?only=broken-demo&noask=1")
  const w = widget(page, "broken-demo")
  await rendered(w)
  await page.evaluate(() =>
    (window as unknown as { __demo: { widgets: Record<string, { setFailure(f: unknown): void }> } }).__demo.widgets["broken-demo"]!.setFailure({
      phase: "init",
      message: "ReferenceError: boom is not defined",
      line: 2,
      column: 9,
      client: "tui",
      sent: false,
    }),
  )
  const failure = w.locator(".pw-failure")
  const text = (await failure.locator(".pw-failure-text").textContent()) ?? ""
  check(text === "Failed on tui: init: ReferenceError: boom is not defined (line 2, col 9)", "failures: another client's failure shows as Failed on <client>: <phase>: <message> (line:col)", text)
  check((await failure.locator("button").count()) === 0, "failures: without onAsk (an artifact) there's no Ask button")
  await shot(page.locator('.slot[data-name="broken-demo"]'), "failure-artifact")
  check(errors.length === 0, "failures (artifact): no page errors", errors)
  await page.close()
}
for (const query of ["?only=shader-broken", "?only=shader-broken&gl=1"]) {
  const { page, errors } = await open(query)
  const w = widget(page, "shader-broken")
  await rendered(w)
  const line = await waitLog(page, (l) => l.startsWith("shader-broken report"), 8000)
  const report = line ? JSON.parse(line.slice("shader-broken report ".length)) : undefined
  check(
    report?.phase === "shader" && /WGSL line 2/.test(report?.message) && report?.line === undefined,
    `failures: WGSL that fails validation is a program error (${query.includes("gl") ? "naga" : "WebGPU"})`,
    report,
  )
  check(errors.length === 0, "failures (shader): no page errors", errors)
  await page.close()
}
{
  // A host that can't start its worker: a client error for the dev log, never a report.
  const { page } = await open("?only=confirm")
  const got = await page.evaluate(async () => {
    const d = (window as unknown as { __demo: { WidgetHost: new (o: object) => { mount(el: HTMLElement, o: object): { destroy(): void }; destroy(): void }; fixtures: Record<string, { source: string; data: unknown }> } }).__demo
    const slot = document.createElement("div")
    document.body.prepend(slot)
    const reports: unknown[] = []
    const clientErrors: string[] = []
    const host = new d.WidgetHost({ workerUrl: "/no-such-worker.js" })
    host.mount(slot, {
      program: "const __widget_protocol = 2\nfunction view() { return ui.text('x') }",
      data: {},
      onReport: (e: unknown) => reports.push(e),
      onClientError: (m: string) => clientErrors.push(m),
    })
    await new Promise((r) => setTimeout(r, 2500))
    host.destroy()
    return { reports, clientErrors }
  })
  check(got.reports.length === 0 && got.clientErrors.length > 0, "failures: a host failure (no worker) goes to onClientError, not onReport", got)
  await page.close()
}

// ---------- widget protocol 2: the protocol check, rules of views, functions where none may go ----------
{
  const { page, errors } = await open("?only=confirm")
  const got = await page.evaluate(async () => {
    const d = (window as unknown as { __demo: { host: { mount(el: HTMLElement, o: object): { destroy(): void } }; prelude: string } }).__demo
    const older = d.prelude.slice(d.prelude.indexOf("\n") + 1)
    const run = async (name: string, program: string, mode: string, act?: (root: ShadowRoot) => void) => {
      const slot = document.createElement("div")
      document.body.prepend(slot)
      const reports: { phase: string; message: string }[] = []
      const clientErrors: string[] = []
      const w = d.host.mount(slot, { program, data: null, mode, onReport: (e: { phase: string; message: string }) => reports.push(e), onClientError: (m: string) => clientErrors.push(m) })
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await sleep(1200)
      const root = slot.querySelector(".psychoscript-widget")!.shadowRoot!
      if (act) {
        act(root)
        await sleep(800)
      }
      const out = { name, reports, clientErrors, shown: (root.querySelector(".pw-error-card, .pw-error:not([hidden])") as HTMLElement | null)?.textContent ?? "", buttons: root.querySelectorAll(".pw-view .pw-btn").length }
      w.destroy()
      slot.remove()
      return out
    }
    const step = (source: string) => d.prelude + "\n" + source
    return [
      await run("older", older + "\nfunction view() { return ui.text('x') }", "step"),
      await run("older-live", older + "\nasync function main() { widget.render(ui.text('x')) }", "live"),
      await run("newer", "const __widget_protocol = 3\nfunction view() { return ui.text('x') }", "step"),
      await run(
        "key",
        step(`function view(state) {\n  return ui.column([ui.button("b", { key: state.bad ? { a: 1 } : "k", onPress: () => ({ bad: true }) })])\n}`),
        "step",
        (root) => (root.querySelector(".pw-view .pw-btn") as HTMLElement).click(),
      ),
      await run("deep", step(`async function main() {\n  let node = ui.text("x")\n  for (let i = 1; i < 101; i++) node = ui.column([node])\n  widget.render(node)\n}`), "live"),
      await run("function", step(`function view() {\n  return ui.column({ onHover: (s) => s }, [ui.text("t")])\n}`), "step"),
    ]
  })
  const by = Object.fromEntries(got.map((g) => [g.name, g]))
  const OLDER = "This widget was built with an older widget runtime; ask the agent to post it again"
  const NEWER = "This widget needs a newer version of this app"
  check(
    JSON.stringify(by.older!.reports) === JSON.stringify([{ phase: "init", message: OLDER }]) && by.older!.shown.includes(OLDER),
    "protocol: a program without `const __widget_protocol = 2` isn't run: the older-runtime error, reported in phase init",
    by.older,
  )
  check(JSON.stringify(by["older-live"]!.reports) === JSON.stringify([{ phase: "main", message: OLDER }]), "protocol: an older live program is refused in phase main", by["older-live"])
  check(
    by.newer!.reports.length === 0 && by.newer!.clientErrors.includes(NEWER) && by.newer!.shown.includes(NEWER),
    "protocol: a newer program shows the newer-app message, a client error, never reported",
    by.newer,
  )
  check(
    JSON.stringify(by.key!.reports) === JSON.stringify([{ phase: "view", message: "A node's key must be a string, a number or a boolean" }]) && by.key!.buttons === 1,
    "rules of views: a key of another type fails the step in phase view, the view kept",
    by.key,
  )
  check(JSON.stringify(by.deep!.reports) === JSON.stringify([{ phase: "view", message: "The view nests more than 100 levels" }]), "rules of views: a live view over 100 levels ends the run in phase view", by.deep)
  check(
    JSON.stringify(by.function!.reports) === JSON.stringify([{ phase: "init", message: "TypeError: Argument 1 to __widget_emit contains a function, which cannot be passed to the host." }]),
    "functions: a function in a view's prop fails the step with the runtime's TypeError",
    by.function,
  )
  check(errors.length === 0, "protocol 2: no page errors", errors)
  await page.close()
}

// ---------- local network in dev mode ----------
for (const [query, on] of [["?only=local-demo", true], ["?only=local-demo&local=0", false]] as const) {
  const { page, errors } = await open(query)
  const w = widget(page, "local-demo")
  await rendered(w)
  const end = Date.now() + 8000
  let text = ""
  while (Date.now() < end && !/status|CapabilityDenied|Network/.test(text)) {
    text = (await w.locator(".pw-text").allTextContents()).join(" | ")
    await page.waitForTimeout(100)
  }
  if (on) {
    check(/status 200/.test(text), "fetch: allowLocalNetwork lets a declared localhost:port through over http:", text)
    check(/local network allowed/.test((await w.locator(".pw-chip").textContent()) ?? ""), "fetch: the chip says the local network is allowed")
    await shot(w, "local-network")
  } else check(/CapabilityDenied: only https/.test(text), "fetch: without allowLocalNetwork the same request is denied", text)
  check(errors.length === 0, `local network (${on ? "on" : "off"}): no page errors`, errors)
  await page.close()
}

await browser.close()
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
