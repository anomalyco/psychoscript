// bun tools/sound-test.mjs [path/to/choir.wav]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const { Choir } = await import(process.env.CHOIR_MODULE || '../site/voice.worklet.js')
const rate = 48000, seconds = 72, frames = seconds * rate, n = 4096
const db = x => 20 * Math.log10(Math.max(1e-12, x))
const fmt = x => +x.toFixed(2)

function spectrum(signal, window = true) {
  const re = new Float64Array(n), im = new Float64Array(n)
  for (let i = 0, j = 0; i < n; i++) {
    re[j] = signal[i] * (window ? .5 - .5 * Math.cos(2 * Math.PI * i / n) : 1)
    let bit = n >> 1
    while (j & bit) { j ^= bit; bit >>= 1 }
    j ^= bit
  }
  for (let step = 2; step <= n; step <<= 1) {
    for (let j = 0; j < step / 2; j++) {
      const theta = -2 * Math.PI * j / step, cos = Math.cos(theta), sin = Math.sin(theta)
      for (let i = j; i < n; i += step) {
        const k = i + step / 2
        const a = re[k] * cos - im[k] * sin, b = im[k] * cos + re[k] * sin
        re[k] = re[i] - a; im[k] = im[i] - b; re[i] += a; im[i] += b
      }
    }
  }
  return re.slice(0, n / 2).map((r, i) => r * r + im[i] * im[i])
}

function formants(vowel) {
  const choir = new Choir(rate, 7919); choir.control()
  const s = choir.singers[0]; s.volume = s.inhale = s.focus = s.step = 0
  s.shape(vowel, 0, 0); s.r[0] = 1
  const transfer = spectrum(Float32Array.from({length: n}, () => s.sample()), false)
  const peaks = []
  for (let j = 2; j < n * 4000 / rate; j++) {
    if (transfer[j] >= transfer[j - 1] && transfer[j] > transfer[j + 1]) peaks.push(Math.round(j * rate / n))
  }
  return peaks.slice(0, 3)
}

const choir = new Choir(rate, 17117), left = new Float32Array(frames), right = new Float32Array(frames)
const start = performance.now()
for (let i = 0; i < frames; i += 128) {
  const t = i / rate
  if (i % 2048 === 0) {
    const storm = t >= 19 && t < 40, night = t >= 42 && t < 66
    choir.state({rain: +storm, night: +night, moon: night, maw: +(t >= 29 && t < 35),
      tears: +(t >= 15 && t < 37), blood: +(t >= 25 && t < 38), water: +(t >= 20 && t < 43)})
  }
  if (i % (rate * 8) === 0) choir.event(i % (rate * 16) ? 'built' : 'flower', i % (rate * 16) ? -.88 : .76)
  choir.render(left.subarray(i, i + 128), right.subarray(i, i + 128))
}
const wall = (performance.now() - start) / 1000
let peak = 0, energy = 0, nonFinite = 0
for (const channel of [left, right]) for (const x of channel) {
  if (!Number.isFinite(x)) nonFinite++
  energy += x * x; peak = Math.max(peak, Math.abs(x))
}
const rms = db(Math.sqrt(energy / (2 * frames)))
const f = [0, 1, 2, 3].map(formants), bands = [0, 0, 0, 0, 0], edges = [40, 250, 1200, 4000]
for (let i = 0; i < frames - n; i += rate / 2) {
  for (const channel of [left, right]) {
    const bins = spectrum(channel.subarray(i, i + n))
    for (let j = 0, b = 0; j < bins.length; j++) {
      if (j * rate / n >= edges[b]) b++
      bands[b] += bins[j]
    }
  }
}
const total = bands.reduce((a, b) => a + b, 0), percentages = bands.map(x => fmt(100 * x / total))
console.log(JSON.stringify({seconds, rate, nonFinite, peakDBFS: fmt(db(peak)), rmsDBFS: fmt(rms),
  wallSeconds: fmt(wall), realTimeFactor: fmt(seconds / wall), bandEdgesHz: edges, bandEnergyPercent: percentages,
  tractResonancesHz: {oo: f[0], oh: f[1], ah: f[2], ee: f[3]}}, null, 2))

if (process.argv[2]) {
  const data = Buffer.alloc(44 + frames * 4)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22)
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32)
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(left[i] * 32767), 44 + 4 * i)
    data.writeInt16LE(Math.round(right[i] * 32767), 46 + 4 * i)
  }
  await mkdir(dirname(resolve(process.argv[2])), {recursive: true}); await writeFile(process.argv[2], data)
}
assert.equal(nonFinite, 0); assert(db(peak) < -1, 'peak ceiling'); assert(rms >= -22 && rms <= -16, 'choir level')
assert(seconds / wall >= 4, 'render budget'); assert(percentages[1] > 4 && percentages[2] > 4 && percentages[4] < 3, 'dark vocal bands')
assert(f[2][0] - f[0][0] > 120 && f[3][1] - f[0][1] > 300, 'vowels must move actual tract resonances')
