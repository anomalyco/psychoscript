// One measurement process. The runner (run.ts) spawns it; it is not meant to be run by hand.
// Usage: bun script/perf/worker.ts '<json Job>'   (on Node: the bundled copy the runner builds, with the same argument)
// Prints one JSON line (Report) to stdout, and `=====MEASURE` to stderr where timing starts, so OSR exit logs can be split.
import { createHash } from "node:crypto"
import type { Host, Runtime } from "../../src/index.js"
import type { Vm } from "../../src/vm.js"
import { agentGlobals, agents } from "./corpus/agents.js"
import { dataGlobals, history, HISTORY_VERSION } from "./corpus/history.js"
import { targets } from "./corpus/targets.js"

export type Cell = "cold" | "warm" | "polluted" | "mixed" | "repeat"

export type Job = {
  readonly cell: Cell
  /** psychoscript checkout to measure: `src/` on Bun, the built `dist/` on Node. */
  readonly checkout: string
  readonly targets: ReadonlyArray<string>
  /** Timed executes per target (warm, polluted) or measured rounds over the agent corpus (mixed, repeat). 0 runs only the setup, for instruction subtraction. */
  readonly iters: number
  /** Untimed executes per target before timing (warm), or untimed rounds (mixed, repeat). */
  readonly settle: number
  /** History order for polluted: fwd, rev or shuf:<seed>. */
  readonly order: string
  /** Count guest work (fuel ticks and frames) instead of trusting timing; wraps `Vm.exec`, so never time with it. */
  readonly counters: boolean
}

export type TargetReport = {
  readonly ms: ReadonlyArray<number>
  readonly median: number
  /** Hash of the result, compared across checkouts so an A/B never compares different answers. */
  readonly result: string
  readonly dfg?: number
  readonly retries?: number
  readonly guest?: { readonly fuel: number; readonly frames: number }
}

const job: Job = JSON.parse(process.argv[2]!)
const bun = process.versions.bun !== undefined
const t0 = performance.now()
const base = job.checkout + (bun ? "/src/" : "/dist/")
const ps = (await import(base + (bun ? "index.ts" : "index.js"))) as { Runtime: typeof Runtime; Host: typeof Host }
const VmClass = ((await import(base + (bun ? "vm.ts" : "vm.js"))) as { Vm: typeof Vm }).Vm
const importMs = performance.now() - t0
const exec = VmClass.prototype["exec"] as () => number
const jsc = bun ? await import("bun:jsc") : undefined
const jit = () => (jsc === undefined ? {} : { dfg: jsc.numberOfDFGCompiles(exec), retries: jsc.reoptimizationRetryCount(exec) })
const guest = { fuel: 0, frames: 0 }
if (job.counters) {
  const proto = VmClass.prototype as unknown as { exec: () => number; acquire: (code: unknown) => unknown; fuel: number }
  const acquire = proto.acquire
  proto.exec = function (this: { fuel: number }) {
    const before = this.fuel
    const signal = exec.call(this)
    guest.fuel += before - this.fuel
    return signal
  }
  proto.acquire = function (this: unknown, code: unknown) {
    guest.frames++
    return acquire.call(this, code)
  }
}

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? NaN
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12)

const run = async (rt: Runtime.Runtime, code: string) => {
  const result = await rt.execute(code)
  if (!result.ok) throw new Error("program failed: " + JSON.stringify(result).slice(0, 500) + "\n" + code.slice(0, 200))
  return result
}

const timeTarget = async (rt: Runtime.Runtime, name: string, settle: number): Promise<TargetReport> => {
  const code = targets[name]
  if (code === undefined) throw new Error("unknown target " + name)
  console.error("=====CASE " + name)
  let last: unknown
  for (let i = 0; i < settle; i++) last = await run(rt, code)
  const ms: Array<number> = []
  const g0 = { ...guest }
  for (let i = 0; i < job.iters; i++) {
    const s = performance.now()
    last = await run(rt, code)
    ms.push(performance.now() - s)
  }
  const per = Math.max(job.iters, 1)
  return {
    ms,
    median: median(ms),
    result: hash(JSON.stringify(last ?? null)),
    ...jit(),
    ...(job.counters ? { guest: { fuel: (guest.fuel - g0.fuel) / per, frames: (guest.frames - g0.frames) / per } } : {}),
  }
}

const shuffle = <T>(xs: ReadonlyArray<T>, seed: number) => {
  const out = [...xs]
  let x = seed
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    const j = x % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const ordered = (order: string) => {
  if (order === "fwd") return history
  if (order === "rev") return [...history].reverse()
  if (order.startsWith("shuf:")) return shuffle(history, Number(order.slice(5)))
  throw new Error("unknown order " + order)
}

const report = await (async () => {
  if (job.cell === "cold") {
    const name = job.targets[0]!
    const s = performance.now()
    const rt = ps.Runtime.make({ globals: () => ({ ...dataGlobals(ps.Host), ...agentGlobals(ps.Host) }) })
    const make = performance.now() - s
    const result = await run(rt, targets[name]!)
    const first = performance.now() - s - make
    return { importMs, makeMs: make, firstMs: first, result: hash(JSON.stringify(result)), ...jit() }
  }
  if (job.cell === "warm" || job.cell === "polluted") {
    const rt = ps.Runtime.make({ globals: () => ({ ...dataGlobals(ps.Host), ...agentGlobals(ps.Host) }) })
    if (job.cell === "polluted") {
      const programs = ordered(job.order)
      for (let k = 0; k < 2; k++) for (const code of programs) await run(rt, code)
    }
    console.error("=====MEASURE")
    const out: Record<string, TargetReport> = {}
    // Warm: each target settles first, then is timed. Polluted: the history is the warm-up.
    for (const name of job.targets) out[name] = await timeTarget(rt, name, job.cell === "warm" ? job.settle : 0)
    return {
      importMs,
      targets: out,
      ...(job.cell === "polluted" ? { history: { version: HISTORY_VERSION, hash: hash(history.join("\0")), order: job.order } } : {}),
    }
  }
  // mixed: every body gets a unique suffix, so each execute parses and compiles new text, as a long-lived agent host
  // sees. repeat: the same 30 texts over and over.
  const rt = ps.Runtime.make({ globals: () => agentGlobals(ps.Host) })
  const unique = job.cell === "mixed"
  let n = 0
  const text = (code: string) => (unique ? code + "\n// " + n++ : code)
  for (let r = 0; r < job.settle; r++) for (const code of agents) await run(rt, text(code))
  console.error("=====MEASURE")
  const per: Array<Array<number>> = agents.map(() => [])
  const g0 = { ...guest }
  for (let r = 0; r < job.iters; r++)
    for (const [i, code] of agents.entries()) {
      const body = text(code)
      const s = performance.now()
      await run(rt, body)
      per[i]!.push((performance.now() - s) * 1000)
    }
  const all = per.flat()
  const medians = per.map(median)
  const runs = Math.max(all.length, 1)
  return {
    importMs,
    runs: all.length,
    medianOfMediansUs: median(medians),
    meanUs: all.reduce((a, b) => a + b, 0) / runs,
    p90Us: [...all].sort((a, b) => a - b)[Math.floor(all.length * 0.9)] ?? NaN,
    agentUs: medians[0]!,
    ...jit(),
    ...(job.counters ? { guest: { fuel: (guest.fuel - g0.fuel) / runs, frames: (guest.frames - g0.frames) / runs } } : {}),
  }
})()

console.log(JSON.stringify({ engine: bun ? "bun " + process.versions.bun : "node " + process.versions.node, ...report }))
process.exit(0)
