const key = { toString() { return "a" } }
const has = Object.prototype.hasOwnProperty, enumerable = Object.prototype.propertyIsEnumerable
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const o = { a: 1, [Symbol.iterator]: 1, [Symbol.asyncIterator]: 2 }
const arr = [1]; arr[Symbol.iterator] = 3
let reads = 0
const counted = { toString() { reads++; return "a" } }
return [
  has.call("abc", "0"), has.call("abc", "length"), has.call(5, "x"), enumerable.call("abc", "0"),
  enumerable.call("abc", "length"), Object.hasOwn({ a: 1 }, key), ({ a: 1 }).hasOwnProperty(key),
  ({ a: 1 }).propertyIsEnumerable(key), t(() => has.call(null, "x")), t(() => has.call(undefined, { toString() { throw new Error("k") } })),
  has.call(Symbol.iterator, "x"), has.call(1n, "x"), has.call("abc", 1), enumerable.call("abc", 5), has.call(true, "x"),
  Object.hasOwn({ a: 1 }, counted), ({ a: 1 }).hasOwnProperty(counted), reads,
  Object.getOwnPropertySymbols(o).map((s) => [s === Symbol.iterator, s === Symbol.asyncIterator]), Object.getOwnPropertySymbols("ab").length, t(() => Object.getOwnPropertySymbols(null)),
  Object.getOwnPropertySymbols(arr).length, Object.getOwnPropertySymbols(5).length, t(() => Object.getOwnPropertySymbols(tools)),
  Object.fromEntries(new Map([["fn", Math.max], ["arrow", () => 2], ["p", Promise.resolve(1)]])).fn(1, 3), Object.keys(Object.fromEntries([Math.max])),
  t(() => Object.fromEntries([1])), t(() => Object.fromEntries([tools])), typeof Object.fromEntries([["p", Promise.resolve(1)]]).p.then,
  ...[Math, JSON, crypto, new TextEncoder(), new TextDecoder(), Symbol.iterator, function* () {}, async () => {}, async function* () {},
    Object.create(Math), Object.create(new TextDecoder()), new Error("x"), class {}, async function f() {}, async function () {}.bind(null)]
    .map((x) => Object.prototype.toString.call(x)),
  "" + function* () {}, `${async () => {}}`,
]
