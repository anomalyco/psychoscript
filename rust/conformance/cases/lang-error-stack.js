// An error's `stack`: `name: message` as of its first read, then the program frames where it was made (innermost
// first, at most 10), or for a built-in's failure the site it failed at. Non-enumerable, writable, configurable.
const attempt = (f) => { try { return f() } catch (e) { return e.stack } }
function inner() { return new Error("boom") }
const outer = () => inner()
class MyErr extends Error { constructor(m) { super(m); this.name = "MyErr" } }
const late = new Error("y"); late.name = "Late"; late.message = "z"
const first = late.stack
late.name = "After"
const unnamed = new Error("q"); unnamed.name = ""
const empty = new Error(""); empty.name = "N"
const getter = new Error("g"); Object.defineProperty(getter, "name", { get() { return "G" } })
const a = new Error("a"); a.stack = "custom"
const b = new Error("b"); b.stack; b.stack = 1
function deep(n) { return n === 0 ? new Error("deep") : deep(n - 1) }
const o = { method() { return new TypeError("in a method") }, get prop() { return new RangeError("in a getter") } }
const anon = [0].map(() => new Error("callback"))[0]
const e = new Error("x"); e.code = 1
const before = new Error("before")
Object.defineProperty(before, "stack", { enumerable: true })
return [
  outer().stack.split("\n"), new MyErr("x").stack, first, late.stack, unnamed.stack, empty.stack, getter.stack.split("\n")[0],
  a.stack, b.stack, Object.getOwnPropertyDescriptor(a, "stack").enumerable,
  deep(20).stack.split("\n"), o.method().stack, o.prop.stack, anon.stack,
  JSON.stringify(e), Object.keys(e), Object.getOwnPropertyDescriptor(e, "stack"), Object.getOwnPropertyNames(new Error("n", { cause: 1 })),
  attempt(() => null.x), attempt(() => { function f() { undefined.y } f() }), attempt(() => [1].map(() => null.z)),
  attempt(() => JSON.parse("{")), attempt(() => { throw new SyntaxError("s") }), new RangeError().stack,
  new AggregateError([1], "agg").stack, Error("called").stack, TypeError("t").stack,
  before.stack, Object.keys(before), String(new Error("str")), "stack" in Error.prototype,
  attempt(() => { const x = 1; x() }), attempt(() => new (class { constructor() { throw new Error("ctor") } })()),
]
