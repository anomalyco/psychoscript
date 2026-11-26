import { MAX_ARRAY_LENGTH } from "../runtime/limits.js"
import { constructor, methods, prototypeFrom, receiver, requiresNew } from "../runtime/native.js"
import { rangeError, typeError } from "../runtime/model.js"
import {
  ArrayBufferObj,
  Bytes,
  defineAccessor,
  get,
  Native,
  Obj,
  coerceToNumber,
  type Value,
} from "../runtime/objects.js"
import { withPrimitives, withReads } from "../runtime/callback.js"
import type { Interpreter } from "../runtime/interpreter.js"

const MAX_INDEX = 2 ** 53 - 1

/** ToNumber on each value, in order, after ToPrimitive (which may call program code; see `withPrimitives`). */
const numbers = (values: Array<Value>, body: (numbers: Array<number>) => ReturnType<typeof withPrimitives>) =>
  withPrimitives("number", values, (primitives) => body(primitives.map(coerceToNumber)), true)

/** ToIntegerOrInfinity on a number. */
const integer = (value: number): number => (Number.isNaN(value) ? 0 : Math.trunc(value) + 0)

/** ToIndex on a number: a RangeError for a negative or unsafe one. */
const toIndex = (value: number, what: string): number => {
  const index = integer(value)
  if (index < 0 || index > MAX_INDEX) throw rangeError(`Invalid ${what}: ${String(value)}`)
  return index
}

/** A relative index (`slice`) clamped to `[0, length]`; `undefined` stands for `fallback`. */
const relative = (raw: Value, value: number, length: number, fallback: number): number => {
  if (raw === undefined) return fallback
  const index = integer(value)
  return index < 0 ? Math.max(length + index, 0) : Math.min(index, length)
}

// InitializeTypedArrayFromArrayBuffer: a view that shares the buffer's memory.
export const viewOf = (buffer: ArrayBufferObj, args: Array<Value>, proto: Obj) =>
  numbers([args[1]], ([rawOffset]) => {
    const offset = toIndex(rawOffset!, "typed array offset")
    return numbers([args[2]], ([rawLength]) => {
      const length = args[2] === undefined ? undefined : toIndex(rawLength!, "typed array length")
      const available = buffer.data.byteLength
      if (length === undefined && offset > available) {
        throw rangeError(`Start offset ${offset} is outside the bounds of the buffer`)
      }
      const bytes = length ?? available - offset
      if (offset + bytes > available) throw rangeError(`Invalid typed array length: ${bytes}`)
      return new Bytes(proto, new Uint8Array(buffer.data, offset, bytes), buffer)
    })
  })

export const arrayBufferGlobal = <R>(ctx: Interpreter<R>): Native => {
  const builtins = ctx.builtins
  const proto = builtins.ArrayBuffer
  const ctor = constructor(builtins, proto, {
    name: "ArrayBuffer",
    length: 1,
    call: requiresNew("ArrayBuffer"),
    construct: (args, newTarget) =>
      numbers([args[0]], ([raw]) => {
        const length = toIndex(raw!, "array buffer length")
        return withReads(() => {
          const options = args[1]
          if (options instanceof Obj && get(options, "maxByteLength") !== undefined) {
            throw typeError("Resizable ArrayBuffers (maxByteLength) are not supported.")
          }
          if (length > MAX_ARRAY_LENGTH) throw rangeError("Array buffer allocation failed")
          return new ArrayBufferObj(prototypeFrom(newTarget, proto), new ArrayBuffer(length))
        })
      }),
  })
  methods(builtins, ctor, [["isView", 1, (_, args) => args[0] instanceof Bytes]])
  const self = (thisValue: Value, name: string) => receiver(ArrayBufferObj, thisValue, `ArrayBuffer.prototype.${name}`)
  defineAccessor(proto, "byteLength", (thisValue) => self(thisValue, "byteLength").data.byteLength)
  defineAccessor(proto, "maxByteLength", (thisValue) => self(thisValue, "maxByteLength").data.byteLength)
  defineAccessor(proto, "resizable", (thisValue) => (self(thisValue, "resizable"), false))
  defineAccessor(proto, "detached", (thisValue) => (self(thisValue, "detached"), false))
  methods(builtins, proto, [
    [
      "slice",
      2,
      (thisValue, args) => {
        const data = self(thisValue, "slice").data
        return numbers([args[0], args[1]], ([start, end]) => {
          const length = data.byteLength
          const first = relative(args[0], start!, length, 0)
          const final = relative(args[1], end!, length, length)
          return new ArrayBufferObj(builtins.ArrayBuffer, data.slice(first, Math.max(first, final)))
        })
      },
    ],
  ])
  return ctor
}
