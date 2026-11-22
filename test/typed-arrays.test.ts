import { describe, expect, test } from "bun:test"
import { Host, Runtime, toBytes } from "../src/index.js"

// Typed arrays and ArrayBuffer: their semantics (also in the conformance cases), the heap cap, the host's zero-copy
// access to their bytes, and suspending a run that holds them.

const value = async (runtime: Runtime.Runtime, code: string) => {
  const result = await runtime.execute(code)
  if (!result.ok) throw new Error(`${code}: ${result.error.message}`)
  return result.value
}

describe("typed arrays", () => {
  test("elements round and wrap, views share their buffer, and out-of-range indexes do nothing", async () => {
    const runtime = Runtime.make()
    expect(
      await value(
        runtime,
        `const f = new Float32Array(2); f[0] = 1.1; f[1] = 16777217
         const u = new Uint16Array([-1, 65537]); const i = new Int32Array([2 ** 31])
         return [f[0], f[1], u[0], u[1], i[0], new Uint32Array([-1])[0]]`,
      ),
    ).toEqual([1.100000023841858, 16777216, 65535, 1, -2147483648, 4294967295])
    expect(
      await value(
        runtime,
        `const b = new ArrayBuffer(8); const f = new Float32Array(b); const u = new Uint8Array(b, 4)
         f[1] = 1; const s = f.subarray(1); s[0] = 2; f[5] = 1; f[-1] = 1
         return [Array.from(u), f[1], s.buffer === b, f.buffer === b, f[2], f[-1], f.length, s.byteOffset, Object.keys(f)]`,
      ),
    ).toEqual([[0, 0, 0, 64], 2, true, true, undefined, undefined, 2, 4, ["0", "1"]].map((v) => v ?? null))
  })

  test("storage counts against the heap cap once per buffer", async () => {
    const capped = (maxHeapBytes: number) => Runtime.make({ limits: { maxHeapBytes } })
    // 64 for the Float32Array, 4000 for its buffer, and 64 for the view that shares it.
    const code = "Math.kept = new Float32Array(1000); Math.view = Math.kept.subarray(10); return 1"
    expect(await capped(4128).execute(code)).toMatchObject({ ok: true })
    expect(await capped(4127).execute(code)).toMatchObject({ ok: false, error: { kind: "MemoryLimitExceeded" } })
    expect(await capped(1_000_000).execute("const kept = []; while (true) kept.push(new Float64Array(1000))")).toMatchObject(
      { ok: false, error: { kind: "MemoryLimitExceeded" } },
    )
    expect(
      await value(
        capped(1_000_000),
        "let s = 0; for (let i = 0; i < 2000; i++) { const f = new Float64Array(1000); f[0] = i; s += f[0] } return s",
      ),
    ).toBe(1999000)
  })

  test("a host function borrows a typed array's bytes for the call, and returns bytes it owns", async () => {
    const seen: Array<string> = []
    const runtime = Runtime.make({
      globals: () => ({
        upload: Host.fn((views) => {
          let sum = 0
          for (const view of views as Array<ArrayBufferView | ArrayBuffer>) {
            seen.push(view.constructor.name)
            const bytes = view instanceof ArrayBuffer ? new Uint8Array(view) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
            for (const byte of bytes) sum += byte
          }
          return sum
        }),
        scale: Host.fn(([view, k]) => {
          const values = view as Float32Array
          for (let i = 0; i < values.length; i++) values[i] = values[i]! * (k as number)
        }),
        mesh: Host.fn(() => new Float32Array([1, 2, 3])),
        echo: Host.fn(([view]) => view),
      }),
    })
    // Read and written in place during the call, with no copy.
    expect(
      await value(
        runtime,
        "const f = new Float32Array([1, 2, 3, 4]); const sum = upload(f.subarray(1, 3)); scale(f, 10); return [sum, Array.from(f)]",
      ),
    ).toEqual([64 + 128, [10, 20, 30, 40]])
    // An ArrayBuffer and views of it in one call; a Uint8Array is the host's own copy.
    expect(
      await value(
        runtime,
        "const b = new ArrayBuffer(8); const f = new Float32Array(b); f[0] = 2; f[1] = 2; return upload(b, new Int32Array(b, 4), f)",
      ),
    ).toEqual(128 + 64 + 128)
    expect(seen.slice(-3)).toEqual(["ArrayBuffer", "Int32Array", "Float32Array"])
    // Bytes the host made become the program's; a typed array the call got is the program's buffer again.
    expect(
      await value(
        runtime,
        "const m = mesh(); m[1] = 7; return [m.constructor.name, Array.from(m), m.byteLength, m.buffer.byteLength]",
      ),
    ).toEqual(["Float32Array", [1, 7, 3], 12, 12])
    expect(
      await value(
        runtime,
        "const f = new Float32Array([1, 2, 3]); const r = echo(f.subarray(1)); r[0] = 9; return [r === f, r.buffer === f.buffer, Array.from(f), r.length]",
      ),
    ).toEqual([false, true, [1, 9, 3], 2])
  })

  test("a suspended run keeps its typed arrays and the buffers their views share", async () => {
    const make = (hang: boolean) =>
      Runtime.make({
        globals: () => ({
          step: Host.fn(() => (hang ? new Promise(() => {}) : 1), { type: "async", idempotent: true }),
        }),
      })
    const program = make(true).program(
      `const b = new ArrayBuffer(8); const f = new Float32Array(b); const u = new Uint8Array(b, 4); const s = f.subarray(1)
       f[0] = 1.5; await step(); s[0] = 2
       return [Array.from(f), Array.from(u), s.buffer === f.buffer, u.buffer === b, f.byteLength]`,
    )
    const running = program.run()
    await Bun.sleep(5)
    const suspended = await program.suspend()
    expect(await running).toBe(suspended)
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    expect(await make(false).resume(toBytes(suspended.state)).run()).toMatchObject({
      ok: true,
      value: [[1.5, 2], [0, 0, 0, 64], true, true, 8],
    })
  })
})
