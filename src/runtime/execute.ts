import type { Program } from "acorn"
import { fromJson, type Json } from "../data.js"
import { type Call, DurableFn, Interrupted } from "./contract.js"
import { fromBytes, header, type Snapshot, SnapshotError, toBytes } from "../snapshot/snapshot.js"
import { normalizeError } from "./errors.js"
import { hostGlobals } from "./extensions.js"
import { createBuiltins } from "./intrinsics.js"
import { Interpreter } from "./interpreter.js"
import type { Value } from "./objects.js"
import { type Diagnostic, formatLocation, sourceLocation } from "./model.js"
import { CANCELLED, Driver, SUSPENDED } from "./driver.js"
import { BIGINT_LITERAL_TOO_LARGE, parseScript } from "./parser.js"
import { Interruption } from "./signals.js"
import { Source } from "./source.js"
import { compileCodes, type Vm } from "../vm.js"
import type { Code } from "../code.js"
import type { Translate } from "../runtime.js"

/**
 * A suspend that failed, leaving the run running: `running` names each host call that blocked it by its key and its
 * path (for example `sleep` or `store.get`). Empty when the state couldn't be saved or was too large.
 */
export class SuspendError extends Error {
  readonly _tag = "SuspendError"
  override readonly name = "SuspendError"
  readonly running: ReadonlyArray<{ readonly key: string; readonly path: string }>
  constructor(props: { readonly message: string; readonly running: ReadonlyArray<{ readonly key: string; readonly path: string }> }) {
    super(props.message)
    this.running = props.running
  }
}

/** How one run is started: `signal` interrupts it (it then rejects with `Interrupted`); `context` goes to host calls. */
export type RunOptions = {
  readonly signal?: AbortSignal | undefined
  readonly context?: unknown
}

/**
 * A program's one run: `start` makes it when `run()` is called, and a suspend waits for it. Running it twice rejects.
 * `suspend` throws a `RangeError` at once for an invalid `maxBytes`.
 */
export const makeProgram = <R>(start: () => Running<R>) => {
  let claimed = false
  const started = Promise.withResolvers<Running<R>>()
  started.promise.catch(() => {})
  return {
    run: async (options?: RunOptions): Promise<Outcome> => {
      if (claimed) throw new Error("A program runs once; make another with runtime.program or runtime.resume.")
      claimed = true
      const running = attempt(start)
      if (!running.ok) {
        started.reject(new SuspendError({ message: "The program didn't start.", running: [] }))
        throw running.error
      }
      started.resolve(running.value)
      return running.value.run(options)
    },
    suspend: (maxBytes?: number): Promise<Outcome> => {
      checkMaxBytes(maxBytes)
      return started.promise.then((running) => running.suspend(maxBytes))
    },
  }
}

export const checkMaxBytes = (maxBytes: number | undefined): void => {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError("maxBytes must be a safe integer greater than or equal to 0.")
  }
}

/** A run that ended: its value, or the diagnostic it failed with, plus its logs and its `run.metadata` at the end. */
export type Result =
  | {
      readonly ok: true
      readonly value: Json
      readonly warnings?: ReadonlyArray<Diagnostic>
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly metadata: Json
    }
  | {
      readonly ok: false
      readonly error: Diagnostic
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly metadata: Json
    }

/** A run stopped by `program.suspend`: its whole state, to resume with `Runtime.resume`. */
export type Suspended = {
  readonly ok: "suspended"
  readonly state: Snapshot
}

/** How a run of a program ended: its result, or its saved state once suspended. */
export type Outcome = Result | Suspended

/**
 * One run of a program, as its host globals see it. `metadata` is the host's own state for the run, as JSON: saved
 * with a suspended run and given back on resume, and in the run's result.
 */
export type Run = {
  readonly id: string
  metadata: Json
}

/** The budgets every run of a runtime gets. Time counts active time only, across every resume of a run. */
export type Limits = {
  readonly timeoutMs: number | undefined
  readonly maxOutputBytes: number | undefined
}

type Globals<R> = (ctx: Interpreter<R>) => ReadonlyArray<readonly [string, Value]>

