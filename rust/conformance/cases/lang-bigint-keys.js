// A BigInt literal as a property name is its decimal text: in object literals, classes and patterns.
const o = { 999999999999999999n: 1, 0x10n: 2, 1n() { return "m" }, get 2n() { return "g" } }
class C {
  1n() { return "baz" }
  static 3n() { return "s" }
  4n = "field";
  static 5n = "static field";
  get 6n() { return "getter" }
}
const c = new C()
const { 1n: a, 7n: b = "default" } = { "1": "foo" }
return [
  Object.keys(o), o["1"](), o["2"], c["1"](), C["3"](), c["4"], C["5"], c["6"], a, b, o[1].name, Object.keys(c),
  Object.getOwnPropertyNames(C.prototype), C[3].name,
]
