// @limits {"max_heap_bytes": 216079}
// One byte less than heap-limit-exact-under.js keeps: over the limit.
Math.kept = new Array(1000).fill("y".repeat(100000))
return Math.kept.length
