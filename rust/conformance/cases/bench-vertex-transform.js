// @typed_arrays true
// Transforms 1k vertices by a per-frame rotation matrix into an output Float32Array, for 60 frames.
const n = 1000
const positions = new Float32Array(n * 3)
for (let i = 0; i < n; i++) {
  positions[i * 3] = Math.cos(i)
  positions[i * 3 + 1] = Math.sin(i)
  positions[i * 3 + 2] = i / n
}
const out = new Float32Array(n * 3)
const m = new Float32Array(16)
let check = 0
for (let frame = 0; frame < 60; frame++) {
  const t = frame / 60
  const c = Math.cos(t)
  const s = Math.sin(t)
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c; m[10] = 1; m[15] = 1; m[14] = -t
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    out[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]
    out[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
    out[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
  }
  check += out[0] + out[n * 3 - 1]
}
return check
