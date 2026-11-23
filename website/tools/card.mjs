// The link preview: photographs the page itself at 1200x630, twice as sharp, a few moments into the show, and
// writes the candidates to .preview/card. Run on a browser worker: `bun card.mjs [seconds ...]` from tools/.
// The one that is kept is made into site/art/card.jpg with
// `magick .preview/card/<seconds>.png -resize 1200x630 -quality 88 site/art/card.jpg`.
import { chromium } from 'playwright-core'
import { mkdirSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../site/', import.meta.url).pathname
const outDir = new URL('../.preview/card/', import.meta.url).pathname
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
function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds)
    for (const arch of ['chrome-mac-arm64', 'chrome-mac'])
      for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
        const path = join(cache, build, arch, app)
        if (existsSync(path)) return path
      }
  throw new Error('no Chromium build found')
}
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--mute-audio', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'],
})
const times = process.argv.slice(2).map(Number)
const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })
const page = await context.newPage()
await page.goto(`http://127.0.0.1:${server.port}/?awake`, { waitUntil: 'networkidle' })
await page.addStyleTag({ content: '.sigils { display: none !important }' })
await page.waitForFunction(() => document.querySelector('canvas.liquid')?.classList.contains('is-live'), null, { timeout: 30000 })
const began = Date.now()
for (const seconds of times.length ? times : [4, 7, 10, 14, 18, 23]) {
  await page.waitForTimeout(Math.max(0, seconds * 1000 - (Date.now() - began)))
  await page.screenshot({ path: `${outDir}${seconds}.png` })
  console.log('took', seconds)
}
await browser.close()
server.stop()
