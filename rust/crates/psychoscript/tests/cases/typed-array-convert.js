// Each typed array converts what is written as JS does: float32 rounding, integer wrapping, NaN and infinities as 0.
const f = new Float32Array(6)
f[0] = 1.1; f[1] = 16777217; f[2] = 1e40; f[3] = -0.1; f[4] = -1e-50; f[5] = "2.5"
const u16 = new Uint16Array([65536 + 3, -1, 1.9, NaN, Infinity, -65537])
const u32 = Uint32Array.of(-1, 2 ** 32 + 5, 3.7, -3.7, 2 ** 53)
const i32 = new Int32Array([2 ** 31, -(2 ** 31) - 1, -3.9, 4294967295, "12"])
const d = new Float64Array([0.1, 1 / 3, -0, 1e308 * 10])
const u8 = new Uint8Array(new Float32Array([300, -1, 1.5, 255.9]))
const back = new Float32Array(new Float64Array([1.1, 2.2]))
return [[...f].map(String), [...u16], [...u32], [...i32], [...d].map(String), [...u8], [...back], Object.is(new Float32Array([-0])[0], -0)]
