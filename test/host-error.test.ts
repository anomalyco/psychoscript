import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Host as EffectHost, Runtime as EffectRuntime } from "../src/effect/index.js"
import { Host, Runtime } from "../src/index.js"

// `Host.error`: a host call that fails with it throws a real error of that standard class, located at the call.

const caught = "try { await f() } catch (e) { return [e instanceof TypeError, e.constructor === TypeError, e.message, e.stack] }"
const located = [true, true, "bad arg", "TypeError: bad arg\n    at <program>:1:13"]
const uncaught = {
  ok: false,
  error: { kind: "ExecutionFailure", message: "TypeError: bad arg (line 2, col 7)", location: { line: 2, column: 7 } },
}

describe("Host.error", () => {
  test("is a real host error of its class, an Error for any other name", () => {
    const error = Host.error("RangeError", "too big")
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toBe("too big")
    expect(Host.error("Nope" as "Error", "m").constructor).toBe(Error)
    expect(EffectHost.error("TypeError", "m")).toBeInstanceOf(TypeError)
  })

  const forms: Record<string, Host.Fn> = {
    thrown: Host.fn(() => {
      throw Host.error("TypeError", "bad arg")
    }),
    "a rejected promise": Host.fn(() => Promise.reject(Host.error("TypeError", "bad arg"))),
    "an async function's": Host.fn(
      async () => {
        await null
        throw Host.error("TypeError", "bad arg")
      },
      { type: "async" },
    ),
    "sync-thenable": Host.fn(
      () => {
        throw Host.error("TypeError", "bad arg")
      },
      { type: "sync-thenable" },
    ),
  }
  for (const [form, f] of Object.entries(forms)) {
    test(`${form}: caught as its class, and located at the call`, async () => {
      const runtime = Runtime.make({ globals: () => ({ f }) })
      expect(await runtime.execute(caught)).toMatchObject({ ok: true, value: located })
      expect(await runtime.execute("await null\nawait f()")).toMatchObject(uncaught)
    })
  }

  test("an Effect that fails or dies with it, from a sync or an async function", async () => {
    const fail = () => Effect.fail(EffectHost.error("TypeError", "bad arg"))
    const die = () => Effect.die(EffectHost.error("TypeError", "bad arg"))
    for (const f of [
      EffectHost.fn(fail),
      EffectHost.fn(die),
      EffectHost.fn(fail, { type: "async" }),
      EffectHost.fn(die, { type: "async" }),
    ]) {
      const runtime = EffectRuntime.make({ globals: () => ({ f }) })
      expect(await Effect.runPromise(runtime.execute(caught))).toMatchObject({ ok: true, value: located })
      expect(await Effect.runPromise(runtime.execute("await null\nawait f()"))).toMatchObject(uncaught)
    }
  })

  test("returned as a value, it is an error like any other", async () => {
    const runtime = Runtime.make({ globals: () => ({ f: Host.fn(() => Host.error("TypeError", "bad arg")) }) })
    expect(
      await runtime.execute("const e = f(); return [e instanceof TypeError, e.message, e.stack]"),
    ).toMatchObject({ ok: true, value: [true, "bad arg", "TypeError: bad arg"] })
  })
})
