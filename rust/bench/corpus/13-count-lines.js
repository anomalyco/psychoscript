const file = await tools.read({ path: "big.log" })
const counts = new Map()
for (const line of file.content.split("\n")) {
  const key = line.split(" ")[0]
  counts.set(key, (counts.get(key) || 0) + 1)
}
return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => v + " " + k).join("\n")
