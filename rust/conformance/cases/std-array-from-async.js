const f = Array.fromAsync
const out = [f.name, f.length, Object.prototype.toString.call(f), typeof f, String(f), Object.getOwnPropertyNames(Array)]
out.push(await Array.fromAsync([1, Promise.resolve(2)]))
async function* g() { yield 1; yield tools.echo({ id: 2 }) }
out.push(await Array.fromAsync(g(), (x, i) => x * 10 + i))
out.push(await Array.fromAsync({ length: 2, 0: tools.echo({ id: "a" }), 1: "b" }, async function (x) { return x + this.s }, { s: "!" }))
out.push(await Array.fromAsync([3, 4], (x) => tools.echo({ id: x })))
const p = Array.fromAsync([1], 42); out.push(p instanceof Promise, await p.catch((e) => [e.name, e.message, e.stack]))
try { await Array.fromAsync(null) } catch (e) { out.push(e.message, e.stack) }
let st
await Array.fromAsync([1], function () { st = new Error("x").stack })
out.push(st)
try { await Array.fromAsync({ length: 2 ** 53 }) } catch (e) { out.push(e.message, e.stack) }
out.push(await Array.fromAsync("ab"), await Array.fromAsync(new Set([3, 4])), await Array.fromAsync({ length: 1.5, 0: 9 }), await Array.fromAsync(5))
const log = []
const ticks = (async () => { for (let i = 0; i < 6; i++) { log.push("t" + i); await null } })()
const r = Array.fromAsync([1, 2], (x) => { log.push("m" + x); return x }).then(() => log.push("done"))
await ticks; await r
out.push([...log])
const it = { [Symbol.asyncIterator]() { let i = 0; return { next() { return Promise.resolve({ done: i > 1, value: i++ }) }, return() { log.push("ret"); return {} } } } }
out.push(await Array.fromAsync(it), await Array.fromAsync(it, (x) => { if (x) throw new Error("boom"); return x }).catch((e) => e.message), log.at(-1))
try { new Array.fromAsync([]) } catch (e) { out.push(e.message) }
out.push(await Array.fromAsync({ [Symbol.iterator]() { return { next() { return { value: Promise.reject(new Error("rej")), done: false } }, return() { log.push("sret"); return {} } } } }).catch((e) => e.message), log.at(-1))
const bad = { [Symbol.asyncIterator]() { return { next() { return 5 } } } }
function call() { return Array.fromAsync(bad) }
for (const h of [() => Array.fromAsync(bad), call, () => Array.fromAsync({ [Symbol.asyncIterator]() { return { next: 5 } } })]) {
  try { await h() } catch (e) { out.push([e.message, e.stack]) }
}
Array.fromAsync = 5
out.push(Array.fromAsync)
return out
