import { chargeObjects } from "./objects.js"

// `limits.maxHeapBytes`: how much a run's heap may hold. The heap is measured, not the process: everything the run
// can still reach (see `measureVm`), in a fixed size model, so a measurement is the same on
// every platform and garbage never counts.
//
// - An object made by the run: OBJECT_BYTES, plus PROPERTY_BYTES per own property, plus ELEMENT_BYTES per array
//   element or argument (holes included, up to `length`), ENTRY_BYTES per Map, Set, WeakMap or WeakSet entry, and one
//   per byte of a Uint8Array. A function's `name` and `length`, a RegExp's source and flags are part of it.
// - The runtime's own objects (built-ins, host globals) count nothing, though the objects the program stored on them
//   do.
// - A string value: STRING_BYTES plus two per UTF-16 code unit, once per distinct text. Property keys count as part
//   of their property, an error's `stack` text as part of the error, and a built-in's own texts nothing.
//
// Measuring walks the reachable heap, so it is paced by allocation: the run counts roughly what it allocated since the
// last measurement (objects, large strings, what concatenations copy, array contents, elements and properties added at
// once, and FUEL_BYTES per unit of fuel for the rest), and measures again at its next safe point once that could have
// taken it past the limit, and always as its body returns (its bindings still live) and when the run ends.
// A run whose reachable heap is over the limit at a measurement stops with `MemoryLimitExceeded`.

export const OBJECT_BYTES = 64
export const PROPERTY_BYTES = 32
export const ELEMENT_BYTES = 16
export const ENTRY_BYTES = 32
export const STRING_BYTES = 16
/** What a unit of fuel is assumed to allocate, for growth nothing else counts (`push`, a property added). */
export const FUEL_BYTES = 2

export const memoryLimitMessage = (maxHeapBytes: number): string =>
  `Execution exceeded its memory limit of ${maxHeapBytes} bytes.`

/** One run's pacing of measurements against its limit. */
export class HeapMeter {
  /** Roughly what the run allocated since the last measurement. */
  debt = 0
  /** The last measurement, or undefined before the first one of a restored run. */
  live: number | undefined
  /** The last object made, whose array elements (set after it is made) are charged with the next one or check. */
  private last: { readonly items?: unknown } | undefined

  constructor(
    readonly limit: number,
    restored: boolean,
  ) {
    this.live = restored ? undefined : 0
  }

  /** Whether a safe point should measure: what was allocated could have passed the limit, and is worth a walk. */
  get due(): boolean {
    this.settle()
    const live = this.live
    return live === undefined || this.debt >= Math.max(this.limit - live, this.limit / 16)
  }

  /** Records a measurement; whether it is over the limit. */
  measured(bytes: number): boolean {
    this.live = bytes
    this.debt = 0
    this.last = undefined
    return bytes > this.limit
  }

  /** Charges an object the run made (the made-object hook, see `chargeObjects`). */
  push(obj: object): void {
    this.settle()
    this.debt += OBJECT_BYTES
    this.last = obj
  }

  /** Charges the last object's array elements, if it is an array. */
  private settle(): void {
    const items = this.last?.items
    this.last = undefined
    if (Array.isArray(items)) this.debt += ELEMENT_BYTES * items.length
  }
}

/** The meter of the run on this thread's VM right now (`Vm.run` sets it), which allocations charge. */
export let charging: HeapMeter | undefined

export const setCharging = (meter: HeapMeter | undefined): void => {
  charging = meter
  chargeObjects(meter)
  lastConcat = undefined
}

// The last concatenation's result while a meter charges: a concatenation onto it counts as appended
// in place, so only the appended part counts; any other copies every part.
let lastConcat: string | undefined

/** Charges a running run's meter with a string concatenation of `left` and more into `result`. */
export const chargeConcat = (left: unknown, result: string): void => {
  const meter = charging
  if (meter === undefined) return
  meter.debt += 2 * (left === lastConcat ? result.length - (left as string).length : result.length)
  lastConcat = result
}

/** Charges a running run's meter with what was just allocated. */
export const charge = (bytes: number): void => {
  if (charging !== undefined) charging.debt += bytes
}
