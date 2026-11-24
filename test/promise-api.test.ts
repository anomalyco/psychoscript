import { describe, expect, test } from "bun:test"
import { fromBytes, Host, Runtime, StreamingResponse, toBytes } from "../src/index.js"

const execute = (runtime: Runtime.Runtime, code: string) => runtime.execute(code)

describe("Promise API", () => {
  test("execute", async () => {
    expect(await execute(Runtime.make(), "return 1 + 2")).toEqual({ ok: true, value: 3, metadata: null })
  })

  test("host functions return values and Promises, and throw", async () => {
    const runtime = Runtime.make({
      globals: () => ({
        double: Host.fn(([n]) => Number(n) * 2),
        later: Host.fn(async ([n]) => Number(n) + 1),
        boom: Host.fn(() => {
          throw new Error("boom")
        }),
        refuse: Host.fn(() => Promise.reject(Host.fail("Refused", "no"))),
      }),
    })
    expect(await execute(runtime, "return [double(21), await later(1)]")).toMatchObject({ ok: true, value: [42, 2] })
    expect(await execute(runtime, "try { boom() } catch (e) { return e.message }")).toMatchObject({ value: "boom" })
    expect(await execute(runtime, "await refuse()")).toMatchObject({ ok: false, error: { kind: "Refused", message: "no" } })
  })

  test("an idempotent async call is suspended to bytes and resumed in a fresh runtime", async () => {
    const calls: Array<string> = []
    const make = (hang: boolean) =>
      Runtime.make({
        globals: () => ({
          fetchNumber: Host.fn(
            ([n], call) => {
              calls.push(call.key)
              return hang ? new Promise(() => {}) : Number(n) * 10
            },
            { type: "async", idempotent: true },
          ),
        }),
      })
    const program = make(true).program("const a = await fetchNumber(1); return a + 1", { runId: "r" })
    const running = program.run()
    await Bun.sleep(5)
    const suspended = await program.suspend()
    expect(await running).toBe(suspended)
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    const bytes = toBytes(suspended.state)
    expect(await make(false).resume(fromBytes(bytes) as Runtime.Suspended["state"]).run()).toMatchObject({ ok: true, value: 11 })
    expect(await make(false).resume(bytes).run()).toMatchObject({ ok: true, value: 11 })
    expect(calls).toEqual(["r:0", "r:0", "r:0"])
  })

  test("a bad state rejects with a SnapshotError", async () => {
    await expect(Runtime.make().resume(new Uint8Array([1, 2, 3])).run()).rejects.toMatchObject({ name: "SnapshotError" })
  })

  test("a durable function's Promise start, wait and cancel span a suspend", async () => {
    const log: Array<string> = []
    let release: ((value: string) => void) | undefined
    const make = () =>
      Runtime.make({
        globals: () => ({
          job: Host.durableFn<{ id: number }>({
            start: async ([n]) => {
              log.push(`start ${n}`)
              return { id: Number(n) }
            },
            wait: (data, call) =>
              new Promise((resolve) => {
                log.push(`wait ${data.id}`)
                release = resolve
                call.signal.addEventListener("abort", () => log.push("aborted wait"))
              }),
            cancel: async (data) => {
              log.push(`cancel ${data.id}`)
            },
          }),
        }),
      })
    const program = make().program("return await job(7)")
    const running = program.run()
    await Bun.sleep(5)
    const suspended = await program.suspend()
    expect(await running).toBe(suspended)
    if (!("state" in suspended)) throw new Error("expected a suspended run")
    const resumed = make().resume(toBytes(suspended.state)).run()
    await Bun.sleep(5)
    release!("done")
    expect(await resumed).toMatchObject({ ok: true, value: "done" })
    expect(log).toEqual(["start 7", "wait 7", "aborted wait", "wait 7"])

    const cancelled = new AbortController()
    const aborted = make().execute("return await job(8)", { signal: cancelled.signal })
    await Bun.sleep(5)
    cancelled.abort()
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" })
    expect(log).toContain("cancel 8")
  })

  test("aborting rejects with an AbortError, and an in-flight call sees its signal aborted", async () => {
    let seen: AbortSignal | undefined
    const runtime = Runtime.make({
      globals: () => ({
        hang: Host.fn((_, call) => {
          seen = call.signal
          return new Promise(() => {})
        }),
      }),
    })
    const controller = new AbortController()
    const running = runtime.execute("await hang()", { signal: controller.signal })
    await Bun.sleep(5)
    controller.abort("stop")
    const error = await running.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DOMException)
    expect(error).toMatchObject({ name: "AbortError", cause: "stop" })
    expect(seen?.aborted).toBe(true)

    const program = runtime.program("await hang()")
    await expect(program.run({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" })
  })

  test("the timeout limit", async () => {
    const runtime = Runtime.make({
      limits: { timeoutMs: 20 },
      globals: () => ({ hang: Host.fn(() => new Promise(() => {})) }),
    })
    expect(await execute(runtime, "await hang()")).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
  })

  test("translate", async () => {
    const globals = () => ({ echo: Host.fn(([value]) => value) })
    const program = "return echo({ a: 1, f() {} })"
    expect(await execute(Runtime.make({ globals }), program)).toMatchObject({ ok: false })
    expect(await execute(Runtime.make({ globals, translate: { functions: "drop" } }), program)).toMatchObject({
      ok: true,
      value: { a: 1 },
    })
  })

  test("a StreamingResponse has type, clone(), reader.closed, and refuses what needs a Blob or WritableStream", async () => {
    const runtime = Runtime.make({
      globals: () => ({ get: Host.fn(async () => new StreamingResponse(new Response("hi", { status: 201 }))) }),
    })
    expect(
      await execute(
        runtime,
        `const r = await get()
        const c = r.clone()
        const reader = c.body.getReader()
        const same = reader.closed === reader.closed
        await reader.read()
        await reader.read()
        await reader.closed
        const text = await r.text()
        let used
        try { r.clone() } catch (e) { used = e.name }
        return [r.type, c.status, same, text, used]`,
      ),
    ).toMatchObject({ ok: true, value: ["default", 201, true, "hi", "TypeError"] })
    expect(
      await execute(
        runtime,
        `const r = await get()
        const names = []
        for (const f of [() => r.blob(), () => r.formData(), () => r.body.pipeTo(), () => r.body.tee()])
          try { await f() } catch (e) { names.push(e.name) }
        return names`,
      ),
    ).toMatchObject({ ok: true, value: ["TypeError", "TypeError", "TypeError", "TypeError"] })
  })
})
