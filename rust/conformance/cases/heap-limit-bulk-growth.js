// @limits {"max_heap_bytes": 4194304}
// Strings and arrays grown in bulk count as they grow, though the run lets them go before it ends.
const block = "x".repeat(32768)
const big = new Array(4096).fill(0)
let keep = []
for (let i = 0; i < 2048; i++) keep.push(block + i, [...big])
keep = null
return 1
