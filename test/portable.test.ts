import { describe, expect, test } from "bun:test"
import { Host, Runtime, toBytes } from "../src/index.js"

// The public API end to end, in Bun and in every browser the browser job runs (script/browser-test.ts): nothing here
// may depend on Node or Bun.

const run = async (code: string, options?: Runtime.Options) => {
  const result = await Runtime.make(options).execute(code)
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`)
  return result
}

// Anything that would name the page, the bundle or the host's files.
const hostDetails = /https?:|file:|\.[jt]s\b|@\//

describe("portable", () => {
  test("arithmetic, closures, classes and async functions", async () => {
    const result = await run(`
      function counter(n) { return (step) => n += step }
      class Point { constructor(x) { this.x = x } get double() { return this.x * 2 } }
      class Three extends Point { constructor() { super(3) } }
      async function twice(n) { return (await Promise.resolve(n)) * 2 }
      const count = counter(10)
      count(2)
      return [1 + 2 * 3, 2 ** 8, 7 / 2, count(3), new Three().double, await twice(21), await Promise.all([1, Promise.resolve(2)])]
    `)
    expect(result.value).toEqual([7, 256, 3.5, 15, 6, 42, [1, 2]])
  })

  test("built-ins that lean on the host engine: JSON, RegExp, BigInt, text, URL, bytes and structuredClone", async () => {
    const result = await run(`
      const bytes = new TextEncoder().encode("hé😀")
      const url = new URL("https://example.com/a?x=1")
      url.searchParams.set("y", "two words")
      const copy = structuredClone({ a: [1, { b: 2 }], when: new Date(0) })
      return [
        JSON.stringify({ a: 1, b: [2] }), /(?<word>[a-z]+)-(\\d+)/.exec("id ab-42").groups.word,
        String((2n ** 64n + 2n) / 2n), Array.from(bytes), new TextDecoder().decode(bytes), url.href,
        new Uint8Array([1, 9, 3, 4]).toBase64(), Uint8Array.fromHex("ff00")[0], copy.when.toISOString(),
        [...new Map([["a", 1]])], [...new Set([1, 2, 2])], [3, 1, 2].sort().map((x) => x * 2),
      ]
    `)
    expect(result.value).toEqual([
      '{"a":1,"b":[2]}', "ab", "9223372036854775809", [104, 195, 169, 240, 159, 152, 128], "hé😀",
      "https://example.com/a?x=1&y=two+words", "AQkDBA==", 255, "1970-01-01T00:00:00.000Z", [["a", 1]], [1, 2], [2, 4, 6],
    ])
  })

  test("console output and located errors", async () => {
    const logged = await run('console.log("hello", { a: 1 }); console.warn("careful"); return 7')
    expect(logged.logs).toEqual(['hello {"a":1}', "[warn] careful"])
    const failed = await Runtime.make().execute("const a = 1\nconst b = null\nreturn b.foo")
    expect(failed.ok ? undefined : failed.error.location).toEqual({ line: 3, column: 8 })
  })

  test("sync and async host functions", async () => {
    const result = await run("return [double(21), await later(2)]", {
      globals: () => ({
        double: Host.fn(([n]) => Number(n) * 2),
        later: Host.fn(([n]) => new Promise((resolve) => setTimeout(() => resolve(Number(n) * 2), 5)), { type: "async" }),
      }),
    })
    expect(result.value).toEqual([42, 4])
  })

  test("a run yields between slices, with or without setImmediate and MessageChannel", async () => {
    const host = globalThis as { setImmediate?: unknown; MessageChannel?: unknown }
    const saved = { setImmediate: host.setImmediate, MessageChannel: host.MessageChannel }
    const sliced = async () => {
      const result = await Runtime.make({ limits: { timeoutMs: 50 } }).execute("while (true) {}")
      expect(result.ok ? undefined : result.error.kind).toBe("TimeoutExceeded")
      expect((await run("let n = 0; for (let i = 0; i < 300000; i++) n += i; return n")).value).toBe(44999850000)
    }
    try {
      delete host.setImmediate
      await sliced()
      delete host.MessageChannel
      await sliced()
    } finally {
      if (saved.setImmediate !== undefined) host.setImmediate = saved.setImmediate
      if (saved.MessageChannel !== undefined) host.MessageChannel = saved.MessageChannel
    }
  })

  test("a run suspended to bytes resumes from them", async () => {
    const code = "let total = 0; for (const n of [1, 2, 3]) total += await fetchNumber(n); return total"
    let reached: () => void = () => {}
    const waiting = new Promise<void>((resolve) => (reached = resolve))
    const program = Runtime.make({
      globals: () => ({
        fetchNumber: Host.fn(([n]) => (n === 2 ? new Promise(() => reached()) : Number(n) * 10), {
          type: "async",
          idempotent: true,
        }),
      }),
    }).program(code)
    const running = program.run()
    await waiting
    const outcome = await program.suspend()
    await running
    if (outcome.ok !== "suspended") throw new Error(`expected a suspended run, got ${JSON.stringify(outcome)}`)
    const resumed = await Runtime.make({
      globals: () => ({ fetchNumber: Host.fn(([n]) => Number(n) * 10, { type: "async", idempotent: true }) }),
    })
      .resume(toBytes(outcome.state))
      .run()
    expect(resumed.ok === true ? resumed.value : resumed).toBe(60)
  })

  test("a program reaches no page, Node or Bun globals", async () => {
    const names = ["window", "document", "fetch", "globalThis", "self", "top", "parent", "frames", "navigator",
      "location", "localStorage", "indexedDB", "XMLHttpRequest", "WebSocket", "Worker", "importScripts", "postMessage",
      "process", "Bun", "Deno", "global", "eval", "setTimeout", "setImmediate", "queueMicrotask", "WebAssembly"]
    const result = await run(`return [${names.map((name) => `typeof ${name}`).join(", ")}]`)
    expect(result.value).toEqual(names.map(() => "undefined"))
  })

  test("constructors, prototypes and this lead to no host object", async () => {
    const result = await run(`
      const tries = [
        () => ({}).constructor.constructor("return window")(),
        () => (() => {}).constructor("return this")(),
        () => (async () => {}).constructor("return document")(),
        () => Object.getPrototypeOf(function* () {}).constructor("return self")(),
      ]
      const caught = tries.map((attempt) => { try { return "returned " + typeof attempt() } catch (error) { return error.name } })
      const thisValue = (function () { return this })()
      return [caught, typeof thisValue, Object.getOwnPropertyNames(Object.getPrototypeOf(Object.getPrototypeOf(() => {}))).includes("__defineGetter__")]
    `)
    expect(result.value).toEqual([["TypeError", "TypeError", "TypeError", "TypeError"], "undefined", false])
  })

  test("error stacks show program lines only, and host errors keep their stack to the host", async () => {
    const result = await run(
      `function inner() { return new TypeError("bad") }
      let caught
      try { null.x } catch (error) { caught = error.stack }
      let host
      try { explode() } catch (error) { host = [error.name, error.message, String(error.stack)] }
      return [inner().stack, caught, host]`,
      { globals: () => ({ explode: Host.fn(() => { throw new TypeError("host boom") }) }) },
    )
    const [stack, caught, host] = result.value as [string, string, Array<string>]
    expect(stack).toContain("<program>:1:")
    expect(caught).toContain("<program>:3:")
    expect(host.slice(0, 2)).toEqual(["TypeError", "host boom"])
    expect(JSON.stringify(result.value)).not.toMatch(hostDetails)
  })
})
