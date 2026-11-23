// One-off browser check: serves site/, loads it at desktop and phone widths in
// headless Chromium with WebGPU, and writes screenshots plus a JSON report to
// .preview/shots. Run on a browser worker: `bun check.mjs` from tools/.
import { chromium } from 'playwright-core'
import { mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../site/', import.meta.url).pathname
const outDir = new URL('../.preview/shots/', import.meta.url).pathname
mkdirSync(outDir, { recursive: true })

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
    const file = Bun.file(join(root, path.endsWith('/') ? `${path}index.html` : path))
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 })
  },
})
// BASE=https://… checks a deployed copy in place of the one in site/.
const base = process.env.BASE ?? `http://127.0.0.1:${server.port}/`

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds)
    for (const arch of ['chrome-mac-arm64', 'chrome-mac'])
      for (const app of [
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const path = join(cache, build, arch, app)
        if (existsSync(path)) return path
      }
  throw new Error('no Chromium build found')
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--mute-audio', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'],
})
const report = { browser: browser.version() }

// PERF=1: only count frames a second at a few sizes, beside an empty page's.
if (process.env.PERF) {
  const count = (page) =>
    page.evaluate(
      () =>
        new Promise((done) => {
          let n = 0
          const t0 = performance.now()
          const tick = () => {
            n++
            if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
            else done(Math.round(n / 4))
          }
          requestAnimationFrame(tick)
        }),
    )
  const sizes = [
    ['empty', 1440, 900, 1, 'about:blank'],
    ['small', 720, 450, 1],
    ['desktop', 1440, 900, 1],
    ['retina', 1512, 982, 2],
    ['phone', 390, 844, 2],
  ]
  for (const [name, width, height, scale, url = base] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
    const page = await context.newPage()
    await page.goto(url === base ? `${base}?awake` : url)
    await page.waitForTimeout(4000)
    console.log(name, await count(page), await page.evaluate(() => document.querySelector('canvas.liquid')?.width))
    await context.close()
  }
  await browser.close()
  server.stop()
  process.exit(0)
}

async function open({ name, width, height, scale, query = '?awake', noGpu = false }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  const page = await context.newPage()
  const problems = []
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`))
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()}: ${r.url()}`))
  if (noGpu) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }))
  await page.goto(base + query, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  // How long the picture takes to come up after the page has loaded (its shaders have to be compiled first).
  const began = Date.now()
  if (!noGpu) await page.waitForFunction(() => document.querySelector('canvas.liquid')?.classList.contains('is-live'), null, { timeout: 20000 }).catch(() => {})
  const liveAfter = Date.now() - began
  await page.waitForTimeout(1500)
  report[name] = { problems, liveAfter }
  return { page, context, entry: report[name] }
}

const facts = (page) =>
  page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    const canvas = document.querySelector('canvas.liquid')
    const box = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect()
      return r && [r.x, r.y, r.width, r.height].map(Math.round)
    }
    return {
      webgpu: Boolean(navigator.gpu),
      adapter: adapter ? `${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.description}`.trim() : null,
      live: canvas.classList.contains('is-live'),
      canvas: [canvas.width, canvas.height],
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      pageHeight: document.documentElement.scrollHeight,
      fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`),
      boxes: { hero: box('.hero'), title: box('.title'), card: box('.card'), scene: box('.scene'), prompt: box('.prompt') },
      motion: document.documentElement.dataset.motion,
    }
  })

// Desktop, frozen at two moments so the frames can be compared.
{
  const { page, context, entry } = await open({ name: 'desktop', width: 1440, height: 900, scale: 1, query: '?freeze=6' })
  Object.assign(entry, await facts(page))
  await page.screenshot({ path: join(outDir, 'desktop-hero.png') })
    await context.close()
}
{
  const { page, context } = await open({ name: 'desktopLater', width: 1440, height: 900, scale: 1, query: '?freeze=47' })
  await page.screenshot({ path: join(outDir, 'desktop-hero-later.png') })
  await context.close()
}

// Desktop, live: the keyboard reaches every control, the sound comes on
// (muted here), a typed line can be cast, and the planet brings the night.
{
  const { page, context, entry } = await open({ name: 'desktopLive', width: 1440, height: 900, scale: 1 })
  await page.waitForTimeout(5000)
  entry.framesPerSecond = await page.evaluate(
    () =>
      new Promise((done) => {
        let n = 0
        const t0 = performance.now()
        const tick = () => {
          n++
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick)
          else done(Math.round(n / 3))
        }
        requestAnimationFrame(tick)
      }),
  )
  const stops = []
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab')
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement
        return `${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') || ''}"`
      }),
    )
  }
  entry.tabStops = stops
  await page.locator('#sound-toggle').click()
  await page.waitForTimeout(2500)
  entry.sound = await page.evaluate(() => document.querySelector('#sound-toggle').getAttribute('aria-pressed'))
  await page.locator('body').click({ position: { x: 700, y: 500 } })
  await page.keyboard.type('psycho', { delay: 80 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(outDir, 'desktop-cast.png') })
  await page.locator('.hot--sun').click()
  await page.waitForTimeout(1800)
  await page.screenshot({ path: join(outDir, 'desktop-roar.png') })
  await page.locator('.hot--planet').click()
  await page.waitForTimeout(11000)
  await page.screenshot({ path: join(outDir, 'desktop-night.png') })
  await page.locator('.prompt').click({ force: true })
  await page.waitForTimeout(1200)
  const before = await page.locator('canvas.liquid').screenshot()
  await page.locator('#motion-toggle').click()
  await page.waitForTimeout(400)
  const paused = await page.locator('canvas.liquid').screenshot()
  await page.waitForTimeout(700)
  const still = await page.locator('canvas.liquid').screenshot()
  entry.motion = {
    pressed: await page.evaluate(() => document.querySelector('#motion-toggle').getAttribute('aria-pressed')),
    movedBeforePause: !before.equals(paused),
    stillWhilePaused: paused.equals(still),
  }
  await page.locator('#sound-toggle').click()
  entry.soundOff = await page.evaluate(() => document.querySelector('#sound-toggle').getAttribute('aria-pressed'))
  await context.close()
}

