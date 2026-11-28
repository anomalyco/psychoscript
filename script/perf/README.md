# Benchmark harness

`script/perf/run.ts` measures psychoscript in the states a host actually sees it in, not only after a clean warm-up. On
JavaScriptCore (Bun) one compile of `Vm.exec` serves every program a Runtime runs, so what ran before decides how fast
the next program is: a long-lived host can be 2-3x slower on the same program than a fresh process. "Warm up, then time"
cannot see that, so the runner has five cells:

| cell | what one process does | answers |
|---|---|---|
| `cold` | import psychoscript, `Runtime.make`, first `execute` of one target (`empty`, `agent`) | startup cost |
| `warm` | one target: 3 untimed runs, then `--iters` timed runs | the best case, a fresh process per program |
| `polluted` | the fixed history (`corpus/history.ts`, 52 programs) twice in one order, then every target timed | the long-lived host; compare to warm |
| `mixed` | 30 agent-style bodies (`corpus/agents.ts`), each with unique source text, round after round in one Runtime | the typical small run, parse and compile included |
| `repeat` | the same 30 bodies with the same text every round | the same with repeated text |

History orders are `fwd`, `rev` and `shuf:<seed>`. Different orders leave `exec` with different type profiles, so
report several. The history is versioned: change a program in `corpus/history.ts` and bump `HISTORY_VERSION`; every
polluted result carries the version and a hash of the text.

Sentinels (`classes`, `protoMethod`, `accessors`) are the targets the history is known to slow down.

## Running

```sh
bun run perf                                            # every cell on Bun, 5 processes per cell, ~10 min
bun run perf --quick                                    # 1 process, fwd and rev only, ~2 min
bun run perf --cells warm,polluted --targets classes,protoMethod,accessors
bun run perf --engine bun,node                          # Node runs the built dist/ (built first; --no-build to skip)
bun run perf --counters                                 # add deterministic guest counts (see below)
bun run perf --json out.json                            # raw per-process samples and metadata as well
```

Options: `--cells`, `--engine bun,node`, `--procs N` (processes per cell and side), `--iters N` (timed runs per target),
`--settle N` (untimed runs before warm timing), `--rounds N` (mixed and repeat), `--orders fwd,rev,shuf:1`,
`--targets a,b` (names in `corpus/targets.ts`), `--instr sentinels|all|none|a,b`, `--no-exits`.

## A/B two checkouts

```sh
git worktree add ../psychoscript-base origin/dev && (cd ../psychoscript-base && bun install)
bun run perf --base ../psychoscript-base                # head = this checkout, or --head <dir>
```

The harness itself always comes from the checkout you run it from; `--head` and `--base` only choose the psychoscript
being measured, so the base doesn't need `script/perf`. Launches alternate A,B then B,A per slot so load drift lands on
both sides. The `head/base` column is the median of the per-slot ratios with a 95% bootstrap interval of that median:
treat a change as real only when the interval excludes 1.0. Every target's result is hashed and compared; a warning is
printed when head and base return different answers.

## Metrics and how to read them

- **ms**: per process, the median of the timed runs; across processes, the median, with [min-max]. Wall time moves
  with load and macOS QoS (a background-QoS process can be 3x slower doing the same work), so compare only runs made
  back to back on the same machine, and prefer A/B over comparing two reports.
- **instructions/run**: retired instructions for the timed part: (process with 20 timed runs - the same process with
  0) / 20, measured with `/usr/bin/time -l` on macOS or `perf stat` on Linux (skipped when neither is there). They
  vary under 1% between processes and don't care about load, but they do see a bad JIT state, because baseline code
  retires more instructions than optimized code. Use them as the main A/B number. Default: sentinels only.
- **dfg / retries** (Bun): `numberOfDFGCompiles(exec)` and `reoptimizationRetryCount(exec)` from `bun:jsc` after
  the target. A warm process settles at about 2 / 1; a polluted one keeps recompiling (7 / 6 on origin/dev).
- **OSR exits** (Bun, polluted only): one extra process per order with `BUN_JSC_printEachOSRExit=1`, counting
  "failure in exec#" lines after timing starts, per target. Printing is slow, so these runs are never timed. Zero
  while timing means the history left `exec` in a compile that covers the targets.
- **polluted / warm**: the state-stability number. About 1.0x when the history doesn't hurt; 2x or more on a
  sentinel means `exec` is stuck in a bad compile.
- **guest fuel / frames** (`--counters`): fuel ticks spent in `Vm.exec` (loops, calls and built-ins, as the
  interpreter meters them) and frames acquired, per run. Exact and identical on Bun and Node, so a change in them is
  a change in what the interpreter does, not in how fast the host runs it. The counter wraps `Vm.exec` from the
  harness (nothing in `src/` changes), which changes how JSC compiles it, so counter runs are separate and untimed.

## CI

`.github/workflows/perf.yml` runs two jobs:

- **smoke**: every cell once on Bun and Node, so the harness keeps working.
- **exits** (`bun run perf gate`): the polluted history in `fwd` and `rev` order, then the three sentinels, with
  exits counted. It fails when exec OSR exits while timing the sentinels exceed `--max-exits` (0) in either order.
  On origin/dev today it fails (see below), so the job is `continue-on-error`; once the main-loop fix makes it pass,
  remove that line and it guards the fix. Exit counts are close to deterministic (fwd gives the same count on macOS
  arm64 and Linux x86), unlike wall time on a shared runner, which is why the gate doesn't time anything.

## Validation on origin/dev

`bun run perf --counters` at e8380b6, Bun 1.4.4, Apple M5, macOS, 5 processes per cell, load average 6.5-16 (busy
machine: read the ratios, instructions and exit counts, not absolute ms).

| target | warm ms | polluted fwd ms | polluted / warm (fwd, rev, shuf:1, shuf:2, shuf:3) | instructions/run warm -> fwd |
|---|---:|---:|---|---:|
| classes | 30.5 | 86.1 | 2.82x, 1.19x, 2.64x, 2.71x, 3.14x | 954 M -> 2,381 M |
| protoMethod | 17.2 | 69.4 | 4.04x, 1.16x, 3.88x, 1.04x, 1.09x | 581 M -> 2,110 M |
| accessors | 25.6 | 76.2 | 2.98x, 1.99x, 3.14x, 1.05x, 1.00x | 790 M -> 2,088 M |
| closureCall | 28.9 | 26.6 | 0.92x, 1.06x, 2.89x, 2.65x, 2.99x | |

Every other target stays within about 0.85-1.3x. `exec` ends warm runs at dfg 2 / retries 1 and the fwd history at
7 / 6. Exec OSR exits while timing (7 runs per target): fwd 1,092 (sentinels 1,057), rev 1,477, shuffles 2,437-4,163.
The quick gate (sentinels only, 5 runs each) gave fwd 755 on two runs and rev 545-3,101: fwd is deterministic, rev is
not. On Node 24 the polluted cell is no slower than warm (classes 0.81x), matching earlier measurements.

Other cells: cold first execute 19.4 ms (`return 1`) and 25.3 ms (agent body), plus 10.7 ms to import, `Runtime.make`
0.03 ms; mixed (unique text) median of per-body medians 275 µs, 9.6 M instructions per run; repeat 222 µs, 8.7 M.

Noise floor: an A/B of two checkouts of the same commit gave instruction ratios of 0.977-0.988 (wall 1.06-1.14 under
load), so treat instruction differences under ~3% between two directories as noise unless they repeat with the sides
swapped.
