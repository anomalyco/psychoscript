import type { Builtins } from "./intrinsics.js"
import { typeError } from "./model.js"
import {
  Bytes,
  type Callable,
  define,
  frozen,
  hidden,
  Native,
  type NativeCall,
  type NativeOptions,
  Obj,
  positionIterator,
  type PositionSource,
  type Value,
} from "./objects.js"
import { describeValue } from "./references.js"

/** A native function body: a value, a thrown `PendingThrow`, or what the VM carries out as the call. */
export type Impl = NativeCall

export const native = (builtins: Builtins, options: NativeOptions): Native => new Native(builtins.Function, options)

export const fn = (builtins: Builtins, name: string, length: number, impl: Impl): Native =>
  native(builtins, { name, length, call: impl })

export type Method = readonly [name: string, length: number, impl: Impl]

export const methods = (builtins: Builtins, target: Obj, table: ReadonlyArray<Method>): void => {
  for (const [name, length, impl] of table) define(target, name, fn(builtins, name, length, impl), hidden)
}

/** `keys`, `values`, and `entries`: built-in iterators over the receiver `self` checks. */
export const iteratorMethods = (
  builtins: Builtins,
  self: (thisValue: Value, name: string) => PositionSource,
): Array<Method> =>
  (["keys", "values", "entries"] as const).map((kind) => [
    kind,
    0,
    (thisValue) => positionIterator(builtins, self(thisValue, kind), kind),
  ])

export const constants = (target: Obj, table: Record<string, Value>): void => {
  for (const [name, value] of Object.entries(table)) define(target, name, value, frozen)
}

/** A constructor wired to its prototype: `C.prototype === proto` and `proto.constructor === C`. */
export const constructor = (builtins: Builtins, proto: Obj, options: NativeOptions): Native => {
  const ctor = native(builtins, options)
  define(ctor, "prototype", proto, frozen)
  define(proto, "constructor", ctor, hidden)
  return ctor
}

/** The `call` of a constructor that JS requires to be invoked with `new`. */
export const requiresNew = (name: string) => (): never => {
  throw typeError(`Constructor ${name} requires 'new'.`)
}

/** The instance prototype for `new` via `newTarget.prototype`, falling back to the built-in's own. */
export const prototypeFrom = (newTarget: Callable, fallback: Obj): Obj => {
  const proto = newTarget.props.get("prototype")
  return proto !== undefined && "value" in proto && proto.value instanceof Obj ? proto.value : fallback
}

/** A typed array receiver: a Uint8Array (or Buffer) for `uint8`, any typed array otherwise. */
export const typedReceiver: {
  (thisValue: Value, method: string, uint8: true): Bytes<Uint8Array>
  (thisValue: Value, method: string, uint8?: false): Bytes
} = ((thisValue: Value, method: string, uint8 = false) => {
  if (thisValue instanceof Bytes && (!uint8 || thisValue.isUint8())) return thisValue
  throw typeError(`${method} called on incompatible receiver ${describeValue(thisValue)}.`)
}) as never

/** Narrows a method receiver to the built-in it belongs to, or throws the TypeError JS would. */
export const receiver = <T extends Obj>(
  cls: abstract new (...args: never) => T,
  thisValue: Value,
  method: string,
): T => {
  if (thisValue instanceof cls) return thisValue
  throw typeError(`${method} called on incompatible receiver ${describeValue(thisValue)}.`)
}
