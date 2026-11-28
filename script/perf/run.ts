#!/usr/bin/env bun

// psychoscript benchmark runner: cold, warm, polluted, mixed and repeat cells, on Bun (src/) and Node (dist/).
// Usage: bun run script/perf/run.ts [options]          see script/perf/README.md
//        bun run script/perf/run.ts gate [options]     Bun only: fail when exec OSR exits while timing exceed --max-exits

import { mkdtempSync, rmSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { sentinels, targets } from "./corpus/targets.js"
import { bootstrapMedian, max, median, min } from "./stats.js"
import type { Cell, Job, TargetReport } from "./worker.js"

const here = fileURLToPath(new URL(".", import.meta.url))
const args = parseArgs({
  allowPositionals: true,
  options: {
    cells: { type: "string", default: "cold,warm,polluted,mixed,repeat" },
    engine: { type: "string", default: "bun" },
    head: { type: "string", default: resolve(here, "../..") },
    base: { type: "string" },
    procs: { type: "string" },
    iters: { type: "string" },
    settle: { type: "string", default: "3" },
    rounds: { type: "string" },
    orders: { type: "string" },
    targets: { type: "string" },
    instr: { type: "string", default: "sentinels" },
    exits: { type: "boolean", default: true },
    "no-exits": { type: "boolean", default: false },
    counters: { type: "boolean", default: false },
    build: { type: "boolean", default: true },
    "no-build": { type: "boolean", default: false },
    "max-exits": { type: "string", default: "0" },
    quick: { type: "boolean", default: false },
    json: { type: "string" },
  },
})
const opt = args.values
const gate = args.positionals[0] === "gate"
const quick = opt.quick || gate
const procs = Number(opt.procs ?? (quick ? 1 : 5))
const iters = Number(opt.iters ?? (quick ? 5 : 7))
const settle = Number(opt.settle)
// Retired instructions vary well under 1% between processes, so two launches (one A,B and one B,A pair) are enough.
const instrProcs = Math.min(procs, 2)
const instrIters = 20
const rounds = Number(opt.rounds ?? (quick ? 5 : 20))
const orders = (opt.orders ?? (quick ? "fwd,rev" : "fwd,rev,shuf:1,shuf:2,shuf:3")).split(",")
const cells = (gate ? "polluted" : opt.cells).split(",") as Array<Cell>
const engines = (gate ? "bun" : opt.engine).split(",") as Array<"bun" | "node">
const timedTargets = (opt.targets ?? (gate ? sentinels.join(",") : Object.keys(targets).filter((k) => k !== "agent" && k !== "empty").join(","))).split(",")
const coldTargets = opt.targets?.split(",") ?? ["empty", "agent"]
const instrTargets = opt.instr === "none" || gate ? [] : opt.instr === "all" ? timedTargets : opt.instr === "sentinels" ? sentinels.filter((t) => timedTargets.includes(t)) : opt.instr.split(",")
const sides = opt.base === undefined ? [{ name: "head", dir: resolve(opt.head) }] : [{ name: "head", dir: resolve(opt.head) }, { name: "base", dir: resolve(opt.base) }]
const exitsPass = gate || (opt.exits && !opt["no-exits"])
for (const t of [...timedTargets, ...coldTargets]) if (targets[t] === undefined) throw new Error("unknown target " + t + "; have " + Object.keys(targets).join(", "))

const tmp = mkdtempSync(join(tmpdir(), "psychoscript-perf-"))
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }))

// Retired instructions for a whole process: `/usr/bin/time -l` on macOS, `perf stat` on Linux when installed.
const counter = await (async () => {
  if (opt.instr === "none" || gate) return undefined
  if (process.platform === "darwin") return "time" as const
  if (process.platform === "linux" && Bun.which("perf") !== null) {
    const probe = Bun.spawnSync(["perf", "stat", "-x,", "-e", "instructions", "true"], { stderr: "pipe" })
    if (probe.exitCode === 0 && !probe.stderr.toString().includes("not supported")) return "perf" as const
  }
  console.error("note: no instruction counter here (macOS /usr/bin/time -l or Linux perf); skipping instructions")
  return undefined
})()

