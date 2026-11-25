// An object as an array method's numeric argument, or an array's new length: its own valueOf and toString are not
// called, so it is not a number (NaN, as 0 where a position is read).
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const log = []
const n = { valueOf() { log.push("valueOf"); return 2 }, toString() { log.push("toString"); return "2" } }
const a = [1, 2, 3, 4]
const out = {
  read: [a.at(n), a.slice(n), a.slice(0, n), a.includes(1, n), a.indexOf(3, n), a.lastIndexOf(3, n), a.with(n, 9), a.toSpliced(n, 1), a.flat(n), [[1, [2]]].flat(n)],
  write: [t(() => { const b = [1, 2, 3]; b.splice(n, 1); return b }), t(() => [1, 2, 3].fill(0, n)), t(() => [1, 2, 3].copyWithin(n, 0))],
  length: [t(() => { const b = [1, 2, 3]; b.length = n; return b }), t(() => { const b = [1, 2, 3]; b.length = { valueOf: () => 1 }; return b }), t(() => { const b = [1]; b["length"] = n; return b })],
  fromCharCode: [String.fromCharCode(n), String.fromCharCode(n, 65), String.fromCharCode({ valueOf: () => 65 }).charCodeAt(0), String.fromCodePoint(65)],
  iterator: [t(() => [...String.prototype[Symbol.iterator].call({ toString() { return "xy" } })]), t(() => [...String.prototype[Symbol.iterator].call(12)])],
  strings: [t(() => "abc".at(n)), t(() => "abc".slice(n)), t(() => "abc".charAt(n)), t(() => "abc".padStart(n, "-"))],
  json: [t(() => JSON.parse(new (class { toString() { return "1" } })())), t(() => JSON.parse(new Date(0))), t(() => JSON.parse({ toString: () => "2" })), t(() => JSON.parse([1])), t(() => JSON.parse(5))],
}
return [out, log]
