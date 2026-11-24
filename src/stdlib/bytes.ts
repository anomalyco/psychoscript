import { Invoke } from "../runtime/signals.js"
import { charge } from "../runtime/heap.js"
import { checkArrayLength, checkStringLength, MAX_ARRAY_LENGTH } from "../runtime/limits.js"
import type { Builtins } from "../runtime/intrinsics.js"
import { constructor, methods, prototypeFrom, receiver, requiresNew, iteratorMethods, typedReceiver } from "../runtime/native.js"
import { IteratorSymbol, rangeError, syntaxError, typeError } from "../runtime/model.js"
import {
  define,
  defineAccessor,
  frozen,
  get,
  hidden,
  arrayBufferOf,
  ArrayBufferObj,
  Bytes,
  Obj,
  typedArrays,
  type TypedArrayName,
  coerceToInteger,
  coerceToNumber,
  coerceToString,
  record,
  type Value,
} from "../runtime/objects.js"
import { describeValue } from "../runtime/references.js"
import { requireCallback, readsPending, withReads } from "../runtime/callback.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { sortArray } from "./array.js"

/**
 * The values a typed array, array, or other iterable of numbers describes, read in the prelude: a new typed array with
 * prototype `into`, or set into the typed array `into` at `offset`. The host array converts each value.
 */
export const collectBytes = <R>(
  ctx: Interpreter<R>,
  source: Value,
  name: string,
  into: Obj,
  offset: number,
  mapper?: Value,
  thisArg?: Value,
) => {
  const callback = mapper === undefined ? undefined : requireCallback(mapper, name)
  if (source instanceof Bytes && callback === undefined) return finishBytes(ctx.builtins, Array.from(source.bytes), into, offset)
  return new Invoke(
    ctx.prelude.fn("collectBytes"),
    undefined,
    [source, name, callback, thisArg, into, offset],
    undefined,
  )
}

/** The typed array kind whose prototype is `proto`: a subclass's prototype makes its base kind. */
const kindOf = (builtins: Builtins, proto: Obj): TypedArrayName => {
  for (let current: Obj | null = proto; current !== null; current = current.proto) {
    for (const name of Object.keys(typedArrays) as Array<TypedArrayName>) if (builtins[name] === current) return name
  }
  return "Uint8Array"
}

/** The collected values as a new typed array with prototype `into`, or set into the typed array `into` at `offset`. */
export const finishBytes = (builtins: Builtins, values: ArrayLike<number>, into: Obj, offset: number): Value => {
  if (!(into instanceof Bytes)) {
    const name = kindOf(builtins, into)
    charge(values.length * typedArrays[name].BYTES_PER_ELEMENT)
    return new Bytes(into, typedArrays[name].from(values))
  }
  if (!Number.isInteger(offset) || offset < 0 || values.length + offset > into.bytes.length) {
    throw rangeError(`${into.tag}.set: the source does not fit at that offset.`)
  }
  into.bytes.set(values, offset)
  return undefined
}

/** ToIndex for a byte offset or a length: undefined is 0, fractions truncate, and a negative one is undefined. */
const toIndex = (value: Value): number | undefined => {
  if (value === undefined) return 0
  const index = coerceToInteger(value)
  return index < 0 ? undefined : index
}

/** A view of `name` on an ArrayBuffer, as `new Float32Array(buffer, byteOffset, length)` makes it. */
const viewOf = (name: TypedArrayName, proto: Obj, source: ArrayBufferObj, offset: Value, length: Value) => {
  const size = typedArrays[name].BYTES_PER_ELEMENT
  const total = source.buffer.byteLength
  const start = toIndex(offset)
  if (start === undefined) throw rangeError(`Start offset ${coerceToString(offset)} is outside the bounds of the buffer`)
  if (start % size !== 0) throw rangeError(`start offset of ${name} should be a multiple of ${size}`)
  let count: number
  if (length === undefined) {
    if (total % size !== 0) throw rangeError(`byte length of ${name} should be a multiple of ${size}`)
    if (start > total) throw rangeError(`Start offset ${start} is outside the bounds of the buffer`)
    count = (total - start) / size
  } else {
    const n = toIndex(length)
    if (n === undefined || start + n * size > total) {
      throw rangeError(`Invalid typed array length: ${coerceToString(length)}`)
    }
    count = n
  }
  return new Bytes(proto, new typedArrays[name](source.buffer, start, count))
}

