// Garbage never counts: about 20 MB is allocated in all under a 1 MB limit, and a large live set that churns stays as
// large.
let n = 0
for (let i = 0; i < 50000; i++) {
  const o = { i, s: "x" + i, a: [i, i, i] }
  n += o.a.length
}
let kept = []
for (let round = 0; round < 10; round++) {
  kept = []
  for (let i = 0; i < 4000; i++) kept.push({ round, i })
}
return [n, kept.length]
