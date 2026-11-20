import type { Json } from "../data.js"
import { DurableFn, type Fn, HostDefect, HostWork, Interrupted, type Settled } from "./contract.js"
import type { HostCall } from "../scheduler.js"
import { locate } from "./errors.js"
import { HostFailure, PendingThrow } from "./model.js"
import type { Vm } from "../vm.js"
import { abrupt, type Completion, Interruption, normal } from "./signals.js"

/** What `Driver.run` returns once the run was suspended: its state is saved, and the VM stopped. */
export const SUSPENDED: unique symbol = Symbol("psychoscript.suspended")

/** What `Driver.run` returns once `cancel` stopped it (a timeout, or the caller interrupting the run). */
export const CANCELLED: unique symbol = Symbol("psychoscript.cancelled")

/** For tests: `onPark` is called each time a run has nothing to do but wait on host calls in flight. */
export const parking: { onPark?: () => void } = {}

/**
 * Runs the VM (see `Vm`): the only place program execution meets the host. It calls `vm.run` until the program ends,
 * and does what each stop asks: yields to the event loop for a slice, and starts the host calls the VM queued,
 * reporting each outcome back with `vm.complete`. Calls in flight live only here, by host call id, and never become
 * part of the VM's state.
 *
 * A durable call runs as two parts, `start` then `wait`, so suspending can detach the second and keep the JSON data
 * `start` gave. An idempotent call in flight is detached and aborted on suspend, and the call is saved as queued to run
 * again on resume. The VM can be swapped for a restored one between stops (the round-trip test mode does); an outcome
 * goes to whichever VM is current, by host call id.
 */
export class Driver {
  private readonly pending = new Map<number, Pending>()
  // Calls stopped to suspend or end the run: their outcomes are not reported.
  private readonly detached = new Set<number>()
  private wake: (() => void) | undefined
  private stopping = false
  private stopped: Promise<void> | undefined
  private suspending = false
  private cancelled = false
  // Blocking host work interrupted on its own, which interrupts the execution.
  private interrupted = false
  /** Called at every slice and host stop, before queued calls start: the round-trip test mode swaps the VM. */
  checkpoint: (() => void) | undefined

  constructor(
    public vm: Vm,
    /** The run's opaque context, given to every host call. */
    private readonly context: unknown,
  ) {}

  /**
   * Runs the VM until the program's body completes, then returns how it ended, `SUSPENDED` once the run was suspended
   * (see `detach`), or `CANCELLED` once cancelled. Host work it started may still be running; `interrupt` stops it.
   * Host work interrupted on its own that reaches the program's body, or blocking host work that is interrupted,
   * rejects with `Interrupted`.
   */
  async run(): Promise<Completion | typeof SUSPENDED | typeof CANCELLED> {
    while (true) {
      if (this.interrupted) throw new Interrupted()
      if (this.suspending) return SUSPENDED
      if (this.cancelled) return CANCELLED
      const stop = this.vm.run()
      if (stop.kind === "slice") {
        this.checkpoint?.()
        await new Promise<void>((resolve) => setImmediate(resolve))
        continue
      }
      if (stop.kind === "host") {
        if (stop.calls.length === 0) {
          parking.onPark?.()
          await this.settled()
          continue
        }
        this.checkpoint?.()
        // Suspended now: the calls stay queued, and start on resume.
        if (this.suspending) continue
        for (const handed of stop.calls) this.launch(this.vm.call(handed.id) ?? handed)
        continue
      }
      if (stop.kind === "stuck") {
        return abrupt(
          new PendingThrow(
            "Error",
            "The program is waiting on a promise that can never settle: nothing else is running, so nothing can resolve it. There are no timers or sleep, so don't wait or poll inside a program.",
            stop.node,
          ),
        )
      }
      const outcome = stop.completion
      if (!outcome.ok && outcome.error instanceof Interruption) throw new Interrupted()
      return outcome
    }
  }

  /**
   * The host calls that block a suspend now: every call in progress except an idempotent call, or a durable call in
   * `started`. A call queued but not started starts on resume, unless its arguments hold host functions, which
   * can't be saved.
   */
  blocking(): Array<{ readonly key: string; readonly path: string }> {
    return this.vm
      .calls()
      .filter(
        (call) =>
          call.holdsFunctions ||
          (call.status !== "queued" && call.status !== "started" && call.policy !== "idempotent"),
      )
      .map((call) => ({ key: call.key, path: call.label }))
  }

  /**
   * Whether the run holds live host values: a call whose function can't be found again, that waits on its result, or
   * whose arguments hold host functions.
   */
  get holdsHostValues(): boolean {
    return this.vm.calls().some((call) => call.work !== undefined || call.path === undefined || call.holdsFunctions)
  }

  /**
   * Stops the run to suspend it, once its state is saved: `run` returns `SUSPENDED` at its next step, and calls in
   * flight are detached, so ending them reports nothing.
   */
  detach(): void {
    this.suspending = true
    for (const id of this.pending.keys()) this.detached.add(id)
    this.wake?.()
  }

  /** Stops the run: `run` returns `CANCELLED` at its next step. */
  cancel(): void {
    this.cancelled = true
    this.wake?.()
  }

  /**
   * Stops host work still running, aborting each call and waiting for host work that can be waited on; a durable
   * call's work is cancelled unless the run was suspended.
   */
  interrupt(): Promise<void> {
    this.stopping = true
    return (this.stopped ??= this.stop())
  }

