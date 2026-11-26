let tries = 0
let last = ""
while (tries < 5) {
  const r = await tools.shell({ command: "check-status" })
  last = r.output
  if (last.includes("line 3")) break
  tries++
}
return { tries, ok: last.length > 0 }
