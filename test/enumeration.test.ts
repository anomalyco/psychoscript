import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Host, Runtime } from "../src/effect/index.js"

// Key enumeration: Object.keys and for...in share one surface over plain objects, arrays (index strings), and host
// namespaces (the names `keys` lists at each path).

const catalog: Record<string, ReadonlyArray<string>> = {
  github: ["list_issues", "get_issue"],
  memory: ["search"],
  playwright: ["navigate"],
}
const echo = Host.fn(([input]) => Effect.succeed((input as { value: string }).value), { type: "async" })
const host = Host.namespace({
  keys: (path) => (path.length === 0 ? Object.keys(catalog) : path.length === 1 ? (catalog[path[0]!] ?? []) : []),
  resolve: () => echo,
})

const run = (code: string) => Effect.runPromise(Runtime.make({ globals: () => ({ host }) }).execute(code))
const value = async (code: string) => {
  const result = await run(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}
const error = async (code: string) => {
  const result = await run(code)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("Object.keys over arrays", () => {
  test("returns index strings, like JS", async () => {
    expect(await value(`return Object.keys(["a", "b", "c"])`)).toEqual(["0", "1", "2"])
    expect(await value(`return Object.keys([])`)).toEqual([])
  })

  test("objects keep their own enumerable keys", async () => {
    expect(await value(`return Object.keys({ a: 1, b: 2 })`)).toEqual(["a", "b"])
  })

  test("non-object inputs follow ToObject, and nullish inputs name what was received", async () => {
    expect(
      await value(`return [Object.keys("ab"), Object.entries(42), Object.keys(() => 1), Object.keys(true)]`),
    ).toEqual([["0", "1"], [], [], []])
    expect(
      await value(`
        const keys = []
        for (const key in "😀") keys.push(key)
        return [Object.keys("😀"), Object.hasOwn("😀", "1"), Object.keys({ ..."😀" }), keys, Object.values("😀")[1].length]
      `),
    ).toEqual([["0", "1"], true, ["0", "1"], ["0", "1"], 1])
    expect(await value(`try { Object.values(null) } catch (e) { return [e.name, e.message] }`)).toEqual([
      "TypeError",
      "Object.values(...) cannot convert null to an object.",
    ])
    expect((await error(`return Object.keys(host.github.list_issues({ value: "x" }))`)).message).toContain(
      "received an un-awaited Promise",
    )
    expect(await value(`const { a, size } = new Map(); return [a, size]`)).toEqual([null, 0])
    expect((await error(`return Array.from(7)`)).message).toContain("received a number.")
    expect(await value(`return [(() => 1).x, Object.keys(() => 1)]`)).toEqual([null, []])
  })
})

describe("for...in", () => {
  test("iterates own enumerable keys of a plain object with break/continue", async () => {
    expect(
      await value(`
      const seen = []
      for (const key in { a: 1, b: 2, c: 3, d: 4 }) {
        if (key === "b") continue
        if (key === "d") break
        seen.push(key)
      }
      return seen
    `),
    ).toEqual(["a", "c"])
  })

  test("iterates index strings over arrays", async () => {
    expect(
      await value(`
      const indexes = []
      for (const i in ["x", "y", "z"]) {
        if (i === "2") break
        indexes.push(i)
      }
      return indexes
    `),
    ).toEqual(["0", "1"])
  })

  test("supports let declarations and bare identifiers", async () => {
    expect(
      await value(`
      let last = ""
      for (let key in { a: 1, b: 2 }) last = key
      return last
    `),
    ).toBe("b")
    expect(
      await value(`
      let key = "before"
      for (key in { only: 1 }) {}
      return key
    `),
    ).toBe("only")
  })

  test("enumerates the names a host namespace lists", async () => {
    expect(
      await value(`
      const names = []
      for (const ns in host) {
        for (const name in host[ns]) names.push(ns + "." + name)
      }
      return names
    `),
    ).toEqual(["github.list_issues", "github.get_issue", "memory.search", "playwright.navigate"])
  })

  test("non-object values enumerate like JS: strings by index, everything else nothing", async () => {
    expect(
      await value(`
        const out = []
        for (const key in "ab") out.push(key)
        for (const key in 42) out.push(key)
        for (const key in null) out.push(key)
        for (const key in undefined) out.push(key)
        for (const key in new Map([[1, 2]])) out.push(key)
        for (const key in Math) out.push(key)
        return out
      `),
    ).toEqual(["0", "1"])
    expect((await error(`for (const key in host.github.list_issues({ value: "x" })) {}`)).message).toContain(
      "un-awaited Promise",
    )
  })

  const forIn = (target: string, setup = "") =>
    value(`${setup}; const out = []; for (const key in ${target}) out.push(key); return out`)

  test("visits inherited enumerable keys after own keys", async () => {
    expect(await forIn("o", "const p = { inh: 1 }; const o = Object.create(p); o.own = 2")).toEqual(["own", "inh"])
  })

  test("walks every level, skipping keys a nearer level already has", async () => {
    expect(
      await forIn(
        "o",
        `const top = { a: 1, top: 1 }
        const mid = Object.create(top); mid.a = 2; mid.mid = 2
        const o = Object.create(mid); o.own = 3; o.mid = 3`,
      ),
    ).toEqual(["own", "mid", "a", "top"])
  })

  test("orders integer-like keys first on each level", async () => {
    expect(
      await forIn("o", `const p = { b: 1, 10: 1, 2: 1 }; const o = Object.create(p); o.z = 1; o[5] = 1; o[1] = 1`),
    ).toEqual(["1", "5", "z", "2", "10", "b"])
  })

  test("a non-enumerable nearer property shadows an enumerable inherited one", async () => {
    // An array's own length and Array.prototype.push are non-enumerable.
    const setup = "Object.prototype.length = 1; Object.prototype.push = 2; Object.prototype.extra = 3"
    expect(await forIn("[5]", setup)).toEqual(["0", "extra"])
    expect(await forIn("Object.create([5])", setup)).toEqual(["0", "extra"])
  })

  test("a null prototype ends the walk", async () => {
    expect(await forIn("o", "const o = Object.create(null); o.a = 1")).toEqual(["a"])
    expect(await forIn("Object.create(null)")).toEqual([])
  })

  test("arrays and strings only visit their indexes, since built-in methods are non-enumerable", async () => {
    expect(await forIn("[7, 8]")).toEqual(["0", "1"])
    expect(await forIn(`"ab"`)).toEqual(["0", "1"])
  })

  test("visits enumerable properties a program adds to a built-in prototype", async () => {
    expect(await forIn("[7, 8]", "Array.prototype.extra = 1")).toEqual(["0", "1", "extra"])
    expect(await forIn(`"ab"`, "Array.prototype.extra = 1")).toEqual(["0", "1"])
    expect(await forIn(`"ab"`, "String.prototype.extra = 1")).toEqual(["0", "1", "extra"])
    expect(await forIn("5", "Number.prototype.extra = 1")).toEqual(["extra"])
  })
})
