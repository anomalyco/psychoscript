// @limits {"max_heap_bytes": 262144}
// A finished async function's call keeps nothing reachable: 20,000 calls of each kind fit in 256 KB.
const N = 20000
let resolveNext = null
const frame = async () => new Promise((r) => { resolveNext = r })
const value = async (i) => i
const throws = async (i) => { await null; throw new Error("x" + i) }
const cleans = async (i) => { try { await null; return i } finally { await null } }
let a = 0, b = 0, c = 0, d = 0
while (a < N) { const p = frame(); resolveNext(a); await p; a++ }
while (b < N) { await value(b); b++ }
while (c < N) { try { await throws(c) } catch (e) {} c++ }
while (d < N) { await Promise.all([value(d), cleans(d)]); d++ }
return [a, b, c, d]
