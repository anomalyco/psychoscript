import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Runtime } from "../src/index.js"
import { generateCases, type Op, staticCases } from "./node-buffer/fuzz.js"

// Differential fuzz: the same random Buffer operations run in psychoscript and in Node 24's own Buffer (`node` on the
// PATH, or $PSYCHOSCRIPT_NODE), comparing every result, every thrown error's class, code and message, and every
// buffer's bytes after each step. $PSYCHOSCRIPT_BUFFER_FUZZ_SEED and $PSYCHOSCRIPT_BUFFER_FUZZ_CASES run other or more
// cases. Node 25 changed how some methods behave on a plain Uint8Array, so other versions are skipped.

const directory = path.join(import.meta.dir, "node-buffer")
const binary = Bun.which(process.env.PSYCHOSCRIPT_NODE ?? "node")
const version = binary === null ? undefined : Bun.spawnSync([binary, "--version"]).stdout.toString().trim()
const supported = version?.startsWith("v24.") === true

const seed = Number(process.env.PSYCHOSCRIPT_BUFFER_FUZZ_SEED ?? 20261127)
const count = Number(process.env.PSYCHOSCRIPT_BUFFER_FUZZ_CASES ?? 600)

type Trace = Array<unknown>

const inNode = async (cases: Array<Array<Op>>): Promise<Array<Trace>> => {
  const child = Bun.spawn([binary!, "--no-deprecation", path.join(directory, "fuzz-node.mjs")], {
    stdin: new Blob([JSON.stringify(cases)]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" })
  return JSON.parse(stdout)
}

const inPsychoscript = async (cases: Array<Array<Op>>): Promise<Array<Trace>> => {
  const driver = await Bun.file(path.join(directory, "fuzz-driver.js")).text()
  const result = await Runtime.make().execute(`${driver}\nreturn runCases(cases)`, { bindings: { cases: cases as never } })
  if (!result.ok) throw new Error(`The fuzz driver failed: ${result.error.message}`)
  return result.value as Array<Trace>
}

// Differences that come from psychoscript itself rather than its Buffer: its memory limit, and the messages of the
// Uint8Array methods Node's generic ones hand on to.
const settle = (entry: unknown, other: unknown) => {
  if (!Array.isArray(entry) || !Array.isArray(other) || entry[0] !== "err" || other[0] !== "err") return entry
  const [, name, code, message] = entry as [string, string, string | null, string]
  const [, otherName, , otherMessage] = other as [string, string, string | null, string]
  if (name === "RangeError" && otherName === "RangeError" && otherMessage === "Invalid array length") {
    if (code === "ERR_MEMORY_ALLOCATION_FAILED" || message === "Array buffer allocation failed") return other
  }
  if (code === null && name === otherName && `${message}.` === otherMessage) return other
  return entry
}

describe("Buffer differential fuzz", () => {
  test.skipIf(!supported)(
    `matches Node 24's Buffer (seed ${seed}, ${count} cases)`,
    async () => {
      const cases = [...generateCases(seed, count), ...staticCases(seed, Math.ceil(count / 20))]
      const [expected, actual] = await Promise.all([inNode(cases), inPsychoscript(cases)])
      const mismatches = cases.flatMap((ops, index) => {
        const at = ops.findIndex((_, step) => {
          const want = expected[index]![2 * step]
          return (
            JSON.stringify(settle(want, actual[index]![2 * step])) !== JSON.stringify(actual[index]![2 * step]) ||
            expected[index]![2 * step + 1] !== actual[index]![2 * step + 1]
          )
        })
        if (at < 0) return []
        return [
          {
            case: index,
            operations: ops.slice(0, at + 1),
            node: expected[index]!.slice(2 * at, 2 * at + 2),
            psychoscript: actual[index]!.slice(2 * at, 2 * at + 2),
          },
        ]
      })
      expect(mismatches.slice(0, 5)).toEqual([])
    },
    120_000,
  )
})
