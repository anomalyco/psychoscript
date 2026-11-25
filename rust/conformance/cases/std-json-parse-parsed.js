// JSON.parse of an array or a plain object throws a TypeError at the call (it was probably parsed already); other
// values still convert to text.
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
}
