import { isSupportedCallback, requireCallback, withReads } from "../runtime/callback.js"
import type { Builtins } from "../runtime/intrinsics.js"
import { SORT_RUN, sortKeys, sorted, type SortInto } from "../stdlib/array.js"
import { finishBytes } from "../stdlib/bytes.js"
import { weakKey } from "../stdlib/collections.js"
import { buildPairs } from "../stdlib/url.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { checkArrayLength, MAX_ARRAY_LENGTH } from "../runtime/limits.js"
import { AsyncIteratorSymbol, invalidData, IteratorSymbol, PendingThrow } from "../runtime/model.js"
import { native, receiver } from "../runtime/native.js"
import {
  Arr,
  Bytes,
  coerceToString,
  data,
  define,
  hidden,
  hasPrototype,
  keys,
  getOwn,
  own,
  ownKeys,
  IteratorObj,
  positionIterator,
  coerceToInteger,
  coerceToNumber,
  get,
  MapObj,
  type NativeResult,
  Obj,
  PromiseObj,
  SetObj,
  type Value,
  WeakMapObj,
  WeakSetObj,
} from "../runtime/objects.js"
import { builtinCursor, requireIteratorObject } from "../runtime/operations.js"
import { containsOpaqueReference, describeValue, isOpaque } from "../runtime/references.js"
import { compareText } from "../runtime/operations.js"
import { Invoke } from "../runtime/signals.js"
import { SnapshotError } from "../snapshot/codec.js"

// The prelude's privileged helpers: leaf built-ins (they never call program code) bound only in the prelude's scope.
//
// The prelude keeps its working state in registers, and a forged snapshot can fill those with anything and resume at
// any instruction. So each helper checks what it is given before it trusts it: a value no prelude code passes is a
// SnapshotError, never a host crash, a hang, or an error the program could catch.

type Helper = readonly [length: number, call: (args: Array<Value>) => NativeResult]

const classes = { Array: Arr, Uint8Array: Bytes, Map: MapObj, Set: SetObj } as const

// Bun exposes ES2026 Math.sumPrecise before TypeScript's standard library types.
declare global {
  interface Math {
    sumPrecise(values: Iterable<number>): number
  }
}

