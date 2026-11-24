// bench-typed-fill.js with a plain array.
const n = 100000
const a = new Array(n).fill(0)
let sum = 0
for (let round = 0; round < 10; round++) {
  for (let i = 0; i < n; i++) a[i] = Math.fround(i * 0.5 + round)
  for (let i = 0; i < n; i++) sum += a[i]
}
return sum
