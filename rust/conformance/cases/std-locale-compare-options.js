// localeCompare with locales and options, as the host's Intl.Collator takes them: numeric, sensitivity, caseFirst,
// ignorePunctuation, usage, locale tailorings and extension keywords, getters and objects among the options, and what
// it refuses.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const numeric = { get numeric() { return true } }
return [
  ["a10", "a9", "a1"].sort((x, y) => x.localeCompare(y, undefined, numeric)),
  "a".localeCompare("A", undefined, { sensitivity: "base" }),
  "a".localeCompare("á", "en", { sensitivity: "base" }),
  "a".localeCompare("A", ["en"], { sensitivity: { toString() { return "accent" } } }),
  "a".localeCompare("A", "en", { sensitivity: "case" }),
  "a".localeCompare("A", "en", { caseFirst: "upper" }),
  "a,b".localeCompare("ab", "en", { ignorePunctuation: true }),
  "ä".localeCompare("z", "sv"), "ä".localeCompare("z", "de"), "a".localeCompare("A"),
  "ch".localeCompare("cz", "es-u-co-trad"), "x".localeCompare("X", "en-u-kf-upper"),
  ["a10", "a9"].sort((x, y) => x.localeCompare(y, "en-u-kn")),
  "a".localeCompare("A", "en", { usage: "search", sensitivity: "base" }), "a".localeCompare("b", 5, 7),
  attempt(() => "a".localeCompare("b", "xx_bad")), attempt(() => "a".localeCompare("b", "")),
  attempt(() => "a".localeCompare("b", undefined, { sensitivity: "nope" })),
  attempt(() => "a".localeCompare("b", undefined, { usage: "x" })),
  attempt(() => "a".localeCompare("b", undefined, { caseFirst: "x" })),
  attempt(() => "a".localeCompare("b", undefined, { localeMatcher: "x" })),
  attempt(() => "a".localeCompare("b", undefined, { collation: "a!" })),
  attempt(() => "a".localeCompare("b", undefined, null)), attempt(() => "a".localeCompare("b", null)),
  attempt(() => "a".localeCompare("b", [1])), attempt(() => "a".localeCompare("b", ["en", { toString() { return "fr" } }])),
]