const nodeWorker = await (async () => {
  if (!engines.includes("node")) return undefined
  if (opt.build && !opt["no-build"])
    for (const side of sides) {
      console.error("building " + side.dir + " for Node")
      const built = Bun.spawnSync(["bun", "run", "build"], { cwd: side.dir, stdout: "ignore", stderr: "inherit" })
      if (built.exitCode !== 0) throw new Error("build failed in " + side.dir)
    }
  const out = await Bun.build({ entrypoints: [join(here, "worker.ts")], target: "node", format: "esm", outdir: tmp, external: ["bun:jsc"] })
  if (!out.success) throw new Error(out.logs.join("\n"))
  return out.outputs[0]!.path
})()

type Spawned = { readonly report: Record<string, unknown>; readonly instructions?: number; readonly exits?: Exits }
type Exits = { readonly total: number; readonly measured: number; readonly byTarget: Record<string, number> }

const spawn = async (engine: "bun" | "node", job: Job, mode: { instr?: boolean; exits?: boolean } = {}): Promise<Spawned> => {
  const worker = engine === "bun" ? ["bun", join(here, "worker.ts")] : ["node", nodeWorker!]
  const instrFile = join(tmp, "instr.txt")
  const cmd =
    mode.instr && counter === "time"
      ? ["/usr/bin/time", "-l", ...worker, JSON.stringify(job)]
      : mode.instr && counter === "perf"
        ? ["perf", "stat", "-x,", "-e", "instructions", "-o", instrFile, "--", ...worker, JSON.stringify(job)]
        : [...worker, JSON.stringify(job)]
  const errFile = join(tmp, "stderr.txt")
  const env = mode.exits ? { ...process.env, BUN_JSC_printEachOSRExit: "1" } : process.env
  const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: Bun.file(errFile) })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  const stderr = await Bun.file(errFile).text()
  if (code !== 0) throw new Error(cmd.slice(0, -1).join(" ") + " exited " + code + "\n" + stderr.slice(-3000))
  const report = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>
  const instructions =
    mode.instr && counter === "time"
      ? Number(/(\d+)\s+instructions retired/.exec(stderr)?.[1] ?? NaN)
      : mode.instr && counter === "perf"
        ? Number(/^(\d+),/m.exec(await Bun.file(instrFile).text())?.[1] ?? NaN)
        : undefined
  return { report, instructions, exits: mode.exits ? countExits(stderr) : undefined }
}

// JSC prints one "Speculation failure in exec#..." per OSR exit with BUN_JSC_printEachOSRExit=1. Count the ones in
// `Vm.exec` after the worker's =====MEASURE marker, per target by its =====CASE marker.
const countExits = (log: string): Exits => {
  const byTarget: Record<string, number> = {}
  let total = 0
  let measured = 0
  let target: string | undefined
  for (const line of log.split("\n")) {
    if (line.startsWith("=====CASE ")) target = line.slice(10)
    if (!line.includes("failure in exec#")) continue
    total++
    if (target === undefined) continue
    measured++
    byTarget[target] = (byTarget[target] ?? 0) + 1
  }
  return { total, measured, byTarget }
}

const job = (cell: Cell, dir: string, rest: Partial<Job> = {}): Job => ({ cell, checkout: dir, targets: timedTargets, iters, settle, order: "fwd", counters: false, ...rest })

// samples[key][side] = per-process values, index = launch slot (so head and base pair up)
const samples = new Map<string, Record<string, Array<number>>>()
const add = (key: string, side: string, value: number | undefined) => {
  if (value === undefined || Number.isNaN(value)) return
  const entry = samples.get(key) ?? {}
  ;(entry[side] ??= []).push(value)
  samples.set(key, entry)
}
const results = new Map<string, Record<string, string>>()
const exitRows: Array<{ engine: string; side: string; order: string; exits: Exits }> = []

// Launch order alternates A,B / B,A by slot, so drift over the run hits both sides equally.
const each = async (fn: (side: { name: string; dir: string }, slot: number) => Promise<void>, slots = procs) => {
  for (let slot = 0; slot < slots; slot++) for (const side of slot % 2 === 0 ? sides : [...sides].reverse()) await fn(side, slot)
}

const checkResult = (key: string, side: string, result: string) => {
  const seen = results.get(key) ?? {}
  seen[side] = result
  results.set(key, seen)
}

