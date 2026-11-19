# psychoscript

A confined, resumable JavaScript interpreter for [Effect](https://effect.website) hosts. Programs are compiled to
bytecode and run on a VM with no ambient access: no file system, network, process or timers. The only way a program
reaches the outside world is through the host functions you give it. A run can be suspended while it waits, saved to
bytes, and resumed later, in the same process or another one, with the same result.

Use it to run code you don't fully trust (from a model, a user, a plugin) against an API you control, and to keep
long-running programs alive across restarts.

## Install

```sh
npm install psychoscript effect
bun add psychoscript effect
```

Requires Node ≥ 24 or Bun ≥ 1.4. `effect` (^4.1) is a peer dependency.

## Quick start

```ts
import { Effect } from "effect"
import { Host, Runtime } from "psychoscript"

const runtime = Runtime.make({
  globals: () => ({
    double: Host.fn(([n]) => Effect.succeed(Number(n) * 2)),
  }),
})

const result = await Effect.runPromise(
  runtime.execute("return [await double(21), [1, 2, 3].map((x) => x + 1)]"),
)
console.log(JSON.stringify(result))
// {"ok":true,"value":[42,[2,3,4]],"metadata":null}
```

A result is `{ ok: true, value }` or `{ ok: false, error: { kind, message, suggestions? } }`, plus `logs` from
`console`, `warnings`, and the run's `metadata`. The value crosses as `JSON.stringify` would serialize it (details in
[`interpreter-support.md`](interpreter-support.md)).

## Suspend and resume

`runtime.program(code)` gives a run you control: `run()` runs it, and `suspend()` from another fiber stops it and
returns its state. `toBytes` and `fromBytes` turn that state into bytes and back; `runtime.resume` continues it.

```ts
import { Deferred, Effect, Fiber } from "effect"
import { Host, Runtime, fromBytes, toBytes } from "psychoscript"

const code = `
  let total = 0
  for (const n of [1, 2, 3]) total += await fetchNumber(n)
  return total
`

// First process: the host call never finishes, so the run waits; suspend it there.
const waiting = Runtime.make({
  globals: () => ({
    fetchNumber: Host.fn(([n]) => (n === 2 ? Effect.never : Effect.succeed(n * 10)), { type: "async", idempotent: true }),
  }),
})
const bytes = await Effect.runPromise(
  Effect.gen(function* () {
    const program = waiting.program(code)
    const fiber = yield* Effect.forkChild(program.run())
    yield* Effect.sleep("10 millis")
    const outcome = yield* program.suspend()
    yield* Fiber.join(fiber)
    return toBytes(outcome.state)
  }),
)
console.log("saved", bytes.length, "bytes")

// Later, anywhere with the same build and globals: resume from the bytes.
const runtime = Runtime.make({
  globals: () => ({
    fetchNumber: Host.fn(([n]) => Effect.succeed(n * 10), { type: "async", idempotent: true }),
  }),
})
const result = await Effect.runPromise(runtime.resume(fromBytes(bytes)).run())
console.log(JSON.stringify(result))
// saved 5363 bytes
// {"ok":true,"value":60,"metadata":null}
```

The interrupted call to `fetchNumber(2)` runs again on resume with the same `call.key`, which is why it is marked
`idempotent`. Without that, `suspend()` fails with a `SuspendError` while the call is in progress, and the run goes
on. A snapshot records the build that wrote it (package version plus a hash of the opcodes, prelude, codecs and
built-ins); resuming it in another build, or from malformed bytes, fails with a `SnapshotError`.
`suspend({ maxBytes })` caps the snapshot size.

## Host functions

`globals` is called for each run (and again on resume) with the `Run`: its `id`, and `metadata`, JSON the host keeps
with the run. It returns the program's globals; they shadow built-ins of the same name, and plain objects of host
functions act as namespaces (`fs.read(...)`). Arguments reach the host as copies, and results are copied back.

