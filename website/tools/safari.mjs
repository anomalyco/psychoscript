// Checks the page in real Safari through safaridriver: `bun safari.mjs [url]` from tools/, on a Mac with a
// desktop session and Develop > Allow Remote Automation on. Reports whether the picture came up, how long that
// took, what the shaders' compilers said, frames a second, and writes screenshots to .preview/safari. PACE=1 has
// the page pace itself as it does for a visitor (driven, it otherwise keeps its sharpness) and reports what it decided.
import { mkdirSync, writeFileSync } from 'node:fs'

const url = process.argv[2] ?? 'https://psychoscript.pages.dev/'
const out = new URL('../.preview/safari/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const port = 4477
const driver = Bun.spawn(['/usr/bin/safaridriver', '-p', String(port)], { stdout: 'ignore', stderr: 'ignore' })
const call = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const json = await response.json()
  if (json.value?.error) throw new Error(`${path}: ${json.value.error}: ${json.value.message}`)
  return json.value
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${port}/status`)
    break
  } catch {
    await wait(250)
  }
}
const report = {}
let session
try {
  session = (await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId
  const at = `/session/${session}`
  const run = (script, args = []) => call('POST', `${at}/execute/sync`, { script, args })
  const later = (script, args = []) => call('POST', `${at}/execute/async`, { script, args })
  const shot = async (name) => writeFileSync(`${out}${name}.png`, Buffer.from(await call('GET', `${at}/screenshot`), 'base64'))
  await call('POST', `${at}/timeouts`, { script: 120000, pageLoad: 60000 })
  report.browser = await run('return navigator.userAgent')

  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 430, 900]]) {
    await call('POST', `${at}/window/rect`, { x: 40, y: 40, width, height })
    const began = Date.now()
    await call('POST', `${at}/url`, { url: `${url}?awake${process.env.PACE ? '&pace' : ''}` })
    const result = { gpu: await run('return Boolean(navigator.gpu)') }
    for (let i = 0; i < 120 && !result.live; i++) {
      await wait(250)
      result.live = await run(`return Boolean(document.querySelector('canvas.liquid')?.classList.contains('is-live'))`)
    }
    result.liveAfter = Date.now() - began
    await wait(6000)
    await shot(name)
    // Frames a second over four seconds, and the longest gap between two of them.
    result.frames = await later(`
      const done = arguments[arguments.length - 1]
      let n = 0, worst = 0, last = performance.now()
      const t0 = last
      const tick = (now) => { n++; worst = Math.max(worst, now - last); last = now; now - t0 < 4000 ? requestAnimationFrame(tick) : done({ fps: Math.round(n / 4), worst: Math.round(worst) }) }
      requestAnimationFrame(tick)`)
    const canvas = await run(`const c = document.querySelector('canvas.liquid'); return [c.width, c.height, devicePixelRatio, innerWidth, innerHeight]`)
    result.canvas = canvas
    result.pace = await run(`return document.querySelector('canvas.liquid').dataset.pace ?? null`)
    await wait(14000)
    await shot(`${name}-later`)
    report[name] = result
  }

  // What Safari's compiler says of each shader.
  report.shaders = await later(`
    const done = arguments[arguments.length - 1]
    ;(async () => {
      try {
        const m = await import('/liquid.js')
        const adapter = await navigator.gpu.requestAdapter()
        const device = await adapter.requestDevice()
        const said = {}
        for (const name of ['shader', 'simShader', 'glowShader']) {
          if (!m[name]) { said[name] = 'not exported'; continue }
          const info = await device.createShaderModule({ code: m[name] }).getCompilationInfo()
          said[name] = info.messages.slice(0, 8).map((x) => x.type + ' ' + x.lineNum + ':' + x.linePos + ' ' + x.message)
        }
        said.features = [...adapter.features].join(' ')
        done(said)
      } catch (error) { done({ failed: String(error) }) }
    })()`)

  // The grey page: take the tab, and see the picture come.
  await call('POST', `${at}/window/rect`, { x: 40, y: 40, width: 1440, height: 900 })
  await call('POST', `${at}/url`, { url: `${url}${process.env.PACE ? '?pace' : ''}` })
  await wait(2500)
  await shot('front')
  await run(`document.querySelector('button.tab').click()`)
  await wait(2200)
  await shot('front-melting')
  await wait(4500)
  await shot('front-after')
  report.frontPace = await run(`return document.querySelector('canvas.liquid').dataset.pace ?? null`)
  report.front = { trip: await run('return document.documentElement.dataset.trip'), live: await run(`return Boolean(document.querySelector('canvas.liquid')?.classList.contains('is-live'))`) }
} catch (error) {
  report.failed = String(error)
} finally {
  if (session) await call('DELETE', `/session/${session}`).catch(() => {})
  driver.kill()
}
writeFileSync(`${out}report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
