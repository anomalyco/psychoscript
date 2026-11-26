const sh = async (c) => (await tools.shell({ command: c })).output
const slugs = ["numeric-loop", "closure-recursion", "array-callbacks", "promise-fan-out", "json-round-trip", "generator-iteration", "string-building", "map-set-ops"]
const res = []
for (const s of slugs) {
  const out = await sh("bench --filter " + s + " --json")
  try {
    const x = JSON.parse(out)[0]
    res.push(`${s.padEnd(22)} ${(x.median_instructions / 3e6).toFixed(1).padStart(8)} insn/iter ${(x.median_ms / 3).toFixed(2).padStart(7)} ns/iter`)
  } catch (e) {
    res.push(s + ": " + out.slice(0, 300))
  }
}
return res.join("\n")
