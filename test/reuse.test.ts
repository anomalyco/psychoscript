import { expect, test } from "bun:test"
import { Runtime } from "../src/index.js"

// A run that ends leaving the built-ins as made hands its runtime to the next run of the same `Runtime`
// (`Interpreter.reusable`). Nothing a program does may reach the run after it: each attack here runs, then a probe
// run must see what a first run sees.
const probe = `
const t = (f) => { try { return f() } catch (e) { return "E:" + e.name } }
return [
  t(() => Array.prototype.leak), t(() => Math.leak), t(() => JSON.parse.leak), t(() => [].map.leak), t(() => Object.leak),
  t(() => Object.isFrozen(Math)), t(() => Object.isExtensible(Array.prototype)), t(() => typeof leak), t(() => typeof globalThis === "undefined" ? "none" : globalThis.leak),
  t(() => Symbol.for === undefined ? "none" : String(Symbol.for("leak").description)), t(() => Object.getOwnPropertyDescriptor(Map.prototype, "size").get.leak),
  t(() => [...[1, 2]].length), t(() => Object.getPrototypeOf(Math) === Object.prototype), t(() => Object.keys(Math).length), t(() => "a".leak), t(() => (1).leak),
  t(() => Promise.leak), t(() => (function () {}).constructor.prototype.leak), t(() => Object.getPrototypeOf(function* () {}).leak), t(() => new Map().leak), t(() => Error.prototype.leak),
  t(() => String(Object.getOwnPropertyDescriptor(Array.prototype, "length") && Array.prototype.length)), t(() => Array.prototype[0]),
  t(() => Object.getOwnPropertyNames(Math).includes("max")), t(() => typeof Math.max), t(() => [3,1,2].sort().join()), t(() => JSON.stringify({a:1})),
]`
const attacks = [
  "Array.prototype.leak = 1; return 1",
  "Math.leak = 1; return 1",
  "JSON.parse.leak = 1; return 1",
  "[].map.leak = 1; return 1",
  "Object.leak = 1; return 1",
  "Object.freeze(Math); return 1",
  "Object.preventExtensions(Array.prototype); return 1",
  "leak = 1; return 1",
  "var leak = 1; return 1",
  "globalThis.leak = 1; return 1",
  "Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.leak = 1; return 1",
  "Array.prototype[Symbol.iterator] = function* () {}; return 1",
  "Object.setPrototypeOf(Math, null); return 1",
  "delete Math.max; return 1",
  "String.prototype.leak = 1; Number.prototype.leak = 1; return 1",
  "Promise.leak = 1; (function(){}).constructor.prototype.leak = 1; Object.getPrototypeOf(function*(){}).leak = 1; return 1",
  "Map.prototype.leak = 1; Error.prototype.leak = 1; return 1",
  "Array.prototype.push(7); return 1",
  "Array.prototype.length = 0; Array.prototype[0] = 5; return 1",
  "Object.defineProperty(Math, 'max', { value: 1 }); return 1",
  "Object.defineProperty(Array.prototype, 'sort', { get() { return () => ['x'] } }); return 1",
  "JSON.stringify = () => 'x'; return 1",
  "Object.prototype.toJSON = () => 'x'; return 1",
  "console.count('a'); console.group('g'); return 1",
  "Object.getPrototypeOf(async function(){}).leak = 1; Object.getPrototypeOf([][Symbol.iterator]()).next = () => ({done:true}); return 1",
  "Math.max.name; Object.defineProperty(Math.max, 'name', {value:'zz'}); return 1",
  "const d = Object.getOwnPropertyDescriptor(Map.prototype,'size'); Object.defineProperty(Map.prototype,'size',{get(){return 9}}); return 1",
  "throw new Error('x')",
  "Array.prototype.leak = 1; await new Promise(() => {})",
]

test("nothing a run does reaches the next run of the same runtime", async () => {
  const runtime = Runtime.make({})
  const clean = JSON.stringify(((await runtime.execute(probe)) as { value: unknown }).value)
  for (const attack of attacks) {
    await Promise.race([runtime.execute(attack).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 20))])
    const after = (await runtime.execute(probe)) as { value: unknown }
    expect([attack, JSON.stringify(after.value)]).toEqual([attack, clean])
    const logged = (await runtime.execute("console.count('a'); console.log('z'); return 1")) as { logs?: Array<string> }
    expect([attack, logged.logs]).toEqual([attack, ["a: 1", "z"]])
  }
})

test("a run takes the runtime a clean run left, and not one a run changed", async () => {
  const runtime = Runtime.make({})
  expect(((await runtime.execute("return [1, 2, 3].map((x) => x * 2)")) as { value: unknown }).value).toEqual([2, 4, 6])
  expect(((await runtime.execute("Array.prototype.map = () => 'changed'; return [1].map((x) => x)")) as { value: unknown }).value).toBe("changed")
  expect(((await runtime.execute("return [1, 2, 3].map((x) => x * 2)")) as { value: unknown }).value).toEqual([2, 4, 6])
})
