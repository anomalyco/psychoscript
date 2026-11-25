// Opaque values (functions, generators, iterators, promises) are not data: operators reject them, and string, number
// and key conversions take their tag without calling their own toString or valueOf. Map and Set are data and convert.
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const f = () => 1
f.toString = () => "own"
f.valueOf = () => 7
const g = function* () {}
const opaque = [f, g, g(), async () => {}, [1].values(), new Map().keys(), "ab"[Symbol.iterator](), [1].values().map((x) => x), Promise.resolve(1)]
let h = () => 1
return {
  operators: opaque.map((v) => [t(() => v + "!"), t(() => "!" + v), t(() => v < 1), t(() => v == 1), t(() => v != "x"), t(() => v * 2), t(() => v in {}), t(() => -v), t(() => +v), t(() => ~v), t(() => !v)]),
  update: [t(() => h++), t(() => --h), t(() => { let x = g; x += 1; return x })],
  identity: [f == f, f === f, f != g, f == null, null == f, t(() => f == {}), "x" in f, t(() => f in f)],
  strings: opaque.map((v) => t(() => [String(v), `${v}`, [v].join(), [1, 2].join(v)])),
  numbers: opaque.map((v) => t(() => [Number(v), Math.max(v, 1), isNaN(v), parseInt(v)])),
  keys: opaque.map((v) => t(() => { const o = {}; o[v] = 1; return [Object.keys(o), o[v], delete o[v], Object.keys(o)] })),
  methods: [t(() => "abc".includes(f)), t(() => "abc".indexOf(g)), t(() => "abc".concat(f)), t(() => "abc".includes([f])), t(() => [1, f].includes(f)), t(() => [1, 2].indexOf(f))],
  collections: [new Map([[1, 2]]) + "", `${new Set([1])}`, Number(new Map()), t(() => new Map() < 1), t(() => -new Set()), { [new Map()]: 1 }],
}
