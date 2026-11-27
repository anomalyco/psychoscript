import { afterEach, describe, expect, test } from "bun:test"
import { Runtime } from "../src/index.js"

const long = "let s = 0; for (let i = 0; i < 300000; i++) s += i; return s"
const expected = (300000 * 299999) / 2

const savedImmediate = globalThis.setImmediate
const savedMessageChannel = globalThis.MessageChannel

afterEach(() => {
  if (savedImmediate) globalThis.setImmediate = savedImmediate
  else delete (globalThis as { setImmediate?: typeof setImmediate }).setImmediate
  if (savedMessageChannel) globalThis.MessageChannel = savedMessageChannel
  else delete (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel
})

describe("yielding a time slice to the host", () => {
  test("a short program still runs when setImmediate is missing", async () => {
    delete (globalThis as { setImmediate?: typeof setImmediate }).setImmediate
    const runtime = Runtime.make({ globals: () => ({}) })
    await expect(runtime.execute("return 1 + 1")).resolves.toMatchObject({ ok: true, value: 2 })
  })

  test("a program that hits a slice runs when setImmediate is missing", async () => {
    delete (globalThis as { setImmediate?: typeof setImmediate }).setImmediate
    const runtime = Runtime.make({ globals: () => ({}) })
    await expect(runtime.execute(long)).resolves.toMatchObject({ ok: true, value: expected })
  })

  test("a program that hits a slice runs with only a microtask yield", async () => {
    delete (globalThis as { setImmediate?: typeof setImmediate }).setImmediate
    delete (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel
    const runtime = Runtime.make({ globals: () => ({}) })
    await expect(runtime.execute(long)).resolves.toMatchObject({ ok: true, value: expected })
  })

  test("Runtime.make({ yieldToHost }) is used at each slice", async () => {
    let yields = 0
    const runtime = Runtime.make({
      globals: () => ({}),
      yieldToHost: () => {
        yields++
        return Promise.resolve()
      },
    })
    await expect(runtime.execute(long)).resolves.toMatchObject({ ok: true, value: expected })
    expect(yields).toBeGreaterThan(0)
  })
})
