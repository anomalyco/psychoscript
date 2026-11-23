#!/usr/bin/env bun
// The GPU hang watchdog (src/watchdog.ts; widgets-gpu.md, GPU hang) on a queue whose work finishes when a check says
// so, in order as a GPU's does, and strikes on a clock the check sets: no GPU, no timing margins beyond the 250 ms rule.
//
//   bun scripts/watchdog-check.ts

import { Strikes, Watchdog } from "../src/watchdog.ts"
import { STRIKE_MS } from "../src/gpu-checks.ts"
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
const none = () => {}

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
  dog.submitted(() => hung.push("a"), none)
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
  dog.submitted(() => hung.push("a"), none)
  await sleep(20)
  dog.submitted(() => hung.push("b"), none)
  await sleep(GPU_HANG_MS + 150)
  check(hung.join() === "a", "the oldest unfinished submit hangs; work queued behind it isn't blamed", hung)
  dog.stop()
}
{
  // A submit is timed from when the one before it finished: b, queued behind a slow a, has its own 250 ms.
  const q = queue()
  const dog = new Watchdog(q)
  const hung: string[] = []
  dog.submitted(() => hung.push("a"), none)
  dog.submitted(() => hung.push("b"), none)
  await sleep(GPU_HANG_MS - 50)
  q.finish()
  await sleep(150)
  check(hung.length === 0, "the next submit's clock starts when the one before it finished (not at its submit)", hung)
  await sleep(GPU_HANG_MS)
  check(hung.join() === "b", "it hangs 250 ms after that", hung)
  dog.stop()
}
{
  // At a loss: each run with work unfinished gets one strike, however many of its submits were; one whose work finished
  // gets none; and nothing is timed after.
  const q = queue()
  const dog = new Watchdog(q)
  const struck: string[] = []
  const hung: string[] = []
  const run = () => struck.push("run")
  const done = () => struck.push("done")
  dog.submitted(() => hung.push("done"), done)
  dog.submitted(() => hung.push("run"), run)
  dog.submitted(() => hung.push("run"), run)
  q.finish()
  await sleep(10)
  dog.lost()
  await sleep(GPU_HANG_MS + 50)
  check(struck.join() === "run", "a loss strikes each run with work unfinished, once, and none whose work finished", struck)
  check(hung.length === 0, "a loss is no GPU hang by itself: no 250 ms rule at a loss, no timer after it", hung)
}
{
  // Two strikes within 30 s stop; strikes further apart don't.
  const clock = { t: 0 }
  const strikes = new Strikes(() => clock.t)
  const got = [strikes.strike()]
  clock.t = STRIKE_MS + 1
  got.push(strikes.strike())
  clock.t += STRIKE_MS
  got.push(strikes.strike())
  check(got.join() === "false,false,true", "a first strike changes nothing; a second within 30 s stops; 30 s apart, it doesn't", got)
}

console.log(failed === 0 ? "watchdog: all checks pass" : `watchdog: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
