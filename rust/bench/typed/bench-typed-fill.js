// @typed_arrays true
// Fills a 100k-float Float32Array in script, ten times, and sums it back.
const n = 100000
const a = new Float32Array(n)
let sum = 0
for (let round = 0; round < 10; round++) {
  for (let i = 0; i < n; i++) a[i] = i * 0.5 + round
  for (let i = 0; i < n; i++) sum += a[i]
}
return sum
