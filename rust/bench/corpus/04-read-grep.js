const file = await tools.read({ path: "src/vm.rs" })
const lines = file.content.split("\n")
const hits = []
for (let i = 0; i < lines.length; i++) if (lines[i].includes("fn ")) hits.push((i + 1) + ": " + lines[i].trim())
return hits.slice(0, 40).join("\n")