/** How a runtime runs programs: its limits and host globals, shared by every run it starts. */
export type Setup<R> = {
  readonly limits: Limits
  readonly translate?: Required<Translate> | undefined
  /** Turns what a plain host function (one inside a result, or among the globals) returned into a value, a Promise or `HostWork`. */
  readonly adapt?: ((value: unknown, call: Call) => unknown) | undefined
  /** Each run's host globals (see `Host`): made when it starts, and again for a restored run. */
  readonly globals?: ((run: Run) => Readonly<Record<string, unknown>>) | undefined
  /** Module names that load a global, beyond its own name; see `Runtime.Options`. */
  readonly modules?: Readonly<Record<string, string>> | undefined
  /** Globals made as program values (a test harness), made again the same way for a restored run. */
  readonly programGlobals?: Globals<R> | undefined
}

/** Turns a suspended outcome into a failure, for callers that only run programs to their end. */
export const finishExecution = async (outcome: Promise<Outcome>): Promise<Result> => {
  const ended = await outcome
  if (ended.ok !== "suspended") return ended
  return {
    ok: false,
    error: { kind: "ExecutionFailure", message: "The program suspended, which isn't supported here." },
    metadata: ended.state.header.metadata,
  }
}

/**
 * A program compiled once to run many times, in any runtime: its parse and its bytecode, which no run changes. A run
 * of it is the same as a run of its source, and so is a state saved from one.
 */
export class Compiled {
  /** @internal */
  constructor(
    /** The program's source. */
    readonly code: string,
    /** @internal */
    readonly source: Source,
    /** @internal */
    readonly codes: ReadonlyArray<Code> | RangeError,
  ) {}
}

/**
 * Parses and compiles a program, or gives the diagnostic its run would fail with before running anything: an empty
 * program or a syntax error. Unsupported syntax still fails where it runs, as from source.
 */
export const compileProgram = (
  code: string,
): { readonly ok: true; readonly compiled: Compiled } | { readonly ok: false; readonly error: Diagnostic } => {
  if (code.trim().length === 0) return { ok: false, error: { kind: "ParseError", message: "Code cannot be empty." } }
  const parsed = parseProgram(code)
  if (!parsed.ok) return parsed
  return { ok: true, compiled: new Compiled(code, parsed.source, compileCodes(parsed.source)) }
}

/** A program ready to run on the VM: nothing runs until `run`. */
export const startProgram = <R>(
  setup: Setup<R>,
  code: string | Compiled,
  bindings?: Readonly<Record<string, Json>>,
  runId: string = crypto.randomUUID(),
): Running<R> =>
  new Running(setup, 0, () => {
    const compiled = typeof code === "string" ? compileProgram(code) : { ok: true as const, compiled: code }
    if (!compiled.ok) return { ok: false, error: compiled.error, metadata: null }
    const run: Run = { id: runId, metadata: null }
    const runtime = instantiate(setup, run, bindings)
    runtime.vm.hosts.runId = runId
    runtime.vm.start(compiled.compiled.source, compiled.compiled.codes)
    return [runtime, run] as const
  })

/**
 * Restores a saved run into this runtime, under the limits it was saved with, ready to run as `startProgram`'s.
 * Fails with a `SnapshotError` when the state can't be read or belongs to another build, other host globals, or other
 * sources, or when a durable call it waits on has no durable function at its path any more.
 */
export const resumeProgram = <R>(
  setup: Setup<R>,
  saved: Snapshot | Uint8Array | unknown,
): Running<R> => {
  try {
      const state = saved instanceof Uint8Array ? fromBytes(saved) : saved
      const saw = header(state)
      const resumed: Setup<R> = {
        ...setup,
        limits: {
          timeoutMs: saw.limits.timeoutMs ?? undefined,
          maxOutputBytes: saw.limits.maxOutputBytes ?? undefined,
        },
      }
      const run: Run = { id: saw.runId, metadata: saw.metadata }
      const fresh = instantiate(resumed, run)
      const snapshot = restoreInto(state, fresh.vm)
      for (const call of fresh.vm.calls()) {
        if (call.status !== "started") continue
        if (call.path === undefined || !(fresh.hosts?.resolve(call.path) instanceof DurableFn)) {
          throw new SnapshotError(
            `The pending durable call ${call.key} (${call.label}) cannot resume because that function is no longer a durable function in this runtime.`,
          )
        }
      }
      return new Running(resumed, snapshot.header.budget.activeMs, () => [fresh, run] as const, true)
  } catch (error) {
    throw error instanceof SnapshotError ? error : new SnapshotError(String(error))
  }
}

