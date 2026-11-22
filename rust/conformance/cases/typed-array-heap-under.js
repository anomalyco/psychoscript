// @limits {"max_heap_bytes": 4128}
// A typed array counts as an object and its storage, once for every view of it: 64 for the Float32Array, 4000 for its
// buffer, and 64 for the subarray, which shares the buffer. Exactly at the limit is under it.
Math.kept = new Float32Array(1000)
Math.view = Math.kept.subarray(10)
return Math.kept.length
