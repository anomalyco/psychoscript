# psychoscript-web

PsychoScript in the browser: wasm-bindgen bindings over the `psychoscript` crate for hosts that run on one thread (a
Web Worker) and hand programs JSON. The web counterpart of `psychoscript-mobile`; the widget host that uses it is
`web/` at the repository root.

## JavaScript API (`wasm-bindgen --target web`)

```ts
class Program {
  constructor(source: string, inputName?: string)              // compile once; throws PsychoScriptError
  run(inputJson: string, timeoutMs?: number, maxOutputBytes?: number): string   // one run, its completion value as JSON
  runStep(inputJson: string, timeoutMs?: number, maxOutputBytes?: number): string // a native widget step (below)
  runDraw(inputJson: string, timeoutMs?: number, maxOutputBytes?: number): string // a native draw step's commands
  startLive(inputJson: string, options?: { sliceBudgetMs?: number; maxPostsPerSecond?: number; httpsHosts?: string[];
            allowLocalNetwork?: boolean; native?: boolean }): LiveRun
}
class LiveRun {
  pump(maxMs: number): number      // -3 ended (see exit()), -2 still computing: pump again soon,
                                   // -1 waiting with no timer, else ms until its next sleep ends
  takeBytes(): Uint8Array           // the GPU batches' bytes in that outbox, which they name by [offset, length]
  takeOutbox(): string             // JSON array: { type: "post", message } | { type: "warning", message }
                                   //   | { type: "fetch", id, url, method, headers, body?|body64?, timeoutMs, maxResponseBytes }
                                   //   | { type: "cancel", id }
  deliver(messageJson: string): void
  fetchDone(id: number, metaJson: string /* { status, url, headers } */, body: Uint8Array): void
  fetchFailed(id: number, kind: "Network" | "Timeout" | "TooLarge", message: string): void
  pause(): void; resume(): void; stop(): void; isPaused(): boolean; nowMs(): number
  exit(): string | undefined       // { type: "finished", result } | { type: "failed", error } | { type: "stopped" }
}
```

Errors are `Error`s named `PsychoScriptError` with `type` (`syntax`, `runtime`, `timeout`, `outputTooLarge`,
`invalidInput`, `sliceBudget`, `invalidState`, `view`), `kind` (the language's diagnostic kind), 1-based
`line`/`column`, and `phase: "view"` for a `view` error.

Widgets run as a native host of widget protocol 2 (opencode `specs/v2/widgets.md`, Native hosts): functions cross as
markers, and this crate builds the tree clients get (`src/tree.rs`). `runStep` runs a program ending in
`return __widget_native_step(__input())` with `__widget_emit(view, failure?)` as a second host global: the result is the
run's, its functions left out as JSON leaves them, with `view` (the emitted view's tree) added. `runDraw` runs a draw step
the same way and gives the commands the program emitted, as JSON reads them (`null` for none). A live run with
`native: true` builds each posted `render`'s tree (`post` returns whether it has handlers) and maps a `draw`'s `key` to
its canvas's id; its `render` and `draw` posts go out under the post rate (a bucket of 8 refilled at
`maxPostsPerSecond`, 240; waiting posts coalesce by render and by canvas key, and go out at the run's end unless it is
stopped); GPU batches (`{ type: "frame", gpu }`, `{ type: "gpu", ops, bytes }`, widgets-gpu.md) take no token but
never overtake a waiting post, and go as they are for the client's host checks: their ops as JSON reads them, with
their non-finite numbers (which JSON writes as `null`) listed by path in `nonFinite` for the client to put back, an
`ArrayBuffer`'s bytes (read in place) in the byte outbox (`takeBytes`), other bytes `null`; a render carries its GPU canvases' ids by
key (`gpu`). Widget runs (`runStep`, `runDraw`, `native` live runs) have typed arrays (`Runtime::typed_arrays`); a
plain `run` doesn't. A
`draw` without a string `key`, over 2,000 commands or with an invalid command (type `draw`), ends the run. Draws, live posts and
`runDraw` alike, are checked and normalised by the spec's draw command checks (`src/draw.rs`; `tests/draw.rs` runs the
89 shared cases of opencode widgets cb1e19652). A key that isn't a string, number or boolean, or a view over 100 levels, fails with type `view` (a step
once it has run; a live run at once); a function anywhere but a node's handler props, in any host call's argument,
throws the runtime's `TypeError` `Argument <n> to <name> contains a function, which cannot be passed to the host.`,
located at the call (`HostError::located`, sync and async calls alike), as the host's other errors are. `tests/tree.rs` runs the 56 conformance fixtures (`tests/fixtures/wire`, opencode widgets 35f0712e3).

