# psychoscript (Rust)

An early pre-release (`0.1.0-alpha.1`): the API may still change.

A Rust implementation of psychoscript: the same confined, JavaScript-like language as the TypeScript package in `src/`,
which is its reference. Programs run in a bytecode VM written in pure Rust, with no Bun, Node or other JavaScript
engine at build or run time, and reach only the host functions the embedder gives them.

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

With `Runtime::typed_arrays(true)` (off by default), an `ArrayBuffer` or a typed array other than Uint8Array crosses
as `HostValue::TypedArray(TypedArray)`. A synchronous
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
| `Host.error(name, message)` | `HostError::located(name, message)` (`HostValue::Located`) |
| `runtime.execute`, `runtime.program`, `runtime.compile`, `runtime.resume` | `execute`/`execute_async`, `program`, `compile`, `resume`/`resume_bytes` |
| `toBytes`, `fromBytes` | `to_bytes`, `from_bytes` |
| a host typed array or `ArrayBuffer` (a view of the program's bytes) | `HostValue::TypedArray(TypedArray)` |
| `limits.maxValueDepth` (at most 256) | `Limits::max_value_depth` (at most `MAX_VALUE_DEPTH_LIMIT`) |
| `limits.timeoutMs` (wall clock) | `Limits::timeout_ms`, on `Limits::clock`: `Clock::Wall` (the default) or `Clock::ThreadCpu` (Rust only) |
| (none) | `Limits::slice_ms`: the longest a run may compute without awaiting the host, on `Limits::clock` (Rust only) |
| `typedArrays: true` | `Runtime::typed_arrays(true)` |
| `Host.functionMarker` (under `translate: { functions: "mark" }`) | `HostValue::FunctionMarker`, `Data::FunctionMarker` |

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
```

## Parity

Both implementations must stay equally capable: a language feature or host API lands in both or in neither. The
expectations come only from the reference, never from hand:

- `conformance/cases/*.js` → `.json` (`generate.ts`), replayed by `bench/tests/conformance.rs`, also in round-trip mode,
  which saves and restores every run at each host stop and loop slice.
- `conformance/host.json` (`host.ts`), `boundary.json` (`boundary.ts`) and `streaming.json` (`streaming.ts`), replayed
  by `crates/psychoscript/tests/`.
- Rust-only features (the heap cap, typed arrays, function markers, the value depth limit, located host errors) have
  no reference: their expected results are written in Rust's own tests (`crates/psychoscript/tests/heap.rs`,
  `typed.rs`, `host_recording.rs`, `value_depth.rs`; the programs of `tests/cases/*.js` also run in round-trip mode).
- test262, both ways: `test262/rust-skipped.txt` (fails here, passes in the reference) and `test262/reference-gaps.txt`
  (passes here, fails in the reference) are empty and may only stay so.

CI regenerates every recording and fails on any difference. The cases marked `@platform "linux"` depend on the system
libm and are recorded only on Linux.

Known differences:

- A saved state resumes only in the implementation and build that saved it: the snapshot formats differ.
- Date's `toLocaleString`, `toLocaleDateString` and `toLocaleTimeString` format any locale and `Intl.DateTimeFormat`
  options through ICU4X rather than the host ICU4C: the common cases — and every error kind and message — match, and
  the rest render ICU4X's closest output. The differences are recorded by `conformance/date-locale.ts` in
  `conformance/date-locale.differences.json` and pinned by `bench/tests/date_locale.rs`; among them: a two-digit year
  inside a date, numeric dates where a locale's `yMd` pattern differs from its short style, a standalone minute or
  second (ICU4X prefixes the hour), flexible day periods (`b`/`B`), and the CJK separators and zone names whose data
  differs from ICU's.

## Design

- **Threading:** a run stays on the thread that drives it; as a future, compute past 1 ms moves to a worker of the
  run's own while host code is always handed back to the executor, in the same order. On wasm32, without threads, the
  run yields to its executor there instead.
- **Memory:** an incremental, non-moving mark-sweep collector (`collector.rs`) frees what a run can no longer reach,
  at safe points only (`bench/GC.md`). `Limits::max_heap_bytes` (the reference's `maxHeapBytes`) caps what a run
  can reach, measured in the size model both share (`heap.rs`), so a measurement finds the same in both; when the
  measurements between the first and the last fall differs, as the pacing counts allocations each its own way.
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
