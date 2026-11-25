// Arrays are iterated directly until a program replaces Array.prototype[Symbol.iterator] or the built-in iterators'
// next; from then on they go through the iterator protocol: destructuring, spread, for...of, Array.from, yield*,
// arguments, a Set fed from an array, bytes and keys(). An array with its own [Symbol.iterator] always does.
const results = []
const uses = () => {
  const [a, b] = [1, 2, 3]
  const spread = [...[1, 2, 3]]
  const looped = []
  for (const x of [1, 2, 3]) looped.push(x)
  const from = Array.from([1, 2, 3])
  function* delegate() { yield* [1, 2, 3] }
  const delegated = [...delegate()]
  const args = Math.max(...[1, 2, 3])
  function f() { return [...arguments] }
  const set = [...new Set([1, 2, 3])]
  return [a, b, spread, looped, from, delegated, args, f(1, 2), set, [...new Uint8Array([1, 2])], Array.from([1, 2].keys())]
}
results.push(uses())
const own = [1, 2, 3]
own[Symbol.iterator] = function* () { yield "own" }
const [x] = own
results.push([x, [...own]])
const proto = Object.getPrototypeOf([][Symbol.iterator]())
let calls = 0
const origNext = proto.next
proto.next = function () { calls++; return calls > 2 ? { done: true, value: undefined } : { done: false, value: calls * 10 } }
results.push(uses())
calls = 0
proto.next = origNext
results.push(uses())
Array.prototype[Symbol.iterator] = function* () { yield 42; yield 43 }
results.push(uses())
return results
