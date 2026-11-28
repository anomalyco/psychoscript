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
import { checkStringLength } from "../runtime/limits.js"
import type { Interpreter } from "../runtime/interpreter.js"

const consoleMethods = ["log", "info", "debug", "warn", "error", "dir", "table"]

/** What `count`, `group` and `time` remember between calls; kept on the interpreter so a saved run keeps it. */
export type ConsoleState = {
  readonly counts: Map<string, number>
  /** Epoch milliseconds each `time` label started at, so the elapsed time survives a save and restore. */
  readonly timers: Map<string, number>
  indent: string
}

/** Captured console: every method appends one formatted line to `logs`. */
export const consoleGlobal = <R>(ctx: Interpreter<R>) => {
  const builtins = ctx.builtins
  const console = new Obj(builtins.Object)
  const state = () => ctx.consoleState
  const push = (prefix: string, message: string) => {
    const indent = state().indent
    // The indent starts every line: checked before the line is made.
    if (indent !== "") checkStringLength(prefix.length + message.length + indent.length * lineCount(message))
    else checkStringLength(prefix.length + message.length)
    ctx.log(prefix + (indent === "" ? message : message.replace(/^/gm, indent)))
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
    checkStringLength(state().indent.length + 2)
    state().indent += "  "
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
        state().indent = state().indent.slice(2)
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
        return push("", formatArgs([`${name}: ${time}`, ...args.slice(1)]))
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

const formatArgs = (args: Array<Value>) => {
  const format = formatter()
  return args.map((arg, at) => format.part(format.show(arg), at > 0 ? 1 : 0)).join(" ")
}

// As Node shows a `console.time` duration.
const formatDuration = (ms: number) => (ms < 1000 ? `${ms.toFixed(3)}ms` : `${(ms / 1000).toFixed(3)}s`)

const formatConsoleMessage = (name: string, args: Array<Value>): string => {
  if (name === "dir") return args.length === 0 ? "undefined" : formatValue(args[0])
  if (name === "table") return formatConsoleTable(args[0], args[1])
  return formatArgs(args)
}

/** One value as `console.log` shows it. */
export const formatValue = (value: Value): string => formatter().show(value)

// How many lines `message.replace(/^/gm, indent)` indents: one, and one after each line terminator.
const lineCount = (message: string) => 1 + (message.match(/[\n\r\u2028\u2029]/g)?.length ?? 0)

/**
 * Formats the values of one console message. Objects a value shares show in full wherever they recur, so its text can
 * be exponentially longer than the value: an object's text is made once and reused wherever it would come out the same,
 * and the message is refused once the parts that make it up pass the string limit, before they are joined.
 *
 * An object's text depends on its depth (past the limit it is `...`) and on which objects being shown around it are on
 * a cycle with it (those show as `[Circular]`); nothing else it meets can be one of them. So that is what a reused text
 * is kept by. Which objects share a cycle is only worked out once an object recurs, which a tree never does.
 */
const formatter = () => {
  // The objects being shown, outermost first.
  const showing: Array<Obj> = []
  const made = new Map<Obj, Map<string, string>>()
  const seen = new Set<Obj>()
  // Each object's cycle (its strongly connected component), once any object recurred.
  let cycles: Map<Obj, number> | undefined
  const ids = new Map<Obj, number>()
  const idOf = (value: Obj) => {
    const known = ids.get(value)
    if (known !== undefined) return known
    ids.set(value, ids.size)
    return ids.size - 1
  }
  // The length of the parts so far of the message, then of each object being shown.
  const lengths = [0]
  const part = (text: string, extra = 0) => {
    const at = lengths.length - 1
    lengths[at]! += text.length + extra
    checkStringLength(lengths[at]!)
    return text
  }
  const format = (value: Value, depth: number): string => {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "bigint") return `${value}n`
    if (!(value instanceof Obj)) return value instanceof HostNamespace ? "[opaque reference]" : String(value)
    if (depth > MAX_CONSOLE_DEPTH) return "..."
    if (showing.includes(value)) return "[Circular]"
    if (cycles === undefined && seen.has(value)) cycles = new Map()
    seen.add(value)
    let key: string | undefined
    if (cycles !== undefined) {
      const cycle = cycleOf(value, cycles)
      key = `${depth}`
      for (const outer of showing) if (cycleOf(outer, cycles) === cycle) key += `,${idOf(outer)}`
      const known = made.get(value)?.get(key)
      if (known !== undefined) return known
    }
    showing.push(value)
    lengths.push(0)
    const text = value.inspect((item) => part(format(item, depth + 1)))
    lengths.pop()
    showing.pop()
    if (key !== undefined) {
      const texts = made.get(value) ?? new Map<string, string>()
      texts.set(key, text)
      made.set(value, texts)
    }
    return text
  }
  return {
    part,
    /** A value as a message shows it: a string as itself. */
    show: (value: Value) => (value === undefined ? "undefined" : typeof value === "string" ? value : format(value, 0)),
    /** A table cell: empty for undefined. */
    cell: (value: Value) => (value === undefined ? "" : typeof value === "string" ? value : format(value, 0)),
  }
}

/**
 * The cycle `value` is on, as the number of its strongly connected component among the objects it shows (Tarjan's
 * algorithm, without recursion). Components found from earlier objects are kept in `cycles`: no object found later can
 * share a cycle with them, or it would have been found with them.
 */
const cycleOf = (value: Obj, cycles: Map<Obj, number>): number => {
  const known = cycles.get(value)
  if (known !== undefined) return known
  const order = new Map<Obj, number>()
  const low = new Map<Obj, number>()
  const stack: Array<Obj> = []
  const stacked = new Set<Obj>()
  const walks: Array<{ readonly value: Obj; readonly children: Array<Obj>; at: number }> = []
  const enter = (entered: Obj) => {
    const children: Array<Obj> = []
    entered.inspect((item) => {
      if (item instanceof Obj) children.push(item)
      return ""
    })
    order.set(entered, order.size)
    low.set(entered, order.size - 1)
    stack.push(entered)
    stacked.add(entered)
    walks.push({ value: entered, children, at: 0 })
  }
  enter(value)
  while (walks.length > 0) {
    const walk = walks[walks.length - 1]!
    if (walk.at < walk.children.length) {
      const child = walk.children[walk.at++]!
      if (cycles.has(child)) continue
      if (!order.has(child)) enter(child)
      else if (stacked.has(child)) low.set(walk.value, Math.min(low.get(walk.value)!, order.get(child)!))
      continue
    }
    walks.pop()
    const outer = walks[walks.length - 1]
    if (outer !== undefined) low.set(outer.value, Math.min(low.get(outer.value)!, low.get(walk.value)!))
    if (low.get(walk.value) !== order.get(walk.value)) continue
    const component = cycles.size
    for (let member = stack.pop()!; ; member = stack.pop()!) {
      stacked.delete(member)
      cycles.set(member, component)
      if (member === walk.value) break
    }
  }
  return cycles.get(value)!
}

const formatConsoleTable = (value: Value, columnsArgument: Value): string => {
  if (value === undefined) return "undefined"
  if (isOpaque(value)) return formatValue(value)
  const columns = columnsArgument instanceof Arr ? columnsArgument.items.map(String) : undefined
  const entries = consoleTableEntries(value)
  // Every row has a tab before each column and a line break: refused before rows of that many columns are made.
  if (columns !== undefined) checkStringLength((entries.length + 1) * (columns.length + 1))
  const rows = entries.map(([index, item]) => ({ index, values: consoleTableValues(item, columns) }))
  const keys = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row.values))))
  checkStringLength((rows.length + 1) * (keys.length + 1))
  const format = formatter()
  format.part("", (rows.length + 1) * (keys.length + 1))
  const header = ["(index)", ...keys].map((key) => format.part(key)).join("\t")
  return [
    header,
    ...rows.map((row) =>
      [format.part(row.index), ...keys.map((key) => format.part(format.cell(row.values[key])))].join("\t"),
    ),
  ].join("\n")
}

const consoleTableEntries = (data: Value): Array<readonly [string, Value]> => {
  if (data instanceof Arr) return data.items.map((item, index) => [String(index), item] as const)
  if (data instanceof Obj) return shownEntries(data)
  return [["0", data]]
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
