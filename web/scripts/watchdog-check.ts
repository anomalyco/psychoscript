#!/usr/bin/env bun
// The GPU hang watchdog (src/watchdog.ts; widgets-gpu.md, GPU hang) on a queue whose work finishes when a check says
// so, in order as a GPU's does: no GPU, no timing margins beyond the 250 ms rule itself.
//
//   bun scripts/watchdog-check.ts

import { Watchdog } from "../src/watchdog.ts"
import { GPU_HANG_MS } from "../src/protocol.ts"

/** A queue whose submits finish when `finish()` is called, oldest first. */
function queue() {
  const waiting: Array<() => void> = []
  return {
    onSubmittedWorkDone: () => new Promise<undefined>((r) => waiting.push(() => r(undefined))),
    finish: () => waiting.shift()?.(),
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const check = (ok: boolean, name: string, detail?: unknown) => {
  if (!ok) failed++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`)
}

{
  // Work done in time: nothing hangs.
  const q = queue()
  const dog = new Watchdog(q)
  const hung: string[] = []
  dog.submitted(() => hung.push("a"))
  await sleep(GPU_HANG_MS / 2)
  q.finish()
  await sleep(GPU_HANG_MS)
  check(hung.length === 0, "work done within 250 ms doesn't hang", hung)
  dog.stop()
}
{
  // The oldest hangs; the work queued behind it isn't blamed, though it too is unfinished 250 ms after its submit.
  const q = queue()
  const dog = new Watchdog(q)
  const hung: string[] = []
  dog.submitted(() => hung.push("a"))
  await sleep(20)
  dog.submitted(() => hung.push("b"))
  await sleep(GPU_HANG_MS + 150)
  check(hung.join() === "a", "the oldest unfinished submit hangs; work queued behind it isn't blamed", hung)
  dog.stop()
}
{
  // A submit is timed from when the one before it finished: b, queued behind a slow a, has its own 250 ms.
  const q = queue()
  const dog = new Watchdog(q)
  const hung: string[] = []
  dog.submitted(() => hung.push("a"))
  dog.submitted(() => hung.push("b"))
  await sleep(GPU_HANG_MS - 50)
  q.finish()
  await sleep(150)
  check(hung.length === 0, "the next submit's clock starts when the one before it finished (not at its submit)", hung)
  await sleep(GPU_HANG_MS)
  check(hung.join() === "b", "it hangs 250 ms after that", hung)
  dog.stop()
}
{
  // At a loss: the oldest unfinished submit, running 250 ms, hangs; one running less doesn't.
  const late = new Watchdog(queue(), () => performance.now())
  const hung: string[] = []
  late.submitted(() => hung.push("short"))
  await sleep(20)
  late.lost()
  check(hung.length === 0, "a loss doesn't blame a submit running under 250 ms", hung)
  const clock = { t: 0 }
  const dog = new Watchdog(queue(), () => clock.t)
  dog.submitted(() => hung.push("long"))
  dog.submitted(() => hung.push("behind"))
  clock.t = GPU_HANG_MS
  dog.lost()
  await sleep(GPU_HANG_MS + 50)
  check(hung.join() === "long", "a loss blames the oldest unfinished submit running 250 ms, once, and nothing behind it", hung)
}

console.log(failed === 0 ? "watchdog: all checks pass" : `watchdog: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
