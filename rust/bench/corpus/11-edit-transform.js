const p = "/repo/src/collector.rs"
let s = (await tools.read({ path: p })).content
const rep = (a, b) => { if (!s.includes(a)) throw new Error("missing: " + a.slice(0, 60)); s = s.replace(a, b) }
rep("fn item_0", "pub fn item_0")
rep("let mut", "let")
s = s.replaceAll("\t", "    ")
await tools.write({ path: p, content: s })
return s.length