export const helpers = (ctx: Interpreter<unknown>): Array<readonly [string, Value]> => {
  const builtins = ctx.builtins
  const helpers: Record<string, Helper> = {
    /** Throws a program error of `type` ("TypeError", "RangeError", or "InvalidData") with `message`. */
    $Throw: [
      2,
      ([type, message]) => {
        if (type === "InvalidData") throw invalidData(String(message))
        if (type !== "TypeError" && type !== "RangeError") return forged("an error type is unknown.")
        throw new PendingThrow(type, String(message))
      },
    ],
    /** The callback itself, or the TypeError for one a callback site doesn't admit. */
    $Callback: [2, ([value, label]) => requireCallback(value, String(label))],
    /** Calls `fn` with a receiver and arguments, as `Function.prototype.call` would, without reading `call`. */
    $Call: [2, ([fn, thisArg, ...args]) => new Invoke(fn, thisArg, args, undefined)],
    /** The receiver, when it is the built-in kind `kind` names, or the TypeError for any other. */
    $Receiver: [
      3,
      ([value, kind, method]) =>
        typeof kind === "string" && Object.hasOwn(classes, kind)
          ? receiver<Obj>(classes[kind as keyof typeof classes], value, String(method))
          : forged("a receiver kind is unknown."),
    ],
    /** Whether `value` is an object; with `data`, one holding no opaque reference. */
    $IsObject: [2, ([value, data]) => value instanceof Obj && !(data === true && containsOpaqueReference(value))],
    /** Whether `for...of` can iterate `value`. */
    $IsIterable: [
      1,
      ([value]) =>
        withReads(() => {
          if (builtinCursor(builtins, value) !== undefined) return true
          if (!(value instanceof Obj)) return false
          const method = get(value, IteratorSymbol)
          return method !== undefined && method !== null
        }),
    ],
    $Describe: [1, ([value]) => describeValue(value)],
    $Inherits: [2, ([value, proto]) => hasPrototype(value, object(proto))],
    /** An object's own enumerable string keys. */
    $Keys: [1, ([value]) => new Arr(builtins.Array, keys(object(value)))],
    /**
     * An object's own keys as the copying built-ins visit them: strings and the iterator symbols, or only strings, less
     * `excluded` (canonical keys). Each is checked for enumerability when it is visited (`$IsEnumerableOwn`).
     */
    $OwnKeys: [
      3,
      ([value, strings, excluded]) => {
        const skip = excluded instanceof Arr ? new Set(excluded.items) : undefined
        return new Arr(
          builtins.Array,
          ownKeys(object(value)).filter(
            (key) =>
              (typeof key === "string" ||
                (strings !== true && (key === IteratorSymbol || key === AsyncIteratorSymbol))) &&
              skip?.has(key) !== true,
          ),
        )
      },
    ],
    $IsEnumerableOwn: [2, ([value, key]) => own(object(value), propertyKey(key))?.enumerable === true],
    /** Defines an own data property, enumerable or hidden, and returns the object. */
    $Define: [
      4,
      ([target, key, value, enumerable]) => {
        define(object(target), propertyKey(key), value, enumerable === true ? data : hidden)
        return target
      },
    ],
    /** Writes an element of a prelude-made array without going through the prototype chain. */
    $ArraySet: [
      3,
      ([array, index, value]) => {
        // Within the array limit, so a forged index can't make an array no program could.
        list(array).items[position(index, MAX_ARRAY_LENGTH - 1)] = value
        return value
      },
    ],
    /** An array-like's length, as ToLength gives it, capped like arrays. */
    $Length: [
      1,
      ([value]) => {
        const length = Math.max(0, coerceToInteger(value))
        checkArrayLength(length)
        return length
      },
    ],
    $SumPrecise: [
      1,
      ([numbers]) => {
        const items = list(numbers).items
        if (!items.every((item) => typeof item === "number")) return forged("a sum's values are not numbers.")
        return Math.sumPrecise(items as Array<number>)
      },
    ],
    /** A Uint8Array of the values (see `collectBytes`). */
    $Bytes: [
      3,
      ([values, into, offset]) => {
        const items = list(values).items
        checkArrayLength(items.length)
        return finishBytes(Uint8Array.from(items, coerceToNumber), object(into), offset as number)
      },
    ],
    /** A Uint8Array of the values, of the same kind as the Uint8Array `source`: a Buffer's map makes a Buffer. */
    $DerivedBytes: [
      2,
      ([values, source]) => {
        const items = list(values).items
        checkArrayLength(items.length)
        if (!(source instanceof Bytes)) return forged("a Uint8Array's source is not one.")
        return source.derive(builtins, Uint8Array.from(items, coerceToNumber))
      },
    ],
    /** Headers or URLSearchParams from the pairs `readPairs` read, or from a record. */
    $Pairs: [
      4,
      ([kind, proto, value, label]) => {
        if (kind !== "Headers" && kind !== "URLSearchParams") return forged("a kind of pairs is unknown.")
        const into = object(proto)
        return withReads(() => buildPairs({ kind, proto: into }, value, String(label)))
      },
    ],
    $IsCallable: [1, ([value]) => isSupportedCallback(value)],
    /**
     * An iterator object as `for...of` steps it, reading `next` once and calling it only then (GetIteratorDirect);
     * with `arrays`, an array's values.
     */
    $Direct: [
      2,
      ([value, arrays]) =>
        arrays === true && value instanceof Arr
          ? positionIterator(builtins, value, "values")
          : value instanceof IteratorObj
            ? value
            : withReads(
                () =>
                  new IteratorObj(builtins.Iterator, {
                    iterator: requireIteratorObject(value, "An iterator"),
                    next: get(value as Obj, "next"),
                    asynchronous: false,
                  }),
              ),
    ],
    /** A sort's result written where it goes (see `sortWith`): the defined values in order, then `undefs` undefined. */
    $Sorted: [
      5,
      ([target, into, holes, values, undefs]) => {
        if (!(target instanceof Arr || target instanceof Bytes)) return forged("a sort's target is not an array.")
        if (!sortInto.has(into)) return forged("a sort's kind is unknown.")
        const items = list(values).items
        const count = position(undefs, MAX_ARRAY_LENGTH - items.length)
        const result = [...items, ...Array<Value>(count).fill(undefined)]
        position(holes, result.length)
        if (target instanceof Bytes && result.length > target.bytes.length) return forged("a sort has more values than its target.")
        return sorted(builtins, target, into as SortInto, holes as number, result)
      },
    ],
    /** Ends one merge of `sortWith`: the runs' remaining values after the merged ones, then all of them back in `work`. */
    $MergeRest: [
      8,
      ([work, merged, count, left, middle, right, high, low]) => {
        const items = list(work).items
        const out = list(merged).items
        // A merge of [low, high) whose first `count` values are written, up to `left` and `right` in its two runs.
        const end = position(high, items.length)
        const start = position(low, end)
        const split = position(middle, end)
        const from = position(left, split)
        const to = position(right, end)
        if (from < start || to < split || position(count, out.length) !== from - start + to - split)
          return forged("a merge's positions do not fit together.")
        out.length = count as number
        for (let at = from; at < split; at++) out.push(items[at])
        for (let at = to; at < end; at++) out.push(items[at])
        for (let at = 0; at < out.length; at++) items[start + at] = out[at]
        return undefined
      },
    ],
    $SortState: [1, ([values]) => sortState(builtins, list(values))],
    $SortStep: [1, ([state]) => sortStep(sortSlots(state))],
    $SortResult: [
      2,
      ([state, values]) => {
        const items = list(values).items
        const order = sortSlots(state).order
        if (order.length !== items.length) return forged("a sort's order does not fit its values.")
        return new Arr(
          builtins.Array,
          order.map((at) => items[position(at, items.length - 1)]),
        )
      },
    ],
    /** What the collection built-ins need from a Map, Set, WeakMap, or WeakSet's table; see `table`. */
    $Table: [
      4,
      ([op, target, key, value]) =>
        typeof op === "string" ? table(builtins, op, target, key, value) : forged("a collection operation is unknown."),
    ],
  }
  return Object.entries(helpers).map(([name, [length, call]]) => [
    name,
    native(builtins, { name, length, call: (_, args) => call(args), callback: false }),
  ])
}

