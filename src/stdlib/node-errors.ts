import { type Builtins, createErrorValue } from "../runtime/intrinsics.js"
import { Throw } from "../runtime/model.js"
import {
  Arr,
  Bytes,
  Callable,
  coerceToString,
  define,
  get,
  has,
  hasPrototype,
  keys,
  Obj,
  own,
  type Value,
} from "../runtime/objects.js"
import { describeValue, typeofValue } from "../runtime/references.js"

// Node's errors as its Buffer throws them (lib/internal/errors.js), with the same classes, codes and messages, and the
// part of util.inspect those messages use. Reading `constructor.name` may meet a program getter, so a built-in builds
// these inside `withReads`.

export const kMaxLength = 2 ** 53 - 1

type ErrorClass = "TypeError" | "RangeError" | "Error"

export const nodeError = (builtins: Builtins, type: ErrorClass, code: string, message: string): Throw => {
  const value = createErrorValue(builtins[type], message)
  define(value, "code", code)
  return new Throw(value)
}

const kTypes = ["string", "function", "number", "object", "Function", "Object", "boolean", "bigint", "symbol"]

const formatList = (items: ReadonlyArray<string>, type = "and") => {
  if (items.length < 3) return items.join(` ${type} `)
  return `${items.slice(0, -1).join(", ")}, ${type} ${items.at(-1)}`
}

/** ERR_INVALID_ARG_TYPE */
export const invalidArgType = (builtins: Builtins, name: string, expected: string | ReadonlyArray<string>, actual: Value) => {
  const list = typeof expected === "string" ? [expected] : expected
  let message = name.endsWith(" argument") ? `The ${name} ` : `The "${name}" ${name.includes(".") ? "property" : "argument"} `
  message += "must be "
  const types: Array<string> = []
  const instances: Array<string> = []
  const other: Array<string> = []
  for (const value of list) {
    if (kTypes.includes(value)) types.push(value.toLowerCase())
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) instances.push(value)
    else other.push(value)
  }
  if (instances.length > 0 && types.includes("object")) {
    types.splice(types.indexOf("object"), 1)
    instances.push("Object")
  }
  if (types.length > 0) {
    message += `${types.length > 1 ? "one of type" : "of type"} ${formatList(types, "or")}`
    if (instances.length > 0 || other.length > 0) message += " or "
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances, "or")}`
    if (other.length > 0) message += " or "
  }
  if (other.length > 1) message += `one of ${formatList(other, "or")}`
  else if (other.length === 1) message += `${other[0]!.toLowerCase() !== other[0] ? "an " : ""}${other[0]}`
  return nodeError(builtins, "TypeError", "ERR_INVALID_ARG_TYPE", `${message}. Received ${specificType(builtins, actual)}`)
}

/** How ERR_INVALID_ARG_TYPE names the value it received (`determineSpecificType`). */
const specificType = (builtins: Builtins, value: Value): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeofValue(value) === "function") return `function ${coerceToString(get(value as Obj, "name"))}`
  if (value instanceof Obj) {
    const constructor = get(value, "constructor")
    if (constructor instanceof Obj && has(constructor, "name")) {
      return `an instance of ${coerceToString(get(constructor, "name"))}`
    }
    return inspect(builtins, value, -1)
  }
  switch (typeof value) {
    case "bigint":
      return `type bigint (${value}n)`
    case "number":
      return `type number (${Object.is(value, -0) ? "-0" : value})`
    case "boolean":
      return `type boolean (${value})`
    case "symbol":
      return `type symbol (${String(value)})`
    case "string": {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value
      return shown.includes("'") ? `type string (${JSON.stringify(shown)})` : `type string ('${shown}')`
    }
  }
  return describeValue(value)
}

const addNumericalSeparator = (value: string) => {
  let result = ""
  let i = value.length
  const start = value[0] === "-" ? 1 : 0
  for (; i >= start + 4; i -= 3) result = `_${value.slice(i - 3, i)}${result}`
  return `${value.slice(0, i)}${result}`
}

/** ERR_OUT_OF_RANGE */
export const outOfRange = (builtins: Builtins, name: string, range: string, input: Value) => {
  let received: string
  if (typeof input === "number" && Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
    received = addNumericalSeparator(String(input))
  } else if (typeof input === "bigint") {
    received = String(input)
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received)
    received += "n"
  } else {
    received = inspect(builtins, input, 2)
  }
  return nodeError(
    builtins,
    "RangeError",
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
  )
}

/** ERR_BUFFER_OUT_OF_BOUNDS */
export const bufferOutOfBounds = (builtins: Builtins, name?: string) =>
  nodeError(
    builtins,
    "RangeError",
    "ERR_BUFFER_OUT_OF_BOUNDS",
    name === undefined ? "Attempt to access memory outside buffer bounds" : `"${name}" is outside of buffer bounds`,
  )

/** ERR_UNKNOWN_ENCODING, naming the encoding as `util.format("%s")` does; `primitive` is what it converted to. */
export const unknownEncoding = (builtins: Builtins, encoding: Value, primitive: Value = encoding) =>
  nodeError(builtins, "TypeError", "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${formatString(builtins, encoding, primitive)}`)

