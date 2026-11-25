// Maps, Sets, strings and arrays kept across jobs all count.
const m = new Map()
const s = new Set()
const parts = []
for (let i = 0; ; i++) {
  m.set("k" + i, [i])
  s.add({ i })
  parts.push(String(i).padStart(8, "0"))
  if (i % 100 === 0) await null
}
