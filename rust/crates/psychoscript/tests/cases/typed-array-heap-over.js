// One byte less than typed-array-heap-under.js keeps: over the limit.
Math.kept = new Float32Array(1000)
Math.view = Math.kept.subarray(10)
return Math.kept.length
