import { describe, expect, test } from "bun:test"
import { Host, Runtime, toBytes } from "../src/index.js"

// `limits.maxHeapBytes`: a run stops with `MemoryLimitExceeded` once what it can still reach is over the limit, in the
// size model of src/runtime/heap.ts; garbage never counts.

const capped = (maxHeapBytes: number) => Runtime.make({ limits: { maxHeapBytes } })

const kind = async (runtime: Runtime.Runtime, code: string) => {
  const result = await runtime.execute(code)
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`)
  return result.error.kind
}

describe("maxHeapBytes", () => {
  test("must be a safe integer of at least 1", () => {
    for (const maxHeapBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => capped(maxHeapBytes)).toThrow("maxHeapBytes must be a safe integer greater than or equal to 1.")
    }
  })

  test("a growing heap stops the run, and no handler sees it", async () => {
    const result = await capped(1_000_000).execute(
      "console.log('start'); try { const a = []; while (true) a.push({ n: a.length }) } catch (e) { return 'caught' } finally { console.log('finally') }",
    )
    expect(result).toEqual({
      ok: false,
      error: { kind: "MemoryLimitExceeded", message: "Execution exceeded its memory limit of 1000000 bytes." },
      logs: ["start"],
      metadata: null,
    })
    for (const code of [
      "const m = new Map(); for (let i = 0; ; i++) m.set('k' + i, i)",
      "let s = ''; for (let i = 0; ; i++) s += 'abcdefgh'",
      "const a = []; while (true) { a.push(new Array(100)); await null }",
      "const o = {}; for (let i = 0; ; i++) o['k' + i] = i",
    ]) {
      expect(await kind(capped(1_000_000), code)).toBe("MemoryLimitExceeded")
    }
  })

  test("garbage does not count", async () => {
    const runtime = capped(1_000_000)
    expect(
      await runtime.execute(
        "let n = 0; for (let i = 0; i < 100000; i++) { const o = { i, s: 'x' + i, a: [i, i, i] }; n += o.a.length } return n",
      ),
    ).toMatchObject({ ok: true, value: 300000 })
    expect(
      await runtime.execute(
        "let kept = []; for (let round = 0; round < 20; round++) { kept = []; for (let i = 0; i < 5000; i++) kept.push({ round, i }) } return kept.length",
      ),
    ).toMatchObject({ ok: true, value: 5000 })
  })

  test("the heap is measured in the shared size model", async () => {
    // An array of 1000 holes: 64 bytes for the object and 16 per element, all the run keeps when it ends.
    const holes = "Math.kept = new Array(1000); return 1"
    expect(await capped(16_064).execute(holes)).toMatchObject({ ok: true })
    expect(await kind(capped(16_063), holes)).toBe("MemoryLimitExceeded")
    // A string counts once however often it is kept: 16 bytes and 2 per code unit.
    const shared = "Math.kept = new Array(1000).fill('y'.repeat(100000)); return 1"
    expect(await capped(216_080).execute(shared)).toMatchObject({ ok: true })
    expect(await kind(capped(216_079), shared)).toBe("MemoryLimitExceeded")
    // The value a run returns is measured when it ends.
    expect(await kind(capped(1_000_000), "return 'x'.repeat(600000)")).toBe("MemoryLimitExceeded")
    expect(await capped(1_000_000).execute("return 'x'.repeat(400000)")).toMatchObject({ ok: true })
  })

  test("the body's own bindings count as it ends", async () => {
    const holes = "const kept = new Array(1000); return 1"
    expect(await capped(16_064).execute(holes)).toMatchObject({ ok: true, value: 1 })
    expect(await kind(capped(16_063), holes)).toBe("MemoryLimitExceeded")
    for (const code of [
      "const kept = []; for (let i = 0; i < 16; i++) kept.push(new Array(1 << 16).fill(i)); return kept.length",
      "const block = 'x'.repeat(1 << 15); const kept = []; for (let i = 0; i < 128; i++) kept.push(block + i); return kept.length",
      "const kept = []; await (async () => { await 0; kept.push(new Array(1 << 18)) })(); return kept.length",
    ]) {
      expect(await kind(capped(4_000_000), code)).toBe("MemoryLimitExceeded")
    }
  })

  test("bulk growth is charged as it happens", async () => {
    // Each grows its heap far over the limit and lets it go before it ends: only a measurement on the way stops it.
    const big = "const big = new Array(4096).fill(0)"
    const block = "const block = 'x'.repeat(32768)"
    const props = "const props = {}; for (let k = 0; k < 2048; k++) props['p' + k] = k"
    for (const [setup, grown] of [
      [block, "block + i"],
      [block, "`${block}${i}`"],
      [big, "[...big]"],
      [big, "(() => { const t = []; t.push(...big); return t })()"],
      [big, "(() => { const t = []; t.unshift(...big); return t })()"],
      [big, "(() => { const t = []; t.splice(0, 0, ...big); return t })()"],
      ["", "(() => { const t = []; t.length = 4096; return t })()"],
      ["", "(() => { const t = []; t[4095] = i; return t })()"],
      [props, "Object.assign({}, props)"],
      [props, "({ ...props })"],
    ]) {
      const code = `${setup}; let keep = []; for (let i = 0; i < 2048; i++) keep.push(${grown}); keep = null; return 1`
      expect(await kind(capped(4_194_304), code)).toBe("MemoryLimitExceeded")
    }
  })

  test("a run handing calls to the host is measured too, before they start", async () => {
    const started: Array<string> = []
    const runtime = Runtime.make({
      limits: { maxHeapBytes: 1_000_000 },
      globals: () => ({ later: Host.fn(async () => (started.push("later"), 1), { type: "async" }) }),
    })
    expect(await kind(runtime, "const a = new Array(100000); await later(); return a.length")).toBe(
      "MemoryLimitExceeded",
    )
    expect(started).toEqual([])
  })

  test("no limit by default", async () => {
    expect(
      await Runtime.make().execute("const a = []; for (let i = 0; i < 100000; i++) a.push({ i }); return a.length"),
    ).toMatchObject({ ok: true, value: 100000 })
  })

  test("a resumed run keeps its limit", async () => {
    const make = (limits: Runtime.Options["limits"], hang: boolean) =>
      Runtime.make({
        limits,
        globals: () => ({
          step: Host.fn(() => (hang ? new Promise(() => {}) : 1), { type: "async", idempotent: true }),
        }),
      })
    const program = make({ maxHeapBytes: 1_000_000 }, true).program(
      "const kept = []; for (let i = 0; i < 1000; i++) kept.push({ i }); await step(); while (true) kept.push({})",
    )
    const running = program.run()
    await Bun.sleep(5)
    const suspended = await program.suspend()
    expect(await running).toBe(suspended)
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    expect(suspended.state.header.limits).toEqual({ timeoutMs: null, maxOutputBytes: null, maxHeapBytes: 1_000_000 })
    // A runtime without limits resumes it with the ones it was saved with.
    expect(await make(undefined, false).resume(toBytes(suspended.state)).run()).toMatchObject({
      ok: false,
      error: { kind: "MemoryLimitExceeded", message: "Execution exceeded its memory limit of 1000000 bytes." },
    })
  })
})
