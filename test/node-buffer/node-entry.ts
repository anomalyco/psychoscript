// The vendored Buffer tests over the built package, bundled for Node by script/node-buffer.ts --node: prints each
// file's outcome as JSON. Arguments: the package's built entry, the test directory, then the files.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Runtime } from "../../src/index.js"
import { runSuite } from "./suite.js"

const [entry, directory, ...files] = process.argv.slice(2)
const built = (await import(pathToFileURL(entry!).href)) as { Runtime: typeof Runtime }
const runtime = built.Runtime.make({ limits: { timeoutMs: 60_000 } })
const outcomes = await runSuite(
  (code) => runtime.execute(code),
  (name) => readFile(path.join(directory!, name), "utf8"),
  files,
)
process.stdout.write(JSON.stringify(outcomes))
