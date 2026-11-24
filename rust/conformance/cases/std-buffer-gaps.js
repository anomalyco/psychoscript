const t = (f) => { try { const r = f(); return r instanceof Uint8Array ? [Buffer.isBuffer(r), ...r] : r } catch (e) { return [e.name, e.message, e.code ?? null] } }
const buf = Buffer.alloc(4)
buf.writeUintBE(258, 0, 2); buf.writeUintLE(258, 2, 2)
const enc = new TextEncoder()
const eb = new Uint8Array(3)
const u = new Uint8Array([1, 2, 3, 4])
const into = Buffer.alloc(4)
return [t(() => Buffer.from(new Uint8Array([1, 2, 3, 4]), 1, 2)), Object.getPrototypeOf(Buffer) === Uint8Array, t(() => Buffer.of(1, 2)), t(() => Buffer.fromHex("0102")),
  t(() => Buffer.copyBytesFrom(new Uint8Array([1, 2, 3]), 1)), [...buf], buf.readUintBE(0, 2), buf.readUintLE(2, 2), Buffer.byteLength("hi", ""), Buffer.byteLength("hi", 5),
  Buffer.byteLength("hé", "nope"), Buffer.BYTES_PER_ELEMENT, Object.getOwnPropertyNames(Buffer).includes("BYTES_PER_ELEMENT"), t(() => Buffer.of(1, 256, "3", -1)), typeof Buffer.fromBase64,
  t(() => Buffer.copyBytesFrom(u, "1", -1)), t(() => Buffer.copyBytesFrom(u, 0, "x")), t(() => Buffer.copyBytesFrom(u, 0, 1.5)), t(() => Buffer.copyBytesFrom(u, 1e21)),
  t(() => Buffer.copyBytesFrom(u, -1)), t(() => Buffer.copyBytesFrom(u, 5, "x")), t(() => Buffer.copyBytesFrom([1])), t(() => Buffer.copyBytesFrom(u, 2 ** 53)),
  t(() => Buffer.copyBytesFrom(u, { valueOf() { return 1 } })), t(() => Buffer.copyBytesFrom(u, null)), t(() => Buffer.copyBytesFrom(u, NaN)), t(() => Buffer.copyBytesFrom(u, -0)),
  t(() => Buffer.copyBytesFrom(u, 4294967296)), t(() => Buffer.copyBytesFrom(new Uint8Array(0), "x")), t(() => Buffer.copyBytesFrom(u, undefined, 2)), t(() => Buffer.copyBytesFrom(u, 3, 0)),
  enc.encodeInto("héllo", eb), [...eb], t(() => enc.encodeInto("a", [])), enc.encodeInto("😀", new Uint8Array(3)), enc.encodeInto("a😀", new Uint8Array(5)),
  enc.encodeInto("\ud800x", new Uint8Array(5)), enc.encodeInto(undefined, new Uint8Array(20)), enc.encodeInto.length, enc.encodeInto("hi", into), [...into],
  Buffer.of.length, Buffer.copyBytesFrom.length]
