// The polluted cell's history: programs run, in a seeded order and twice over, in one Runtime before timing. Changing
// any program changes what JSC has compiled for `Vm.exec` when the targets run, so bump HISTORY_VERSION with it; the
// runner reports the version and a hash of the text with every result.
import type { Host } from "../../../src/index.js"

export const HISTORY_VERSION = 1

export const cases = {
  strConv: "let n = 0; for (let i = 0; i < 100000; i++) n += String(i).length; return n",
  toFixed: "let n = 0; for (let i = 0; i < 100000; i++) n += (i * 1.5).toFixed(2).length; return n",
  parseIntC: "let n = 0; for (let i = 0; i < 100000; i++) n += parseInt('12' + (i % 10), 10); return n",
  hasOwn: "const o = { a: 1, b: 2 }; let n = 0; for (let i = 0; i < 100000; i++) n += (Object.hasOwn(o, 'a') ? 1 : 0) + (o.hasOwnProperty('b') ? 1 : 0); return n",
  arrIndexOf: "const a = ['x', 'y', 'z', 'w']; let n = 0; for (let i = 0; i < 100000; i++) n += a.indexOf('z') + (a.includes('w') ? 1 : 0); return n",
  joinSlice: "const a = [1, 2, 3, 4, 5]; let n = 0; for (let i = 0; i < 50000; i++) n += a.slice(1, 3).length + a.join('-').length; return n",
  filterB: "const rows = Array.from({length: 20000}, (_, i) => i % 3); let n = 0; for (let k = 0; k < 10; k++) n += rows.filter(r => r).length; return n",
  filterU: "const rows = Array.from({length: 20000}, (_, i) => i % 3); const cb = r => r; let n = 0; for (let k = 0; k < 10; k++) { const result = []; let count = 0; let index = 0; let item; const length = rows.length; while (index < length) { if (index in rows) { item = rows[index]; if (cb(item, index, rows)) result[count++] = item } index++ } n += result.length } return n",
  forEachB: "const rows = Array.from({length: 20000}, (_, i) => i % 3); let n = 0; for (let k = 0; k < 10; k++) rows.forEach(r => { n += r }); return n",
  reduceB: "const rows = Array.from({length: 20000}, (_, i) => i % 3); let n = 0; for (let k = 0; k < 10; k++) n += rows.reduce((a, r) => a + r, 0); return n",
  forLoop: "const rows = Array.from({length: 20000}, (_, i) => i % 3); let n = 0; for (let k = 0; k < 10; k++) for (let i = 0; i < rows.length; i++) n += rows[i]; return n",
  pushObjs: "const rows = Array.from({length: 20000}, (_, i) => ({ id: i, tags: ['a', 'b'], meta: { k: i } })); let n = 0; for (let k = 0; k < 5; k++) { const out = []; for (const r of rows) out.push(r); n += out.length } return n",
  pushPrims: "let n = 0; for (let k = 0; k < 5; k++) { const out = []; for (let i = 0; i < 20000; i++) out.push(i); n += out.length } return n",
  assignBig: "const big = Array.from({length: 2000}, (_, i) => ({ id: i, tags: ['a'] })); const holder = {}; for (let k = 0; k < 200; k++) holder['k' + (k % 10)] = big; return 1",
  groupObjs: "const rows = Array.from({length: 20000}, (_, i) => ({ id: i, team: 't' + (i % 13), tags: ['x'] })); let n = 0; for (let k = 0; k < 3; k++) { const g = {}; for (const r of rows) (g[r.team] ??= []).push(r); n += Object.keys(g).length } return n",
  filterObjs: "const rows = Array.from({length: 20000}, (_, i) => ({ id: i, a: i % 3 !== 0, tags: ['x'] })); let n = 0; for (let k = 0; k < 5; k++) n += rows.filter(r => r.a).length; return n",
  nativeCall: "let s = 0; for (let i = 0; i < 300000; i++) s += Math.abs(i); return s",
  noCall: "let s = 0; for (let i = 0; i < 300000; i++) s += i; return s",
  fnCall: "const f = (x) => x; let s = 0; for (let i = 0; i < 300000; i++) s += f(i); return s",
  jsonParse: "const raw = await getJson(); let n = 0; for (let i = 0; i < 5; i++) n += JSON.parse(raw).items.length; return n",
  jsonStringify: "const rows = await getRows(); let n = 0; for (let i = 0; i < 5; i++) n += JSON.stringify(rows).length; return n",
  hostRows: "let n = 0; for (let i = 0; i < 5; i++) n += (await getRows()).length; return n",
  spread: "const o = { a: 1, b: 2, c: 3, d: 4 }; let n = 0; for (let i = 0; i < 50000; i++) { const c = { ...o, e: i }; n += c.e } return n",
  destructure: "const o = { a: 1, b: 2, c: 3, d: 4 }; let n = 0; for (let i = 0; i < 100000; i++) { const { a, b, c } = o; n += a + b + c } return n",
  templ: "let n = 0; for (let i = 0; i < 100000; i++) { const s = `id-${i}-${n}`; n += s.length } return n",
  objKeys: "const o = { a: 1, b: 2, c: 3, d: 4 }; let n = 0; for (let i = 0; i < 50000; i++) { n += Object.keys(o).length + Object.entries(o).length } return n",
  arrPush: "let n = 0; for (let k = 0; k < 10; k++) { const a = []; for (let i = 0; i < 20000; i++) a.push(i); n += a.length } return n",
  sortObjs: "const rows = Array.from({length: 20000}, (_, i) => ({ s: (i * 7919) % 1000 })); let n = 0; for (let k = 0; k < 3; k++) n += rows.slice().sort((a, b) => a.s - b.s)[0].s; return n",
  mapGetSet: "const m = new Map(); let n = 0; for (let i = 0; i < 100000; i++) { const k = 'k' + (i % 1000); m.set(k, (m.get(k) ?? 0) + 1) } return m.size",
  closureCall: "const add = (a) => (b) => a + b; let n = 0; for (let i = 0; i < 200000; i++) n = add(i)(n) % 1000; return n",
  mapBuiltin: "const a = Array.from({length: 100000}, (_, i) => i); let s = 0; for (let k = 0; k < 3; k++) s += a.map(x => x + 1).length; return s",
  mapManual: "const a = Array.from({length: 100000}, (_, i) => i); const f = x => x + 1; let s = 0; for (let k = 0; k < 3; k++) { const r = new Array(a.length); for (let i = 0; i < a.length; i++) r[i] = f(a[i]); s += r.length } return s",
  objLit: "let s = 0; for (let i = 0; i < 200000; i++) { const o = { id: i, name: 'x', score: i % 7, active: true }; s += o.score } return s",
  propRead: "const o = { id: 1, name: 'x', score: 3, active: true }; let s = 0; for (let i = 0; i < 300000; i++) { s += o.score + o.id } return s",
  protoMethod: "class P { constructor(x) { this.x = x } get2() { return this.x } } const p = new P(2); let s = 0; for (let i = 0; i < 300000; i++) s += p.get2(); return s",
  strConcat: "let s = ''; for (let i = 0; i < 100000; i++) s += 'ab' + i; return s.length",
  strMethods: "let n = 0; const t = 'hello world foo bar'; for (let i = 0; i < 100000; i++) { n += t.indexOf('foo') + t.slice(2, 5).length + (t.startsWith('he') ? 1 : 0) } return n",
  forOf: "const a = Array.from({length: 200000}, (_, i) => i); let s = 0; for (const x of a) s += x; return s",
  emptyLoop: "let s = 0; for (let i = 0; i < 1000000; i++) s += i; return s",
}

