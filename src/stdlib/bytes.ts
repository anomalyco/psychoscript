import { checkArrayLength } from "../runtime/limits.js"
import { constructor, methods, prototypeFrom, receiver, requiresNew } from "../runtime/native.js"
import { rangeError, syntaxError, typeError } from "../runtime/model.js"
import {
  binaryBytes,
  defineAccessor,
  get,
  Bytes,
  Obj,
  coerceToString,
  type Value,
} from "../runtime/objects.js"
import { describeValue } from "../runtime/references.js"
import { readsPending, withReads } from "../runtime/callback.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { typedArrayGlobal } from "./typed-array.js"

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
  const uint8Array = typedArrayGlobal(ctx, "Uint8Array")
  const decode = (name: string, args: Array<Value>, from: (text: string) => Uint8Array) => {
    if (typeof args[0] !== "string") throw typeError(`Uint8Array.${name} expects a string.`)
    try {
      return wrap(from(args[0]))
    } catch {
      throw syntaxError(`Uint8Array.${name}: the string is not valid ${name === "fromHex" ? "hex" : "base64"}.`)
    }
  }
  methods(builtins, uint8Array, [
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

  const self = (thisValue: Value, name: string) => receiver(Bytes, thisValue, `Uint8Array.prototype.${name}`)
  methods(builtins, proto, [
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
  ])
  return uint8Array
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
        const input = args[0] === undefined ? empty : binaryBytes(args[0])
        if (input === undefined) {
          throw typeError(
            `TextDecoder.decode expects an ArrayBuffer, a typed array or a DataView, received ${describeValue(args[0])}.`,
          )
        }
        const options = args[1]
        if (options !== undefined && typeof options !== "object") {
          throw typeError("TextDecoder.decode expects an options object.")
        }
        return withReads(() => {
          const stream = options instanceof Obj && Boolean(get(options, "stream"))
          return readsPending() ? undefined : decoder.decode(input, stream)
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
