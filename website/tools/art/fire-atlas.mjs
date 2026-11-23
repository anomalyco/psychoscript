// fire-atlas.mjs <SmallFlame01_16x4.tga> <CandleSmoke01_20x4.tga> <out.png>
// Packs two CC0 Unity Labs flipbooks (see SOURCES.md) into site/art/fire.png:
// an 8x8 grid of 80x160 cells, red the flame's heat and green the smoke's density,
// both stored as square roots so the faint edges keep their steps. Each sequence
// loops: the flame's 60 frames already do (its last is as close to its first as
// any two neighbours); the smoke keeps 64 of its 80, its first 16 cross-faded from
// the frames after its end. Values fade out over the last pixels at a cell's sides
// and top, so frames whose fire touched the edge of their tile show no cut.
// Needs ImageMagick (magick) on the path. Run with bun or node.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

const [flamePath, smokePath, out] = process.argv.slice(2)
const CW = 80, CH = 160, COLS = 8, ROWS = 8

// size [w, h] resamples the sheet first, so that frames are whole pixels.
const load = (path, [w, h]) => {
  const raw = `${out}.tmp.rgba`
  execFileSync('magick', [path, '-resize', `${w}x${h}!`, '-depth', '8', `rgba:${raw}`])
  const data = readFileSync(raw); rmSync(raw)
  return { w, h, data }
}

// One value a pixel for every frame of a sheet, cut to the box all its frames share.
// With pitch set, a row's frames are not on its grid (the flame sheet's sit about
// 134 px apart on a 128 px grid), so each is found as a run of lit columns between
// empty ones and cut pitch wide around its own middle.
function frames(sheet, cols, rows, value, pitch = 0) {
  const fh = sheet.h / rows, fw = pitch || sheet.w / cols, list = []
  const read = (x, y) => {
    if (x < 0 || x >= sheet.w) return 0
    const i = (y * sheet.w + x) * 4, d = sheet.data
    return value(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255)
  }
  for (let r = 0; r < rows; r++) {
    let starts = []
    if (pitch) {
      const lit = []
      for (let x = 0; x < sheet.w; x++) { let sum = 0; for (let y = 0; y < fh; y++) sum += read(x, r * fh + y); lit.push(sum) }
      for (let x = 0; x < sheet.w;) {
        if (lit[x] < 0.05) { x++; continue }
        let end = x, mass = 0, moment = 0
        while (end < sheet.w && (lit[end] >= 0.05 || lit.slice(end, end + 6).some((v) => v >= 0.05))) { mass += lit[end]; moment += lit[end] * end; end++ }
        if (mass > 20) starts.push(Math.round(moment / mass - fw / 2))
        x = end
      }
    } else starts = [...Array(cols)].map((_, c) => c * fw)
    for (const x0 of starts) {
      const f = new Float32Array(fw * fh)
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) f[y * fw + x] = read(x0 + x, r * fh + y)
      list.push(f)
    }
  }
  let x0 = fw, y0 = fh, x1 = 0, y1 = 0
  for (const f of list) for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) if (f[y * fw + x] > 0.01) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { list, fw, fh, box: [x0, y0, x1, y1] }
}

// Resample a frame's box into a cell, the box's bottom on the cell's bottom and centred across.
function fit({ fw, fh, box }, f, margin) {
  const [x0, y0, x1, y1] = box, bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const s = Math.min((CW - 2 * margin) / bw, (CH - 2 * margin) / bh)
  const cell = new Float32Array(CW * CH)
  const cx = (x0 + x1 + 1) / 2
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const sx = cx + (x + 0.5 - CW / 2) / s - 0.5, sy = y1 + 1 - (CH - margin - y - 0.5) / s - 0.5
    const ix = Math.floor(sx), iy = Math.floor(sy), tx = sx - ix, ty = sy - iy
    const at = (u, v) => (u < 0 || v < 0 || u >= fw || v >= fh ? 0 : f[v * fw + u])
    const edge = Math.min(1, (x + 0.5) / 8, (CW - x - 0.5) / 8, (y + 0.5) / 8)
    cell[y * CW + x] = edge * edge * (3 - 2 * edge) * (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty
  }
  return { cell, scale: s, foot: margin }
}

// n looping frames from n + blend source frames: the first `blend` fade in from the ones past the end.
const loop = (list, n, blend) => list.slice(0, n).map((f, i) => {
  if (i >= blend) return f
  const k = (i + 0.5) / blend, g = list[i + n], o = new Float32Array(f.length)
  for (let j = 0; j < f.length; j++) o[j] = f[j] * k + g[j] * (1 - k)
  return o
})

const flame = frames(load(flamePath, [2048, 1024]), 16, 4, (r, g, b, a) => a * (0.3 * r + 0.7 * g), 136)
const smoke = frames(load(smokePath, [1040, 512]), 20, 4, (r, g, b, a) => a)
const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length
const step = flame.list.slice(1).map((f, i) => diff(f, flame.list[i]))
console.log(`${flame.list.length} flame frames; frame to frame ${(step.reduce((a, b) => a + b) / step.length).toFixed(4)}, last to first ${diff(flame.list.at(-1), flame.list[0]).toFixed(4)}`)
const flames = flame.list.map((f) => fit(flame, f, 3))
const smokes = loop(smoke.list, 64, 16).map((f) => fit(smoke, f, 3))

const W = CW * COLS, H = CH * ROWS, rgb = Buffer.alloc(W * H * 3)
const put = (cells, channel) => cells.forEach(({ cell }, n) => {
  const ox = (n % COLS) * CW, oy = Math.floor(n / COLS) * CH
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++)
    rgb[((oy + y) * W + ox + x) * 3 + channel] = Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, cell[y * CW + x]))))
})
put(flames, 0); put(smokes, 1)
writeFileSync(`${out}.tmp.rgb`, rgb)
execFileSync('magick', ['-size', `${W}x${H}`, '-depth', '8', `rgb:${out}.tmp.rgb`, '-define', 'png:compression-level=9', out])
rmSync(`${out}.tmp.rgb`)
console.log(`wrote ${out} ${W}x${H}; flame box ${flame.box} scale ${flames[0].scale.toFixed(3)}, smoke box ${smoke.box} scale ${smokes[0].scale.toFixed(3)}`)
