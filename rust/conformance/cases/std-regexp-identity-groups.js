const r = /a/g
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const m = /(?<n>\d)/d.exec("1")
let g
"1".replace(/(?<n>\d)/, (...args) => { g = args.at(-1); return "" })
const p = RegExp.prototype
const nulled = /b/; nulled.constructor = null
const other = /c/; other.constructor = function () {}
let reads = 0
const counted = /d/; Object.defineProperty(counted, "constructor", { get() { reads++; return RegExp } })
return [RegExp(r) === r, RegExp(r, "g") === r, new RegExp(r) === r, RegExp(r, undefined) === r, RegExp(nulled) === nulled,
  RegExp(other) === other, RegExp(counted) === counted, reads, String(RegExp(nulled)),
  "groups" in /a/.exec("a"), [..."a".matchAll(/a/g)].map((m) => "groups" in m), Object.keys(/a/.exec("ba")), Object.values(/a/.exec("ba")),
  [m.groups, m.indices.groups, g].map((o) => Object.getPrototypeOf(o) === null), m.indices.groups.n, JSON.stringify(m.groups),
  p.source, p.flags, p.global, p.sticky, p.hasIndices, p.unicodeSets, p.dotAll, String(p), p.toString(), t(() => p.lastIndex), t(() => Object.create(p).source),
  "a".match(/a/).groups, "a".match(/(?<x>a)/).groups.x, [..."ab".matchAll(/(?<x>.)/g)].map((m) => m.groups.x),
  t(() => p.toString.call({})), Object.prototype.toString.call(p), String(new RegExp(p)), { ...m }.groups.n]
