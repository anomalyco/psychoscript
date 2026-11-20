import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Host, Runtime } from "../src/effect/index.js"
import { failure, value } from "./run.js"

// BigInt as ECMAScript defines it, held natively. BigInts never cross a host boundary, which is JSON-like.

/** Each expression's value as text (`1n` for a BigInt), or the name and message of what it throws. */
const outcomes = (expressions: ReadonlyArray<string>) =>
  value(`
    const show = (v) => typeof v === "bigint" ? v + "n" : v
    return [${expressions.map((expression) => `(() => { try { return show(${expression}) } catch (e) { return e.name + ": " + e.message } })()`).join(", ")}]`)

const run = (code: string, globals: Runtime.Globals = {}) =>
  Effect.runPromise(Runtime.make({ globals: () => globals }).execute(code))

describe("BigInt literals", () => {
  test("are bigints in every base, with separators", async () => {
    expect(await outcomes([`typeof 1n`, `0x1Fn`, `0o17n`, `0b101n`, `1_000_000n`, `9007199254740993n`, `-0n`])).toEqual(
      ["bigint", "31n", "15n", "5n", "1000000n", "9007199254740993n", "0n"],
    )
  })

  test("work as property keys", async () => {
    expect(
      await value(`const o = { 1n: "a", [2n]: "b" }; return [Object.keys(o), o[1n], [5, 6][1n], "xy"[1n]]`),
    ).toEqual([["1", "2"], "a", 6, "y"])
  })
})

describe("BigInt arithmetic", () => {
  test("is exact, truncates division toward zero, and keeps the dividend's sign for %", async () => {
    expect(
      await outcomes([
        `2n ** 64n`,
        `0xFEDCBA9876543210n * 3n`,
        `7n / 2n`,
        `-7n / 2n`,
        `-7n % 3n`,
        `7n % -3n`,
        `0n ** 0n`,
        `-(5n)`,
        `~5n`,
        `5n & 3n`,
        `5n | 3n`,
        `5n ^ 3n`,
        `1n << 70n`,
        `-9n >> 1n`,
        `1n << -1n`,
      ]),
    ).toEqual([
      "18446744073709551616n",
      "55094275633479194160n",
      "3n",
      "-3n",
      "-1n",
      "1n",
      "1n",
      "-5n",
      "-6n",
      "1n",
      "7n",
      "6n",
      "1180591620717411303424n",
      "-5n",
      "0n",
    ])
  })

  test("updates through ++, --, and compound assignment", async () => {
    expect(
      await value(`let x = 1n
        const seen = [String(x++), String(x), String(++x), String(x--), String(--x)]
        x **= 10n; x %= 1000n; x -= 1n; x *= 3n; x /= 2n; x &= 0xffn; x |= 0x100n; x ^= 1n; x <<= 2n; x >>= 1n
        const o = { n: 1n }
        o.n++
        o.n += 40n
        return [seen, String(x), String(o.n)]`),
    ).toEqual([["1", "2", "3", "3", "1"], "514", "42"])
  })

  test("refuses to mix with Numbers, unary plus, >>>, a zero divisor, and a negative exponent", async () => {
    expect(
      await outcomes([
        `1n + 1`,
        `1n * 1.5`,
        `1n + true`,
        `1n + null`,
        `+1n`,
        `1n >>> 0n`,
        `1n / 0n`,
        `1n % 0n`,
        `2n ** -1n`,
      ]),
    ).toEqual([
      "TypeError: Cannot mix BigInt and other types, use explicit conversions.",
      "TypeError: Cannot mix BigInt and other types, use explicit conversions.",
      "TypeError: Cannot mix BigInt and other types, use explicit conversions.",
      "TypeError: Cannot mix BigInt and other types, use explicit conversions.",
      "TypeError: Cannot convert a BigInt value to a number.",
      "TypeError: BigInts have no unsigned right shift, use >> instead.",
      "RangeError: Division by zero.",
      "RangeError: Division by zero.",
      "RangeError: Exponent must be non-negative.",
    ])
  })

  test("converts objects through valueOf", async () => {
    expect(
      await outcomes([
        `({ valueOf() { return 2n } }) * 3n`,
        `-({ valueOf() { return 2n } })`,
        `(() => { let o = { valueOf() { return 2n } }; o++; return o })()`,
        `({ valueOf() { return 2n } }) == 2`,
        `({ valueOf() { return 2n } }) + 1`,
      ]),
    ).toEqual(["6n", "-2n", "3n", true, "TypeError: Cannot mix BigInt and other types, use explicit conversions."])
  })

  test("concatenates with strings", async () => {
    expect(
      await outcomes([`1n + "x"`, `"x" + 1n`, "`${-5n}`", `String(10n)`, `[1n, 2n].join("-")`, `[3n] + ""`]),
    ).toEqual(["1x", "x1", "-5", "10", "1-2", "3"])
  })
})

