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
    [...el.shadowRoot!.querySelectorAll(".pw-surface[data-kind=canvas] canvas")].flatMap((c) => {
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
    if ((await w.locator(".pw-surface[data-kind=canvas]").count()) > 0 && name !== "minigame") {
      await page.waitForTimeout(150)
      const px = await painted(w)
      check(px.length > 0 && px.every((n) => n > 100), `${name}: canvas drawn`, px)
    }
  }
  for (const name of names) {
    const want = name === "fetch-demo" || name === "local-demo" || name === "keys-live" ? false : surfaces.has(name) || name.endsWith("-demo") || name === "minigame"
    check((await expandShown(widget(page, name))) === want, `${name}: full-screen button ${want ? "offered" : "not offered"}`)
  }
  check(errors.length === 0, "all: no page errors", errors.slice(0, 3))
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
  check(errors.length === 0, `shader (${backend}): no page errors`, errors)
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
  await w.hover()
  const expand = w.locator(".pw-expand")
  await expand.click()
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(700)
  const inFull = await page.evaluate(() => document.fullscreenElement?.className)
  const title = await w.locator(".pw-text").first().textContent()
  const height = (await w.locator("canvas").boundingBox())?.height ?? 0
  check(inFull === "psychoscript-widget", "full screen: the widget's element goes full screen", inFull)
  check(title?.includes("(full screen)") ?? false, "full screen: update gets { id: '', type: 'fullscreen', value: true }", title)
  check(height > 500, `full screen: the fill canvas takes the free height (${Math.round(height)} px)`)
  await shot(page, "fullscreen")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)
  if (await page.evaluate(() => document.fullscreenElement !== null)) await page.evaluate(() => document.exitFullscreen())
  await page.waitForTimeout(500)
  const after = await w.locator(".pw-text").first().textContent()
  const back = (await w.locator("canvas").boundingBox())?.height ?? 0
  check(!after?.includes("(full screen)") && Math.round(back) === 140, "full screen: leaving it sends value false and the canvas keeps its height", { after, back })
  check(errors.length === 0, "full screen: no page errors", errors)
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
  await page.mouse.click(pad.x + pad.width / 2, pad.y + pad.height / 2)
  let t = await until(/focus true/)
  check(/focus true/.test(t), "keys: a click inside gives the widget keyboard focus ({ type: focus, value: true })", t)
  check((await hint()) && (await w.evaluate((el) => "focused" in el.dataset)), "keys: focus ring and the Esc-to-release hint show")
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
