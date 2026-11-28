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

/**
 * Most bits a BigInt may have besides its sign: it lies in [-2^MAX_BIGINT_BITS, 2^MAX_BIGINT_BITS). Past about a
 * million bits, one multiplication, division or decimal conversion can take tens of milliseconds. Firefox and Safari
 * refuse BigInts past 2^20 bits (V8 allows far more); the 256 bits under that cover an operator's carry, engines
 * rounding sizes up to whole 64-bit digits, and the size estimates below, so the engine's own limit is never reached.
 */
export const MAX_BIGINT_BITS = (1 << 20) - 256
const maxBits = BigInt(MAX_BIGINT_BITS)

// A shift instead of comparing with 2^MAX_BIGINT_BITS: that bound would be a 128 KB BigInt, and negating a value to
// compare its magnitude would copy it. Shifting a BigInt that fits right by the limit leaves 0 or -1, cheaply.
export const fitsBigIntSize = (value: bigint): boolean => {
  const high = value >> maxBits
  return high === 0n || high === -1n
}

/** Whether `value << shift` fits, without computing it. */
export const fitsShiftedBigInt = (value: bigint, shift: bigint): boolean => shift <= maxBits && fitsWithin(value, maxBits - shift)

/** The bits a BigInt has besides its sign, within one either way, without converting it to text. */
export const approxBitLength = (value: bigint): number => {
  const n = Math.abs(Number(value))
  if (n !== Infinity) return n === 0 ? 0 : Math.floor(Math.log2(n)) + 1
  // Past 2^1024 a number is Infinity, so search for the smallest shift that leaves 0 or -1. Shifts past the length
  // only read the value; those under it copy its top bits, about one copy of the value in all.
  let lo = 1023
  let hi = MAX_BIGINT_BITS + 1
  if (!fitsWithin(value, BigInt(hi))) return hi
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (fitsWithin(value, BigInt(mid))) hi = mid
    else lo = mid
  }
  return hi
}

/** Whether a BigInt needs at most `bits` bits besides its sign: shifting it right by them leaves 0 or -1. */
export const fitsWithin = (value: bigint, bits: bigint): boolean => {
  const high = value >> bits
  return high === 0n || high === -1n
}

/**
 * Whether the integer `digits` spell in `radix` (no sign, prefix or separators) has more bits than any BigInt may,
 * without parsing it. An integer it can't rule out has at most a few bits more than the limit.
 */
export const bigIntTextTooLong = (digits: string, radix: number): boolean => {
  const first = digits.search(/[^0]/)
  if (first < 0) return false
  return (digits.length - first - 1) * Math.log2(radix) > MAX_BIGINT_BITS + 1
}

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
