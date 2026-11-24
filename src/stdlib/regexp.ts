import type { Builtins } from "../runtime/intrinsics.js"
import { constructor, type Method, methods, prototypeFrom, receiver } from "../runtime/native.js"
import { syntaxError, typeError } from "../runtime/model.js"
import {
  define,
  defineAccessor,
  get,
  Arr,
  Obj,
  RegExpObj,
  record,
  coerceToNumber,
  coerceToString,
  type Value,
} from "../runtime/objects.js"
import type { Interpreter } from "../runtime/interpreter.js"
import { readsPending, withReads } from "../runtime/callback.js"

const flagProperties = [
  "hasIndices",
  "global",
  "ignoreCase",
  "multiline",
  "sticky",
  "unicode",
  "unicodeSets",
  "dotAll",
] as const

const regexFailureReason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression:\s*/i, "")

const escapeRegexHint =
  'To match special characters like ( ) [ ] { } + * ? . literally, escape them with a backslash (e.g. "\\\\(") or test for them with String.includes instead.'

/** Runs host regex work on a RegExp argument, sharing its `lastIndex`, or on a pattern string compiled for the call. */
export const withHostRegex = <T>(arg: Value, method: string, extraFlags: string, work: (regex: RegExp) => T): T => {
  if (arg instanceof RegExpObj) return arg.use(work)
  // Anything else is a pattern string, as `new RegExp(arg)` would read it: undefined is the empty pattern.
  const source = arg === undefined ? "" : coerceToString(arg)
  return work(compilePattern(source, method, extraFlags))
}

const compilePattern = (source: string, method: string, extraFlags: string): RegExp => {
  try {
    return new RegExp(source, extraFlags)
  } catch (error) {
    throw syntaxError(
      `String.${method} received the string ${JSON.stringify(source)}, which is not a valid regular expression pattern (${regexFailureReason(error)}). ${escapeRegexHint}`,
    )
  }
}

export const matchToValue = (builtins: Builtins, match: RegExpMatchArray): Arr => {
  const result = new Arr(
    builtins.Array,
    Array.from(match, (group) => group),
  )
  if (match.index !== undefined) define(result, "index", match.index)
  if (match.input !== undefined) define(result, "input", match.input)
  // Like JS, `groups` is always present: undefined without named groups, otherwise a null-prototype object.
  define(result, "groups", match.groups === undefined ? undefined : record(null, match.groups))
  if (match.indices) define(result, "indices", indicesToValue(builtins, match.indices))
  return result
}

export const constructRegExp = (builtins: Builtins, args: Array<Value>, proto: Obj = builtins.RegExp): RegExpObj => {
  const first = args[0]
  const pattern = first instanceof RegExpObj ? first.source : first === undefined ? "" : coerceToString(first)
  const flagsArg = args[1]
  if (flagsArg !== undefined && typeof flagsArg !== "string") {
    throw syntaxError(
      `RegExp flags must be a string of flag characters (e.g. "g", "gi"), not ${flagsArg === null ? "null" : typeof flagsArg}.`,
    )
  }
  const flags = flagsArg ?? (first instanceof RegExpObj ? first.flags : "")
  try {
    return new RegExpObj(proto, pattern, flags)
  } catch (error) {
    const reason = regexFailureReason(error)
    throw syntaxError(
      /flag/i.test(reason)
        ? `new RegExp(...) received invalid flags ${JSON.stringify(flags)} (${reason}). Valid flags are d, g, i, m, s, u, v, and y.`
        : `new RegExp(...) received ${JSON.stringify(pattern)}, which is not a valid regular expression pattern (${reason}). ${escapeRegexHint}`,
    )
  }
}

// RegExp constructs identically with or without new, like JS.
export const regexpGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const proto = builtins.RegExp
  const regexp = constructor(builtins, proto, {
    name: "RegExp",
    length: 2,
    // RegExp(r) without new returns r itself when no flags are given and its constructor is RegExp.
    call: (_, args) => {
      const pattern = args[0]
      if (!(pattern instanceof RegExpObj) || args[1] !== undefined) return constructRegExp(builtins, args)
      return withReads(() => {
        const patternConstructor = get(pattern, "constructor")
        if (readsPending()) return undefined
        return patternConstructor === regexp ? pattern : constructRegExp(builtins, args)
      })
    },
    construct: (args, newTarget) => constructRegExp(builtins, args, prototypeFrom(newTarget, proto)),
  })
  methods(builtins, regexp, [
    [
      "escape",
      1,
      (_, args) => {
        if (typeof args[0] !== "string") throw typeError("RegExp.escape expects a string.")
        return RegExp.escape(args[0])
      },
    ],
  ])

  const self = (thisValue: Value, name: string) => receiver(RegExpObj, thisValue, `RegExp.prototype.${name}`)
  // RegExp.prototype itself is not a RegExp, but JS reads it as the empty pattern with no flags set.
  defineAccessor(proto, "source", (thisValue) => (thisValue === proto ? "(?:)" : self(thisValue, "source").source))
  defineAccessor(proto, "flags", (thisValue) => (thisValue === proto ? "" : self(thisValue, "flags").flags))
  // One lastIndex per RegExp, so exec/test and the String methods share one counter.
  defineAccessor(
    proto,
    "lastIndex",
    (thisValue) => self(thisValue, "lastIndex").lastIndex,
    (thisValue, value) => {
      self(thisValue, "lastIndex").lastIndex = coerceToNumber(value)
    },
  )
  for (const name of flagProperties) {
    defineAccessor(proto, name, (thisValue) => (thisValue === proto ? undefined : self(thisValue, name).regex[name]))
  }
  const run = (name: "exec" | "test"): Method => [
    name,
    1,
    (thisValue, args) => {
      const value = self(thisValue, name)
      const input = coerceToString(args[0])
      const matched = value.use((regex) => regex.exec(input))
      if (name === "test") return matched !== null
      return matched === null ? null : matchToValue(builtins, matched)
    },
  ]
  methods(builtins, proto, [
    run("exec"),
    run("test"),
    ["toString", 0, (thisValue) => (thisValue === proto ? "/(?:)/" : coerceToString(self(thisValue, "toString")))],
  ])
  return regexp
}

const indicesToValue = (builtins: Builtins, indices: RegExpIndicesArray): Arr => {
  const range = (pair: [number, number] | undefined) =>
    pair === undefined ? undefined : new Arr(builtins.Array, [...pair])
  const result = new Arr(builtins.Array, Array.from(indices, range))
  const groups = indices.groups
  define(
    result,
    "groups",
    groups === undefined
      ? undefined
      : record(null, Object.fromEntries(Object.entries(groups).map(([key, pair]) => [key, range(pair)]))),
  )
  return result
}