A live run has `__host.post/receive/sleep/now/fetch` as in `psychoscript-mobile` (and `widgets-live.md`), but nothing
runs by itself: the host calls `pump` after a delivery, a fetch answer, a resume, or when the returned timer is due,
and again while it returns `-2`. In the browser the language yields about every millisecond of compute (see below),
so `pump(8)` returns within ~8 ms and the worker's event loop stays responsive; a stretch of compute longer than the
slice budget (50 ms) with no wait on the host stops the run with `sliceBudget`. Pausing freezes `now()` and sleeps,
and holds deliveries and fetch answers; `resume` queues `{ type: "resumed", pausedMs }` first.

`fetch` rules are checked here (`src/fetch.rs`): https only, the declared hosts (an entry may name a port), no URL
credentials, no local names or non-public literal addresses (unless `allowLocalNetwork`, dev mode: then those too,
over `http:` as well, when an entry other than `*` declares them), the six methods, no cookie headers, 256 KB out / 2 MB in, 4 in flight and 10 a
second; the browser carries the request and the final URL after redirects is checked again. Snapshots
(`suspend`/`toBytes`) aren't offered: `Suspender::suspend` blocks on a condition variable, which a single-threaded
host can't do while it is the thread that must reach the safe point.

The native parts are plain Rust and tested natively: `cargo test -p psychoscript-web`.

## Changes in the language crate (`crates/psychoscript`) for the browser

Both apply only to `target_arch = "wasm32"`; native builds are unchanged.

1. **Clocks:** `std::time::Instant`/`SystemTime` panic on `wasm32-unknown-unknown`. A new `src/time.rs` re-exports
   `std::time::{Instant, SystemTime, UNIX_EPOCH}`, or on wasm32 `web_time`'s (`performance.now()`, `Date.now()`),
   and every use (`vm.rs`, `exec.rs`, `host.rs`, `program.rs`, `offload.rs`, `collector.rs`, `builtins/date.rs`) goes
   through it. Dependency `web-time = "1.1"` for wasm32 targets only.
2. **Yielding instead of offloading:** a run driven as a future moves compute past 1 ms to a worker thread. A
   browser can't start one, so on wasm32 `Program::advance` instead wakes its own waker and returns `Pending` at that
   stop (`program.rs`); the executor polls it again to continue, as it would after the worker brought it back. This
   is what lets a single-threaded host bound and interleave stretches of compute. `offload.rs` allows its then
   unused worker code on wasm32 (`allow(dead_code)`).

Not changed: local time zone in a browser is UTC (there is no `TZ` or `/etc/localtime`); `crypto.getRandomValues`
falls back to the run's generator (there is no `/dev/urandom`); a program nested too deeply to compile on the
caller's stack fails with "nested too deeply" (no thread with a larger stack).

## Size

`web/scripts/build-wasm.sh` (release, thin LTO, `wasm-opt -O3`):

| Module | Raw | gzip -9 | brotli -q 11 |
| --- | --- | --- | --- |
| `psychoscript_web_bg.wasm` (language) | 9.54 MB | 3.19 MB | 2.21 MB |
|   of which code | 3.84 MB | 1.36 MB | 0.93 MB |
|   of which data | 5.69 MB | 1.83 MB | 1.24 MB |

The data is mostly ICU4X's compiled data for every CLDR locale (date/time names and patterns for
`toLocale*String`/`Intl.DateTimeFormat`, collation for `localeCompare`). Data segments are copied into each
instance's linear memory, so they also set each worker's baseline memory (~7 MB). Trimming them to a few locales
(baked data from `icu4x-datagen` through `ICU4X_DATA_DIR`, no code change) would save most of the data row (an
estimated 4–5 MB raw, ~1.5 MB gzip, ~1 MB brotli, and as much memory per worker), at the cost of formatting and
collating other locales like their nearest kept one: a difference from the native build and the reference, so it
needs a decision first. `-Oz` instead of `-O3` in wasm-opt saves under 1%.
