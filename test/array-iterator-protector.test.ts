import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Host, Runtime, toBytes } from "../src/index.js"
import { parking } from "../src/runtime/driver.js"
import { runProgram } from "./run.js"

// Arrays are iterated directly until a program replaces `Array.prototype[Symbol.iterator]` or the built-in iterators'
// `next`; from then on, for the rest of the run, they go through the iterator protocol.

const overrideIterator = `
  Array.prototype[Symbol.iterator] = function* () { yield 42; yield 43 }
`
const overrideNext = `
  const proto = Object.getPrototypeOf([][Symbol.iterator]())
  let calls = 0
  proto.next = function () { calls++; return calls > 2 ? { done: true, value: undefined } : { done: false, value: calls * 10 } }
`
const uses = `
  const [a, b] = [1, 2, 3]
  const spread = [...[1, 2, 3]]
  const looped = []
  for (const x of [1, 2, 3]) looped.push(x)
  const from = Array.from([1, 2, 3])
  function* delegate() { yield* [1, 2, 3] }
  const delegated = [...delegate()]
  const args = Math.max(...[1, 2, 3])
`

const both = (code: string) => {
  const plain = runProgram(code)
  expect(runProgram(code, { roundTrip: { every: 1, max: 100_000 } })).toEqual(plain)
  return plain
}

describe("an overridden array iterator", () => {
  test("Array.prototype[Symbol.iterator] is honoured by destructuring, spread, for...of, Array.from and yield*", () => {
    expect(both(`${overrideIterator}${uses} return [a, b, spread, looped, from, delegated, args]`)).toMatchObject({
      ok: true,
      value: [42, 43, [42, 43], [42, 43], [42, 43], [42, 43], 43],
    })
  })

  test("the built-in iterators' next is honoured", () => {
    expect(both(`${overrideNext} const [a, b, c] = [1, 2, 3]; calls = 0; const s = [...[7, 8, 9]]; return [a, b, c, s]`)).toMatchObject({
      ok: true,
      value: [10, 20, null, [10, 20]],
    })
  })

  test("defineProperty, an accessor and delete all count", () => {
    expect(
      both(`
        const results = []
        Object.defineProperty(Array.prototype, Symbol.iterator, { get() { return function* () { yield "got" } }, configurable: true })
        results.push([...[1, 2]])
        delete Array.prototype[Symbol.iterator]
        try { const [x] = [1]; results.push(x) } catch (e) { results.push(e instanceof TypeError) }
        return results`),
    ).toMatchObject({ ok: true, value: [["got"], true] })
  })

  test("an array's own Symbol.iterator, and a Set fed from an array", () => {
    expect(
      both(`
        const own = [1, 2, 3]
        own[Symbol.iterator] = function* () { yield "own" }
        const [x] = own
        const plain = [...[1, 2]]
        ${overrideIterator}
        const set = new Set([1, 2, 3])
        return [x, [...own], plain, [...set]]`),
    ).toMatchObject({ ok: true, value: ["own", ["own"], [1, 2], [42, 43]] })
  })

  test("a run that never overrides them keeps array iteration", () => {
    expect(both(`${uses} return [a, b, spread, looped, from, delegated, args]`)).toMatchObject({
      ok: true,
      value: [1, 2, [1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3], 3],
    })
  })
})

const latch = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const hosting = (gate: Promise<void> | undefined) => {
  const started = latch()
  const runtime = Runtime.make({
    globals: () => ({
      slow: Host.fn(
        ([n]) =>
          Effect.promise(async () => {
            started.resolve()
            await gate
            return n as number
          }),
        { type: "async", idempotent: true },
      ),
    }),
  }) as Runtime.Runtime<never>
  return { runtime, started: started.promise }
}

test("the override survives a suspend and a resume from bytes", async () => {
  const code = `
    ${overrideIterator}
    await slow(1)
    const [a, b] = [1, 2, 3]
    return [a, b, ...[5]]`
  const gate = latch()
  const first = hosting(gate.promise)
  const parked = latch()
  parking.onPark = parked.resolve
  const program = first.runtime.program(code, { runId: "r" })
  const fiber = Effect.runFork(program.run())
  await Promise.all([first.started, parked.promise])
  parking.onPark = undefined
  const suspended = await Effect.runPromise(program.suspend())
  gate.resolve()
  await Effect.runPromise(Fiber.join(fiber))
  if (suspended.ok !== "suspended") throw new Error(`expected a suspended run, got ${JSON.stringify(suspended)}`)
  const resumed = await Effect.runPromise(hosting(undefined).runtime.resume(toBytes(suspended.state)).run())
  expect(resumed).toMatchObject({ ok: true, value: [42, 43, 42, 43] })
})