for (const engine of engines) {
  const e = engine
  for (const cell of cells) {
    console.error(`[${e}] ${cell}`)
    if (cell === "cold") {
      for (const t of coldTargets)
        await each(async (side) => {
          const r = (await spawn(e, job("cold", side.dir, { targets: [t] }))).report
          add(`${e}|cold|${t}|import ms`, side.name, r.importMs as number)
          add(`${e}|cold|${t}|make ms`, side.name, r.makeMs as number)
          add(`${e}|cold|${t}|first execute ms`, side.name, r.firstMs as number)
          checkResult(`cold|${t}`, side.name, r.result as string)
        })
      continue
    }
    if (cell === "warm" || cell === "polluted") {
      const variants = cell === "warm" ? ["warm"] : orders.map((o) => "polluted " + o)
      for (const variant of variants) {
        const order = variant.split(" ")[1] ?? "fwd"
        // Warm: a fresh process per target. Polluted: one process times all targets after the history.
        const groups = cell === "warm" ? timedTargets.map((t) => [t]) : [timedTargets]
        for (const group of groups)
          await each(async (side) => {
            const r = (await spawn(e, job(cell, side.dir, { targets: group, order }))).report
            for (const [t, rep] of Object.entries(r.targets as Record<string, TargetReport>)) {
              add(`${e}|${variant}|${t}|ms`, side.name, rep.median)
              add(`${e}|${variant}|${t}|dfg`, side.name, rep.dfg)
              add(`${e}|${variant}|${t}|retries`, side.name, rep.retries)
              checkResult(t, side.name, rep.result)
            }
          })
        // Instructions per timed execute: (process with N runs - the same process with 0) / N, one target per process.
        // N is large because the polluted history alone is ~50 G instructions and varies by a few hundred M.
        if (counter !== undefined)
          for (const t of instrTargets)
            await each(async (side) => {
              const full = await spawn(e, job(cell, side.dir, { targets: [t], order, iters: instrIters }), { instr: true })
              const none = await spawn(e, job(cell, side.dir, { targets: [t], order, iters: 0 }), { instr: true })
              add(`${e}|${variant}|${t}|instructions/run`, side.name, (full.instructions! - none.instructions!) / instrIters)
            }, instrProcs)
        if (e === "bun" && exitsPass && cell === "polluted")
          for (const side of sides) {
            const r = await spawn(e, job(cell, side.dir, { order }), { exits: true })
            exitRows.push({ engine: e, side: side.name, order, exits: r.exits! })
          }
        if (opt.counters && cell === "warm")
          for (const side of sides) {
            const r = (await spawn(e, job(cell, side.dir, { counters: true, iters: 1 }))).report
            for (const [t, rep] of Object.entries(r.targets as Record<string, TargetReport>)) {
              add(`${e}|counters|${t}|guest fuel`, side.name, rep.guest!.fuel)
              add(`${e}|counters|${t}|guest frames`, side.name, rep.guest!.frames)
            }
          }
      }
      continue
    }
    await each(async (side) => {
      const r = (await spawn(e, job(cell, side.dir, { iters: rounds, settle: 5 }))).report
      for (const k of ["medianOfMediansUs", "meanUs", "p90Us", "agentUs", "dfg", "retries"]) add(`${e}|${cell}|corpus|${k}`, side.name, r[k] as number)
    })
    if (counter !== undefined)
      await each(async (side) => {
        const full = await spawn(e, job(cell, side.dir, { iters: rounds, settle: 5 }), { instr: true })
        const none = await spawn(e, job(cell, side.dir, { iters: 0, settle: 5 }), { instr: true })
        add(`${e}|${cell}|corpus|instructions/run`, side.name, (full.instructions! - none.instructions!) / (rounds * 30))
      }, instrProcs)
    if (opt.counters)
      for (const side of sides) {
        const r = (await spawn(e, job(cell, side.dir, { iters: 1, settle: 1, counters: true }))).report
        const g = r.guest as { fuel: number; frames: number }
        add(`${e}|${cell}|corpus|guest fuel`, side.name, g.fuel)
        add(`${e}|${cell}|corpus|guest frames`, side.name, g.frames)
      }
  }
}

// ---- report ----
const fmt = (x: number) => (Number.isNaN(x) ? "–" : Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(2) + "M" : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2))
const range = (xs: ReadonlyArray<number>) => (xs.length > 1 ? ` [${fmt(min(xs))}–${fmt(max(xs))}]` : "")
const sha = (dir: string) => {
  const rev = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--short", "HEAD"]).stdout.toString().trim()
  const dirty = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"]).stdout.toString().trim()
  return rev + (dirty ? "+dirty" : "")
}
const meta = {
  date: new Date().toISOString(),
  platform: process.platform + " " + process.arch,
  bun: process.versions.bun,
  node: engines.includes("node") ? Bun.spawnSync(["node", "--version"]).stdout.toString().trim() : undefined,
  loadavg: loadavg().map((x) => x.toFixed(2)).join(" "),
  sides: Object.fromEntries(sides.map((s) => [s.name, s.dir + " @ " + sha(s.dir)])),
  procs,
  iters,
  orders,
}

