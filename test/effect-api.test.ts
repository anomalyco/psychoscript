import { describe, expect, test } from "bun:test"
import { Context, Data, Effect, Exit, Fiber, Layer, References } from "effect"
import { Host, Runtime } from "../src/effect/index.js"

class Counter extends Context.Service<Counter, { readonly next: () => number }>()("Counter") {}
class NotFound extends Data.TaggedError("NotFound")<{ readonly message: string }> {}

const counter = () => {
  let n = 0
  return { next: () => ++n }
}
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Effect API", () => {
  test("a host function keeps its own name and length, as through the Promise API", async () => {
    const runtime = Runtime.make({
      globals: () => ({
        double: Host.fn(([n]: ReadonlyArray<number>) => n * 2),
        named: Host.fn(function given(_args: ReadonlyArray<unknown>) {
          return Effect.succeed(1)
        }),
        none: Host.fn(() => Effect.succeed(0)),
      }),
    })
    expect(
      await run(runtime.execute("return [double.name, double.length, named.name, named.length, none.name, none.length]")),
    ).toMatchObject({ ok: true, value: ["double", 1, "given", 1, "none", 0] })
  })

  test("services reach host functions in execute, run and resume", async () => {
    const make = () =>
      Runtime.make({
        globals: () => ({
          next: Host.fn(() => Effect.map(Counter, (c) => c.next()), { type: "async", idempotent: true }),
        }),
      })
    const runtime = make()
    expect(await run(Effect.provideService(runtime.execute("return [await next(), await next()]"), Counter, counter()))).toMatchObject({ value: [1, 2] })
    expect(await run(Effect.provide(runtime.program("return await next()").run(), Layer.succeed(Counter)(counter())))).toMatchObject({ value: 1 })

    const program = Runtime.make({
      globals: () => ({ next: Host.fn(() => Effect.never, { type: "async", idempotent: true }) }),
    }).program("return (await next()) + 10", { runId: "r" })
    const suspended = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(program.run())
        yield* Effect.sleep(5)
        const outcome = yield* program.suspend()
        yield* Fiber.join(fiber)
        return outcome
      }),
    )
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    expect(await run(Effect.provideService(make().resume(suspended.state).run(), Counter, counter()))).toMatchObject({ value: 11 })
  })

  test("services reach durable start, wait and cancel", async () => {
    const seen: Array<string> = []
    const tag = (part: string) => Effect.map(Counter, (c) => void seen.push(part + c.next()))
    const runtime = Runtime.make({
      globals: () => ({
        job: Host.durableFn({
          start: () => Effect.as(tag("start"), "d"),
          wait: (data) => Effect.as(tag("wait"), data),
          cancel: () => tag("cancel"),
        }),
        hang: Host.durableFn({
          start: () => Effect.as(tag("start"), "h"),
          wait: () => Effect.never,
          cancel: () => tag("cancel"),
        }),
      }),
    })
    expect(await run(Effect.provideService(runtime.execute("return await job()"), Counter, counter()))).toMatchObject({ value: "d" })
    expect(await run(Effect.provideService(runtime.execute("hang(); return 1"), Counter, counter()))).toMatchObject({ value: 1 })
    expect(seen).toEqual(["start1", "wait2", "start1", "cancel2"])
  })

  test("a missing service is a type error", () => {
    const runtime = Runtime.make({ globals: () => ({ next: Host.fn(() => Counter) }) })
    const effect = runtime.execute("next()")
    // @ts-expect-error Counter is not provided
    void (() => Effect.runPromise(effect))
    void Effect.runPromise(Effect.provideService(effect, Counter, counter()))
  })

  test("host failures, tagged errors, defects and interrupts reach the program", async () => {
    const runtime = Runtime.make({
      globals: () => ({
        missing: Host.fn(() => Effect.fail(Host.fail("NotFound", "no such thing", ["try another"]))),
        tagged: Host.fn(() => Effect.fail(new NotFound({ message: "tagged" }))),
        die: Host.fn(() => Effect.die(new Error("kaboom"))),
        thrown: Host.fn(() =>
          Effect.sync(() => {
            throw new Error("thrown")
          }),
        ),
        interrupt: Host.fn(() => Effect.interrupt),
      }),
    })
    const exec = (code: string) => run(runtime.execute(code))
    expect(await exec("try { missing() } catch (e) { return e.message }")).toMatchObject({ value: "no such thing" })
    const missing = await exec("\nmissing()")
    expect(missing).toMatchObject({ ok: false, error: { kind: "NotFound", message: "no such thing", suggestions: ["try another"] } })
    // As on origin/dev: a host failure's diagnostic has no location, and a typed failure is an ExecutionFailure.
    expect(await exec("tagged()")).toMatchObject({ ok: false, error: { kind: "ExecutionFailure", message: "Error: tagged" } })
    for (const name of ["die", "thrown"]) {
      const result = await exec(`\n${name}()`)
      expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure", location: { line: 2, column: 1 } } })
    }
    // An interrupt in a host function interrupts the run, even inside try/catch.
    for (const code of ["interrupt()", "try { interrupt() } catch { return 1 }"]) {
      const interrupted = await Effect.runPromiseExit(runtime.execute(code))
      expect(Exit.isFailure(interrupted) && Exit.hasInterrupts(interrupted)).toBe(true)
    }
  })

  test("durable start, wait and cancel failures", async () => {
    const cancelled: Array<string> = []
    const runtime = Runtime.make({
      globals: () => ({
        badStart: Host.durableFn({ start: () => Effect.fail(Host.fail("StartFailed", "s")), wait: Effect.succeed, cancel: () => Effect.void }),
        badWait: Host.durableFn({ start: () => Effect.succeed("d"), wait: () => Effect.fail(Host.fail("WaitFailed", "w")), cancel: () => Effect.void }),
        badCancel: Host.durableFn({
          start: () => Effect.succeed("d"),
          wait: () => Effect.never,
          cancel: () => Effect.sync(() => void cancelled.push("c")).pipe(Effect.andThen(Effect.fail(Host.fail("CancelFailed", "c")))),
        }),
      }),
    })
    const exec = (code: string) => run(runtime.execute(code))
    expect(await exec("try { await badStart() } catch (e) { return e.message }")).toMatchObject({ value: "s" })
    expect(await exec("try { await badWait() } catch (e) { return e.message }")).toMatchObject({ value: "w" })
    expect(await exec("await badWait()")).toMatchObject({ ok: false, error: { kind: "WaitFailed" } })
    const result = await exec("badCancel(); return 1")
    expect(cancelled).toEqual(["c"])
    // A failing cancel doesn't change the run's result.
    expect(result).toMatchObject({ ok: true, value: 1 })
  })

  test("interrupting execute interrupts the in-flight host call", async () => {
    const log: Array<string> = []
    const runtime = Runtime.make({
      globals: () => ({
        hang: Host.fn(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void log.push("interrupted"))))),
      }),
    })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runtime.execute("hang()"))
        yield* Effect.sleep(5)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(Exit.hasInterrupts(exit.value)).toBe(true)
    expect(log).toEqual(["interrupted"])
  })

  test("suspend interrupts an idempotent call and detaches a durable wait", async () => {
    const log: Array<string> = []
    const runtime = Runtime.make({
      globals: () => ({
        slow: Host.fn(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void log.push("slow")))), {
          type: "async",
          idempotent: true,
        }),
        job: Host.durableFn({
          start: () => Effect.succeed("d"),
          wait: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void log.push("wait")))),
          cancel: () => Effect.sync(() => void log.push("cancel")),
        }),
      }),
    })
    for (const code of ["return await slow()", "return await job()"]) {
      const program = runtime.program(code, { runId: "r" })
      const [outcome, suspended] = await run(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(program.run())
          yield* Effect.sleep(5)
          const suspended = yield* program.suspend()
          return [yield* Fiber.join(fiber), suspended] as const
        }),
      )
      expect(outcome).toBe(suspended)
      expect("state" in suspended).toBe(true)
    }
    expect(log).toContain("slow")
    expect(log).not.toContain("cancel")
  })

  test("log annotations and spans reach host functions", async () => {
    const seen: Array<unknown> = []
    const runtime = Runtime.make({
      globals: () => ({
        probe: Host.fn(() =>
          Effect.gen(function* () {
            seen.push(yield* Effect.currentSpan.pipe(Effect.map((s) => s.name), Effect.orElseSucceed(() => "none")))
            seen.push(yield* References.CurrentLogAnnotations)
          }),
        ),
      }),
    })
    await run(runtime.execute("probe()").pipe(Effect.annotateLogs("request", "r1"), Effect.withSpan("outer")))
    expect(seen).toEqual(["outer", { request: "r1" }])
  })
})