// Sources restored recently, by text: the AST is never changed, so runs restored from the same program share it.
const restoredSources = new Map<string, Source>()

const restoreInto = (saved: unknown, vm: Vm): Snapshot =>
  vm.restore(saved, {
    parse: (code) => {
      const known = restoredSources.get(code)
      if (known !== undefined) return known
      const parsed = parseProgram(code)
      if (!parsed.ok) throw new SnapshotError(`A saved source no longer parses: ${parsed.error.message}`)
      if (restoredSources.size >= 16) restoredSources.delete(restoredSources.keys().next().value!)
      restoredSources.set(code, parsed.source)
      return parsed.source
    },
    interruption: () => new Interruption(),
  })

// A new runtime for a run: intrinsics, the host globals, the program's bindings, and its VM.
const instantiate = <R>(setup: Setup<R>, run: Run, bindings?: Readonly<Record<string, Json>>): Interpreter<R> => {
  const ctx = new Interpreter<R>({
    builtins: createBuiltins(),
    logs: [],
    modules: setup.modules,
    globals: (ctx) => [
      ...(setup.programGlobals?.(ctx) ?? []),
      ...(setup.globals === undefined ? [] : hostGlobals(ctx, setup.globals(run), setup.translate, setup.adapt)),
    ],
    bindings:
      bindings === undefined
        ? undefined
        : (ctx) => Object.entries(bindings).map(([name, value]) => [name, fromJson(ctx, value)] as const),
  })
  if (roundTrip) ctx.vm.tripEvery = ROUND_TRIP_TICKS
  return ctx
}

/**
 * The round-trip test mode: at every host stop and every slice, which come every few loop back-edges and calls, a run's
 * state is saved to bytes and restored into a brand-new runtime, which continues the run. It proves the VM's state is
 * plain data at every step. Internal: only the test suite turns it on (`bun run test:roundtrip`).
 */
let roundTrip = false
export const setRoundTrip = (enabled: boolean) => {
  roundTrip = enabled
}
const ROUND_TRIP_TICKS = 2
const ROUND_TRIP_MAX = 200

/** One run's state: the runtime it is in now (restoring swaps it), its driver, and how much active time it used. */
export class Running<R> {
  private ctx!: Interpreter<R>
  private run_!: Run
  private driver!: Driver
  private startedAt = 0
  // Set once the program's body ends, and once a suspend saved the run: either way, `done` gets the outcome next.
  private finished = false
  private suspended: Suspended | undefined
  private trips = 0
  // Checkpoints to let pass before the next round trip, so a large state is not saved at every one.
  private skip = 0
  private readonly started = Promise.withResolvers<void>()
  private readonly done = Promise.withResolvers<Outcome>()

  constructor(
    private readonly setup: Setup<R>,
    /** Active milliseconds used before this run, by earlier ones of the same execution. */
    private readonly activeBefore: number,
    private readonly prepare: () => readonly [Interpreter<R>, Run] | Result,
    private readonly resuming = false,
  ) {}

  /** Makes the run's runtime and driver, then runs the program until it ends or is suspended. */
  async run(options?: RunOptions): Promise<Outcome> {
    this.done.promise.catch(() => {})
    try {
      const outcome = await this.begin(options)
      this.done.resolve(outcome)
      return outcome
    } catch (error) {
      this.done.reject(error)
      throw error
    } finally {
      this.started.resolve()
    }
  }

  private begin(options: RunOptions | undefined): Promise<Outcome> {
    const prepared = this.prepare()
    if (!Array.isArray(prepared)) {
      this.finished = true
      return Promise.resolve(prepared as Result)
    }
    const [ctx, run] = prepared as readonly [Interpreter<R>, Run]
    this.ctx = ctx
    this.run_ = run
    this.driver = new Driver(ctx.vm, options?.context)
    if (roundTrip) this.driver.checkpoint = () => this.trip()
    this.startedAt = Date.now()
    return this.execute(options?.signal)
  }

