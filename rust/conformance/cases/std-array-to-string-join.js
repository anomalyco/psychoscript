const a = [1, 2]
a.join = () => "x"
const b = [3]
let n = 0
Object.defineProperty(b, "join", { get() { n++; return () => "g" } })
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const ts = Array.prototype.toString
const viaHost = [1]
viaHost.join = () => tools.echo({ id: "h" })
return [a.toString(), `${a}`, String([1, [2, 3], null]), ts.call({ join: () => "j" }), ts.call({}), String(b), b + "", n,
  t(() => ts.call(null)), t(() => ts.call(Symbol.iterator)), t(() => ts.call(tools)), ts.call(5), ts.call("s"), ts.call(true), ts.call(1n),
  ts.call(Math), ts.call(JSON), ts.call(function* () {}), ts.call(async () => {}), [[a, 1]].join(";"), [{ toString() { return "o" } }, 2].toString(),
  ts.call({ join: Math.max }), ts.call({ join: 5 }), [1, 2].toString.call(new Map()), await viaHost.toString(), [a] + "", t(() => `${[{ toString: 5, valueOf: 6 }]}`)]
