// Number and BigInt toLocaleString on the common path: the default locale, a few others, and the fraction digits
// most programs set. conformance/number-locale.json is the full matrix.
const n = 1234567.891
return [
  n.toLocaleString(), n.toLocaleString("en-US"), n.toLocaleString("de-DE"), n.toLocaleString("fr-FR"), n.toLocaleString("ja-JP"),
  (1234.5).toLocaleString("en-US", { maximumFractionDigits: 0 }), (1234.5).toLocaleString("de-DE", { maximumFractionDigits: 0 }),
  (0.1 + 0.2).toLocaleString(), (42).toLocaleString("en-US", { minimumFractionDigits: 2 }), (-0.5).toLocaleString("en-US", { maximumFractionDigits: 0 }),
  (1234.5678).toLocaleString(undefined, { maximumFractionDigits: 2 }), (1234.5678).toLocaleString([], { useGrouping: false }),
  (98.765).toLocaleString("en-US", { maximumSignificantDigits: 3 }), (5).toLocaleString("en-US", { minimumIntegerDigits: 2 }),
  (12345678901234567890n).toLocaleString(), (12345678901234567890n).toLocaleString("de-DE"),
  [1234.5, 6789.25].toLocaleString("de-DE", { maximumFractionDigits: 1 }),
]
