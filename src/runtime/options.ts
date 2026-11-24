import type { Json } from "../data.js"
import type { Run, Setup } from "./execute.js"

/** Budgets enforced on each run. Time counts active time only, across every resume of a run. */
export type Limits = {
  /** Wall-clock milliseconds before interruption. No default: absent means no timeout. */
  readonly timeoutMs?: number
  /**
   * Maximum UTF-8 bytes retained from the result and logs. Warnings have a separate equal budget; truncation notices
   * are additional.
   */
  readonly maxOutputBytes?: number
  /**
   * The most bytes the run's heap may hold: everything it can still reach, in a size model that is the same on every
   * platform (objects, properties, elements, entries and strings at fixed sizes; see `interpreter-support.md`), not
   * the process's memory. A run over it stops with `MemoryLimitExceeded`. No default: absent means no limit.
   */
  readonly maxHeapBytes?: number
}

/**
 * How a host call's arguments carry program values the host can't hold. Every host function in the runtime gets its
 * arguments this way; the run's result only takes `functions: "mark"`.
 */
export type Translate = {
  /**
   * A program function inside an argument: `"error"` (the default) fails the call; `"drop"` leaves it out, as
   * `JSON.stringify` does: an object's key is left out, an array's item is `null`, and an argument is `undefined`;
   * `"mark"` puts `Host.functionMarker` in its place, and in the run's result where a function would vanish too.
   */
  readonly functions?: "error" | "drop" | "mark" | undefined
  /**
   * A program promise inside an argument: `"error"` (the default) fails the call; `"await"` makes the call wait for it
   * to settle and use its value. A rejection fails the call with its reason.
   */
  readonly promises?: "error" | "await" | undefined
}

/** A runtime's host globals for one run: `Host.fn`, `Host.durableFn`, `Host.namespace`, and plain values of them. */
export type Globals = Readonly<Record<string, unknown>>

/** How `Runtime.make` sets up a runtime: its host globals, module aliases, limits, and argument translation. */
export type Options<G extends Globals = Globals> = {
  /**
   * The globals a program reaches, made for each run when it starts and again when it resumes, so they can keep the
   * run's own state in `run.metadata`.
   */
  readonly globals?: ((run: Run) => G) | undefined
  /** Module names that load a global, beyond its own name: `{ bun: "Bun" }` makes `import "bun"` load `Bun`. */
  readonly modules?: Readonly<Record<string, string>> | undefined
  /** Budgets every run gets; none by default. */
  readonly limits?: Limits | undefined
  /** How host calls receive program functions and promises inside arguments; both fail the call by default. */
  readonly translate?: Translate | undefined
  /**
   * Whether programs have the typed arrays besides `Uint8Array` (`ArrayBuffer`, `Uint16Array`, `Uint32Array`,
   * `Int32Array`, `Float32Array`, `Float64Array`), and host functions may return them; off by default. Off, as before
   * they were added, a host function that returns one fails at the call, and a `Uint8Array` has no `byteLength`,
   * `byteOffset` or `buffer`, keeps other numeric keys as properties, and reads one out of range from its prototypes.
   * A run resumes only in a runtime with the same setting.
   */
  readonly typedArrays?: boolean | undefined
}

/** Options for `Runtime.program`. */
export type ProgramOptions = {
  /** Read-only JSON values bound in the program's outer scope (shadowable by top-level declarations). */
  readonly bindings?: Readonly<Record<string, Json>> | undefined
  /** Names this run's host calls (`<runId>:<callId>`); a random UUID by default. */
  readonly runId?: string | undefined
}

/** How `program.suspend` saves a run's state. */
export type SuspendOptions = {
  /** The most bytes a saved state may take; a larger one fails the suspend, and the run goes on. */
  readonly maxBytes?: number
}

/** A runtime's setup from its options. Throws a `RangeError` for invalid limits. */
export const makeSetup = <R>(options: Options<Globals>): Setup<R> => ({
  limits: {
    timeoutMs: validateLimit("timeoutMs", options.limits?.timeoutMs, 1),
    maxOutputBytes: validateLimit("maxOutputBytes", options.limits?.maxOutputBytes, 0),
    maxHeapBytes: validateLimit("maxHeapBytes", options.limits?.maxHeapBytes, 1),
  },
  globals: options.globals,
  modules: options.modules,
  typedArrays: options.typedArrays === true,
  translate: {
    functions: options.translate?.functions ?? "error",
    promises: options.translate?.promises ?? "error",
  },
})

const validateLimit = (name: string, value: number | undefined, minimum: number): number | undefined => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}
