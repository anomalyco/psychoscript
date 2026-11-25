// Behaviours where the reference keeps PsychoScript's own rules: repeat's count, inherited holes, locales passed to
// every element, a default sort's keys.
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const repeat = [t(() => "ab".repeat(NaN)), t(() => "ab".repeat(undefined)), t(() => "ab".repeat()), t(() => "ab".repeat(null)), t(() => "ab".repeat("2")), t(() => "ab".repeat(2.7)), t(() => "ab".repeat(-1)), t(() => "ab".repeat(Infinity)), t(() => "ab".repeat(0))]
Array.prototype[1] = "inherited"
const h = [0, , 2]
const seen = []
h.forEach((x) => seen.push(x))
const holes = [1 in h, h[1], seen, h.map((x) => x), h.filter(() => true), Object.keys(h), h.indexOf("inherited"), h.includes("inherited"), h.join(), JSON.stringify(h), [...h], h.find((x) => x === "inherited")]
delete Array.prototype[1]
const args = []
const spy = { toLocaleString(...a) { args.push(a); return "spy" } }
const locale = [
  [1234.5, new Date(0)].toLocaleString("en-US", { timeZone: "UTC" }),
  [spy, [spy], 1].toLocaleString("de", {}),
  [spy].toLocaleString(),
  args,
]
const sort = [[10, 9, 1].sort(), ["10", "9", 1].sort(), [true, false].sort(), [null, undefined, "a"].sort(), t(() => [{}, 1].sort()), t(() => [new Date(1), new Date(0)].sort()), t(() => [() => 1, 2].toSorted()), [1n, 10n, 9n].sort().map(String)]
return { repeat, holes, locale, sort }
