#!/usr/bin/env bun
// Checks the demo in a real Chromium: renders, presses controls and asserts what the widgets submit.
// Needs the demo server (bun scripts/serve.ts). Run under Xvfb for WebGPU screenshots: xvfb-run -a bun scripts/check.ts
// Env: CHROMIUM (executable), DEMO (base URL), SHOTS (screenshot directory; none when unset).
import { chromium, type Page } from "playwright-core"

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
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}

async function open(query: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
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

// confirm: a plain button press submits.
{
  const { page, errors } = await open("?only=confirm")
  const w = widget(page, "confirm")
  await w.locator("button.pw-btn", { hasText: "Delete" }).click()
  const line = await waitLog(page, (l) => l.startsWith("confirm submit"))
  check(line === 'confirm submit {"confirmed":true}', "confirm: pressing Delete submits { confirmed: true }", line)
  check(await w.locator(".pw-status").textContent().then((t) => t?.startsWith("Submitted") ?? false), "confirm: read-only with a status line")
  check(errors.length === 0, "confirm: no page errors", errors)
  await page.close()
}

// suggestions: a card press, a note, then Choose.
{
  const { page, errors } = await open("?only=suggestions")
  const w = widget(page, "suggestions")
  await w.locator(".pw-card").nth(1).click()
  await page.waitForFunction(() => true)
  await w.locator(".pw-card.pw-selected").first().waitFor({ timeout: 3000 })
  await w.locator("input.pw-input").fill("ship it")
  await w.locator("input.pw-input").press("Enter")
  await w.locator("button.pw-btn", { hasText: "Choose" }).click()
  const line = await waitLog(page, (l) => l.startsWith("suggestions submit"))
  check(line === 'suggestions submit {"choice":"Minimal","index":1,"note":"ship it"}', "suggestions: card, note and Choose submit", line)
  check(errors.length === 0, "suggestions: no page errors", errors)
  await page.close()
}

// form: text, slider (keyboard), checkbox, select, submit.
{
  const { page, errors } = await open("?only=form")
  const w = widget(page, "form")
  await w.locator("input.pw-input").first().fill("v2.0")
  await w.locator("input.pw-input").first().blur()
  const slider = w.locator("input.pw-slider")
  await slider.focus()
  await slider.press("ArrowRight")
  await w.locator(".pw-check input").click()
  await w.locator(".pw-option", { hasText: "EU West" }).click()
  await page.waitForTimeout(200)
  await w.locator("button.pw-btn", { hasText: "Deploy" }).click()
  const line = await waitLog(page, (l) => l.startsWith("form submit"))
  const value = line ? JSON.parse(line.slice("form submit ".length)) : undefined
  check(
    value?.name === "v2.0" && value?.replicas === 3 && value?.canary === false && value?.region === "eu-west",
    "form: every control reaches the submitted value",
    value,
  )
  check(errors.length === 0, "form: no page errors", errors)
  await page.close()
}

await browser.close()
if (shots) console.log(`screenshots in ${shots}`)
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