const lines: Array<string> = []
lines.push(`# psychoscript perf ${meta.date}`, "", "```", JSON.stringify(meta, null, 2), "```", "")
lines.push("Values are medians over processes of each process's median; [min–max] over processes.")
if (sides.length > 1) lines.push("head/base = median of per-slot paired ratios, with a 95% bootstrap interval; below 1 means head is faster.")
lines.push("")
const header = sides.length > 1 ? "| cell | target | metric | head | base | head/base [95% CI] |\n|---|---|---|---:|---:|---:|" : "| cell | target | metric | value |\n|---|---|---|---:|"
for (const engine of engines) {
  lines.push(`## ${engine}`, "", header)
  for (const [key, entry] of samples) {
    const [e, cell, target, metric] = key.split("|")
    if (e !== engine) continue
    const h = entry.head ?? []
    if (sides.length === 1) {
      lines.push(`| ${cell} | ${target} | ${metric} | ${fmt(median(h))}${range(h)} |`)
      continue
    }
    const b = entry.base ?? []
    const ratios = h.map((x, i) => x / b[i]!).filter((x) => Number.isFinite(x))
    const ci = bootstrapMedian(ratios)
    const ratio = ratios.length > 0 && !metric!.startsWith("dfg") && !metric!.startsWith("retries") ? `${median(ratios).toFixed(3)} [${ci[0].toFixed(3)}–${ci[1].toFixed(3)}]` : "–"
    lines.push(`| ${cell} | ${target} | ${metric} | ${fmt(median(h))}${range(h)} | ${fmt(median(b))}${range(b)} | ${ratio} |`)
  }
  lines.push("")
  // polluted vs warm, the state-stability number: ~1 when the history leaves exec in a good compile.
  const warmKeys = [...samples.keys()].filter((k) => k.startsWith(engine + "|warm|") && k.endsWith("|ms"))
  if (warmKeys.length > 0 && orders.length > 0 && cells.includes("polluted")) {
    lines.push(`### ${engine}: polluted / warm (head)`, "", "| target | " + orders.join(" | ") + " |", "|---|" + orders.map(() => "---:").join("|") + "|")
    for (const k of warmKeys) {
      const t = k.split("|")[2]!
      const warm = median(samples.get(k)!.head ?? [])
      const cols = orders.map((o) => median(samples.get(`${engine}|polluted ${o}|${t}|ms`)?.head ?? []) / warm)
      lines.push(`| ${t}${sentinels.includes(t) ? " *" : ""} | ${cols.map((x) => x.toFixed(2) + "x").join(" | ")} |`)
    }
    lines.push("", "\\* sentinel", "")
  }
}
if (exitRows.length > 0) {
  lines.push("## Bun: Vm.exec OSR exits after the polluted history", "", "| side | order | while timing | sentinels while timing | whole process | by target (while timing) |", "|---|---|---:|---:|---:|---|")
  for (const row of exitRows) {
    const sent = sentinels.reduce((a, t) => a + (row.exits.byTarget[t] ?? 0), 0)
    lines.push(`| ${row.side} | ${row.order} | ${row.exits.measured} | ${sent} | ${row.exits.total} | ${Object.entries(row.exits.byTarget).map(([t, n]) => t + " " + n).join(", ")} |`)
  }
  lines.push("")
}
const mismatched = [...results].filter(([, r]) => sides.length > 1 && r.head !== undefined && r.base !== undefined && r.head !== r.base)
for (const [t] of mismatched) lines.push(`**warning:** ${t} returned different results on head and base`)
console.log(lines.join("\n"))
if (opt.json !== undefined)
  await Bun.write(opt.json, JSON.stringify({ meta, samples: Object.fromEntries(samples), exits: exitRows, results: Object.fromEntries(results) }, null, 2))

if (gate) {
  const limit = Number(opt["max-exits"])
  const over = exitRows.filter((r) => sentinels.reduce((a, t) => a + (r.exits.byTarget[t] ?? 0), 0) > limit)
  for (const r of over) console.error(`gate: ${r.side} ${r.order}: ${r.exits.measured} exec OSR exits while timing sentinels (limit ${limit})`)
  if (over.length > 0) process.exit(1)
  console.error(`gate: exec OSR exits while timing sentinels within ${limit} in every order`)
}