const constructBytes = <R>(ctx: Interpreter<R>, args: Array<Value>, proto: Obj, name: TypedArrayName = "Uint8Array") => {
  const source = args[0]
  if (source instanceof ArrayBufferObj) return viewOf(name, proto, source, args[1], args[2])
  if (source !== null && typeof source === "object") return collectBytes(ctx, source, `new ${name}(...)`, proto, 0)
  // ToIndex: fractions truncate and NaN is 0.
  const length = source === undefined ? 0 : Math.trunc(coerceToNumber(source)) || 0
  if (!Number.isFinite(length) || length < 0) throw rangeError(`Invalid typed array length: ${coerceToString(source)}`)
  checkArrayLength(length)
  charge(length * typedArrays[name].BYTES_PER_ELEMENT)
  return new Bytes(proto, new typedArrays[name](length))
}

const base64Alphabets = ["base64", "base64url"] as const
const lastChunkHandlings = ["loose", "strict", "stop-before-partial"] as const

const base64Options = (value: Value, name: string) => {
  if (value === undefined) return undefined
  if (value instanceof Obj) return value
  throw typeError(`${name} requires that options be an object.`)
}

/** A string option of the base64 methods: one of `allowed`, defaulting to the first. */
const base64Option = <const T extends string>(
  options: Obj | undefined,
  key: string,
  allowed: ReadonlyArray<T>,
  name: string,
): T => {
  const value = options === undefined ? undefined : get(options, key)
  if (value === undefined) return allowed[0]
  const match = allowed.find((option) => option === value)
  if (match !== undefined) return match
  throw typeError(`${name} requires that ${key} be ${allowed.map((option) => `"${option}"`).join(" or ")}.`)
}

