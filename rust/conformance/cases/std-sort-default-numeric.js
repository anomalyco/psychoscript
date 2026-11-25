// A default sort over numbers only (undefined and holes aside) is numeric; any other mix of primitives sorts by
// text; one that would compare an object throws before any element converts. Deliberate differences from JavaScript.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const seen = []
const loud = (v) => ({ toString() { seen.push(v); return v } })
const zeros = [0, -0, 0, -0].sort().map((z) => Object.is(z, -0))
const holes = [3, , 1, undefined, 2, , -1]
holes.sort()
const big = Array.from({ length: 5000 }, (_, i) => (i * 7919) % 5003 - 2500)
const bigSorted = big.toSorted()
const people = [{ age: 30 }, { age: 20 }]
const kept = [{ n: 1 }, 2]
return {
  numbers: [10, 9, 1, 100, 2.5, -1, -Infinity, Infinity, NaN, 1e-300, -1e300].sort().map(String),
  toSorted: [10, 9, 1].toSorted(),
  zeros,
  nans: [NaN, 1, NaN, -1, 0 / 0].toSorted().map(String),
  holes: [holes.length, 1 in holes, 5 in holes, 6 in holes, holes.slice(0, 4)],
  bigInOrder: bigSorted.every((v, i) => i === 0 || bigSorted[i - 1] <= v),
  bigEnds: [bigSorted[0], bigSorted[4999], big.slice().sort()[2500] === bigSorted[2500]],
  mixed: [[10, "9", 1].sort(), [10, 9n, 1].sort().map(String), [null, 3, 1].sort(), [true, 10, 9].sort()],
  strings: ["10", "9", "1"].sort(),
  single: [[loud(3), undefined].sort().length, [loud(20), , undefined].toSorted().length, seen],
  emptyish: [[].sort(), [undefined, undefined].sort(), [, ,].toSorted()],
  objects: attempt(() => people.sort()),
  objectsToSorted: attempt(() => [1, [2]].toSorted()),
  functions: attempt(() => [() => 1, 2].sort()),
  dates: attempt(() => [new Date(1), new Date(0)].toSorted()),
  noConversion: [attempt(() => [loud("b"), loud("a")].sort()), seen.length],
  unchanged: [attempt(() => kept.sort()), kept[1]],
  comparator: [people.sort((a, b) => a.age - b.age).map((p) => p.age), [{}, {}].toSorted(() => 0).length],
  typed: [...new Uint8Array([10, 9, 1]).sort()],
}