// A retina laptop: four times the pixels. How many frames a second does it manage?
{
  const { page, context, entry } = await open({ name: 'desktopRetina', width: 1512, height: 982, scale: 2 })
  await page.waitForTimeout(5000)
  entry.framesPerSecond = await page.evaluate(
    () =>
      new Promise((done) => {
        let n = 0
        const t0 = performance.now()
        const tick = () => {
          n++
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick)
          else done(Math.round(n / 3))
        }
        requestAnimationFrame(tick)
      }),
  )
  await page.screenshot({ path: join(outDir, 'retina.png') })
  await context.close()
}

// Desktop without WebGPU: the still SVG stands in.
{
  const { page, context, entry } = await open({ name: 'desktopNoGpu', width: 1440, height: 900, scale: 1, noGpu: true })
  Object.assign(entry, await facts(page))
  await page.screenshot({ path: join(outDir, 'desktop-hero-nogpu.png') })
  await context.close()
}

// Phone and small tablet.
for (const [name, width, height, scale] of [
  ['phone', 390, 844, 2],
  ['tablet', 768, 1024, 1],
]) {
  const { page, context, entry } = await open({ name, width, height, scale, query: '?freeze=6' })
  Object.assign(entry, await facts(page))
  await page.screenshot({ path: join(outDir, `${name}-full.png`), fullPage: true })
  await context.close()
}
{
  const { page, context, entry } = await open({ name: 'phoneNoGpu', width: 390, height: 844, scale: 1, noGpu: true })
  Object.assign(entry, await facts(page))
  await page.screenshot({ path: join(outDir, 'phone-nogpu.png'), fullPage: true })
  await context.close()
}

// The way in: the page opens grey, the tab is the only thing that can be
// pressed, taking it brings the picture and the sound, and Escape wears it off.
for (const [name, width, height, scale] of [
  ['front', 1440, 900, 1],
  ['frontPhone', 390, 844, 2],
  ['frontNoGpu', 1440, 900, 1],
]) {
  const { page, context, entry } = await open({ name, width, height, scale, query: '', noGpu: name === 'frontNoGpu' })
  const state = () =>
    page.evaluate(() => ({
      trip: document.documentElement.dataset.trip,
      title: document.title,
      posterInert: document.querySelector('.poster').inert,
      corpShown: getComputedStyle(document.querySelector('.corp')).visibility,
      live: document.querySelector('canvas.liquid').classList.contains('is-live'),
      sound: document.querySelector('#sound-toggle').getAttribute('aria-pressed'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    }))
  entry.before = await state()
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  await page.keyboard.press('Tab')
  entry.firstTabStop = await page.evaluate(() => document.activeElement.getAttribute('aria-label'))
  await page.keyboard.press('Tab')
  entry.secondTabStop = await page.evaluate(() => document.activeElement.tagName)
  await page.locator('.tab').click({ force: true })
  for (const [wait, shot] of [[500, 'a'], [500, 'b'], [600, 'c'], [600, 'd'], [2600, 'after']]) {
    await page.waitForTimeout(wait)
    await page.screenshot({ path: join(outDir, `${name}-${shot}.png`) })
  }
  entry.after = await state()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${name}-down.png`) })
  await page.waitForTimeout(1200)
  entry.back = await state()
  await context.close()
}

// FRONT=1: the grey page without its tab as an image, and where the tab sits,
// for tools/clip.mjs to lay over a film.
if (process.env.FRONT) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 4 / 3 })
  const page = await context.newPage()
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }))
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const { tab, sheets } = await page.evaluate(async () => {
    const { drawPage } = await import('./liquid.js')
    const corp = document.querySelector('.corp')
    const button = corp.querySelector('.tab')
    const r = button.getBoundingClientRect()
    const sheets = [false, true].map((inScript) => {
      const sheet = document.createElement('canvas')
      sheet.width = Math.round(innerWidth * devicePixelRatio)
      sheet.height = Math.round(innerHeight * devicePixelRatio)
      const g = sheet.getContext('2d')
      g.scale(devicePixelRatio, devicePixelRatio)
      drawPage(g, corp, button, inScript)
      return sheet.toDataURL('image/png').split(',')[1]
    })
    return { tab: [r.x + r.width / 2, r.y + r.height / 2], sheets }
  })
  writeFileSync(join(outDir, 'grey.png'), Buffer.from(sheets[0], 'base64'))
  writeFileSync(join(outDir, 'grey-script.png'), Buffer.from(sheets[1], 'base64'))
  writeFileSync(join(outDir, 'tab.json'), JSON.stringify(tab))
  await context.close()
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
server.stop(true)
