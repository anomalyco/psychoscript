import { Invoke } from "../runtime/signals.js"
import { checkStringLength, MAX_ARRAY_LENGTH } from "../runtime/limits.js"
import { constructor, methods, prototypeFrom, receiver, requiresNew, iteratorMethods } from "../runtime/native.js"
import { IteratorSymbol, rangeError, typeError } from "../runtime/model.js"
import {
  Arr,
  ArrayBufferObj,
  Callable,
  DataViewObj,
  define,
  defineAccessor,
  frozen,
  get,
  hasPrototype,
  hidden,
  Native,
  Obj,
  coerceToNumber,
  coerceToString,
  typedArray,
  TypedArrayObj,
  typedArrayKinds,
  typedArrayTypes,
  type HostTypedArray,
  type TypedArrayKind,
  type Value,
} from "../runtime/objects.js"
import type { Builtins } from "../runtime/intrinsics.js"
import { isSupportedCallback, requireCallback, withPrimitives, withReads } from "../runtime/callback.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { sortArray } from "./array.js"

const MAX_INDEX = 2 ** 53 - 1

/** ToNumber on each value, in order, after ToPrimitive (which may call program code; see `withPrimitives`). */
const numbers = (values: Array<Value>, body: (numbers: Array<number>) => ReturnType<typeof withPrimitives>) =>
  withPrimitives("number", values, (primitives) => body(primitives.map(coerceToNumber)), true)

/** ToIntegerOrInfinity on a number. */
const integer = (value: number): number => (Number.isNaN(value) ? 0 : Math.trunc(value) + 0)

/** ToIndex on a number: a RangeError for a negative or unsafe one. */
export const toIndex = (value: number, what: string): number => {
  const index = integer(value)
  if (index < 0 || index > MAX_INDEX) throw rangeError(`Invalid ${what}: ${String(value)}`)
  return index
}

/** A relative index (`slice`, `fill`, `subarray`) clamped to `[0, length]`; `undefined` stands for `fallback`. */
const relative = (raw: Value, value: number, length: number, fallback: number): number => {
  if (raw === undefined) return fallback
  const index = integer(value)
  return index < 0 ? Math.max(length + index, 0) : Math.min(index, length)
}

/** Memory for a typed array or buffer: within the cap on what one built-in may allocate. */
const checkBytes = (bytes: number, message: string): void => {
  if (bytes > MAX_ARRAY_LENGTH) throw rangeError(message)
}

const allocate = (kind: TypedArrayKind, length: number, proto: Obj): TypedArrayObj => {
  checkBytes(length * typedArrayTypes[kind].BYTES_PER_ELEMENT, `Invalid typed array length: ${length}`)
  return typedArray(proto, new typedArrayTypes[kind](length))
}

/** An array whose elements are all numbers, readable without running program code. */
const plainNumbers = (builtins: Builtins, value: Value): ReadonlyArray<number> | undefined => {
  if (!(value instanceof Arr) || value.hasProgramAccessors || value.iterator(builtins) === undefined) return undefined
  const items = value.items
  for (let index = 0; index < items.length; index++) if (typeof items[index] !== "number") return undefined
  return items as ReadonlyArray<number>
}

/**
 * A typed array's values read from `source` in the prelude (`collectTyped`): a new typed array of `kind` with
 * prototype `into`, or set into the typed array `into` at `offset`. `iterate` reads an iterable source through its
 * iterator (the constructor and `from`); otherwise, and for a source without one, it is read as an array-like.
 */
export const collectTyped = <R>(
  ctx: Interpreter<R>,
  source: Value,
  name: string,
  into: Obj,
  offset: number,
  kind: TypedArrayKind | undefined,
  iterate: boolean,
  mapper?: Value,
  thisArg?: Value,
): Value | Invoke => {
  const callback = mapper === undefined ? undefined : requireCallback(mapper, name)
  if (callback === undefined && kind !== undefined) {
    const items = source instanceof TypedArrayObj ? source.array : plainNumbers(ctx.builtins, source)
    if (items !== undefined) return finishTyped(items, into, offset, kind)
  }
  if (source === null || source === undefined) throw typeError(`${name} cannot read values from ${String(source)}.`)
  return new Invoke(
    ctx.prelude.fn("collectTyped"),
    undefined,
    [source, name, callback, thisArg, into, offset, kind, iterate],
    undefined,
  )
}

