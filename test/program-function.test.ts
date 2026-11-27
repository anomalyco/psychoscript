import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Host, ProgramFunction, Runtime, toBytes } from "../src/effect/index.js"

// A host function that takes functions gets a function the program wrote as a ProgramFunction: its source text and
// the names from outside it that it uses.

const run = (code: string, globals: Record<string, unknown>, translate?: Runtime.Translate) =>
  Effect.runPromise(Runtime.make({ globals: () => globals, ...(translate && { translate }) }).execute(code))

const recorder = () => {
  const calls: Array<ReadonlyArray<unknown>> = []
  return { calls, fn: Host.fn((args) => void calls.push(args), { takesFunctions: true }) }
}

const plain = (value: unknown): unknown => {
  if (value instanceof ProgramFunction) return { source: value.source, captures: [...value.captures] }
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}

describe("ProgramFunction", () => {
  test("is what a function that takes functions gets, where another one drops it", async () => {
    const define = recorder()
    const other: Array<unknown> = []
    const outcome = await run(
      `
        define({ name: "double", run: async (input) => { return input.days * 2 } })
        other({ name: "double", run: async (input) => { return input.days * 2 } })
        return "done"
      `,
      { define: define.fn, other: Host.fn((args) => void other.push(...args)) },
      { functions: "drop", promises: "await" },
    )
    expect(outcome).toMatchObject({ ok: true, value: "done" })
    const [spec] = define.calls[0] as [{ name: string; run: ProgramFunction }]
    expect(spec.run).toBeInstanceOf(ProgramFunction)
    expect(Object.isFrozen(spec.run) && Object.isFrozen(spec.run.captures)).toBe(true)
    expect("call" in spec.run).toBe(false)
    expect(plain(spec)).toEqual({
      name: "double",
      run: { source: "async (input) => { return input.days * 2 }", captures: [] },
    })
    expect(other).toEqual([{ name: "double" }])
  })

  test("lists the names from outside the function that it uses", async () => {
    const take = recorder()
    const outcome = await run(
      `
        const rate = 2
        let ünïcode = 1
        function helper(x) { return x }
        function fact(n) { return n ? n * fact(n - 1) : 1 }
        const o = { m() { return this.x + arguments.length }, get g() { return rate } }
        function outer() { return () => [this, arguments, rate] }
        class B { m() { return 1 } }
        class A extends B { m() { return () => super.m() } }
        take(
          (input) => input.days * rate + helper(1) + Math.max(1) + ünïcode,
          fact,
          o.m,
          Object.getOwnPropertyDescriptor(o, "g").get,
          outer(),
          new A().m(),
          function named() { return named },
          (a, { b } = {}, ...rest) => { let c = a; return [b, c, rest] },
          (x) => { const inner = () => rate; return inner },
          () => typeof undeclared,
          function* gen() { yield helper },
        )
        return "done"
      `,
      { take: take.fn },
    )
    expect(outcome).toMatchObject({ ok: true })
    expect((take.calls[0] as ReadonlyArray<ProgramFunction>).map((f) => f.captures)).toEqual([
      ["helper", "rate", "ünïcode"],
      [],
      [],
      ["rate"],
      ["arguments", "rate", "this"],
      ["super", "this"],
      [],
      [],
      ["rate"],
      [],
      ["helper"],
    ])
  })

  test("fails the call for a built-in or bound function or a class, and still passes host functions back", async () => {
    const read = () => "called"
    const seen: Array<unknown> = []
    const globals = {
      open: Host.fn(() => ({ read })),
      double: Host.fn(([n]) => n * 2),
      take: Host.fn((args) => void seen.push(...args), { takesFunctions: true }),
    }
    const failures = await run(
      `
        class A {}
        const errors = []
        for (const f of [Math.max, ((x) => x).bind(null), A])
          try { take(f) } catch (e) { errors.push(e.message) }
        take({ read: open().read, run: () => 2, double })
        return errors
      `,
      globals,
      { functions: "drop" },
    )
    expect(failures).toMatchObject({
      ok: true,
      value: [
        "Argument 1 to take contains a built-in function, which cannot be passed to the host; only a function written in the program can.",
        "Argument 1 to take contains a bound function, which cannot be passed to the host; only a function written in the program can.",
        "Argument 1 to take contains a class, which cannot be passed to the host; only a function written in the program can.",
      ],
    })
    // A host function that isn't one of its results is left to the runtime's translation, here dropped.
    expect(plain(seen)).toEqual([{ read, run: { source: "() => 2", captures: [] } }])
  })

  test("leaves functions that don't take functions to the runtime's translation", async () => {
    const outcome = await run(`other(() => 1)`, { other: Host.fn(() => 1) })
    expect(outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Argument 1 to other contains a function, which cannot be passed to the host.") },
    })
  })

  test("can't be handed back to the program", async () => {
    const outcome = await run(`return echo(() => 1)`, { echo: Host.fn(([f]) => f, { takesFunctions: true }) })
    expect(outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("echo produced a ProgramFunction, which the program cannot hold.") },
    })
  })

  test("is kept by a run saved during the call, and the resumed call gets it again", async () => {
    let started!: () => void
    const reached = new Promise<void>((done) => (started = done))
    const seen: Array<unknown> = []
    let resumed = false
    const globals = () => ({
      hold: Host.fn(
        ([f]) =>
          Effect.suspend(() => {
            seen.push(f)
            if (resumed) return Effect.succeed(1)
            started()
            return Effect.never
          }),
        { type: "async", idempotent: true, takesFunctions: true },
      ),
    })
    const program = Runtime.make({ globals }).program(`
      const rate = 3
      await hold((x) => x * rate)
      return "done"
    `)
    const fiber = Effect.runFork(program.run())
    await reached
    await Bun.sleep(10)
    const suspended = await Effect.runPromise(program.suspend())
    await Effect.runPromise(Fiber.interrupt(fiber))
    if (suspended.ok !== "suspended") throw new Error(`expected a suspended run, got ${JSON.stringify(suspended)}`)
    resumed = true
    const done = await Effect.runPromise(Runtime.make({ globals }).resume(toBytes(suspended.state)).run())
    expect(done).toMatchObject({ ok: true, value: "done" })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBeInstanceOf(ProgramFunction)
    expect(plain(seen)).toEqual([
      { source: "(x) => x * rate", captures: ["rate"] },
      { source: "(x) => x * rate", captures: ["rate"] },
    ])
  })
})