const table = (builtins: Builtins, op: string, target: Value, key: Value, value: Value): Value => {
  switch (op) {
    case "add":
      if (target instanceof MapObj) target.map.set(key, value)
      else if (target instanceof SetObj) target.set.add(key)
      else if (target instanceof WeakMapObj) target.map.set(weakKey(key, "as weak map key"), value)
      else if (target instanceof WeakSetObj) target.set.add(weakKey(key, "in weak set"))
      else forged("a collection is not one.")
      return undefined
    case "delete":
      return set(target).set.delete(key)
    case "has":
      return set(target).set.has(key)
    case "size":
      return set(target).set.size
    case "copy": {
      const copy = new SetObj(builtins.Set)
      for (const item of set(target).set.liveKeys()) copy.set.add(item)
      return copy
    }
    case "values":
      return positionIterator(builtins, set(target), "values")
    case "entries":
      return positionIterator(
        builtins,
        target instanceof MapObj ? target : set(target),
        "entries",
      )
    case "groups":
      return target === "Map" ? new MapObj(builtins.Map) : new Obj(null)
    case "groupKey":
      if (target instanceof PromiseObj) return coerceToString(target)
      if (isOpaque(target)) {
        throw invalidData(`Object.groupBy callback must return a data value, received ${describeValue(target)}.`)
      }
      return target
    case "group": {
      if (target instanceof MapObj) {
        const group = target.map.get(key)
        if (group === undefined) target.map.set(key, new Arr(builtins.Array, [value]))
        else list(group).items.push(value)
        return undefined
      }
      const groups = object(target)
      const name = propertyKey(key)
      const group = getOwn(groups, name)
      if (group === undefined) define(groups, name, new Arr(builtins.Array, [value]))
      else list(group).items.push(value)
      return undefined
    }
  }
  return forged(`the collection operation ${op} is unknown.`)
}

const forged = (what: string): never => {
  throw new SnapshotError(`Invalid snapshot: ${what}`)
}

const list = (value: Value): Arr => (value instanceof Arr ? value : forged("a prelude array is not an array."))

const object = (value: Value): Obj => (value instanceof Obj ? value : forged("a prelude object is not an object."))

