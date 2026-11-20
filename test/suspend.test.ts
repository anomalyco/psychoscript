import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { Host, Runtime, toBytes } from "../src/effect/index.js"

// Suspending a run, saving its state, and resuming it in a brand-new runtime.

/** Runs a program in a fiber of its own: its outcome, and a way to suspend it. */
const background = <E>(program: Runtime.Program<never, E>) => {
  const fiber = Effect.runFork(program.run())
  return { program, result: Fiber.join(fiber), suspend: program.suspend() }
}

/** Why a suspend fails. */
const blocked = (execution: { readonly suspend: Effect.Effect<unknown, Runtime.SuspendError> }) =>
  Effect.runPromise(Effect.flip(execution.suspend))

/** A promise and its resolver, for host work a test finishes by hand. */
const latch = <A = void>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => (resolve = done))
  return { promise, resolve }
}

/** A host function that doubles `{ value }` and signals when called. */
const stepFn = () => {
  let called = latch()
  const fn = Host.fn(([input]) => {
    called.resolve()
    return { value: (input as { value: number }).value * 2 }
  })
  return {
    fn,
    called: () => called.promise,
    reset: () => {
      called = latch()
    },
  }
}

const stepRuntime = (step: ReturnType<typeof stepFn>, limits?: Runtime.Limits) =>
  Runtime.make({ globals: () => ({ step: step.fn }), limits })

const suspendedOf = (outcome: Runtime.Outcome): Runtime.Suspended => {
  if (outcome.ok !== "suspended") throw new Error(`expected a suspended run, got ${JSON.stringify(outcome)}`)
  return outcome
}

/** Runs `code` until `step` has completed and the VM is yielding at a slice boundary with no host call running. */
const suspendBetweenCalls = async (code: string) => {
  const step = stepFn()
  const run = background(stepRuntime(step).program(code))
  await step.called()
  await Bun.sleep(10)
  return { step, run }
}

describe("synchronous host calls", () => {
  // Each sync host call stops the VM; the slice clock must keep running across those stops, or a loop of them
  // never yields: suspend can't land and timeouts can't interrupt it.
  const counter = () => {
    let calls = 0
    const reached = latch()
    const draw = Host.fn(([n]) => {
      calls += 1
      if (calls === 500) reached.resolve()
      return n as number
    })
    return { draw, reached: () => reached.promise, calls: () => calls }
  }

  // Round-trip mode also yields at every host stop, where a suspend lands mid-call and is rightly refused.
  test.skipIf(process.env.PSYCHOSCRIPT_ROUNDTRIP === "1")(
    "a loop of sync host calls can be suspended and resumed",
    async () => {
      const draw = counter()
      const runtime = Runtime.make({ globals: () => ({ draw: draw.draw }) })
      const run = background(runtime.program("let n = 0\nwhile (n < 200000) draw(n++)\nreturn n"))
      await draw.reached()
      const suspended = suspendedOf(await Effect.runPromise(run.suspend))
      expect(draw.calls()).toBeLessThan(200000)
      const resumed = await Effect.runPromise(background(runtime.resume(toBytes(suspended.state))).result)
      expect(resumed).toMatchObject({ ok: true, value: 200000 })
    },
  )

  test("a loop of sync host calls is interrupted by the timeout", async () => {
    const draw = counter()
    const outcome = await Effect.runPromise(
      Runtime.make({ globals: () => ({ draw: draw.draw }), limits: { timeoutMs: 100 } }).execute(
        "let n = 0\nwhile (true) draw(n++)",
      ),
    )
    expect(outcome).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
  })
})

