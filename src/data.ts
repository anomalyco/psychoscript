import type { Json } from "./snapshot/codec.js"
import type { functionMarker } from "./runtime/contract.js"
import type { Interpreter } from "./runtime/interpreter.js"
import { Arr, define, Obj, type Value } from "./runtime/objects.js"

export type { Json }

/**
 * A run's result: JSON, which under `translate: { functions: "mark" }` also holds `Host.functionMarker` where each
 * function was. Without it, it is plain `Json`.
 */
export type Data =
  | null
  | boolean
  | number
  | string
  | typeof functionMarker
  | ReadonlyArray<Data>
  | { readonly [key: string]: Data }

/** Host JSON as program values: objects and arrays are copied, primitives pass through. */
export const fromJson = <R>(ctx: Interpreter<R>, value: Json | undefined): Value => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value))
    return new Arr(
      ctx.builtins.Array,
      value.map((item) => fromJson(ctx, item)),
    )
  const copied = new Obj(ctx.builtins.Object)
  for (const [key, item] of Object.entries(value)) define(copied, key, fromJson(ctx, item))
  return copied
}
