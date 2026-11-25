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

/** Most bits a BigInt may have. Past about a million bits, one multiplication, division or decimal conversion can take tens of milliseconds. */
export const MAX_BIGINT_BITS = 1 << 20
// Both bounds are made once: negating a million-bit BigInt on every check would copy it each time.
const bigintBound = 1n << BigInt(MAX_BIGINT_BITS)
const negativeBigintBound = -bigintBound

export const fitsBigIntSize = (value: bigint): boolean => value < bigintBound && value > negativeBigintBound

export const checkBigIntSize = (value: bigint): bigint => {
  if (!fitsBigIntSize(value)) throw rangeError("Maximum BigInt size exceeded")
  return value
}

export const checkStringLength = (length: number): void => {
  if (length > MAX_STRING_LENGTH) throw rangeError("Invalid string length")
}

export const checkArrayLength = (length: number): void => {
  if (length > MAX_ARRAY_LENGTH) throw rangeError("Invalid array length")
}
