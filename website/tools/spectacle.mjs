// One-off browser check of the typed spectacles with the sound on: types `speak`, `stars` and `sing` into the
// picture at desktop and phone widths and writes shots and any problems to .preview/spectacle. Run on a browser
// worker: `bun spectacle.mjs` from tools/ (BASE=https://… checks a deployed copy).
import { chromium } from 'playwright-core'
import { mkdirSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = new URL('../site/', import.meta.url).pathname
const outDir = new URL('../.preview/spectacle/', import.meta.url).pathname
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
const base = process.env.BASE ?? `http://127.0.0.1:${server.port}/`
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const build = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0]
const exe = ['chrome-mac-arm64', 'chrome-mac']
  .flatMap((arch) => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium'].map((app) => join(cache, build, arch, app)))
  .find(existsSync)
const browser = await chromium.launch({ executablePath: exe, args: ['--mute-audio', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const report = {}
for (const [name, width, height] of [['wide', 1440, 900], ['narrow', 430, 900]]) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const problems = []
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  await page.goto(`${base}?awake`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelector('canvas.liquid')?.classList.contains('is-live'), null, { timeout: 30000 })
  await page.locator('#sound-toggle').click()
  await page.waitForTimeout(6000)
  const shot = (n) => page.screenshot({ path: join(outDir, `${name}-${n}.png`) })
  await page.keyboard.type('speak', { delay: 50 })
  for (const [i, wait] of [600, 400, 400].entries()) { await page.waitForTimeout(wait); await shot(`speak${i}`) }
  await page.waitForTimeout(5000)
  await page.keyboard.type('stars', { delay: 50 })
  let at = 0
  for (const t of [1, 2, 5, 9, 13, 17, 21, 25]) { await page.waitForTimeout((t - at) * 1000); at = t; await shot(`stars${String(t).padStart(2, '0')}`) }
  await page.waitForTimeout(8000)
  await page.keyboard.type('sing', { delay: 50 })
  at = 0
  for (const t of [2, 5, 9]) { await page.waitForTimeout((t - at) * 1000); at = t; await shot(`sing${t}`) }
  report[name] = { problems, sound: await page.evaluate(() => document.querySelector('#sound-toggle').getAttribute('aria-pressed')) }
  await context.close()
}
console.log(JSON.stringify(report, null, 1))
await browser.close()
server.stop()