export const uint8ArrayGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.Uint8Array
  const wrap = (bytes: Uint8Array) => new Bytes(proto, bytes)
  const uint8Array = constructor(builtins, proto, {
    name: "Uint8Array",
    length: 3,
    call: requiresNew("Uint8Array"),
    construct: (args, newTarget) => constructBytes(ctx, args, prototypeFrom(newTarget, proto)),
  })
  const decode = (name: string, args: Array<Value>, from: (text: string) => Uint8Array) => {
    if (typeof args[0] !== "string") throw typeError(`Uint8Array.${name} expects a string.`)
    try {
      return wrap(from(args[0]))
    } catch {
      throw syntaxError(`Uint8Array.${name}: the string is not valid ${name === "fromHex" ? "hex" : "base64"}.`)
    }
  }
  methods(builtins, uint8Array, [
    ["from", 1, (_, args) => collectBytes(ctx, args[0], "Uint8Array.from", proto, 0, args[1], args[2])],
    ["of", 0, (_, args) => wrap(Uint8Array.from(args, coerceToNumber))],
    [
      "fromBase64",
      1,
      (_, args) => {
        if (typeof args[0] !== "string") throw typeError("Uint8Array.fromBase64 expects a string.")
        return withReads(() => {
          const options = base64Options(args[1], "Uint8Array.fromBase64")
          const alphabet = base64Option(options, "alphabet", base64Alphabets, "Uint8Array.fromBase64")
          const lastChunkHandling = base64Option(
            options,
            "lastChunkHandling",
            lastChunkHandlings,
            "Uint8Array.fromBase64",
          )
          return decode("fromBase64", args, (text) => Uint8Array.fromBase64(text, { alphabet, lastChunkHandling }))
        })
      },
    ],
    ["fromHex", 1, (_, args) => decode("fromHex", args, (text) => Uint8Array.fromHex(text))],
  ])
  const written = (name: string, format: string, run: () => { read: number; written: number }) => {
    try {
      const result = run()
      return record(builtins.Object, { read: result.read, written: result.written })
    } catch {
      throw syntaxError(`${name}: the string is not valid ${format}.`)
    }
  }
  define(uint8Array, "BYTES_PER_ELEMENT", 1, frozen)
  define(proto, "BYTES_PER_ELEMENT", 1, frozen)

  const self = (thisValue: Value, name: string) => typedReceiver(thisValue, `Uint8Array.prototype.${name}`, true)
  const optNumber = (value: Value): number | undefined => (value === undefined ? undefined : coerceToInteger(value))
  // Uint8Array cannot contain NaN, so non-number search values never match a byte.
  const search = (value: Value) => (typeof value === "number" ? value : NaN)
  defineAccessor(proto, "length", (thisValue) => self(thisValue, "length").bytes.length)
  viewAccessors(builtins, proto, self)
  methods(builtins, proto, [
    ["at", 1, (thisValue, args) => self(thisValue, "at").bytes.at(optNumber(args[0]) ?? 0)],
    [
      "slice",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "slice")
        return target.derive(builtins, target.bytes.slice(optNumber(args[0]), optNumber(args[1])))
      },
    ],
    // A view on the same bytes, as in JS: writes through one are visible through the other.
    [
      "subarray",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "subarray")
        return target.derive(builtins, target.bytes.subarray(optNumber(args[0]), optNumber(args[1])))
      },
    ],
    [
      "set",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "set")
        return collectBytes(ctx, args[0], "Uint8Array.set", target, optNumber(args[1]) ?? 0)
      },
    ],
    [
      "fill",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "fill")
        target.bytes.fill(coerceToNumber(args[0]), optNumber(args[1]), optNumber(args[2]))
        return target
      },
    ],
    [
      "reverse",
      0,
      (thisValue) => {
        const target = self(thisValue, "reverse")
        target.bytes.reverse()
        return target
      },
    ],
    [
      "sort",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "sort")
        // Without a comparator, typed arrays sort numerically rather than by string.
        if (args[0] === undefined) {
          target.bytes.sort()
          return target
        }
        return sortArray(ctx, target, args[0], "Uint8Array.sort")
      },
    ],
    [
      "toSorted",
      1,
      (thisValue, args) => {
        const copy = wrap(self(thisValue, "toSorted").bytes.slice())
        if (args[0] === undefined) {
          copy.bytes.sort()
          return copy
        }
        return sortArray(ctx, copy, args[0], "Uint8Array.toSorted")
      },
    ],
    ["toReversed", 0, (thisValue) => wrap(self(thisValue, "toReversed").bytes.toReversed())],
    [
      "with",
      2,
      (thisValue, args) => {
        const bytes = self(thisValue, "with").bytes
        const index = optNumber(args[0]) ?? 0
        const resolved = index < 0 ? bytes.length + index : index
        // The value is converted before the index is checked, as in JS.
        const value = coerceToNumber(args[1])
        if (resolved < 0 || resolved >= bytes.length) throw rangeError("Uint8Array.with index is out of range.")
        return wrap(bytes.with(resolved, value))
      },
    ],
    [
      "copyWithin",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "copyWithin")
        target.bytes.copyWithin(optNumber(args[0]) ?? 0, optNumber(args[1]) ?? 0, optNumber(args[2]))
        return target
      },
    ],
    ["indexOf", 1, (thisValue, args) => self(thisValue, "indexOf").bytes.indexOf(search(args[0]), optNumber(args[1]))],
    [
      "lastIndexOf",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "lastIndexOf").bytes
        return args.length < 2
          ? target.lastIndexOf(search(args[0]))
          : target.lastIndexOf(search(args[0]), optNumber(args[1]))
      },
    ],
    [
      "includes",
      1,
      (thisValue, args) => self(thisValue, "includes").bytes.includes(search(args[0]), optNumber(args[1])),
    ],
    [
      "join",
      1,
      (thisValue, args) => {
        const joined = self(thisValue, "join").bytes.join(args[0] === undefined ? "," : coerceToString(args[0]))
        checkStringLength(joined.length)
        return joined
      },
    ],
    ["toString", 0, (thisValue) => self(thisValue, "toString").bytes.join(",")],
    [
      "toBase64",
      0,
      (thisValue, args) => {
        const bytes = self(thisValue, "toBase64").bytes
        return withReads(() => {
          const options = base64Options(args[0], "Uint8Array.prototype.toBase64")
          const alphabet = base64Option(options, "alphabet", base64Alphabets, "Uint8Array.prototype.toBase64")
          return bytes.toBase64({
            alphabet,
            omitPadding: options !== undefined && Boolean(get(options, "omitPadding")),
          })
        })
      },
    ],
    ["toHex", 0, (thisValue) => self(thisValue, "toHex").bytes.toHex()],
    [
      "setFromBase64",
      1,
      (thisValue, args) => {
        const bytes = self(thisValue, "setFromBase64").bytes
        const name = "Uint8Array.prototype.setFromBase64"
        if (typeof args[0] !== "string") throw typeError(`${name} expects a string.`)
        const text = args[0]
        return withReads(() => {
          const options = base64Options(args[1], name)
          const alphabet = base64Option(options, "alphabet", base64Alphabets, name)
          const lastChunkHandling = base64Option(options, "lastChunkHandling", lastChunkHandlings, name)
          return written(name, "base64", () => bytes.setFromBase64(text, { alphabet, lastChunkHandling }))
        })
      },
    ],
    [
      "setFromHex",
      1,
      (thisValue, args) => {
        const bytes = self(thisValue, "setFromHex").bytes
        const name = "Uint8Array.prototype.setFromHex"
        if (typeof args[0] !== "string") throw typeError(`${name} expects a string.`)
        const text = args[0]
        return written(name, "hex", () => bytes.setFromHex(text))
      },
    ],
    ...iteratorMethods(builtins, self),
    // The callback methods are the prelude's.
  ])
  define(proto, IteratorSymbol, get(proto, "values"), hidden)
  return uint8Array
}

