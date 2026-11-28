import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Host, Runtime } from "../src/effect/index.js"

const value = async (code: string, globals: Runtime.Globals = {}) => {
  const result = await Effect.runPromise(Runtime.make({ globals: () => globals }).execute(code))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("Buffer", () => {
  test("converts text in each encoding, defaulting to UTF-8", async () => {
    expect(
      await value(`const b = Buffer.from("héllo")
        return [b.length, b.toString(), String(b), \`\${b}\`, b.toString("hex"), b.toString("base64"),
          Buffer.from("aGk=", "base64").toString(), Buffer.from("6869", "hex").toString(), Buffer.byteLength("é")]`),
    ).toEqual([6, "héllo", "héllo", "héllo", "68c3a96c6c6f", "aMOpbGxv", "hi", "hi", 2])
  })

  test("copies bytes whole, inherits Uint8Array's statics and has Node's lowercase aliases", async () => {
    expect(
      await value(`const b = Buffer.alloc(4)
        b.writeUintBE(258, 0, 2)
        b.writeUintLE(258, 2, 2)
        return [[...Buffer.from(new Uint8Array([1, 2, 3, 4]), 1, 2)], Object.getPrototypeOf(Buffer) === Uint8Array,
          Buffer.isBuffer(Buffer.of(1, 2)), [...Buffer.fromHex("0102")], [...Buffer.copyBytesFrom(new Uint8Array([1, 2, 3]), 1)],
          [...b], b.readUintBE(0, 2), b.readUintLE(2, 2), Buffer.byteLength("hi", "")]`),
    ).toEqual([[1, 2, 3, 4], true, true, [1, 2], [2, 3], [1, 2, 2, 1], 258, 258, 2])
  })

  test("is a Uint8Array, and Buffer.isBuffer tells the two apart", async () => {
    expect(
      await value(`const b = Buffer.from([1, 2, 3])
        return [b instanceof Uint8Array, Buffer.isBuffer(b), Buffer.isBuffer(new Uint8Array(1)), [...b], b[1],
          Object.prototype.toString.call(b)]`),
    ).toEqual([true, true, false, [1, 2, 3], 2, "[object Uint8Array]"])
  })

  test("concatenates, slices over the same memory, compares and searches like Node", async () => {
    expect(
      await value(`const b = Buffer.concat([Buffer.from("ab"), Buffer.from("cd")])
        const view = b.subarray(1, 3)
        view[0] = 120
        return [b.toString(), view.toString(), b.equals(Buffer.from("axcd")), Buffer.compare(Buffer.from("a"), Buffer.from("b")),
          b.includes("cd"), b.indexOf("c"), Buffer.alloc(3, 1).toString("hex"), Buffer.alloc(4, "ab").toString()]`),
    ).toEqual(["axcd", "xc", true, -1, true, 2, "010101", "abab"])
  })

  test("makes a Buffer from a Buffer through the inherited Uint8Array methods, like Bun", async () => {
    expect(
      await value(`const b = Buffer.from("abc")
        const made = [b.map((x) => x + 1), b.filter((x) => x > 97), Uint8Array.prototype.slice.call(b, 1),
          Uint8Array.prototype.subarray.call(b, 2)]
        return [...made.map((x) => [Buffer.isBuffer(x), x.toString()]), Buffer.isBuffer(new Uint8Array(1).map((x) => x)),
          String(new Uint8Array([1, 2]).slice(1))]`),
    ).toEqual([[true, "bcd"], [true, "bc"], [true, "bc"], [true, "c"], false, "2"])
  })

  test("reads and writes numbers", async () => {
    expect(
      await value(`const b = Buffer.alloc(4)
        b.writeUInt16BE(0x1234, 0)
        b.writeInt8(-1, 2)
        return [b.readUInt16BE(0), b.readUInt16LE(0), b.readInt8(2), b.toString("hex")]`),
    ).toEqual([0x1234, 0x3412, -1, "1234ff00"])
  })

  test("serializes like Node and rejects unknown encodings with Node's code", async () => {
    expect(
      await value(`let code
        try { Buffer.from("x", "nope") } catch (e) { code = [e.name, e.code] }
        return [JSON.stringify(Buffer.from("hi")), code]`),
    ).toEqual(['{"type":"Buffer","data":[104,105]}', ["TypeError", "ERR_UNKNOWN_ENCODING"]])
  })

  test("crosses host functions as a Buffer in both directions", async () => {
    const seen: Array<boolean> = []
    const bytes = {
      read: Host.fn(() => Buffer.from("from host")),
      write: Host.fn(([value]) => void seen.push(Buffer.isBuffer(value))),
    }
    expect(
      await value(`const b = read()
        write(Buffer.from("x"))
        return [Buffer.isBuffer(b), b.toString()]`, bytes),
    ).toEqual([true, "from host"])
    expect(seen).toEqual([true])
  })

  test("works the same where the host has no Buffer, as in a browser", async () => {
    const root = path.join(import.meta.dir, "..")
    const script = `const { Runtime } = await import(${JSON.stringify(path.join(root, "src/index.ts"))})
      const result = await Runtime.make().execute('return [Buffer.from("héllo").toString("base64"), Buffer.from("6869", "hex").toString(), Buffer.alloc(4, "ab").readUInt32BE(0)]')
      console.log(typeof Buffer, JSON.stringify(result.ok ? result.value : result.error))`
    const child = Bun.spawn(["bun", "--preload", "./test/fixtures/no-host-buffer.ts", "-e", script], { cwd: root, stdout: "pipe" })
    expect((await new Response(child.stdout).text()).trim()).toBe(
      `undefined ${JSON.stringify(["aMOpbGxv", "hi", 0x61626162])}`,
    )
  })

  test("searches repetitive bytes in linear time and finds what a plain scan finds", async () => {
    // Runs of a and b make the candidate checks give up early and the linear search take over.
    let seed = 11
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    const haystack = Array.from({ length: 4000 }, (_, i) => (Math.floor(i / (1 + next(30))) % 7 === 0 ? 98 : 97))
    const queries = Array.from({ length: 300 }, () => {
      const at = next(haystack.length - 50)
      const needle = haystack.slice(at, at + 1 + next(45))
      if (next(3) === 0) needle[next(needle.length)] = 98
      return { needle, offset: next(haystack.length), forward: next(2) === 0 }
    })
    const scan = ({ needle, offset, forward }: (typeof queries)[number]) => {
      const fits = (i: number) => needle.every((byte, j) => haystack[i + j] === byte)
      const last = haystack.length - needle.length
      if (forward) {
        for (let i = offset; i <= last; i++) if (fits(i)) return i
        return -1
      }
      for (let i = Math.min(offset, last); i >= 0; i--) if (fits(i)) return i
      return -1
    }
    const found = await value(`const h = Buffer.from(haystack)
      return queries.map((q) => q.forward ? h.indexOf(Buffer.from(q.needle), q.offset) : h.lastIndexOf(Buffer.from(q.needle), q.offset))`, {
      haystack: JSON.parse(JSON.stringify(haystack)),
      queries: JSON.parse(JSON.stringify(queries)),
    } as never)
    expect(found).toEqual(queries.map(scan))
    const worst = await value(`const h = Buffer.alloc(2000000, 97)
      const n = Buffer.alloc(100000, 97)
      n[0] = 98
      return [h.indexOf(n), h.lastIndexOf(n), h.indexOf(n.toString("latin1"), "ucs2")]`)
    expect(worst).toEqual([-1, -1, -1])
  })

  test("runs the program's getters and conversions where Node does, with Node's results", async () => {
    expect(
      await value(`const t = (f) => { try { const r = f(); return r instanceof Uint8Array ? [...r] : r } catch (e) { return [e.name, e.code, e.message] } }
        return [
          t(() => Buffer.alloc({ get constructor() { return { name: "X" } } })),
          t(() => Buffer.from({ get length() { return 2 }, 0: 7, 1: { valueOf() { return 9 } } })),
          t(() => Buffer.from({ valueOf() { return "hi" } }, "latin1")),
          t(() => Buffer.from({ [Symbol.toPrimitive](hint) { return hint + "!" } })),
          t(() => Buffer.from({ type: "Buffer", data: [1, 2, 300] })),
          t(() => Buffer.alloc(4).fill({ valueOf() { return 0x41 } })),
          t(() => Buffer.alloc(2).writeUInt16BE({ valueOf() { return 258 } })),
          t(() => Buffer.from("abcdef").toString({ toString() { return "hex" } }, { valueOf() { return 1 } }, 3)),
          t(() => Buffer.from("abc").indexOf("c", { valueOf() { return 1 } })),
          t(() => Buffer.from([1, 2, 3]).slice({ valueOf() { return 1 } })),
          t(() => Buffer.from("a").toString({})),
        ]`),
    ).toEqual([
      ["TypeError", "ERR_INVALID_ARG_TYPE", 'The "size" argument must be of type number. Received an instance of X'],
      [7, 9],
      [104, 105],
      [115, 116, 114, 105, 110, 103, 33],
      [1, 2, 44],
      [65, 65, 65, 65],
      2,
      "6263",
      2,
      [2, 3],
      ["TypeError", "ERR_UNKNOWN_ENCODING", "Unknown encoding: {}"],
    ])
  })

  test("is importable from the buffer module", async () => {
    expect(await value(`const { Buffer: B } = await import("node:buffer"); return B.from("ok").toString()`)).toBe("ok")
  })
})
