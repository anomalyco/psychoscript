import { Effect } from "effect"
import type { Json } from "../src/data.js"
import { Host } from "../src/host-function.js"
import { Runtime } from "../src/runtime.js"

/** Runs a program in a fresh runtime with no host globals. */
export const execute = (code: string, bindings?: Readonly<Record<string, Json>>, options?: Runtime.Options) =>
  Effect.runPromise(Runtime.make(options).execute(code, { bindings }))

/** A host namespace with nothing in it: an opaque value programs can hold but not read as data. */
export const emptyNamespace = Host.namespace({
  keys: () => [],
  resolve: (path) => Host.missing(`Nothing is at '${path.join(".")}'.`),
})

/** A host function that answers with an object, not a list. */
export const search = Host.fn(() => ({ items: [] }))

/** The value a program returns; throws when it fails. */
export const value = async (code: string, bindings?: Readonly<Record<string, Json>>) => {
  const result = await execute(code, bindings)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

/** The error a program fails with; throws when it succeeds. */
export const failure = async (code: string, bindings?: Readonly<Record<string, Json>>) => {
  const result = await execute(code, bindings)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}
