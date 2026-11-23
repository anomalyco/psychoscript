// BigInt's TypeErrors and RangeErrors, and the size cap: no operator makes a BigInt past 2^20 bits.
const attempt = (f) => { try { const v = f(); return typeof v === "bigint" ? `${v}n` : v } catch (e) { return e.name + ": " + e.message } }
const max = (2n ** 1048575n - 1n) * 2n + 1n
return [
  attempt(() => 1n + 1), attempt(() => 1 * 2n), attempt(() => 1n - "1"), attempt(() => 2n ** 1), attempt(() => 1n & 1),
  attempt(() => +1n), attempt(() => Math.abs(1n)), attempt(() => 1n >>> 0n), attempt(() => 1n / 0n),
  attempt(() => 1n % 0n), attempt(() => 2n ** -1n), attempt(() => Symbol.iterator + 1n),
  attempt(() => 1n + Symbol.iterator), attempt(() => 1n < Symbol.iterator), attempt(() => "a".charAt(1n)),
  attempt(() => [1, 2].slice(1n)), attempt(() => isNaN(1n)), attempt(() => new BigInt(1)),
  attempt(() => { let x = 1n; x += 1; return x }), attempt(() => { let x = 1; x *= 2n; return x }),
  attempt(() => { const a = [1n]; a[0]++; return a[0] }), attempt(() => { const o = { n: 1n }; o.n -= 1; return o.n }),
  attempt(() => 2n ** 10000000n), attempt(() => 3n ** 700000n), attempt(() => 1n << 2000000n),
  attempt(() => 1n >> -2000000n), attempt(() => 2n ** 1000000n * 2n ** 1000000n), attempt(() => ~max),
  attempt(() => -max === -max), attempt(() => max + 1n), attempt(() => { let m = max; m++; return m }),
  attempt(() => { let m = -max; m--; return m }), attempt(() => String(2n ** 1048575n).length),
  attempt(() => 0n ** 10000000n), attempt(() => (-1n) ** 10000001n), attempt(() => 1n ** 10000000n),
  attempt(() => String(BigInt("0x" + "f".repeat(262144))).length), attempt(() => BigInt("0x" + "f".repeat(262145))),
  attempt(() => BigInt("9".repeat(400000))), attempt(() => BigInt.asUintN(2 ** 40, -1n)),
  attempt(() => BigInt.asIntN(2 ** 40, -5n)),
  attempt(() => Object.defineProperty(1n, "x", { value: 1 })), attempt(() => { "use strict"; (1n).x = 1 }),
  attempt(() => (1n).x), attempt(() => delete (1n).x), attempt(() => 1n.constructor === BigInt), attempt(() => Object(1n)),
]
