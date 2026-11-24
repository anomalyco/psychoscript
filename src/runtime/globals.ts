import {
  Arr,
  BoundFn,
  Callable,
  coerceToInteger,
  define,
  defineAccessor,
  get,
  Obj,
  readonly,
  type Value,
} from "./objects.js"
import { withReads } from "./callback.js"
import { arrayGlobal } from "../stdlib/array.js"
import { arrayBufferGlobal, textDecoderGlobal, textEncoderGlobal, typedArrayGlobal, uint8ArrayGlobal } from "../stdlib/bytes.js"
import { bufferGlobal } from "../stdlib/buffer.js"
import { mapGlobal, setGlobal, weakMapGlobal, weakSetGlobal } from "../stdlib/collections.js"
import { consoleGlobal } from "../stdlib/console.js"
import { dateGlobal } from "../stdlib/date.js"
import { jsonGlobal } from "../stdlib/json.js"
import { mathGlobal } from "../stdlib/math.js"
import { bigintGlobal, booleanGlobal, numberGlobal } from "../stdlib/number.js"
import { objectGlobal } from "../stdlib/object.js"
import { regexpGlobal } from "../stdlib/regexp.js"
import { stringGlobal } from "../stdlib/string.js"
import { uriGlobal, urlGlobal, urlSearchParamsGlobal } from "../stdlib/url.js"
import { headersGlobal } from "../stdlib/headers.js"
import { iteratorGlobals } from "../stdlib/iterator.js"
import { coercion } from "../stdlib/value.js"
import { base64Global, cryptoGlobal, structuredCloneGlobal } from "../stdlib/web.js"
import { errorGlobal } from "./errors.js"
import { errorTypes } from "./intrinsics.js"
import { constants, constructor, fn, methods, native, receiver } from "./native.js"
import { AsyncIteratorSymbol, IteratorSymbol, ToPrimitiveSymbol, ToStringTagSymbol, typeError } from "./model.js"
import { checkArrayLength } from "./limits.js"
import { generatorGlobals } from "./generators.js"
import { promiseGlobal } from "./promises.js"
import type { Interpreter } from "./interpreter.js"
import { Invoke } from "./signals.js"

// Function.prototype.constructor exists so `fn.constructor === Function` holds; dynamic code is unsupported.
const functionGlobal = <R>(ctx: Interpreter<R>) => {
  const reject = () => {
    throw typeError("The Function constructor is not supported; write the function inline.")
  }
  const target = (thisValue: Value, method: string) => receiver(Callable, thisValue, `Function.prototype.${method}`)
  methods(ctx.builtins, ctx.builtins.Function, [
    ["call", 1, (thisValue, args, site) => new Invoke(target(thisValue, "call"), args[0], args.slice(1), site)],
    [
      "apply",
      2,
      (thisValue, args, site) =>
        withReads(() => new Invoke(target(thisValue, "apply"), args[0], listFromArrayLike(args[1]), site)),
    ],
    [
      "bind",
      1,
      (thisValue, args) =>
        withReads(() => {
          const fn = target(thisValue, "bind")
          const name = get(fn, "name")
          const length = get(fn, "length")
          return new BoundFn(
            ctx.builtins.Function,
            fn,
            args[0],
            args.slice(1),
            typeof name === "string" ? name : "",
            typeof length === "number" && !Number.isNaN(length)
              ? Math.max(0, Math.trunc(length) - Math.max(0, args.length - 1))
              : 0,
          )
        }),
    ],
  ])
  // AddRestrictedFunctionProperties: strict functions have no caller or arguments of their own.
  // Each half gets its own function: the intrinsics name a native accessor half by the function it wraps.
  const restricted = (): never => {
    throw typeError("'caller' and 'arguments' are restricted function properties and cannot be accessed in this context.")
  }
  for (const key of ["caller", "arguments"])
    defineAccessor(ctx.builtins.Function, key, () => restricted(), () => restricted())
  return constructor(ctx.builtins, ctx.builtins.Function, {
    name: "Function",
    length: 1,
    call: reject,
    construct: reject,
  })
}

// CreateListFromArrayLike: `apply` reads `length` and the indexed properties of any object.
const listFromArrayLike = (value: Value): Array<Value> => {
  if (value === undefined || value === null) return []
  if (value instanceof Arr) return [...value.items]
  if (!(value instanceof Obj)) throw typeError("Function.prototype.apply expects an array-like argument list.")
  const length = Math.max(0, coerceToInteger(get(value, "length")))
  checkArrayLength(length)
  return Array.from({ length }, (_, index) => get(value, String(index)))
}

const symbolGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const symbol = constructor(builtins, builtins.Symbol, {
    name: "Symbol",
    call: () => {
      throw typeError(
        "Symbol is not callable; only Symbol.asyncIterator, Symbol.iterator, Symbol.toPrimitive and Symbol.toStringTag are available.",
      )
    },
    callback: false,
  })
  constants(symbol, {
    asyncIterator: AsyncIteratorSymbol,
    iterator: IteratorSymbol,
    toPrimitive: ToPrimitiveSymbol,
    toStringTag: ToStringTagSymbol,
  })
  const self = (thisValue: Value, name: string): symbol => {
    if (typeof thisValue === "symbol") return thisValue
    throw typeError(`Symbol.prototype.${name} requires that 'this' be a Symbol.`)
  }
  methods(builtins, builtins.Symbol, [
    ["toString", 0, (thisValue) => String(self(thisValue, "toString"))],
    ["valueOf", 0, (thisValue) => self(thisValue, "valueOf")],
  ])
  defineAccessor(builtins.Symbol, "description", (thisValue) => self(thisValue, "description").description)
  define(
    builtins.Symbol,
    ToPrimitiveSymbol,
    fn(builtins, "[Symbol.toPrimitive]", 1, (thisValue) => self(thisValue, "[Symbol.toPrimitive]")),
    readonly,
  )
  define(builtins.Symbol, ToStringTagSymbol, "Symbol", readonly)
  return symbol
}