describe("BigInt comparison", () => {
  test("compares with Numbers and strings by mathematical value", async () => {
    expect(
      await outcomes([
        `1n == 1`,
        `1n === 1`,
        `1n == "1"`,
        `1n == "x"`,
        `1n == true`,
        `0n == ""`,
        `1n < 1.5`,
        `2n > "1"`,
        `1n < "x"`,
        `1n < NaN`,
        `-1n > -Infinity`,
        `2n ** 64n > Number.MAX_SAFE_INTEGER`,
        `Object.is(0n, -0n)`,
        `[!!0n, !!1n, 0n ? 1 : 2]`,
        `0n ?? 3`,
      ]),
    ).toEqual([
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      [false, true, 2],
      "0n",
    ])
  })

  test("selects switch cases strictly, keys Maps and Sets by value, and sorts", async () => {
    expect(
      await value(`const pick = (v) => { switch (v) { case 1: return "number"; case 1n: return "bigint" } }
        const m = new Map([[1n, "a"]])
        return [pick(1n), pick(1), m.get(1n), m.has(1), new Set([1n, 1n, 1]).size, [1n].includes(1n), [1n].indexOf(1),
          [10n, 9n, 1n].sort().join(), [10n, 9n, 1n].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join()]`),
    ).toEqual(["bigint", "number", "a", false, 2, true, -1, "1,10,9", "1,9,10"])
  })
})

describe("BigInt()", () => {
  test("converts integral Numbers, strings, and booleans", async () => {
    expect(
      await outcomes([
        `BigInt(10)`,
        `BigInt(-0)`,
        `BigInt(1e21)`,
        `BigInt(" 0x10 ")`,
        `BigInt("0b101")`,
        `BigInt("-12")`,
        `BigInt("")`,
        `BigInt(true)`,
        `BigInt({ valueOf() { return "7" } })`,
      ]),
    ).toEqual(["10n", "0n", "1000000000000000000000n", "16n", "5n", "-12n", "0n", "1n", "7n"])
  })

  test("refuses fractions, malformed strings, nullish values, and new", async () => {
    expect(
      await outcomes([
        `BigInt(1.5)`,
        `BigInt(NaN)`,
        `BigInt("1n")`,
        `BigInt("0x")`,
        `BigInt(undefined)`,
        `new BigInt(1)`,
      ]),
    ).toEqual([
      "RangeError: The number 1.5 cannot be converted to a BigInt because it is not an integer.",
      "RangeError: The number NaN cannot be converted to a BigInt because it is not an integer.",
      "SyntaxError: Cannot convert 1n to a BigInt.",
      "SyntaxError: Cannot convert 0x to a BigInt.",
      "TypeError: Cannot convert undefined to a BigInt.",
      "TypeError: BigInt is not a constructor.",
    ])
  })

  test("asIntN and asUintN wrap to a width", async () => {
    expect(
      await outcomes([
        `BigInt.asIntN(64, 2n ** 63n)`,
        `BigInt.asIntN(8, 255n)`,
        `BigInt.asUintN(32, -1n)`,
        `BigInt.asUintN(0, 5n)`,
        `BigInt.asUintN("8", "257")`,
        `BigInt.asIntN(8, 1)`,
        `BigInt.asIntN(-1, 1n)`,
      ]),
    ).toEqual([
      "-9223372036854775808n",
      "-1n",
      "4294967295n",
      "0n",
      "1n",
      "TypeError: Cannot convert 1 to a BigInt.",
      "RangeError: Invalid value: not (convertible to) a safe integer.",
    ])
  })

  test("has a prototype with toString, toLocaleString, and valueOf", async () => {
    expect(
      await outcomes([
        `(255n).toString(16)`,
        `(-255n).toString(2)`,
        `(5n).toString({ valueOf() { return 2 } })`,
        `(1234567n).toLocaleString()`,
        `(5n).valueOf()`,
        `(10n).toString(37)`,
        `BigInt.prototype.valueOf.call(1)`,
        `Object.getPrototypeOf(1n) === BigInt.prototype && (1n).constructor === BigInt`,
        `Object.prototype.toString.call(1n)`,
        `[BigInt.name, BigInt.length, BigInt.asIntN.length]`,
      ]),
    ).toEqual([
      "ff",
      "-11111111",
      "101",
      "1,234,567",
      "5n",
      "RangeError: toString() radix must be between 2 and 36.",
      "TypeError: BigInt.prototype.valueOf requires that 'this' be a BigInt.",
      true,
      "[object BigInt]",
      ["BigInt", 1, 2],
    ])
  })
})