describe("suspend", () => {
  test("a run suspended while idle-awaiting between calls resumes from state and from bytes", async () => {
    const code = `
      const log = ["before"]
      const a = await step({ value: 20 })
      const started = Date.now()
      while (Date.now() - started < 300) await Promise.resolve()
      const b = await step({ value: 1 })
      log.push("after " + (a.value + b.value))
      console.log("resumed")
      return { log, total: a.value + b.value }`
    const { step, run } = await suspendBetweenCalls(code)
    const suspended = suspendedOf(await Effect.runPromise(run.suspend))
    // The run's own result is the same saved state.
    expect(suspendedOf(await Effect.runPromise(run.result))).toBe(suspended)

    for (const state of [suspended.state, toBytes(suspended.state)] as const) {
      const outcome = await Effect.runPromise(
        background(stepRuntime(step).resume(state)).result,
      )
      expect(outcome).toEqual({
        ok: true,
        value: { log: ["before", "after 42"], total: 42 },
        logs: ["resumed"],
        metadata: null,
      })
    }
  })

  test("a suspend after the run ended gives its result", async () => {
    const program = Runtime.make().program(`return 1 + 1`)
    expect(await Effect.runPromise(program.run())).toEqual({ ok: true, value: 2, metadata: null })
    expect(await Effect.runPromise(program.suspend())).toEqual({ ok: true, value: 2, metadata: null })
  })

  test("a program runs inline in the current fiber", async () => {
    const runtime = stepRuntime(stepFn())
    expect(
      await Effect.runPromise(runtime.program(`return (await step({ value: x })).value`, { bindings: { x: 21 } }).run()),
    ).toEqual({ ok: true, value: 42, metadata: null })
  })

  test("a suspend from another fiber stops a background run, which returns the same state", async () => {
    const runtime = Runtime.make()
    const code = `let n = 0; for (let i = 0; i < 2_000_000; i++) n = (n + i) % 1_000_003; return n`
    const expected = await Effect.runPromise(runtime.execute(code))
    const [suspended, outcome] = await Effect.runPromise(
      Effect.gen(function* () {
        const program = runtime.program(code)
        const fiber = yield* Effect.forkChild(program.run())
        // Issued before the run starts: it waits for it.
        const suspended = yield* program.suspend()
        return [suspended, yield* Fiber.join(fiber)] as const
      }),
    )
    expect(outcome).toBe(suspended)
    const fresh = Runtime.make()
    expect(await Effect.runPromise(fresh.resume(toBytes(suspendedOf(suspended).state)).run())).toEqual(
      expected,
    )
  })

  test("a program runs once", async () => {
    const program = Runtime.make().program(`return 1`)
    expect(await Effect.runPromise(program.run())).toMatchObject({ ok: true, value: 1 })
    const exit = await Effect.runPromise(Effect.exit(program.run()))
    expect(String(exit)).toContain("A program runs once")
  })

  test("interrupting run interrupts the program and its running calls", async () => {
    const called = latch()
    const interrupted = latch()
    const hang = Host.fn(() =>
      Effect.sync(() => called.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
      ),
    )
    const program = Runtime.make({ globals: () => ({ hang }) }).program(`return await hang({ value: 1 })`)
    const fiber = Effect.runFork(program.run())
    await called.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    await interrupted.promise
  })

  test("a state over the byte budget fails the suspend, and the run goes on", async () => {
    const { run } = await suspendBetweenCalls(
      `const big = "x".repeat(1000); await step({ value: 1 }); const t = Date.now(); while (Date.now() - t < 300) {} return big.length`,
    )
    const error = await blocked({ suspend: run.program.suspend({ maxBytes: 100 }) })
    expect(error.running).toEqual([])
    expect(error.message).toMatch(/^The run's state takes \d+ bytes, more than the 100-byte limit/)
    expect(await Effect.runPromise(run.result)).toMatchObject({ ok: true, value: 1000 })
  })

  test("a maxBytes that isn't a non-negative integer is rejected", () => {
    const program = Runtime.make().program("return 1")
    expect(() => program.suspend({ maxBytes: -1 })).toThrow(RangeError)
  })

  test("the snapshot codec does not import Effect", async () => {
    for (const file of ["codec.ts", "snapshot.ts"]) {
      expect(await Bun.file(path.join(import.meta.dir, "../src/snapshot", file)).text()).not.toMatch(
        /from "effect"/,
      )
    }
  })
})

describe("resume", () => {
  const suspendAt = async (code: string) => {
    const { step, run } = await suspendBetweenCalls(code)
    return { step, suspended: suspendedOf(await Effect.runPromise(run.suspend)) }
  }

  test("a run saved to a file resumes in another process", async () => {
    const step = stepFn()
    const run = background(
      stepRuntime(step).program(`
        const seen = new Map([["first", await step({ value: 10 })]])
        const started = Date.now()
        while (Date.now() - started < 300) {}
        const second = await step({ value: 21 })
        return [seen.get("first").value, second.value]`),
    )
    await step.called()
    await Bun.sleep(10)
    const suspended = suspendedOf(await Effect.runPromise(run.suspend))
    const file = path.join(tmpdir(), `psychoscript-${crypto.randomUUID()}.state`)
    await Bun.write(file, toBytes(suspended.state))
    try {
      const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/resume-process.ts"), file], {
        stdout: "pipe",
        stderr: "inherit",
      })
      const output = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      expect(JSON.parse(output)).toEqual({ ok: true, value: [20, 42], metadata: null })
    } finally {
      await Bun.file(file).delete()
    }
  })

  test("program state of every kind survives a suspend", async () => {
    const code = `
      const shared = { n: 1 }
      const map = new Map([[shared, "a"], ["k", shared]])
      const set = new Set([1, shared])
      const it = map.keys()
      it.next()
      const url = new URL("https://example.com/a?x=1")
      const params = url.searchParams
      const bytes = new Uint8Array([1, 2, 3, 4])
      const view = bytes.subarray(1, 3)
      const re = /a(b)/g
      re.test("abab")
      const date = new Date(0)
      const weak = new WeakMap([[shared, 5]])
      function* counter() { let i = 0; while (true) yield i++ }
      const gen = counter()
      gen.next()
      const bound = ((a, b) => a + b).bind(null, 10)
      const sparse = []
      sparse[5000] = "far"
      const pending = new Promise((resolve) => (globalResolve = resolve))
      var globalResolve
      Array.prototype.extra = "patched"
      await step({ value: 1 })
      const t = Date.now()
      while (Date.now() - t < 300) {}
      params.append("y", "2")
      view[0] = 9
      globalResolve("later")
      return {
        same: map.get("k") === shared && set.has(shared) && weak.get(shared) === 5,
        next: it.next().value,
        url: url.href,
        bytes: [...bytes],
        lastIndex: re.lastIndex,
        date: date.getTime(),
        gen: [gen.next().value, gen.next().value],
        bound: bound(5),
        sparse: [5001, "far", false],
        pending: await pending,
        extra: [].extra,
        negative: Object.is(-0, -0 * 1),
      }`
    const { step, suspended } = await suspendAt(code)
    const outcome = await Effect.runPromise(
      background(stepRuntime(step).resume(toBytes(suspended.state))).result,
    )
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        same: true,
        next: "k",
        url: "https://example.com/a?x=1&y=2",
        bytes: [1, 9, 3, 4],
        lastIndex: 2,
        date: 0,
        gen: [1, 2],
        bound: 15,
        sparse: [5001, "far", false],
        pending: "later",
        extra: "patched",
        negative: true,
      },
    })
  })

  test("changes to built-ins survive a second suspend, including freeze, seal, and deletes", async () => {
    const code = `
      Array.prototype.extra = "patched"
      delete Math.max
      Object.freeze(JSON)
      Object.seal(Number.prototype)
      Object.preventExtensions(Date.prototype)
      await step({ value: 1 })
      const t1 = Date.now()
      while (Date.now() - t1 < 300) {}
      await step({ value: 2 })
      const t2 = Date.now()
      while (Date.now() - t2 < 300) {}
      return {
        extra: [].extra,
        max: typeof Math.max,
        frozen: Object.isFrozen(JSON),
        sealed: Object.isSealed(Number.prototype) && !Object.isFrozen(Number.prototype),
        extensible: Object.isExtensible(Date.prototype),
        untouched: Object.isExtensible(Map.prototype) && typeof Math.min,
      }`
    const { step, suspended } = await suspendAt(code)
    step.reset()
    const runtime = stepRuntime(step)
    const again = background(runtime.resume(toBytes(suspended.state)))
    await step.called()
    await Bun.sleep(10)
    // Nothing changed a built-in since the first resume: the second state keeps what changed before.
    const second = suspendedOf(await Effect.runPromise(again.suspend))
    const outcome = await Effect.runPromise(background(runtime.resume(toBytes(second.state))).result)
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        extra: "patched",
        max: "undefined",
        frozen: true,
        sealed: true,
        extensible: false,
        untouched: "function",
      },
    })
  })
})