/** Checks that `length` values fit `into` at `offset`, or that a new typed array of `kind` may hold them. */
export const checkTypedLength = (length: number, into: Obj, offset: number, kind: TypedArrayKind): void => {
  if (into instanceof TypedArrayObj) {
    if (length + offset > into.array.length) throw rangeError("offset is out of bounds")
    return
  }
  checkBytes(length * typedArrayTypes[kind].BYTES_PER_ELEMENT, `Invalid typed array length: ${length}`)
}

export const finishTyped = (
  values: ArrayLike<number>,
  into: Obj,
  offset: number,
  kind: TypedArrayKind,
): TypedArrayObj | undefined => {
  checkTypedLength(values.length, into, offset, kind)
  if (into instanceof TypedArrayObj) {
    into.array.set(values as never, offset)
    return undefined
  }
  return typedArray(into, typedArrayTypes[kind].from(values as never))
}

/** The kind and instance prototype of the typed array constructor `ctor` (`this` of `from` and `of`). */
const constructed = (
  builtins: Builtins,
  ctor: Value,
  name: string,
): { proto: Obj; kind: TypedArrayKind | undefined } => {
  const proto = ctor instanceof Callable ? get(ctor, "prototype") : undefined
  // %TypedArray% is a constructor that throws when it constructs, after the source is read.
  if (proto === builtins.TypedArray) return { proto, kind: undefined }
  if (proto instanceof Obj) {
    for (const kind of typedArrayKinds) {
      if (proto === builtins[kind] || hasPrototype(proto, builtins[kind])) return { proto, kind }
    }
  }
  throw typeError(`${name}: this is not a typed array constructor.`)
}

const constructTyped = <R>(ctx: Interpreter<R>, kind: TypedArrayKind, args: Array<Value>, proto: Obj) => {
  const source = args[0]
  if (!(source instanceof Obj)) {
    return numbers([source], ([length]) => allocate(kind, toIndex(length!, "typed array length"), proto))
  }
  if (source instanceof ArrayBufferObj) return viewOf(kind, source, args, proto)
  if (source instanceof TypedArrayObj) {
    checkTypedLength(source.array.length, proto, 0, kind)
    return typedArray(proto, new typedArrayTypes[kind](source.array as never))
  }
  return collectTyped(ctx, source, `new ${kind}(...)`, proto, 0, kind, true)
}

// InitializeTypedArrayFromArrayBuffer: a view that shares the buffer's memory.
const viewOf = (kind: TypedArrayKind, buffer: ArrayBufferObj, args: Array<Value>, proto: Obj) => {
  const size = typedArrayTypes[kind].BYTES_PER_ELEMENT
  return numbers([args[1]], ([rawOffset]) => {
    const offset = toIndex(rawOffset!, "typed array offset")
    if (offset % size !== 0) throw rangeError(`Start offset of ${kind} should be a multiple of ${size}`)
    return numbers([args[2]], ([rawLength]) => {
      const length = args[2] === undefined ? undefined : toIndex(rawLength!, "typed array length")
      const available = buffer.data.byteLength
      let bytes: number
      if (length === undefined) {
        if (available % size !== 0) throw rangeError(`Byte length of ${kind} should be a multiple of ${size}`)
        bytes = available - offset
        if (bytes < 0) throw rangeError(`Start offset ${offset} is outside the bounds of the buffer`)
      } else {
        bytes = length * size
        if (offset + bytes > available) throw rangeError(`Invalid typed array length: ${length}`)
      }
      return typedArray(proto, new typedArrayTypes[kind](buffer.data, offset, bytes / size), buffer)
    })
  })
}

const bases = new WeakMap<Builtins, Native>()

