// The methods a 3D program needs: indexing, set, fill, reverse, search, join, at, iteration, Array.from, spread and
// destructuring, and how typed arrays print and serialize.
const fa = new Float32Array([0, 1.5, 2, 3])
fa.set([7, 8], 2)
fa.set(new Uint8Array([4]))
fa.set(new Float64Array([0.1]), 1)
const out = [[...fa]]
fa.fill(0.5, 1, 3)
out.push([...fa], fa.indexOf(0.5), fa.lastIndexOf(0.5), fa.lastIndexOf(0.5, 1), fa.includes(8), fa.indexOf("0.5"), fa.includes("8"))
out.push(fa.at(-1), fa.at(9), fa[9], fa[-1], fa["2"], fa.length)
fa[10] = 5
out.push(fa.length, Object.keys(fa), "10" in fa, 2 in fa)
out.push(fa.join("|"), String(fa), `${new Int32Array([1, -2])}`, fa.toString())
out.push([...fa.keys()], [...fa.entries()], [...fa.values()])
out.push([...new Int32Array([1, 2, 3]).reverse()], [...new Float64Array([1, 2]).fill(9)])
const nan = new Float64Array([NaN, 1])
out.push(nan.includes(NaN), nan.indexOf(NaN))
let s = 0
for (const x of new Float64Array([1, 2, 3])) s += x
const [a, b] = new Uint16Array([5, 6])
out.push(s, a + b, Math.max(...new Int32Array([3, 9, 4])), Array.from(new Float32Array([1, 2]), (x) => x * 2))
out.push(JSON.stringify(new Float32Array([1.5, 2])), JSON.stringify({ b: new ArrayBuffer(2) }))
out.push(Object.prototype.toString.call(fa), Object.prototype.toString.call(fa.buffer), typeof fa, Array.isArray(fa))
out.push(Object.getPrototypeOf(fa) === Float32Array.prototype, fa instanceof Float32Array, fa instanceof Uint8Array)
out.push(fa.constructor === Float32Array, Float32Array.name, new Uint32Array(2).buffer.constructor === ArrayBuffer)
console.log(new Float32Array([1.5, -2]), new Uint16Array(2), new ArrayBuffer(3))
console.log(String(new ArrayBuffer(3)))
return out
