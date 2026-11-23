// BigInts on the stack, in locals, closures and collections across host stops, and through the host boundary.
const attempt = async (f) => { try { return await f() } catch (e) { return e.name + ": " + e.message } }
let factorial = 1n
const steps = new Map()
const seen = new Set()
for (let i = 1n; i <= 30n; i++) {
  factorial *= i
  steps.set(i, factorial)
  seen.add(factorial % 7n)
  if (i % 10n === 0n) await tools.echo({ i: String(i) })
}
const keep = () => factorial
const big = 2n ** 5000n - 1n
await tools.echo({})
return [
  String(factorial), String(steps.get(20n)), typeof [...steps.keys()][0], seen.size, String(keep() / steps.get(29n)),
  steps.get(30n) === factorial, String(big % 1000n), (big + 1n) === 2n ** 5000n, String(-big).length,
  await attempt(() => tools.echo(1n)), await attempt(() => tools.echo({ a: [2n] })),
]
