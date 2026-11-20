#!/usr/bin/env bun

// Regenerates conformance/date-locale.json and conformance/date-locale.differences.json: the matrix of Date
// `toLocale*String` cases the Rust implementation replays in bench/tests/date_locale.rs.
//
// The matrix runs a representative set of the common locales through the reference's `Intl.DateTimeFormat` options
// (dateStyle and timeStyle, each field alone, typical combinations, timeZone and hour12/hourCycle) at fixed instants
// in fixed time zones, so no machine's own zone shows up, plus an error case for each option the reference rejects,
// pinned by its kind and message. Every case is recorded from the reference (`langDate`); then the Rust side runs the
// same matrix (the `date_locale` example) and the differences — where ICU4X renders its closest output rather than the
// exact one — are written to the differences file, kept as short as the limit allows.
//
// Usage: bun conformance/date-locale.ts [reference] — the reference package directory, from the argument,
// PSYCHOSCRIPT_REF, or by default the repository root.

import { join } from "node:path"
import { writeRecording } from "./recording.ts"
import { reference } from "./reference.ts"

const ref = await reference(process.argv[2] ?? process.env.PSYCHOSCRIPT_REF)
const Effect = ref.Effect
const Runtime = ref.Language.Runtime

// 20 of the most common locales, and a smaller set shared by the time and time-zone cases.
const LOCALES = [
  "en-US", "en-GB", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "nl-NL", "ru-RU", "zh-CN",
  "ja-JP", "ko-KR", "ar-EG", "hi-IN", "th-TH", "vi-VN", "tr-TR", "pl-PL", "id-ID", "sv-SE",
]
const SUBSET = ["en-US", "en-GB", "de-DE", "fr-FR", "ja-JP", "ar-EG"]
const ZONES = ["UTC", "Asia/Tokyo", "America/New_York", "Australia/Sydney", "Asia/Kolkata"]
const INSTANT = Date.UTC(2024, 0, 15, 13, 5, 9)

type Bag = Record<string, string | number | boolean>
type Case = {
  method: string
  locale?: string | null
  options?: Bag | null
  instant: number
  error?: boolean
}

const cases: Array<Case> = []
const push = (method: string, locale: string | null | undefined, options: Bag | null | undefined, instant = INSTANT) => {
  const case_: Case = { method, instant }
  if (locale !== undefined) case_.locale = locale
  if (options !== undefined) case_.options = options
  cases.push(case_)
}

// The default fields in each locale, for each of the three methods, at the fixed instant in UTC.
for (const locale of LOCALES) {
  for (const method of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    push(method, locale, { timeZone: "UTC" })
  }
}

// dateStyle and timeStyle, alone and together.
for (const locale of LOCALES) {
  for (const dateStyle of ["full", "long", "medium", "short"]) push("toLocaleString", locale, { dateStyle, timeZone: "UTC" })
  push("toLocaleString", locale, { timeStyle: "short", timeZone: "UTC" })
  push("toLocaleString", locale, { timeStyle: "medium", timeZone: "UTC" })
  push("toLocaleString", locale, { dateStyle: "full", timeStyle: "short", timeZone: "UTC" })
}

// Each date field alone, at its common widths, which are the locale-sensitive ones.
for (const locale of LOCALES) {
  for (const [key, value] of [
    ["weekday", "long"], ["weekday", "short"], ["era", "short"], ["month", "long"], ["month", "short"],
    ["month", "numeric"], ["month", "2-digit"],
  ] as const) {
    push("toLocaleString", locale, { [key]: value, timeZone: "UTC" })
  }
}

// The numeric widths and the typical combinations.
for (const locale of LOCALES) {
  const bags: Array<Bag> = [
    { year: "numeric" },
    { year: "2-digit" },
    { day: "numeric" },
    { day: "2-digit" },
    { year: "numeric", month: "long", day: "numeric" },
    { weekday: "long", year: "numeric", month: "long", day: "numeric" },
    { year: "2-digit", month: "numeric", day: "numeric" },
    { month: "2-digit", day: "2-digit", year: "numeric" },
  ]
  for (const bag of bags) push("toLocaleString", locale, { ...bag, timeZone: "UTC" })
}

