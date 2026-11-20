import type { HostFailure } from "./model.js"

// The host-call contract the interpreter runs on. It knows nothing about Effect: a host function is called as
// `run(args, call)` and returns a value, a Promise, or `HostWork`, or throws. The Effect API (see `host-function.ts`)
// wraps its functions into this contract before the interpreter sees them.

/** What every call of a host function gets. */
export type Call = {
  /** The call's key, `<runId>:<callId>`: the same across a suspended run's resumes. */
  readonly key: string
  /** Whether the run is being suspended: an interruption now detaches the call instead of ending it. */
  readonly suspending: () => boolean
  /** Aborted when the call is stopped: the run ended, was interrupted, or is being suspended. */
  readonly signal: AbortSignal
  /** The run's opaque context, as given to `execute`, `run` or `resume`. */
  readonly context: unknown
}

/** What every call of a durable function gets: also the arguments it was called with, as they crossed. */
export type DurableCall = Call & { readonly args: ReadonlyArray<unknown> }

/**
 * Lets a saved run keep the functions inside values a host function returned: `encode` gets such a value and gives
 * plain data (JSON values and `Uint8Array`s); `decode` gets that data back on resume and gives a value of the same
 * shape, whose functions the program's copies call from then on. Without it, those functions are lost on resume.
 */
export type Snapshot = {
  readonly encode: (value: unknown) => unknown
  readonly decode: (data: unknown) => unknown
}

/**
 * How a call reaches the program:
 * - `sync`: the program waits for the function; a returned Promise reaches the program as a promise.
 * - `async`: the program gets a promise at once, and the function runs once the program's current step ends.
 * - `sync-thenable`: as `sync`, and an object result also has hidden `then`, `catch` and `finally`, so the program can
 *   use it directly or await it.
 */
export type Type = "sync" | "async" | "sync-thenable"

/** How host work ended. */
export type Settled = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }

/**
 * Host work that starts only when the driver runs it, and that the run waits for when it stops it: `start` begins it
 * with the run's context, calls `done` once (possibly at once) when it ends, and may return a function that asks it to
 * stop. A blocking call that returns it makes the program wait for it.
 */
export class HostWork {
  constructor(readonly start: (context: unknown, done: (settled: Settled) => void) => (() => void) | void) {}
}

/** A host failure that is a defect, not a failure the host meant: it gets the call's source location. */
export class HostDefect {
  constructor(readonly error: unknown) {}
}

/** Host work, or a run, that was interrupted. */
export class Interrupted extends Error {
  override readonly name = "Interrupted"
  constructor() {
    super("Interrupted")
  }
}

/** A host function; see `Host.fn`. */
export class Fn<R = never> {
  declare readonly requirements?: (_: never) => R
  constructor(
    readonly run: (args: ReadonlyArray<unknown>, call: Call) => unknown,
    readonly type: Type,
    readonly idempotent: boolean,
    readonly snapshot: Snapshot | undefined,
    readonly constructible = false,
    readonly takesFunctions = false,
  ) {}
}

/** A host function whose work keeps running across a suspend; see `Host.durableFn`. Each part returns as `Fn.run`. */
export class DurableFn<R = never> {
  declare readonly requirements?: (_: never) => R
  constructor(
    readonly start: (args: ReadonlyArray<unknown>, call: Call) => unknown,
    readonly wait: (data: unknown, call: DurableCall) => unknown,
    readonly cancel: (data: unknown, call: DurableCall) => unknown,
  ) {}
}

/** A lazy object of host functions, addressed by path; see `Host.namespace`. */
export class Namespace<R = never> {
  declare readonly requirements?: (_: never) => R
  constructor(
    readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>,
    readonly resolve: (path: ReadonlyArray<string>) => Fn<R> | DurableFn<R> | HostFailure,
  ) {}
}
