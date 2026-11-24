// Equal BigInts stay one value while the collector frees the others: as Map keys, in Sets and under ===.
const counts = new Map()
const kept = []
let x = 0n
for (let i = 0; i < 20000; i++) {
  const k = BigInt(i % 50) * 3n + 2n ** 70n
  counts.set(k, (counts.get(k) ?? 0) + 1)
  x = (x * 31n + BigInt(i)) % 1000003n
  if (i % 1000 === 0) kept.push(2n ** BigInt(i))
}
const again = Array.from({ length: 50 }, (_, i) => BigInt(i) * 3n + 2n ** 70n)
const set = new Set(kept)
return [
  counts.size, [...counts.values()].every((v) => v === 400), again.every((k) => counts.get(k) === 400),
  String(x), kept.every((k, i) => k === 2n ** BigInt(i * 1000) && set.has(2n ** BigInt(i * 1000))), set.size,
  [...counts.keys()][7] === 7n * 3n + 2n ** 70n,
]