- **`Host.fn(f, options)`**: `f(args, call)` returns a value, a Promise, or an Effect (whose requirements become the
  runtime's). `options.type`:
  - `"sync"` (default): the program waits for the result.
  - `"async"`: the program gets a promise at once. Add `idempotent: true` if it is safe to run twice, so the run can
    be suspended while the call is in progress.
  - `"sync-thenable"`: like `sync`, but an object result can also be awaited.

  `constructible: true` allows `new`; `takesFunctions: true` lets it receive functions it returned earlier;
  `snapshot: { encode, decode }` keeps functions inside its results across a resume.
- **`Host.durableFn({ start, wait, cancel })`**: work that keeps running across a suspend. `start` returns JSON kept in
  the snapshot; `wait(data)` gets the result (again after a resume); `cancel(data)` runs if the run ends without it.
- **`Host.namespace({ keys, resolve })`**: a lazy object for large catalogs. `resolve(path)` returns the function for
  `ns.a.b(...)`, or `Host.missing(message, suggestions)`.
- **`Host.fail(kind, message, suggestions)`**: throw or fail with it to give the program an error with your own `kind`.
- **`StreamingResponse`**: return `new StreamingResponse(response)` to give the program a `Response`-like object whose
  body streams (`text()`, `json()`, `bytes()`, `body` readers, `for await`).
- **`translate`** (runtime option): what happens to a program function or promise inside an argument. By default both
  fail the call; `{ functions: "drop", promises: "await" }` drops functions (as `JSON.stringify` does) and awaits
  promises.

```ts
import { Effect } from "effect"
import { Host, Runtime } from "psychoscript"

const files = { "a.txt": "hello", "b.txt": "world" }

const runtime = Runtime.make({
  limits: { timeoutMs: 1_000, maxOutputBytes: 64_000 },
  translate: { functions: "drop", promises: "await" },
  globals: () => ({
    now: Host.fn(() => 1_700_000_000_000),
    log: Host.fn(([value]) => JSON.stringify(value), { type: "async" }),
    fs: Host.namespace({
      keys: (path) => (path.length === 0 ? ["read"] : []),
      resolve: (path) =>
        path.join(".") === "read"
          ? Host.fn(([name]) => {
              if (!(name in files)) throw Host.fail("NotFound", `No file ${name}`, Object.keys(files))
              return files[name]
            })
          : Host.missing(`fs.${path.join(".")} is not a function`, ["fs.read"]),
    }),
  }),
})

const run = (code) => Effect.runPromise(runtime.execute(code)).then((r) => console.log(JSON.stringify(r)))
await run("return [fs.read('a.txt'), Object.keys(fs), now()]")
await run("return await log({ f() {}, p: Promise.resolve(1) })")
await run("fs.read('c.txt')")
await run("fs.write('c.txt', 'x')")
await run("while (true) {}")
```

```
{"ok":true,"value":["hello",["read"],1700000000000],"metadata":null}
{"ok":true,"value":"{\"p\":1}","metadata":null}
{"ok":false,"error":{"kind":"NotFound","message":"No file c.txt","suggestions":["a.txt","b.txt"]},"metadata":null}
{"ok":false,"error":{"kind":"ExecutionFailure","message":"fs.write is not a function","suggestions":["fs.read"]},"metadata":null}
{"ok":false,"error":{"kind":"TimeoutExceeded","message":"Execution timed out after 1000ms."},"metadata":null}
```

## Limits

`Runtime.make({ limits })` takes:

| Option           | Default | Meaning                                                                                      |
| ---------------- | ------- | -------------------------------------------------------------------------------------------- |
| `timeoutMs`      | none    | Active time a run may take, summed across resumes; checked between VM steps.                 |
| `maxOutputBytes` | none    | UTF-8 bytes kept from the result and logs (warnings get an equal budget); the rest is cut.    |

Fixed caps: a string at most 2^24 characters, an array at most 10,000,000 elements, at most 10,000 pending promises,
and values nested at most 32 deep when they cross to or from the host. Exceeding one throws a `RangeError` in the
program. There is no separate memory or step-count limit: bound runs with `timeoutMs`.

## Security model

- **No ambient I/O.** No `fetch`, `fs`, `process`, timers or host-engine globals; everything outside the program is a
  host function you passed.
- **No dynamic code.** No `eval`, `Function` constructor or `with`; programs are strict mode only.
- **No prototype mutation.** No `Object.setPrototypeOf`, `__proto__` assignment, legacy accessors, `Proxy` or
  `Reflect`, so a program can't change how built-ins behave.
- **Bounded.** Time via `timeoutMs`, output via `maxOutputBytes`, and the caps above. A single regular-expression
  match runs on the host engine and can't be interrupted, so a pathological pattern can run long.
- **Checked snapshots.** A snapshot is validated on resume against the build that wrote it. Store snapshots as you
  would code: whoever can edit one controls the resumed run.

## Language

Modern strict-mode JavaScript: `let`/`const`, destructuring, spread, arrow, async and generator functions (including
async generators and `for await`), classes (fields, static members, getters and setters, `extends`, `super`), object
literal getters and setters, labels, `try`/`finally`, top-level `await` and `return`, and `import`/`require` of host
globals by module name. Built-ins: `Object`, `Array`, `String`, `Number`, `Math`, `JSON`, `Date`, `RegExp`, `Map`,
`Set`, `Promise`, `Iterator` helpers, errors, `URL`, `URLSearchParams`, `Headers`, `TextEncoder`/`TextDecoder`,
`atob`/`btoa`, `structuredClone`, `crypto.randomUUID`/`getRandomValues`, `Uint8Array`, Node's `Buffer`, and `console`.

Not supported: private members (`#x`), static blocks, `new` on plain functions, `Proxy`/`Reflect`, `Symbol()` (only
`Symbol.iterator` and `Symbol.asyncIterator` exist), BigInt, typed arrays other than `Uint8Array` (and
`ArrayBuffer`/`DataView`), `WeakRef`/`FinalizationRegistry`, sloppy mode, `eval`, `export`, and TypeScript syntax.
Unsupported syntax fails before the program runs, with a hint.

[`interpreter-support.md`](interpreter-support.md) is the detailed support matrix.

## Determinism

Runs are deterministic except for built-ins that read the host engine: `Math.random()`, `Date.now()` and `new Date()`
with no arguments, and `crypto.randomUUID()`/`crypto.getRandomValues()`. There is no option to seed them. A host
that needs reproducible runs can shadow them, since globals replace built-ins of the same name (for example a `Math`
global whose `random` is a seeded `Host.fn`); the replacement is the whole object, so it must provide every member
the program uses.

## test262

The interpreter is tested against [test262](https://github.com/tc39/test262) at a pinned revision (`250f204f`, in
`test/test262/manifest.json`). The files aren't committed and CI doesn't run them yet: sync a local checkout (see
[`test/test262/README.md`](test/test262/README.md)) and run `bun test test/test262.test.ts`. The sync leaves out
features that are out of scope by design (prototype mutation, `Proxy`, `eval`, sloppy mode and others). Of the
22,253 files it keeps, 19,408 pass and 2,845 are skipped as known gaps (`test/test262/skipped.txt`), with no failures.

## Development

```sh
bun install
bun run check            # typecheck, tests, and a packed-tarball check; run before pushing
bun run test:roundtrip   # tests that also save and restore state mid-run
bun run bench
bun run build            # dist/
bun run script/sync-test262.ts ~/development/test262 && bun test test/test262.test.ts
```

## License

MIT. Files under `test/test262` come from test262 under its own license (`test/test262/LICENSE.test262`), and
`test/LICENSE.wpt` covers adapted web-platform-tests.
