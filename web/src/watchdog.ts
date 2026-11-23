// A GPU queue's watchdog (widgets-gpu.md, GPU hang). Submits finish in order, so only the oldest unfinished one is
// timed, from its submit or, if later, from when the one before it finished: still unfinished `GPU_HANG_MS` after
// that, it hangs and its `hang` runs; work queued behind it isn't blamed. At a device loss, each run with work still
// unfinished gets a strike (`Strikes`). Nothing waits on the GPU: one `onSubmittedWorkDone` per submit and one
// timer for the oldest. (Chromium settles `device.lost` before the work pending at the loss: unfinished work is seen.)

import { STRIKE_MS } from "./gpu-checks.js"
import { GPU_HANG_MS } from "./protocol.js"

interface Submit {
  hang: () => void
  /** Its submitter's strike: called once per loss, however many of its submits were unfinished. */
  struck: () => void
  start: number
  done: boolean
  hung: boolean
}

/** What the watchdog needs of a queue. */
export interface WorkQueue {
  onSubmittedWorkDone(): Promise<undefined>
}

export class Watchdog {
  private readonly submits: Submit[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private gone = false

  constructor(
    private readonly queue: WorkQueue,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Work was just submitted: `hang` runs if it hangs, `struck` if it is unfinished when the device is lost (pass the
   * run's own, the same each time: one strike a run a loss). Resolves (or rejects) when the work is done.
   */
  submitted(hang: () => void, struck: () => void): Promise<undefined> {
    const submit: Submit = { hang, struck, start: this.now(), done: false, hung: false }
    this.submits.push(submit)
    if (this.submits.length === 1) this.arm()
    const done = this.queue.onSubmittedWorkDone()
    const finish = () => {
      submit.done = true
      this.settle()
    }
    done.then(finish, finish)
    return done
  }

  /** The device was lost: each run with work unfinished gets a strike, once; then none is left. */
  lost() {
    const struck = new Set(this.submits.filter((submit) => !submit.done).map((submit) => submit.struck))
    this.stop()
    for (const strike of struck) strike()
  }

  /** No more timing (the device or the widget is gone). */
  stop() {
    this.gone = true
    clearTimeout(this.timer)
    this.submits.length = 0
  }

  // The finished submits at the front go; the next one's clock starts when the one before it finished.
  private settle() {
    if (this.gone || !this.submits[0]?.done) return
    while (this.submits[0]?.done) this.submits.shift()
    const oldest = this.submits[0]
    if (oldest) oldest.start = Math.max(oldest.start, this.now())
    this.arm()
  }

  private arm() {
    clearTimeout(this.timer)
    const oldest = this.submits[0]
    if (!oldest || oldest.hung) return
    this.timer = setTimeout(
      () => {
        if (this.submits[0] === oldest && !oldest.done && !oldest.hung) this.blame(oldest)
      },
      Math.max(0, oldest.start + GPU_HANG_MS - this.now()),
    )
  }

  private blame(submit: Submit) {
    submit.hung = true
    submit.hang()
  }
}

/** A run's strikes at device losses (widgets-gpu.md, Strikes): whether one is the second within `STRIKE_MS`. */
export class Strikes {
  private last: number | undefined

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A strike now: true when it is the second within `STRIKE_MS` of the last (the run stops). */
  strike(): boolean {
    const now = this.now()
    const second = this.last !== undefined && now - this.last <= STRIKE_MS
    this.last = now
    return second
  }
}
