// What the title's distance-field textures hold, and the distance transform
// trace.mjs builds them with.
// Red: even letters, green: odd letters (neighbours never share a channel, so
// each letter keeps its own outline), blue: the black shape behind them all.
// Each channel is 0.5 on its edge and spans RANGE texels either side.
// Alpha: how deep inside its letter a point is, 0 at the edge to 1 at DEEP texels in.
export const RANGE = 10
export const DEEP = 40

// Squared distance to the nearest zero of f along one line (Felzenszwalb and Huttenlocher).
function pass(f, n, d, v, z) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s
    do {
      const p = v[k]
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
    } while (s <= z[k] && --k >= 0)
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const p = v[k]
    d[q] = (q - p) * (q - p) + f[p]
  }
}

// Distance from every pixel to the nearest pixel where mask is `target`.
export function distance(mask, w, h, target) {
  const INF = 1e12
  const grid = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] === target ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    pass(f, h, d, v, z)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    pass(f, w, d, v, z)
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x])
  }
  return grid
}
