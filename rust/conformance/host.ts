#!/usr/bin/env bun

// Regenerates conformance/host.json: what the reference's language layer does with host functions, the behaviours
// test/language.test.ts covers that the other recordings don't: call keys and run ids, sync, async
// and sync-thenable functions, constructible ones, functions that take functions, idempotent calls across a suspend,
// durable functions across a suspend (start, wait, cancel), `Host.fail` and `Host.missing` kinds and suggestions,
// namespaces (keys, resolve), `run.metadata` across a suspend and in the result, globals made again on resume,
// `translate` (default "error" and its modes) and `limits`. The Rust tests replay this recording.
// Usage: bun conformance/host.ts [reference] — the reference package directory, from the argument,
// PSYCHOSCRIPT_REF, or by default the repository root.
//
// Every entry runs in its own runtime: `Runtime.make({ globals, translate?, limits? })` with the entry's `translate`
// and `limits` (absent: the reference's defaults, both translations "error" and no limits), no `modules`, and the
// program made with `{ runId }` (the entry's, "run" by default). `globals(run)` is called when a run starts and again
// when it resumes; each call counts toward the entry's `made`. It gives (every `run` takes one parameter, `length` 1,
// except `note`, `post` and the durable function's hooks, which also take the call; each is named by its global):
// - `double(n)`: sync; gives `n * 2`.
// - `inc(n)`: sync; gives `Effect.succeed(n + 1)`, which the program waits for.
// - `promised(n)`: sync; gives `Promise.resolve(n)`, which reaches the program as a promise.
// - `load(n)`: async; gives `Effect.succeed(n)`.
// - `find()`: sync-thenable; gives `{ items: [1, 2] }`.
// - `note(...args)`: sync; logs `["note", call.key, args.map(describe)]` (see `describe` in conformance/reference.ts)
//   and gives `undefined`.
// - `post(...args)`: async; logs `["post", call.key, args.map(describe)]` as it runs and gives `undefined`.
// - `never()`: async, not idempotent; logs `["never", call.key]` and never settles.
// - `open()`: sync; gives `{ read }`, where `read` is a host function (a plain JavaScript function inside a result)
//   that gives `"called"`.
// - `takes(input)`: sync, `takesFunctions: true`; gives whether `input.read` is that same `read` function.
// - `refuses(input)`: sync; gives `true`.
// - `grab(input)`: async, `idempotent: true`, `takesFunctions: true`; logs `["grab", call.key]`; never settles until the entry
//   resumed, then gives 3.
// - `Box(item)`: sync, `constructible: true`; gives `{ item }`.
// - `Later(item)`: sync, `constructible: true`; gives `Effect.succeed({ item })`.
// - `refuse()`: sync; fails with `Host.fail("Refused", "Not today", ["Ask again."])`.
// - `mistyped(n)`: sync; throws `Host.error("TypeError", "Not a name: <n>")`.
// - `bounded(n)`: async; fails with `Effect.fail(Host.error(<n>, "Out of range"))`, where `n` names the class.
// - `api`: `Host.namespace`; `keys([])` is `["issues"]`, `keys` of any other path `["list"]`; `resolve(["issues",
//   "list"])` is an async function giving `["#1"]`, any other path `Host.missing("No api.<path>", ["Try
//   api.issues.list."], "NotFound")`.
// - `count()`: sync; sets `run.metadata` to `{ count: 0 }` when it is null, then increments and gives `count`.
// - `wait()`: async, `idempotent: true`; logs `["wait", call.key]`; never settles until the entry resumed, then gives 7.
// - `job()`: `Host.durableFn`. `start(args, call)` logs `["job.start", call.key, args.map(describe)]` and gives
//   `call.key` as its data; `wait(data, call)` logs `["job.wait", data, call.key, call.args.map(describe)]`, never
//   settles until the entry resumed, then gives 41; `cancel(data, call)` logs `["job.cancel", data, call.key]`.
//
// host.json: `{ executes: [{ code, runId, translate?, limits?, compiled?, compile?, outcome, again?, log }],
// suspensions: [{ code, runId, translate?, limits?, compiled?, suspend, resume?, made, log }] }`.
// - An entry with `compiled: true` runs from `runtime.compile(code)` instead of its source. An execute records
//   `compile` (`{ ok: true }`, or `{ ok: false, error }` with the diagnostic, when `outcome` is its source's run), and
//   runs the compiled program twice in the same runtime: `outcome`, then `again`.
// - `outcome` and `resume`: the run's `Result` as the reference gives it (`ok`, `value` or `error` with `kind`,
//   `message` and `suggestions?`, `warnings?`, `logs?`, `truncated?`, `metadata`), with each `Host.functionMarker` in
//   `value` as `{ functionMarker: true }`.
// - A suspension runs the program until `never`, `grab`, `wait` or the durable `job`'s `wait` is first called,
//   suspends it (`program.suspend()`), then: on a `SuspendError`, records `suspend: { ok: false, message, running }`
//   and interrupts the run; on success, records `suspend: { ok: true, metadata, same }` (the saved header's
//   `metadata`; `same`: whether `run()` returned that same `Suspended`), marks the entry resumed, and resumes the
//   state from bytes (`Language.toBytes`) in the same runtime. `made` counts `globals` calls (the reference's normal
//   mode; its round-trip test mode makes them more often).
// - `log`: what the host functions logged, in order.
// Everything is recorded twice, and a difference between the two fails the generator.

