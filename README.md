# psychoscript

A confined, resumable JavaScript interpreter for [Effect](https://effect.website) hosts. Programs run on a bytecode VM
with a deterministic standard library and no ambient access: they can only reach the functions the host gives them.
A run can be suspended to bytes and resumed later, in another process.

## Install

```sh
bun add psychoscript effect
```

## Example

```ts
import { Effect } from "effect"
import { Host, Runtime } from "psychoscript"

const runtime = Runtime.make({
  globals: () => ({
    double: Host.fn(([n]) => Effect.succeed(Number(n) * 2)),
  }),
})

const result = await Effect.runPromise(runtime.execute("return [await double(21), [1, 2, 3].map((x) => x + 1)]"))
console.log(result) // { ok: true, value: [42, [2, 3, 4]], metadata: null }
```

## Status

`interpreter-support.md` is the support matrix. The pinned [test262](https://github.com/tc39/test262) subset in
`test/test262` passes with no failures; known gaps are listed in `test/test262/skipped.txt`.

## Development

```sh
bun install
bun run typecheck
bun test                 # PSYCHOSCRIPT_ROUNDTRIP=1 bun test also saves and restores state mid-run
bun run build            # dist/
```
