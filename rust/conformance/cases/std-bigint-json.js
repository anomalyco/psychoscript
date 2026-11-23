// JSON.stringify refuses a BigInt unless the program gives BigInts a toJSON, which then applies everywhere.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const before = [
  attempt(() => JSON.stringify(1n)), attempt(() => JSON.stringify({ a: 1n })), attempt(() => JSON.stringify([2n])),
  attempt(() => JSON.stringify({ a: 1n }, null, 2)), attempt(() => JSON.stringify({ a: 1n }, (k, v) => (typeof v === "bigint" ? String(v) : v))),
  attempt(() => JSON.stringify({ a: 1n }, ["a"])), attempt(() => JSON.stringify({ toJSON() { return 1n } })),
  attempt(() => JSON.stringify(new Map([[1n, 1n]]))), attempt(() => JSON.stringify({ a: [{ b: 3n }] })),
]
BigInt.prototype.toJSON = function (key) { return `${this}:${key}` }
const after = [
  JSON.stringify(1n), JSON.stringify({ a: 1n, b: [2n] }), JSON.stringify({ a: 1n }, null, 1),
  JSON.stringify([1n], (k, v) => (typeof v === "string" ? v + "!" : v)), attempt(() => JSON.stringify({ toJSON() { return 5n } })),
]
delete BigInt.prototype.toJSON
Object.prototype.toJSON = function () { return typeof this }
const inherited = [JSON.stringify({ a: 1n }), JSON.stringify(7n)]
delete Object.prototype.toJSON
BigInt.prototype.toJSON = 5
const uncallable = attempt(() => JSON.stringify([1n]))
delete BigInt.prototype.toJSON
return [before, after, inherited, uncallable, attempt(() => JSON.parse("1n")), JSON.parse("12345678901234567890")]
