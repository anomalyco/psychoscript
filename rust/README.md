# psychoscript (Rust)

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
boundary as copies (`HostValue`, with strings as lossless `HostString`s).

| Reference (`src/index.ts`) | Rust (`crates/psychoscript/src/lib.rs`) |
|---|---|
| `Runtime.make({ globals, modules, limits, translate })` | `Runtime::make().globals(..).modules(..).limits(..).translate(..)` |
| `Host.fn`, `Host.durableFn`, `Host.namespace` | `HostFunction`, `DurableFunction`, `Namespace` |
| `Host.fail`, `Host.missing` | `Failure::new`, `Failure::missing` |
| `runtime.execute`, `runtime.program`, `runtime.compile`, `runtime.resume` | `execute`/`execute_async`, `program`, `compile`, `resume`/`resume_bytes` |
| `toBytes`, `fromBytes` | `to_bytes`, `from_bytes` |

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
```

## Parity

Both implementations must stay equally capable: a language feature or host API lands in both or in neither. The
expectations come only from the reference, never from hand:

- `conformance/cases/*.js` → `.json` (`generate.ts`), replayed by `bench/tests/conformance.rs`, also in round-trip mode,
  which saves and restores every run at each host stop and loop slice.
- `conformance/host.json` (`host.ts`), `boundary.json` (`boundary.ts`) and `streaming.json` (`streaming.ts`), replayed
  by `crates/psychoscript/tests/`.
- test262, both ways: `test262/rust-skipped.txt` (fails here, passes in the reference) and `test262/reference-gaps.txt`
  (passes here, fails in the reference) are empty and may only stay so.

CI regenerates every recording and fails on any difference. The cases marked `@platform "linux"` depend on the system
libm and are recorded only on Linux.

Known differences:

- A saved state resumes only in the implementation and build that saved it: the snapshot formats differ.
- A getter that native code reads (iterator `next`/`done`/`value`, spread, `Object.assign`/`entries`, `valueOf` and
  `toString`, a Set-like argument's `size`/`has`/`keys`) runs to completion inline: unlike the reference, it cannot
  wait on a host call or be suspended.
- Date's `toLocaleString`, `toLocaleDateString` and `toLocaleTimeString` read no locales or options: always `en-US` in
  the host's time zone, where the reference formats any locale and Intl options.

## Design

- **Threading:** a run stays on the thread that drives it; as a future, compute past 1 ms moves to a worker of the
  run's own while host code is always handed back to the executor, in the same order.
- **Memory:** an incremental, non-moving mark-sweep collector (`collector.rs`) frees what a run can no longer reach,
  at safe points only (`bench/GC.md`).
- Layout: `crates/psychoscript` (compiler on `oxc_parser`, VM, standard library, host functions, snapshots),
  `conformance/` (generators and recordings), `bench/`, `test262/`.

Rules: pure Rust and few dependencies, no `unsafe`, never panic on user input, and unsupported syntax throws
`UnsupportedSyntax` with a location where it runs.