  private async stop(): Promise<void> {
    while (this.pending.size > 0) {
      const entries = [...this.pending.values()]
      this.pending.clear()
      for (const entry of entries) entry.abort()
      await Promise.all(entries.map((entry) => entry.done))
    }
    // A suspended run's durable work keeps running, to be waited on at resume.
    if (this.suspending) return
    for (const call of this.vm.calls()) {
      if (call.status !== "started") continue
      call.status = "completed"
      const fn = this.function(call)
      if (!(fn instanceof DurableFn)) continue
      const entry = new Pending()
      await new Promise<void>((resolve) => {
        try {
          settle(fn.cancel(call.data as Json, this.call(call, entry)), entry, this.context, () => resolve())
        } catch {
          resolve()
        }
      })
    }
  }

  /** Starts calls that were queued (including idempotent ones) and waits on durable calls in `started`. */
  resume(): void {
    if (this.suspending) return
    for (const call of this.vm.calls()) {
      if (call.status === "queued") this.launch(call)
      else if (call.status === "started") this.wait(call)
    }
  }

  // Starts host work now; its outcome goes back to the VM: a blocking call's continues the job that made it, a
  // concurrent call's waits in the inbox and settles its promise in a later job, in completion order.
  private launch(call: HostCall): void {
    call.status = "running"
    const work = call.work
    if (work !== undefined) return this.begin(call, () => work)
    const fn = this.function(call)
    if (fn === undefined) {
      return this.begin(call, () => {
        throw new HostFailure("ExecutionFailure", `${call.label} is not available in this runtime.`)
      })
    }
    if (fn instanceof DurableFn) {
      return this.begin(
        call,
        (context) => fn.start(call.args, context),
        (data) => {
          const current = this.vm.call(call.id)
          if (current === undefined) return
          current.status = "started"
          current.data = data as Json
          if (this.stopping || this.detached.has(call.id)) return
          this.wait(current)
        },
      )
    }
    this.begin(call, (context) => fn.run(call.args, context))
  }

  private wait(call: HostCall): void {
    const fn = this.function(call)
    if (!(fn instanceof DurableFn)) return
    this.begin(call, (context) => fn.wait(call.data as Json, context))
  }

  // The call's host function: the one it was made with, or, in a restored run, the one at its path now.
  private function(call: HostCall): Fn<unknown> | DurableFn<unknown> | undefined {
    if (call.fn !== undefined) return call.fn
    if (call.path === undefined) return undefined
    return (call.fn = this.vm.ctx.hosts?.resolve(call.path))
  }

  private call(call: HostCall, entry: Pending): CallContext {
    return new CallContext(call.key, call.args, () => this.suspending, entry, this.context)
  }

  // Runs `make` now, so host functions run before the VM runs another job, and settles what it gives. A success goes
  // to `next` when given, otherwise to the VM.
  private begin(
    call: HostCall,
    make: (context: CallContext) => unknown,
    next?: (value: unknown) => void,
  ): void {
    const id = call.id
    const entry = new Pending()
    this.pending.set(id, entry)
    const finish = (settled: Settled) => {
      if (this.pending.get(id) === entry) this.pending.delete(id)
      this.report(id, settled, next)
    }
    let result: unknown
    try {
      result = make(this.call(call, entry))
    } catch (error) {
      return finish({ ok: false, error })
    }
    settle(result, entry, this.context, finish)
  }

  private report(id: number, settled: Settled, next: ((value: unknown) => void) | undefined): void {
    if (next !== undefined && settled.ok) return next(settled.value)
    // Stopped to end or suspend the run: nothing is left to settle.
    if (this.stopping || this.detached.has(id)) return
    const call = this.vm.call(id)
    if (call === undefined) return
    const interrupted = !settled.ok && settled.error instanceof Interrupted
    if (call.blocking && interrupted) {
      // Blocking work interrupted on its own interrupts the execution.
      this.interrupted = true
      this.wake?.()
      return
    }
    this.vm.complete(
      id,
      settled.ok
        ? normal(settled.value)
        : abrupt(
            interrupted
              ? new Interruption()
              : settled.error instanceof HostDefect
                ? locate(settled.error.error, call.site)
                : settled.error,
          ),
    )
    this.wake?.()
  }

  private settled(): Promise<void> {
    if (this.vm.ready || this.suspending || this.cancelled || this.interrupted) return Promise.resolve()
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined
        resolve()
      }
    })
  }
}

// What a host call gets (see `Call`); its signal is made only when read.
class CallContext {
  constructor(
    readonly key: string,
    readonly args: ReadonlyArray<unknown>,
    readonly suspending: () => boolean,
    private readonly entry: Pending,
    readonly context: unknown,
  ) {}
  get signal(): AbortSignal {
    return this.entry.signal
  }
}

// One call in flight: its abort controller, made when the call first reads its signal, and, for `HostWork`, how to
// stop it and when it ends, which stopping the run waits for.
class Pending {
  controller: AbortController | undefined
  stop: (() => void) | void = undefined
  done: Promise<void> | undefined
  get signal(): AbortSignal {
    return (this.controller ??= new AbortController()).signal
  }
  abort(): void {
    this.controller?.abort()
    this.stop?.()
  }
}

// Settles what a host function returned: `HostWork` starts, a Promise settles, and anything else is its value.
const settle = (result: unknown, entry: Pending, context: unknown, finish: (settled: Settled) => void): void => {
  if (result instanceof HostWork) {
    let ended = false
    let resolve: (() => void) | undefined
    entry.stop = result.start(context, (settled) => {
      ended = true
      resolve?.()
      finish(settled)
    })
    if (!ended) entry.done = new Promise<void>((done) => (resolve = done))
    return
  }
  if (result instanceof Promise) {
    result.then(
      (value) => finish({ ok: true, value }),
      (error) => finish({ ok: false, error }),
    )
    return
  }
  finish({ ok: true, value: result })
}
