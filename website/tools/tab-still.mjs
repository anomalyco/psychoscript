// The photograph of the tab that the grey page shows until the lens draws the tab itself (site/art/tab.webp).
// It is taken of the lens's own tab, at rest and at the start of its clock, so the one takes over from the other
// unseen. Run on a browser worker, `bun tab-still.mjs` from tools/, whenever the drawn tab's look changes; it
// writes .preview/tab/lens.png (240 by 240 page pixels round the tab, twice as sharp). Then, from .preview/tab:
//   magick -size 352x352 xc:black -fx "rr=hypot(i-175.5,j-175.5); kk=(168-rr)/36; kk<0?0:(kk>1?1:kk*kk*(3-2*kk))" mask.png
//   magick lens.png -crop 352x352+64+64 +repage mask.png -alpha off -compose CopyOpacity -composite tab.png
//   magick tab.png -quality 86 -define webp:alpha-quality=100 ../../site/art/tab.webp
import { chromium } from 'playwright-core'
import { mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = new URL('../site/', import.meta.url).pathname
const outDir = new URL('../.preview/tab/', import.meta.url).pathname
mkdirSync(outDir, { recursive: true })
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
    if (path === '/liquid.js') {
      // The tab's clock stopped at its start.
      const code = readFileSync(join(root, 'liquid.js'), 'utf8')
      const still = code.replace('let g = lens.beat.x;', 'let g = 0.0;')
      if (still === code) throw new Error("the tab's clock was not found")
      return new Response(still, { headers: { 'Content-Type': 'text/javascript' } })
    }
    const file = Bun.file(join(root, path.endsWith('/') ? `${path}index.html` : path))
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 })
  },
})
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const build = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0]
const exe = ['chrome-mac-arm64', 'chrome-mac']
  .flatMap((arch) => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium'].map((app) => join(cache, build, arch, app)))
  .find(existsSync)
const browser = await chromium.launch({ executablePath: exe, args: ['--mute-audio', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
await page.goto(`http://127.0.0.1:${server.port}/`)
const at = await page.evaluate(() => {
  const r = document.querySelector('button.tab').getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
})
await page.waitForFunction(() => document.documentElement.classList.contains('drawn'), null, { timeout: 30000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${outDir}lens.png`, clip: { x: Math.round(at[0]) - 120, y: Math.round(at[1]) - 120, width: 240, height: 240 } })
console.log('the tab is centred at', at.join(', '), 'and at 120, 120 of the picture, give or take the fraction')
await browser.close()
server.stop()
