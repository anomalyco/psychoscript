const list = (await tools.shell({ command: "ls src" })).output.split("\n").filter(Boolean).slice(0, 20)
const files = await Promise.all(list.map((f) => tools.read({ path: "src/" + f })))
let total = 0
const sizes = files.map((f, i) => { total += f.content.length; return list[i] + " " + f.content.length })
return sizes.join("\n") + "\ntotal " + total
