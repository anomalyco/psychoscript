#!/usr/bin/env bun
// The GPU conformance fixtures (opencode `packages/widget/test/fixtures/gpu/*.json`, widgets 7111a0325; copies in
// rust/crates/psychoscript-web/tests/fixtures/gpu): each program runs on this host's WebAssembly (the worker's
// `LiveRun`, from wasm/) under the fixtures' driver, and must post the same batches (ops, and bytes byte for byte),
// give the same program errors from the host checks (src/gpu-checks.ts, which the page runs before replaying), and
// end the same way. Needs scripts/build-wasm.sh first.
//
//   bun scripts/gpu-fixtures.ts [name...]

import path from "node:path"
import { initSync, Program } from "../wasm/psychoscript_web.js"
import { canvasSize, gpuChecks } from "../src/gpu-checks.ts"

const root = path.resolve(import.meta.dir, "..")
const dir = path.resolve(root, "../rust/crates/psychoscript-web/tests/fixtures")
initSync({ module: await Bun.file(path.join(root, "wasm/psychoscript_web_bg.wasm")).arrayBuffer() })
// A live program: the prelude, the live prelude, then the source (widgets.md, Prelude and step ABI).
const prelude =
  (await Bun.file(path.join(dir, "wire/prelude.js")).text()) + "\n" + (await Bun.file(path.join(dir, "wire/prelude-live.js")).text())

interface Fixture {
  name: string
  source: string
  data?: unknown
  canvases: Array<{ key: string; width: number; height: number }>
  inputs?: Array<{ frame: number; after?: boolean; input: { type: string; key?: string; width?: number; height?: number; lost?: string } }>
  gpu: { available: boolean; format: string }
  batches?: Array<{ frame: boolean; ops: unknown; bytes: string }>
  errors: Array<{ message: string; canvases: string[] | "all" }>
  end: string
}

/** Frame `i` at `t = i / 60`, on a canvas 300 x 200 at scale 2. */
const frame = (i: number) => ({ t: i / 60, dt: 1 / 60, width: 300, height: 200, scale: 2, pointer: null, dark: false })
const FRAMES = 10

