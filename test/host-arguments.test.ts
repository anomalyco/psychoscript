import { describe, expect, test } from "bun:test"
import { Host, Runtime } from "../src/index.js"

// Arguments crossing to a host function: plain objects and arrays are copied as data, as before their fast path.

const received = async (code: string, translate?: Runtime.Translate) => {
  const calls: Array<ReadonlyArray<unknown>> = []
  const result = await Runtime.make({
    translate,
    globals: () => ({ keep: Host.fn((args) => void calls.push(args)) }),
  }).execute(code)
  if (!result.ok) return result.error
  return calls[0]![0]
}

describe("plain data crossing as an argument", () => {
  test("arrays keep their holes and leave out their other properties", async () => {
    const holes = (await received("keep([1, , 3])")) as Array<unknown>
    expect(holes).toEqual([1, , 3])
    expect(1 in holes).toBe(false)
    expect(await received("keep(Object.assign([1, 2], { x: 1 }))")).toEqual([1, 2])
    expect(await received("keep([undefined, null, NaN, -0])")).toEqual([undefined, null, NaN, -0])
  })

  test("objects keep their enumerable data in key order, without a __proto__ key", async () => {
    const copied = (await received(
      "keep({ b: undefined, 2: 'a', 1: 'b', x: [1], ['__proto__']: 1, 0: 'c', [Symbol.iterator]: 1 })",
    )) as object
    expect(Object.keys(copied)).toEqual(["0", "1", "2", "b", "x"])
    expect(copied).toEqual({ 0: "c", 1: "b", 2: "a", b: undefined, x: [1] })
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(await received("keep(Object.defineProperty({ a: 1 }, 'h', { value: 2, enumerable: false }))")).toEqual({
      a: 1,
    })
    expect(await received("const o = Object.create(null); o.a = 1; keep(o)")).toEqual({ a: 1 })
    expect(await received("class A { constructor() { this.x = 1 } }; keep(new A())")).toEqual({ x: 1 })
  })

  test("a value shared within an argument crosses as a copy each time", async () => {
    const [first, second] = (await received("const s = { v: [1] }; keep([s, s])")) as Array<object>
    expect(first).toEqual({ v: [1] })
    expect(first).not.toBe(second)
  })

  test("functions inside follow translate.functions", async () => {
    const code = "keep({ a: 1, f: () => 1, list: [() => 2, 3], nested: { g() {} } })"
    expect(await received(code, { functions: "drop" })).toEqual({ a: 1, list: [null, 3], nested: {} })
    expect(await received(code, { functions: "mark" })).toEqual({
      a: 1,
      f: Host.functionMarker,
      list: [Host.functionMarker, 3],
      nested: { g: Host.functionMarker },
    })
    expect(await received(code)).toMatchObject({
      kind: "ExecutionFailure",
      message: "TypeError: Argument 1 to keep contains a function, which cannot be passed to the host. (line 1, col 1)",
    })
  })

  test("the depth limit applies inside plain data", async () => {
    let nested = "0"
    for (let i = 0; i < 33; i++) nested = i % 2 ? `[${nested}]` : `{ a: ${nested} }`
    expect(await received(`keep(${nested})`)).toMatchObject({
      kind: "ExecutionFailure",
      message: "TypeError: Argument 1 to keep exceeds the maximum value depth of 32. (line 1, col 1)",
    })
  })
})
