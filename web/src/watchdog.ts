// A GPU queue's watchdog (widgets-gpu.md, GPU hang). Submits finish in order, so only the oldest unfinished one is
// timed, from its submit or, if later, from when the one before it finished: still unfinished `GPU_HANG_MS` after
// that, it hangs and its owner's `hang` runs; work queued behind it isn't blamed. At a device loss, the oldest
// unfinished submit hangs if it had been running that long. Nothing waits on the GPU: one `onSubmittedWorkDone` per
// submit and one timer for the oldest.

import { GPU_HANG_MS } from "./protocol.js"

interface Submit {
  hang: () => void
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

  /** Work was just submitted: `hang` runs if it hangs. Resolves (or rejects) when the work is done. */
  submitted(hang: () => void): Promise<undefined> {
    const submit: Submit = { hang, start: this.now(), done: false, hung: false }
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

  /** The device was lost: the oldest unfinished submit hangs if it had been running `GPU_HANG_MS`; then none is left. */
  lost() {
    const oldest = this.submits[0]
    if (oldest && !oldest.done && !oldest.hung && this.now() - oldest.start >= GPU_HANG_MS) this.blame(oldest)
    this.stop()
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
