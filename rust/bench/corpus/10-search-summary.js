const results = await tools.websearch({ query: "JavaScriptCore BigInt32" })
return results.slice(0, 5).map((i) => i.url + "\n" + (i.title || "") + "\n" + (i.content || "").slice(0, 700)).join("\n--\n")
