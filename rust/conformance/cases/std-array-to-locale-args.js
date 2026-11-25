// Without Intl, an element's toLocaleString gets no arguments; those of primitives, arrays and dates get the locales and options.
const spy = { toLocaleString(...a) { return a.length } }
const d = new Date(0)
const sub = Object.create(Date.prototype); sub.toLocaleString = (...a) => a.length
const seen = []
const n = 5
Number.prototype.toLocaleString = function (...a) { seen.push(a); return "n" }
return [[spy].toLocaleString("en-US", {}), [spy].toLocaleString(), [[spy]].toLocaleString("x"), [sub].toLocaleString("en"),
  [(...a) => 1].toLocaleString("x"), [d, d].toLocaleString("en-US", { timeZone: "UTC" }), [undefined, null, spy].toLocaleString("ar"),
  [n, [n]].toLocaleString("de-DE", { style: "percent" }), seen, [].toLocaleString.length]
