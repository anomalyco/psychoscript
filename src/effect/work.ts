import { Cause, Context, Effect, Exit } from "effect"
import { HostDefect, HostWork, Interrupted } from "../runtime/contract.js"

// What a host function returned, with an Effect as host work.
export const adapt = (value: unknown): unknown => (Effect.isEffect(value) ? work(value) : value)

// An Effect as host work: it runs with the run's services when the driver starts it, an abort interrupts it, and its
// exit settles the call. An interruption stays one, and a defect gets the call's location.
export const work = (effect: Effect.Effect<unknown, unknown, unknown>): HostWork =>
  new HostWork((context, done) => {
    const fiber = Effect.runForkWith((context ?? emptyServices) as Context.Context<unknown>)(effect)
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) {
        const value = exit.value
        return done({ ok: true, value: Effect.isEffect(value) ? work(value) : value })
      }
      const cause = exit.cause
      done({
        ok: false,
        error: Cause.hasInterruptsOnly(cause)
          ? new Interrupted()
          : Cause.hasDies(cause)
            ? new HostDefect(Cause.squash(cause))
            : Cause.squash(cause),
      })
    })
    return () => fiber.interruptUnsafe()
  })

const emptyServices = Context.empty()