import { join } from "node:path"
import { writeRecording } from "./recording.ts"
import { describe, reference } from "./reference.ts"

const ref = await reference(process.argv[2] ?? process.env.PSYCHOSCRIPT_REF)
const Effect = ref.Effect
const Fiber = ref.Fiber
const Host = ref.Language.Host
const Runtime = ref.Language.Runtime

type Entry = { code: string; runId?: string; translate?: unknown; limits?: unknown; compiled?: boolean }

const read = () => "called"

const make = (entry: Entry) => {
  const log: Array<unknown> = []
  const state = { resumed: false, made: 0, started: () => {} }
  const waiting = new Promise<void>((done) => (state.started = done))
  const pending = () => Effect.callback<never>(() => state.started())
  const runtime = Runtime.make({
    ...(entry.translate === undefined ? {} : { translate: entry.translate }),
    ...(entry.limits === undefined ? {} : { limits: entry.limits }),
    globals: (run: { id: string; metadata: unknown }) => {
      state.made++
      return {
        double: Host.fn(([n]: ReadonlyArray<number>) => n * 2),
        inc: Host.fn(([n]: ReadonlyArray<number>) => Effect.succeed(n + 1)),
        promised: Host.fn(([n]: ReadonlyArray<number>) => Promise.resolve(n)),
        load: Host.fn(([n]: ReadonlyArray<unknown>) => Effect.succeed(n), { type: "async" }),
        find: Host.fn((_: ReadonlyArray<unknown>) => ({ items: [1, 2] }), { type: "sync-thenable" }),
        scale: Host.fn(([data, k]: ReadonlyArray<unknown>, call: { key: string }) => {
          log.push(["scale", call.key, describe(data)])
          const view = data as Float32Array
          for (let i = 0; i < view.length; i++) view[i] = view[i]! * (k as number)
          return view
        }),
        mesh: Host.fn(() => new Float32Array([0.5, 1.5, 2.5])),
        note: Host.fn((args: ReadonlyArray<unknown>, call: { key: string }) => {
          log.push(["note", call.key, args.map(describe)])
        }),
        post: Host.fn(
          (args: ReadonlyArray<unknown>, call: { key: string }) =>
            Effect.sync(() => void log.push(["post", call.key, args.map(describe)])),
          { type: "async" },
        ),
        never: Host.fn(
          (_: ReadonlyArray<unknown>, call: { key: string }) =>
            Effect.suspend(() => (log.push(["never", call.key]), pending())),
          { type: "async" },
        ),
        open: Host.fn((_: ReadonlyArray<unknown>) => ({ read })),
        takes: Host.fn(([input]: ReadonlyArray<{ read?: unknown }>) => input?.read === read, { takesFunctions: true }),
        refuses: Host.fn((_: ReadonlyArray<unknown>) => true),
        grab: Host.fn(
          (_: ReadonlyArray<unknown>, call: { key: string }) =>
            Effect.suspend(() => (log.push(["grab", call.key]), state.resumed ? Effect.succeed(3) : pending())),
          { type: "async", idempotent: true, takesFunctions: true },
        ),
        Box: Host.fn(([item]: ReadonlyArray<unknown>) => ({ item }), { constructible: true }),
        Later: Host.fn(([item]: ReadonlyArray<unknown>) => Effect.succeed({ item }), { constructible: true }),
        refuse: Host.fn((_: ReadonlyArray<unknown>) => Effect.fail(Host.fail("Refused", "Not today", ["Ask again."]))),
        mistyped: Host.fn(([n]: ReadonlyArray<unknown>) => {
          throw Host.error("TypeError", `Not a name: ${n}`)
        }),
        bounded: Host.fn(([n]: ReadonlyArray<unknown>) => Effect.fail(Host.error(n as "RangeError", "Out of range")), {
          type: "async",
        }),
        api: Host.namespace({
          keys: (path: ReadonlyArray<string>) => (path.length === 0 ? ["issues"] : ["list"]),
          resolve: (path: ReadonlyArray<string>) =>
            path.join(".") === "issues.list"
              ? Host.fn((_: ReadonlyArray<unknown>) => Effect.succeed(["#1"]), { type: "async" })
              : Host.missing(`No api.${path.join(".")}`, ["Try api.issues.list."], "NotFound"),
        }),
        count: Host.fn((_: ReadonlyArray<unknown>) => {
          const counted = (run.metadata ??= { count: 0 }) as { count: number }
          return ++counted.count
        }),
        wait: Host.fn(
          (_: ReadonlyArray<unknown>, call: { key: string }) =>
            Effect.suspend(() => {
              log.push(["wait", call.key])
              return state.resumed ? Effect.succeed(7) : pending()
            }),
          { type: "async", idempotent: true },
        ),
        job: Host.durableFn({
          start: (args: ReadonlyArray<unknown>, call: { key: string }) =>
            Effect.sync(() => {
              log.push(["job.start", call.key, args.map(describe)])
              return call.key
            }),
          wait: (data: unknown, call: { key: string; args: ReadonlyArray<unknown> }) =>
            Effect.suspend(() => {
              log.push(["job.wait", data, call.key, call.args.map(describe)])
              return state.resumed ? Effect.succeed(41) : pending()
            }),
          cancel: (data: unknown, call: { key: string }) =>
            Effect.sync(() => void log.push(["job.cancel", data, call.key])),
        }),
      }
    },
  })
  return { runtime, log, state, waiting }
}

