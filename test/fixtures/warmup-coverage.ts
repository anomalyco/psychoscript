// Run with BUN_JSC_useControlFlowProfiler=1: prints the lines of `Vm.exec` the JavaScriptCore warm-up never ran, as JSON.
// @ts-expect-error Bun exports it but its types don't declare it.
import { codeCoverageForFile } from "bun:jsc"
import path from "node:path"
import { Runtime } from "../../src/index.js"

await Runtime.make({ engine: "jsc" }).execute("return 1")
const file = path.join(import.meta.dir, "../../src/vm.ts")
const source = (await Bun.file(file).text()).split("\n")
const start = source.indexOf("  private exec(): number {") + 1
const end = source.findIndex((line, i) => i >= start && line === "  }") + 1
// "<file> | <ranges>", where a range is "a" or "a-b" of 1-based lines that never ran.
const lines = (codeCoverageForFile(file) as string)
  .split("|")
  .pop()!
  .trim()
  .split(",")
  .filter((range) => range !== "")
  .flatMap((range) => {
    const [a, b = a] = range.split("-").map(Number) as [number, number?]
    return Array.from({ length: b - a + 1 }, (_, i) => a + i)
  })
  .filter((line) => line >= start && line <= end)
console.log(JSON.stringify(lines.map((line) => ({ line, text: source[line - 1]!.trim() }))))
