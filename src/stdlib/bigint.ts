import { constructor, type Method, methods } from "../runtime/native.js"
import { coerceToInteger, type Value } from "../runtime/objects.js"
import { rangeError, syntaxError, typeError } from "../runtime/model.js"
import { checkBigIntDigits } from "../runtime/limits.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { withPrimitives } from "../runtime/callback.js"
import { describeValue } from "../runtime/references.js"
import { bigintFailure } from "../runtime/operations.js"

/** StringToBigInt: the host's parse, which follows the spec (whitespace, `0x`/`0o`/`0b`, no sign after a prefix). */
const parseBigInt = (text: string): bigint => {
  try {
    return BigInt(text)
  } catch {
    throw syntaxError(`Cannot convert ${text} to a BigInt.`)
  }
}

/** ToBigInt on a primitive: Numbers are refused, unlike `BigInt(number)`. */
const toBigInt = (value: Value): bigint => {
  if (typeof value === "bigint") return value
  if (typeof value === "boolean") return value ? 1n : 0n
  if (typeof value === "string") return parseBigInt(value)
  throw typeError(`Cannot convert ${typeof value === "number" ? value : describeValue(value)} to a BigInt.`)
}

/** NumberToBigInt: only an integral Number has an exact BigInt. */
const numberToBigInt = (value: number): bigint => {
  if (!Number.isInteger(value)) {
    throw rangeError(`The number ${value} cannot be converted to a BigInt because it is not an integer.`)
  }
  return BigInt(value)
}

/** ToIndex: an integer in [0, 2^53 - 1]. */
const toIndex = (value: Value): number => {
  const index = value === undefined ? 0 : coerceToInteger(value)
  if (index < 0 || index > Number.MAX_SAFE_INTEGER)
    throw rangeError("Invalid value: not (convertible to) a safe integer.")
  return index
}

export const bigintGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const bigint = constructor(builtins, builtins.BigInt, {
    name: "BigInt",
    length: 1,
    call: (_, args) =>
      withPrimitives("number", [args[0]], ([value]) =>
        typeof value === "number" ? numberToBigInt(value) : toBigInt(value),
      ),
    // BigInt is a constructor in the spec, so `extends BigInt` is allowed, but constructing one always throws.
    construct: () => {
      throw typeError("BigInt is not a constructor.")
    },
  })
  const truncating = (name: "asIntN" | "asUintN"): Method => [
    name,
    2,
    (_, args) =>
      withPrimitives("number", [args[0]], ([bits]) => {
        const width = toIndex(bits)
        return withPrimitives("number", [args[1]], ([value]) => {
          const n = toBigInt(value)
          try {
            return BigInt[name](width, n)
          } catch (error) {
            throw bigintFailure(error)
          }
        })
      }),
  ]
  methods(builtins, bigint, [truncating("asIntN"), truncating("asUintN")])

  const self = (thisValue: Value, name: string): bigint => {
    if (typeof thisValue === "bigint") return thisValue
    throw typeError(`BigInt.prototype.${name} requires that 'this' be a BigInt.`)
  }
  methods(builtins, builtins.BigInt, [
    [
      "toString",
      0,
      (thisValue, args) => {
        const value = self(thisValue, "toString")
        return withPrimitives("number", [args[0]], ([radix]) => {
          const base = radix === undefined ? 10 : coerceToInteger(radix)
          if (base < 2 || base > 36) throw rangeError("toString() radix must be between 2 and 36.")
          checkBigIntDigits(value, base)
          return value.toString(base)
        })
      },
    ],
    [
      "toLocaleString",
      0,
      (thisValue) => {
        const value = self(thisValue, "toLocaleString")
        checkBigIntDigits(value, 10, true)
        // Like Number's, always en-US, so output does not depend on the host.
        return value.toLocaleString("en-US")
      },
    ],
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf")],
  ])
  return bigint
}
