const seen = []
JSON.parse('{"a":[1e1,"x\\u0041", -0, 0, null, true, {}],"b":2, "c": {"d": 5}, "c": {"d": -0.0}, "__proto__": 1}', function (key, item, context) {
  if (key === "a") this.b = 3
  if (key === "0" && item === 10) this[2] = 0
  seen.push([key, context.source ?? null, Object.keys(context), Object.getPrototypeOf(context) === Object.prototype])
  return item
})
const replaced = []
JSON.parse("[1, [2], 3]", (k, v, c) => { replaced.push([k, c.source ?? null]); return k === "0" ? 7 : v })
const args = []
JSON.parse('{"x": tools}'.replace("tools", '"t"'), function (...a) { args.push(a.length); return a[1] })
return [JSON.parse("1.0", (key, item, context) => context.source), JSON.parse(' "s" ', (k, v, c) => c.source), seen, replaced, args,
  await JSON.parse('[1, 2]', (k, v, c) => k === "" ? Promise.all(v.map((x) => tools.echo({ id: x }))) : v)]