/** `byteLength`, `byteOffset` and `buffer`, which every typed array has. */
const viewAccessors = (builtins: Builtins, proto: Obj, self: (thisValue: Value, name: string) => Bytes) => {
  defineAccessor(proto, "byteLength", (thisValue) => self(thisValue, "byteLength").bytes.byteLength)
  defineAccessor(proto, "byteOffset", (thisValue) => self(thisValue, "byteOffset").bytes.byteOffset)
  defineAccessor(proto, "buffer", (thisValue) => arrayBufferOf(builtins, self(thisValue, "buffer").bytes))
}

/** The most bytes an ArrayBuffer may hold: as many as the longest Float64Array. */
const MAX_BUFFER_BYTES = MAX_ARRAY_LENGTH * 8

export const arrayBufferGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.ArrayBuffer
  const arrayBuffer = constructor(builtins, proto, {
    name: "ArrayBuffer",
    length: 1,
    call: requiresNew("ArrayBuffer"),
    construct: (args, newTarget) => {
      const length = toIndex(args[0])
      if (length === undefined || length > MAX_BUFFER_BYTES) throw rangeError("Invalid array buffer length")
      charge(length)
      return new ArrayBufferObj(prototypeFrom(newTarget, proto), new ArrayBuffer(length))
    },
  })
  methods(builtins, arrayBuffer, [
    ["isView", 1, (_, args) => args[0] instanceof Bytes],
  ])
  const self = (thisValue: Value, name: string) =>
    receiver(ArrayBufferObj, thisValue, `ArrayBuffer.prototype.${name}`)
  defineAccessor(proto, "byteLength", (thisValue) => self(thisValue, "byteLength").buffer.byteLength)
  methods(builtins, proto, [
    [
      "slice",
      2,
      (thisValue, args) => {
        const buffer = self(thisValue, "slice").buffer
        const slice = buffer.slice(optIndex(args[0]), optIndex(args[1]))
        charge(slice.byteLength)
        return new ArrayBufferObj(builtins.ArrayBuffer, slice)
      },
    ],
  ])
  return arrayBuffer
}

const optIndex = (value: Value): number | undefined => (value === undefined ? undefined : coerceToInteger(value))

