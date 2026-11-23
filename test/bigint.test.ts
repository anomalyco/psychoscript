import { describe, expect, test } from "bun:test"
import { Host, Runtime } from "../src/index.js"
import { failure, value } from "./run.js"

// BigInts live inside the program. They cross no boundary: results, host arguments and JSON need text.

describe("BigInt", () => {
  test("literals and arithmetic", async () => {
    expect(
      await value(`const big = 2n ** 64n
        return [typeof 1n, String(big), String(big - 1n), String(-7n / 2n), String(-7n % 2n), String(6n * 7n),
          String(0x1fn), String(0o17n), String(0b101n), String(1_000n), String(5n & 3n), String(5n | 3n), String(5n ^ 3n),
          String(1n << 70n), String(-9n >> 1n), String(~5n), String(-(-5n))]`),
    ).toEqual([
      "bigint",
      "18446744073709551616",
      "18446744073709551615",
      "-3",
      "-1",
      "42",
      "31",
      "15",
      "5",
      "1000",
      "1",
      "7",
      "6",
      "1180591620717411303424",
      "-5",
      "-6",
      "5",
    ])
  })

  test("compares with numbers and strings, and keys collections by value", async () => {
    expect(
      await value(`const map = new Map([[1n, "a"]])
        return [1n == 1, 1n === 1, 2n > 1, 1n < 1.5, "10" == 10n, 0n ? "yes" : "no", 1n === 1n, Object.is(0n, -0n),
          map.get(1n), map.has(1), new Set([1n, 1n, 1]).size, [3n, 1n, 2n].sort().join(), [1n, 2n].includes(2n),
          [10, 20][1n], { 1n: "key" }[1]]`),
    ).toEqual([true, false, true, true, true, "no", true, true, "a", false, 2, "1,2,3", true, 20, "key"])
  })

  test("increments, compound assignment and conversion through valueOf", async () => {
    expect(
      await value(`let i = 1n
        i++
        ++i
        i += 10n
        i **= 2n
        let j = 5n
        j--
        const boxed = { valueOf() { return 3n } }
        let k = boxed
        k++
        return [String(i), String(j), String(boxed * 2n), String(k), \`\${7n}\`, "n=" + 8n]`),
    ).toEqual(["169", "4", "6", "4", "7", "n=8"])
  })

  test("the BigInt function and its methods", async () => {
    expect(
      await value(`return [BigInt(5) === 5n, BigInt(true) === 1n, BigInt(" 0x1f ") === 31n, BigInt("") === 0n,
          BigInt("-12") === -12n, BigInt(Number.MAX_SAFE_INTEGER) + 2n === 9007199254740993n,
          BigInt.asIntN(8, 255n) === -1n, BigInt.asUintN(64, -1n) === 18446744073709551615n,
          BigInt.asUintN(4, 0x1fn) === 15n, (255n).toString(16), (255n).toString(), 12345678n.toLocaleString(),
          5n.valueOf() === 5n, Number(2n ** 53n), parseInt("12n"), Object.prototype.toString.call(1n),
          typeof BigInt, BigInt.name, BigInt.length]`),
    ).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      "ff",
      "255",
      "12,345,678",
      true,
      9007199254740992,
      12,
      "[object BigInt]",
      "function",
      "BigInt",
      1,
    ])
  })

  test("fails like JS on mixed types and bad operands", async () => {
    const cases: Array<[string, string, string]> = [
      ["1n + 1", "TypeError", "Cannot mix BigInt and other types"],
      ["1 * 2n", "TypeError", "Cannot mix BigInt and other types"],
      ["+1n", "TypeError", "Cannot convert a BigInt value to a number"],
      ["Math.abs(1n)", "TypeError", "Cannot convert a BigInt value to a number"],
      ["1n >>> 0n", "TypeError", "unsigned right shift"],
      ["1n / 0n", "RangeError", "Division by zero"],
      ["1n % 0n", "RangeError", "Division by zero"],
      ["2n ** -1n", "RangeError", "Exponent must be non-negative"],
      ["BigInt(1.5)", "RangeError", "not an integer"],
      ["BigInt('1.5')", "SyntaxError", "Cannot convert"],
      ["BigInt('0x')", "SyntaxError", "Cannot convert"],
      ["BigInt(undefined)", "TypeError", "Cannot convert undefined to a BigInt"],
      ["BigInt.asIntN(-1, 1n)", "RangeError", "safe integer"],
      ["BigInt.asIntN(8, 1)", "TypeError", "Cannot convert a number to a BigInt"],
      ["BigInt.prototype.toString.call(1)", "TypeError", "requires that 'this' be a BigInt"],
      ["(1n).toString(1)", "RangeError", "radix"],
    ]
    for (const [code, type, message] of cases) {
      const error = await failure(`try { ${code} } catch (e) { throw new Error(e.name + ": " + e.message) }`)
      expect(error.message).toContain(`${type}: `)
      expect(error.message).toContain(message)
    }
  })

  test("stops a BigInt from growing past the size limit before it is computed", async () => {
    for (const code of [
      "2n ** 10000000n",
      "3n ** 700000n",
      "1n << 2000000n",
      "1n >> -2000000n",
      "BigInt('9'.repeat(400000))",
      "BigInt.asUintN(2 ** 40, -1n)",
      "2n ** 1000000n * 2n ** 1000000n",
    ]) {
      const error = await failure(`return String(${code}).length`)
      expect(error.message).toContain("Maximum BigInt size exceeded")
    }
    expect(await value("return [String(3n ** 600000n).length, BigInt.asIntN(2 ** 40, -5n) === -5n]")).toEqual([
      286273,
      true,
    ])
  })

  test("compares with a huge numeric string without parsing it, giving JS's answers", async () => {
    const started = performance.now()
    expect(
      await value(`const many = "1".repeat(16_000_000)
        const negative = "-" + many
        const zeros = "0".repeat(2_000_000) + "42"
        const hex = "0x" + "0".repeat(5000) + "ff"
        return [many == 1n, many > 1n, many < 1n, 1n < many, negative < 1n, 1n != many, zeros == 42n, 42n <= zeros,
          hex == 255n, (many + "x") == 1n, (many + "x") < 1n, (many + "x") > 1n, " 7 ".padEnd(5000) == 7n]`),
    ).toEqual([false, true, false, true, true, true, true, true, true, false, false, false, true])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("a BigInt literal past the size limit is a RangeError, and so is ~ or - stepping past it", async () => {
    const huge = `0x${"f".repeat(300_000)}n`
    expect((await failure(`return String(${huge}).length`)).message).toContain("Maximum BigInt size exceeded")
    expect((await failure("const max = (2n ** 1048575n - 1n) * 2n + 1n; return String(~max)")).message).toContain(
      "Maximum BigInt size exceeded",
    )
    expect(await value("const max = (2n ** 1048575n - 1n) * 2n + 1n; return String(-max === -max)")).toBe("true")
  })

  test("refuses to cross to the host or serialize to JSON without toJSON", async () => {
    expect((await failure("return 1n")).message).toContain("A BigInt cannot cross to the host")
    expect((await failure("return { a: [1n] }")).message).toContain("A BigInt cannot cross to the host")
    expect((await failure("return JSON.stringify({ a: 1n })")).message).toContain(
      "Do not know how to serialize a BigInt",
    )
    expect(
      await value(`BigInt.prototype.toJSON = function () { return this.toString() }
        return [JSON.stringify({ a: 1n, b: [2n] }), { c: 3n }]`),
    ).toEqual(['{"a":"1","b":["2"]}', { c: "3" }])
    const runtime = Runtime.make({ globals: () => ({ take: Host.fn(([n]) => n) }) })
    const result = await runtime.execute("return take(1n)")
    expect(result.ok ? undefined : result.error.message).toContain("cannot be passed to the host")
  })

  test("Buffer reads and writes 64-bit integers as BigInts", async () => {
    expect(
      await value(`const b = Buffer.alloc(16)
        b.writeBigInt64LE(-2n, 0)
        b.writeBigUInt64BE(2n ** 64n - 1n, 8)
        return [String(b.readBigInt64LE(0)), String(b.readBigUInt64LE(0)), String(b.readBigUint64BE(8)),
          typeof b.readBigInt64BE(8), b.toString("hex")]`),
    ).toEqual(["-2", "18446744073709551614", "18446744073709551615", "bigint", "feffffffffffffffffffffffffffffff"])
  })

  test("join refuses a too-long result before converting", async () => {
    const started = performance.now()
    const error = await failure("const x = 2n ** 1048575n; return new Array(100).fill(x).join('').length")
    expect(error.message).toContain("Invalid string length")
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("the default sort converts equal huge BigInts once", async () => {
    const started = performance.now()
    expect(
      await value(`const base = 2n ** 1048575n
        const sorted = Array.from({ length: 200 }, (_, i) => base + BigInt((i * 3) % 5)).sort()
        return [sorted.length, String(sorted[0] - base), String(sorted[39] - base), String(sorted[40] - base),
          String(sorted[199] - base)]`),
    ).toEqual([200, "0", "0", "1", "4"])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("shows a BigInt with its suffix in the console", async () => {
    const result = await Runtime.make().execute("console.log(1n, [2n], { a: 3n }, new Map([[4n, 5n]])); return 0")
    expect(result.logs).toEqual(['1n [2n] {"a":3n} Map(1) [[4n,5n]]'])
  })
})
