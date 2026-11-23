// Films the first four seconds of the grey page, wide and narrow, to .preview/first/: what is seen while the lens
// takes over the drawing of the tab. Run on a browser worker, `bun first-second.mjs` from tools/. Nothing should
// change round the tab (QUERY=?pace has the page pace itself as it does for a visitor); this prints how bright that
// part of each frame is, to check:
//   ffmpeg -i wide.webm -vf "crop=200:200:620:385,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -
import { chromium } from 'playwright-core'
import { mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = new URL('../site/', import.meta.url).pathname
const outDir = new URL('../.preview/first/', import.meta.url).pathname
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
for (const [name, width] of [['wide', 1440], ['narrow', 430]]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width, height: 900 } } })
  const page = await context.newPage()
  await page.goto(base + (process.env.QUERY ?? ''))
  // When the page opened its window on the canvas.
  const opened = await page.evaluate(
    () =>
      new Promise((done) => {
        const t0 = performance.now()
        let at = null
        const tick = () => {
          const now = Math.round(performance.now() - t0)
          if (at === null && document.documentElement.classList.contains('drawn')) at = now
          now < 4000 ? requestAnimationFrame(tick) : done(at)
        }
        tick()
      }),
  )
  const tab = await page.evaluate(() => {
    const r = document.querySelector('button.tab').getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  })
  console.log(name, 'window opened after', opened, 'ms; the tab is at', tab.join(', '))
  const video = page.video()
  await context.close()
  renameSync(await video.path(), `${outDir}${name}.webm`)
}
await browser.close()
server.stop()
