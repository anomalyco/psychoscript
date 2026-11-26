const r = await Promise.allSettled([
  tools.websearch({ query: "interpreter dispatch" }),
  tools.websearch({ query: "nan boxing" }),
  tools.shell({ command: "uptime" }),
])
return r.map((x) => (x.status === "fulfilled" ? JSON.stringify(x.value).slice(0, 300) : String(x.reason))).join("\n")