async function run(f: Fixture) {
  const program = new Program(prelude + "\n" + f.source + "\nreturn await __widget_live(__input(), true)")
  const live = program.startLive(JSON.stringify({ data: f.data ?? null, gpu: f.gpu }), { native: true, sliceBudgetMs: 600_000 })
  const batches: Array<{ frame: boolean; ops: unknown; bytes: string }> = []
  const errors: Array<{ message: string; canvases: readonly string[] | "all" }> = []
  let keys = new Set<string>()
  const checks = gpuChecks(() => keys)
  let requested = false
  let ended = false
  // The outbox in order: renders give the GPU canvases' keys, batches are recorded and checked as the page does.
  const flush = () => {
    const out = JSON.parse(live.takeOutbox()) as Array<{ type: string; message?: Record<string, unknown> }>
    let bytes: Uint8Array | undefined
    for (const e of out) {
      const m = e.message
      if (e.type !== "post" || !m) continue
      if (m.type === "render") keys = new Set(Object.keys((m.gpu as object) ?? {}))
      // A frame request ends a frame: recorded (`frame: true`, without a batch as no ops and no bytes) and the
      // per-frame counts start again. One while a frame is pending isn't one: its batch, if any, is a plain batch.
      const frame = m.type === "frame" && !requested
      if (m.type === "frame") requested = true
      const value = m.type === "frame" ? m.gpu : m.type === "gpu" ? m.batch : undefined
      if (value === undefined) {
        if (frame) {
          batches.push({ frame: true, ops: [], bytes: "" })
          checks.frame()
        }
        continue
      }
      const batch = value as { ops?: unknown; bytes?: unknown }
      if (batch && typeof batch === "object" && Array.isArray(batch.bytes)) {
        bytes ??= live.takeBytes()
        const [offset, length] = batch.bytes as [number, number]
        batch.bytes = bytes.subarray(offset, offset + length)
      }
      if (batch && typeof batch === "object" && batch.bytes instanceof Uint8Array)
        batches.push({ frame, ops: batch.ops, bytes: Buffer.from(batch.bytes).toString("base64") })
      const checked = checks.batch(value)
      if (checked.error) errors.push({ message: checked.error.message, canvases: checked.error.canvases })
      if (frame) checks.frame()
    }
  }
  /** Runs until the program waits on the host; the ms until its next timer, or -1. */
  const pump = () => {
    for (;;) {
      const r = live.pump(50)
      flush()
      if (r === -3) {
        ended = true
        return -1
      }
      if (r !== -2) return r
    }
  }
  const deliver = (message: unknown) => live.deliver(JSON.stringify(message))
  // Until the program asks for a frame or ends; its timers run while it waits (a sixtieth of a second at a time).
  const settle = async () => {
    for (let step = 0; step < 10 && !ended && !requested; step++) {
      const timer = pump()
      if (ended || requested) break
      if (timer >= 0) await Bun.sleep(Math.min(timer, 1000 / 60) + 1)
    }
  }
  // As the page sends them: a canvas's size clamped to the texture limit; a device loss lost by the checks first.
  const input = (given: { type: string; key?: string; width?: number; height?: number; lost?: string }) => {
    if (given.type === "canvas") {
      const [width, height] = canvasSize(given.width!, given.height!)
      return deliver({ type: "canvas", key: given.key, width, height })
    }
    if (given.type === "gpu" && given.lost !== undefined) checks.lost()
    deliver(given)
  }
  for (const c of f.canvases) input({ type: "canvas", ...c })
  for (let i = 0; i < FRAMES; i++) {
    await settle()
    if (ended || !requested) break
    const send = (after: boolean) => {
      for (const entry of (f.inputs ?? []).filter((entry) => entry.frame === i && !!entry.after === after)) input(entry.input)
    }
    send(false)
    requested = false
    deliver({ type: "frame", frame: frame(i) })
    send(true)
  }
  await settle()
  if (!ended) {
    live.stop()
    flush()
  }
  const exit = JSON.parse(live.exit() ?? '{"type":"stopped"}') as { type: string; error?: { message: string } }
  const end = exit.type === "finished" ? "return" : exit.type === "failed" ? `error: ${exit.error!.message}` : "stop"
  live.free()
  program.free()
  return { batches, errors, end }
}

const only = process.argv.slice(2)
const files = [...new Bun.Glob("*.json").scanSync(path.join(dir, "gpu"))].sort()
let failed = 0
for (const file of files) {
  const f = (await Bun.file(path.join(dir, "gpu", file)).json()) as Fixture
  if (only.length > 0 && !only.includes(f.name)) continue
  const started = performance.now()
  const got = await run(f)
  const problems: string[] = []
  if (f.batches) {
    if (got.batches.length !== f.batches.length) problems.push(`${got.batches.length} batches, want ${f.batches.length}`)
    f.batches.forEach((want, i) => {
      const have = got.batches[i]
      if (!have) return
      if (have.frame !== want.frame) problems.push(`batch ${i}: frame ${have.frame}, want ${want.frame}`)
      if (JSON.stringify(have.ops) !== JSON.stringify(want.ops)) problems.push(`batch ${i}: ops differ`)
      if (have.bytes !== want.bytes) problems.push(`batch ${i}: bytes differ (${have.bytes.length} vs ${want.bytes.length} base64 chars)`)
    })
  }
  if (JSON.stringify(got.errors) !== JSON.stringify(f.errors)) problems.push(`errors ${JSON.stringify(got.errors)}, want ${JSON.stringify(f.errors)}`)
  if (got.end !== f.end) problems.push(`end ${got.end}, want ${f.end}`)
  const ms = (performance.now() - started).toFixed(0)
  if (problems.length > 0) failed++
  console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${f.name} (${f.batches ? `${f.batches.length} batches, ` : ""}${f.errors.length} errors, ${ms} ms)${problems.length ? "\n     " + problems.join("\n     ") : ""}`)
}
console.log(failed === 0 ? "all GPU fixtures pass" : `${failed} GPU fixture(s) failed`)
process.exit(failed === 0 ? 0 : 1)
