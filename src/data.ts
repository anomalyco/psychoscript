import type { Json } from "./snapshot/codec.js"
import type { Interpreter } from "./runtime/interpreter.js"
import { Arr, Obj, type Value } from "./runtime/objects.js"

export type { Json }

/** Host JSON as program values: objects and arrays are copied, primitives pass through. */
export const fromJson = <R>(ctx: Interpreter<R>, value: Json | undefined): Value => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value))
    return new Arr(
      ctx.builtins.Array,
      value.map((item) => (item === null || typeof item !== "object" ? item : fromJson(ctx, item))),
    )
  // A fresh ordinary object: defining a key is adding its default data slot.
  const copied = new Obj(ctx.builtins.Object)
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    const item = (value as { readonly [key: string]: Json })[key]!
    copied.props.set(key, {
      value: item === null || typeof item !== "object" ? item : fromJson(ctx, item),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return copied
}
