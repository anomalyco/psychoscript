// Builds the title's distance-field textures from a tracing of the poster's
// own hand lettering: `bun trace.mjs ../design/lettering.png`. The tracing is
// white letters on black, one line. The wide title is that line; the narrow
// one is the same letters on two lines, 'script' tucked under 'Psycho'.
// Writes site/art/title-{wide,narrow}.png (see sdf.mjs for what the channels
// hold), title.json, and the still wordmarks shown without WebGPU.
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RANGE, DEEP, distance } from './sdf.mjs'

const SUPER = 3
const LETTERS = 12
const dir = mkdtempSync(join(tmpdir(), 'psy-trace-'))
const art = new URL('../site/art/', import.meta.url).pathname

const gray = (args, w, h) => {
  const raw = execFileSync('magick', [...args, '-depth', '8', 'gray:-'], { maxBuffer: 1 << 30 })
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = raw[i] > 127 ? 1 : 0
  return mask
}
const size = (file) => execFileSync('magick', ['identify', '-format', '%w %h', file]).toString().split(' ').map(Number)
const save = (mask, w, h, file) => {
  const raw = join(dir, 'save.gray')
  writeFileSync(raw, Uint8Array.from(mask, (v) => (v ? 255 : 0)))
  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', `gray:${raw}`, file])
}

// Every separate white shape: its pixels' label, and its box and weight.
function shapes(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1)
  const found = []
  const stack = new Int32Array(w * h)
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start] >= 0) continue
    const id = found.length
    const shape = { id, area: 0, x0: w, y0: h, x1: 0, y1: 0, sumX: 0 }
    let top = 0
    stack[top++] = start
    label[start] = id
    while (top) {
      const at = stack[--top]
      const x = at % w
      const y = (at - x) / w
      shape.area++
      shape.sumX += x
      if (x < shape.x0) shape.x0 = x
      if (x > shape.x1) shape.x1 = x
      if (y < shape.y0) shape.y0 = y
      if (y > shape.y1) shape.y1 = y
      for (const next of [at - 1, at + 1, at - w, at + w]) {
        if (next < 0 || next >= w * h || !mask[next] || label[next] >= 0) continue
        if ((next === at - 1 && x === 0) || (next === at + 1 && x === w - 1)) continue
        label[next] = id
        stack[top++] = next
      }
    }
    found.push(shape)
  }
  return { label, found }
}

// The letters among the shapes, left to right, each pixel marked with its letter.
// A small shape over a letter (the dot of the i) belongs to that letter.
function letters(mask, w, h) {
  const { label, found } = shapes(mask, w, h)
  const tall = Math.max(...found.map((s) => s.y1 - s.y0))
  const big = found.filter((s) => s.y1 - s.y0 > tall * 0.3).sort((a, b) => a.sumX / a.area - b.sumX / b.area)
  const top = Math.min(...big.map((s) => s.y0))
  const bottom = Math.max(...big.map((s) => s.y1))
  const owner = new Int32Array(found.length).fill(-1)
  big.forEach((s, i) => (owner[s.id] = i))
  for (const s of found) {
    if (owner[s.id] >= 0 || s.area < tall * tall * 0.004 || s.y1 > top + (bottom - top) * 0.45) continue
    const over = big.map((b, i) => [Math.min(s.x1, b.x1) - Math.max(s.x0, b.x0), i]).sort((a, b) => b[0] - a[0])[0]
    if (over[0] > 0) owner[s.id] = over[1]
  }
  const which = new Int8Array(w * h).fill(-1)
  for (let i = 0; i < w * h; i++) if (label[i] >= 0) which[i] = owner[label[i]]
  return { which, count: big.length }
}

function box(which, w, h, pick) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (which[y * w + x] >= 0 && pick(which[y * w + x])) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return [x0, y0, x1 + 1, y1 + 1]
}

function signed(mask, w, h, texW, texH) {
  const toOutside = distance(mask, w, h, 0)
  const toInside = distance(mask, w, h, 1)
  const out = new Float32Array(texW * texH)
  for (let y = 0; y < texH; y++)
    for (let x = 0; x < texW; x++) {
      let sum = 0
      for (let j = 0; j < SUPER; j++)
        for (let i = 0; i < SUPER; i++) {
          const at = (y * SUPER + j) * w + x * SUPER + i
          sum += mask[at] ? toOutside[at] - 0.5 : 0.5 - toInside[at]
        }
      out[y * texW + x] = sum / (SUPER * SUPER * SUPER)
    }
  return out
}