// Time fields, fractional seconds, and the hour-cycle options (a few locales each, where the hour cycle differs).
for (const locale of SUBSET) {
  const bags: Array<Bag> = [
    { hour: "numeric" },
    { hour: "2-digit" },
    { minute: "2-digit" },
    { second: "2-digit" },
    { dayPeriod: "long" },
    { hour: "numeric", minute: "2-digit" },
    { hour: "numeric", minute: "2-digit", second: "2-digit" },
    { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 },
    { hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
    { hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h12" },
    { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false },
    { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true },
  ]
  for (const bag of bags) push("toLocaleString", locale, { ...bag, timeZone: "UTC" })
}

// Time zones: time styles that carry a time zone name, and the timeZoneName option, across the fixed zones.
for (const locale of SUBSET) {
  for (const timeZone of ZONES) {
    const bags: Array<Bag> = [
      { timeStyle: "long" },
      { timeStyle: "full" },
      { timeZoneName: "short", hour: "2-digit", minute: "2-digit" },
      { timeZoneName: "long", hour: "2-digit", minute: "2-digit" },
      { dateStyle: "full", timeStyle: "short" },
    ]
    for (const bag of bags) push("toLocaleString", locale, { ...bag, timeZone })
  }
}

// The defaults with no arguments (the reference's own default locale and zone; the recordings are made in UTC).
push("toLocaleString", undefined, undefined)
push("toLocaleDateString", undefined, undefined)
push("toLocaleTimeString", undefined, undefined)

// The widths ICU4X can't render exactly, recorded so they reel in a difference rather than silently diverge.
for (const bag of [{ weekday: "narrow" }, { month: "narrow" }, { era: "long" }, { era: "narrow" }]) {
  push("toLocaleString", "en-US", { ...bag, timeZone: "UTC" })
}

// An error case for every option the reference rejects, pinned by kind and message.
const errorCase = (method: string, locale: string | null | undefined, options: Bag | null | undefined) => {
  const case_: Case = { method, instant: INSTANT, error: true }
  if (locale !== undefined) case_.locale = locale
  if (options !== undefined) case_.options = options
  cases.push(case_)
}
for (const [method, options] of [
  ["toLocaleString", { timeZone: "Nope" }],
  ["toLocaleString", { weekday: "bad" }],
  ["toLocaleString", { era: "bad" }],
  ["toLocaleString", { year: "bad" }],
  ["toLocaleString", { month: "bad" }],
  ["toLocaleString", { day: "bad" }],
  ["toLocaleString", { dayPeriod: "bad" }],
  ["toLocaleString", { hour: "bad" }],
  ["toLocaleString", { minute: "bad" }],
  ["toLocaleString", { second: "bad" }],
  ["toLocaleString", { fractionalSecondDigits: 4 }],
  ["toLocaleString", { timeZoneName: "bad" }],
  ["toLocaleString", { hourCycle: "bad" }],
  ["toLocaleString", { dateStyle: "bad" }],
  ["toLocaleString", { timeStyle: "bad" }],
  ["toLocaleString", { dateStyle: "short", year: "numeric" }],
  ["toLocaleTimeString", { dateStyle: "short" }],
  ["toLocaleDateString", { timeStyle: "short" }],
] as const) {
  errorCase(method, "en-US", options as Bag)
}
errorCase("toLocaleString", null, undefined) // null locales
errorCase("toLocaleString", "en-US", null) // null options
errorCase("toLocaleString", "!!", { timeZone: "UTC" }) // invalid language tag

// ---------- record the reference's output ----------

const runtime = Runtime.make({})
const run = async (case_: Case) => {
  const json = (value: unknown) => JSON.stringify(value)
  let args = ""
  if (case_.locale !== undefined && case_.options !== undefined) args = `${json(case_.locale)},${json(case_.options)}`
  else if (case_.locale !== undefined) args = json(case_.locale)
  else if (case_.options !== undefined) args = `undefined,${json(case_.options)}`
  const call = `new Date(${case_.instant})[${json(case_.method)}](${args})`
  const code = case_.error ? `try { ${call} } catch (e) { return [e.name, e.message] }` : `return ${call}`
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`reference failed unexpectedly: ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const expected: Array<unknown> = []
for (const case_ of cases) expected.push(await run(case_))

const recorded = {
  cases: cases.map((case_, index) => ({
    method: case_.method,
    ...(case_.locale !== undefined ? { locale: case_.locale } : {}),
    ...(case_.options !== undefined ? { options: case_.options } : {}),
    ...(case_.error ? { error: true } : {}),
    instant: case_.instant,
    expected: expected[index],
  })),
}
writeRecording(join(import.meta.dir, "date-locale.json"), recorded)

// ---------- run the Rust side and record the differences ----------

const rustDir = join(import.meta.dir, "..")
const proc = Bun.spawnSync({
  cmd: ["cargo", "run", "--quiet", "-p", "psychoscript-bench", "--example", "date_locale", "--", join(import.meta.dir, "date-locale.json")],
  cwd: rustDir,
  stdout: "pipe",
  stderr: "pipe",
})
if (proc.exitCode !== 0) {
  throw new Error(`date-locale example failed (${proc.exitCode}):\n${proc.stderr.toString()}`)
}
const actual: Array<unknown> = JSON.parse(proc.stdout.toString())
if (actual.length !== cases.length) {
  throw new Error(`date-locale example answered ${actual.length} of ${cases.length} cases`)
}

// An error case (its recorded result is the caught `[name, message]`) must match exactly; only a differing value case
// is a recorded difference.
for (let index = 0; index < cases.length; index++) {
  if (cases[index].error && JSON.stringify(actual[index]) !== JSON.stringify(expected[index])) {
    throw new Error(`date-locale error case ${index} drifted:\n  reference: ${JSON.stringify(expected[index])}\n  rust:      ${JSON.stringify(actual[index])}`)
  }
}
const differences = actual
  .map((rust, index) => {
    if (cases[index].error || typeof expected[index] !== "string") return undefined
    return rust === expected[index] ? undefined : { index, reference: expected[index] as string, rust }
  })
  .filter((entry): entry is { index: number; reference: string; rust: string } => entry !== undefined)
writeRecording(join(import.meta.dir, "date-locale.differences.json"), { differences })

console.log(
  `${cases.length} cases, ${differences.length} differences` +
    (differences.length === 0 ? "" : `\n${differences.map((d) => `  ${cases[d.index].locale} ${JSON.stringify(cases[d.index].options)}:\n    ${d.reference}\n    ${d.rust}`).join("\n")}`),
)