const gen = `const bigRows = Array.from({ length: 5000 }, (_, i) => ({ id: i, path: "src/dir" + (i % 40) + "/file" + i + ".ts", size: (i * 7919) % 100000, kind: i % 5 === 0 ? "dir" : "file", tags: ["a" + (i % 7), "b"] }))
`
export const selfCases = {
  sort: "const rows = Array.from({length: 20000}, (_, i) => ({ score: (i * 7919) % 1000 })); let n = 0; for (let k = 0; k < 3; k++) n += rows.slice().sort((a, b) => b.score - a.score)[0].score; return n",
  filterCb: "const rows = Array.from({length: 20000}, (_, i) => ({ a: i % 3 !== 0 })); let n = 0; for (let k = 0; k < 10; k++) n += rows.filter(r => r.a).length; return n",
  mathCalls: "let s = 0; for (let i = 0; i < 300000; i++) s += Math.abs(i) + Math.max(i, 3); return s",
  strCalls: "let n = 0; const t = 'hello world foo bar'; for (let i = 0; i < 100000; i++) { n += t.indexOf('foo') + t.slice(2, 5).length + (t.startsWith('he') ? 1 : 0) } return n",
  objects: `const rows = Array.from({length: 20000}, (_, i) => ({ id: i, name: "user" + i, team: "t" + (i % 13), score: (i * 7919) % 1000, active: i % 3 !== 0 }))
const active = rows.filter(r => r.active)
const byTeam = {}
for (const r of active) { (byTeam[r.team] ??= []).push(r) }
const summary = Object.entries(byTeam).map(([team, list]) => ({ team, n: list.length, avg: list.reduce((a, r) => a + r.score, 0) / list.length, top: list.slice().sort((a, b) => b.score - a.score).slice(0, 3).map(r => r.name) }))
let s = 0
for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (r.score > 500 && r.active) s += r.id }
return [summary.length, s]`,
  strings: `const lines = []
for (let i = 0; i < 20000; i++) lines.push(String(i).padStart(6, "0") + " | " + ("name" + i) + " | " + (i * 3.7).toFixed(2))
const text = lines.join("\\n")
const parts = text.split("\\n").map(l => l.split(" | "))
let n = 0
for (const p of parts) { if (p[1].includes("9")) n += p[0].length; n += p[2].toUpperCase().length }
let out = ""
for (let i = 0; i < 20000; i++) out += "x" + i + ","
return n + out.length`,
  json: gen + `const raw = JSON.stringify({ items: bigRows })
const data = JSON.parse(raw)
const files = data.items.filter(x => x.kind === "file" && x.size > 1000)
const out = JSON.stringify(files.map(f => ({ p: f.path, s: f.size })))
return out.length + JSON.stringify(data.items.slice(0, 500), null, 2).length`,
  mapset: `const m = new Map(); const seen = new Set()
for (let i = 0; i < 40000; i++) { const k = "key" + (i % 3000); m.set(k, (m.get(k) ?? 0) + 1); seen.add(i % 5000) }
const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
return top.length + seen.size`,
  closures: `const compose = (...fs) => (x) => fs.reduceRight((a, f) => f(a), x)
const inc = (x) => x + 1, dbl = (x) => x * 2
const g = compose(inc, dbl, inc)
let s = 0
for (let i = 0; i < 30000; i++) s += g(i)
const counters = Array.from({ length: 1000 }, () => { let c = 0; return { inc: () => ++c, get: () => c } })
for (let j = 0; j < 20; j++) for (const c of counters) c.inc()
return s + counters.reduce((a, c) => a + c.get(), 0)`,
  regex: `const text = Array.from({ length: 5000 }, (_, i) => "worker" + (i % 9) + " " + (i * 31 % 1000) + ": request " + (i % 2 ? "ok" : "failed with code " + (i % 500)) + " path=/api/v1/item/" + i).join("\\n")
const re = /^(\\w+)\\s+(\\d+): request (ok|failed with code (\\d+)) path=(\\S+)$/
let ok = 0
for (const line of text.split("\\n")) { const m = re.exec(line); if (m && m[3] === "ok") ok++ }
return [ok, [...text.matchAll(/item\\/(\\d+)/g)].length, text.replace(/\\d{3,}/g, "N").length]`,
  loop: `let s = 0; for (let i = 0; i < 1000000; i++) s = (s + i * 3) % 1000003; return s`,
  fib: `const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2)); return fib(24)`,
  classes: `class P { constructor(x) { this.x = x } get2() { return this.x } } class Q extends P { get2() { return super.get2() + 1 } }
let s = 0; for (let i = 0; i < 100000; i++) { const q = new Q(i % 10); s += q.get2() } return s`,
}

export const history: ReadonlyArray<string> = [...Object.values(cases), ...Object.values(selfCases)]

const bigRows = Array.from({ length: 5000 }, (_, i) => ({ id: i, path: "src/dir" + (i % 40) + "/file" + i + ".ts", size: (i * 7919) % 100000, kind: i % 5 === 0 ? "dir" : "file", tags: ["a" + (i % 7), "b"] }))
const bigJson = JSON.stringify({ items: bigRows, total: bigRows.length })

export const dataGlobals = (host: typeof Host) => ({
  getJson: host.fn(() => bigJson, { type: "async" }),
  getRows: host.fn(() => bigRows, { type: "async" }),
})
