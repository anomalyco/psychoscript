import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Runtime } from "../src/index.js"
import { warmupSource } from "../src/vm.js"

// JavaScriptCore compiles `Vm.exec` from the code it has seen run, and leaves the compiled loop for the rest of a slice
// at code it never saw, so the warm-up it gets must run every part of `exec` that doesn't end the call anyway. An arm
// added to `exec` without warm-up coverage (or moved out to `execWide`) fails here.

type Line = { readonly line: number; readonly text: string }

// Runs of unrun lines, joined over blank and comment lines.
const blocks = (lines: ReadonlyArray<Line>) =>
  lines.reduce<Array<Array<Line>>>((all, line) => {
    const last = all.at(-1)?.at(-1)
    if (last !== undefined && line.line === last.line + 1) all.at(-1)!.push(line)
    else all.push([line])
    return all
  }, [])

// A block that ends by throwing or returning from `exec` only costs itself if it leaves the compiled loop.
const leavesExec = (block: ReadonlyArray<Line>) => {
  const last = block.filter((line) => line.text !== "" && !line.text.startsWith("//")).at(-1)
  return last !== undefined && /^(return\b|throw\b|this\.fail\w*\()/.test(last.text)
}

describe("warm-up", () => {
  test("the JavaScriptCore warm-up runs every part of exec that doesn't leave it", async () => {
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/warmup-coverage.ts")], {
      env: { ...process.env, BUN_JSC_useControlFlowProfiler: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code: await child.exited, stderr }).toMatchObject({ code: 0 })
    const unrun = blocks(JSON.parse(stdout) as Array<Line>).filter((block) => !leavesExec(block))
    expect(unrun.map((block) => block.map((line) => `${line.line}: ${line.text}`).join("\n"))).toEqual([])
  })

  test("both warm-up programs run to their end", async () => {
    for (const wide of [false, true]) {
      const result = await Runtime.make().execute(warmupSource(wide))
      expect(result).toMatchObject({ ok: true })
    }
  })

  test("an unknown engine is refused", () => {
    expect(() => Runtime.make({ engine: "rhino" as "jsc" })).toThrow(RangeError)
  })
})
