import { describe, expect, test } from "bun:test"
import { Host, type Json, Runtime, toBytes } from "../src/index.js"

// `limits.maxValueDepth`: how deep a value may nest where it crosses between the program and the host (the result, a
// host call's arguments and what it returns) and where `JSON.stringify` copies it. 32 by default, at most 256.

/** A program value `n` levels deep: objects and arrays in turn around a number. */
const deep = "const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v };"

/** The same as host data. */
const hostDeep = (n: number): Json => {
  let v: Json = 0
  for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }
  return v
}

const make = (maxValueDepth?: number) => {
  const taken: Array<unknown> = []
  const runtime = Runtime.make({
    ...(maxValueDepth === undefined ? {} : { limits: { maxValueDepth } }),
    globals: () => ({
      take: Host.fn(([v]) => void taken.push(v)),
      give: Host.fn(([n]) => hostDeep(n as number)),
    }),
  })
  return { runtime, taken }
}

/** A run under `maxValueDepth`, suspended while its idempotent `wait(v)` hangs; `seen` gets what `wait` got. */
const suspend = async (maxValueDepth: number, code: string, seen: Array<unknown>) => {
  const { promise: called, resolve } = Promise.withResolvers<void>()
  const program = Runtime.make({
    limits: { maxValueDepth },
    globals: () => ({
      wait: Host.fn(([v]) => (seen.push(v), resolve(), new Promise(() => {})), { type: "async", idempotent: true }),
    }),
  }).program(code)
  const running = program.run()
  await called
  const suspended = await program.suspend()
  expect(await running).toBe(suspended)
  if (!("state" in suspended)) throw new Error("expected a suspended run")
  return suspended
}

const message = async (runtime: Runtime.Runtime, code: string) => {
  const result = await runtime.execute(code)
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`)
  return result.error.message
}

describe("maxValueDepth", () => {
  test("must be an integer from 1 to 256", () => {
    for (const maxValueDepth of [0, -1, 1.5, 257, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => make(maxValueDepth)).toThrow("maxValueDepth must be an integer from 1 to 256.")
    }
    for (const maxValueDepth of [1, 32, 256]) expect(() => make(maxValueDepth)).not.toThrow()
  })

  test("is 32 by default, as before", async () => {
    const { runtime, taken } = make()
    expect(await runtime.execute(`${deep} take(deep(32)); give(32); return deep(32)`)).toMatchObject({ ok: true })
    expect(taken).toEqual([hostDeep(32)])
    expect(await message(runtime, `${deep} take(deep(33))`)).toContain(
      "TypeError: Argument 1 to take exceeds the maximum value depth of 32.",
    )
    expect(await message(runtime, `${deep} return deep(33)`)).toBe("RangeError: Value exceeds the maximum depth of 32.")
  })

  test("a value N deep crosses each way, and one N + 1 deep fails", async () => {
    for (const n of [1, 5, 200, 256]) {
      const { runtime, taken } = make(n)
      expect(await runtime.execute(`${deep} take(deep(${n})); const g = give(${n}); return deep(${n})`)).toEqual({
        ok: true,
        value: hostDeep(n),
        metadata: null,
      })
      expect(taken).toEqual([hostDeep(n)])
      expect(await message(runtime, `${deep} take(deep(${n + 1}))`)).toContain(
        `TypeError: Argument 1 to take exceeds the maximum value depth of ${n}.`,
      )
      expect(await message(runtime, `${deep} give(${n + 1})`)).toMatch(
        new RegExp(`^TypeError: give\\S* exceeds the maximum value depth of ${n}\\.`),
      )
      expect(await message(runtime, `${deep} return deep(${n + 1})`)).toBe(
        `RangeError: Value exceeds the maximum depth of ${n}.`,
      )
      expect(await runtime.execute(`${deep} return JSON.stringify(deep(${n})).length`)).toMatchObject({ ok: true })
      expect(await message(runtime, `${deep} return JSON.stringify(deep(${n + 1}))`)).toContain(
        `RangeError: Value exceeds the maximum depth of ${n}.`,
      )
    }
  })

  test("the walk a result takes for a promise or a toJSON allows the limit, and at least 100", async () => {
    expect(
      await make(200).runtime.execute(`${deep} return [Promise.resolve(1), { toJSON: () => deep(198) }]`),
    ).toEqual({ ok: true, value: [1, hostDeep(198)], metadata: null })
    expect(await message(make(200).runtime, `${deep} return [Promise.resolve(1), deep(200)]`)).toBe(
      "RangeError: Value exceeds the maximum depth of 200.",
    )
    expect(await make(4).runtime.execute(`${deep} return [Promise.resolve(1), deep(99)]`)).toMatchObject({ ok: true })
    expect(await message(make(4).runtime, `${deep} return [Promise.resolve(1), deep(100)]`)).toBe(
      "RangeError: Value exceeds the maximum depth of 100.",
    )
  })

  test("a resumed run keeps its limit, and a deep argument is saved with the call", async () => {
    const seen: Array<unknown> = []
    const suspended = await suspend(200, `${deep} await wait(deep(200)); return deep(200)`, seen)
    expect(suspended.state.header.limits).toEqual({ timeoutMs: null, maxOutputBytes: null, maxValueDepth: 200 })
    // A runtime with the default resumes it with the depth it was saved with.
    const resumed = Runtime.make({
      globals: () => ({ wait: Host.fn(([v]) => (seen.push(v), 1), { type: "async", idempotent: true }) }),
    })
    expect(await resumed.resume(toBytes(suspended.state)).run()).toEqual({
      ok: true,
      value: hostDeep(200),
      metadata: null,
    })
    // Every call got the whole argument: before the suspend, and again on resume (more often in round-trip mode).
    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const v of seen) expect(v).toEqual(hostDeep(200))
  })

  test("a saved depth past the bound is refused", async () => {
    const suspended = await suspend(4, `await wait(1)`, [])
    const state = JSON.parse(JSON.stringify(suspended.state))
    state.header.limits.maxValueDepth = 257
    await expect(Runtime.make().resume(state).run()).rejects.toMatchObject({
      name: "SnapshotError",
      message: "Invalid snapshot: the value depth 257 is not an integer from 1 to 256.",
    })
  })
})
