// Resumes a saved run in its own process: `bun resume-process.ts <state file>`. The `step` host function answers
// `{ value: input.value * 2 }`.
import { Effect } from "effect"
import { Host, Runtime } from "../../src/index.js"

const step = Host.fn(([input]) => ({ value: (input as { value: number }).value * 2 }))
const [file] = process.argv.slice(2)
const bytes = new Uint8Array(await Bun.file(file!).arrayBuffer())
const resumed = Runtime.make({ globals: () => ({ step }) }).resume(bytes)
console.log(JSON.stringify(await Effect.runPromise(resumed.run())))
