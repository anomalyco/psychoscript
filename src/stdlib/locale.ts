import { typeError } from "../runtime/model.js"
import { Arr, Obj, coerceToNumber, get, has, type NativeResult, type Value } from "../runtime/objects.js"
import { withPrimitives, withReads } from "../runtime/callback.js"
import { checkArrayLength } from "../runtime/limits.js"

// How Intl reads each option it takes: converted to a string or a number, or taken as a boolean without conversion.
export type LocaleOptions = Readonly<Record<string, "string" | "number" | "boolean">>

/**
 * Formats through a host `toLocaleString`-style method: the locale tags and the listed options are read from the
 * program's values, and program objects among them are converted first, as Intl's ToString and ToNumber would.
 */
export const formatLocale = (
  locales: Value,
  options: Value,
  reads: LocaleOptions,
  format: (locales: Intl.LocalesArgument, options: Record<string, Value> | undefined) => string,
): NativeResult => {
  if (locales === null || options === null) throw typeError("Cannot convert undefined or null to object.")
  return withReads(() => {
    // Bun's default locale is en-US whatever the environment says; pinning it keeps output off the host's.
    // A non-array object is array-like to Intl, so its elements are the tags.
    const tags =
      locales === undefined
        ? ["en-US"]
        : locales instanceof Arr
          ? locales.items.filter(() => true)
          : locales instanceof Obj
            ? arrayLikeTags(locales)
            : [locales]
    const entries =
      options instanceof Obj
        ? Object.entries(reads).flatMap(([key, kind]) => {
            const value = get(options, key)
            if (value === undefined) return []
            return [[key, kind === "boolean" ? Boolean(value) : value, kind] as const]
          })
        : []
    return withPrimitives(
      [...tags.map(() => "string" as const), ...entries.map((entry) => (entry[2] === "number" ? "number" : "string"))],
      [...tags, ...entries.map((entry) => entry[1])],
      (primitives) =>
        format(
          (locales instanceof Obj ? primitives.slice(0, tags.length) : primitives[0]) as Intl.LocalesArgument,
          options instanceof Obj
            ? Object.fromEntries(entries.map((entry, at) => [entry[0], primitives[tags.length + at]]))
            : (options as undefined),
        ),
    )
  })
}

const arrayLikeTags = (locales: Obj) => {
  const length = get(locales, "length")
  const count = length instanceof Obj ? 0 : Math.max(0, Math.floor(coerceToNumber(length)) || 0)
  checkArrayLength(count)
  return Array.from({ length: count }, (_, index) => index)
    .filter((index) => has(locales, String(index)))
    .map((index) => get(locales, String(index)))
}

// The options Intl.NumberFormat reads.
export const numberFormatOptions: LocaleOptions = {
  localeMatcher: "string",
  numberingSystem: "string",
  style: "string",
  currency: "string",
  currencyDisplay: "string",
  currencySign: "string",
  unit: "string",
  unitDisplay: "string",
  notation: "string",
  minimumIntegerDigits: "number",
  minimumFractionDigits: "number",
  maximumFractionDigits: "number",
  minimumSignificantDigits: "number",
  maximumSignificantDigits: "number",
  roundingIncrement: "number",
  roundingMode: "string",
  roundingPriority: "string",
  trailingZeroDisplay: "string",
  compactDisplay: "string",
  useGrouping: "string",
  signDisplay: "string",
}

// The options Intl.DateTimeFormat reads.
export const dateTimeFormatOptions: LocaleOptions = {
  localeMatcher: "string",
  calendar: "string",
  numberingSystem: "string",
  hour12: "boolean",
  hourCycle: "string",
  timeZone: "string",
  weekday: "string",
  era: "string",
  year: "string",
  month: "string",
  day: "string",
  dayPeriod: "string",
  hour: "string",
  minute: "string",
  second: "string",
  fractionalSecondDigits: "number",
  timeZoneName: "string",
  formatMatcher: "string",
  dateStyle: "string",
  timeStyle: "string",
}
