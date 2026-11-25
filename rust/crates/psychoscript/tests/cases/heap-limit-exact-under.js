// The heap the run keeps when it ends, in the size model: 64 bytes for the array and 16 per element, and the string it
// holds once, 16 bytes and 2 per code unit. Exactly at the limit is under it.
Math.kept = new Array(1000).fill("y".repeat(100000))
return Math.kept.length
