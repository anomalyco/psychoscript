const out = await tools.shell({ command: "bench --json" })
const rows = JSON.parse(out.output)
return rows
  .filter((x) => x.median_ms > 1)
  .map((x) => x.slug.padEnd(22) + " " + x.median_ms.toFixed(2).padStart(8) + " ms " + (x.median_instructions / 1e6).toFixed(1) + "M")
  .join("\n")
