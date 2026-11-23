// @typed_arrays true
// Indexed reads and writes at the edges: out of range, negative, -0, past 2^31, strings, and values that are not
// numbers yet.
const f = new Float32Array(3)
const i = new Int32Array(2)
f[-1] = 5
f[3] = 5
f[2 ** 31] = 5
f[-0] = 1.5
f["1"] = "2.25"
f[2] = true
i[0] = "7"
i[1] = null
const reads = [f[0], f[1], f[2], f[3], f[-1], f[2 ** 31], f[-0], f["2"], f[NaN], i[0], i[1], i[2]]
let sum = 0
for (let k = 0; k < 5; k++) sum += f[k] === undefined ? 100 : f[k]
const big = new Float64Array(4)
for (let k = 0; k < 4; k++) big[k] = k / 3
let acc = 0
for (let k = 0; k < 4; k++) acc += big[k]
return [reads, sum, acc, Object.keys(f), f.length]
