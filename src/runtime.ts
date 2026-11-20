export * as Runtime from "./runtime.js"

import { Interrupted } from "./runtime/contract.js"
import type { Diagnostic } from "./runtime/model.js"
import {
  checkMaxBytes,
  Compiled,
  compileProgram,
  finishExecution,
  makeProgram,
  type Outcome,
  type Result,
  resumeProgram,
  type Run,
  startProgram,
  SuspendError,
  type Suspended,
} from "./runtime/execute.js"
import { type Globals, makeSetup, type Options, type ProgramOptions, type SuspendOptions } from "./runtime/options.js"

export { Compiled, SuspendError }
export type { Outcome, Result, Run, Suspended }
export type { Globals, Limits, Options, ProgramOptions, SuspendOptions, Translate } from "./runtime/options.js"

/** How one run is stopped: aborting `signal` makes it reject with an `AbortError`. */
export type RunOptions = {
  readonly signal?: AbortSignal | undefined
}

/** Options for `Runtime.execute`. */
export type ExecuteOptions = ProgramOptions & RunOptions

/** A reusable confined runtime over host globals. */
export type Runtime = {
  /**
   * Runs a program, from its source or compiled, to its end. Rejects with an `AbortError` when `options.signal`
   * aborts.
   */
  readonly execute: (code: string | Compiled, options?: ExecuteOptions) => Promise<Result>
  /** A program, from its source or compiled, ready to run once; nothing runs until `program.run()`. */
  readonly program: (code: string | Compiled, options?: ProgramOptions) => Program
  /**
   * Parses and compiles a program once, for `program` and `execute` to run many times without doing it again; or the
   * diagnostic a run of it would fail with first (an empty program, a syntax error).
   */
  readonly compile: (
    code: string,
  ) => { readonly ok: true; readonly compiled: Compiled } | { readonly ok: false; readonly error: Diagnostic }
  /**
   * A suspended run (its `state`, or that state as bytes) as a program to continue in this runtime, which must be the
   * same build with the same host globals. The state is checked when it runs: `run()` rejects with a `SnapshotError`
   * when it can't be resumed here.
   */
  readonly resume: (state: Suspended["state"] | Uint8Array) => Program
}

/**
 * One run of a program. Aborting `run`'s signal stops it and its host calls, and it rejects with an `AbortError`;
 * host work that ignores its call's signal is not waited for. A program runs once: running it again throws.
 */
export type Program = {
  /** Runs the program until it ends (a `Result`) or is suspended (a `Suspended` with its state). */
  readonly run: (options?: RunOptions) => Promise<Outcome>
  /**
   * Saves the run's state and stops it, at once: `run()` then resolves with the same `Suspended`, and so does this. It
   * rejects with a `SuspendError`, leaving the run running, while a host call that can't be suspended is in progress,
   * or when the state can't be saved or is over `options.maxBytes`. A run that already ended gives its result. Before
   * `run()` starts, this waits for it to start.
   */
  readonly suspend: (options?: SuspendOptions) => Promise<Outcome>
}

/**
 * Creates a runtime whose programs reach the host globals `options.globals` makes for each run. Throws a `RangeError`
 * for invalid limits.
 */
export const make = <const G extends Globals = {}>(options: Options<G> = {}): Runtime => {
  const setup = makeSetup<never>(options)
  const start = (code: string | Compiled, programOptions?: ProgramOptions) =>
    makeProgram(() => startProgram(setup, code, programOptions?.bindings, programOptions?.runId))
  return {
    execute: (code, executeOptions) =>
      aborting(finishExecution(start(code, executeOptions).run({ signal: executeOptions?.signal })), executeOptions?.signal),
    program: (code, programOptions) => wrap(start(code, programOptions)),
    compile: compileProgram,
    resume: (state) => wrap(makeProgram(() => resumeProgram(setup, state))),
  }
}

const wrap = (program: ReturnType<typeof makeProgram<never>>): Program => ({
  run: (runOptions) => aborting(program.run({ signal: runOptions?.signal }), runOptions?.signal),
  suspend: async (suspendOptions) => {
    checkMaxBytes(suspendOptions?.maxBytes)
    return program.suspend(suspendOptions?.maxBytes)
  },
})

// An aborted run rejects with a DOMException named "AbortError", as `fetch` does; its cause is the signal's reason.
const aborting = <A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> =>
  promise.catch((error: unknown) => {
    if (!(error instanceof Interrupted)) throw error
    const abort = new DOMException("The run was aborted.", "AbortError")
    if (signal?.reason !== undefined) Object.defineProperty(abort, "cause", { value: signal.reason, configurable: true })
    throw abort
  })
