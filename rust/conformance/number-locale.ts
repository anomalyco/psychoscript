#!/usr/bin/env bun

// Regenerates conformance/number-locale.json and conformance/number-locale.differences.json: the matrix of Number and
// BigInt `toLocaleString` cases the Rust implementation replays in bench/tests/date_locale.rs.
//
// The matrix runs the common locales through the reference's `Intl.NumberFormat` decimal-style options (fraction,
// significant and integer digits, rounding modes, increments and priority, trailing zeros, grouping, sign display,
// numbering systems) over representative values, plus an error case for each option the reference rejects, pinned by
// its kind and message. Every case is recorded from the reference; then the Rust side runs the same matrix (the
// `date_locale` example) and the differences — where ICU4X's data or rendering differs from the host's ICU — are
// written to the differences file. The styles and notations Rust refuses (percent, currency, unit; scientific,
// engineering, compact) are not here: crates/psychoscript/tests/number_locale.rs pins that refusal.
//
// The recordings were made on macOS, whose ICU the reference uses there; date-locale.ts is run on Linux, whose ICU may
// render a few locales otherwise: regenerate both on the same platform.
//
// Usage: bun conformance/number-locale.ts [reference] — the reference package directory, from the argument,
// PSYCHOSCRIPT_REF, or by default the repository root.

import { join } from "node:path"
import { writeRecording } from "./recording.js"
import { reference } from "./reference.js"

const ref = await reference(process.argv[2] ?? process.env.PSYCHOSCRIPT_REF)
const Effect = ref.Effect
const Runtime = ref.Language.Runtime

const LOCALES = [
  "en-US", "en-GB", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "nl-NL", "ru-RU", "zh-CN",
  "ja-JP", "ko-KR", "ar-EG", "hi-IN", "th-TH", "vi-VN", "tr-TR", "pl-PL", "id-ID", "sv-SE",
  "en-IN", "de-CH",
]
const SUBSET = ["en-US", "de-DE", "fr-FR", "ar-EG", "hi-IN", "ja-JP"]

type Bag = Record<string, string | number | boolean | null>
type Case = { method: string; value: string; locale?: unknown; options?: Bag | null; error?: boolean }

const cases: Array<Case> = []
const push = (value: string, locale: unknown, options?: Bag | null, error = false) => {
  const case_: Case = { method: "toLocaleString", value }
  if (locale !== undefined) case_.locale = locale
  if (options !== undefined) case_.options = options
  if (error) case_.error = true
  cases.push(case_)
}

// Each locale's defaults over values of every shape: fractions, grouping, zeros, the specials and BigInts.
for (const locale of LOCALES) {
  for (const value of ["1234567.891", "-1234.5", "0.5", "0", "-0", "1e21", "0.000123", "NaN", "-Infinity", "12345678901234567890n", "-42n"]) {
    push(value, locale)
  }
}

// The decimal-style options, alone and combined, in a few locales.
const BAGS: Array<Bag> = [
  { maximumFractionDigits: 0 },
  { maximumFractionDigits: 2 },
  { minimumFractionDigits: 2 },
  { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  { minimumFractionDigits: 4, maximumFractionDigits: 6 },
  { maximumSignificantDigits: 3 },
  { minimumSignificantDigits: 5 },
  { minimumSignificantDigits: 2, maximumSignificantDigits: 4 },
  { minimumIntegerDigits: 4 },
  { minimumIntegerDigits: 3, minimumFractionDigits: 2 },
  { useGrouping: false },
  { useGrouping: true },
  { useGrouping: "always" },
  { useGrouping: "min2" },
  { useGrouping: "auto" },
  { signDisplay: "always" },
  { signDisplay: "never" },
  { signDisplay: "exceptZero" },
  { signDisplay: "negative" },
  { trailingZeroDisplay: "stripIfInteger", minimumFractionDigits: 2 },
  { style: "decimal", notation: "standard" },
]
for (const locale of SUBSET) {
  for (const options of BAGS) {
    for (const value of ["1234.5678", "-0.004", "1234", "5", "12345678901234567890n"]) push(value, locale, options)
  }
}

// Every rounding mode, at the halfway points and off them, either sign.
for (const roundingMode of ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"]) {
  for (const value of ["2.5", "-2.5", "3.5", "2.4", "-2.6"]) push(value, "en-US", { maximumFractionDigits: 0, roundingMode })
  for (const value of ["1.25", "-1.25", "1.005"]) push(value, "en-US", { maximumFractionDigits: 2, roundingMode })
  push("1234.5", "en-US", { maximumSignificantDigits: 2, roundingMode })
}

// Rounding increments, with as many fraction digits on both sides.
for (const roundingIncrement of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000]) {
  for (const digits of [0, 2]) {
    for (const value of ["1.2345", "1234.5678", "-987.654"]) {
      push(value, "en-US", { roundingIncrement, minimumFractionDigits: digits, maximumFractionDigits: digits })
    }
  }
}

