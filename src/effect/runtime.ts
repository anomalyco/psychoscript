export * as Runtime from "./runtime.js"

import { type Context, Effect } from "effect"
import { type DurableFn, type Fn, Interrupted, type Namespace } from "../runtime/contract.js"
import {
  checkMaxBytes,
  finishExecution,
  makeProgram,
  type Outcome,
  type Result,
  resumeProgram,
  type Run,
  startProgram,
  SuspendError,
  type Suspended,
} from "../runtime/execute.js"
import { type Globals, makeSetup, type Options, type ProgramOptions, type SuspendOptions } from "../runtime/options.js"
import { SnapshotError } from "../snapshot/snapshot.js"

export { SuspendError }
export type { Outcome, Result, Run, Suspended }
export type { Globals, Limits, Options, ProgramOptions, SuspendOptions, Translate } from "../runtime/options.js"

/** A reusable confined runtime over host globals. */
export type Runtime<R = never> = {
  /** Runs a program to its end. */
  readonly execute: (code: string, options?: ProgramOptions) => Effect.Effect<Result, never, R>
  /** A program ready to run once; nothing runs until `program.run()`. */
  readonly program: (code: string, options?: ProgramOptions) => Program<R>
  /**
   * A suspended run (its `state`, or that state as bytes) as a program to continue in this runtime, which must be the
   * same build with the same host globals. The state is checked when it runs: `run()` fails with a `SnapshotError`
   * when it can't be resumed here.
   */
  readonly resume: (state: Suspended["state"] | Uint8Array) => Program<R, SnapshotError>
}

/**
 * One run of a program. `run()` runs it in the current fiber until it ends or is suspended, and owns its host calls:
 * interrupting `run()` interrupts them. A program runs once: running it again is a defect.
 */
export type Program<R = never, E = never> = {
  /** Runs the program until it ends (a `Result`) or is suspended (a `Suspended` with its state). */
  readonly run: () => Effect.Effect<Outcome, E, R>
  /**
   * Saves the run's state and stops it, at once, from another fiber: `run()` then returns the same `Suspended`, and so
   * does this. It fails with a `SuspendError`, leaving the run running, while a host call that can't be suspended is
   * in progress, or when the state can't be saved or is over `options.maxBytes`. A run that already ended gives its
   * result. Before `run()` starts, this waits for it to start.
   */
  readonly suspend: (options?: SuspendOptions) => Effect.Effect<Outcome, SuspendError>
}

/** The Effect environment the host functions among `G` need, at any depth. */
export type Services<G> = ServicesOf<G, []>

type ServicesOf<T, Depth extends ReadonlyArray<unknown>> = Depth["length"] extends 8
  ? never
  : T extends Fn<infer R> | DurableFn<infer R> | Namespace<infer R>
    ? R
    : T extends object
      ? ServicesOf<T[keyof T], [...Depth, unknown]>
      : never

/**
 * Creates a runtime whose programs reach the host globals `options.globals` makes for each run. Throws a `RangeError`
 * for invalid limits.
 */
export const make = <const G extends Globals = {}>(options: Options<G> = {}): Runtime<Services<G>> => {
  type R = Services<G>
  const setup = makeSetup<R>(options)
  const program = (code: string, programOptions?: ProgramOptions): Program<R> =>
    wrap(makeProgram(() => startProgram(setup, code, programOptions?.bindings, programOptions?.runId)))
  return {
    execute: (code, programOptions) =>
      Effect.flatMap(Effect.context<R>(), (services) =>
        fromPromise((signal) =>
          finishExecution(
            makeProgram(() => startProgram(setup, code, programOptions?.bindings, programOptions?.runId)).run({
              signal,
              context: services,
            }),
          ),
        ),
      ) as Effect.Effect<Result, never, R>,
    program,
    resume: (state) => wrap(makeProgram(() => resumeProgram(setup, state))) as Program<R, SnapshotError>,
  }
}

// The Effect API over a program's Promise one: `run` gives host calls the caller's services, and interrupting it
// aborts the run.
const wrap = <R>(program: ReturnType<typeof makeProgram<R>>): Program<R, never> => ({
  run: () =>
    Effect.flatMap(Effect.context<R>(), (services: Context.Context<R>) =>
      fromPromise((signal) => program.run({ signal, context: services })),
    ),
  suspend: (options) => {
    const maxBytes = options?.maxBytes
    checkMaxBytes(maxBytes)
    return fromPromise(() => program.suspend(maxBytes)) as Effect.Effect<Outcome, SuspendError>
  },
})

// A Promise as an Effect: `Interrupted` interrupts, a `SuspendError` or `SnapshotError` fails, and anything else is a
// defect. Interrupting the Effect aborts the signal and waits for the Promise to settle.
const fromPromise = <A>(start: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> =>
  Effect.callback<A>((resume) => {
    const controller = new AbortController()
    const settled = start(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) =>
        resume(
          error instanceof Interrupted
            ? Effect.interrupt
            : error instanceof SuspendError || error instanceof SnapshotError
              ? (Effect.fail(error) as unknown as Effect.Effect<A>)
              : Effect.die(error),
        ),
    )
    return Effect.promise(() => {
      controller.abort()
      return settled
    })
  })