/** Uint16Array, Uint32Array, Int32Array, Float32Array and Float64Array: the typed arrays besides Uint8Array. */
export const typedArrayGlobal = <R>(ctx: Interpreter<R>, name: Exclude<TypedArrayName, "Uint8Array">) => {
  const builtins = ctx.builtins
  const proto = builtins[name]
  const size = typedArrays[name].BYTES_PER_ELEMENT
  const typed = constructor(builtins, proto, {
    name,
    length: 3,
    call: requiresNew(name),
    construct: (args, newTarget) => constructBytes(ctx, args, prototypeFrom(newTarget, proto), name),
  })
  methods(builtins, typed, [
    ["from", 1, (_, args) => collectBytes(ctx, args[0], `${name}.from`, proto, 0, args[1], args[2])],
    [
      "of",
      0,
      (_, args) => {
        charge(args.length * size)
        return new Bytes(proto, typedArrays[name].from(args.map(coerceToNumber)))
      },
    ],
  ])
  define(typed, "BYTES_PER_ELEMENT", size, frozen)
  define(proto, "BYTES_PER_ELEMENT", size, frozen)
  const self = (thisValue: Value, method: string) => typedReceiver(thisValue, `${name}.prototype.${method}`)
  defineAccessor(proto, "length", (thisValue) => self(thisValue, "length").bytes.length)
  viewAccessors(builtins, proto, self)
  methods(builtins, proto, [
    ["at", 1, (thisValue, args) => self(thisValue, "at").bytes.at(optIndex(args[0]) ?? 0)],
    [
      "slice",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "slice")
        const slice = target.bytes.slice(optIndex(args[0]), optIndex(args[1]))
        charge(slice.byteLength)
        return target.derive(builtins, slice)
      },
    ],
    [
      "subarray",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "subarray")
        return target.derive(builtins, target.bytes.subarray(optIndex(args[0]), optIndex(args[1])))
      },
    ],
    [
      "set",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "set")
        return collectBytes(ctx, args[0], `${target.tag}.set`, target, optIndex(args[1]) ?? 0)
      },
    ],
    [
      "fill",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "fill")
        target.bytes.fill(coerceToNumber(args[0]), optIndex(args[1]), optIndex(args[2]))
        return target
      },
    ],
    [
      "reverse",
      0,
      (thisValue) => {
        const target = self(thisValue, "reverse")
        target.bytes.reverse()
        return target
      },
    ],
    // Only a number can equal an element.
    [
      "indexOf",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "indexOf").bytes
        return typeof args[0] === "number" ? target.indexOf(args[0], optIndex(args[1])) : -1
      },
    ],
    [
      "lastIndexOf",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "lastIndexOf").bytes
        if (typeof args[0] !== "number") return -1
        return args.length < 2 ? target.lastIndexOf(args[0]) : target.lastIndexOf(args[0], optIndex(args[1]))
      },
    ],
    [
      "includes",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "includes").bytes
        return typeof args[0] === "number" && target.includes(args[0], optIndex(args[1]))
      },
    ],
    [
      "join",
      1,
      (thisValue, args) => {
        const joined = self(thisValue, "join").bytes.join(args[0] === undefined ? "," : coerceToString(args[0]))
        checkStringLength(joined.length)
        return joined
      },
    ],
    ["toString", 0, (thisValue) => self(thisValue, "toString").bytes.join(",")],
    ...iteratorMethods(builtins, self),
  ])
  define(proto, IteratorSymbol, get(proto, "values"), hidden)
  return typed
}

export const textEncoderGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.TextEncoder
  const encoder = new TextEncoder()
  defineAccessor(proto, "encoding", () => "utf-8")
  methods(builtins, proto, [
    [
      "encode",
      0,
      (_, args) => new Bytes(builtins.Uint8Array, encoder.encode(coerceToString(args[0] === undefined ? "" : args[0]))),
    ],
    [
      "encodeInto",
      2,
      (_, args) => {
        const target = args[1]
        if (!(target instanceof Bytes)) {
          throw typeError(`TextEncoder.encodeInto expects a Uint8Array, received ${describeValue(target)}.`)
        }
        const result = encoder.encodeInto(coerceToString(args[0]), target.bytes)
        return record(builtins.Object, { read: result.read, written: result.written })
      },
    ],
  ])
  return constructor(builtins, proto, {
    name: "TextEncoder",
    call: requiresNew("TextEncoder"),
    construct: (_, newTarget) => new Obj(prototypeFrom(newTarget, proto)),
  })
}

