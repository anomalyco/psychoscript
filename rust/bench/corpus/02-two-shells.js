const sh = async (c) => (await tools.shell({ command: c, workdir: "/repo" })).output
return [await sh("ls src"), await sh("git log --oneline | head -5")].join("\n=====\n")
