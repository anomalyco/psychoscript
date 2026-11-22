// bench-typed-matrix.js with plain arrays.
const count = 10000
const out = new Array(16).fill(0)
const a = new Array(16).fill(0)
const b = new Array(16).fill(0)
for (let i = 0; i < 16; i++) {
  a[i] = (i % 5) * 0.25
  b[i] = (i % 3) - 1
}
const multiply = (out, a, b) => {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = Math.fround(s)
    }
  }
}
let check = 0
for (let i = 0; i < count; i++) {
  b[0] = Math.fround(i * 0.001)
  multiply(out, a, b)
  check += out[0] + out[15]
}
return check
