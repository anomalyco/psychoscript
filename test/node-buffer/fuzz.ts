// Random operation lists for the Buffer differential fuzz (see fuzz-driver.js). Seeded, so a seed always makes the
// same cases. Arguments are JSON with tags for what JSON can't carry (see `fuzzDecode` in the driver).

type Arg = unknown
export type Op = { k: string; m: string; a: Array<Arg>; t?: number; push?: boolean; zero?: boolean }

const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const encodings = [
  "utf8", "utf-8", "UTF8", "Utf-8", "hex", "HEX", "base64", "base64url", "BASE64URL", "latin1", "binary", "BINARY",
  "ascii", "ASCII", "ucs2", "ucs-2", "UCS2", "utf16le", "utf-16le", "UTF16LE",
]
const badEncodings: Array<Arg> = ["nope", "", "utf9", "utf 8", ["u"], null, 1, ["obj"], ["toString", "hex"], "base 64"]

const pieces = [
  "a", "Z", "0", "9", "f", "F", "g", "+", "/", "-", "_", "=", "==", " ", "\n", "\t", "\r", "\f", "\u000b", "\0",
  "\u007f", "\u0080", "\u00e9", "\u00ff", "\u0100", "\u0141", "\u0161", "\u013d", "\u0130", "\u20ac", "\u4e2d",
  "\ufeff", "\ufffd", "\ud83d\ude00", "\ud83d", "\ude00", "\udbff\udfff", "\ud800", "\u00a0", "AQID", "aGVsbG8",
  "6869", "deadBEEF", "QQ==", "QUI=", "QUJD", "q83v", "-_-_", "!", "\u2028",
]

