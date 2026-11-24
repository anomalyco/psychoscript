import { type Method, methods } from "../runtime/native.js"
import {
  accessorLabel,
  coerceToString,
  get,
  Arr,
  HostNamespace,
  isProgramAccessor,
  lookup,
  Obj,
  shownEntries,
  type Value,
} from "../runtime/objects.js"
import { isOpaque } from "../runtime/references.js"
import type { Interpreter } from "../runtime/interpreter.js"

const consoleMethods = ["log", "info", "debug", "warn", "error", "dir", "table"]

/** What `count`, `group` and `time` remember between calls; kept on the interpreter so a saved run keeps it. */
export type ConsoleState = {
  readonly counts: Map<string, number>
  /** Epoch milliseconds each `time` label started at, so the elapsed time survives a save and restore. */
  readonly timers: Map<string, number>
  /** How many `group`s are open; a number rather than the indent text, so an idle console adds nothing to the heap. */
  depth: number
}

/** Captured console: every method appends one formatted line to `logs`. */
export const consoleGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const console = new Obj(builtins.Object)
  const state = () => ctx.consoleState
  const push = (prefix: string, message: string) => {
    const indent = "  ".repeat(state().depth)
    ctx.logs.push(prefix + (indent === "" ? message : message.replace(/^/gm, indent)))
    return undefined
  }
  const label = (value: Value) => (value === undefined ? "default" : coerceToString(value))
  const elapsed = (name: string, method: string): string | undefined => {
    const start = state().timers.get(name)
    if (start === undefined) push("[warn] ", `No such label '${name}' for console.${method}()`)
    return start === undefined ? undefined : formatDuration(Date.now() - start)
  }
  const group = (_: Value, args: Array<Value>) => {
    if (args.length > 0) push("", formatArgs(args))
    state().depth += 1
    return undefined
  }
  methods(builtins, console, [
    ...consoleMethods.map((name): Method => [name, 0, (_, args) => push(prefixOf(name), formatConsoleMessage(name, args))]),
    [
      "assert",
      0,
      (_, args) => {
        if (Boolean(args[0])) return undefined
        const rest = args.slice(1)
        const separator = typeof rest[0] === "string" ? ": " : " "
        return push("[error] ", rest.length === 0 ? "Assertion failed" : `Assertion failed${separator}${formatArgs(rest)}`)
      },
    ],
    [
      "count",
      0,
      (_, args) => {
        const name = label(args[0])
        const count = (state().counts.get(name) ?? 0) + 1
        state().counts.set(name, count)
        return push("", `${name}: ${count}`)
      },
    ],
    [
      "countReset",
      0,
      (_, args) => {
        const name = label(args[0])
        if (!state().counts.has(name)) return push("[warn] ", `Count for '${name}' does not exist`)
        state().counts.set(name, 0)
        return undefined
      },
    ],
    ["group", 0, group],
    ["groupCollapsed", 0, group],
    [
      "groupEnd",
      0,
      () => {
        state().depth = Math.max(0, state().depth - 1)
        return undefined
      },
    ],
    ["trace", 0, (_, args) => push("[error] ", args.length === 0 ? "Trace" : `Trace: ${formatArgs(args)}`)],
    [
      "time",
      0,
      (_, args) => {
        const name = label(args[0])
        if (state().timers.has(name)) return push("[warn] ", `Label '${name}' already exists for console.time()`)
        state().timers.set(name, Date.now())
        return undefined
      },
    ],
    [
      "timeLog",
      0,
      (_, args) => {
        const name = label(args[0])
        const time = elapsed(name, "timeLog")
        if (time === undefined) return undefined
        return push("", [`${name}: ${time}`, ...args.slice(1).map((arg) => formatValue(arg))].join(" "))
      },
    ],
    [
      "timeEnd",
      0,
      (_, args) => {
        const name = label(args[0])
        const time = elapsed(name, "timeEnd")
        if (time === undefined) return undefined
        state().timers.delete(name)
        return push("", `${name}: ${time}`)
      },
    ],
  ])
  return console
}

const MAX_CONSOLE_DEPTH = 32

const prefixOf = (name: string) =>
  name === "warn" ? "[warn] " : name === "error" ? "[error] " : name === "debug" ? "[debug] " : ""

const formatArgs = (args: Array<Value>) => args.map((arg) => formatValue(arg)).join(" ")

// As Node shows a `console.time` duration.
const formatDuration = (ms: number) => (ms < 1000 ? `${ms.toFixed(3)}ms` : `${(ms / 1000).toFixed(3)}s`)

const formatConsoleMessage = (name: string, args: Array<Value>): string => {
  if (name === "dir") return args.length === 0 ? "undefined" : formatValue(args[0])
  if (name === "table") return formatConsoleTable(args[0], args[1])
  return formatArgs(args)
}

/** One value as `console.log` shows it. */
export const formatValue = (value: Value): string => {
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  return formatConsoleValue(value, new Set(), 0)
}

const formatConsoleValue = (value: Value, seen: Set<object>, depth: number): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "bigint") return `${value}n`
  if (!(value instanceof Obj)) return value instanceof HostNamespace ? "[opaque reference]" : String(value)
  if (depth > MAX_CONSOLE_DEPTH) return "..."
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  try {
    return value.inspect((item) => formatConsoleValue(item, seen, depth + 1))
  } finally {
    seen.delete(value)
  }
}

const formatConsoleTable = (value: Value, columnsArgument: Value): string => {
  if (value === undefined) return "undefined"
  if (isOpaque(value)) return formatValue(value)
  const columns = columnsArgument instanceof Arr ? columnsArgument.items.map(String) : undefined
  const rows = consoleTableRows(value, columns)
  const keys = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row.values))))
  const header = ["(index)", ...keys].join("\t")
  return [
    header,
    ...rows.map((row) => [row.index, ...keys.map((key) => formatConsoleTableCell(row.values[key]))].join("\t")),
  ].join("\n")
}

const consoleTableRows = (
  data: Value,
  columns: ReadonlyArray<string> | undefined,
): Array<{ readonly index: string; readonly values: Record<string, Value> }> => {
  if (data instanceof Arr) {
    return data.items.map((item, index) => ({ index: String(index), values: consoleTableValues(item, columns) }))
  }
  if (data instanceof Obj) {
    return shownEntries(data).map(([index, item]) => ({ index, values: consoleTableValues(item, columns) }))
  }
  return [{ index: "0", values: { Value: data } }]
}

const consoleTableValues = (value: Value, columns: ReadonlyArray<string> | undefined): Record<string, Value> => {
  if (value instanceof Obj && !(value instanceof Arr)) {
    if (columns !== undefined)
      return Object.fromEntries(columns.map((column) => [column, shownProperty(value, column)]))
    return Object.fromEntries(shownEntries(value))
  }
  return { Value: value }
}

// A column of a table row, as display shows it: a program accessor (own or inherited) by its label.
const shownProperty = (value: Obj, column: string): Value => {
  const slot = lookup(value, column)
  return slot !== undefined && isProgramAccessor(slot) ? accessorLabel(slot) : get(value, column)
}

const formatConsoleTableCell = (value: Value): string => {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return formatConsoleValue(value, new Set(), 0)
}
