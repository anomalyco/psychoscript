const made = Promise.try(5)
const executor = function (resolve) { resolve(this.v) }.bind({ v: 7 })
const add = function (x) { return x + this.n }.bind({ n: 1 })
const out = [made instanceof Promise, await made.catch((e) => [e.name, e.message, e.stack]), await new Promise(executor),
  await Promise.resolve(1).then(add), await Promise.try(add, 2)]
for (const f of [Math.max, Array.prototype.map, console.log, Promise.resolve, Symbol, Object, tools.echo, tools, 5, null]) {
  try { new Promise(f).catch(() => 0); out.push("ok") } catch (e) { out.push(e.message) }
}
try { await Promise.try(tools) } catch (e) { out.push(e.message) }
try { await Promise.try(null) } catch (e) { out.push(e.message) }
return out