// Rounding priority between significant and fraction digits.
for (const roundingPriority of ["auto", "morePrecision", "lessPrecision"]) {
  for (const value of ["1.2345", "1234.5", "0.00012345", "99.99"]) {
    push(value, "en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 3, roundingPriority })
    push(value, "en-US", { minimumSignificantDigits: 2, maximumFractionDigits: 0, roundingPriority })
  }
}

// Numbering systems: the option and the locale's `-u-nu-`.
for (const numberingSystem of ["arab", "latn", "thai", "hanidec", "deva", "abcd"]) {
  for (const locale of ["en-US", "ar-EG", "th-TH"]) push("1234.5678", locale, { numberingSystem })
}
for (const locale of ["ar-EG-u-nu-latn", "th-TH-u-nu-thai", "en-US-u-nu-arab", "zh-CN-u-nu-hanidec", "hi-IN-u-nu-deva", "de-u-nu-abcd"]) {
  push("1234.5678", locale)
}

// Locale lists, odd tags, and more regions.
for (const locale of [["en-US", "de"], [], ["de", "xx"], "EN-us", "sr-Latn-RS", "zh-TW", "pt-PT", "es-MX", "de-AT", "fr-CH", "en-ZA", "he-IL", "fa-IR", "bn-BD"]) {
  push("-1234567.891", locale)
}

// Options that don't shape the decimal style, and the specials under the sign options.
for (const options of [{ currency: "USD" }, { unit: "meter" }, { unit: "meter-per-second" }, { currencyDisplay: "name" }, { currencySign: "accounting" }, { unitDisplay: "long" }, { compactDisplay: "long" }, { localeMatcher: "lookup" }] as Array<Bag>) {
  push("1234.5678", "en-US", options)
}
for (const signDisplay of ["auto", "always", "exceptZero", "negative", "never"]) {
  for (const value of ["NaN", "Infinity", "-Infinity", "-0", "0", "-0.0001"]) push(value, "en-US", { signDisplay })
}

// Values converted as the host converts them.
for (const options of [{ maximumFractionDigits: "2" }, { maximumFractionDigits: null }, { minimumIntegerDigits: 1.9 }, { useGrouping: 0 }, { useGrouping: "" }, { useGrouping: "false" }, { useGrouping: "true" }, { useGrouping: null }] as Array<Bag>) {
  push("1234.5678", "en-US", options)
}

// The defaults with no arguments.
push("1234567.891", undefined)
push("-12345678901234567890n", undefined)

// An error case for every option the reference rejects, pinned by kind and message.
for (const options of [
  { localeMatcher: "bad" }, { numberingSystem: "!!" }, { numberingSystem: "ab-cdef" }, { style: "bad" }, { style: null }, { style: "currency" },
  { style: "unit" }, { currency: "US" }, { currencyDisplay: "bad" }, { currencySign: "bad" }, { unit: "bad" }, { unitDisplay: "bad" },
  { notation: "bad" }, { minimumIntegerDigits: 0 }, { minimumIntegerDigits: 22 }, { minimumFractionDigits: -1 }, { maximumFractionDigits: 101 },
  { maximumFractionDigits: "x" }, { minimumFractionDigits: 3, maximumFractionDigits: 1 },
  { minimumSignificantDigits: 0 }, { minimumSignificantDigits: 22 }, { minimumSignificantDigits: 3, maximumSignificantDigits: 2 },
  { roundingIncrement: 0 }, { roundingIncrement: 5001 }, { roundingIncrement: 3 }, { roundingIncrement: 5, maximumFractionDigits: 2 },
  { roundingIncrement: 5, maximumSignificantDigits: 2 }, { roundingIncrement: 5, minimumFractionDigits: 2, maximumFractionDigits: 2, roundingPriority: "morePrecision" },
  { roundingMode: "bad" }, { roundingPriority: "bad" }, { trailingZeroDisplay: "bad" }, { compactDisplay: "bad" }, { useGrouping: "bad" },
  { useGrouping: 1 }, { signDisplay: "bad" },
] as Array<Bag>) {
  push("1234.5", "en-US", options, true)
}
push("1234.5", null, undefined, true) // null locales
push("1234.5", "en-US", null, true) // null options
push("1234.5", "!!", undefined, true) // invalid language tag
push("1234.5", ["en", "xx-invalid-but-valid"], undefined, true) // an invalid tag later in the list
push("1n", "en-US", { maximumFractionDigits: 101 }, true)

// ---------- record the reference's output ----------

const runtime = Runtime.make({})
const run = async (case_: Case) => {
  const json = (value: unknown) => JSON.stringify(value)
  let args = ""
  if (case_.locale !== undefined && case_.options !== undefined) args = `${json(case_.locale)},${json(case_.options)}`
  else if (case_.locale !== undefined) args = json(case_.locale)
  else if (case_.options !== undefined) args = `undefined,${json(case_.options)}`
  const call = `(${case_.value})[${json(case_.method)}](${args})`
  const code = case_.error ? `try { ${call} } catch (e) { return [e.name, e.message] }` : `return ${call}`
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`reference failed unexpectedly on ${call}: ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const expected: Array<unknown> = []
for (const case_ of cases) expected.push(await run(case_))
for (let index = 0; index < cases.length; index++) {
  const errored = Array.isArray(expected[index])
  if (errored !== Boolean(cases[index].error)) {
    throw new Error(`case ${index} ${JSON.stringify(cases[index])} ${errored ? "threw" : "did not throw"}: ${JSON.stringify(expected[index])}`)
  }
}

const recorded = { cases: cases.map((case_, index) => ({ ...case_, expected: expected[index] })) }
writeRecording(join(import.meta.dir, "number-locale.json"), recorded)

// ---------- run the Rust side and record the differences ----------

const rustDir = join(import.meta.dir, "..")
const proc = Bun.spawnSync({
  cmd: ["cargo", "run", "--quiet", "-p", "psychoscript-bench", "--example", "date_locale", "--", join(import.meta.dir, "number-locale.json")],
  cwd: rustDir,
  stdout: "pipe",
  stderr: "pipe",
})
if (proc.exitCode !== 0) {
  throw new Error(`date_locale example failed (${proc.exitCode}):\n${proc.stderr.toString()}`)
}
const actual: Array<unknown> = JSON.parse(proc.stdout.toString())
if (actual.length !== cases.length) {
  throw new Error(`date_locale example answered ${actual.length} of ${cases.length} cases`)
}

// An error case (its recorded result is the caught `[name, message]`) must match exactly; only a differing value case
// is a recorded difference.
const drifted = cases.flatMap((case_, index) =>
  case_.error && JSON.stringify(actual[index]) !== JSON.stringify(expected[index])
    ? [`  ${index} ${JSON.stringify(case_.options)}:\n    reference: ${JSON.stringify(expected[index])}\n    rust:      ${JSON.stringify(actual[index])}`]
    : [],
)
if (drifted.length > 0) throw new Error(`number-locale error cases drifted:\n${drifted.join("\n")}`)
const differences = actual
  .map((rust, index) => {
    if (cases[index].error || typeof expected[index] !== "string") return undefined
    return rust === expected[index] ? undefined : { index, reference: expected[index] as string, rust }
  })
  .filter((entry): entry is { index: number; reference: string; rust: string } => entry !== undefined)
writeRecording(join(import.meta.dir, "number-locale.differences.json"), { differences })

console.log(
  `${cases.length} cases, ${differences.length} differences` +
    (differences.length === 0
      ? ""
      : `\n${differences.map((d) => `  ${d.index} ${cases[d.index].value} ${JSON.stringify(cases[d.index].locale)} ${JSON.stringify(cases[d.index].options)}:\n    ${d.reference}\n    ${d.rust}`).join("\n")}`),
)
