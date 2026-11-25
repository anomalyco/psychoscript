// JSON.parse of an array or a plain object returns it unchanged (it was parsed already), without applying a reviver;
// other values still convert to text.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
class Point { constructor() { this.x = 1 } }
let calls = 0
const counted = { toString() { calls++; return "1" } }
const parsed = JSON.parse('{"a":[1,2]}')
return {
  array: attempt(() => JSON.parse([1])),
  empty: attempt(() => JSON.parse([])),
  object: attempt(() => JSON.parse(parsed)),
  nested: attempt(() => JSON.parse(parsed.a)),
  instance: attempt(() => JSON.parse(new Point())),
  nullProto: attempt(() => JSON.parse(Object.create(null))),
  withToString: [attempt(() => JSON.parse(counted)), calls],
  withReviver: attempt(() => JSON.parse([1], (k, v) => v)),
  string: JSON.parse('"[1]"'),
  number: JSON.parse(12),
  boolean: JSON.parse(true),
  nul: JSON.parse(null),
  date: attempt(() => JSON.parse(new Date(0))),
  map: attempt(() => JSON.parse(new Map())),
  fn: attempt(() => JSON.parse(() => 1)),
  boxedText: attempt(() => JSON.parse({ [Symbol.toPrimitive]: () => "[2]" })),
  stack: (() => { try { JSON.parse({}) } catch (e) { return e.stack } })(),
  same: [JSON.parse(parsed) === parsed, JSON.parse(parsed.a) === parsed.a, JSON.parse(parsed, () => 0) === parsed],
  revived: attempt(() => JSON.parse([1, { b: 2 }], () => 0)),
  frozen: attempt(() => JSON.parse(Object.freeze({ f: 1 }))),
  derived: attempt(() => JSON.parse(Object.create({ inherited: 1 }))),
  getter: (() => { let got = 0; const o = { get g() { got++; return 1 } }; return [JSON.parse(o) === o, got] })(),
  arrayLike: attempt(() => JSON.parse({ length: 1, 0: "x" })),
  args: (function () { return attempt(() => JSON.parse(arguments)) })(1),
  math: attempt(() => JSON.parse(Math) === Math),
  json: attempt(() => JSON.parse(JSON) === JSON),
  error: attempt(() => JSON.parse(new Error("e"))),
  regexp: attempt(() => JSON.parse(/x/)),
  set: attempt(() => JSON.parse(new Set([1]))),
  promise: attempt(() => JSON.parse(Promise.resolve(1))),
  url: attempt(() => JSON.parse(new URL("https://a.b/"))),
  headers: attempt(() => JSON.parse(new Headers())),
  bytes: attempt(() => JSON.parse(new Uint8Array([1]))),
  generator: attempt(() => JSON.parse((function* () {})())),
  iterator: attempt(() => JSON.parse([1].values())),
}