// A clean drawing of only the letters (file, with the letters' box in it) becomes a texture texW wide.
function texture(file, name, texW, still) {
  const line = 7
  const grow = 34 // the black shape reaches this many texels past the letters
  const shadow = [9, 14]
  const margin = grow + RANGE + 4
  const [w0, h0] = size(file)
  const inner = texW - 2 * margin - shadow[0]
  const lettersH = Math.round((inner * h0) / w0)
  const texH = lettersH + 2 * margin + shadow[1]
  const w = texW * SUPER
  const h = texH * SUPER
  const mask = gray(
    [file, '-colorspace', 'Gray', '-filter', 'Lanczos', '-resize', `${inner * SUPER}x${lettersH * SUPER}!`, '-blur', '0x2.2', '-background', 'black', '-gravity', 'NorthWest', '-splice', `${margin * SUPER}x${margin * SUPER}`, '-extent', `${w}x${h}`],
    w,
    h,
  )
  const { which, count } = letters(mask, w, h)
  if (count !== LETTERS) throw new Error(`${name}: found ${count} letters, not ${LETTERS}`)
  const only = (pick) => Uint8Array.from(which, (v) => (v >= 0 && pick(v) ? 1 : 0))
  const even = signed(only((i) => i % 2 === 0), w, h, texW, texH)
  const odd = signed(only((i) => i % 2 === 1), w, h, texW, texH)
  const all = signed(only(() => true), w, h, texW, texH)
  const rgba = new Uint8Array(texW * texH * 4)
  const picture = new Uint8Array(texW * texH * 4)
  const pack = (sd) => Math.max(0, Math.min(255, Math.round((0.5 + sd / (2 * RANGE)) * 255)))
  const cover = (sd) => Math.max(0, Math.min(1, sd + 0.5))
  for (let i = 0; i < texW * texH; i++) {
    rgba[i * 4] = pack(even[i])
    rgba[i * 4 + 1] = pack(odd[i])
    rgba[i * 4 + 2] = pack(all[i] + grow)
    const depth = odd[i] > 0 ? odd[i] : even[i]
    rgba[i * 4 + 3] = 1 + Math.round(254 * Math.max(0, Math.min(1, depth / DEEP)))
    // The still: orange letters, redder toward the top, on the black shape.
    const y = Math.floor(i / texW) / texH
    const ink = cover(Math.max(even[i], odd[i]) + 0)
    const fill = [238 + 10 * y, 74 + 90 * y, 31 + 5 * y]
    const blob = cover(all[i] + grow)
    for (let c = 0; c < 3; c++) picture[i * 4 + c] = Math.round(fill[c] * ink + [29, 22, 20][c] * (1 - ink))
    picture[i * 4 + 3] = Math.round(255 * blob)
  }
  const write = (data, to, extra = []) => {
    const raw = join(dir, 'out.rgba')
    writeFileSync(raw, data)
    execFileSync('magick', ['-size', `${texW}x${texH}`, '-depth', '8', `rgba:${raw}`, ...extra, '-define', 'png:color-type=6', '-define', 'png:compression-level=9', to])
  }
  write(rgba, join(art, `title-${name}.png`))
  write(picture, join(art, still), ['-resize', '75%'])
  return { src: `art/title-${name}.png`, width: texW, height: texH, range: RANGE, deep: DEEP, line, shadow }
}

const source = process.argv[2]
const [w, h] = size(source)
const first = letters(gray([source, '-colorspace', 'Gray'], w, h), w, h)
if (first.count !== LETTERS) throw new Error(`found ${first.count} letters in the tracing, not ${LETTERS}`)

// One line: only the letters, cropped to their box.
const whole = box(first.which, w, h, () => true)
const crop = (pick, [x0, y0, x1, y1], file) => {
  const cw = x1 - x0
  const ch = y1 - y0
  const out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = first.which[(y + y0) * w + x + x0] >= 0 && pick(first.which[(y + y0) * w + x + x0]) ? 1 : 0
  save(out, cw, ch, file)
  return { mask: out, w: cw, h: ch }
}
crop(() => true, whole, join(dir, 'line.png'))

// Two lines: the second slides under the first as far up as it will go.
const one = box(first.which, w, h, (i) => i < 6)
const two = box(first.which, w, h, (i) => i >= 6)
const upper = crop((i) => i < 6, one, join(dir, 'upper.png'))
const lower = crop((i) => i >= 6, two, join(dir, 'lower.png'))
const gap = Math.round(h * 0.035)
const under = new Int32Array(upper.w).fill(-1) // the lowest white pixel of the upper line in each column
for (let x = 0; x < upper.w; x++) for (let y = upper.h - 1; y >= 0; y--) if (upper.mask[y * upper.w + x]) { under[x] = y; break }
const over = new Int32Array(lower.w).fill(lower.h)
for (let x = 0; x < lower.w; x++) for (let y = 0; y < lower.h; y++) if (lower.mask[y * lower.w + x]) { over[x] = y; break }
let best = { dy: Infinity, dx: 0 }
for (let dx = -Math.round(lower.w * 0.1); dx <= upper.w - lower.w * 0.75; dx += 4) {
  let dy = 0
  for (let x = 0; x < lower.w; x++) {
    for (let near = -gap; near <= gap; near += gap) {
      const above = x + dx + near
      if (above < 0 || above >= upper.w || under[above] < 0) continue
      dy = Math.max(dy, under[above] + gap - over[x])
    }
  }
  const wide = Math.max(upper.w, dx + lower.w) - Math.min(0, dx)
  const score = dy + lower.h + 0.35 * (wide - upper.w)
  if (score < best.score || best.dy === Infinity) best = { dy, dx, score }
}
const left = Math.min(0, best.dx)
const stackW = Math.max(upper.w, best.dx + lower.w) - left
const stackH = Math.max(upper.h, best.dy + lower.h)
execFileSync('magick', ['-size', `${stackW}x${stackH}`, 'xc:black', join(dir, 'upper.png'), '-geometry', `+${-left}+0`, '-compose', 'Lighten', '-composite', join(dir, 'lower.png'), '-geometry', `+${best.dx - left}+${best.dy}`, '-compose', 'Lighten', '-composite', join(dir, 'stack.png')])

const facts = {
  wide: texture(join(dir, 'line.png'), 'wide', 1536, 'wordmark.png'),
  narrow: texture(join(dir, 'stack.png'), 'narrow', 1024, 'wordmark-stacked.png'),
}
writeFileSync(join(art, 'title.json'), JSON.stringify(facts, null, 2) + '\n')
rmSync(dir, { recursive: true })
console.log(JSON.stringify(facts))
