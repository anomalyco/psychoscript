import { withPrimitives, withReads } from "../runtime/callback.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { checkArrayLength, checkStringLength, MAX_ARRAY_LENGTH } from "../runtime/limits.js"
import { rangeError, typeError } from "../runtime/model.js"
import { constructor, fn } from "../runtime/native.js"
import {
  Arr,
  ArrayBufferObj,
  type Attributes,
  Bytes,
  data,
  define,
  defineAccessor,
  get,
  hasPrototype,
  HostNamespace,
  type NativeCall,
  type NativeResult,
  Obj,
  own,
  record,
  type Value,
} from "../runtime/objects.js"
import { describeValue } from "../runtime/references.js"
import { Invoke } from "../runtime/signals.js"
import { type Builtins, primitivePrototype } from "../runtime/intrinsics.js"
import { byteLength, decode, decodedLength, encode, type Encoding, encodingOf, write } from "./encoding.js"
import {
  bufferOutOfBounds,
  invalidArgType,
  invalidArgValue,
  invalidBufferSize,
  kMaxLength,
  nodeError,
  outOfRange,
  unknownEncoding,
} from "./node-errors.js"

/** Buffer.from's TypeError for a value it can't make bytes of. */
export const invalidFrom = (builtins: Builtins, value: Value): NativeResult =>
  withReads(() => {
    throw invalidArgType(builtins, "first argument", ["string", "Buffer", "ArrayBuffer", "Array", "Array-like Object"], value)
  })

/** A Node Buffer: a Uint8Array whose text conversions default to UTF-8. */
export class BufferObj extends Bytes {
  override toString() {
    checkStringLength(this.bytes.length)
    return decode(this.bytes, "utf8")
  }
  /** A host Buffer where the host has one, and otherwise a Uint8Array. */
  override toHost() {
    const host = (globalThis as { Buffer?: { from(bytes: Uint8Array): Uint8Array<ArrayBuffer> } }).Buffer
    return host === undefined ? new Uint8Array(this.bytes) : host.from(this.bytes)
  }
  override derive(builtins: Builtins, bytes: Uint8Array, buffer?: ArrayBufferObj) {
    return new BufferObj(builtins.Buffer, bytes, buffer)
  }
  override inspect() {
    const shown = Array.from(this.bytes.subarray(0, 50), (byte) => byte.toString(16).padStart(2, "0")).join(" ")
    const more = this.bytes.length > 50 ? ` ... ${this.bytes.length - 50} more bytes` : ""
    return `<Buffer${shown === "" ? "" : ` ${shown}`}${more}>`
  }
}

// Node's Buffer (lib/buffer.js and lib/internal/buffer.js in Node 24), written over the program's own bytes: every
// argument check, coercion, error and result as Node has them. Where Node converts an object argument (`+value`,
// `encoding += ""`), the conversion runs program code through `withPrimitives`, at the point Node makes it.

const enumerable: Attributes = data

/** ToNumber of a primitive, with V8's messages. */
const toNumber = (value: Value): number => {
  if (typeof value === "bigint") throw typeError("Cannot convert a BigInt value to a number")
  if (typeof value === "symbol") throw typeError("Cannot convert a Symbol value to a number")
  return value instanceof HostNamespace ? Number.NaN : Number(value)
}

/** ToString of a primitive, as `value + ""` gives it. */
const toText = (value: Value): string => {
  if (typeof value === "symbol") throw typeError("Cannot convert a Symbol value to a string")
  return String(value)
}

/**
 * `withPrimitives` for one value. A primitive skips it: whether a value needs converting is the same each time a
 * built-in runs again, so the conversions it does ask for keep their order.
 */
const primitive = (hint: "number" | "string" | "default", value: Value, body: (value: Value) => NativeResult) =>
  value instanceof Obj ? withPrimitives(hint, [value], (values) => body(values[0])) : body(value)

/** Byte `index` of `bytes`, or undefined where `buf[index]` would be: Node's bounds checks read them so. */
const at = (bytes: Uint8Array, index: number): number | undefined =>
  Number.isInteger(index) && index >= 0 && index < bytes.length ? bytes[index] : undefined

const float32 = new Float32Array(1)
const float32Bytes = new Uint8Array(float32.buffer)
const float64 = new Float64Array(1)
const float64Bytes = new Uint8Array(float64.buffer)
const bigEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 0

