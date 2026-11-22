// Views share their buffer: writes through one show through every other, and every view of one buffer gives the same
// ArrayBuffer. slice copies.
const buf = new ArrayBuffer(16)
const fa = new Float32Array(buf)
const ua = new Uint8Array(buf, 4, 4)
fa[1] = 1
const out = [[...ua], fa.buffer === buf, ua.buffer === buf]
const sub = fa.subarray(1, 3)
sub[0] = 2
out.push(fa[1], sub.length, sub.byteOffset, sub.buffer === buf, sub.subarray(1).byteOffset)
const sl = fa.slice(1, 3)
sl[0] = 9
out.push(fa[1], sl.buffer === buf, sl.byteOffset, sl.buffer.byteLength)
const lazy = new Int32Array(4)
const lazySub = lazy.subarray(2)
lazySub[0] = 7
out.push(lazy[2], lazySub.buffer === lazy.buffer, lazy.buffer.byteLength)
const bytes = new Uint8Array(lazy.buffer)
bytes[0] = 1
bytes[1] = 1
out.push(lazy[0], new Uint32Array(new Uint8Array([1, 0, 0, 128]).buffer)[0])
const copy = buf.slice(4, 8)
out.push(new Uint8Array(copy).join(","), copy === buf, buf.slice(-4).byteLength, buf.slice(8, 4).byteLength)
out.push(ArrayBuffer.isView(fa), ArrayBuffer.isView(buf), ArrayBuffer.isView([]), ArrayBuffer.isView(new Uint8Array(1).buffer))
return out
