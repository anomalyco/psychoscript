// @typed_arrays true
// Constructors from a length, an array, an iterable, a typed array and an ArrayBuffer with offset and length; from, of,
// and BYTES_PER_ELEMENT.
const kinds = [Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array]
const sizes = kinds.map((K) => [K.name, K.BYTES_PER_ELEMENT, new K(1).BYTES_PER_ELEMENT, new K(3).byteLength, K.length])
const fromIterable = new Float32Array(new Set([1, 2, 3]))
const fromGenerator = new Int32Array((function* () { yield 4; yield 5 })())
const buffer = new ArrayBuffer(16)
const whole = new Float32Array(buffer)
const part = new Uint16Array(buffer, 4, 3)
const rest = new Float64Array(buffer, 8)
const mapped = Float32Array.from([1, 2, 3], function (x, i) { return x / 3 + i + this.k }, { k: 10 })
const of = Float64Array.of(1, "2", true)
const empty = new Float32Array()
return [
  sizes,
  [...fromIterable],
  [...fromGenerator],
  [whole.length, whole.byteOffset, whole.byteLength],
  [part.length, part.byteOffset, part.byteLength],
  [rest.length, rest.byteOffset],
  [...mapped],
  [...of],
  [empty.length, empty.byteLength, empty.buffer.byteLength],
  [buffer.byteLength, ArrayBuffer.length, new ArrayBuffer(2.9).byteLength, new ArrayBuffer().byteLength],
]