  /**
   * Saves the run's state and stops it, at once: `run` then returns the same `Suspended`. It rejects with a
   * `SuspendError`, leaving the run running, while a host call is in progress. A run that already ended gives its result.
   * Before the run has started, it waits for it.
   */
  async suspend(maxBytes: number | undefined): Promise<Outcome> {
    await this.started.promise
    if (this.finished) return this.done.promise
    const saved = this.save(maxBytes)
    if (saved instanceof SuspendError) throw saved
    this.stop(saved)
    return this.done.promise
  }

  private async execute(signal: AbortSignal | undefined): Promise<Outcome> {
    const limits = this.setup.limits
    const logged = () => {
      const logs = this.ctx.logs
      return logs.length > 0 ? { logs: [...logs] } : {}
    }
    const metadata = () => this.run_.metadata
    const failed = (error: Diagnostic): Result => ({ ok: false, error, ...logged(), metadata: metadata() })
    // Set only after copy-out so timeouts cannot report invalid values as completed.
    let returned: { value: Json; warnings: () => Array<Diagnostic> } | undefined
    const driver = this.driver

    const base = async (): Promise<Outcome | typeof CANCELLED> => {
      try {
        if (this.resuming) driver.resume()
        this.started.resolve()
        const outcome = await driver.run()
        if (outcome === CANCELLED) return CANCELLED
        if (outcome === SUSPENDED) return this.suspended!
        this.finished = true
        if (!outcome.ok) return failed(normalizeError(outcome.error))
        const result = (outcome.value as Json | undefined) ?? null
        const vm = this.ctx.vm
        returned = { value: result, warnings: () => vm.diagnostics() }
        // Host work the program left running is interrupted, not awaited.
        await driver.interrupt()
        const warnings = vm.diagnostics()
        return {
          ok: true,
          value: result,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...logged(),
          metadata: metadata(),
        } satisfies Result
      } finally {
        await driver.interrupt()
      }
    }
    const timedOut = (timeoutMs: number): Outcome => {
      this.finished = true
      if (this.suspended !== undefined) return this.suspended
      if (returned === undefined) {
        return failed({ kind: "TimeoutExceeded", message: `Execution timed out after ${timeoutMs}ms.` })
      }
      // Keep the timeout warning first so truncation preserves it.
      return {
        ok: true,
        value: returned.value,
        warnings: [
          {
            kind: "TimeoutExceeded",
            message: `The program returned, but background work was still running at the ${timeoutMs}ms timeout and was interrupted. Await all started promises.`,
          },
          ...returned.warnings(),
        ],
        ...logged(),
        metadata: metadata(),
      } satisfies Result
    }

    const timeoutMs = limits.timeoutMs
    const stopped = Promise.withResolvers<"timeout" | "interrupt">()
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => stopped.resolve("timeout"), Math.max(0, timeoutMs - this.activeBefore))
    const onAbort = () => stopped.resolve("interrupt")
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    const running = base().then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    )
    const first = await Promise.race([running, stopped.promise]).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    })
    if (typeof first === "string") {
      driver.cancel()
      const late = first === "timeout" ? timedOut(timeoutMs!) : undefined
      await running
      if (late === undefined) throw new Interrupted()
      return this.bound(late)
    }
    if ("error" in first) {
      if (first.error instanceof Interrupted) throw first.error
      return this.bound(failed(normalizeError(first.error)))
    }
    // Only a cancelled run gives CANCELLED, and that is the other branch.
    return this.bound(first.outcome as Outcome)
  }

  private bound(result: Outcome): Outcome {
    const maxOutputBytes = this.setup.limits.maxOutputBytes
    return result.ok === "suspended" || maxOutputBytes === undefined ? result : boundOutput(result, maxOutputBytes)
  }

  // Suspends the run once its state is saved: the driver stops.
  private stop(saved: Suspended): void {
    this.finished = true
    this.suspended = saved
    this.driver.detach()
  }

  /**
   * Saves the run's state, with no effect on the run: the calls that block a suspend, or the state as it is now. The
   * program shares this thread with the caller, so it is at a step boundary.
   */
  private save(maxBytes: number | undefined): Suspended | SuspendError {
    const vm = this.ctx.vm
    const running = this.driver.blocking()
    if (running.length > 0) {
      return new SuspendError({
        message: `The run can't be suspended while ${running.map((call) => call.path).join(", ")} ${running.length === 1 ? "is" : "are"} running.`,
        running,
      })
    }
    // Idempotent calls in flight are saved as queued so they run again on resume under the same key.
    const idempotent = vm.calls().filter((call) => call.status === "running")
    for (const call of idempotent) call.status = "queued"
    const restoreRunning = () => {
      for (const call of idempotent) call.status = "running"
    }
    const limits = this.setup.limits
    const saved = attempt(() =>
      vm.capture({
        limits: { timeoutMs: limits.timeoutMs ?? null, maxOutputBytes: limits.maxOutputBytes ?? null },
        activeMs: this.activeBefore + Date.now() - this.startedAt,
        metadata: this.run_.metadata,
        strict: false,
      }),
    )
    if (!saved.ok) {
      restoreRunning()
      const error = saved.error
      return new SuspendError({
        message: `The run's state couldn't be saved: ${error instanceof Error ? error.message : String(error)}`,
        running: [],
      })
    }
    const snapshot = saved.value.snapshot
    if (maxBytes !== undefined) {
      const size = toBytes(snapshot).byteLength
      if (size > maxBytes) {
        restoreRunning()
        return new SuspendError({
          message: `The run's state takes ${size} bytes, more than the ${maxBytes}-byte limit, so it couldn't be suspended.`,
          running: [],
        })
      }
    }
    return { ok: "suspended", state: snapshot }
  }

  // The round-trip test mode's checkpoint: saves the state to bytes and continues in a brand-new runtime, made with
  // the run's metadata as it would be on resume. States that hold live host values (a call waiting on what its host
  // function returned, a function a host function without `snapshot` hooks returned) can't round-trip, so they are
  // skipped; a value with no data form anywhere else is a codec gap and fails the run.
  private trip(): void {
    const driver = this.driver
    if (this.trips >= ROUND_TRIP_MAX) {
      this.ctx.vm.tripEvery = 0
      return
    }
    if (this.skip > 0) {
      this.skip--
      return
    }
    if (driver.holdsHostValues) return
    this.trips++
    const attempted = attempt(() => this.ctx.vm.capture({ metadata: this.run_.metadata, strict: true }))
    // A host function's `snapshot` hooks may refuse to save a value, which fails a suspend, not the run.
    if (!attempted.ok) {
      const error = attempted.error
      if (error instanceof SnapshotError && error.message.startsWith("The host function ")) return
      throw error
    }
    const saved = attempted.value
    const bytes = toBytes(saved.snapshot)
    this.skip = Math.floor(saved.snapshot.records.length / 200 + bytes.byteLength / 100_000)
    if (saved.lost.length > 0) return
    const restored = fromBytes(bytes)
    const run = { id: this.run_.id, metadata: header(restored).metadata }
    const fresh = instantiate(this.setup, run)
    restoreInto(restored, fresh.vm)
    this.ctx = fresh
    this.run_ = run
    driver.vm = fresh.vm
  }
}

