import { type Execute, type Outcome, runNodeTest } from "./run.js"

// The vendored tests and what's expected of each: the lines of the top-level statements that fail (see README.md).

export type Expected = Record<string, { readonly total: number; readonly failing: ReadonlyArray<number> }>

/** The lines of an outcome's failing statements, in order. */
export const failingLines = (outcome: Outcome) =>
  [...new Set(outcome.failures.map((failure) => failure.line))].sort((a, b) => a - b)

/** Runs every test in `expected`, reading files with `read`, and returns each one's outcome. */
export const runSuite = async (
  execute: Execute,
  read: (name: string) => Promise<string>,
  files: ReadonlyArray<string>,
): Promise<Record<string, Outcome>> => {
  const harness = await read("harness.js")
  const outcomes: Record<string, Outcome> = {}
  for (const file of files) outcomes[file] = await runNodeTest(execute, harness, await read(file))
  return outcomes
}