/** %TypedArray%: the abstract constructor every typed array constructor inherits from, with the shared methods. */
const typedArrayBase = <R>(ctx: Interpreter<R>): Native => {
  const builtins = ctx.builtins
  const known = bases.get(builtins)
  if (known !== undefined) return known
  const proto = builtins.TypedArray
  const abstract = (): never => {
    throw typeError("Abstract class TypedArray not directly constructable")
  }
  const base = constructor(builtins, proto, { name: "TypedArray", length: 0, call: abstract, construct: abstract })
  bases.set(builtins, base)

  methods(builtins, base, [
    [
      "from",
      1,
      (thisValue, args) => {
        const { proto: into, kind } = constructed(builtins, thisValue, "TypedArray.from")
        const mapper = args[1]
        if (mapper !== undefined && !isSupportedCallback(mapper))
          requireCallback(mapper, `${kind ?? "TypedArray"}.from`)
        return collectTyped(ctx, args[0], `${kind ?? "TypedArray"}.from`, into, 0, kind, true, mapper, args[2])
      },
    ],
    [
      "of",
      0,
      (thisValue, args) => {
        const { proto: into, kind } = constructed(builtins, thisValue, "TypedArray.of")
        if (kind === undefined) throw typeError("Abstract class TypedArray not directly constructable")
        return collectTyped(ctx, new Arr(builtins.Array, args), `${kind}.of`, into, 0, kind, false)
      },
    ],
  ])

  const self = (thisValue: Value, name: string) => receiver(TypedArrayObj, thisValue, `%TypedArray%.prototype.${name}`)
  const same = (target: TypedArrayObj, array: HostTypedArray) => typedArray(builtins[target.tag], array)
  const comparator = (value: Value, name: string) => {
    if (value !== undefined && !isSupportedCallback(value)) requireCallback(value, name)
    return value
  }
  // Searches: the start index converts even when nothing can match; a non-number never matches an element.
  const search = (
    name: "includes" | "indexOf" | "lastIndexOf",
    thisValue: Value,
    args: Array<Value>,
    missing: boolean | number,
  ) => {
    const array = self(thisValue, name).array
    if (array.length === 0) return missing
    return numbers([args[1]], ([from]) => {
      if (typeof args[0] !== "number") return missing
      const start = name === "lastIndexOf" && args.length < 2 ? array.length - 1 : integer(from!)
      return (array[name] as (value: number, from: number) => boolean | number)(args[0], start)
    })
  }

  defineAccessor(proto, "buffer", (thisValue) => self(thisValue, "buffer").bufferObj(builtins))
  defineAccessor(proto, "byteLength", (thisValue) => self(thisValue, "byteLength").array.byteLength)
  defineAccessor(proto, "byteOffset", (thisValue) => self(thisValue, "byteOffset").array.byteOffset)
  defineAccessor(proto, "length", (thisValue) => self(thisValue, "length").array.length)
  methods(builtins, proto, [
    [
      "at",
      1,
      (thisValue, args) => {
        const array = self(thisValue, "at").array
        return numbers([args[0]], ([raw]) => {
          const index = integer(raw!)
          const at = index >= 0 ? index : array.length + index
          return at < 0 || at >= array.length ? undefined : array[at]
        })
      },
    ],
    [
      "copyWithin",
      2,
      (thisValue, args) => {
        const array = self(thisValue, "copyWithin").array
        return numbers([args[0], args[1], args[2]], ([target, start, end]) => {
          const length = array.length
          array.copyWithin(
            relative(args[0], target!, length, 0),
            relative(args[1], start!, length, 0),
            relative(args[2], end!, length, length),
          )
          return thisValue
        })
      },
    ],
    ...iteratorMethods(builtins, self),
    [
      "fill",
      1,
      (thisValue, args) => {
        const array = self(thisValue, "fill").array
        return numbers([args[0], args[1], args[2]], ([value, start, end]) => {
          const length = array.length
          array.fill(value!, relative(args[1], start!, length, 0), relative(args[2], end!, length, length))
          return thisValue
        })
      },
    ],
    ["includes", 1, (thisValue, args) => search("includes", thisValue, args, false)],
    ["indexOf", 1, (thisValue, args) => search("indexOf", thisValue, args, -1)],
    ["lastIndexOf", 1, (thisValue, args) => search("lastIndexOf", thisValue, args, -1)],
    [
      "join",
      1,
      (thisValue, args) => {
        const array = self(thisValue, "join").array
        return withPrimitives("string", [args[0]], ([separator]) => {
          const joined = array.join(separator === undefined ? "," : coerceToString(separator))
          checkStringLength(joined.length)
          return joined
        })
      },
    ],
    [
      "reverse",
      0,
      (thisValue) => {
        self(thisValue, "reverse").array.reverse()
        return thisValue
      },
    ],
    [
      "set",
      1,
      (thisValue, args) => {
        const target = self(thisValue, "set")
        return numbers([args[1]], ([raw]) => {
          const offset = integer(raw!)
          if (offset < 0) throw rangeError("offset is out of bounds")
          return collectTyped(ctx, args[0], "TypedArray.prototype.set", target, offset, target.tag, false)
        })
      },
    ],
    [
      "slice",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "slice")
        return numbers([args[0], args[1]], ([start, end]) => {
          const length = target.array.length
          return target.derive(
            builtins,
            target.array.slice(relative(args[0], start!, length, 0), relative(args[1], end!, length, length)),
          )
        })
      },
    ],
    [
      "sort",
      1,
      (thisValue, args) => {
        const compare = comparator(args[0], "TypedArray.prototype.sort")
        const target = self(thisValue, "sort")
        if (compare === undefined) {
          target.array.sort()
          return target
        }
        return sortArray(ctx, target, compare, "TypedArray.sort")
      },
    ],
    // A view on the same memory, as in JS: writes through one are visible through the other.
    [
      "subarray",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "subarray")
        return numbers([args[0], args[1]], ([start, end]) => {
          const array = target.array
          const length = array.length
          const begin = relative(args[0], start!, length, 0)
          const count = Math.max(relative(args[1], end!, length, length) - begin, 0)
          const view = new typedArrayTypes[target.tag](
            target.memory,
            array.byteOffset + begin * array.BYTES_PER_ELEMENT,
            count,
          )
          return target.derive(builtins, view, target.bufferObj(builtins))
        })
      },
    ],
    [
      "toReversed",
      0,
      (thisValue) => same(self(thisValue, "toReversed"), self(thisValue, "toReversed").array.toReversed()),
    ],
    [
      "toSorted",
      1,
      (thisValue, args) => {
        const compare = comparator(args[0], "TypedArray.prototype.toSorted")
        const target = self(thisValue, "toSorted")
        const copy = same(target, target.array.slice())
        if (compare === undefined) {
          copy.array.sort()
          return copy
        }
        return sortArray(ctx, copy, compare, "TypedArray.sort")
      },
    ],
    ["toString", 0, (thisValue) => self(thisValue, "toString").array.join(",")],
    [
      "with",
      2,
      (thisValue, args) => {
        const target = self(thisValue, "with")
        return numbers([args[0], args[1]], ([raw, value]) => {
          const length = target.array.length
          const index = integer(raw!)
          const at = index >= 0 ? index : length + index
          if (at < 0 || at >= length) throw rangeError("Invalid typed array index")
          const copy = target.array.slice()
          copy[at] = value!
          return same(target, copy)
        })
      },
    ],
    // The callback methods and toLocaleString are the prelude's.
  ])
  define(proto, IteratorSymbol, get(proto, "values"), hidden)
  return base
}

