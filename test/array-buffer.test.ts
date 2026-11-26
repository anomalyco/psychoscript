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

  test("isView is true for Uint8Arrays and Buffers only", async () => {
    expect(
      await value(`return [ArrayBuffer.isView(new Uint8Array(1)), ArrayBuffer.isView(new ArrayBuffer(4)),
        ArrayBuffer.isView([]), ArrayBuffer.isView(Buffer.from("a"))]`),
    ).toEqual([true, false, false, true])
  })

  test("validates its length and refuses resizable buffers", async () => {
    expect((await error(`new ArrayBuffer(-1)`)).message).toContain("RangeError: Invalid array buffer length")
    expect((await error(`ArrayBuffer(1)`)).message).toContain("requires 'new'")
    expect((await error(`new ArrayBuffer(4, { maxByteLength: 8 })`)).message).toContain("not supported")
    // The cap on what one built-in may allocate, as for arrays.
    expect((await error(`new ArrayBuffer(2 ** 31)`)).message).toContain("RangeError: Array buffer allocation failed")
  })

  test("shows itself, and cannot be the result", async () => {
    const result = await Runtime.make().execute(
      `console.log(new ArrayBuffer(2)); return JSON.stringify(new ArrayBuffer(1))`,
    )
    expect(result).toMatchObject({ ok: true, value: "{}", logs: ["ArrayBuffer { byteLength: 2 }"] })
    expect((await error(`return new ArrayBuffer(1)`)).message).toContain("An ArrayBuffer cannot cross to the host")
    expect((await error(`return { bytes: new Uint8Array(1) }`)).message).toContain(
      "A Uint8Array cannot cross to the host",
    )
  })
})

describe("Uint8Array on ArrayBuffers", () => {
  test("constructs over part of a buffer and checks its bounds", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(8)
        const view = new Uint8Array(buffer, 2, 4)
        view[0] = 7
        return [view.length, view.byteOffset, view.byteLength, view.buffer === buffer, new Uint8Array(buffer)[2],
          new Uint8Array(buffer, 8).length, new Uint8Array(buffer, 3).length, new Uint8Array(1).buffer instanceof ArrayBuffer,
          new Uint8Array(1).buffer.byteLength]`),
    ).toEqual([4, 2, 4, true, 7, 0, 5, true, 1])
    expect((await error(`new Uint8Array(new ArrayBuffer(2), 3)`)).message).toContain("RangeError")
    expect((await error(`new Uint8Array(new ArrayBuffer(2), 1, 2)`)).message).toContain("RangeError")
    expect((await error(`new Uint8Array(new ArrayBuffer(2), -1)`)).message).toContain("RangeError")
  })

  test("views over one buffer share their memory", async () => {
    expect(
      await value(`const bytes = new Uint8Array(8)
        const other = new Uint8Array(bytes.buffer, 4)
        const middle = bytes.subarray(2, 6)
        const inner = middle.subarray(1, 2)
        other[0] = 0xff
        middle[0] = 3
        inner[0] = 9
        return [[...bytes], middle.buffer === bytes.buffer, inner.buffer === other.buffer, middle.byteOffset,
          inner.byteOffset, [...bytes.slice(2, 4)], bytes.slice(2, 4).buffer === bytes.buffer]`),
    ).toEqual([[0, 0, 3, 9, 255, 0, 0, 0], true, true, 2, 3, [3, 9], false])
  })

  test("structuredClone copies buffers once and keeps views sharing them", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(4)
        const [a, b, c, d] = structuredClone([new Uint8Array(buffer), new Uint8Array(buffer, 2), buffer, new Uint8Array(2)])
        a[2] = 1
        return [a.buffer === b.buffer, b.buffer === c, a.buffer === buffer, b[0], new Uint8Array(buffer)[2], d.length]`),
    ).toEqual([true, true, false, 1, 0, 2])
  })

  test("TextDecoder takes an ArrayBuffer", async () => {
    expect(
      await value(`const bytes = new TextEncoder().encode("héllo")
        const decoder = new TextDecoder()
        return [decoder.decode(bytes.buffer), decoder.decode(new Uint8Array(bytes.buffer, 1)), decoder.decode(bytes.subarray(3))]`),
    ).toEqual(["héllo", "éllo", "llo"])
  })
})

