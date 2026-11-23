// startup.mjs: what starting the picture costs a browser. Loads the page in a fresh headless Chromium (RUNS times,
// 3 by default), and for each run prints how long every pipeline took to make, when the picture came up, the most
// memory the browser's GPU process and the page's own process held, and how frames ran for the first SECONDS (20).
// Run on a browser worker from tools/: `bun perf/startup.mjs` (BASE=https://… for a deployed copy, QUERY=?awake).
import { chromium } from 'playwright-core'
import { readdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = new URL('../../site/', import.meta.url).pathname
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
const query = process.env.QUERY ?? '?awake&pace'
const seconds = Number(process.env.SECONDS ?? 20)
const [width, height, scale] = (process.env.SIZE ?? '1440x900x2').split('x').map(Number)
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const build = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0]
const exe = ['chrome-mac-arm64', 'chrome-mac']
  .flatMap((arch) => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium'].map((app) => join(cache, build, arch, app)))
  .find(existsSync)
// The memory of every browser process of one kind, in megabytes.
const memory = () => {
  const out = Bun.spawnSync(['ps', '-axo', 'rss=,command=']).stdout.toString()
  let gpu = 0, page = 0
  for (const line of out.split('\n')) {
    if (!/Chrome for Testing|Chromium/.test(line)) continue
    const rss = Number(line.trim().split(/\s+/)[0]) / 1024
    if (line.includes('--type=gpu-process')) gpu += rss
    else if (line.includes('--type=renderer')) page = Math.max(page, rss)
  }
  return { gpu, page }
}
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const all = []
// COLD=1 throws away the test browser's compiled shaders before each run (macOS keeps them for it between runs),
// so that pipelines are made from nothing, as on a first visit.
const metal = join(Bun.spawnSync(['getconf', 'DARWIN_USER_CACHE_DIR']).stdout.toString().trim(), 'com.google.chrome.for.testing.helper')
for (let run = 0; run < Number(process.env.RUNS ?? 3); run++) {
  if (process.env.COLD) rmSync(metal, { recursive: true, force: true })
  const browser = await chromium.launch({ executablePath: exe, args: ['--mute-audio', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] })
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  const page = await context.newPage()
  const problems = []
  const said = []
  page.on('console', (m) => (['error', 'warning'].includes(m.type()) ? problems.push(m.text().slice(0, 200)) : m.text().startsWith('pace:') && said.push(m.text().slice(6))))
  page.on('pageerror', (e) => problems.push(e.message.slice(0, 200)))
  page.on('crash', () => problems.push('the page crashed'))
  await page.addInitScript(() => {
    const t0 = performance.now()
    const log = (window.__start = { pipes: [], modules: [], frames: [], live: null, lost: null, open: 0, allDone: null })
    if (!navigator.gpu) return
    const sizes = new WeakMap()
    const make = GPUDevice.prototype.createShaderModule
    GPUDevice.prototype.createShaderModule = function (d) {
      const m = make.call(this, d)
      sizes.set(m, d.code.length)
      log.modules.push(d.code.length)
      return m
    }
    for (const name of ['createRenderPipelineAsync', 'createRenderPipeline']) {
      const was = GPUDevice.prototype[name]
      GPUDevice.prototype[name] = function (d) {
        const began = performance.now()
        const entry = { name: d.fragment?.entryPoint, code: sizes.get(d.fragment?.module), from: Math.round(began - t0), sync: name === 'createRenderPipeline' }
        log.pipes.push(entry)
        const made = was.call(this, d)
        if (made?.then) {
          log.open++
          made.then(() => { entry.took = Math.round(performance.now() - began); if (--log.open === 0) log.allDone = Math.round(performance.now() - t0) }, () => { entry.failed = true; log.open-- })
        } else entry.took = Math.round(performance.now() - began)
        return made
      }
    }
    const lose = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function (...a) {
      const device = await lose.apply(this, a)
      device?.lost.then((info) => (log.lost = `${info.reason}: ${info.message}`))
      return device
    }
    let last = 0
    const tick = (now) => {
      if (last) log.frames.push(now - last)
      last = now
      if (!log.live && document.querySelector('canvas.liquid')?.classList.contains('is-live')) log.live = Math.round(now - t0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  let peak = { gpu: 0, page: 0 }
  const watch = setInterval(() => { const m = memory(); peak = { gpu: Math.max(peak.gpu, m.gpu), page: Math.max(peak.page, m.page) } }, 150)
  await page.goto(base + query).catch((e) => problems.push(e.message.slice(0, 200)))
  if (process.env.SOUND) await page.locator('#sound-toggle').click({ timeout: 15000 }).catch((e) => problems.push(e.message.slice(0, 120)))
  // Every twenty seconds: megabytes held by the GPU process, the page's process, and the page's own script.
  const timeline = []
  for (let t = 0; t < seconds; t += 20) {
    await page.waitForTimeout(Math.min(20, seconds - t) * 1000)
    const m = memory()
    const heap = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)).catch(() => -1)
    timeline.push(`${Math.min(seconds, t + 20)}s gpu ${Math.round(m.gpu)} page ${Math.round(m.page)} heap ${heap}`)
  }
  const log = await page.evaluate(() => ({ ...window.__start, canvas: [document.querySelector('canvas.liquid')?.width, document.querySelector('canvas.liquid')?.height], isLive: document.querySelector('canvas.liquid')?.classList.contains('is-live') })).catch((e) => ({ dead: e.message.slice(0, 200) }))
  clearInterval(watch)
  const settled = memory()
  await browser.close()
  const frames = log.frames ?? []
  const late = frames.slice(Math.floor(frames.length / 2))
  const result = {
    run,
    live: log.live,
    allPipelines: log.allDone,
    pipelines: (log.pipes ?? []).filter((p) => (p.code ?? 0) > 100000).map((p) => `${p.name} ${Math.round(p.code / 1000)}k from ${p.from} took ${p.took}`),
    smallPipelines: (log.pipes ?? []).filter((p) => (p.code ?? 0) <= 100000).reduce((most, p) => Math.max(most, p.took ?? 0), 0),
    gpuPeakMB: Math.round(peak.gpu),
    gpuSettledMB: Math.round(settled.gpu),
    pagePeakMB: Math.round(peak.page),
    frames: frames.length,
    longest: Math.round(Math.max(0, ...frames)),
    over50: frames.filter((f) => f > 50).length,
    over100: frames.filter((f) => f > 100).length,
    medianLate: Number(median(late.length ? late : [0]).toFixed(1)),
    canvas: log.canvas,
    lost: log.lost,
    pace: said.length > 12 ? [...said.slice(0, 8), `… ${said.length - 12} more …`, ...said.slice(-4)] : said,
    isLive: log.isLive,
    memory: seconds > 20 ? timeline : undefined,
    problems,
    dead: log.dead,
  }
  all.push(result)
  console.log(JSON.stringify(result))
}
const pick = (key) => median(all.map((r) => r[key] ?? 0))
for (const key of ['live', 'allPipelines', 'gpuPeakMB', 'pagePeakMB', 'longest', 'over50', 'medianLate']) console.log(`METRIC ${key}=${pick(key)}`)
server.stop()
