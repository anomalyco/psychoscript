#!/usr/bin/env bun

// What a typical program costs, by phase: the programs of a corpus directory (rust/bench/corpus: short snippets of the
// kind a model writes) against a host whose tools answer at once with canned data.
// Usage: bun run script/corpus.ts <corpus dir> [--runs N]
// Per program, the median microseconds of: compiling it, running it compiled (a fresh run's setup, the program, its
// host calls), and both from source. The last program, `return 1`, is the setup alone.

import { readdirSync, readFileSync } from "node:fs"
import { Host, Runtime } from "../src/index.js"

const text = (lines: number) =>
  Array.from({ length: lines }, (_, i) =>
    i % 4 === 0
      ? `fn item_${i}(value: usize) -> usize { value + ${i} }\n`
      : i % 4 === 1
        ? `warn line ${i} of the log: something happened\n`
        : i % 4 === 2
          ? `    let mut total_${i} = ${i} * 2; // version = "0.${i}.1"\n`
          : `dep_${i} = "1.${i}"\n`,
  ).join("")
const texts = { 16: text(16), 24: text(24), 240: text(240) }
const json = `[${Array.from({ length: 9 }, (_, i) => `{"slug":"case-${i}","median_ms":${i * 3}.25,"median_instructions":${1_000_000 * (i + 1)}}`).join(",")}]`
const list = Array.from({ length: 24 }, (_, i) => `file_${i}.rs\n`).join("")
const search = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Result ${i}`, content: texts[16] }))

const fn = (f: (input: Record<string, unknown>) => unknown) => Host.fn(([input]) => f((input ?? {}) as Record<string, unknown>), { type: "async" })
const tools = {
  shell: fn((input) => {
    const command = String(input.command ?? "")
    return { output: command.includes("--json") ? json : command.startsWith("ls") ? list : texts[24], exitCode: 0 }
  }),
  read: fn(() => ({ type: "text", content: texts[240] })),
  websearch: fn(() => search),
  write: fn(() => "ok"),
  edit: fn(() => "ok"),
}
const runtime = Runtime.make({ globals: () => ({ tools }) })

const dir = process.argv[2]
if (dir === undefined) throw new Error("usage: bun run script/corpus.ts <corpus dir> [--runs N]")
const at = process.argv.indexOf("--runs")
const runs = at === -1 ? 301 : Number(process.argv[at + 1])
const median = (values: Array<number>) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const measure = async (f: () => unknown) => {
  for (let i = 0; i < 50; i++) await f()
  const times: Array<number> = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await f()
    times.push((performance.now() - start) * 1000)
  }
  return median(times)
}

const rows: Array<[string, number, number, number, number]> = []
for (const name of readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
  const code = readFileSync(`${dir}/${name}`, "utf8")
  const first = await runtime.execute(code)
  if (!first.ok) throw new Error(`${name} failed: ${JSON.stringify(first.error)}`)
  const made = runtime.compile(code)
  if (!made.ok) throw new Error(`${name} does not compile`)
  const compile = await measure(() => runtime.compile(code))
  const run = await measure(() => runtime.program(made.compiled).run())
  const both = await measure(() => runtime.execute(code))
  rows.push([name.replace(/\.js$/, ""), code.length, compile, run, both])
}
const setup = rows.at(-1)![3]
const pad = (v: number) => v.toFixed(0).padStart(9)
console.log(`${"program".padEnd(22)} ${"bytes".padStart(6)} ${"compile".padStart(9)} ${"setup".padStart(9)} ${"program".padStart(9)} ${"total".padStart(9)}  (median µs)`)
const sum = [0, 0, 0, 0]
for (const [name, bytes, compile, run, both] of rows) {
  const program = Math.max(0, run - setup)
  console.log(`${name.padEnd(22)} ${String(bytes).padStart(6)} ${pad(compile)} ${pad(setup)} ${pad(program)} ${pad(both)}`)
  ;[compile, setup, program, both].forEach((v, i) => (sum[i]! += v))
}
console.log(`${"sum".padEnd(22)} ${"".padStart(6)} ${sum.map(pad).join(" ")}`)
const parts = sum[0]! + sum[1]! + sum[2]!
console.log(`${"share".padEnd(22)} ${"".padStart(6)} ${[sum[0]!, sum[1]!, sum[2]!].map((v) => `${((100 * v) / parts).toFixed(0)}%`.padStart(9)).join(" ")}`)