/** A typed array constructor, `Int8Array` … `Float64Array`, inheriting from %TypedArray%. */
export const typedArrayGlobal = <R>(ctx: Interpreter<R>, kind: TypedArrayKind): Native => {
  const builtins = ctx.builtins
  const base = typedArrayBase(ctx)
  const proto = builtins[kind]
  const ctor = constructor(builtins, proto, {
    name: kind,
    length: 3,
    call: requiresNew(kind),
    construct: (args, newTarget) => constructTyped(ctx, kind, args, prototypeFrom(newTarget, proto)),
  })
  ctor.proto = base
  const size = typedArrayTypes[kind].BYTES_PER_ELEMENT
  define(ctor, "BYTES_PER_ELEMENT", size, frozen)
  define(proto, "BYTES_PER_ELEMENT", size, frozen)
  return ctor
}

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
          checkBytes(length, "Array buffer allocation failed")
          return new ArrayBufferObj(prototypeFrom(newTarget, proto), new ArrayBuffer(length))
        })
      }),
  })
  methods(builtins, ctor, [
    ["isView", 1, (_, args) => args[0] instanceof TypedArrayObj || args[0] instanceof DataViewObj],
  ])
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

const viewTypes = [
  ["Int8", 1],
  ["Uint8", 1],
  ["Int16", 2],
  ["Uint16", 2],
  ["Int32", 4],
  ["Uint32", 4],
  ["Float16", 2],
  ["Float32", 4],
  ["Float64", 8],
  // TODO: BigInt64 and BigUint64, once programs have BigInt.
] as const

