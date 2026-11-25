const t = (f) => { try { const r = f(); return [...r] } catch (e) { return [e.name, e.message] } }
return [t(() => new Float32Array({ length: 2, 0: 1.5 })), t(() => Float64Array.from({ length: 1, 0: "2" }, (x) => x * 2)), t(() => new Int32Array(2.7)),
  t(() => Uint16Array.from(5)), t(() => Uint32Array.from(null)), t(() => new Uint16Array(NaN)), t(() => new Float32Array(-1)),
  [new Float32Array(4).byteLength, new Float32Array(4).subarray(1).byteOffset, new Uint8Array(4).subarray(2).byteOffset]]