// Replacement mode only needs to identify an incomplete suffix (at most three bytes).
// Fatal mode also needs the queue position after the first error, which the host doesn't expose.
const streamBoundary = (bytes: Uint8Array, fatal: boolean) => {
  let next = fatal ? 0 : Math.max(0, bytes.length - 3)
  while (next < bytes.length) {
    const start = next
    const lead = bytes[next++]!
    if (lead < 0x80) continue
    if (lead < 0xc2 || lead > 0xf4) {
      if (fatal) return { end: next, error: true }
      continue
    }
    const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
    let lower = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80
    let upper = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf
    while (next < start + width) {
      if (next === bytes.length) return { end: start, error: false }
      const byte = bytes[next]!
      // A bad continuation is reprocessed as a leading byte, even after a fatal error.
      if (byte < lower || byte > upper) {
        if (fatal) return { end: next, error: true }
        break
      }
      next++
      lower = 0x80
      upper = 0xbf
    }
  }
  return { end: next, error: false }
}

const empty = new Uint8Array()

export class TextDecoderObj extends Obj {
  queued: Uint8Array = empty
  seen = false

  constructor(
    proto: Obj,
    readonly decoder: TextDecoder,
    readonly ignoreBOM: boolean,
  ) {
    super(proto)
  }

  decode(bytes: Uint8Array, stream: boolean) {
    if (this.queued.length && bytes.length) {
      checkArrayLength(this.queued.length + bytes.length)
      const joined = new Uint8Array(this.queued.length + bytes.length)
      joined.set(this.queued)
      joined.set(bytes, this.queued.length)
      bytes = joined
    }
    if (!bytes.length) bytes = this.queued
    const { end, error } = stream ? streamBoundary(bytes, this.decoder.fatal) : { end: bytes.length, error: false }
    this.queued = end < bytes.length ? bytes.slice(end) : empty
    if (error) throw typeError("TextDecoder.decode: the input is not valid utf-8.")
    const stripBOM = !this.ignoreBOM && !this.seen
    if (!stream) this.seen = false
    try {
      // Keep the host decoder stateless: snapshots own the pending bytes and BOM decision.
      const text = this.decoder.decode(end === bytes.length ? bytes : bytes.subarray(0, end))
      if (stream && text.length) this.seen = true
      return stripBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } catch {
      throw typeError("TextDecoder.decode: the input is not valid utf-8.")
    }
  }
}

// The WHATWG labels for UTF-8, the only encoding psychoscript decodes.
const utf8Labels = new Set(["unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"])

export const textDecoderGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.TextDecoder
  const self = (thisValue: Value, name: string) => receiver(TextDecoderObj, thisValue, `TextDecoder.prototype.${name}`)
  defineAccessor(proto, "encoding", (thisValue) => self(thisValue, "encoding").decoder.encoding)
  defineAccessor(proto, "fatal", (thisValue) => self(thisValue, "fatal").decoder.fatal)
  defineAccessor(proto, "ignoreBOM", (thisValue) => self(thisValue, "ignoreBOM").ignoreBOM)
  methods(builtins, proto, [
    [
      "decode",
      0,
      (thisValue, args) => {
        const decoder = self(thisValue, "decode")
        if (args[0] !== undefined && !(args[0] instanceof Bytes && args[0].isUint8())) {
          throw typeError(`TextDecoder.decode expects a Uint8Array, received ${describeValue(args[0])}.`)
        }
        const options = args[1]
        if (options !== undefined && typeof options !== "object") {
          throw typeError("TextDecoder.decode expects an options object.")
        }
        return withReads(() => {
          const stream = options instanceof Obj && Boolean(get(options, "stream"))
          return readsPending()
            ? undefined
            : decoder.decode((args[0] as Bytes<Uint8Array> | undefined)?.bytes ?? empty, stream)
        })
      },
    ],
  ])
  return constructor(builtins, proto, {
    name: "TextDecoder",
    call: requiresNew("TextDecoder"),
    construct: (args, newTarget) => {
      const label = args[0] === undefined ? "utf-8" : coerceToString(args[0]).trim().toLowerCase()
      if (!utf8Labels.has(label)) throw rangeError(`The "${label}" encoding is not supported; only UTF-8 is.`)
      const options = args[1] instanceof Obj ? args[1] : undefined
      const flag = (name: string) => options !== undefined && Boolean(get(options, name))
      return withReads(
        () =>
          new TextDecoderObj(
            prototypeFrom(newTarget, proto),
            new TextDecoder("utf-8", { fatal: flag("fatal"), ignoreBOM: true }),
            flag("ignoreBOM"),
          ),
      )
    },
  })
}