const named = (entry: Entry) => ({ ...entry, runId: entry.runId ?? "run" })

// A result with its function markers spelled out, which JSON would leave out.
const marks = (v: unknown): unknown =>
  typeof v === "symbol"
    ? { functionMarker: true }
    : Array.isArray(v)
      ? v.map(marks)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, marks(x)]))
        : v
const shown = <T extends { ok: unknown }>(result: T): T =>
  result.ok === true ? { ...result, value: marks((result as { value?: unknown }).value) } : result

const execute = async (entry: Entry) => {
  const made = make(entry)
  const options = { runId: named(entry).runId }
  if (entry.compiled !== true) {
    const result = await Effect.runPromise(made.runtime.execute(entry.code, options))
    return { ...named(entry), outcome: shown(result), log: made.log }
  }
  const compiled = made.runtime.compile(entry.code)
  if (!compiled.ok) {
    const result = await Effect.runPromise(made.runtime.execute(entry.code, options))
    return { ...named(entry), compile: compiled, outcome: shown(result), log: made.log }
  }
  const outcome = await Effect.runPromise(made.runtime.execute(compiled.compiled, options))
  const again = await Effect.runPromise(made.runtime.execute(compiled.compiled, options))
  return { ...named(entry), compile: { ok: true }, outcome: shown(outcome), again: shown(again), log: made.log }
}

// The program an entry runs: its source, or with `compiled`, what `runtime.compile` made of it.
const code = (runtime: { compile: (code: string) => { ok: boolean; compiled?: unknown } }, entry: Entry) => {
  if (entry.compiled !== true) return entry.code
  const compiled = runtime.compile(entry.code)
  if (!compiled.ok) throw new Error(`${entry.code} doesn't compile`)
  return compiled.compiled
}

const suspend = async (entry: Entry) => {
  const made = make(entry)
  const program = made.runtime.program(code(made.runtime, entry), { runId: named(entry).runId })
  const fiber = Effect.runFork(program.run())
  await made.waiting
  const suspended = await Effect.runPromise(Effect.result(program.suspend()))
  if (suspended._tag === "Failure") {
    await Effect.runPromise(Fiber.interrupt(fiber))
    return {
      ...named(entry),
      suspend: { ok: false, message: suspended.failure.message, running: suspended.failure.running },
      made: made.state.made,
      log: made.log,
    }
  }
  const outcome = suspended.success
  const ran = await Effect.runPromise(Fiber.join(fiber))
  if (outcome.ok !== "suspended")
    return { ...named(entry), suspend: { ok: false, outcome: shown(outcome) }, made: made.state.made, log: made.log }
  made.state.resumed = true
  const resumed = await Effect.runPromise(made.runtime.resume(ref.Language.toBytes(outcome.state)).run())
  return {
    ...named(entry),
    suspend: { ok: true, metadata: outcome.state.header.metadata, same: ran === outcome },
    resume: shown(resumed),
    made: made.state.made,
    log: made.log,
  }
}

