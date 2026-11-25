const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const o = { [Symbol.toPrimitive](hint) { return hint === "number" ? 42 : hint } }
const tagged = { [Symbol.toStringTag]: "X" }
let n = 0
const getterTag = { get [Symbol.toStringTag]() { n++; return "G" } }
class C { get [Symbol.toStringTag]() { return "C!" } }
const d = new Date(0); d[Symbol.toPrimitive] = (h) => "d:" + h
const s = Symbol.iterator
return [+o, `${o}`, o + "", Object.keys(o), String(tagged), Object.prototype.toString.call(Symbol.iterator), String(getterTag), n, String(new C()),
  s.description, String(s), String(Symbol.asyncIterator), String(Symbol.toPrimitive), Symbol.toStringTag.description, Symbol.species === undefined,
  t(() => +{ [Symbol.toPrimitive]() { return {} } }), t(() => +{ [Symbol.toPrimitive]: 5 }), +{ [Symbol.toPrimitive]: null, valueOf() { return 3 } },
  d + 1, `${d}`, d - 0, t(() => Symbol()), t(() => new Symbol()), Object.getOwnPropertyNames(Symbol), Object.getPrototypeOf(s) === Symbol.prototype,
  s.toString(), s.valueOf() === s, s[Symbol.toPrimitive]("x") === s, Symbol.prototype[Symbol.toStringTag], t(() => Symbol.prototype.description),
  t(() => Symbol.prototype.toString.call(1)), t(() => Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get.call(5)),
  Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get.call(s), t(() => { s.x = 1 }), t(() => delete s.x), s.foo, "x" in Object.create(null),
  Object.keys({ ...o, ...tagged }), Object.getOwnPropertySymbols({ ...o, ...tagged }).length, Object.assign({}, tagged)[Symbol.toStringTag],
  [s].join(), t(() => [s].join()), t(() => `${s}`), t(() => s + ""), JSON.stringify({ [Symbol.toPrimitive]: 1, a: 2 }), Object.prototype.toString.call(5),
  Object.prototype.toString.call(null), Object.prototype.toString.call(Object.create(Math)), Object.prototype.toString.call(Object.assign(Object.create(Math), { [Symbol.toStringTag]: 7 })),
  { [Symbol.toStringTag]: "Q" }.toString(), String([o]), o == "default", [1].concat(o).length, t(() => s.toLocaleString()),
  Object.getOwnPropertyNames(Symbol.prototype), Object.getOwnPropertySymbols(Symbol.prototype).length, typeof Symbol.prototype[Symbol.toPrimitive], Symbol.prototype[Symbol.toPrimitive].name,
  { a: { [Symbol.toPrimitive]: () => "k" } }.a + "", ({ [o]: 1 }).default, new Date(o).getTime ? 1 : 0, t(() => Math.max(o)), Number(o), String(o)]
