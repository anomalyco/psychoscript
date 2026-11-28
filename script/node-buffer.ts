// Runs Node's vendored Buffer tests (test/node-buffer) inside psychoscript and prints how many top-level statements of
// each pass. Pass --write to regenerate test/node-buffer/expected.json from the results, or --node to run them with
// the built package under Node (`node` on the PATH, or $PSYCHOSCRIPT_NODE) instead of the sources under Bun.
//
// Usage: bun run script/node-buffer.ts [--write] [--node] [file-filter]
import path from "node:path"
import { $ } from "bun"
import type { Outcome } from "../test/node-buffer/run.js"
import { failingLines, runSuite } from "../test/node-buffer/suite.js"

const root = path.join(import.meta.dir, "..")
const directory = path.join(root, "test/node-buffer")
const write = process.argv.includes("--write")
const node = process.argv.includes("--node")
const filter = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? ""
const files = [...new Bun.Glob("test-buffer-*.js").scanSync(directory)].filter((file) => file.includes(filter)).sort()

const outcomes: Record<string, Outcome> = node ? await underNode() : await underBun()

let passed = 0
let total = 0
for (const file of files) {
  const outcome = outcomes[file]!
  const failed = failingLines(outcome).filter((line) => line > 0).length
  passed += outcome.total - failed
  total += outcome.total
  console.log(`${file.padEnd(44)} ${String(outcome.total - failed).padStart(4)} / ${outcome.total}`)
}
console.log(`${"total".padEnd(44)} ${String(passed).padStart(4)} / ${total}`)

if (write) {
  const expected = Object.fromEntries(
    files.map((file) => [file, { total: outcomes[file]!.total, failing: failingLines(outcomes[file]!) }]),
  )
  await Bun.write(path.join(directory, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`)
}

async function underBun() {
  const { Runtime } = await import("../src/index.js")
  const runtime = Runtime.make({ limits: { timeoutMs: 60_000 } })
  return runSuite((code) => runtime.execute(code), (name) => Bun.file(path.join(directory, name)).text(), files)
}

// Builds the package, bundles the runner for Node, and runs it there over dist/.
async function underNode() {
  await $`bun run build`.cwd(root).quiet()
  const built = await Bun.build({ entrypoints: [path.join(directory, "node-entry.ts")], target: "node", format: "esm" })
  if (!built.success) throw new AggregateError(built.logs, "Bundling the Node runner failed")
  const bundle = path.join(root, "dist", "node-buffer-runner.mjs")
  await Bun.write(bundle, built.outputs[0]!)
  const binary = process.env.PSYCHOSCRIPT_NODE ?? "node"
  const output = await $`${binary} ${bundle} ${path.join(root, "dist/index.js")} ${directory} ${files}`.text()
  await $`rm -f ${bundle}`
  return JSON.parse(output) as Record<string, Outcome>
}
