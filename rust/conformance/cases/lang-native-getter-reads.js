// Getters that built-ins and the iteration protocol read, as the reference's bytecode reads them: a `[Symbol.iterator]`
// getter giving the method, undefined or a non-function, an entry's getters (one that throws closes the iterator, and
// Object.fromEntries converts the key between them), a delegated iterator's `return` and `throw` getters, and
// `done`/`value` getters on each kind of loop.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const log = []
const src = { get [Symbol.iterator]() { log.push("iter"); return function () { return [1, 2][Symbol.iterator]() } } }
const results = { [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { log.push("done"); return i > 2 }, get value() { log.push("value"); return i } } } } } }
let closed = 0
const throwing = { [Symbol.iterator]() { return { next: () => ({ done: false, value: { get 0() { throw new Error("entry") } } }), return() { closed++; return {} } } } }
const del = { [Symbol.iterator]() { let i = 0; return { next: () => ({ done: ++i > 2, value: i }), get return() { log.push("return"); return () => ({ done: true, value: 9 }) }, get throw() { return undefined } } } }
const keyed = { get 0() { log.push("0"); return { toString() { log.push("key"); return "k" } } }, get 1() { log.push("1"); return "v" } }
function* g() { yield* del }
const it = g()
it.next()
const it2 = g()
it2.next()
return [
  [...src], Array.from(src), Iterator.from(src).toArray(), (() => { const [a, b] = src; return [a, b] })(),
  [...results], Array.from(results), Iterator.from(results).map((x) => x * 2).toArray(), [...new Set(results)],
  Iterator.from({ get [Symbol.iterator]() { return undefined }, next: () => ({ done: true }) }).toArray(),
  attempt(() => Iterator.from({ get [Symbol.iterator]() { return 5 } })), attempt(() => [...{ get [Symbol.iterator]() { return 5 } }]),
  Object.fromEntries([{ get 0() { return "a" }, get 1() { return 1 } }, ["b", 2]]),
  [...new Map([{ get 0() { return "a" }, get 1() { return 1 } }])],
  Object.fromEntries([keyed]), [...new Map([keyed])].length,
  attempt(() => Object.fromEntries(throwing)), closed, attempt(() => new Map(throwing)), closed,
  it.return(5), attempt(() => it2.throw(5)),
  Object.entries({ a: 1, get b() { log.push("b"); return 2 } }), { ...{ get c() { log.push("c"); return 3 } } },
  log,
]
