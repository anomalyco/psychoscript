# psychoscript (Rust)

An early pre-release (`0.1.0-alpha.1`): the API may still change.

A Rust implementation of psychoscript: the same confined, JavaScript-like language as the TypeScript package in `src/`,
which is its reference. Programs run in a bytecode VM written in pure Rust, with no Bun, Node or other JavaScript
engine at build or run time, and reach only the host functions the embedder gives them.

Against `dev`'s TypeScript: 34x faster to start, 4.3x faster per program on a 429-program corpus, 2.0x on the bench
programs ([`bench/TYPESCRIPT.md`](https://github.com/anomalyco/psychoscript/blob/dev/rust/bench/TYPESCRIPT.md)).

## Use

```rust
use psychoscript::{HostFunction, HostValue, Limits, Runtime};

let runtime = Runtime::make()
    .globals(|_run| [("double", HostFunction::new(|args, _| HostValue::from(args[0].as_f64().unwrap_or(0.0) * 2.0)))])
    .limits(Limits { timeout_ms: Some(5_000), ..Default::default() });
let outcome = runtime.execute("return double(21)");
```

The API is the Rust form of `src/index.ts`; host work is a `Future` instead of an Effect, and values cross the
boundary as copies (`HostValue`, with strings as lossless `HostString`s), except typed arrays.

Programs always have `ArrayBuffer`, `Uint16Array`, `Uint32Array`, `Int32Array`, `Float32Array` and `Float64Array`
besides Uint8Array (Rust only), set up only when a program uses them. An `ArrayBuffer` or a typed array other than
Uint8Array crosses as `HostValue::TypedArray(TypedArray)`. A synchronous
host function borrows the program's own bytes for the duration of the call, with no copy: read them in place with
`with_bytes(|bytes: &[u8]| ..)` (for instance to upload them to a GPU) or write them with `with_bytes_mut`; `kind()`,
`len()` and `byte_len()` describe the view. Once the call returns the handle is empty. An async or durable host
function gets a copy, as the program runs on meanwhile. Return `TypedArray::new(TypedKind::F32, bytes)`, which takes
the `Vec<u8>` without copying and gives it to the program, or a handle the same call got, which is the program's buffer
again. Elements are little-endian. Inside the run, a typed array's bytes are a heap object its views reference by id,
so element access takes no lock.

```rust
use psychoscript::{HostFunction, HostValue, TypedArray, TypedKind};

let upload = HostFunction::new(|args, _| {
    if let Some(HostValue::TypedArray(t)) = args.first() {
        t.with_bytes(|bytes| queue_write_buffer(bytes)); // no copy
    }
    HostValue::Undefined
});
let mesh = HostFunction::new(|_, _| HostValue::TypedArray(TypedArray::from_f32(&[0.0, 1.0, 0.5])));
```

| Reference (`src/index.ts`) | Rust (`crates/psychoscript/src/lib.rs`) |
|---|---|
| `Runtime.make({ globals, modules, limits, translate })` | `Runtime::make().globals(..).modules(..).limits(..).translate(..)` |
| `Host.fn`, `Host.durableFn`, `Host.namespace` | `HostFunction`, `DurableFunction`, `Namespace` |
| `Host.fail`, `Host.missing` | `Failure::new`, `Failure::missing` |
| `runtime.execute`, `runtime.program`, `runtime.compile`, `runtime.resume` | `execute`/`execute_async`, `program`, `compile`, `resume`/`resume_bytes` |
| `toBytes`, `fromBytes` | `to_bytes`, `from_bytes` |
| `limits.timeoutMs`, `limits.maxOutputBytes` | `Limits::timeout_ms`, `Limits::max_output_bytes` |
| `translate: { functions, promises }` | `Translate { functions, promises }` |
| an `AbortSignal` | dropping the future or the `Program` |

## Differences from the TypeScript implementation

Only Rust has:

- A heap cap: [`Limits::max_heap_bytes`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/diagnostic.rs), measured in the size model of [`heap.rs`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/heap.rs); over it, `MemoryLimitExceeded`.
- CPU-time budgets: [`Limits::clock`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/diagnostic.rs) `Clock::ThreadCpu` for `timeout_ms` (also [`thread_clock`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/thread_clock.rs) for hosts).
- The interpreter slice: [`Limits::slice_ms`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/diagnostic.rs), the longest stretch between awaits of the host; past it, `SliceExceeded`.
- The function marker: [`TranslateFunctions::Mark`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/runtime.rs), giving `HostValue::FunctionMarker` and `Data::FunctionMarker`.
- A value depth limit: [`Limits::max_value_depth`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/diagnostic.rs), at most [`MAX_VALUE_DEPTH_LIMIT`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/convert.rs).
- Located host errors: [`HostError::located`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/host_function.rs) (`HostValue::Located`), caught as a standard error at the call.
- Always-on typed arrays: `ArrayBuffer`, `Uint16Array`, `Uint32Array`, `Int32Array`, `Float32Array`, `Float64Array`, as [`HostValue::TypedArray`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/host_function.rs): lent without a copy to sync host functions, copied for async and durable ones.
- Lazy built-in groups: [`LAZY`](https://github.com/anomalyco/psychoscript/blob/dev/rust/crates/psychoscript/src/builtins/mod.rs) sets up `RegExp`, `Date`, the typed arrays and the other groups only when a program uses them.

Only TypeScript has:

- [`parseProgram`](https://github.com/anomalyco/psychoscript/blob/dev/src/runtime/execute.ts), the program's ESTree AST; Rust's `Runtime::compile` only reports its errors.
- [`formatLocation`](https://github.com/anomalyco/psychoscript/blob/dev/src/runtime/model.ts) and [`moduleName`](https://github.com/anomalyco/psychoscript/blob/dev/src/runtime/modules.ts), two small exported helpers.
- Date's locale formatting through the host's ICU4C: Rust uses ICU4X, with [recorded differences](https://github.com/anomalyco/psychoscript/blob/dev/rust/conformance/date-locale.differences.json) (see Parity).
- Number and BigInt `toLocaleString` through the host's `Intl.NumberFormat`: Rust formats the decimal style with ICU4X,
  with [recorded differences](https://github.com/anomalyco/psychoscript/blob/dev/rust/conformance/number-locale.differences.json),
  and refuses with a RangeError what it doesn't format: `style` `"percent"`, `"currency"` or `"unit"`, and `notation`
  `"scientific"`, `"engineering"` or `"compact"` (so `currency`, `currencyDisplay`, `currencySign`, `unit`,
  `unitDisplay` and `compactDisplay` only take effect in TypeScript; Rust validates them and leaves the decimal style as
  it is).
- A host failure thrown inside a built-in the reference writes as bytecode with handlers (`Map.prototype.forEach`, the
  iterator helpers) becomes an ordinary error there; Rust's native built-ins keep its host kind.

## Commands

Run from `rust/`, after `bun install` at the repository root:

```sh
cargo fmt --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace                                         # includes every conformance recording
PSYCHOSCRIPT_ROUNDTRIP=1 cargo test --locked -p psychoscript-bench --test conformance
bash test262/run.sh                                                     # test262, both ways
bash bench/compare.sh                                                   # against the reference, writes bench/RESULTS.md
```

After a change to the TypeScript reference, regenerate the recordings and commit them with the Rust change that makes
them pass:

```sh
bun conformance/generate.ts && bun conformance/host.ts && bun conformance/boundary.ts && bun conformance/streaming.ts
bun conformance/date-locale.ts # the Date locale matrix, its expected output and its differences from ICU4X
bun conformance/number-locale.ts # the same for Number and BigInt toLocaleString
```

## Parity

Apart from the differences above, Rust matches `dev`'s TypeScript. The expectations for that come only from the
reference, never from hand:

- `conformance/cases/*.js` → `.json` (`generate.ts`), replayed by `bench/tests/conformance.rs`, also in round-trip mode,
  which saves and restores every run at each host stop and loop slice.
- `conformance/host.json` (`host.ts`), `boundary.json` (`boundary.ts`) and `streaming.json` (`streaming.ts`), replayed
  by `crates/psychoscript/tests/`.
- Rust-only features have no reference: their expected results are written in Rust's own tests
  (`crates/psychoscript/tests/heap.rs`, `clock.rs`, `typed.rs`, `host_recording.rs`, `value_depth.rs`; the programs
  of `tests/cases/*.js` also run in round-trip mode).
- test262, both ways: `test262/rust-skipped.txt` (fails here, passes in the reference) and `test262/reference-gaps.txt`
  (passes here, fails in the reference) are empty and may only stay so.

There is no Rust CI job: run the commands above, and the generators with no diff, before pushing. The cases marked
`@platform "linux"` depend on the system libm and are recorded only on Linux.

Known differences:

- A saved state resumes only in the implementation and build that saved it: the snapshot formats differ.
- Date's `toLocaleString`, `toLocaleDateString` and `toLocaleTimeString` format any locale and `Intl.DateTimeFormat`
  options through ICU4X rather than the host ICU4C: the common cases — and every error kind and message — match, and
  the rest render ICU4X's closest output. The differences are recorded by `conformance/date-locale.ts` in
  `conformance/date-locale.differences.json` and pinned by `bench/tests/date_locale.rs`; among them: a two-digit year
  inside a date, numeric dates where a locale's `yMd` pattern differs from its short style, a standalone minute or
  second (ICU4X prefixes the hour), flexible day periods (`b`/`B`), and the CJK separators and zone names whose data
  differs from ICU's.
- Number and BigInt `toLocaleString` likewise, in the decimal style: every option the reference honours there (integer,
  fraction and significant digits, the rounding modes, increments and priority, `trailingZeroDisplay`, `useGrouping`,
  `signDisplay`, `numberingSystem`), and every error kind and message, match. `conformance/number-locale.ts` records
  the differences in `conformance/number-locale.differences.json`, pinned by `bench/tests/date_locale.rs`: NaN is
  `NaN` in every locale (ICU4X has no localized name for it), a numbering system other than the locale's keeps the
  locale's separators, and a few regions whose CLDR data is newer in ICU4X (`de-AT`, `fr-CH`, `bn-BD`).

## Known issues

- A regular expression's backtracking can't be interrupted: one match (`/(a|a)*b/` on a long run of `a`s) runs past
  `timeout_ms` and `slice_ms`, as in the reference. `regress` has no step budget; bound untrusted patterns or inputs.
- A saved state changed since it was saved is refused (its header holds a hash of it), but resuming doesn't validate a
  forged one in full and may panic (in safe Rust): store saved states as you would code.
- On wasm32, a run driven as a future that waits on a host call notices its timeout only when it is next polled.
- The round-trip conformance run (`PSYCHOSCRIPT_ROUNDTRIP=1`) failed once on a heavily loaded machine and didn't
  reproduce in 52 runs since; its quiet panic hook doesn't name the failing case.

## Design

- **Threading:** a run stays on the thread that drives it; as a future, compute past 1 ms moves to a worker of the
  run's own while host code is always handed back to the executor, in the same order. On wasm32, without threads, the
  run yields to its executor there instead, and a thread can't wait: a synchronous run waiting on host work that
  isn't ready, or a sync host function's `Returned::Block` work, ends in an `ExecutionFailure` saying so.
- **Memory:** an incremental, non-moving mark-sweep collector (`collector.rs`) frees what a run can no longer reach,
  at safe points only (`bench/GC.md`). `Limits::max_heap_bytes` caps what a run can reach, in the size model of
  `heap.rs`.
- **Time:** `Limits::timeout_ms` counts wall-clock time by default. With `Limits::clock: Clock::ThreadCpu` it counts
  the CPU time of the threads while they run the program (`cpu.rs`), so a loaded machine never times out a program
  that is only waiting for a core. Host work isn't counted. Synchronous host calls are left out by their wall-clock
  duration (two `Instant` reads, not the thread's clock), which can only count too little, never too much; the
  thread's CPU time with host calls ends the run at ten times the timeout, so what that misses stays bounded. Waits
  on host calls count on the wall clock, up to ten times the timeout. The check reads the thread's clock only when the
  wall time since its last reading could have used up the budget. `Limits::slice_ms` bounds each stretch between
  awaits of the host the same way, also leaving out host calls, and stops the run with `SliceExceeded`, so a host
  needn't watch the run from outside. Under `ThreadCpu` a stretch's CPU time is measured from when it has run a
  sixteenth of the slice, so it may run up to that much past it. On wasm32 the clocks are `performance.now()` and
  `Date.now()` (`web-time`), and `ThreadCpu` counts wall-clock time.
- Layout: `crates/psychoscript` (compiler on `oxc_parser`, VM, standard library, host functions, snapshots, and
  `thread_clock`: a thread's CPU time, read on it or from another thread, for hosts too), `conformance/` (generators
  and recordings), `bench/`, `test262/`.

Rules: pure Rust and few dependencies, no `unsafe` (outside the `thread_clock` module, whose blocks are each one
documented OS call), never panic on user input, and unsupported syntax throws `UnsupportedSyntax` with a location where
it runs.
