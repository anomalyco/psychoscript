import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { Host, Runtime } from "../src/effect/index.js"
import { MAX_ARRAY_LENGTH, MAX_PENDING_PROMISES, MAX_STRING_LENGTH } from "../src/runtime/limits.js"
import { toBytes } from "../src/snapshot/snapshot.js"

const runtime = Runtime.make()

const value = async (code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const logs = async (code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.logs ?? []
}

const failure = async (code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error.message
}

const S = MAX_STRING_LENGTH
const A = MAX_ARRAY_LENGTH

describe("one built-in cannot build an unbounded value", () => {
  test("strings: repeat, pad, concat, join, +, template, JSON.stringify", async () => {
    expect(await value(`return "x".repeat(${S}).length`)).toBe(S)
    for (const code of [
      `"x".repeat(${S + 1})`,
      `"x".padStart(${S + 1})`,
      `"x".padEnd(${S + 1}, "y")`,
      `"x".repeat(${S}).concat("y")`,
      `["x".repeat(${S}), "y"].join("")`,
      `"x".repeat(${S}) + "y"`,
      `\`\${"x".repeat(${S})}y\``,
      `JSON.stringify("x".repeat(${S}))`,
    ]) {
      expect(await failure(`try { ${code} } catch (e) { throw Error(e.name + ": " + e.message) }`)).toContain(
        "RangeError: Invalid string length",
      )
    }
  })

  // split and matchAll share the same result check but must build ten million items first to reach it,
  // which is too slow for CI; flat() over MAX_ARRAY_LENGTH (10M) elements still needs a 15s budget on Windows.
  test("arrays: constructor, length, Array.from, concat, flat", async () => {
    expect(await value(`return Array(${A}).length`)).toBe(A)
    for (const code of [
      `Array(${A + 1})`,
      `const a = []; a.length = ${A + 1}`,
      `Array.from({ length: ${A + 1} })`,
      `Array(${A}).concat([1])`,
      `[Array(${A}).fill(0), [1]].flat()`,
    ]) {
      expect(await failure(`try { ${code} } catch (e) { throw Error(e.name + ": " + e.message) }`)).toContain(
        "RangeError: Invalid array length",
      )
    }
  }, 15_000)

  test("promises: too many pending at once, while settled ones do not count", async () => {
    const n = MAX_PENDING_PROMISES
    expect(await value(`for (let i = 0; i < ${n * 2}; i++) Promise.resolve(i); return 1`)).toBe(1)
    expect(
      await failure(
        `try { for (let i = 0; i <= ${n}; i++) new Promise(() => {}) } catch (e) { throw Error(e.name + ": " + e.message) }`,
      ),
    ).toContain("RangeError: Too many pending promises")
    expect(await failure(`await Promise.all(Array(${n + 1}).fill(0).map(() => new Promise(() => {})))`)).toContain(
      "Too many pending promises",
    )
  }, 10_000)
})

// Arrays and objects that share parts: n doublings make a text 2^n times longer than the n arrays holding it. Each case
// was one native step that took seconds or more (exponential in n) and built strings past the limit.
describe("values that share parts", () => {
  const shared = (depth: number, item = "1") => `let a = [${item}]; for (let i = 0; i < ${depth}; i++) a = [a, a];`
  const quick = async (code: string, expected: string) => {
    const started = performance.now()
    expect(await failure(`${code}; try { ${expected} } catch (e) { throw Error(e.name + ": " + e.message) }`)).toContain(
      "RangeError: Invalid string length",
    )
    expect(performance.now() - started).toBeLessThan(2_000)
  }

  test("an array's text is measured before it is built", async () => {
    for (const use of ["new URLSearchParams({ a }).toString()", "encodeURIComponent(a)"]) {
      await quick(shared(40), use)
      // 2^22 ones and the commas between them (each encoded as %2C) fit, just: 2^24 characters or less.
      expect(await value(`${shared(22)} return ${use}.length`)).toBe(use.startsWith("new") ? S - 1 : S - 3)
    }
    // A long text recurring at every level of a chain of distinct arrays is written once, not once per array.
    expect(await value(`let a = ["x".repeat(1e6)]; for (let i = 0; i < 2000; i++) a = [a, 1]; return encodeURI(a).length`)).toBe(
      1_004_000,
    )
    expect(
      await value(`return decodeURIComponent(encodeURIComponent([[1, [2, 3]], null, undefined, [], [[]], "x", 10n, [[[5]]], [[6, [7]]]]))`),
    ).toBe("1,2,3,,,,,x,10,5,6,7")
  })

  test("console.log refuses a message past the string limit before building it", async () => {
    await quick(shared(40), "console.log(a)")
    await quick(shared(40, "{}"), "console.log({ a, b: [a] })")
    await quick(`const s = "x".repeat(${S / 2})`, "console.log(s, s, s)")
    await quick(`const s = "x".repeat(${S / 2})`, "console.log('%s', s, s)")
    await quick(`const s = "x".repeat(${S / 2}); console.time("t")`, "console.timeLog('t', s, s)")
    // Shared parts show in full wherever they recur, as before.
    expect(await logs(`${shared(2)} console.log(a, [a])`)).toEqual(["[[[1],[1]],[[1],[1]]] [[[[1],[1]],[[1],[1]]]]"])
  })

  test("console.log shows cycles the same wherever an object recurs", async () => {
    expect(
      await logs(`const m = new Map(); const s = new Set([m]); m.set(1, s); console.log([s, m], s); console.log({ a: m, b: [m, s] })`),
    ).toEqual([
      "[Set(1) [Map(1) [[1,[Circular]]]],Map(1) [[1,Set(1) [[Circular]]]]] Set(1) [Map(1) [[1,[Circular]]]]",
      '{"a":Map(1) [[1,Set(1) [[Circular]]]],"b":[Map(1) [[1,Set(1) [[Circular]]]],Set(1) [Map(1) [[1,[Circular]]]]]}',
    ])
    // Objects shared deeper than the depth limit, with and without a cycle behind it.
    expect(await logs(`${shared(40)} const b = [a]; try { console.log(b) } catch { console.log("long") }`)).toEqual(["long"])
    const chain = (length: number) =>
      logs(`const m = new Map(); let x = [m]; for (let i = 0; i < ${length}; i++) x = [x, x]; m.set(1, x); console.log(m)`)
    expect((await chain(10))[0]!.split("[Circular]").length).toBe(2 ** 10 + 1)
    // Shared arrays on a cycle, and deeper than the depth limit: refused as quickly.
    await quick(`const m = new Map(); let x = [m]; for (let i = 0; i < 40; i++) x = [x, x]; m.set(1, x)`, "console.log(m)")
    await quick(
      `const m = new Map(); let x = new Map([[0, m]]); for (let i = 0; i < 30; i++) x = new Map([[0, m], [1, x], [2, x]]); m.set(0, x)`,
      "console.log(m)",
    )
  })

  test("console.group's indent is counted before a line is indented", async () => {
    await quick(`for (let i = 0; i < 5000; i++) console.group()`, `console.log("\\n".repeat(4000))`)
    expect(await logs(`console.group("g"); console.log("a\\nb\\r\\nc"); console.groupEnd(); console.log("z")`)).toEqual([
      "g",
      "  a\n  b\r  \n  c",
      "z",
    ])
  })

  test("console.table refuses a table past the string limit before building its rows", async () => {
    await quick(`const rows = []; for (let i = 0; i < 5000; i++) rows.push({ ["k" + i]: i })`, "console.table(rows)")
    await quick(
      `const columns = Array.from({ length: 5000 }, (_, i) => "k" + i); const rows = Array(5000).fill({})`,
      "console.table(rows, columns)",
    )
    await quick(`${shared(30)} const rows = [{ a }, { a }]`, "console.table(rows)")
  })
})

describe("logs past the output limit", () => {
  const limited = Runtime.make({ limits: { maxOutputBytes: 100 } })
  const run = (code: string) => Effect.runPromise(limited.execute(code))

  test("are counted, and the result is as it always was", async () => {
    expect(await run(`for (let i = 0; i < 1000; i++) console.log("x".repeat(30)); return 1`)).toMatchObject({
      logs: ["x".repeat(30), "x".repeat(30), "x".repeat(30), "[logs truncated: showing 3 of 1000 lines]"],
      truncated: true,
    })
    expect(await run(`for (let i = 0; i < 1000; i++) console.log("é".repeat(i % 7)); return "v"`)).toMatchObject({
      logs: ["", "é", "éé", "ééé", "éééé", "ééééé", "éééééé", "", "é", "éé", "ééé", "éééé", "ééééé", "[logs truncated: showing 13 of 1000 lines]"],
    })
    expect(await run(`console.log("x".repeat(500)); console.log("y"); throw new Error("no")`)).toMatchObject({
      ok: false,
      logs: ["[logs truncated: showing 0 of 2 lines]"],
    })
  })

  test("are not kept while the run goes on, so a saved run stays small", async () => {
    const runtime = Runtime.make({ limits: { maxOutputBytes: 1024 } })
    const program = runtime.program(
      `for (let i = 0; i < 500; i++) console.log(String(i).repeat(2000)); let n = 0; while (n < 1e9) n++; return n`,
    )
    const run = Effect.runPromise(program.run())
    await new Promise((done) => setTimeout(done, 100))
    const suspended = await Effect.runPromise(program.suspend())
    await run
    if (suspended.ok !== "suspended") throw new Error("the run ended before it could be suspended")
    expect(toBytes(suspended.state).byteLength).toBeLessThan(100_000)
  })
})

describe("the host stays in control", () => {
  test("other host work keeps running while one long job runs", async () => {
    // Once the loop starts, the runner yields to the host every millisecond, so the host takes its 20 turns within
    // about 20 slices: at most about a million iterations on a fast machine, far short of the job's 30 million. A job
    // that kept the thread would finish first. Counting turns instead of timing them keeps this independent of how
    // fast the loop runs, and waiting for the start keeps a cold engine's setup out of the count.
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const job = yield* Effect.forkChild(
          Runtime.make({
            globals: () => ({ host: { started: Host.fn(() => Deferred.succeed(started, undefined)) } }),
          }).execute(
            `await host.started({}); let t = 0; for (let i = 0; i < 30_000_000; i++) t += i % 3; return t`,
          ),
        )
        yield* Deferred.await(started)
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        yield* Fiber.interrupt(job)
        return yield* Fiber.await(job)
      }),
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  // Each case would run for seconds or forever; the timeout must still stop it promptly.
  test.each([
    ["a loop of only built-in calls", `return Iterator.from({ next: Object }).drop(Infinity).next()`],
    [
      "serializing shared references",
      `let a = [0]; for (let i = 0; i < 24; i++) a = [a, a]; return JSON.stringify(a).length`,
    ],
    ["copying out shared references", `let a = [0]; for (let i = 0; i < 24; i++) a = [a, a]; return a`],
    [
      "reporting many unhandled rejections",
      `const a = Array(10_000).fill(0); for (let i = 0; i < 20_000; i++) Promise.reject(a); return 1`,
    ],
  ])("%s still times out", async (_, code) => {
    const result = await Effect.runPromise(Runtime.make({ limits: { timeoutMs: 100 } }).execute(code))
    expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
  })

  test("nesting deeper than the host stack fails cleanly, and the next run is unaffected", async () => {
    expect(await failure(`const f = () => f; f${"()".repeat(100_000)}; return 1`)).toBe(
      "Execution exceeded the maximum nesting depth.",
    )
    expect(await value(`const f = () => f; f${"()".repeat(500)}; return 1`)).toBe(1)
  })
})
