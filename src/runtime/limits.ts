import { rangeError } from "./model.js"

// The timeout only fires between interpreter steps, so a single built-in must not be able to materialize an
// unbounded value. These bound what one call may build; programs cannot reach such sizes any other way.

/** Longest string a built-in or operator may produce. */
export const MAX_STRING_LENGTH = 1 << 24
/** Longest array a built-in may create or grow to. */
export const MAX_ARRAY_LENGTH = 10_000_000
/** Most promises that may be pending at once. */
export const MAX_PENDING_PROMISES = 10_000
/** Deepest nesting a value may have when it crosses to or from the host. */
export const MAX_VALUE_DEPTH = 32

export const checkStringLength = (length: number): void => {
  if (length > MAX_STRING_LENGTH) throw rangeError("Invalid string length")
}

export const checkArrayLength = (length: number): void => {
  if (length > MAX_ARRAY_LENGTH) throw rangeError("Invalid array length")
}

const SMALL_BIGINT = 1n << 4096n

/** Refuses, before converting, a BigInt whose digits in `radix` would make a string longer than strings may be. */
export const checkBigIntDigits = (value: bigint, radix = 10, grouped = false): void => {
  if (value < SMALL_BIGINT && value > -SMALL_BIGINT) return
  const bits = (value < 0n ? -value : value).toString(16).length * 4
  const digits = Math.floor(bits / Math.log2(radix)) + 2
  checkStringLength(grouped ? digits + Math.floor(digits / 3) : digits)
}