const drop = { functions: "drop" }
const mark = { functions: "mark" }
const wait = { promises: "await" }
const executes: Array<Entry> = [
  // Sync, async and sync-thenable functions.
  { code: `const a = double(2); const b = inc(a); return [a, b, typeof double, double.name, double.length]` },
  { code: `const p = load(1); return [p instanceof Promise, await p]` },
  { code: `const p = promised(3); return [p instanceof Promise, await p]` },
  {
    code: `return [find().items.length, (await find()).items.length, await find().then((r) => r.items[1]), Object.keys(find())]`,
  },
  {
    code: `const log = []; load(1).then(() => log.push("load")); promised(2).then(() => log.push("promised")); Promise.resolve().then(() => log.push("job")); log.push(inc(1)); await null; await null; await null; return log`,
  },
  // Call keys: every call of a host function takes the next id, in program order.
  { code: `note(); note(1); await load(1); note("a", [2]); await post(3); return 1`, runId: "r" },
  {
    code: `const p = post(1); note(2); const q = Promise.all([post(3), load(4)]); note(5); await p; await q; return 1`,
    runId: "k",
  },
  // Arguments and results cross as structured copies.
  {
    code: `note({ at: new Date(5), m: new Map([["k", 1]]), s: new Set(["a"]), u: new URL("https://a.test/"), e: new RangeError("r") }); const r = open(); return [typeof r.read, r.read(), r.read.name]`,
  },
  // A function inside a result crosses back as itself only to a function that takes functions.
  { code: `return takes({ read: open().read })` },
  { code: `return takes(open())` },
  { code: `refuses(open().read)` },
  { code: `takes(takes)` },
  { code: `takes(() => 1)` },
  // Constructible functions.
  { code: `return [new Box(1).item, new Later(2).item, new Later(...[3]).item, Box(4).item, typeof Box]` },
  { code: `new double(1)` },
  { code: `try { new load(1) } catch (e) { return [e.name, e.message] }` },
  // Namespaces, Host.missing and Host.fail.
  {
    code: `return [await api.issues.list(), Object.keys(api), Object.keys(api.issues), typeof api.x, typeof api.issues.list]`,
  },
  { code: `return api.issues.nope()` },
  { code: `try { api.nope() } catch (e) { return [e.name, e.message, e instanceof Error] }` },
  { code: `refuse()` },
  { code: `try { refuse() } catch (e) { return [e.name, e.message] }` },
  // Host.error: an error of its class, located at the call.
  { code: `const n = 1\n  mistyped(n)` },
  { code: `await null\nawait bounded("RangeError")` },
  { code: `try { mistyped(2) } catch (e) { return [e instanceof TypeError, e.constructor === TypeError, e.name, e.message, e.stack, Object.keys(e)] }` },
  {
    code: `const kinds = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "Other"]\nreturn await Promise.all(kinds.map((k) => bounded(k).catch((e) => [e.constructor.name, e.name, e.message, e.stack, e instanceof Error, Object.keys(e)])))`,
  },
  {
    code: `const out = []; for (const k in api) out.push(k); const x = api.issues; return [out, api.issues === api.issues, x === x, String(api.issues)]`,
  },
  // run.metadata is the result's.
  { code: `count(); count(); return count()` },
  { code: `return 1` },
  { code: `count(); throw new Error("after")` },
  // Translate: the default refuses functions and promises in arguments.
  { code: `note({ f() {} })` },
  { code: `note([Promise.resolve(1)])` },
  { code: `await post(() => 1)` },
  { code: `return await post({ p: Promise.resolve(1) }).catch((e) => [e.name, e.message])` },
  // functions: "drop".
  {
    code: `note({ q: "x", format(v) { return v }, nested: { f: Math.max } }, [1, () => 2, note], () => 3, new Map([["k", () => 1]]))`,
    translate: drop,
  },
  { code: `note({ p: Promise.resolve(1) })`, translate: drop },
  // functions: "mark": `Host.functionMarker` where each function was; it cannot come back.
  {
    code: `const e = new Error("x"); e.f = () => 1
note({ q: "x", format(v) { return v }, nested: { f: Math.max, list: [class A {}, note.bind(null)] } }, [1, () => 2, note], () => 3, new Map([["k", () => 1]]), new Set([() => 1]), e)`,
    translate: mark,
  },
  { code: `note({ f() {}, p: load(1) }, Promise.resolve([() => 2]))`, translate: { functions: "mark", promises: "await" } },
  { code: `return await load({ f() {} })`, translate: mark },
  { code: `try { await load([() => 1]) } catch (e) { return [e.name, e.message] }`, translate: mark },
  { code: `return [takes({ read: open().read, f() {} }), takes(() => 1)]`, translate: mark },
  { code: `note({ p: Promise.resolve(1) })`, translate: mark },
  // The result marks its functions too, on the fast path and in the walk (a promise, a `toJSON`).
  {
    code: `const e = new Error("x"); e.f = () => 1
return { a: 1, f() {}, list: [() => 1, 2, double], s: new Set([() => 1]), e, m: new Map([["k", () => 1]]), api: api.issues.list, read: open().read, n: { g: class {} } }`,
    translate: mark,
  },
  { code: `return () => 1`, translate: mark },
  { code: `return [{ p: load(1).then(() => ({ f() {} })), t: { toJSON() { return () => 1 } } }, Promise.resolve([() => 1])]`, translate: mark },
  { code: `return { a: 1, f() {}, list: [() => 1] }`, translate: drop },
  { code: `return { f() {}, list: [() => 1, "x".repeat(20)] }`, translate: mark, limits: { maxOutputBytes: 30 } },
  { code: `return { f() {}, list: [() => 1, "x".repeat(10)] }`, translate: mark, limits: { maxOutputBytes: 30 } },
  // promises: "await".
  {
    code: `const slow = (async () => { await null; await null; return "slow" })()
const a = note({ n: Promise.resolve(5), list: [load(1), slow] }, load({ deep: load(2) }))
const b = await post(slow, new Promise((resolve) => resolve(load(3))))
return [a, b]`,
    translate: wait,
  },
  { code: `note({ f() {} })`, translate: wait },
  {
    code: `const failing = () => Promise.reject(new RangeError("nope"))
let thrown
try { note({ n: failing() }) } catch (error) { thrown = error }
const sent = post([load(1), failing()])
return [thrown instanceof RangeError, thrown.message, sent instanceof Promise, await sent.catch((e) => e.message)]`,
    translate: wait,
  },
  { code: `note({ n: never() })`, translate: wait, limits: { timeoutMs: 50 } },
  { code: `note({ f() {}, p: load(1) }, () => 2)`, translate: { functions: "drop", promises: "await" } },
  // Typed arrays other than Uint8Array cross as views of the same bytes, which the host reads and writes in place; a
  // Uint8Array as a copy. What a host function returns stays a view of its bytes.
  { code: `const v = new Float32Array([1, 2, 3]); const r = scale(v, 2); return [Array.from(v), r instanceof Float32Array, Array.from(r), r === v]` },
  { code: `const b = new ArrayBuffer(8); const f = new Float32Array(b); scale(f.subarray(1), 3); f[1] = 4; scale(f, 1); note(b, new Int32Array(b, 4, 1)); return Array.from(f)` },
  { code: `const u = new Uint8Array([1, 2]); scale(u, 2); return Array.from(u)` },
  { code: `const m = mesh(); m[0] = 9; return [m.constructor.name, Array.from(m), m.byteLength, m.buffer.byteLength]` },
  { code: `return mesh()` },
  // Limits.
  { code: `while (true) {}`, limits: { timeoutMs: 50 } },
  { code: `await never()`, limits: { timeoutMs: 50 } },
  { code: `never(); return 1`, limits: { timeoutMs: 50 } },
  { code: `console.log("a".repeat(10)); console.log("b"); return "c".repeat(20)`, limits: { maxOutputBytes: 16 } },
  { code: `console.log("1"); console.log("2"); console.log("3"); return 1`, limits: { maxOutputBytes: 4 } },
  { code: `count(); console.log("x".repeat(30)); throw new Error("y".repeat(30))`, limits: { maxOutputBytes: 8 } },
  { code: `for (let i = 0; i < 5; i++) Promise.reject(new Error("e" + i)); return 1`, limits: { maxOutputBytes: 100 } },
  // The heap limit: measured where the calls are handed over, which then never start, and when the body ends.
  { code: `note(1); const a = new Array(100000); await load(1); return a.length`, limits: { maxHeapBytes: 1000000 } },
  { code: `const a = []; while (true) a.push(inc(a.length))`, limits: { maxHeapBytes: 1000000 } },
  { code: `note(1); Math.kept = new Array(1000).fill("y".repeat(100000)); return 1`, limits: { maxHeapBytes: 216080 } },
  { code: `note(1); Math.kept = new Array(1000).fill("y".repeat(100000)); return 1`, limits: { maxHeapBytes: 216079 } },
  // limits.maxValueDepth: a value N deep crosses, N + 1 deep fails, each way; the walk the result takes for a promise
  // allows at least 100; JSON.stringify copies to the same depth. Deep values are recorded by digest, as a recording
  // must stay within the 128 levels of nesting the Rust JSON reader takes.
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; note(deep(4)); try { note(deep(5)) } catch (e) { return [e.name, e.message] }`, limits: { maxValueDepth: 4 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; const a = new Box(deep(3)).item; try { Box(deep(4)) } catch (e) { return [a, e.name, e.message] }`, limits: { maxValueDepth: 4 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(4)`, limits: { maxValueDepth: 4 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(5)`, limits: { maxValueDepth: 4 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return [Promise.resolve(1), deep(60)]`, limits: { maxValueDepth: 4 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return [Promise.resolve(1), deep(109)]`, limits: { maxValueDepth: 110 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return [Promise.resolve(1), deep(101)]` },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; const ok = JSON.stringify(deep(4)).length; try { JSON.stringify(deep(5)) } catch (e) { return [ok, e.name, e.message] }`, limits: { maxValueDepth: 4 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; refuses(deep(256)); const back = await load(deep(256)); return [JSON.stringify(back).length, JSON.stringify(deep(256)) === JSON.stringify(back)]`, limits: { maxValueDepth: 256 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(100)`, limits: { maxValueDepth: 100 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; return deep(257)`, limits: { maxValueDepth: 256 } },
  // Warnings: rejections nothing handled.
  { code: `Promise.reject(new Error("x")); return 1` },
  { code: `const p = Promise.reject(1); await null; p.catch(() => 0); return 2` },
  { code: `async function f() { throw new TypeError("bad") }\nf(); f(); return 4` },
  { code: `Promise.reject("plain"); Promise.reject({ a: [1] }); return 6` },
  { code: `Promise.reject(new Error("unseen")); throw new Error("seen")` },
  { code: `async function g() { null.x }\ng(); return 7` },
  { code: `refuse.call(null); return 8` },
  { code: `api.issues.nope(); return 9` },
  // Durable functions: cancelled when the run ends with their work still running.
  { code: `job(1); return 1`, runId: "c" },
  { code: `const p = job({ a: 1 }); await null; throw new Error("ended")`, runId: "c" },
  // Compiled once, run many times: the same as from source, each run with its own state.
  { code: `note(count()); return double(await load(2)) + count()`, compiled: true },
  { code: `job(1); return 1`, runId: "c", compiled: true },
  { code: `note(1); class A {}`, compiled: true },
  // Getters and setters: an argument's getters run once before the host function, a setter-only property is left
  // out; a getter that waits on a host call parks the read; the result's getters run as it crosses.
  { code: `let n = 0; note({ a: 1, get b() { n++; return [double(2)] }, set c(v) {} }); return n` },
  { code: `const o = { get v() { return inc(1) } }; const x = o.v; o.v; return [x, { get w() { return x + 1 } }]` },
  { code: `const o = { set v(x) { note(inc(x)) } }; o.v = 4; return Object.keys(o)` },
  { code: `const e = await load({ get a() { throw new Error("g") } }).catch((e) => e.message); return [e, await load({ get a() { return 2 }, set b(v) {} })]` },
  { code: `let n = 0; const r = await api.issues.list({ get q() { n++; return 1 } }); try { double({ get x() { throw new Error("s") } }) } catch (e) { return [r, n, e.message] }` },
  // A host function called by a built-in reads its arguments' getters first, as one called from program code.
  { code: `return [{ get a() { return 2 } }].map(note)` },
  { code: `return [{ get a() { return 2 } }].map(double)` },
  { code: `return [1].map((x) => note({ get a() { return x } }))` },
  { code: `return note.call(null, { get a() { return 1 } })` },
  { code: `return note.apply(null, [{ get a() { return 1 } }])` },
  { code: `return note.bind(null, { get a() { return 1 } })()` },
  { code: `return Array.from([{ get a() { return 1 } }], note)` },
  { code: `const r = []; new Map([[1, { get a() { return 1 } }]]).forEach((v) => r.push(note(v))); return r` },
  { code: `return await Promise.resolve({ get a() { return 3 } }).then(note)` },
  { code: `return [{ get a() { return 1 } }].forEach(note)` },
  { code: `return [{ get a() { return 1 } }].filter(note)` },
  { code: `return [[{ get a() { return 1 } }]].map(([x]) => note.call(null, x))` },
  { code: `return post.call(null, { get a() { throw new Error('g') } }).catch((e) => e.message)` },
  { code: `return [{ get a() { throw new Error('g') } }].map(post)` },
  { code: `return note.call(null, { get a() { return inc(1) } })` },
  { code: `return [{ get a() { return inc(1) } }].map(note)` },
  // A getter a built-in or the iteration protocol reads in native code, waiting on a host call: the read parks, as in
  // program code.
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); const r = []; for (const x of it((i) => double(load(i)))) r.push(x); return r`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return [...it((i) => double(load(i)))]`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); const [a, b] = it((i) => double(load(i))); return [a, b]`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return Array.from(it((i) => double(load(i))))`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return [...new Map(Array.from(it((i) => [i, double(load(i))])))]`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); function* g() { yield* it((i) => double(load(i))) } return [...g()]`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); const r = []; for await (const x of it((i) => double(load(i)))) r.push(x); return r`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return await Promise.all(it((i) => double(load(i))))`, translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return Iterator.from(it((i) => double(load(i)))).map((x) => x * 2).toArray()`, translate: wait },
  { code: `const [a] = { [Symbol.iterator]() { return { next() { return { done: false, value: double(load(1)) } } } } }; return a`, translate: wait },
  { code: `const o = { [Symbol.iterator]() { return { get next() { double(load(1)); return () => ({ done: true }) } } } }; return [...o]`, translate: wait },
  { code: `let closed = 0; const o = { [Symbol.iterator]() { return { next: () => ({ done: false, value: 1 }), get return() { closed = double(load(closed)); return () => ({}) } } } }; for (const x of o) break; return closed`, translate: wait },
  { code: `return Object.assign({}, { get a() { return double(load(1)) }, b: 2 })`, translate: wait },
  { code: `return Object.entries({ get a() { return double(load(1)) }, b: 2 })`, translate: wait },
  { code: `const o = { get valueOf() { const n = double(load(1)); return () => n } }; return [o + 1, Math.max(o, 0)]`, translate: wait },
  { code: `const o = { get toString() { const s = String(double(load(1))); return () => s } }; return [String(o), "" + [o]]`, translate: wait },
  { code: `return [...new Set([1, 2]).union({ get size() { return double(load(1)) }, has: () => true, keys: () => [3][Symbol.iterator]() })]`, translate: wait },
  { code: `return JSON.stringify({ get a() { return double(load(1)) }, b: { get toJSON() { const v = double(load(2)); return () => v } } })`, translate: wait },
  { code: `return Math.max.apply(null, { length: 2, get 0() { return double(load(4)) }, 1: 3 })`, translate: wait },
  { code: `const src = { get [Symbol.iterator]() { const n = double(load(1)); return function () { return [n, 2][Symbol.iterator]() } } }; const r = []; for (const x of src) r.push(x); return [r, [...src], Iterator.from(src).toArray()]`, translate: wait },
  { code: `const src = { get [Symbol.asyncIterator]() { const n = double(load(1)); return async function* () { yield n } } }; const r = []; for await (const x of src) r.push(x); return r`, translate: wait },
  { code: `let closed = 0; const src = { [Symbol.asyncIterator]() { return { next: () => Promise.resolve({ done: false, value: 1 }), get return() { closed = double(load(1)); return () => Promise.resolve({ done: true }) } } } }; for await (const x of src) break; return closed`, translate: wait },
  { code: `const del = { [Symbol.iterator]() { return { next: () => ({ done: false, value: 1 }), get return() { const n = double(load(1)); return () => ({ done: true, value: n }) } } } }; function* g() { yield* del } const it = g(); it.next(); return it.return(5)`, translate: wait },
  { code: `const entry = { get 0() { return 'a' }, get 1() { return double(load(1)) } }; return [Object.fromEntries([entry]), [...new Map([entry])]]`, translate: wait },
  // An error's stack: a host failure's names the site where the program observed it.
  { code: `try { refuse() } catch (e) { return e.stack }` },
  { code: `function f() { return refuse() }\nfunction g() { try { return f() } catch (e) { return e.stack } }\nreturn g()` },
  { code: `try { api.nope() } catch (e) { return [e.stack, e.name] }` },
  { code: `return [await post({ p: Promise.resolve(1) }).catch((e) => e.stack), await load({ get a() { throw new Error('g') } }).catch((e) => e.stack)]` },
  { code: `try { await post(() => 1) } catch (e) { return e.stack }` },
  { code: `try { double({ get x() { throw new TypeError('in a getter') } }) } catch (e) { return e.stack }` },
  // Compiling gives the diagnostic a run of the source fails with first.
  { code: `  `, compiled: true },
  { code: `return (`, compiled: true },
  { code: `export const x = 1`, compiled: true },
]
const suspensions: Array<Entry> = [
  // A resumed run keeps its heap limit: under it when suspended, over it once resumed.
  {
    code: `const kept = []; for (let i = 0; i < 1000; i++) kept.push({ i }); await wait(); while (true) kept.push({})`,
    runId: "h",
    limits: { maxHeapBytes: 1000000 },
  },
  // run.metadata across a suspend; the globals are made again on resume.
  { code: `count(); count(); await wait(); return count()`, runId: "m" },
  { code: `count(); count(); await wait(); return count()`, runId: "m", compiled: true },
  // Host.error located at the call once resumed.
  { code: `const n = await wait()\ntry { mistyped(n) } catch (e) { return [e.stack, await bounded("RangeError").catch((e) => e.stack)] }`, runId: "m" },
  { code: `const n = await wait()\nawait bounded("RangeError")`, runId: "m" },
  // An idempotent call in progress runs again on resume, under the same key.
  { code: `note(1); const a = await wait(); note(2); return [a, await wait()]`, runId: "i" },
  { code: `const ps = [wait(), load(1), wait()]; return await Promise.all(ps)`, runId: "i" },
  // A suspend fails while a call that isn't idempotent, or one that holds a host function, runs.
  { code: `await never()`, runId: "s" },
  { code: `const p = never(); await wait(); return 1`, runId: "s" },
  { code: `await grab(open().read)`, runId: "s" },
  { code: `await grab({ n: 1 })`, runId: "s" },
  // A durable function keeps running across a suspend and is waited on again.
  { code: `return (await job()) + 1`, runId: "d" },
  { code: `return (await job()) + 1`, runId: "d", compiled: true },
  { code: `const a = job(1, { b: [2] }); const b = job(); return [await a, await b, count()]`, runId: "d" },
  // A raised limits.maxValueDepth: a deep argument is saved and the call made again on resume, and the resumed run
  // keeps the limit.
    { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; await wait(deep(200)); return JSON.stringify(await load(deep(200))).length`, runId: "i", limits: { maxValueDepth: 200 } },
  { code: `const deep = (n) => { let v = 0; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { c: v }; return v }; await wait(); return deep(201)`, runId: "i", limits: { maxValueDepth: 200 } },
  // functions: "mark" keeps a call's markers across a suspend.
  { code: `return (await job({ on() {} }, [() => 1, 2])) + 1`, runId: "d", translate: mark },
  { code: `return [await wait({ on() {} }, [() => 1]), 1]`, runId: "i", translate: mark },
  { code: `const on = () => 1; await wait(); return { on, list: [on, await load(1)] }`, runId: "i", translate: mark },
  // promises: "await" keeps waiting across a suspend.
  { code: `return [note({ n: wait() }), await wait()]`, runId: "t", translate: wait },
  // Accessors and their halves are saved with the run.
  {
    code: `let n = 0; const o = { get x() { return ++n }, set x(v) { n = v } }; o.x; await wait(); o.x = 10; return [o.x, Object.getOwnPropertyDescriptor(o, "x").get.name, Object.keys(o)]`,
    runId: "g",
  },
  // Classes: a host call waited on in a constructor, field, static field, method, accessor, async or generator method,
  // derived constructor or Error subclass, suspended and resumed.
  { code: `class A { constructor(n) { this.v = double(wait()) + n } m() { return this.v + 1 } } const a = new A(1); return [a.v, a.m(), a instanceof A, Object.keys(a)]`, runId: "k", translate: wait },
  { code: `class A { static scale = 2; a = 1; v = double(wait()) + this.a; w = this.v * A.scale; constructor() { this.after = this.w } } const a = new A(); return [a.v, a.w, a.after, Object.keys(a)]`, runId: "k", translate: wait },
  { code: `class A { static v = double(wait()); static w = A.v + 1 } return [A.v, A.w]`, runId: "k", translate: wait },
  { code: `class A { constructor() { this.base = 1 } m() { return this.base + double(wait()) } } return [new A().m()]`, runId: "k", translate: wait },
  { code: `class A { constructor() { this.n = 20 } get v() { return double(wait()) + this.n } set w(x) { this.got = double(wait()) + x } } const a = new A(); a.w = 1; return [a.v, a.got]`, runId: "k", translate: wait },
  { code: `class A { async load() { const v = await wait(); return v + 1 } *items() { yield 1; yield double(wait()); yield 3 } } const a = new A(); return [await a.load(), [...a.items()]]`, runId: "k", translate: wait },
  { code: `class A { constructor(n) { this.v = double(wait()) + n } } class B extends A { constructor() { super(1); this.w = this.v + 1 } m() { return super.constructor.name + this.w } } const b = new B(); return [b.v, b.w, b.m(), b instanceof A]`, runId: "k", translate: wait },
  { code: `class Base extends Error { name = "Base" } class NotFound extends Base { constructor(n) { super("missing", { cause: n }); this.code = double(wait()) } } try { throw new NotFound(3) } catch (e) { return [e instanceof NotFound, e.name, e.message, e.cause, e.code, String(e)] }`, runId: "k", translate: wait },
  // A getter a built-in or the iteration protocol reads in native code, suspended while it waits on a host call.
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); const r = []; for (const x of it((i) => double(wait()) + i)) r.push(x); return r`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return [...it((i) => double(wait()) + i)]`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); const [a, b] = it((i) => double(wait()) + i); return [a, b]`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return Array.from(it((i) => double(wait()) + i))`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return [...new Map(Array.from(it((i) => [i, double(wait()) + i])))]`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); function* g() { yield* it((i) => double(wait()) + i) } return [...g()]`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); const r = []; for await (const x of it((i) => double(wait()) + i)) r.push(x); return r`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return await Promise.all(it((i) => double(wait()) + i))`, runId: "n", translate: wait },
  { code: `const it = (f) => ({ [Symbol.iterator]() { let i = 0; return { next() { i++; return { get done() { return i > 2 }, get value() { return f(i) } } } } } }); return Iterator.from(it((i) => double(wait()) + i)).map((x) => x * 2).toArray()`, runId: "n", translate: wait },
  { code: `const [a] = { [Symbol.iterator]() { return { next() { return { done: false, value: double(wait()) } } } } }; return a`, runId: "n", translate: wait },
  { code: `const o = { [Symbol.iterator]() { return { get next() { double(wait()); return () => ({ done: true }) } } } }; return [...o]`, runId: "n", translate: wait },
  { code: `let closed = 0; const o = { [Symbol.iterator]() { return { next: () => ({ done: false, value: 1 }), get return() { closed = double(wait()); return () => ({}) } } } }; for (const x of o) break; return closed`, runId: "n", translate: wait },
  { code: `return Object.assign({}, { get a() { return double(wait()) }, b: 2 })`, runId: "n", translate: wait },
  { code: `return Object.entries({ get a() { return double(wait()) }, b: 2 })`, runId: "n", translate: wait },
  { code: `const o = { get valueOf() { const n = double(wait()); return () => n } }; return [o + 1, Math.max(o, 0)]`, runId: "n", translate: wait },
  { code: `const o = { get toString() { const s = String(double(wait())); return () => s } }; return [String(o), "" + [o]]`, runId: "n", translate: wait },
  { code: `return [...new Set([1, 2]).union({ get size() { return double(wait()) }, has: () => true, keys: () => [3][Symbol.iterator]() })]`, runId: "n", translate: wait },
  { code: `return JSON.stringify({ get a() { return double(wait()) }, b: { get toJSON() { const v = double(wait()); return () => v } } })`, runId: "n", translate: wait },
  { code: `return Math.max.apply(null, { length: 2, get 0() { return double(wait()) }, 1: 3 })`, runId: "n", translate: wait },
  { code: `const src = { get [Symbol.iterator]() { const n = double(wait()); return function () { return [n, 2][Symbol.iterator]() } } }; const r = []; for (const x of src) r.push(x); return [r, [...src], Iterator.from(src).toArray()]`, runId: "n", translate: wait },
  { code: `const src = { get [Symbol.asyncIterator]() { const n = double(wait()); return async function* () { yield n } } }; const r = []; for await (const x of src) r.push(x); return r`, runId: "n", translate: wait },
  { code: `let closed = 0; const src = { [Symbol.asyncIterator]() { return { next: () => Promise.resolve({ done: false, value: 1 }), get return() { closed = double(wait()); return () => Promise.resolve({ done: true }) } } } }; for await (const x of src) break; return closed`, runId: "n", translate: wait },
  { code: `const del = { [Symbol.iterator]() { return { next: () => ({ done: false, value: 1 }), get return() { const n = double(wait()); return () => ({ done: true, value: n }) } } } }; function* g() { yield* del } const it = g(); it.next(); return it.return(5)`, runId: "n", translate: wait },
  { code: `const entry = { get 0() { return 'a' }, get 1() { return double(wait()) } }; return [Object.fromEntries([entry]), [...new Map([entry])]]`, runId: "n", translate: wait },
  // An error's stack is saved unformatted until it is read, its header taken at that first read.
  { code: `function make() { return new TypeError('bad') }\nconst made = make()\nlet caught\ntry { null.x } catch (error) { caught = error }\nawait wait()\nreturn [made.stack, caught.stack]`, runId: "e" },
  { code: `const unread = new Error('bad')\nconst read = new Error('worse')\nread.stack\nawait wait()\nunread.name = 'Late'\nread.name = 'Late'\nreturn [unread.stack, read.stack, Object.getOwnPropertyDescriptor(unread, 'stack').enumerable]`, runId: "e" },
  // An overridden array iterator stays honoured across a suspend.
  { code: `Array.prototype[Symbol.iterator] = function* () { yield 42; yield 43 }\nawait wait()\nconst [a, b] = [1, 2, 3]\nreturn [a, b, ...[5]]`, runId: "p" },
  // Limits are saved with the run.
  {
    code: `await wait(); console.log("x".repeat(20)); return "y".repeat(20)`,
    runId: "l",
    limits: { maxOutputBytes: 10 },
  },
]

const recordAll = async () => {
  const recorded = { executes: [] as Array<unknown>, suspensions: [] as Array<unknown> }
  for (const entry of executes) recorded.executes.push(await execute(entry))
  for (const entry of suspensions) recorded.suspensions.push(await suspend(entry))
  return recorded
}
// Everything is recorded twice: a recording that differs between the two depends on timing, which CI's freshness
// check and the Rust replay can't follow, so it fails here instead of being written.
const expected = await recordAll()
const again = await recordAll()
const unstable = (["executes", "suspensions"] as const).flatMap((kind) =>
  expected[kind].flatMap((entry, i) =>
    JSON.stringify(entry) === JSON.stringify(again[kind][i]) ? [] : [`${kind}[${i}]: ${(entry as Entry).code}`],
  ),
)
if (unstable.length > 0) {
  console.error(`recordings that differ between two runs (timing-dependent):\n${unstable.join("\n\n")}`)
  process.exit(1)
}
writeRecording(join(import.meta.dir, "host.json"), expected)
console.log(`${expected.executes.length} executes, ${expected.suspensions.length} suspensions`)
