import { methods } from "../runtime/native.js"
import { requireCallback } from "../runtime/callback.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { syntaxError } from "../runtime/model.js"
import { typeofValue } from "../runtime/references.js"
import { fromJson, type Json } from "../data.js"
import { Arr, Obj, coerceToString, define, record, type Value } from "../runtime/objects.js"
import { Invoke, Push } from "../runtime/signals.js"

export const jsonGlobal = <R>(ctx: Interpreter<R>) => {
  const json = new Obj(ctx.builtins.Object)
  methods(ctx.builtins, json, [
    ["parse", 2, (_, args) => parse(ctx, args)],
    ["stringify", 3, (_, args) => stringify(args)],
  ])
  return json
}

const parse = <R>(ctx: Interpreter<R>, args: Array<Value>) => {
  // A plain object or an array is a value that was parsed already: return it unchanged, rather than parse its text
  // ("[object Object]", or the array's elements joined).
  const input = args[0]
  if (input instanceof Arr || (input instanceof Obj && Object.getPrototypeOf(input) === Obj.prototype)) return input
  const text = coerceToString(input)

  const json = (() => {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw syntaxError(`JSON.parse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  if (typeofValue(args[1]) !== "function") return fromJson(ctx, json)
  const reviver = requireCallback(args[1], "JSON.parse")
  // Each primitive replaced by its source text, for the reviver's context argument.
  const source = JSON.parse(text, (_, value, context: { source?: string }) => context.source ?? value)
  const [parsed, snapshot] = revivable(ctx, json, source)
  return new Invoke(
    ctx.prelude.fn("revive"),
    undefined,
    [record(ctx.builtins.Object, { "": parsed }), "", reviver, snapshot],
    undefined,
  )
}

// The parsed value, and its snapshot for `revive`: [object, children's snapshots by key] or [source text, primitive].
const revivable = <R>(ctx: Interpreter<R>, json: Json, source: Json): readonly [Value, Value] => {
  if (json === null || typeof json !== "object") return [json, new Arr(ctx.builtins.Array, [source as string, json])]
  const children = new Obj(null)
  const entries = Object.entries(json).map(([key, item]) => {
    const [value, snapshot] = revivable(ctx, item, (source as Record<string, Json>)[key]!)
    define(children, key, snapshot)
    return [key, value] as const
  })
  const parsed = Array.isArray(json)
    ? new Arr(
        ctx.builtins.Array,
        entries.map((entry) => entry[1]),
      )
    : record(ctx.builtins.Object, Object.fromEntries(entries))
  return [parsed, new Arr(ctx.builtins.Array, [parsed, children])]
}

const stringify = (args: Array<Value>) => {
  const space = args[2]
  const indent = typeof space === "number" || typeof space === "string" ? space : undefined
  const replacer = args[1]
  const properties =
    replacer instanceof Arr
      ? replacer.items
          .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
          .map(String)
      : undefined
  const callback = typeofValue(replacer) === "function" ? requireCallback(replacer, "JSON.stringify") : undefined
  return new Push("JSON.stringify", [args[0], callback, properties, indent])
}
