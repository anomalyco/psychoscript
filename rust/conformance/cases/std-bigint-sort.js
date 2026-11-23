// The default sort compares BigInts by their text, each converted once, and join refuses a result too long.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const base = 2n ** 3000n
const many = Array.from({ length: 40 }, (_, i) => base + BigInt((i * 7) % 5))
const sorted = many.slice().sort()
return [
  [3n, 1n, 2n, 10n, -1n, 1].sort().join(), [10n, 2n, undefined, , 1n].sort().map(String),
  [30n, 4n, 200n].toSorted().join(), sorted.slice(0, 9).map((n) => String(n - base)).join(),
  sorted.slice(-9).map((n) => String(n - base)).join(), Array.from({ length: 30 }, (_, i) => BigInt(30 - i)).sort().join(),
  String([1n, [2n, 3n]]), [1n, 2n].toString(), [1n, null, 2n].join(":"),
  attempt(() => new Array(60).fill(2n ** 1048575n).join("").length),
  attempt(() => new Array(1000).fill(2n ** 100000n).join(",").length),
]