const attempt = <A>(run: () => A): { ok: true; value: A } | { ok: false; error: unknown } => {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return { ok: false, error }
  }
}

export const parseProgram = (
  code: string,
): { ok: true; program: Program; source: Source } | { ok: false; error: Diagnostic } => {
  try {
    const program = parseScript(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      // Imports bind globals by module name; scripts keep sloppy-mode semantics, which module source would make strict.
      allowImportExportEverywhere: true,
      locations: true,
    })
    const exported = program.body.find((statement) => statement.type.startsWith("Export"))
    if (exported) {
      const location = sourceLocation(exported)
      return {
        ok: false,
        error: {
          kind: "ParseError",
          message: `SyntaxError: Exports aren't available. Return the result instead.${formatLocation(location)}`,
          location,
        },
      }
    }
    return { ok: true, program, source: new Source("main", code, program) }
  } catch (error) {
    // Only acorn's own syntax errors become a located ParseError; anything else keeps the generic failure path.
    if (!(error instanceof SyntaxError) || !isAcornError(error)) throw error
    return { ok: false, error: parseDiagnostic(error) }
  }
}

// Acorn appends ` (line:column)` to its messages; its lines are 1-based and its columns 0-based.
type AcornError = { readonly message: string; readonly loc: { readonly line: number; readonly column: number } }