describe("Buffer on ArrayBuffers", () => {
  test("a Buffer's buffer is an ArrayBuffer of its own, shared by its slices", async () => {
    expect(
      await value(`const b = Buffer.from("hello")
        const slice = b.subarray(1, 3)
        const view = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
        view[0] = 72
        slice[1] = 76
        return [b.buffer instanceof ArrayBuffer, b.buffer.byteLength, slice.buffer === b.buffer, slice.byteOffset,
          b.toString(), Buffer.isBuffer(slice), b.slice(1).buffer === b.buffer]`),
    ).toEqual([true, 5, true, 1, "HeLlo", true, true])
  })

  test("Buffer.from(arrayBuffer) views its memory, as in Node", async () => {
    expect(
      await value(`const buffer = new ArrayBuffer(4)
        const b = Buffer.from(buffer, 1, 2)
        b[0] = 65
        return [b.length, b.buffer === buffer, new Uint8Array(buffer)[1], Buffer.byteLength(buffer), b.readUInt16LE(0),
          Buffer.from(buffer).length, new Buffer(buffer, 3).length]`),
    ).toEqual([2, true, 65, 4, 65, 4, 1])
    expect((await error(`Buffer.from(new ArrayBuffer(2), 3)`)).message).toContain('"offset" is outside of buffer bounds')
    expect((await error(`Buffer.from(new ArrayBuffer(2), 1, 2)`)).message).toContain(
      '"length" is outside of buffer bounds',
    )
  })
})

describe("the host boundary", () => {
  test("host functions get each binary value as a Uint8Array of exactly its bytes, and a Buffer as a Buffer", async () => {
    const seen: Array<unknown> = []
    const take = Host.fn(([data]) => {
      seen.push(data)
      return null
    })
    await value(
      `take(new Uint8Array([1, 2])); take(new Uint8Array([2, 1]).buffer); take(new Uint8Array([1, 2, 3]).subarray(1, 2));
       take(new Uint8Array(new Uint8Array([5, 6, 7]).buffer, 1, 1)); take(Buffer.from("ab").subarray(1))`,
      { take },
    )
    expect(
      seen.map((data) => [data?.constructor?.name, [...(data as Uint8Array)], (data as Uint8Array).buffer.byteLength]),
    ).toEqual([
      ["Uint8Array", [1, 2], 2],
      ["Uint8Array", [2, 1], 2],
      ["Uint8Array", [2], 1],
      ["Uint8Array", [6], 1],
      ["Buffer", [98], expect.any(Number)],
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
    const part = new Uint8Array(buffer, 2, 2)
    const lazy = new Uint8Array(4)
    const middle = lazy.subarray(1)
    const pieces = Buffer.from("abcd").subarray(1, 3)
    for (let i = 0; i < 3; i++) await null
    part[0] = 1
    middle[0] = 5
    for (let i = 0; i < 3; i++) await null
    return [[...bytes], bytes.buffer === buffer, part.buffer === buffer, [...lazy], middle.buffer === lazy.buffer,
      Buffer.isBuffer(pieces), pieces.toString(), pieces.buffer.byteLength]`

  test("keep buffers and the Uint8Arrays and Buffers sharing them", () => {
    const straight = runProgram(code)
    expect(straight).toMatchObject({
      ok: true,
      value: [[0, 0, 1, 0, 0, 0, 0, 0], true, true, [0, 5, 0, 0], true, true, "bc", 4],
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
       const tail = bytes.subarray(2)
       await wait()
       tail[0] = 7
       return [[...bytes], bytes.buffer === tail.buffer, tail.buffer === buffer]`,
      { runId: "r" },
    )
    const running = program.run()
    await Bun.sleep(5)
    const suspended = await program.suspend()
    await running
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    expect(await make(false).resume(toBytes(suspended.state)).run()).toMatchObject({
      ok: true,
      value: [[0, 0, 7, 0], true, true],
    })
    expect(fromBytes(toBytes(suspended.state))).toBeDefined()
  })
})