export const bufferGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.Buffer
  const wrap = (bytes: Uint8Array) => new BufferObj(proto, bytes)
  const self = (thisValue: Value, name: string): Bytes => {
    if (thisValue instanceof Bytes) return thisValue
    throw typeError(`Buffer.prototype.${name} called on incompatible receiver ${describeValue(thisValue)}.`)
  }
  const allocate = (size: number) => {
    checkArrayLength(size)
    return new Uint8Array(size)
  }
  // Every method runs inside `withReads`: Node's error messages read `constructor.name`, which may be a program
  // getter. Each one checks everything before it changes anything, so it can run again once that getter has.
  const method = (name: string, length: number, call: NativeCall) =>
    fn(builtins, name, length, (thisValue, args, site) => withReads(() => call(thisValue, args, site)))

  const validateNumber = (value: Value, name: string, min?: number, max?: number) => {
    if (typeof value !== "number") throw invalidArgType(builtins, name, "number", value)
    if ((min !== undefined && value < min) || (max !== undefined && value > max) || Number.isNaN(value)) {
      if (min === undefined && max === undefined) return
      const range = `${min !== undefined ? `>= ${min}` : ""}${min !== undefined && max !== undefined ? " && " : ""}${max !== undefined ? `<= ${max}` : ""}`
      throw outOfRange(builtins, name, range, value)
    }
  }
  const validateInteger = (value: Value, name: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof value !== "number") throw invalidArgType(builtins, name, "number", value)
    if (!Number.isInteger(value)) throw outOfRange(builtins, name, "an integer", value)
    if (value < min || value > max) throw outOfRange(builtins, name, `>= ${min} && <= ${max}`, value)
    return value
  }
  const validateOffset = (value: Value, name: string, min = 0, max = kMaxLength) => validateInteger(value, name, min, max)

  /** getEncodingOps after `encoding += ""`: the encoding, or ERR_UNKNOWN_ENCODING naming `original`. */
  const encodingOps = (original: Value, converted: Value): Encoding => {
    const found = encodingOf(toText(converted))
    if (found === undefined) throw unknownEncoding(builtins, original, converted)
    return found
  }
  /** getEncodingOps for any value: objects are converted first, as `+= ""` does. */
  const withEncoding = (value: Value, body: (encoding: Encoding | undefined, converted: Value) => NativeResult) =>
    primitive("default", value, (converted) => body(encodingOf(toText(converted)), converted))
  /** normalizeEncoding: no conversion, `null`, `undefined` and `""` are UTF-8. */
  const normalizeEncoding = (value: Value): Encoding | undefined => {
    if (value === null || value === undefined || value === "") return "utf8"
    return typeof value === "string" ? encodingOf(value) : undefined
  }

  const decodeChecked = (bytes: Uint8Array, encoding: Encoding) => {
    checkStringLength(decodedLength(bytes.length, encoding))
    return decode(bytes, encoding)
  }
  const encodeChecked = (text: string, encoding: Encoding) => {
    // Only a long string can be over the limit; the exact length costs a pass, so short ones skip it.
    if (text.length * 3 > MAX_ARRAY_LENGTH) checkArrayLength(byteLength(text, encoding))
    return encode(text, encoding)
  }

  // Buffer.from and new Buffer.
  const fromString = (text: string, encoding: Value) => {
    const found =
      !encoding || encoding === "utf8" || typeof encoding !== "string" ? "utf8" : encodingOf(encoding)
    if (found === undefined) throw unknownEncoding(builtins, encoding)
    return wrap(text.length === 0 ? new Uint8Array() : encodeChecked(text, found))
  }
  const fromArrayBuffer = (source: ArrayBufferObj, offsetArg: Value, lengthArg: Value): NativeResult => {
    const available = source.data.byteLength
    return primitive("number", offsetArg, (offsetValue) => {
      const offset = offsetValue === undefined ? 0 : toNumber(offsetValue) || 0
      const maxLength = available - offset
      if (maxLength < 0) throw bufferOutOfBounds(builtins, "offset")
      return primitive("number", lengthArg, (lengthValue) => {
        let length: number | undefined
        if (lengthValue !== undefined) {
          length = toNumber(lengthValue)
          if (length > 0) {
            if (length > maxLength) throw bufferOutOfBounds(builtins, "length")
          } else length = 0
        }
        // new Uint8Array(buffer, offset, length): ToIndex on each.
        const start = Math.trunc(offset)
        if (start < 0) throw rangeError(`Start offset ${offset} is outside the bounds of the buffer`)
        const count = length === undefined ? available - start : Math.trunc(length)
        return new BufferObj(proto, new Uint8Array(source.data, start, count), source)
      })
    })
  }
  const fromNumbers = (values: ReadonlyArray<Value>) => {
    checkArrayLength(values.length)
    const bytes = new Uint8Array(values.length)
    for (let i = 0; i < values.length; i++) bytes[i] = toNumber(values[i])
    return wrap(bytes)
  }
  const valueOf = get(builtins.Object, "valueOf")
  const from = (value: Value, encodingOrOffset: Value, length: Value): NativeResult => {
    if (typeof value === "string") return fromString(value, encodingOrOffset)
    if (value instanceof ArrayBufferObj) return fromArrayBuffer(value, encodingOrOffset, length)
    if (value instanceof Obj) {
      return withReads(() => {
        // Node calls `valueOf` and reads the object's fields; only the common shapes, with nothing a program
        // changed, are read here, and the prelude does the rest as Node's code would.
        if (get(value, "valueOf") === valueOf && !value.hasProgramAccessors) {
          if (value instanceof Bytes) return wrap(value.bytes.slice())
          if (value instanceof Arr && value.items.every((item) => !(item instanceof Obj))) return fromNumbers(value.items)
        }
        return new Invoke(ctx.prelude.fn("bufferFromObject"), undefined, [value, encodingOrOffset, length], undefined)
      })
    }
    return invalidFrom(builtins, value)
  }
  const construct = (args: Array<Value>): NativeResult => {
    const arg = args[0]
    if (typeof arg === "number") {
      if (typeof args[1] === "string") throw invalidArgType(builtins, "string", "string", arg)
      return alloc(arg, undefined, undefined)
    }
    return from(arg, args[1], args[2])
  }
  const buffer = constructor(builtins, proto, {
    name: "Buffer",
    length: 3,
    call: (_, args) => withReads(() => construct(args)),
    construct: (args) => withReads(() => construct(args)),
  })
  // Buffer's statics inherit Uint8Array's (fromHex, fromBase64, BYTES_PER_ELEMENT), which globals makes first.
  const uint8Array = get(builtins.Uint8Array, "constructor")
  if (uint8Array instanceof Obj) buffer.proto = uint8Array

  const alloc = (size: Value, fill: Value, encoding: Value): NativeResult => {
    validateNumber(size, "size", 0, kMaxLength)
    const bytes = allocate(size as number)
    const target = wrap(bytes)
    if (fill !== undefined && fill !== 0 && bytes.length > 0) return fillBytes(target, fill, 0, bytes.length, encoding)
    return target
  }

  const statics: ReadonlyArray<readonly [string, number, NativeCall]> = [
    ["from", 3, (_, args) => from(args[0], args[1], args[2])],
    [
      "copyBytesFrom",
      3,
      (_, args) => {
        const view = args[0]
        if (!(view instanceof Bytes)) throw invalidArgType(builtins, "view", ["TypedArray"], view)
        const length = view.bytes.length
        if (length === 0) return wrap(new Uint8Array())
        let start = 0
        let end = length
        if (args[1] !== undefined) {
          start = validateInteger(args[1], "offset", 0)
          if (start >= length) return wrap(new Uint8Array())
        }
        if (args[2] !== undefined) end = Math.min(start + validateInteger(args[2], "length", 0), length)
        if (end <= start) return wrap(new Uint8Array())
        return wrap(view.bytes.slice(start, end))
      },
    ],
    [
      "of",
      0,
      (_, args) => withPrimitives("number", args, (values) => fromNumbers(values)),
    ],
    ["alloc", 3, (_, args) => alloc(args[0], args[1], args[2])],
    [
      "allocUnsafe",
      1,
      (_, args) => {
        validateNumber(args[0], "size", 0, kMaxLength)
        return wrap(allocate(args[0] as number))
      },
    ],
    [
      "allocUnsafeSlow",
      1,
      (_, args) => {
        validateNumber(args[0], "size", 0, kMaxLength)
        return wrap(allocate(args[0] as number))
      },
    ],
    ["isBuffer", 1, (_, args) => hasPrototype(args[0], proto)],
    [
      "compare",
      2,
      (_, args) => {
        const [a, b] = args
        if (!(a instanceof Bytes)) throw invalidArgType(builtins, "buf1", ["Buffer", "Uint8Array"], a)
        if (!(b instanceof Bytes)) throw invalidArgType(builtins, "buf2", ["Buffer", "Uint8Array"], b)
        if (a === b) return 0
        return compareBytes(a.bytes, b.bytes)
      },
    ],
    [
      "isEncoding",
      1,
      (_, args) => typeof args[0] === "string" && args[0].length !== 0 && normalizeEncoding(args[0]) !== undefined,
    ],
    [
      "concat",
      2,
      (_, args) =>
        withReads(() => {
          const list = args[0]
          if (!(list instanceof Arr)) throw invalidArgType(builtins, "list", "Array", list)
          const items = list.items
          if (items.length === 0) return wrap(new Uint8Array())
          // A given length is checked before the items.
          if (args[1] !== undefined) validateOffset(args[1], "length")
          const parts = items.map((item, index) => {
            if (item instanceof Bytes) return item.bytes
            throw invalidArgType(builtins, `list[${index}]`, ["Buffer", "Uint8Array"], item)
          })
          const length = args[1] === undefined ? parts.reduce((sum, part) => sum + part.length, 0) : (args[1] as number)
          const joined = allocate(length)
          let position = 0
          for (const part of parts) {
            if (position + part.length > length) {
              joined.set(part.subarray(0, length - position), position)
              break
            }
            joined.set(part, position)
            position += part.length
          }
          return wrap(joined)
        }),
    ],
    [
      "byteLength",
      2,
      (_, args) => {
        const [text, encoding] = args
        if (typeof text !== "string") {
          if (text instanceof Bytes) return text.bytes.byteLength
          if (text instanceof ArrayBufferObj) return text.data.byteLength
          throw invalidArgType(builtins, "string", ["string", "Buffer", "ArrayBuffer"], text)
        }
        if (text.length === 0) return 0
        if (!encoding || encoding === "utf8") return byteLength(text, "utf8")
        if (encoding === "ascii") return text.length
        // An unknown encoding counts as UTF-8.
        return withEncoding(encoding, (found) => byteLength(text, found ?? "utf8"))
      },
    ],
  ]
  define(buffer, "poolSize", 8192, enumerable)
  for (const [name, length, call] of statics) define(buffer, name, method(name, length, call), enumerable)

  // Buffer.prototype.fill, and Buffer.alloc's fill.
  const fillBytes = (target: Bytes, value: Value, offsetArg: Value, endArg: Value, encodingArg: Value): NativeResult => {
    // Node reads `buf.length` here, so a length the program defined on the buffer is what it checks against.
    if (own(target, "length") !== undefined) {
      return withReads(() => fillWithin(target, get(target, "length"), value, offsetArg, endArg, encodingArg))
    }
    return fillWithin(target, target.bytes.length, value, offsetArg, endArg, encodingArg)
  }
  const fillWithin = (
    target: Bytes,
    size: Value,
    value: Value,
    offsetArg: Value,
    endArg: Value,
    encodingArg: Value,
  ): NativeResult => {
    const bytes = target.bytes
    let offset = offsetArg
    let end = endArg
    let encoding: Encoding | undefined
    let fill = value
    if (typeof fill === "string") {
      let name = encodingArg
      if (offset === undefined || typeof offset === "string") {
        name = offset
        offset = 0
        end = size
      } else if (typeof end === "string") {
        name = end
        end = size
      }
      encoding = normalizeEncoding(name)
      if (encoding === undefined) {
        if (typeof name !== "string") throw invalidArgType(builtins, "encoding", "string", name)
        throw unknownEncoding(builtins, name)
      }
      if (fill.length === 0) fill = 0
      else if (fill.length === 1) {
        const code = fill.charCodeAt(0)
        if ((encoding === "utf8" || encoding === "ascii") && code < 128) fill = code
        else if (encoding === "latin1") fill = code
      }
    }
    let start: number
    let stop: Value
    if (offset === undefined) {
      start = 0
      stop = size
    } else {
      start = validateOffset(offset, "offset")
      stop = end === undefined ? size : validateOffset(end, "end", 0, size as number)
      if (start >= (stop as number)) return target
    }
    if (typeof stop !== "number" || start > stop || stop > bytes.length) throw bufferOutOfBounds(builtins)
    if (typeof fill === "number") {
      bytes.fill(fill, start, stop)
      return target
    }
    if (typeof fill === "string") {
      const room = stop - start
      const region = bytes.subarray(start, stop)
      // UTF-8 and UTF-16LE are copied whole (cut where the fill ends); the others are written as `write` would.
      // UTF-8 and UTF-16LE count their whole length, even past the room they have.
      const written =
        encoding === "utf8" || encoding === "utf16le"
          ? copyPattern(region, encode(fill, encoding))
          : write(region, fill, encoding!)
      if (written >= room) return target
      if (written === 0) throw invalidArgValue(builtins, "value", value)
      repeat(region, written, room)
      return target
    }
    if (fill instanceof Bytes) {
      const region = bytes.subarray(start, stop)
      if (fill.bytes.length >= region.length) {
        region.set(fill.bytes.subarray(0, region.length))
        return target
      }
      if (fill.bytes.length === 0) throw invalidArgValue(builtins, "value", fill)
      const written = copyPattern(region, fill.bytes.slice())
      repeat(region, written, region.length)
      return target
    }
    // Anything else is converted to a number (Uint32Value) and its low byte fills.
    return primitive("number", fill, (number) => {
      bytes.fill(toNumber(number) & 255, start, stop)
      return target
    })
  }

  // Buffer.prototype.toString, and toLocaleString, which is the same function.
  const toStringMethod = method("toString", 3, (thisValue, args) => {
    const bytes = self(thisValue, "toString").bytes
    if (args.length === 0) return decodeChecked(bytes, "utf8")
    const length = bytes.length
    return primitive("number", args[1], (startValue) => {
      let start: number
      if (typeof startValue === "symbol") toNumber(startValue)
      if ((startValue as number) <= 0) start = 0
      else if ((startValue as number) >= length) return ""
      else start = Math.trunc(toNumber(startValue)) || 0
      return primitive("number", args[2], (endValue) => {
        let end: number
        if (typeof endValue === "symbol") toNumber(endValue)
        if (endValue === undefined || (endValue as number) > length) end = length
        else end = Math.trunc(toNumber(endValue)) || 0
        if (end <= start) return ""
        if (args[0] === undefined) return decodeChecked(bytes.subarray(start, end), "utf8")
        return primitive("default", args[0], (converted) =>
          decodeChecked(bytes.subarray(start, end), encodingOps(args[0], converted)),
        )
      })
    })
  })

  const viewOf = (thisValue: Value, args: Array<Value>, name: string): NativeResult => {
    const target = self(thisValue, name)
    const length = target.bytes.length
    return withPrimitives("number", [args[0], args[1]], ([startValue, endValue]) => {
      const start = adjustOffset(toNumber(startValue), length)
      const end = endValue !== undefined ? adjustOffset(toNumber(endValue), length) : length
      return new BufferObj(
        proto,
        new Uint8Array(target.memory, target.bytes.byteOffset + start, end > start ? end - start : 0),
        target.bufferObj(builtins),
      )
    })
  }

  // Finds the first index of `value` at or after `byteOffset`, or the last at or before it (bidirectionalIndexOf).
  const indexOf = (thisValue: Value, args: Array<Value>, forward: boolean): NativeResult => {
    if (!(thisValue instanceof Bytes)) {
      throw invalidArgType(builtins, "buffer", ["Buffer", "TypedArray", "DataView"], thisValue)
    }
    const bytes = thisValue.bytes
    const value = args[0]
    let encodingArg = args[2]
    let offsetArg = args[1]
    if (typeof offsetArg === "string") {
      encodingArg = offsetArg
      offsetArg = undefined
    }
    return primitive("number", offsetArg, (offsetValue) => {
      if (typeof offsetValue === "symbol") toNumber(offsetValue)
      let offset = offsetValue as number
      if (offset > 0x7fffffff) offset = 0x7fffffff
      else if (offset < -0x80000000) offset = -0x80000000
      offset = toNumber(offset)
      if (Number.isNaN(offset)) offset = forward ? 0 : bytes.length
      // The binding takes it as an int64, so -0 is 0.
      offset = Math.trunc(offset) || 0
      if (typeof value === "number") return indexOfByte(bytes, (value >>> 0) & 0xff, offset, forward)
      const search = (encoding: Encoding | undefined, converted: Value): NativeResult => {
        if (typeof value === "string") {
          if (encoding === undefined) throw unknownEncoding(builtins, encodingArg, converted)
          return indexOfString(bytes, value, offset, encoding, forward)
        }
        if (value instanceof Bytes) return indexOfBytes(bytes, value.bytes, offset, encoding === "utf16le", forward)
        throw invalidArgType(builtins, "value", ["number", "string", "Buffer", "Uint8Array"], value)
      }
      if (encodingArg === undefined) return search("utf8", undefined)
      return withEncoding(encodingArg, search)
    })
  }

  // The `*Slice` and `*Write` methods Node's prototype has for each encoding.
  const parseIndex = (value: Value, fallback: number): number => {
    if (value === undefined) return fallback
    const index = Math.trunc(toNumber(value)) || 0
    if (index < 0) throw nodeError(builtins, "RangeError", "ERR_OUT_OF_RANGE", "Index out of range")
    return index
  }
  const sliceMethod = (encoding: Encoding): NativeCall => (thisValue, args) => {
    const bytes = self(thisValue, `${encoding}Slice`).bytes
    if (bytes.length === 0) return ""
    return withPrimitives("number", [args[0], args[1]], ([startValue, endValue]) => {
      const start = parseIndex(startValue, 0)
      let end = parseIndex(endValue, bytes.length)
      if (end < start) end = start
      if (end > bytes.length) throw nodeError(builtins, "RangeError", "ERR_OUT_OF_RANGE", "Index out of range")
      return decodeChecked(bytes.subarray(start, end), encoding)
    })
  }
  /** The binding's StringWrite: the string, then the offset and length as indexes. */
  const writeString = (bytes: Uint8Array, text: Value, offsetValue: Value, lengthValue: Value, encoding: Encoding) => {
    if (typeof text !== "string") throw nodeError(builtins, "TypeError", "ERR_INVALID_ARG_TYPE", "argument must be a string")
    const offset = parseIndex(offsetValue, 0)
    if (offset > bytes.length) throw bufferOutOfBounds(builtins, "offset")
    const length = Math.min(bytes.length - offset, parseIndex(lengthValue, bytes.length - offset))
    if (length === 0) return 0
    return write(bytes.subarray(offset, offset + length), text, encoding)
  }
  const writeMethod = (encoding: Encoding, checked: boolean): NativeCall => (thisValue, args) => {
    const bytes = self(thisValue, `${encoding}Write`).bytes
    return withPrimitives("number", [args[1], args[2]], ([offsetValue, lengthValue]) => {
      // The ascii, latin1 and utf8 methods check their bounds in JS first.
      if (checked) {
        const offset = offsetValue === undefined ? 0 : (offsetValue as number)
        // `buf.byteLength - offset`, as the default length and in the check below.
        const remaining = () => {
          if (typeof offset === "bigint") throw typeError("Cannot mix BigInt and other types, use explicit conversions")
          return bytes.length - toNumber(offset)
        }
        const length = lengthValue === undefined ? remaining() : (lengthValue as number)
        if (typeof offset === "symbol") toNumber(offset)
        if (offset < 0 || offset > bytes.length) throw bufferOutOfBounds(builtins, "offset")
        if (typeof length === "symbol") toNumber(length)
        if (length < 0 || length > remaining()) throw bufferOutOfBounds(builtins, "length")
        return writeString(bytes, args[0], offset, length, encoding)
      }
      return writeString(bytes, args[0], offsetValue, lengthValue, encoding)
    })
  }

  // Read and write numbers (lib/internal/buffer.js).
  const boundsError = (value: number, length: number, type?: string): never => {
    if (Math.floor(value) !== value) {
      if (typeof value !== "number") throw invalidArgType(builtins, type ?? "undefined", "number", value)
      throw outOfRange(builtins, type ?? "offset", "an integer", value)
    }
    if (length < 0) throw bufferOutOfBounds(builtins)
    throw outOfRange(builtins, type ?? "offset", `>= ${type ? 1 : 0} and <= ${length}`, value)
  }
  /** checkBounds: validateNumber(offset), then the first and last byte must exist. */
  const checkBounds = (bytes: Uint8Array, offset: Value, width: number): number => {
    if (typeof offset !== "number") throw invalidArgType(builtins, "offset", "number", offset)
    if (at(bytes, offset) === undefined || at(bytes, offset + width - 1) === undefined) {
      boundsError(offset, bytes.length - width)
    }
    return offset
  }
  const readInteger = (bytes: Uint8Array, offset: number, width: number, little: boolean, signed: boolean) => {
    let value = 0
    for (let i = 0; i < width; i++) value = value * 256 + bytes[offset + (little ? width - 1 - i : i)]!
    return signed && value >= 2 ** (width * 8 - 1) ? value - 2 ** (width * 8) : value
  }
  const integerReader =
    (width: number, little: boolean, signed: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "read").bytes
      return readInteger(bytes, checkBounds(bytes, args[0] === undefined ? 0 : args[0], width), width, little, signed)
    }
  const variableReader =
    (little: boolean, signed: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "read").bytes
      const offset = args[0]
      const width = args[1]
      if (offset === undefined) throw invalidArgType(builtins, "offset", "number", offset)
      if (width === 1 || width === 2 || width === 3 || width === 4 || width === 5 || width === 6) {
        return readInteger(bytes, checkBounds(bytes, offset, width), width, little, signed)
      }
      return boundsError(width as number, 6, "byteLength")
    }
  const floatReader =
    (width: 4 | 8, little: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "read").bytes
      const offset = checkBounds(bytes, args[0] === undefined ? 0 : args[0], width)
      const scratch = width === 4 ? float32Bytes : float64Bytes
      const reversed = little === bigEndianHost
      for (let i = 0; i < width; i++) scratch[reversed ? width - 1 - i : i] = bytes[offset + i]!
      return width === 4 ? float32[0]! : float64[0]!
    }
  const bigReader =
    (little: boolean, signed: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "read").bytes
      const offset = checkBounds(bytes, args[0] === undefined ? 0 : args[0], 8)
      let value = 0n
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(bytes[offset + (little ? 7 - i : i)]!)
      return signed ? BigInt.asIntN(64, value) : value
    }

  /** checkInt's range, for a value outside `min`..`max` that is `width` bytes wide. */
  const rangeOf = (min: number | bigint, max: number | bigint, width: number) => {
    const n = typeof min === "bigint" ? "n" : ""
    if (width <= 4) return `>= ${min}${n} and <= ${max}${n}`
    if (min === 0 || min === 0n) return `>= 0${n} and < 2${n} ** ${width * 8}${n}`
    return `>= -(2${n} ** ${width * 8 - 1}${n}) and < 2${n} ** ${width * 8 - 1}${n}`
  }
  const bounds = (width: number, signed: boolean) =>
    signed ? ([-(2 ** (width * 8 - 1)), 2 ** (width * 8 - 1) - 1] as const) : ([0, 2 ** (width * 8) - 1] as const)
  const writeInteger = (
    bytes: Uint8Array,
    value: number,
    offsetArg: Value,
    width: number,
    little: boolean,
    min: number,
    max: number,
  ) => {
    if (width === 1) {
      // A single byte's offset is checked before its value.
      if (typeof offsetArg !== "number") throw invalidArgType(builtins, "offset", "number", offsetArg)
      if (value > max || value < min) throw outOfRange(builtins, "value", `>= ${min} and <= ${max}`, value)
      if (at(bytes, offsetArg) === undefined) boundsError(offsetArg, bytes.length - 1)
      bytes[offsetArg] = value
      return offsetArg + 1
    }
    if (value > max || value < min) throw outOfRange(builtins, "value", rangeOf(min, max, width), value)
    const offset = checkBounds(bytes, offsetArg, width)
    // As Node stores them: the low 32 bits a byte at a time, then the bits above them.
    let low = value
    for (let i = 0; i < Math.min(width, 4); i++) {
      bytes[offset + (little ? i : width - 1 - i)] = low
      low = low >>> 8
    }
    let high = Math.floor(value * 2 ** -32)
    for (let i = 4; i < width; i++) {
      bytes[offset + (little ? i : width - 1 - i)] = high
      high = high >>> 8
    }
    return offset + width
  }
  const integerWriter =
    (width: number, little: boolean, signed: boolean): NativeCall => {
      const [min, max] = bounds(width, signed)
      return (thisValue, args) => {
        const bytes = self(thisValue, "write").bytes
        return primitive("number", args[0], (value) =>
          writeInteger(bytes, toNumber(value), args[1] === undefined ? 0 : args[1], width, little, min, max),
        )
      }
    }
  const variableWriter =
    (little: boolean, signed: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "write").bytes
      const width = args[2]
      if (width === 1 || width === 2 || width === 3 || width === 4 || width === 5 || width === 6) {
        const [min, max] = bounds(width, signed)
        // The offset is passed on as given, without a default.
        return primitive("number", args[0], (value) => writeInteger(bytes, toNumber(value), args[1], width, little, min, max))
      }
      return boundsError(width as number, 6, "byteLength")
    }
  const floatWriter =
    (width: 4 | 8, little: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "write").bytes
      return primitive("number", args[0], (value) => {
        const number = toNumber(value)
        const offset = checkBounds(bytes, args[1] === undefined ? 0 : args[1], width)
        const scratch = width === 4 ? float32Bytes : float64Bytes
        if (width === 4) float32[0] = number
        else float64[0] = number
        const reversed = little === bigEndianHost
        for (let i = 0; i < width; i++) bytes[offset + i] = scratch[reversed ? width - 1 - i : i]!
        return offset + width
      })
    }
  const bigWriter =
    (little: boolean, signed: boolean): NativeCall =>
    (thisValue, args) => {
      const bytes = self(thisValue, "write").bytes
      const min = signed ? -0x8000000000000000n : 0n
      const max = signed ? 0x7fffffffffffffffn : 0xffffffffffffffffn
      return primitive("number", args[0], (value) => {
        if (typeof value === "symbol") toNumber(value)
        // The range check compares any primitive; only the masking needs a BigInt.
        const compared = value as bigint
        if (compared > max || compared < min) throw outOfRange(builtins, "value", rangeOf(min, max, 8), value)
        const offset = checkBounds(bytes, args[1] === undefined ? 0 : args[1], 8)
        if (typeof value !== "bigint") throw typeError("Cannot mix BigInt and other types, use explicit conversions")
        let rest = BigInt.asUintN(64, value)
        for (let i = 0; i < 8; i++) {
          bytes[offset + (little ? i : 7 - i)] = Number(rest & 0xffn)
          rest >>= 8n
        }
        return offset + 8
      })
    }

  const copy: NativeCall = (thisValue, args) => {
    if (!(thisValue instanceof Bytes)) throw invalidArgType(builtins, "source", ["Buffer", "Uint8Array"], thisValue)
    const source = thisValue.bytes
    const target = args[0]
    if (!(target instanceof Bytes)) throw invalidArgType(builtins, "target", ["Buffer", "Uint8Array"], target)
    const destination = target.bytes
    // toInteger: an integer as it is, anything else through `+value`, a default where that isn't a safe integer.
    return withPrimitives("number", [args[1], args[2], args[3]], ([targetValue, startValue, endValue]) => {
      const integer = (value: Value) => {
        if (Number.isInteger(value)) return value as number
        const number = toNumber(value)
        if (Number.isNaN(number) || number < Number.MIN_SAFE_INTEGER || number > Number.MAX_SAFE_INTEGER) return 0
        return number % 1 === 0 ? number : Math.floor(number)
      }
      const targetStart = targetValue === undefined ? 0 : integer(targetValue)
      if (targetStart < 0) throw outOfRange(builtins, "targetStart", ">= 0", targetStart)
      const sourceStart = startValue === undefined ? 0 : integer(startValue)
      if (sourceStart < 0 || sourceStart > source.length) {
        throw outOfRange(builtins, "sourceStart", `>= 0 && <= ${source.length}`, sourceStart)
      }
      let sourceEnd = endValue === undefined ? source.length : integer(endValue)
      if (sourceEnd < 0) throw outOfRange(builtins, "sourceEnd", ">= 0", sourceEnd)
      if (targetStart >= destination.length || sourceStart >= sourceEnd) return 0
      if (sourceEnd - sourceStart > destination.length - targetStart) sourceEnd = sourceStart + destination.length - targetStart
      const count = Math.min(sourceEnd - sourceStart, source.length - sourceStart)
      if (count <= 0) return 0
      // `set` copies as memmove does when the two overlap.
      destination.set(source.subarray(sourceStart, sourceStart + count), targetStart)
      return count
    })
  }

  const compare: NativeCall = (thisValue, args) => {
    const source = self(thisValue, "compare").bytes
    const target = args[0]
    if (!(target instanceof Bytes)) throw invalidArgType(builtins, "target", ["Buffer", "Uint8Array"], target)
    const other = target.bytes
    if (args.length === 1) return compareBytes(source, other)
    const targetStart = args[1] === undefined ? 0 : validateOffset(args[1], "targetStart")
    const targetEnd = args[2] === undefined ? other.length : validateOffset(args[2], "targetEnd", 0, other.length)
    const sourceStart = args[3] === undefined ? 0 : validateOffset(args[3], "sourceStart")
    const sourceEnd = args[4] === undefined ? source.length : validateOffset(args[4], "sourceEnd", 0, source.length)
    if (sourceStart >= sourceEnd) return targetStart >= targetEnd ? 0 : -1
    if (targetStart >= targetEnd) return 1
    if (sourceStart > source.length) {
      throw nodeError(builtins, "RangeError", "ERR_OUT_OF_RANGE", 'The value of "sourceStart" is out of range.')
    }
    if (targetStart > other.length) {
      throw nodeError(builtins, "RangeError", "ERR_OUT_OF_RANGE", 'The value of "targetStart" is out of range.')
    }
    const count = Math.min(sourceEnd - sourceStart, targetEnd - targetStart, source.length - sourceStart)
    const order = compareRange(source, sourceStart, other, targetStart, count)
    if (order !== 0) return order
    const sourceLength = sourceEnd - sourceStart
    const targetLength = targetEnd - targetStart
    return sourceLength > targetLength ? 1 : sourceLength < targetLength ? -1 : 0
  }

  const swap =
    (width: 2 | 4 | 8): NativeCall =>
    (thisValue) => {
      const bytes = self(thisValue, `swap${width * 8}`).bytes
      if (bytes.length % width !== 0) throw invalidBufferSize(builtins, `${width * 8}-bits`)
      for (let i = 0; i < bytes.length; i += width) bytes.subarray(i, i + width).reverse()
      return thisValue
    }

  const inspect: NativeCall = (thisValue) =>
    withReads(() => {
      const bytes = self(thisValue, "inspect").bytes
      const shown = Array.from(bytes.subarray(0, 50), (byte) => byte.toString(16).padStart(2, "0")).join(" ")
      const remaining = bytes.length - 50
      const constructor = get(thisValue as Obj, "constructor")
      const slot = constructor instanceof Obj ? own(constructor, "name") : undefined
      const name = slot !== undefined && "value" in slot ? slot.value : get(constructor as Obj, "name")
      return `<${slot === undefined ? "Buffer" : String(name)} ${shown}${remaining > 0 ? ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}` : ""}>`
    })

  type Entry = readonly [key: string, name: string, length: number, call: NativeCall] | readonly [key: string, alias: string]
  const ends = [
    ["LE", true],
    ["BE", false],
  ] as const
  const table: Array<Entry> = [
    ...ends.map(([end, little]): Entry => [`readBigUInt64${end}`, `readBigUInt64${end}`, 0, bigReader(little, false)]),
    ...ends.map(([end]): Entry => [`readBigUint64${end}`, `readBigUInt64${end}`]),
    ...ends.map(([end, little]): Entry => [`readBigInt64${end}`, `readBigInt64${end}`, 0, bigReader(little, true)]),
    ...ends.map(([end, little]): Entry => [`writeBigUInt64${end}`, `writeBigUInt64${end}`, 1, bigWriter(little, false)]),
    ...ends.map(([end]): Entry => [`writeBigUint64${end}`, `writeBigUInt64${end}`]),
    ...ends.map(([end, little]): Entry => [`writeBigInt64${end}`, `writeBigInt64${end}`, 1, bigWriter(little, true)]),
    ...(["UInt", "Uint", "Int"] as const).flatMap((kind): Array<Entry> => {
      const signed = kind === "Int"
      const fixed = (width: number, end: string, little: boolean): Entry =>
        kind === "Uint"
          ? [`read${kind}${width * 8}${width === 1 ? "" : end}`, `readUInt${width * 8}${width === 1 ? "" : end}`]
          : [`read${kind}${width * 8}${width === 1 ? "" : end}`, "", 1, integerReader(width, little, signed)]
      return [
        kind === "Uint" ? ["readUintLE", "readUIntLE"] : [`read${kind}LE`, `read${kind}LE`, 2, variableReader(true, signed)],
        fixed(4, "LE", true),
        fixed(2, "LE", true),
        fixed(1, "", true),
        kind === "Uint" ? ["readUintBE", "readUIntBE"] : [`read${kind}BE`, `read${kind}BE`, 2, variableReader(false, signed)],
        fixed(4, "BE", false),
        fixed(2, "BE", false),
      ]
    }),
    ...(["UInt", "Uint", "Int"] as const).flatMap((kind): Array<Entry> => {
      const signed = kind === "Int"
      const fixed = (width: number, end: string, little: boolean): Entry => {
        const suffix = `${width * 8}${width === 1 ? "" : end}`
        return kind === "Uint"
          ? [`write${kind}${suffix}`, `writeUInt${suffix}`]
          : [`write${kind}${suffix}`, `write${kind}${suffix}`, 1, integerWriter(width, little, signed)]
      }
      return [
        kind === "Uint" ? ["writeUintLE", "writeUIntLE"] : [`write${kind}LE`, `write${kind}LE`, 3, variableWriter(true, signed)],
        fixed(4, "LE", true),
        fixed(2, "LE", true),
        fixed(1, "", true),
        kind === "Uint" ? ["writeUintBE", "writeUIntBE"] : [`write${kind}BE`, `write${kind}BE`, 3, variableWriter(false, signed)],
        fixed(4, "BE", false),
        fixed(2, "BE", false),
      ]
    }),
    // Node names the float methods by whether they match the host's byte order.
    ...(["Float", "Double"] as const).flatMap((kind) =>
      ends.map(([end, little]): Entry => [
        `read${kind}${end}`,
        `read${kind}${little === !bigEndianHost ? "Forwards" : "Backwards"}`,
        0,
        floatReader(kind === "Float" ? 4 : 8, little),
      ]),
    ),
    ...(["Float", "Double"] as const).flatMap((kind) =>
      ends.map(([end, little]): Entry => [
        `write${kind}${end}`,
        `write${kind}${little === !bigEndianHost ? "Forwards" : "Backwards"}`,
        1,
        floatWriter(kind === "Float" ? 4 : 8, little),
      ]),
    ),
    ...sliceEncodings.map(([prefix, encoding]): Entry => [`${prefix}Slice`, "", 2, sliceMethod(encoding)]),
    ...sliceEncodings.map(([prefix, encoding]): Entry => [
      `${prefix}Write`,
      "",
      3,
      writeMethod(encoding, prefix === "ascii" || prefix === "latin1" || prefix === "utf8"),
    ]),
  ]
  const made = new Map<string, Value>()
  for (const entry of table) {
    const value = entry.length === 2 ? made.get(entry[1])! : method(entry[1], entry[2], entry[3])
    made.set(entry[0], value)
    define(proto, entry[0], value, enumerable)
  }
  const isBufferView = (thisValue: Value) => hasPrototype(thisValue, proto)
  defineAccessor(proto, "parent", (thisValue) =>
    isBufferView(thisValue) ? self(thisValue, "parent").bufferObj(builtins) : undefined,
  )
  defineAccessor(proto, "offset", (thisValue) =>
    isBufferView(thisValue) ? self(thisValue, "offset").bytes.byteOffset : undefined,
  )
  for (const key of ["parent", "offset"]) {
    const slot = own(proto, key)
    if (slot !== undefined) slot.enumerable = true
  }
  const later: ReadonlyArray<readonly [string, number, NativeCall]> = [
    ["copy", 4, copy],
  ]
  for (const [name, length, call] of later) define(proto, name, method(name, length, call), enumerable)
  define(proto, "toString", toStringMethod, enumerable)
  const rest: ReadonlyArray<readonly [string, number, NativeCall]> = [
    [
      "equals",
      1,
      (thisValue, args) => {
        const bytes = self(thisValue, "equals").bytes
        const other = args[0]
        if (!(other instanceof Bytes)) throw invalidArgType(builtins, "otherBuffer", ["Buffer", "Uint8Array"], other)
        if (thisValue === other) return true
        if (bytes.length !== other.bytes.length) return false
        return bytes.length === 0 || compareBytes(bytes, other.bytes) === 0
      },
    ],
    ["inspect", 2, inspect],
    ["compare", 5, compare],
    ["indexOf", 3, (thisValue, args) => indexOf(thisValue, args, true)],
    ["lastIndexOf", 3, (thisValue, args) => indexOf(thisValue, args, false)],
    [
      "includes",
      3,
      (thisValue, args) => {
        const found = indexOf(thisValue, args, true)
        return typeof found === "number" ? found !== -1 : found
      },
    ],
    ["fill", 4, (thisValue, args) => fillBytes(self(thisValue, "fill"), args[0], args[1], args[2], args[3])],
    ["write", 4, writeMethodMain],
    [
      "toJSON",
      0,
      (thisValue) => {
        const bytes = self(thisValue, "toJSON").bytes
        checkArrayLength(bytes.length)
        return record(builtins.Object, { type: "Buffer", data: new Arr(builtins.Array, Array.from(bytes)) })
      },
    ],
    ["subarray", 2, (thisValue, args) => viewOf(thisValue, args, "subarray")],
    // Node's slice calls `this.subarray`, so on a plain Uint8Array it makes a Uint8Array.
    [
      "slice",
      2,
      (thisValue, args) =>
        withReads(() => {
          const target = thisValue instanceof Obj ? thisValue : primitivePrototype(builtins, thisValue)
          if (target === undefined) throw typeError("Cannot read properties of undefined (reading 'subarray')")
          return new Invoke(get(target, "subarray", thisValue), thisValue, [args[0], args[1]], undefined)
        }),
    ],
    ["swap16", 0, swap(2)],
    ["swap32", 0, swap(4)],
    ["swap64", 0, swap(8)],
  ]
  for (const [name, length, call] of rest) define(proto, name, method(name, length, call), enumerable)
  define(proto, "toLocaleString", toStringMethod, enumerable)
  return buffer

  // Buffer.prototype.write(string[, offset[, length]][, encoding])
  function writeMethodMain(thisValue: Value, args: Array<Value>): NativeResult {
    const bytes = self(thisValue, "write").bytes
    const text = args[0]
    let offset = args[1]
    let length = args[2]
    let encoding = args[3]
    const length_ = bytes.length
    if (offset === undefined) return writeString(bytes, text, 0, length_, "utf8")
    if (length === undefined && typeof offset === "string") {
      encoding = offset
      length = length_
      offset = 0
    } else {
      validateOffset(offset, "offset", 0, length_)
      const remaining = length_ - (offset as number)
      if (length === undefined) length = remaining
      else if (typeof length === "string") {
        encoding = length
        length = remaining
      } else {
        validateOffset(length, "length", 0, length_)
        if ((length as number) > remaining) length = remaining
      }
    }
    if (!encoding || encoding === "utf8") return writeString(bytes, text, offset, length, "utf8")
    if (encoding === "ascii") return writeString(bytes, text, offset, length, "ascii")
    const name = encoding
    return primitive("default", name, (converted) => writeString(bytes, text, offset, length, encodingOps(name, converted)))
  }
}

const sliceEncodings = [
  ["ascii", "ascii"],
  ["base64", "base64"],
  ["base64url", "base64url"],
  ["latin1", "latin1"],
  ["hex", "hex"],
  ["ucs2", "utf16le"],
  ["utf8", "utf8"],
] as const

/** adjustOffset: Buffer's slice and subarray clamp their bounds into the buffer, and NaN is 0. */
const adjustOffset = (value: number, length: number) => {
  const offset = Math.trunc(value)
  if (offset === 0) return 0
  if (offset < 0) return Math.max(offset + length, 0)
  if (offset < length) return offset
  return Number.isNaN(offset) ? 0 : length
}

/** The order of two byte ranges' first `count` bytes. */
const compareRange = (a: Uint8Array, aStart: number, b: Uint8Array, bStart: number, count: number) => {
  let i = 0
  // Where both line up on four bytes, equal runs are skipped a word at a time.
  const aAt = a.byteOffset + aStart
  const bAt = b.byteOffset + bStart
  const width = count < 64 ? 0 : aAt % 8 === bAt % 8 ? 8 : aAt % 4 === bAt % 4 ? 4 : 0
  if (width > 0) {
    while (i < count && (aAt + i) % width !== 0 && a[aStart + i] === b[bStart + i]) i++
    const words = (aAt + i) % width === 0 ? Math.floor((count - i) / width) : 0
    if (words > 0) i += width === 8 ? equalDoubles(a, aAt + i, b, bAt + i, words) : equalWords(a, aAt + i, b, bAt + i, words)
  }
  for (; i < count; i++) {
    const x = a[aStart + i]!
    const y = b[bStart + i]!
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** How many leading bytes of `words` eight-byte words at byte offsets `aAt` and `bAt` of the two buffers are equal. */
const equalDoubles = (a: Uint8Array, aAt: number, b: Uint8Array, bAt: number, words: number) => {
  const aWords = new Float64Array(a.buffer as ArrayBuffer, aAt, words)
  const bWords = new Float64Array(b.buffer as ArrayBuffer, bAt, words)
  const aBytes = new Uint8Array(a.buffer as ArrayBuffer, aAt, words * 8)
  const bBytes = new Uint8Array(b.buffer as ArrayBuffer, bAt, words * 8)
  let w = 0
  // A NaN is unequal even to the same bits, so a word that compares unequal is checked byte by byte.
  while (w < words && (aWords[w] === bWords[w] || sameBytes(aBytes, bBytes, w * 8, 8))) w++
  return w * 8
}

const equalWords = (a: Uint8Array, aAt: number, b: Uint8Array, bAt: number, words: number) => {
  const aWords = new Uint32Array(a.buffer as ArrayBuffer, aAt, words)
  const bWords = new Uint32Array(b.buffer as ArrayBuffer, bAt, words)
  let w = 0
  while (w < words && aWords[w] === bWords[w]) w++
  return w * 4
}

const sameBytes = (a: Uint8Array, b: Uint8Array, start: number, count: number) => {
  for (let i = start; i < start + count; i++) if (a[i] !== b[i]) return false
  return true
}

const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  const order = compareRange(a, 0, b, 0, Math.min(a.length, b.length))
  if (order !== 0) return order
  return a.length > b.length ? 1 : a.length < b.length ? -1 : 0
}

/** IndexOfOffset: where a search starts, or -1 when nothing can match. */
const indexOfOffset = (length: number, offset: number, needle: number, forward: boolean) => {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset
    return forward || needle === 0 ? 0 : -1
  }
  if (offset + needle <= length) return offset
  if (needle === 0) return length
  return forward ? -1 : length - 1
}

const indexOfByte = (bytes: Uint8Array, byte: number, offset: number, forward: boolean) => {
  const start = indexOfOffset(bytes.length, offset, 1, forward)
  if (start <= -1 || bytes.length === 0) return -1
  return forward ? bytes.indexOf(byte, start) : bytes.lastIndexOf(byte, start)
}

/** nbytes SearchString over bytes: a position, or `length` when there is none. */
const searchBytes = (haystack: Uint8Array, length: number, needle: Uint8Array, start: number, forward: boolean) => {
  const size = needle.length
  if (length < size) return length
  const last = length - size
  // The native byte search finds candidates for the needle's least common byte. Comparing them is bounded: once it
  // has cost about twice the haystack, Knuth-Morris-Pratt takes over, so no search is worse than linear.
  let anchor = 0
  for (let j = 1; j < size; j++) if (rarity(needle[j]!) >= rarity(needle[anchor]!)) anchor = j
  const byte = needle[anchor]!
  let budget = 64 + 2 * length
  const at = (i: number) => haystack[i]!
  const of = (j: number) => needle[j]!
  if (forward) {
    for (let p = haystack.indexOf(byte, start + anchor); p !== -1 && p - anchor <= last; p = haystack.indexOf(byte, p + 1)) {
      const i = p - anchor
      let j = 0
      while (j < size && haystack[i + j] === needle[j]) j++
      if (j === size) return i
      budget -= j + 1
      if (budget < 0) return knuthMorrisPratt(at, length, of, size, i + 1, true) ?? length
    }
    return length
  }
  for (let p = haystack.lastIndexOf(byte, Math.min(start, last) + anchor); p !== -1 && p >= anchor; p = p === 0 ? -1 : haystack.lastIndexOf(byte, p - 1)) {
    const i = p - anchor
    let j = 0
    while (j < size && haystack[i + j] === needle[j]) j++
    if (j === size) return i
    budget -= j + 1
    if (budget < 0) return i === 0 ? length : (knuthMorrisPratt(at, length, of, size, i - 1, false) ?? length)
  }
  return length
}

/** How unusual a byte tends to be in text: letters and spaces least, then punctuation, digits, then the rest. */
const rarity = (byte: number) =>
  (byte >= 0x61 && byte <= 0x7a) || byte === 0x20
    ? 0
    : byte >= 0x41 && byte <= 0x5a
      ? 1
      : byte >= 0x30 && byte <= 0x39
        ? 3
        : byte >= 0x21 && byte < 0x80
          ? 2
          : 4

/**
 * Knuth-Morris-Pratt over `size` items of `needle` in `length` of `haystack`: the first match at or after `from`, or
 * (backward) the last at or before it, by searching the reversed sequences. Linear in both lengths.
 */
const knuthMorrisPratt = (
  haystack: (index: number) => number,
  length: number,
  needle: (index: number) => number,
  size: number,
  from: number,
  forward: boolean,
): number | undefined => {
  const pattern = forward ? needle : (j: number) => needle(size - 1 - j)
  const text = forward ? haystack : (k: number) => haystack(length - 1 - k)
  const failure = new Int32Array(size)
  for (let j = 1, k = 0; j < size; j++) {
    while (k > 0 && pattern(j) !== pattern(k)) k = failure[k - 1]!
    if (pattern(j) === pattern(k)) k++
    failure[j] = k
  }
  for (let i = forward ? from : length - size - from, q = 0; i < length; i++) {
    while (q > 0 && text(i) !== pattern(q)) q = failure[q - 1]!
    if (text(i) === pattern(q)) q++
    if (q === size) {
      const found = i - size + 1
      return forward ? found : length - size - found
    }
  }
  return undefined
}

/** nbytes SearchString over UTF-16 units read little-endian from bytes: a unit position, or `units` for none. */
const searchUnits = (haystack: Uint8Array, units: number, needle: Uint8Array, size: number, start: number, forward: boolean) => {
  if (units < size) return units
  const last = units - size
  if (!forward && start > last) start = last
  if (forward && start > last) return units
  const found = knuthMorrisPratt(
    (i) => haystack[2 * i]! | (haystack[2 * i + 1]! << 8),
    units,
    (j) => needle[2 * j]! | (needle[2 * j + 1]! << 8),
    size,
    start,
    forward,
  )
  return found ?? units
}

/** IndexOfBuffer: `needle`'s bytes, searched as UTF-16 units for utf16le. */
const indexOfBytes = (bytes: Uint8Array, needle: Uint8Array, offset: number, units: boolean, forward: boolean) => {
  const length = bytes.length
  const start = indexOfOffset(length, offset, needle.length, forward)
  if (needle.length === 0) return start
  if (length === 0 || start <= -1) return -1
  if ((forward && needle.length + start > length) || needle.length > length) return -1
  if (units) {
    if (length < 2 || needle.length < 2) return -1
    // Node compares against the byte length, so an odd one reports a miss as its last even index.
    const found = searchUnits(bytes, length >>> 1, needle, needle.length >>> 1, start >>> 1, forward) * 2
    return found === length ? -1 : found
  }
  const found = searchBytes(bytes, length, needle, start, forward)
  return found === length ? -1 : found
}

/** IndexOfString, and IndexOfBuffer for the encodings Node decodes first. */
const indexOfString = (bytes: Uint8Array, text: string, offset: number, encoding: Encoding, forward: boolean) => {
  if (encoding === "hex" || encoding === "base64" || encoding === "base64url") {
    return indexOfBytes(bytes, encode(text, encoding), offset, false, forward)
  }
  const units = encoding === "utf16le"
  const length = units ? bytes.length & ~1 : bytes.length
  const needle = encode(text, encoding === "ascii" ? "latin1" : encoding)
  const start = indexOfOffset(length, offset, needle.length, forward)
  if (needle.length === 0) return start
  if (length === 0 || start <= -1) return -1
  if ((forward && needle.length + start > length) || needle.length > length) return -1
  if (units) {
    if (length < 2) return -1
    const found = searchUnits(bytes, length >>> 1, needle, text.length, start >>> 1, forward) * 2
    return found === length ? -1 : found
  }
  const found = searchBytes(bytes, length, needle, start, forward)
  return found === length ? -1 : found
}

/** Copies as much of `pattern` as fits at the start of `region`, returning how much that was. */
const copyPattern = (region: Uint8Array, pattern: Uint8Array) => {
  const count = Math.min(pattern.length, region.length)
  region.set(pattern.subarray(0, count))
  return count
}

/** Repeats the first `filled` bytes of `region` through its first `length` bytes, doubling as Node's fill does. */
const repeat = (region: Uint8Array, filled: number, length: number) => {
  let have = filled
  while (have < length - have) {
    region.copyWithin(have, 0, have)
    have *= 2
  }
  if (have < length) region.copyWithin(have, 0, length - have)
}
