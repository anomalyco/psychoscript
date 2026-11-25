const log = []
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
const g = { get [Symbol.toPrimitive]() { log.push("get"); return (h) => { log.push(h); return 7 } }, valueOf() { log.push("v"); return 1 } }
const bad = { get [Symbol.toPrimitive]() { return 5 } }
const obj = { [Symbol.toPrimitive](h) { log.push("p" + h); return {} } }
const r = [g + 1, `${g}`, g * 2, [g].join(), String(g), Math.max(g, 3), t(() => bad + 1), t(() => [obj].join()), t(() => Math.min(obj)),
  "abc".at({ [Symbol.toPrimitive]: () => 1 }), [1, 2, 3].slice({ [Symbol.toPrimitive]: () => 1 }), ({ [g]: 1 })[7]]
const viaHost = { [Symbol.toPrimitive](h) { return tools.echo({ id: h }) } }
const asyncKey = { [Symbol.toPrimitive]: async () => "a" }
const k = { [Symbol.toPrimitive]() { log.push("k"); return "key" } }
const o = {}; o[k] = 5
r.push(o.key, k in o, Object.keys(o), t(() => `${viaHost}`), t(() => asyncKey + ""), await tools.echo({ id: `${k}` }))
return [r, log]
