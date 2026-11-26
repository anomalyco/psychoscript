const r = await tools.shell({ command: "git status --short" })
return r.output
