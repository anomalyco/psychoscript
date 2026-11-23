import { constructor, constants, type Method, methods } from "../runtime/native.js"
import { coerceToInteger, coerceToNumber, type Value } from "../runtime/objects.js"
import { rangeError, syntaxError, typeError } from "../runtime/model.js"
import { checkBigIntSize, MAX_BIGINT_BITS } from "../runtime/limits.js"
import { describeValue } from "../runtime/references.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { withPrimitives } from "../runtime/callback.js"
import { coerce } from "./value.js"

export const numberGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const number = constructor(builtins, builtins.Number, {
    name: "Number",
    length: 1,
    call: (_, args) => coerce(ctx, "Number", args),
  })
  constants(number, {
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    MAX_VALUE: Number.MAX_VALUE,
    MIN_VALUE: Number.MIN_VALUE,
    EPSILON: Number.EPSILON,
    NaN: Number.NaN,
    POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
    NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
  })
  methods(builtins, number, [
    ["isInteger", 1, (_, args) => Number.isInteger(args[0])],
    ["isFinite", 1, (_, args) => Number.isFinite(args[0])],
    ["isNaN", 1, (_, args) => Number.isNaN(args[0])],
    ["isSafeInteger", 1, (_, args) => Number.isSafeInteger(args[0])],
    ["parseInt", 2, (_, args) => coerce(ctx, "parseInt", args)],
    ["parseFloat", 1, (_, args) => coerce(ctx, "parseFloat", args)],
  ])

  const self = (thisValue: Value, name: string): number => {
    if (typeof thisValue === "number") return thisValue
    throw typeError(`Number.prototype.${name} requires that 'this' be a Number.`)
  }
  // The receiver is checked first, then the one argument converts through ToPrimitive with the number hint.
  const formatting = (name: string, op: (value: number, digits: number | undefined) => string): Method => [
    name,
    1,
    (thisValue, args) => {
      const value = self(thisValue, name)
      return withPrimitives("number", [args[0]], ([digits]) =>
        op(value, digits === undefined ? undefined : coerceToNumber(digits)),
      )
    },
  ]
  methods(builtins, builtins.Number, [
    formatting("toFixed", (value, digits) => value.toFixed(digits)),
    ["toLocaleString", 0, (thisValue) => self(thisValue, "toLocaleString").toLocaleString("en-US")],
    formatting("toExponential", (value, digits) => value.toExponential(digits)),
    formatting("toPrecision", (value, digits) => (digits === undefined ? value.toString() : value.toPrecision(digits))),
    formatting("toString", (value, radix) => value.toString(radix)),
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf")],
  ])
  return number
}

export const booleanGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const boolean = constructor(builtins, builtins.Boolean, {
    name: "Boolean",
    length: 1,
    call: (_, args) => coerce(ctx, "Boolean", args),
  })
  const self = (thisValue: Value, name: string): boolean => {
    if (typeof thisValue === "boolean") return thisValue
    throw typeError(`Boolean.prototype.${name} requires that 'this' be a Boolean.`)
  }
  methods(builtins, builtins.Boolean, [
    ["toString", 0, (thisValue) => String(self(thisValue, "toString"))],
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf")],
  ])
  return boolean
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
  })
  // Past MAX_BIGINT_BITS every BigInt already fits, except a negative one made unsigned, which would not fit the limit.
  const wrap = (name: string, op: (bits: number, value: bigint) => bigint): Method => [
    name,
    2,
    (_, args) =>
      withPrimitives("number", [args[0], args[1]], ([bits, value]) => {
        const width = toIndex(bits)
        const n = toBigInt(value)
        if (width <= MAX_BIGINT_BITS) return op(width, n)
        if (name === "asUintN" && n < 0n) throw rangeError("Maximum BigInt size exceeded")
        return n
      }),
  ]
  methods(builtins, bigint, [
    wrap("asIntN", (bits, value) => BigInt.asIntN(bits, value)),
    wrap("asUintN", (bits, value) => BigInt.asUintN(bits, value)),
  ])

  const self = (thisValue: Value, name: string): bigint => {
    if (typeof thisValue === "bigint") return thisValue
    throw typeError(`BigInt.prototype.${name} requires that 'this' be a BigInt.`)
  }
  methods(builtins, builtins.BigInt, [
    ["toLocaleString", 0, (thisValue) => self(thisValue, "toLocaleString").toLocaleString("en-US")],
    [
      "toString",
      0,
      (thisValue, args) => {
        const value = self(thisValue, "toString")
        return withPrimitives("number", [args[0]], ([radix]) => {
          const base = radix === undefined ? 10 : coerceToInteger(radix)
          if (base < 2 || base > 36) throw rangeError("toString() radix must be between 2 and 36.")
          return value.toString(base)
        })
      },
    ],
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf")],
  ])
  return bigint
}

/** ToBigInt on a primitive: numbers are refused, unlike `BigInt(n)`. */
const toBigInt = (value: Value): bigint => {
  if (typeof value === "bigint") return value
  if (typeof value === "boolean") return value ? 1n : 0n
  if (typeof value === "string") return stringToBigInt(value)
  throw typeError(`Cannot convert ${describeValue(value)} to a BigInt.`)
}

const numberToBigInt = (value: number): bigint => {
  if (Number.isInteger(value)) return BigInt(value)
  throw rangeError(`The number ${value} cannot be converted to a BigInt because it is not an integer.`)
}

export const bigintSyntax = /^(?:[+-]?\d+|0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+)?$/
// Decimal digits past this many always exceed MAX_BIGINT_BITS (barring leading zeros); parsing them is quadratic.
const maxDecimalDigits = Math.ceil(MAX_BIGINT_BITS * Math.log10(2)) + 1

const stringToBigInt = (text: string): bigint => {
  const trimmed = text.trim()
  if (!bigintSyntax.test(trimmed)) throw syntaxError(`Cannot convert ${JSON.stringify(text.slice(0, 64))} to a BigInt.`)
  if (trimmed.length > MAX_BIGINT_BITS + 2 || (/^[+-]?\d/.test(trimmed) && trimmed.length > maxDecimalDigits)) {
    throw rangeError("Maximum BigInt size exceeded")
  }
  return checkBigIntSize(BigInt(trimmed))
}

// ToIndex: an integer from 0 to 2^53 - 1.
const toIndex = (value: Value): number => {
  const index = value === undefined ? 0 : coerceToInteger(value)
  if (index < 0 || index > Number.MAX_SAFE_INTEGER) throw rangeError("Invalid value: not (convertible to) a safe integer.")
  return index
}
