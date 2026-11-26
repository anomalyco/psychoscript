const file = await tools.read({ path: "Cargo.toml" })
const deps = [...file.content.matchAll(/^([a-z_][a-z0-9_-]*) = /gm)].map((m) => m[1])
const version = (file.content.match(/version = "([^"]+)"/) || [])[1]
return { version, count: deps.length, deps: deps.slice(0, 20) }
