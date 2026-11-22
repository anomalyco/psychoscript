import { charge } from "./heap.js"
import { rangeError } from "./model.js"

// The timeout only fires between interpreter steps, so a single built-in must not be able to materialize an
// unbounded value. These bound what one call may build; programs cannot reach such sizes any other way.

/** Longest string a built-in or operator may produce. */
export const MAX_STRING_LENGTH = 1 << 24
/** Longest array a built-in may create or grow to. */
export const MAX_ARRAY_LENGTH = 10_000_000
/** Most promises that may be pending at once. */
export const MAX_PENDING_PROMISES = 10_000
/**
 * Deepest nesting a value may have when it crosses to or from the host, or `JSON.stringify` copies it on its fast path,
 * unless `limits.maxValueDepth` says otherwise.
 */
export const DEFAULT_VALUE_DEPTH = 32
/**
 * The most `limits.maxValueDepth` may be. Those copies recurse once a level, on the native stack in the Rust
 * implementation, where at this depth they fit the stack a run has (see `interpreter-support.md`).
 */
export const MAX_VALUE_DEPTH_LIMIT = 256
/** The depth the walk that runs a program's `toJSON`s and awaits promises allows, at the least. */
export const WALK_DEPTH = 100

/** Checks the length of a string a built-in or operator is about to make, and charges it to the run's heap meter. */
export const checkStringLength = (length: number): void => {
  if (length > MAX_STRING_LENGTH) throw rangeError("Invalid string length")
  charge(2 * length)
}

export const checkArrayLength = (length: number): void => {
  if (length > MAX_ARRAY_LENGTH) throw rangeError("Invalid array length")
}
