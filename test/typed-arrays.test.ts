import { describe, expect, test } from "bun:test"
import { fromBytes, Host, Runtime, toBytes } from "../src/index.js"
import { runProgram } from "./run.js"

const value = async (code: string, globals: Runtime.Globals = {}) => {
  const result = await Runtime.make({ globals: () => globals }).execute(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const error = async (code: string, globals: Runtime.Globals = {}) => {
  const result = await Runtime.make({ globals: () => globals }).execute(code)
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

describe("ArrayBuffer", () => {
  test("is zeroed memory of a fixed length that slices into copies", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(6)
        new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6])
        const part = buffer.slice(1, -2)
        new Uint8Array(part)[0] = 99
        return [buffer.byteLength, part.byteLength, [...new Uint8Array(part)], new Uint8Array(buffer)[1],
          buffer.slice(-1).byteLength, buffer.resizable, buffer.maxByteLength, buffer.detached,
          Object.prototype.toString.call(buffer), buffer instanceof ArrayBuffer, new ArrayBuffer(2.9).byteLength,
          new ArrayBuffer().byteLength]`),
    ).toEqual([6, 3, [99, 3, 4], 2, 1, false, 6, false, "[object ArrayBuffer]", true, 2, 0])
  })

  test("isView is true for typed arrays and DataViews only", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(4)
        return [ArrayBuffer.isView(new Int8Array(1)), ArrayBuffer.isView(new DataView(buffer)), ArrayBuffer.isView(buffer),
          ArrayBuffer.isView([]), ArrayBuffer.isView(Buffer.from("a"))]`),
    ).toEqual([true, true, false, false, true])
  })

  test("validates its length and refuses resizable buffers", async () => {
    expect((await error(`new ArrayBuffer(-1)`)).message).toContain("RangeError: Invalid array buffer length")
    expect((await error(`ArrayBuffer(1)`)).message).toContain("requires 'new'")
    expect((await error(`new ArrayBuffer(4, { maxByteLength: 8 })`)).message).toContain("not supported")
    // The cap on what one built-in may allocate, as for arrays.
    expect((await error(`new ArrayBuffer(2 ** 31)`)).message).toContain("RangeError: Array buffer allocation failed")
  })
})

