// @typed_arrays true
// 10k 4x4 matrix multiplies, each matrix a Float32Array(16), column-major as WebGPU takes them.
const count = 10000
const out = new Float32Array(16)
const a = new Float32Array(16)
const b = new Float32Array(16)
for (let i = 0; i < 16; i++) {
  a[i] = (i % 5) * 0.25
  b[i] = (i % 3) - 1
}
const multiply = (out, a, b) => {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = s
    }
  }
}
let check = 0
for (let i = 0; i < count; i++) {
  b[0] = i * 0.001
  multiply(out, a, b)
  check += out[0] + out[15]
}
return check
