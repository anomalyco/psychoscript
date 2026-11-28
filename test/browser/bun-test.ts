// The part of bun:test the browser job's test files use. Tests register here and `run` runs them in order.

type Body = () => unknown
type Test = { readonly name: string; readonly body: Body }

const tests: Array<Test> = []
const suites: Array<string> = []

export const describe = (name: string, body: () => void): void => {
  suites.push(name)
  try {
    body()
  } finally {
    suites.pop()
  }
}

const add = (name: string, body: Body): void => {
  tests.push({ name: [...suites, name].join(" > "), body })
}

const each =
  (rows: ReadonlyArray<unknown>) =>
  (name: string, body: (...args: Array<unknown>) => unknown): void => {
    for (const row of rows) {
      const args = Array.isArray(row) ? row : [row]
      let index = 0
      add(
        name.replace(/%[sdifjo]/g, () => String(args[index++])),
        () => body(...args),
      )
    }
  }

export const test = Object.assign(add, { each, only: add, skip: (_name: string, _body: Body) => {}, todo: (_name: string) => {} })

const asymmetric = Symbol("asymmetric")
type Asymmetric = { readonly [asymmetric]: (actual: unknown) => boolean; readonly description: string }

const isAsymmetric = (value: unknown): value is Asymmetric =>
  typeof value === "object" && value !== null && asymmetric in value

const equals = (actual: unknown, expected: unknown, subset = false): boolean => {
  if (isAsymmetric(expected)) return expected[asymmetric](actual)
  if (Object.is(actual, expected)) return true
  if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) return false
  if (Array.isArray(actual) !== Array.isArray(expected)) return false
  if (Array.isArray(expected)) {
    const items = actual as Array<unknown>
    return items.length === expected.length && expected.every((item, index) => equals(items[index], item, subset))
  }
  const own = (value: object) => Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined)
  const expectedKeys = own(expected)
  if (!subset && own(actual).length !== expectedKeys.length) return false
  return expectedKeys.every((key) =>
    equals((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], subset),
  )
}

const show = (value: unknown): string => {
  if (isAsymmetric(value)) return value.description
  try {
    return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? `${item}n` : item)) ?? String(value)
  } catch {
    return String(value)
  }
}

const matchers = (actual: unknown, negated: boolean) => {
  const check = (pass: boolean, what: string) => {
    if (pass === negated) throw new Error(`Expected ${show(actual)} ${negated ? "not " : ""}${what}`)
  }
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `to be ${show(expected)}`),
    toEqual: (expected: unknown) => check(equals(actual, expected), `to equal ${show(expected)}`),
    toMatchObject: (expected: unknown) => check(equals(actual, expected, true), `to match ${show(expected)}`),
    toContain: (expected: unknown) =>
      check(
        typeof actual === "string"
          ? actual.includes(expected as string)
          : Array.isArray(actual) && actual.some((item) => equals(item, expected)),
        `to contain ${show(expected)}`,
      ),
    toStartWith: (expected: string) =>
      check(typeof actual === "string" && actual.startsWith(expected), `to start with ${show(expected)}`),
    toMatch: (expected: RegExp | string) =>
      check(
        typeof actual === "string" && (typeof expected === "string" ? actual.includes(expected) : expected.test(actual)),
        `to match ${String(expected)}`,
      ),
    toBeNull: () => check(actual === null, "to be null"),
    toBeInstanceOf: (expected: abstract new (...args: Array<never>) => unknown) =>
      check(actual instanceof expected, `to be an instance of ${expected.name}`),
    toBeGreaterThan: (expected: number) => check((actual as number) > expected, `to be greater than ${expected}`),
    toBeLessThan: (expected: number) => check((actual as number) < expected, `to be less than ${expected}`),
  }
}

const matcher = (match: (actual: unknown) => boolean, description: string): Asymmetric => ({
  [asymmetric]: match,
  description,
})

export const expect = Object.assign(
  (actual: unknown) => Object.assign(matchers(actual, false), { not: matchers(actual, true) }),
  {
    any: (type: abstract new (...args: Array<never>) => unknown) =>
      matcher(
        (actual) => actual instanceof type || typeof actual === type.name.toLowerCase(),
        `any ${type.name}`,
      ),
    arrayContaining: (items: ReadonlyArray<unknown>) =>
      matcher(
        (actual) => Array.isArray(actual) && items.every((item) => actual.some((value) => equals(value, item))),
        `an array containing ${show(items)}`,
      ),
    stringContaining: (text: string) =>
      matcher((actual) => typeof actual === "string" && actual.includes(text), `a string containing ${show(text)}`),
    stringMatching: (pattern: RegExp | string) =>
      matcher(
        (actual) => typeof actual === "string" && (typeof pattern === "string" ? actual.includes(pattern) : pattern.test(actual)),
        `a string matching ${String(pattern)}`,
      ),
  },
)

export type Outcome = { readonly name: string; readonly status: "passed" | "failed" | "skipped"; readonly error?: string }

/** Runs the registered tests in order, skipping those `skip` names a reason for. */
export const run = async (skip: (name: string) => string | undefined): Promise<Array<Outcome>> => {
  const outcomes: Array<Outcome> = []
  for (const item of tests) {
    if (skip(item.name) !== undefined) {
      outcomes.push({ name: item.name, status: "skipped" })
      continue
    }
    try {
      await item.body()
      outcomes.push({ name: item.name, status: "passed" })
    } catch (error) {
      // Firefox's stack leaves out the message, and a stack overflow's runs to thousands of frames.
      const where = error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 4).join("\n") : ""
      outcomes.push({ name: item.name, status: "failed", error: `${String(error)}\n${where}` })
    }
  }
  return outcomes
}