describe("DataView", () => {
  test("reads and writes every number type in either byte order", async () => {
    expect(
      await value(`const view = new DataView(new ArrayBuffer(16))
        view.setUint32(0, 0xdeadbeef)
        view.setUint32(4, 0xdeadbeef, true)
        view.setFloat64(8, Math.PI, true)
        const bytes = new Uint8Array(view.buffer)
        const out = [view.getUint32(0).toString(16), view.getUint32(4, true).toString(16), view.getInt32(0),
          view.getUint16(0), view.getInt16(0, true), view.getUint8(0), view.getInt8(0), view.getFloat64(8, true),
          [...bytes.subarray(0, 8)]]
        view.setInt8(0, -1); view.setInt16(2, -2, true); view.setFloat32(4, 1.5); view.setFloat16(8, 0.5)
        return [...out, view.getUint8(0), view.getInt16(2, true), view.getFloat32(4), view.getFloat16(8)]`),
    ).toEqual([
      "deadbeef",
      "deadbeef",
      -559038737,
      0xdead,
      -21026,
      0xde,
      -34,
      Math.PI,
      [0xde, 0xad, 0xbe, 0xef, 0xef, 0xbe, 0xad, 0xde],
      255,
      -2,
      1.5,
      0.5,
    ])
  })

  test("views part of a buffer, and checks its bounds", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(8)
        const view = new DataView(buffer, 2, 4)
        view.setUint8(0, 7)
        return [view.byteOffset, view.byteLength, view.buffer === buffer, new Uint8Array(buffer)[2],
          new DataView(buffer, 8).byteLength]`),
    ).toEqual([2, 4, true, 7, 0])
    expect((await error(`new DataView(new ArrayBuffer(2)).getUint32(0)`)).message).toContain(
      "RangeError: Offset is outside the bounds of the DataView",
    )
    expect((await error(`new DataView(new ArrayBuffer(2), 3)`)).message).toContain("RangeError")
    expect((await error(`new DataView(new ArrayBuffer(2), 1, 2)`)).message).toContain("RangeError")
    expect((await error(`new DataView(new ArrayBuffer(2)).getInt8(-1)`)).message).toContain("RangeError")
    expect((await error(`new DataView(new Uint8Array(2))`)).message).toContain(
      "new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)",
    )
  })

  test("converts the index before the value, and the value with its own valueOf", async () => {
    expect(
      await value(`const view = new DataView(new ArrayBuffer(4))
        const order = []
        view.setUint16({ valueOf() { order.push("index"); return 1 } }, { valueOf() { order.push("value"); return 513 } })
        let caught
        try { view.setUint8(-1, { valueOf() { order.push("never") } }) } catch (e) { caught = e.name }
        return [order, view.getUint16(1), caught]`),
    ).toEqual([["index", "value"], 513, "RangeError"])
  })
})

describe("typed arrays", () => {
  test("every kind converts its elements as JS does", async () => {
    expect(
      await value(`const values = [300, -1, 1.5, 2.5, -129, 70000, NaN, Infinity, "7"]
        return [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]
          .map((T) => [T.name, T.BYTES_PER_ELEMENT, [...T.from(values)]])`),
    ).toEqual([
      ["Int8Array", 1, [44, -1, 1, 2, 127, 112, 0, 0, 7]],
      ["Uint8Array", 1, [44, 255, 1, 2, 127, 112, 0, 0, 7]],
      ["Uint8ClampedArray", 1, [255, 0, 2, 2, 0, 255, 0, 255, 7]],
      ["Int16Array", 2, [300, -1, 1, 2, -129, 4464, 0, 0, 7]],
      ["Uint16Array", 2, [300, 65535, 1, 2, 65407, 4464, 0, 0, 7]],
      ["Int32Array", 4, [300, -1, 1, 2, -129, 70000, 0, 0, 7]],
      ["Uint32Array", 4, [300, 4294967295, 1, 2, 4294967167, 70000, 0, 0, 7]],
      ["Float32Array", 4, [300, -1, 1.5, 2.5, -129, 70000, null, null, 7]],
      ["Float64Array", 8, [300, -1, 1.5, 2.5, -129, 70000, null, null, 7]],
    ])
  })

  test("construct from a length, an array, an array-like, an iterable, a typed array, or a buffer", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(16)
        const view = new Int32Array(buffer, 4, 2)
        return [[...new Int16Array(3)], [...new Int16Array([1, 2])], [...new Int16Array({ length: 2, 0: 5 })],
          [...new Int16Array(new Set([7]))], [...new Int8Array(new Float64Array([1.9, -1.9]))],
          view.length, view.byteOffset, view.byteLength, view.buffer === buffer, new Float64Array(buffer).length,
          [...new Uint8Array(new Uint16Array([0x0102]).buffer)], new Uint8Array(1).buffer instanceof ArrayBuffer]`),
    ).toEqual([[0, 0, 0], [1, 2], [5, 0], [7], [1, -1], 2, 4, 8, true, 2, [2, 1], true])
    expect((await error(`new Int32Array(new ArrayBuffer(8), 1)`)).message).toContain("multiple of 4")
    expect((await error(`new Int32Array(new ArrayBuffer(6))`)).message).toContain("multiple of 4")
    expect((await error(`new Int32Array(new ArrayBuffer(8), 4, 2)`)).message).toContain("RangeError")
    expect((await error(`Int32Array(1)`)).message).toContain("requires 'new'")
    expect((await error(`new (Object.getPrototypeOf(Int8Array))()`)).message).toContain("Abstract class TypedArray")
  })

  test("views over one buffer share their memory", async () => {
    expect(
      await value(`const bytes = new Uint8Array(8)
        const words = new Uint32Array(bytes.buffer)
        const middle = bytes.subarray(2, 6)
        const view = new DataView(bytes.buffer)
        words[0] = 0x04030201
        middle[2] = 0xff
        view.setUint8(7, 9)
        return [[...bytes], words[1], middle.buffer === bytes.buffer, words.buffer === view.buffer, middle.byteOffset,
          new Float32Array(new ArrayBuffer(8), 4).byteOffset]`),
    ).toEqual([[1, 2, 3, 4, 255, 0, 0, 9], 0x090000ff, true, true, 2, 4])
  })

  test("share the methods of %TypedArray%", async () => {
    expect(
      await value(`const TypedArray = Object.getPrototypeOf(Int8Array)
        const a = new Int16Array([5, -3, 10, 1])
        return [TypedArray.name, Object.getPrototypeOf(Float64Array.prototype) === TypedArray.prototype,
          a.at(-1), a.indexOf(10), a.lastIndexOf(5), a.includes(-3), a.includes("5"), a.join("-"), String(a),
          [...a.slice(1, 3)], [...a.map((x) => x * 2)], [...a.filter((x) => x > 0)], a.reduce((s, x) => s + x),
          a.reduceRight((s, x) => s + "" + x, ""), a.find((x) => x > 5), a.findLastIndex((x) => x < 0),
          a.every((x) => x !== 0), a.some((x) => x > 9), [...a.toSorted()], [...a.toReversed()], [...a.with(0, 1)],
          [...a], [...new Float64Array([3, -0, NaN, -Infinity, 0]).sort()].map(String),
          [...new Uint8Array([1, 2, 3, 4, 5]).copyWithin(0, 3)], [...new Int8Array(3).fill(4, 1)],
          [...a.keys()], [...a.entries()][1], [...new Int8Array([1, 2]).reverse()],
          new Float64Array([1234.5]).toLocaleString()]`),
    ).toEqual([
      "TypedArray",
      true,
      1,
      2,
      0,
      true,
      false,
      "5--3-10-1",
      "5,-3,10,1",
      [-3, 10],
      [10, -6, 20, 2],
      [5, 10, 1],
      13,
      "110-35",
      10,
      1,
      true,
      true,
      [-3, 1, 5, 10],
      [1, 10, -3, 5],
      [1, -3, 10, 1],
      [5, -3, 10, 1],
      ["-Infinity", "0", "0", "3", "NaN"],
      [4, 5, 3, 4, 5],
      [0, 4, 4],
      [0, 1, 2, 3],
      [1, -3],
      [2, 1],
      "1,234.5",
    ])
  })

  test("set copies from typed arrays, overlapping ones included, and array-likes", async () => {
    expect(
      await value(`const a = new Uint8Array([1, 2, 3, 4, 5, 6])
        a.set(a.subarray(0, 3), 2)
        const b = new Float32Array(4)
        b.set([1.5, { valueOf() { return 2 } }], 1)
        b.set({ length: 1, 0: 9 })
        return [[...a], [...b]]`),
    ).toEqual([
      [1, 2, 1, 2, 3, 6],
      [9, 1.5, 2, 0],
    ])
    expect((await error(`new Uint8Array(2).set([1, 2], 1)`)).message).toContain("RangeError")
    expect((await error(`new Uint8Array(2).set([1], -1)`)).message).toContain("RangeError")
  })

  test("numeric keys are elements or nothing, never ordinary properties", async () => {
    expect(
      await value(`const a = new Int8Array(2)
        a[5] = 1; a["-0"] = 1; a[1.5] = 1; a[-1] = 1
        a.foo = 1
        Int8Array.prototype[3] = "inherited"
        return [Object.keys(a), a[3], 3 in a, 1 in a, "-0" in a, a.foo, delete a[5], Object.getOwnPropertyDescriptor(a, 0)]`),
    ).toEqual([
      ["0", "1", "foo"],
      null,
      false,
      true,
      false,
      1,
      true,
      { value: 0, writable: true, enumerable: true, configurable: true },
    ])
    expect((await error(`const a = new Int8Array(1); delete a[0]`)).message).toContain("TypeError")
    expect((await error(`Object.freeze(new Float64Array(1))`)).message).toContain("TypeError")
  })

  test("iterate, spread and destructure, and show themselves", async () => {
    const result = await Runtime.make().execute(`const a = new Uint16Array([1, 2, 3])
      let total = 0
      for (const x of a) total += x
      const [first, ...rest] = a
      console.log(a, new ArrayBuffer(2), new DataView(new ArrayBuffer(2)))
      return [total, first, rest, Array.from(a), JSON.stringify(a), JSON.stringify(new ArrayBuffer(1)), Array.isArray(a)]`)
    expect(result).toMatchObject({
      ok: true,
      value: [6, 1, [2, 3], [1, 2, 3], '{"0":1,"1":2,"2":3}', "{}", false],
      logs: ["Uint16Array(3) [1,2,3] ArrayBuffer { byteLength: 2 } DataView { byteLength: 2, byteOffset: 0 }"],
    })
  })

  test("a typed array cannot be the result; it asks to be encoded first", async () => {
    expect((await error(`return new Int32Array(1)`)).message).toContain("An Int32Array cannot cross to the host")
    expect((await error(`return new ArrayBuffer(1)`)).message).toContain("An ArrayBuffer cannot cross to the host")
    expect((await error(`return { view: new DataView(new ArrayBuffer(1)) }`)).message).toContain(
      "A DataView cannot cross to the host",
    )
  })

  test("structuredClone copies buffers once and keeps views sharing them", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(4)
        const [a, b, view, c] = structuredClone([new Uint8Array(buffer), new Uint16Array(buffer, 2), new DataView(buffer), buffer])
        a[2] = 1
        return [a.buffer === b.buffer, b.buffer === view.buffer, view.buffer === c, a.buffer === buffer, b[0], new Uint8Array(buffer)[2]]`),
    ).toEqual([true, true, true, false, 1, 0])
  })

  test("TextDecoder and crypto.getRandomValues take any view", async () => {
    expect(
      await value(`const bytes = new TextEncoder().encode("héllo")
        const decoder = new TextDecoder()
        const words = crypto.getRandomValues(new Uint32Array(4))
        return [decoder.decode(bytes.buffer), decoder.decode(new DataView(bytes.buffer, 1)), decoder.decode(bytes.subarray(3)),
          words.length]`),
    ).toEqual(["héllo", "éllo", "llo", 4])
    expect((await error(`crypto.getRandomValues(new Float32Array(1))`)).message).toContain("integer typed array")
  })
})

describe("Buffer on ArrayBuffers", () => {
  test("a Buffer's buffer is an ArrayBuffer of its own, shared by its slices", async () => {
    expect(
      await value(`const b = Buffer.from("hello")
        const slice = b.subarray(1, 3)
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
        view.setUint8(0, 72)
        return [b.buffer instanceof ArrayBuffer, b.buffer.byteLength, slice.buffer === b.buffer, slice.byteOffset,
          b.toString(), Buffer.isBuffer(slice)]`),
    ).toEqual([true, 5, true, 1, "Hello", true])
  })

  test("Buffer.from(arrayBuffer) views its memory, as in Node", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(4)
        const b = Buffer.from(buffer, 1, 2)
        b[0] = 65
        return [b.length, b.buffer === buffer, new Uint8Array(buffer)[1], Buffer.byteLength(buffer),
          Buffer.byteLength(new Uint32Array(2)), b.readUInt16LE(0)]`),
    ).toEqual([2, true, 65, 4, 8, 65])
  })
})

