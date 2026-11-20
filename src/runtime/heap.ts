// `limits.maxHeapBytes`: how much a run's heap may hold. The heap is measured, not the process: everything the run
// can still reach (see `measureVm`), in a size model both implementations share, so a measurement is the same on
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
// last measurement (objects, large strings, array contents, and FUEL_BYTES per unit of fuel for the rest), and
// measures again at its next safe point once that could have taken it past the limit, and always when its body ends.
// A run whose reachable heap is over the limit at a measurement stops with `MemoryLimitExceeded`. Each measurement
// finds the same in both implementations; when they fall between the first and the last differs.

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

  constructor(
    readonly limit: number,
    restored: boolean,
  ) {
    this.live = restored ? undefined : 0
  }

  /** Whether a safe point should measure: what was allocated could have passed the limit, and is worth a walk. */
  get due(): boolean {
    const live = this.live
    return live === undefined || this.debt >= Math.max(this.limit - live, this.limit / 16)
  }

  /** Records a measurement; whether it is over the limit. */
  measured(bytes: number): boolean {
    this.live = bytes
    this.debt = 0
    return bytes > this.limit
  }
}

/** The meter of the run on this thread's VM right now (`Vm.run` sets it), which allocations charge. */
export let charging: HeapMeter | undefined

export const setCharging = (meter: HeapMeter | undefined): void => {
  charging = meter
}

/** Charges a running run's meter with what was just allocated. */
export const charge = (bytes: number): void => {
  if (charging !== undefined) charging.debt += bytes
}