const isAcornError = (error: SyntaxError): error is SyntaxError & AcornError => {
  const loc: unknown = (error as { loc?: unknown }).loc
  return (
    typeof loc === "object" &&
    loc !== null &&
    typeof (loc as { line?: unknown }).line === "number" &&
    typeof (loc as { column?: unknown }).column === "number"
  )
}

const parseDiagnostic = (error: AcornError): Diagnostic => {
  const location = { line: error.loc.line, column: error.loc.column + 1 }
  const reason = error.message.replace(/ \(\d+:\d+\)$/, "")
  if (reason === BIGINT_LITERAL_TOO_LARGE) {
    return { kind: "ParseError", message: `RangeError: ${reason}${formatLocation(location)}`, location }
  }
  const feature = reason === "Unexpected character '@'"
    ? "Decorators are not supported."
    : /^Private field '#/.test(reason)
      ? "Private class members (#name) are not supported. Use a regular property instead."
      : undefined
  const text = feature ?? `${reason.endsWith(".") ? reason : `${reason}.`} Code must be plain JavaScript written as a program body.`
  return { kind: "ParseError", message: `SyntaxError: ${text}${formatLocation(location)}`, location }
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

// Drop a replacement character produced by truncating inside a UTF-8 sequence.
const utf8Truncate = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  const text = new TextDecoder("utf-8").decode(bytes.slice(0, Math.max(0, maxBytes)))
  return text.endsWith("\uFFFD") ? text.slice(0, -1) : text
}

// The longest prefix of `items` whose sizes add up to at most `budget` bytes.
const fitting = <T>(items: ReadonlyArray<T>, budget: number, size: (item: T) => number): Array<T> => {
  const kept: Array<T> = []
  let used = 0
  for (const item of items) {
    used += size(item)
    if (used > budget) break
    kept.push(item)
  }
  return kept
}

// Warnings have a separate budget so result data cannot starve diagnostics.
const boundOutput = (result: Result, maxOutputBytes: number): Result => {
  const serialized = result.ok ? (JSON.stringify(result.value) ?? "null") : ""
  const valueBytes = result.ok ? utf8ByteLength(serialized) : 0
  const valueTruncated = valueBytes > maxOutputBytes
  const value: Json = !result.ok
    ? null
    : valueTruncated
      ? `${utf8Truncate(serialized, maxOutputBytes)} [result truncated: ${valueBytes} bytes exceeds the ${maxOutputBytes}-byte output limit; return a smaller value]`
      : result.value

  const warnings = result.ok ? (result.warnings ?? []) : []
  const keptWarnings = fitting(warnings, maxOutputBytes, (warning) => utf8ByteLength(JSON.stringify(warning)) + 1)
  const warningsCut = keptWarnings.length < warnings.length
  if (warningsCut) {
    keptWarnings.push({
      kind: "Truncated",
      message: `${warnings.length - keptWarnings.length} additional warnings omitted by the output limit.`,
    })
  }

  const logs = result.logs ?? []
  const logBudget = Math.max(0, maxOutputBytes - Math.min(valueBytes, maxOutputBytes))
  const kept = fitting(logs, logBudget, (line) => utf8ByteLength(line) + 1)
  const logsCut = kept.length < logs.length
  if (logsCut) kept.push(`[logs truncated: showing ${kept.length} of ${logs.length} lines]`)

  if (!valueTruncated && !warningsCut && !logsCut) return result
  const warningsPart = keptWarnings.length > 0 ? { warnings: keptWarnings } : {}
  const logsPart = kept.length > 0 ? { logs: kept } : {}
  return result.ok
    ? { ok: true, value, ...warningsPart, ...logsPart, truncated: true, metadata: result.metadata }
    : { ok: false, error: result.error, ...logsPart, truncated: true, metadata: result.metadata }
}
