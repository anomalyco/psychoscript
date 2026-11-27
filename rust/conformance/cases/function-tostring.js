const arrow = async (input) => { return input.x + 1 }
function declared(a, b = 2) {
  return a + b // é
}
const expression = function named() {}
const o = { m(x) { return "ü" + x }, get g() { return 1 }, set g(v) {}, async *gen() {}, ["com" + "puted"]() {} }
const accessors = Object.getOwnPropertyDescriptor(o, "g")
class Base {}
class A extends Base {
  constructor() { super() }
  foo() { return 1 }
  static   bar() {}
  static async *baz() {}
  get size() { return 0 }
}
class Empty {}
let error
try { Function.prototype.toString.call({}) } catch (e) { error = e.constructor.name }
return [
  arrow.toString(), declared.toString(), expression.toString(), (x => x * 2).toString(),
  o.m.toString(), accessors.get.toString(), accessors.set.toString(), o.gen.toString(), o.computed.toString(),
  A.toString(), new A().foo.toString(), A.bar.toString(), A.baz.toString(), Empty.toString(),
  Object.getOwnPropertyDescriptor(A.prototype, "size").get.toString(),
  Math.max.toString(), [].map.toString(), declared.bind(null, 1).toString(), Array.fromAsync.toString(),
  String(arrow), Function.prototype.toString.call(arrow), error,
]