const set = (value: Value): SetObj => (value instanceof SetObj ? value : forged("a Set is not one."))

const propertyKey = (value: Value): string | symbol =>
  typeof value === "string" || typeof value === "symbol" ? value : forged("a property key is not one.")

/** `value` as a position from 0 to `max`. */
const position = (value: unknown, max: number): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
    ? (value as number)
    : forged("a position is out of range.")

const sortInto = new Set<unknown>(["Array.sort", "Array.toSorted", "Uint8Array.sort", "Uint8Array.toSorted"])

// The most values one merge step writes.
const MERGE_STEP = 65_536

/**
 * A default sort's state, as data: the values' string keys, the order so far and a buffer (indices into the values),
 * the next run to sort, and the merge pass's run width, output position, and positions in its two runs. Runs of
 * SORT_RUN are sorted first, then merged in passes of doubling width from the order into the buffer, which swap.
 */
const sortState = (builtins: Builtins, values: Arr): Arr => {
  const keys = sortKeys(values.items)
  const order = keys.map((_, at) => at)
  return new Arr(builtins.Array, [
    new Arr(builtins.Array, keys),
    new Arr(builtins.Array, order),
    new Arr(builtins.Array, [...order]),
    0,
    SORT_RUN,
    0,
    0,
    0,
  ])
}

/** A default sort's state, checked where it is cheap to: its scalars, and that its lists have the same length. */
type SortSlots = {
  readonly slots: Array<Value>
  readonly keys: ReadonlyArray<Value>
  readonly order: Array<Value>
  readonly buffer: Array<Value>
}

const sortSlots = (state: Value): SortSlots => {
  const slots = list(state).items
  if (slots.length !== 8 || !(slots[0] instanceof Arr) || !(slots[1] instanceof Arr) || !(slots[2] instanceof Arr))
    return forged("a sort's state is malformed.")
  const keys = slots[0].items
  const length = keys.length
  if (slots[1].items.length !== length || slots[2].items.length !== length)
    return forged("a sort's lists differ in length.")
  position(slots[3], length)
  // A width of 0 would never finish a merge pass.
  if (position(slots[4], Number.MAX_SAFE_INTEGER) === 0) return forged("a sort's merge width is 0.")
  position(slots[5], length)
  position(slots[6], length)
  position(slots[7], length)
  return { slots, keys, order: slots[1].items, buffer: slots[2].items }
}

// One bounded step of a default sort: one run sorted, or up to MERGE_STEP values merged. Whether work remains. The
// positions it reads from the order are checked as they are read, since checking every one would cost a pass.
const sortStep = (state: SortSlots): boolean => {
  const slots = state.slots
  const keys = state.keys
  const from = state.order
  const length = keys.length
  const run = slots[3] as number
  const width = slots[4] as number
  const key = (at: Value) => {
    const found = keys[position(at, length - 1)]
    return typeof found === "string" || typeof found === "number" || typeof found === "bigint"
      ? found
      : forged("a sort key is malformed.")
  }
  const compare = (left: Value, right: Value) => compareText(key(left) as string, key(right) as string)
  if (run < length) {
    const end = Math.min(run + SORT_RUN, length)
    const part = from.slice(run, end).sort(compare)
    for (let at = 0; at < part.length; at++) from[run + at] = part[at]!
    slots[3] = end
    return end < length || width < length
  }
  const to = state.buffer
  let out = slots[5] as number
  let left = slots[6] as number
  let right = slots[7] as number
  const stop = Math.min(out + MERGE_STEP, length)
  while (out < stop) {
    const low = out - (out % (2 * width))
    const middle = Math.min(low + width, length)
    const high = Math.min(low + 2 * width, length)
    if (out === low) {
      left = low
      right = middle
    }
    while (out < high && out < stop) {
      to[out++] = left < middle && (right >= high || compare(from[left]!, from[right]!) <= 0) ? from[left++]! : from[right++]!
    }
  }
  if (out === length) {
    const merged = slots[2]
    slots[2] = slots[1]
    slots[1] = merged
    slots[4] = width * 2
    out = 0
  }
  slots[5] = out
  slots[6] = left
  slots[7] = right
  return (slots[4] as number) < length
}
