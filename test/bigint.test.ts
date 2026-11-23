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

  test("shows a BigInt with its suffix in the console", async () => {
    const result = await Runtime.make().execute("console.log(1n, [2n], { a: 3n }, new Map([[4n, 5n]])); return 0")
    expect(result.logs).toEqual(['1n [2n] {"a":3n} Map(1) [[4n,5n]]'])
  })
})