export const dataViewGlobal = <R>(ctx: Interpreter<R>): Native => {
  const builtins = ctx.builtins
  const proto = builtins.DataView
  const ctor = constructor(builtins, proto, {
    name: "DataView",
    length: 1,
    call: requiresNew("DataView"),
    construct: (args, newTarget) => {
      const buffer = args[0]
      if (!(buffer instanceof ArrayBufferObj)) {
        throw typeError(
          "First argument to DataView constructor must be an ArrayBuffer; for a Uint8Array `bytes`, use new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).",
        )
      }
      return numbers([args[1]], ([rawOffset]) => {
        const offset = toIndex(rawOffset!, "DataView offset")
        const available = buffer.data.byteLength
        if (offset > available) throw rangeError(`Start offset ${offset} is outside the bounds of the buffer`)
        return numbers([args[2]], ([rawLength]) => {
          const length = args[2] === undefined ? available - offset : toIndex(rawLength!, "DataView length")
          if (offset + length > available) throw rangeError(`Invalid DataView length ${length}`)
          return new DataViewObj(prototypeFrom(newTarget, proto), buffer, new DataView(buffer.data, offset, length))
        })
      })
    },
  })
  const self = (thisValue: Value, name: string) => receiver(DataViewObj, thisValue, `DataView.prototype.${name}`)
  defineAccessor(proto, "buffer", (thisValue) => self(thisValue, "buffer").buffer)
  defineAccessor(proto, "byteLength", (thisValue) => self(thisValue, "byteLength").view.byteLength)
  defineAccessor(proto, "byteOffset", (thisValue) => self(thisValue, "byteOffset").view.byteOffset)
  const bounds = (view: DataView, index: number, size: number) => {
    if (index + size > view.byteLength) throw rangeError("Offset is outside the bounds of the DataView")
  }
  type Accessors = Record<string, (index: number, value?: number, littleEndian?: boolean) => number | undefined>
  methods(
    builtins,
    proto,
    viewTypes.flatMap(([type, size]) => [
      [
        `get${type}`,
        1,
        (thisValue: Value, args: Array<Value>) => {
          const view = self(thisValue, `get${type}`).view
          return numbers([args[0]], ([raw]) => {
            const index = toIndex(raw!, "offset")
            bounds(view, index, size)
            return (view as unknown as Accessors)[`get${type}`]!.call(view, index, Boolean(args[1]) as never)
          })
        },
      ] as const,
      [
        `set${type}`,
        2,
        (thisValue: Value, args: Array<Value>) => {
          const view = self(thisValue, `set${type}`).view
          return numbers([args[0]], ([raw]) => {
            const index = toIndex(raw!, "offset")
            return numbers([args[1]], ([value]) => {
              bounds(view, index, size)
              ;(view as unknown as Accessors)[`set${type}`]!.call(view, index, value, Boolean(args[2]))
              return undefined
            })
          })
        },
      ] as const,
    ]),
  )
  return ctor
}