describe("BigInt conversions", () => {
  test("Number() converts, while ToNumber in Math, isNaN, and the Number methods refuses", async () => {
    expect(
      await outcomes([
        `Number(2n ** 53n + 1n)`,
        `parseInt(15n)`,
        `Number.isInteger(1n)`,
        `Math.max(1n)`,
        `isNaN(1n)`,
        `"abc".at(1n)`,
        `new Date(1n)`,
        `Number.prototype.toString.call(1n)`,
      ]),
    ).toEqual([
      9007199254740992,
      15,
      false,
      "TypeError: Cannot convert a BigInt value to a number.",
      "TypeError: Cannot convert a BigInt value to a number.",
      "TypeError: Cannot convert a BigInt value to a number.",
      "TypeError: Cannot convert a BigInt value to a number.",
      "TypeError: Number.prototype.toString requires that 'this' be a Number.",
    ])
  })

  test("JSON.stringify throws unless a toJSON or replacer converts", async () => {
    expect(
      await outcomes([
        `JSON.stringify(1n)`,
        `JSON.stringify({ a: [1n] })`,
        `JSON.stringify({ a: 1n }, (k, v) => (typeof v === "bigint" ? String(v) : v))`,
        `(() => { BigInt.prototype.toJSON = function () { return this.toString() }; return JSON.stringify({ a: 1n, b: [2n] }) })()`,
        `structuredClone({ a: 5n }).a`,
      ]),
    ).toEqual([
      "TypeError: Do not know how to serialize a BigInt.",
      "TypeError: Do not know how to serialize a BigInt.",
      `{"a":"1"}`,
      `{"a":"1","b":["2"]}`,
      "5n",
    ])
  })

  test("console shows BigInts with their n", async () => {
    const result = await run(`console.log(1n, { a: 2n }, [-3n])`)
    expect(result.logs).toEqual([`1n {"a":2n} [-3n]`])
  })

  test("64-bit hashing and LCGs work as in JS", async () => {
    expect(
      await value(`let h = 0xcbf29ce484222325n
        for (const c of "hello") { h ^= BigInt(c.charCodeAt(0)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
        let s = 12345n
        const out = []
        for (let i = 0; i < 3; i++) { s = (s * 6364136223846793005n + 1442695040888963407n) % (2n ** 64n); out.push(Number(s >> 33n)) }
        return [h.toString(16), out]`),
    ).toEqual(["a430d84680aabd0b", [235318264, 569910583, 1901863042]])
  })
})

describe("BigInt limits", () => {
  test("a result past the host's BigInt size, or a string past the string limit, is a RangeError", async () => {
    expect(
      await outcomes([
        `1n << 100000000000n`,
        `BigInt.asUintN(2 ** 53 - 1, -1n)`,
        `String(2n ** 60000000n)`,
        `"" + 2n ** 60000000n`,
      ]),
    ).toEqual([
      "RangeError: Maximum BigInt size exceeded.",
      "RangeError: Maximum BigInt size exceeded.",
      "RangeError: Invalid string length",
      "RangeError: Invalid string length",
    ])
  })
})

describe("Buffer BigInt methods", () => {
  test("read and write 64-bit integers", async () => {
    expect(
      await value(`const b = Buffer.alloc(16)
        b.writeBigInt64LE(-2n)
        b.writeBigUInt64BE(2n ** 64n - 2n, 8)
        return [String(b.readBigInt64LE()), String(b.readBigUInt64LE()), String(b.readBigUint64BE(8)), String(b.readBigInt64BE(8)), b.toString("hex")]`),
    ).toEqual(["-2", "18446744073709551614", "18446744073709551614", "-2", "fefffffffffffffffffffffffffffffe"])
  })

  test("a value out of range is a RangeError", async () => {
    expect((await failure(`Buffer.alloc(8).writeBigInt64LE(2n ** 64n)`)).message).toContain("RangeError")
  })
})

describe("the host boundary", () => {
  test("a BigInt result is refused with a hint", async () => {
    const result = await run(`return { total: 1n }`)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe(
        "TypeError: A BigInt cannot cross to the host; convert it first, e.g. `String(value)`, or `Number(value)` if it is small enough.",
      )
    }
  })

  test("a BigInt argument fails the call, catchably", async () => {
    const calls: Array<unknown> = []
    const result = await run(
      `try { echo({ n: 1n }) } catch (e) { return [e.name, e.message, String(echo({ n: String(2n) }).n)] }`,
      { echo: Host.fn(([v]) => (calls.push(v), v)) },
    )
    expect(result.ok && result.value).toEqual([
      "TypeError",
      "Argument 1 to echo contains a BigInt, which cannot be passed to the host; convert it first, e.g. `String(value)`, or `Number(value)` if it is small enough.",
      "2",
    ])
    expect(calls).toEqual([{ n: "2" }])
  })

  test("a host BigInt is refused", async () => {
    const result = await run(`try { big() } catch (e) { return e.message }`, { big: Host.fn(() => 1n as never) })
    expect(result.ok && result.value).toBe(
      "big produced a BigInt, which cannot cross from the host; return it as a string or number.",
    )
  })
})