type Factory = <R>(ctx: Interpreter<R>) => Value

// A table rather than a list so the names are known before any runtime exists.
const table: Record<string, Factory> = {
  require: (ctx) =>
    native(ctx.builtins, {
      name: "require",
      length: 1,
      call: (_, args, site) => {
        const specifier = args[0]
        if (typeof specifier !== "string") throw typeError("require expects a module name string.")
        return ctx.module(specifier, site)
      },
    }),
  undefined: () => undefined,
  NaN: () => NaN,
  Infinity: () => Infinity,
  Object: (ctx) => objectGlobal(ctx),
  Function: (ctx) => functionGlobal(ctx),
  Array: (ctx) => arrayGlobal(ctx),
  Math: (ctx) => mathGlobal(ctx),
  JSON: (ctx) => jsonGlobal(ctx),
  console: (ctx) => consoleGlobal(ctx),
  Promise: (ctx) => promiseGlobal(ctx),
  Symbol: (ctx) => symbolGlobal(ctx),
  Iterator: (ctx) => iteratorGlobals(ctx),
  Number: (ctx) => numberGlobal(ctx),
  BigInt: (ctx) => bigintGlobal(ctx),
  String: (ctx) => stringGlobal(ctx),
  Boolean: (ctx) => booleanGlobal(ctx),
  parseInt: (ctx) => coercion(ctx, "parseInt", 2),
  parseFloat: (ctx) => coercion(ctx, "parseFloat"),
  isFinite: (ctx) => coercion(ctx, "isFinite"),
  isNaN: (ctx) => coercion(ctx, "isNaN"),
  Date: (ctx) => dateGlobal(ctx),
  RegExp: (ctx) => regexpGlobal(ctx),
  Map: (ctx) => mapGlobal(ctx),
  Set: (ctx) => setGlobal(ctx),
  WeakMap: (ctx) => weakMapGlobal(ctx),
  WeakSet: (ctx) => weakSetGlobal(ctx),
  URL: (ctx) => urlGlobal(ctx),
  URLSearchParams: (ctx) => urlSearchParamsGlobal(ctx),
  Headers: (ctx) => headersGlobal(ctx),
  Uint8Array: (ctx) => uint8ArrayGlobal(ctx),
  // Built on the host's Buffer, so only where there is one (Node and Bun, not browsers).
  ...(typeof Buffer === "undefined" ? {} : { Buffer: <R>(ctx: Interpreter<R>) => bufferGlobal(ctx) }),
  ArrayBuffer: (ctx) => arrayBufferGlobal(ctx),
  Uint16Array: (ctx) => typedArrayGlobal(ctx, "Uint16Array"),
  Uint32Array: (ctx) => typedArrayGlobal(ctx, "Uint32Array"),
  Int32Array: (ctx) => typedArrayGlobal(ctx, "Int32Array"),
  Float32Array: (ctx) => typedArrayGlobal(ctx, "Float32Array"),
  Float64Array: (ctx) => typedArrayGlobal(ctx, "Float64Array"),
  TextEncoder: (ctx) => textEncoderGlobal(ctx),
  TextDecoder: (ctx) => textDecoderGlobal(ctx),
  encodeURI: (ctx) => uriGlobal(ctx, "encodeURI"),
  encodeURIComponent: (ctx) => uriGlobal(ctx, "encodeURIComponent"),
  decodeURI: (ctx) => uriGlobal(ctx, "decodeURI"),
  decodeURIComponent: (ctx) => uriGlobal(ctx, "decodeURIComponent"),
  atob: (ctx) => base64Global(ctx, "atob"),
  btoa: (ctx) => base64Global(ctx, "btoa"),
  crypto: (ctx) => cryptoGlobal(ctx),
  structuredClone: (ctx) => structuredCloneGlobal(ctx),
  ...Object.fromEntries(errorTypes.map((type) => [type, <R>(ctx: Interpreter<R>) => errorGlobal(type, ctx)])),
}

/** The globals only a runtime with `typedArrays` binds; the others are bound in every program. */
export const typedArrayGlobals: ReadonlySet<string> = new Set([
  "ArrayBuffer",
  "Uint16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
])

/** Names bound in every program before extensions apply. */
export const globalNames: ReadonlySet<string> = new Set(
  Object.keys(table).filter((name) => !typedArrayGlobals.has(name)),
)

/** The immutable global bindings of every program, in declaration order. */
export const globals = <R>(ctx: Interpreter<R>): ReadonlyArray<readonly [string, Value]> => {
  generatorGlobals(ctx)
  return Object.entries(table).map(([name, factory]) => [name, factory(ctx)] as const)
}
