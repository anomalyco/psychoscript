import { describe, expect, test } from "bun:test"
import { Runtime } from "../src/index.js"
import { type Expected, failingLines } from "./node-buffer/suite.js"
import { runNodeTest } from "./node-buffer/run.js"

// Node's own Buffer tests (test/node-buffer, from Node 24), run inside psychoscript a top-level statement at a time.
// expected.json lists the statements each file is known to fail; `bun run script/node-buffer.ts --write` updates it.

const directory = new URL("./node-buffer/", import.meta.url)
const read = (name: string) => Bun.file(new URL(name, directory)).text()
const harness = await read("harness.js")
const expected = (await Bun.file(new URL("expected.json", directory)).json()) as Expected
const runtime = Runtime.make({ limits: { timeoutMs: 60_000 } })

describe("Node's Buffer tests", () => {
  for (const [file, known] of Object.entries(expected)) {
    test(file, async () => {
      const outcome = await runNodeTest((code) => runtime.execute(code), harness, await read(file))
      const failing = failingLines(outcome)
      const messages = outcome.failures.filter((failure) => !known.failing.includes(failure.line))
      expect({ total: outcome.total, failing, newFailures: messages }).toEqual({
        total: known.total,
        failing: [...known.failing],
        newFailures: [],
      })
    }, 30_000)
  }
})