describe("the host boundary", () => {
  test("host functions get every kind of binary value as a Uint8Array of its bytes", async () => {
    const seen: Array<unknown> = []
    const take = Host.fn(([data]) => {
      seen.push(data)
      return null
    })
    await value(
      `take(new Uint8Array([1, 2])); take(new Uint16Array([0x0102]).buffer); take(new Int8Array([-1, 2]).subarray(1));
       take(new DataView(new Uint8Array([5, 6, 7]).buffer, 1, 1)); take(Buffer.from("a"))`,
      { take },
    )
    expect(seen.map((data) => [data?.constructor?.name, [...(data as Uint8Array)]])).toEqual([
      ["Uint8Array", [1, 2]],
      ["Uint8Array", [2, 1]],
      ["Uint8Array", [2]],
      ["Uint8Array", [6]],
      ["Buffer", [97]],
    ])
  })

  test("a host ArrayBuffer still comes in as a Uint8Array", async () => {
    const give = Host.fn(() => new Uint8Array([1, 2, 3]).buffer)
    expect(
      await value(`const data = give(); return [data instanceof Uint8Array, data.length, data.buffer.byteLength]`, {
        give,
      }),
    ).toEqual([true, 3, 3])
  })
})

describe("snapshots", () => {
  const code = `
    const buffer = new ArrayBuffer(8)
    const bytes = new Uint8Array(buffer)
    const words = new Uint16Array(buffer, 2, 2)
    const view = new DataView(buffer)
    const floats = Float64Array.of(0.5, -2)
    const lazy = new Int32Array(2)
    const middle = lazy.subarray(1)
    const pieces = Buffer.from("abcd").subarray(1, 3)
    for (let i = 0; i < 3; i++) await null
    words[0] = 0x0201
    view.setUint8(7, 9)
    middle[0] = 5
    for (let i = 0; i < 3; i++) await null
    return [[...bytes], bytes.buffer === buffer, words.buffer === view.buffer, [...floats], [...lazy],
      middle.buffer === lazy.buffer, Buffer.isBuffer(pieces), pieces.toString(), pieces.buffer.byteLength]`

  test("keep typed arrays, DataViews and buffers, with views sharing their buffer", () => {
    const straight = runProgram(code)
    expect(straight).toMatchObject({
      ok: true,
      value: [[0, 0, 1, 2, 0, 0, 0, 9], true, true, [0.5, -2], [0, 5], true, true, "bc", 4],
    })
    let trips = 0
    expect(runProgram(code, { roundTrip: { every: 1, max: 1000 }, onTrip: () => trips++ })).toEqual(straight)
    expect(trips).toBeGreaterThan(10)
  })

  test("survive a suspend to bytes and a resume in a fresh runtime", async () => {
    const make = (hang: boolean) =>
      Runtime.make({
        globals: () => ({
          wait: Host.fn(() => (hang ? new Promise(() => {}) : null), { type: "async", idempotent: true }),
        }),
      })
    const program = make(true).program(
      `const buffer = new ArrayBuffer(4)
       const bytes = new Uint8Array(buffer)
       const view = new DataView(buffer)
       await wait()
       view.setUint16(0, 0x0102)
       return [[...bytes], bytes.buffer === view.buffer, view.buffer === buffer]`,
      { runId: "r" },
    )
    const running = program.run()
    await Bun.sleep(5)
    const suspended = await program.suspend()
    await running
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    expect(await make(false).resume(toBytes(suspended.state)).run()).toMatchObject({
      ok: true,
      value: [[1, 2, 0, 0], true, true],
    })
    expect(fromBytes(toBytes(suspended.state))).toBeDefined()
  })
})
