# Rust against dev's TypeScript

Rust `d520cec` against `dev`'s TypeScript `104de6f`, on an Apple M5 Max (18 cores, macOS 26.7.1), bun 1.4.4, rustc
1.99.1. Measured under `nice` at a load average below 5, holding `/tmp/ps-timing.lock`. Speed-ups are TypeScript's
median over Rust's.

| Measure | TypeScript | Rust | Rust speed-up |
|---|---:|---:|---:|
| Startup: process start to the result of `return 1`, median of 20 | 68.2 ms | 2.0 ms | 34x |
| Corpus: 429 programs, warm `execute`, median program | 114 µs | 27 µs | 4.3x (geometric mean; 3.8x–4.9x p25–p75) |
| Bench programs: the 9 cases of `compare.sh` (a), median of 11 | 1.6–43.8 ms | 0.5–11.5 ms | 2.0x (geometric mean; 1.2x–3.9x) |
| Plugin event: `bench/plugin/reducer.js`, µs per `execute`, median of 2,000 | 77.0 µs | 23.0 µs | 3.3x |
| Peak RSS: the 9 bench programs, each in a fresh process | 83–119 MiB | 4.3–20 MiB | |

- Startup, bench programs, plugin event and RSS: `PSYCHOSCRIPT_REF=<dev checkout> bash bench/compare.sh`, in full
  in [`RESULTS.md`](RESULTS.md). Its typed-array cases have no TypeScript column, as `dev` has no typed arrays.
- Corpus: the differential corpus (436 programs: the test suite's, targeted probes, and agent sessions; kept outside
  the repository) through the same host on both sides, each program timed 7 times after its recorded run, in 3
  alternating passes; per program, the median of the passes. Left out: 6 programs that mostly wait on timers
  (300–420 ms on both sides) and one that runs into its 5 s timeout. One program is slower in Rust: 2,000 objects
  through an async tool call, 2.8 ms against 3.7 ms.
