// @typed_arrays true
// The own keys of the typed arrays, their prototypes and ArrayBuffer, in order.
const names = (o) => Object.getOwnPropertyNames(o).join(",")
const out = {}
for (const K of [ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array]) {
  out[K.name] = names(K)
  out[K.name + ".prototype"] = names(K.prototype)
}
return out