/** ERR_INVALID_ARG_VALUE */
export const invalidArgValue = (builtins: Builtins, name: string, value: Value, reason = "is invalid") => {
  let shown = inspect(builtins, value, 2)
  if (shown.length > 128) shown = `${shown.slice(0, 128)}...`
  return nodeError(
    builtins,
    "TypeError",
    "ERR_INVALID_ARG_VALUE",
    `The ${name.includes(".") ? "property" : "argument"} '${name}' ${reason}. Received ${shown}`,
  )
}

/** ERR_INVALID_BUFFER_SIZE */
export const invalidBufferSize = (builtins: Builtins, size: string) =>
  nodeError(builtins, "RangeError", "ERR_INVALID_BUFFER_SIZE", `Buffer size must be a multiple of ${size}`)

// util.format's %s: numbers and BigInts as inspect shows them, objects with only built-in toString methods inspected,
// and anything else as String() gives it (here, the primitive the caller already converted it to).
const formatString = (builtins: Builtins, value: Value, primitive: Value): string => {
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value)
  if (typeof value === "bigint") return `${value}n`
  if (!(value instanceof Obj)) return String(value)
  if (builtInToString(value)) return inspect(builtins, value, 0)
  return typeof primitive === "symbol" ? String(primitive) : coerceToString(primitive)
}

const builtInToString = (value: Obj): boolean => {
  if (own(value, "toString") !== undefined) return false
  for (let pointer = value.proto; pointer !== null; pointer = pointer.proto) {
    const slot = own(pointer, "toString")
    if (slot !== undefined) return pointer.intrinsic > 0 && "value" in slot && slot.value instanceof Callable
  }
  return true
}

// util.inspect's escaping (strEscape): quotes chosen by what the string contains, control characters and lone
// surrogates escaped.
const meta = [
  ...Array.from({ length: 32 }, (_, code) => `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`),
]
meta[8] = "\\b"
meta[9] = "\\t"
meta[10] = "\\n"
meta[12] = "\\f"
meta[13] = "\\r"

const escapeString = (text: string): string => {
  let quote = 39
  if (text.includes("'")) {
    if (!text.includes('"')) quote = -1
    else if (!text.includes("`") && !text.includes("${")) quote = -2
  }
  let result = ""
  let last = 0
  for (let i = 0; i < text.length; i++) {
    const point = text.charCodeAt(i)
    if (point === quote || point === 92 || point < 32 || (point > 126 && point < 160)) {
      const escaped =
        point === 39 ? "\\'" : point === 92 ? "\\\\" : point < 32 ? meta[point]! : `\\x${point.toString(16).toUpperCase()}`
      result += `${text.slice(last, i)}${escaped}`
      last = i + 1
    } else if (point >= 0xd800 && point <= 0xdfff) {
      if (point <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++
          continue
        }
      }
      result += `${text.slice(last, i)}\\u${point.toString(16)}`
      last = i + 1
    }
  }
  result += text.slice(last)
  return quote === -1 ? `"${result}"` : quote === -2 ? `\`${result}\`` : `'${result}'`
}

const inspectString = (text: string): string => {
  let trailer = ""
  if (text.length > 10000) {
    const remaining = text.length - 10000
    text = text.slice(0, 10000)
    trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`
  }
  // Long strings are shown a line at a time.
  if (text.length > 16 && text.length > 124) return text.split(/(?<=\n)/).map(escapeString).join(" +\n  ") + trailer
  return escapeString(text) + trailer
}

/** `util.inspect(value, { depth })` for the values Buffer's errors show. */
export const inspect = (builtins: Builtins, value: Value, depth: number): string => {
  if (typeof value === "string") return inspectString(value)
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value)
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "symbol") return String(value)
  if (!(value instanceof Obj)) return value === null || value === undefined ? String(value) : describeValue(value)
  if (value instanceof Callable) {
    const name = coerceToString(get(value, "name"))
    return name === "" ? "[Function (anonymous)]" : `[Function: ${name}]`
  }
  if (value instanceof Bytes) {
    if (hasPrototype(value, builtins.Buffer)) {
      const shown = Array.from(value.bytes.subarray(0, 50), (byte) => byte.toString(16).padStart(2, "0")).join(" ")
      const remaining = value.bytes.length - 50
      return `<Buffer ${shown}${remaining > 0 ? ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}` : ""}>`
    }
    if (value.bytes.length === 0) return "Uint8Array(0) []"
    return `Uint8Array(${value.bytes.length}) [ ${[...value.bytes.subarray(0, 100)].join(", ")}${value.bytes.length > 100 ? `, ... ${value.bytes.length - 100} more items` : ""} ]`
  }
  if (value instanceof Arr) {
    if (depth < 0) return "[Array]"
    if (value.items.length === 0) return "[]"
    return `[ ${value.items.map((item) => inspect(builtins, item, depth - 1)).join(", ")} ]`
  }
  if (value.tag !== "Object") return describeValue(value)
  const prefix = value.proto === null ? "[Object: null prototype] " : ""
  if (depth < 0) return value.proto === null ? "[Object: null prototype]" : "[Object]"
  const names = keys(value)
  if (names.length === 0) return `${prefix}{}`
  const shown = names.map((key) => {
    const name = /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) ? key : escapeString(key)
    return `${name}: ${inspect(builtins, get(value, key), depth - 1)}`
  })
  return `${prefix}{ ${shown.join(", ")} }`
}
