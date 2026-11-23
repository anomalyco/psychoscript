// BigInt literals, operators and comparisons, compared by their text: BigInts cannot cross to the host.
const s = (v) => (Array.isArray(v) ? v.map(s) : typeof v === "bigint" ? `${v}n` : v)
const big = 2n ** 64n
let i = 1n
i++
++i
i += 10n
i **= 2n
let j = 5n
j--
const boxed = { valueOf() { return 3n } }
let k = boxed
k++
const neg = -boxed
const map = new Map([[1n, "a"], [2n ** 70n, "b"]])
return s([
  typeof 1n, big, big - 1n, -7n / 2n, -7n % 2n, 7n % -2n, 6n * 7n, 0x1fn, 0o17n, 0b101n, 1_000n, 0n, -0n,
  5n & 3n, 5n | 3n, 5n ^ 3n, -5n & 3n, -5n | 3n, -5n ^ -3n, 1n << 70n, -9n >> 1n, -1n >> 100n, 8n >> -2n,
  1n << -1n, ~5n, ~-1n, -(-5n), 0n ** 0n, (-1n) ** 3n, (-1n) ** 4n, 2n ** 1n, 3n ** 40n,
  i, j, boxed * 2n, k, neg, `${7n}`, "n=" + 8n, 8n + "", [1n] + "", String(-12n), 123456789012345678901234567890n,
  1n == 1, 1n === 1, 2n > 1, 1n < 1.5, 2n > 1.5, -1n < -0.5, "10" == 10n, 10n == "0xa", "x" == 1n, 1n < "2",
  "1.5" > 1n, 1n <= "1", 1n >= true, null == 0n, undefined == 0n, 0n == false, 1n == true, 1n < NaN, 1n > -Infinity,
  1n < Infinity, 9007199254740993n == 9007199254740992, 9007199254740993n > 9007199254740992,
  0n ? "yes" : "no", 1n && "and", 0n || "or", !0n, !!7n, 1n === 1n, big === 2n ** 64n, Object.is(0n, -0n),
  [1n, 2n].includes(2n), [1n, 2n].indexOf(2n), new Set([1n, 1n, 1, 2n ** 70n, 2n ** 70n]).size,
  map.get(1n), map.get(2n ** 70n), map.has(1), [10, 20][1n], { 1n: "key" }[1], { [2n]: "two" }["2"],
  1n in [5, 6], [3n, 1n, 2n].sort().join(), [10n, 9n, 1n].sort((a, b) => (a < b ? -1 : 1)),
  ({ x: 1n }).x === 1n, 5n.toString(), (255n).toString(16), 12345678n.toLocaleString(),
])
