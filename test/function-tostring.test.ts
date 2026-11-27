import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Host, Runtime, toBytes } from "../src/effect/index.js"
import { execute } from "./run.js"

// Function.prototype.toString gives a program function's source text as written, so a host can keep it.

const sources = (code: string) => execute(code).then((outcome) => (outcome.ok ? outcome.value : outcome))

describe("Function.prototype.toString", () => {
  test("returns each kind of program function exactly as written", async () => {
    expect(
      await sources(`
        const arrow = async (input) => { return input.x + 1 }
        function declared(a, b = 2) {
          return a + b
        }
        const expression = function named() {}
        const o = { m(x) { return x }, get g() { return 1 }, set g(v) {}, async *gen() {}, ["com" + "puted"]() {} }
        const accessors = Object.getOwnPropertyDescriptor(o, "g")
        class Base {}
        class A extends Base {
          constructor() { super() }
          foo() { return 1 }
          static   bar() {}
          static async *baz() {}
        }
        class Empty {}
        return [
          arrow.toString(), declared.toString(), expression.toString(), (x => x * 2).toString(),
          o.m.toString(), accessors.get.toString(), accessors.set.toString(), o.gen.toString(), o.computed.toString(),
          A.toString(), new A().foo.toString(), A.bar.toString(), A.baz.toString(), Empty.toString(),
        ]
      `),
    ).toEqual([
      "async (input) => { return input.x + 1 }",
      "function declared(a, b = 2) {\n          return a + b\n        }",
      "function named() {}",
      "x => x * 2",
      "m(x) { return x }",
      "get g() { return 1 }",
      "set g(v) {}",
      "async *gen() {}",
      '["com" + "puted"]() {}',
      "class A extends Base {\n          constructor() { super() }\n          foo() { return 1 }\n          static   bar() {}\n          static async *baz() {}\n        }",
      "foo() { return 1 }",
      "bar() {}",
      "async *baz() {}",
      "class Empty {}",
    ])
  })

  test("gives built-in, bound and host functions the native form", async () => {
    const outcome = await Effect.runPromise(
      Runtime.make({ globals: () => ({ lookup: Host.fn(() => 1) }) }).execute(`
        function add(a, b) { return a + b }
        return [Math.max.toString(), [].map.toString(), add.bind(null, 1).toString(), lookup.toString()]
      `),
    )
    expect(outcome).toMatchObject({
      ok: true,
      value: [
        "function max() { [native code] }",
        "function map() { [native code] }",
        "function bound add() { [native code] }",
        "function lookup() { [native code] }",
      ],
    })
  })

  test("leaves conversions as they were and rejects a value that isn't a function", async () => {
    expect(
      await sources(`
        const f = () => 1
        let error
        try { Function.prototype.toString.call({}) } catch (e) { error = e.constructor.name }
        return [String(f), \`\${f}\`, Function.prototype.toString.call(f), error]
      `),
    ).toEqual(["[object Function]", "[object Function]", "() => 1", "TypeError"])
  })

  test("reads the same text from a compiled program run again", async () => {
    const code = "const f = (a) => a * 3\nreturn f.toString()"
    expect(await sources(code)).toBe("(a) => a * 3")
    expect(await sources(code)).toBe("(a) => a * 3")
  })

  test("still has the text after the run is saved and resumed in a fresh runtime", async () => {
    let called!: () => void
    const reached = new Promise<void>((done) => (called = done))
    const runtime = () =>
      Runtime.make({
        globals: () => ({
          pause: Host.fn(
            () =>
              Effect.promise(() => {
                called()
                return new Promise<number>(() => {})
              }),
            { type: "async", idempotent: true },
          ),
        }),
      })
    const program = runtime().program(`
      const keep = async (input) => { return input.days * 2 }
      await pause()
      return keep.toString()
    `)
    const fiber = Effect.runFork(program.run())
    await reached
    await Bun.sleep(10)
    const suspended = await Effect.runPromise(program.suspend())
    await Effect.runPromise(Fiber.interrupt(fiber))
    if (suspended.ok !== "suspended") throw new Error(`expected a suspended run, got ${JSON.stringify(suspended)}`)
    const done = Host.fn(() => 0, { type: "async", idempotent: true })
    const resumed = await Effect.runPromise(
      Runtime.make({ globals: () => ({ pause: done }) }).resume(toBytes(suspended.state)).run(),
    )
    expect(resumed).toMatchObject({ ok: true, value: "async (input) => { return input.days * 2 }" })
  })
})
