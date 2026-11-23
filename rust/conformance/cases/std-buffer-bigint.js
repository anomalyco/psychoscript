// Buffer's 64-bit integers are BigInts, read and written like Node's.
const attempt = (f) => { try { const v = f(); return typeof v === "bigint" ? `${v}n` : v } catch (e) { return e.name + ": " + e.message } }
const b = Buffer.alloc(16)
b.writeBigInt64LE(-2n, 0)
b.writeBigUInt64BE(2n ** 64n - 1n, 8)
const c = Buffer.alloc(8)
return [
  attempt(() => b.readBigInt64LE(0)), attempt(() => b.readBigUInt64LE(0)), attempt(() => b.readBigUint64LE()),
  attempt(() => b.readBigUint64BE(8)), attempt(() => b.readBigInt64BE(8)), attempt(() => b.readBigUInt64BE(8)),
  typeof b.readBigInt64BE(8), b.toString("hex"),
  attempt(() => c.writeBigInt64BE(2n ** 63n - 1n)), c.toString("hex"), attempt(() => c.writeBigInt64LE(-(2n ** 63n), 0)),
  c.toString("hex"), attempt(() => c.writeBigUint64LE(1n, 0)), attempt(() => c.writeBigUInt64BE(0x0102030405060708n)),
  c.toString("hex"), attempt(() => c.readBigInt64LE(1)), attempt(() => c.readBigInt64LE(-1)),
  attempt(() => c.readBigInt64LE(0.5)), attempt(() => c.readBigInt64LE("0")), attempt(() => c.writeBigInt64LE(1, 0)),
  attempt(() => c.writeBigInt64LE("1", 0)), attempt(() => c.writeBigInt64LE(2n ** 63n, 0)),
  attempt(() => c.writeBigInt64LE(-(2n ** 63n) - 1n, 0)), attempt(() => c.writeBigUInt64LE(-1n, 0)),
  attempt(() => c.writeBigUInt64LE(2n ** 64n, 0)), attempt(() => c.writeBigUInt64LE(2n ** 64n - 1n, 1)),
  attempt(() => c.writeBigInt64BE(5n)), attempt(() => c.writeBigInt64BE()), c.toString("hex"),
  attempt(() => Buffer.alloc(4).readBigInt64LE(0)), attempt(() => c.writeBigInt64LE(2n ** 100n, 0)),
  attempt(() => c.writeBigInt64LE(1, 5)), attempt(() => c.writeBigInt64LE(2n ** 64n, 5)), attempt(() => c.writeBigInt64LE(true, 0)),
  attempt(() => c.writeBigInt64LE({}, 0)), attempt(() => c.writeBigInt64LE(null, 0)), attempt(() => c.writeBigInt64LE(1n, null)),
  attempt(() => c.writeBigInt64LE(1n, NaN)), attempt(() => c.readBigInt64LE(1n)), attempt(() => Buffer.alloc(4).writeBigInt64LE(2n ** 70n, 0)),
  attempt(() => c.writeBigInt64LE("x".repeat(40), 0)), attempt(() => c.writeBigUInt64LE(-(2n ** 100n), 0)),
  attempt(() => c.writeInt32LE(1n, 0)), attempt(() => c.readInt32LE(1n)), attempt(() => c.writeBigInt64LE([1n], 0)),
  attempt(() => c.writeBigInt64LE(-(2n ** 32n) - 1n, 0)), attempt(() => c.writeBigUInt64LE(-(2n ** 32n), 0)),
  b.writeBigInt64LE.length, b.readBigUint64BE.name,
]
