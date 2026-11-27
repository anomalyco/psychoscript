export * as Host from "./host-function.js"

import type { Json } from "./data.js"
import { type Call as RunCall, DurableFn, Fn, Namespace, type Snapshot, type Type } from "./runtime/contract.js"
import { HostFailure } from "./runtime/model.js"

// Host functions a program calls as globals. Arguments cross into the host as copies (`Date`, `Map`, `Set`,
// `Uint8Array`, `URL`, `Headers`, errors, plain data), and results cross back the same way; a function inside a
// result is callable too. A host function returns a value or a Promise, or throws.

/** What every call of a host function gets. */
export type Call = Omit<RunCall, "context">

/** What every call of a durable function gets: also the arguments it was called with, as they crossed. */
export type DurableCall = Call & { readonly args: ReadonlyArray<unknown> }

export type { Snapshot, Type }
export { DurableFn, Fn, Namespace }

export type Options =
  | {
      readonly type?: "sync" | "sync-thenable"
      readonly idempotent?: false
      readonly snapshot?: Snapshot | undefined
      /**
       * Lets a program call the function with `new`, as it would a class. `new` calls it the same way a plain call
       * does, and the program gets what it returns.
       */
      readonly constructible?: boolean
      /**
       * Lets the function take functions in its arguments, on their own or inside other values. A function that was
       * inside a result arrives as the host function itself, and the run can't be suspended until the call completes.
       * A function the program wrote arrives as a `ProgramFunction`: its source text and the names from outside it
       * that it uses, plain data that a saved run keeps. A built-in or bound function or a class fails the call, and
       * any other host function is treated as `Runtime.Translate` says. Without it, every function is. A
       * `ProgramFunction` can't be called; calling it back during the call may come later, through `call`.
       */
      readonly takesFunctions?: boolean
    }
  | {
      readonly type: "async"
      /**
       * Safe to run twice: a suspend aborts a call in progress, and the resumed run calls it again with the same key.
       * Without it, a suspend fails while a call is in progress.
       */
      readonly idempotent?: boolean
      readonly snapshot?: Snapshot | undefined
      readonly constructible?: boolean
      readonly takesFunctions?: boolean
    }

export { HostFailure as Failure }

/** A host function: `f` gets the program's arguments, as they crossed, and the call, and returns a value or a Promise. */
export const fn = (f: (args: ReadonlyArray<any>, call: Call) => unknown, options: Options = {}): Fn =>
  new Fn(
    f,
    options.type ?? "sync",
    options.type === "async" && options.idempotent === true,
    options.snapshot,
    options.constructible === true,
    options.takesFunctions === true,
  )

/**
 * A host function whose work keeps running across a suspend. `start` begins it and gives JSON data, kept in a saved
 * run; `wait(data)` runs right after, and again after a resume, for the result. `cancel(data)` runs only when the run
 * is aborted, or ends with the work still running. The program always gets a promise.
 */
export const durableFn = <Data extends Json>(options: {
  readonly start: (args: ReadonlyArray<any>, call: Call) => Data | Promise<Data>
  readonly wait: (data: Data, call: DurableCall) => unknown
  readonly cancel: (data: Data, call: DurableCall) => void | Promise<void>
}): DurableFn =>
  new DurableFn(
    (args, call) => options.start(args, call),
    (data, call) => options.wait(data as Data, call),
    (data, call) => options.cancel(data as Data, call),
  )

/**
 * A lazy object of host functions, for catalogs too large to build as objects. `keys(path)` lists the names under a
 * path, for `Object.keys` and `for...in`; `resolve(path)` gives the function a call reaches, or a failure (see
 * `missing`) the call throws. Any path can be read, so `ns.a.b` is a path whether or not anything is there.
 */
export const namespace = (options: {
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>
  readonly resolve: (path: ReadonlyArray<string>) => Fn | DurableFn | HostFailure
}): Namespace => new Namespace(options.keys, options.resolve)

/** A failure with its own diagnostic `kind` and `suggestions`, to throw from a host function. */
export const fail = (kind: string, message: string, suggestions?: ReadonlyArray<string>): HostFailure =>
  new HostFailure(kind, message, suggestions)

/** What `resolve` gives for a path with no function: calling it throws this failure. */
export const missing = (message: string, suggestions?: ReadonlyArray<string>, kind = "ExecutionFailure"): HostFailure =>
  new HostFailure(kind, message, suggestions)