export const generateCases = (seed: number, count: number, length = 12): Array<Array<Op>> => {
  const next = random(seed)
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(items: ReadonlyArray<T>): T => items[int(items.length)]!
  const chance = (p: number) => next() < p

  const string = (): string => {
    if (chance(0.03)) return pick(pieces).repeat(1000 + int(3000))
    const n = chance(0.1) ? 0 : int(chance(0.8) ? 8 : 40)
    let text = ""
    for (let i = 0; i < n; i++) text += chance(0.4) ? String.fromCharCode(32 + int(95)) : pick(pieces)
    return text
  }
  const bytes = (max = 12) => Array.from({ length: int(max) }, () => (chance(0.5) ? int(256) : pick([0, 1, 0x7f, 0x80, 0xff, 0xfe, 0x41, 0xc3, 0xed, 0xf0, 0xe2])))
  const number = (size: number): Arg =>
    pick<() => Arg>([
      () => int(size + 3),
      () => int(size + 3),
      () => size,
      () => size - 1,
      () => -1,
      () => 0 - int(size + 3),
      () => int(size) + 0.5,
      () => ["negz"],
      () => ["nan"],
      () => ["inf", pick([1, -1])],
      () => pick([2 ** 31, 2 ** 31 - 1, -(2 ** 31), 2 ** 32, 2 ** 32 + 1, 2 ** 53, 2 ** 53 - 1, -(2 ** 53), 1e21, 4294967296.5]),
      () => pick([String(int(size)), "", "abc", " 2 ", "0x1", "1e1"]),
      () => pick([["u"], null, true, false]),
      () => pick([["big", "1"], ["big", "0"], ["big", "-1"]]),
      () => pick([["obj"], ["arr", []], ["arr", [int(size)]], ["valueOf", int(size)], ["toString", String(int(size))]]),
    ])()
  // Sizes past psychoscript's array limit fail there and are allocated by Node, so sizes stay small or invalid.
  const size = (limit: number): Arg => {
    const value = number(limit)
    return typeof value === "number" && value > 1000 && value <= 2 ** 53 - 1 ? pick([-1, 2 ** 53, 1.5, 0]) : value
  }
  const index = (size: number): Arg => (chance(0.7) ? int(size + 1) : number(size))
  const encoding = (): Arg => (chance(0.85) ? pick(encodings) : pick(badEncodings))

  const intBounds = (bytes: number, signed: boolean) => {
    const bits = bytes * 8
    const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1
    const min = signed ? -(2 ** (bits - 1)) : 0
    return [min, max, min - 1, max + 1, 0, 1, -1, Math.floor(max / 2), min + 0.5, max - 0.25]
  }
  const intValue = (bytes: number, signed: boolean): Arg =>
    chance(0.75) ? pick(intBounds(bytes, signed)) : chance(0.5) ? int(2 ** Math.min(bytes * 8, 31)) - (signed ? 2 ** 30 : 0) : number(256)
  const floatValue = (): Arg =>
    pick<Arg>([0, ["negz"], ["nan"], ["inf", 1], ["inf", -1], 1.5, -1.5, 3.4028234663852886e38, 3.5e38, 1e-45, 5e-324, 1e308,
      Math.PI, 16777217, 0.1, -123456.789, "2.5", ["u"], ["big", "1"], ["valueOf", 2.25]])
  const bigValue = (signed: boolean): Arg =>
    pick<Arg>(
      signed
        ? [["big", "0"], ["big", "-1"], ["big", "9223372036854775807"], ["big", "-9223372036854775808"], ["big", "9223372036854775808"], ["big", "-9223372036854775809"], ["big", String(int(2 ** 50))]]
        : [["big", "0"], ["big", "1"], ["big", "18446744073709551615"], ["big", "18446744073709551616"], ["big", "-1"], ["big", String(int(2 ** 50))]],
    )

  return Array.from({ length: count }, () => {
    const sizes: Array<number> = []
    const ops: Array<Op> = []
    const make = (op: Op, size: number) => {
      ops.push({ ...op, push: true })
      sizes.push(size)
    }
    const slot = () => int(sizes.length)
    const create = () => {
      const kind = int(16)
      if (kind < 5) {
        const text = string()
        const args: Array<Arg> = [text]
        if (chance(0.8)) args.push(encoding())
        return make({ k: "static", m: "from", a: args }, text.length * 3)
      }
      if (kind === 5) return make({ k: "static", m: "from", a: [["arr", bytes().map((b) => (chance(0.1) ? pick<Arg>([b + 256, -b, b + 0.7, ["nan"], String(b), null]) : b))]] }, 12)
      if (kind === 6) {
        const data = bytes()
        const args: Array<Arg> = [["ab", data]]
        if (chance(0.7)) args.push(index(data.length))
        if (chance(0.5)) args.push(index(data.length))
        return make({ k: "static", m: "from", a: args }, data.length)
      }
      if (kind === 7) {
        const count = int(20)
        const args: Array<Arg> = [chance(0.9) ? count : size(20)]
        if (chance(0.7)) args.push(pick<() => Arg>([() => int(300) - 20, string, () => ["arr", bytes()], () => ["u8", bytes(3)], () => number(300), () => ["slot", slot()]])())
        if (chance(0.4)) args.push(encoding())
        return make({ k: "static", m: "alloc", a: args }, count)
      }
      if (kind === 8) return make({ k: "static", m: pick(["allocUnsafe", "allocUnsafeSlow"]), a: [chance(0.9) ? int(20) : size(20)], zero: true }, 20)
      if (kind === 9 && sizes.length > 0) {
        const list = Array.from({ length: int(4) }, () => (chance(0.95) ? ["slot", slot()] : pick<Arg>([["u8", bytes(4)], "x", 1, ["arr", [1]]])))
        const args: Array<Arg> = [chance(0.95) ? ["arr", list] : pick<Arg>(["x", ["slot", slot()], ["u"]])]
        if (chance(0.4)) args.push(chance(0.8) ? int(31) : size(30))
        return make({ k: "static", m: "concat", a: args }, 40)
      }
      if (kind === 10 && sizes.length > 0) {
        const from = slot()
        const args: Array<Arg> = []
        if (chance(0.8)) args.push(chance(0.6) ? int(sizes[from]! + 2) - 1 : number(sizes[from]!))
        if (chance(0.6)) args.push(chance(0.6) ? int(sizes[from]! + 2) - 1 : number(sizes[from]!))
        return make({ k: "method", t: from, m: pick(["slice", "subarray"]), a: args }, sizes[from]!)
      }
      if (kind === 11) return make({ k: "static", m: "of", a: bytes(6).map((b) => (chance(0.1) ? -b : b)) }, 6)
      if (kind === 12) return make({ k: "static", m: "from", a: [pick<Arg>([["json", bytes()], ["like", bytes()], ["u8", bytes()], ["valueOf", "abc"], ["obj"], 5, null, ["u"], true, ["arr", []]])] }, 12)
      if (kind === 13) {
        const data = bytes()
        const args: Array<Arg> = [["u8", data]]
        if (chance(0.6)) args.push(index(data.length))
        if (chance(0.4)) args.push(index(data.length))
        return make({ k: "static", m: "copyBytesFrom", a: args }, data.length)
      }
      if (kind === 14) return make({ k: "new", m: "Uint8Array", a: [["arr", bytes()]] }, 12)
      if (kind === 15) return make({ k: pick(["new", "call"]), m: "Buffer", a: pick<Array<Arg>>([[chance(0.8) ? int(10) : size(10)], [string(), encoding()], [["arr", bytes()]], [int(5), "hex"]]) }, 30)
      const text = string()
      return make({ k: "static", m: "from", a: [text, pick(encodings)] }, text.length * 3)
    }
    create()
    create()
    while (ops.length < length) {
      if (chance(0.2) || sizes.length === 0) {
        create()
        continue
      }
      const t = slot()
      const size = sizes[t]!
      const k = chance(0.1) ? "generic" : "method"
      const op = (m: string, a: Array<Arg>) => ops.push({ k, t, m, a })
      const kind = int(17)
      if (kind === 0) {
        const args: Array<Arg> = []
        if (chance(0.85)) args.push(chance(0.85) ? pick(encodings) : encoding())
        if (chance(0.5)) args.push(index(size))
        if (chance(0.4)) args.push(index(size))
        op(pick(["toString", "toString", "toLocaleString"]), args)
      } else if (kind === 1) {
        const args: Array<Arg> = [chance(0.95) ? string() : number(3)]
        const shape = int(6)
        if (shape === 1) args.push(encoding())
        if (shape >= 2) args.push(index(size))
        if (shape === 3) args.push(encoding())
        if (shape >= 4) args.push(index(size))
        if (shape === 5) args.push(encoding())
        op("write", args)
      } else if (kind === 2) {
        const value = pick<() => Arg>([() => int(300) - 20, string, string, () => ["slot", slot()], () => ["u8", bytes(3)], () => number(300), () => pick([true, ["big", "5"], ["valueOf", 65], ["obj"]])])()
        const args: Array<Arg> = [value]
        const shape = int(5)
        if (shape === 1) args.push(encoding())
        if (shape >= 2) args.push(index(size))
        if (shape === 3) args.push(encoding())
        if (shape >= 4) args.push(index(size))
        if (shape === 4 && chance(0.5)) args.push(encoding())
        op("fill", args)
      } else if (kind === 3) {
        const args: Array<Arg> = [chance(0.95) ? ["slot", slot()] : pick<Arg>([["u8", bytes(4)], "x", ["arr", [1]]])]
        for (let i = 0; i < int(4); i++) args.push(index(Math.max(size, 4)))
        op("copy", args)
      } else if (kind === 4) {
        const args: Array<Arg> = [chance(0.95) ? ["slot", slot()] : pick<Arg>([["u8", bytes(4)], "x", ["u"]])]
        for (let i = 0; i < int(5); i++) args.push(chance(0.7) ? int(size + 2) : number(size))
        op("compare", args)
      } else if (kind === 5) {
        op("equals", [chance(0.9) ? ["slot", slot()] : pick<Arg>([["u8", bytes(3)], "x"])])
      } else if (kind <= 7) {
        // Node 24 and 25 abort the process on a UTF-8 needle with an unpaired surrogate, so needles have none.
        const wellFormed = () => string().replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "x")
        const needle = pick<() => Arg>([wellFormed, wellFormed, () => ["slot", slot()], () => int(300) - 20, () => ["u8", bytes(3)], () => number(256), () => pick<Arg>([["obj"], true, ["big", "1"]])])()
        const args: Array<Arg> = [needle]
        if (chance(0.6)) args.push(chance(0.2) ? encoding() : chance(0.6) ? int(size * 2 + 2) - size - 1 : number(size))
        if (chance(0.4)) args.push(encoding())
        op(pick(["indexOf", "lastIndexOf", "includes"]), args)
      } else if (kind === 8) {
        if (chance(0.5)) op(pick(["swap16", "swap32", "swap64", "toJSON", "reverse", "inspect"]), [])
        else {
          // The per-encoding methods Node's prototype also has.
          const prefix = pick(["ascii", "base64", "base64url", "latin1", "hex", "ucs2", "utf8"])
          const args: Array<Arg> = chance(0.5) ? [] : [string()]
          for (let i = 0; i < int(3); i++) args.push(index(size))
          if (args.length > 0 && typeof args[0] === "string") op(`${prefix}Write`, args)
          else op(`${prefix}Slice`, args)
        }
      } else {
        const width = pick([1, 2, 4, 8, 3, 5, 6])
        const endian = pick(["LE", "BE"])
        const signed = chance(0.5)
        const u = pick(["UInt", "Uint"])
        const offset = (n: number) => (chance(0.7) ? int(size - n + 3) : number(size))
        const read = chance(0.5)
        if (width === 8) {
          const name = chance(0.5) ? `Double${endian}` : `Big${signed ? "Int" : u}64${endian}`
          if (read) op(`read${name}`, chance(0.9) ? [offset(8)] : [])
          else op(`write${name}`, [name.startsWith("Double") ? floatValue() : bigValue(signed), ...(chance(0.9) ? [offset(8)] : [])])
        } else if (width === 4 && chance(0.4)) {
          if (read) op(`readFloat${endian}`, chance(0.9) ? [offset(4)] : [])
          else op(`writeFloat${endian}`, [floatValue(), ...(chance(0.9) ? [offset(4)] : [])])
        } else if (width === 3 || width === 5 || width === 6 || chance(0.3)) {
          const byteLength = chance(0.9) ? width : pick<Arg>([0, 7, 1.5, ["u"], "2", -1])
          const name = `${signed ? "Int" : u}${endian}`
          if (read) op(`read${name}`, [offset(width), byteLength])
          else op(`write${name}`, [intValue(width, signed), offset(width), byteLength])
        } else {
          const name = width === 1 ? `${signed ? "Int" : u}8` : `${signed ? "Int" : u}${width * 8}${endian}`
          if (read) op(`read${name}`, chance(0.9) ? [offset(width)] : [])
          else op(`write${name}`, [intValue(width, signed), ...(chance(0.9) ? [offset(width)] : [])])
        }
      }
    }
    return ops
  })
}

/** Static operations that don't depend on any buffer, run as one more case. */
export const staticCases = (seed: number, count: number): Array<Array<Op>> => {
  const next = random(seed ^ 0x5bd1e995)
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(items: ReadonlyArray<T>): T => items[int(items.length)]!
  return Array.from({ length: count }, () => {
    const cases = generateCases(int(2 ** 31), 1, 2)[0]!
    const extra: Array<Op> = [
      { k: "static", m: "byteLength", a: [cases[0]!.a[0] ?? "x", pick<unknown>([...encodings, "nope", ["u"], ""])] },
      { k: "static", m: "byteLength", a: [pick<unknown>([1, ["u"], ["obj"], ["u8", [1, 2]], ["ab", [1, 2, 3]], ["arr", [1]]])] },
      { k: "static", m: "isEncoding", a: [pick<unknown>([...encodings, "nope", "", ["u"], 1, null, ["toString", "hex"]])] },
      { k: "static", m: "isBuffer", a: [pick<unknown>([["u8", [1]], 1, ["obj"], ["slot", 0]])] },
      { k: "static", m: "compare", a: [["slot", 0], pick<unknown>([["slot", 1], ["u8", [1, 2]], "x", ["u"]])] },
    ]
    return [...cases, ...extra]
  })
}
