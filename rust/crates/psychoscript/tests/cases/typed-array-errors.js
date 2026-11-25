// What fails, and how: bad lengths and offsets, a missing new, a set past the end, the wrong receiver, read-only
// properties, and the Array methods typed arrays here leave out.
const buf = new ArrayBuffer(16)
const fa = new Float32Array(buf)
const errs = []
for (const fn of [
  () => new Float32Array(buf, 2),
  () => new Float32Array(new ArrayBuffer(6)),
  () => new Float32Array(buf, 20),
  () => new Float32Array(buf, -4),
  () => new Float32Array(buf, 4, 10),
  () => new Float32Array(buf, 0, -1),
  () => new Float32Array(-1),
  () => new Float32Array(1.5),
  () => new Uint16Array({ length: 2 }),
  () => Float32Array(2),
  () => ArrayBuffer(2),
  () => fa.set([1, 2, 3], 3),
  () => fa.set([1], -1),
  () => new ArrayBuffer(-1),
  () => Float32Array.prototype.at.call([], 0),
  () => Float32Array.prototype.at.call(buf, 0),
  () => ArrayBuffer.prototype.slice.call(fa),
  () => Uint8Array.prototype.toHex.call(fa),
  () => { fa.length = 3 },
  () => { fa.buffer = null },
  () => fa.map((x) => x),
  () => fa.forEach((x) => x),
  () => new TextDecoder().decode(fa),
  () => Float32Array.from([1], 5),
  () => Float32Array.from(5),
  () => delete fa[0],
  () => Object.defineProperty(fa, "0", { get() { return 1 } }),
]) {
  try {
    fn()
    errs.push("ok")
  } catch (e) {
    errs.push(e.name + ": " + e.message)
  }
}
fa[100] = 1
return [errs, fa[100], fa.length]
