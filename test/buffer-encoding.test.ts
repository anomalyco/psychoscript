import { describe, expect, test } from "bun:test"
import { base64Js, decode, decodeBase64Lenient, encode, hexJs, writeHexJs } from "../src/stdlib/encoding.js"

// The JS codecs hosts without Uint8Array's base64 and hex methods use (Node 24, older browsers), against those methods,
// which give the same bytes and text where both apply.

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

const samples = (() => {
  const next = random(7)
  return Array.from({ length: 300 }, (_, index) =>
    Uint8Array.from({ length: index % 50 === 0 ? 3000 + index : Math.floor(next() * 40) }, () => Math.floor(next() * 256)),
  )
})()

describe("Buffer encodings without native codecs", () => {
  test("hex and base64 text match Uint8Array's own", () => {
    for (const bytes of samples) {
      expect(hexJs(bytes)).toBe(bytes.toHex())
      expect(base64Js(bytes, "base64")).toBe(bytes.toBase64())
      expect(base64Js(bytes, "base64url")).toBe(bytes.toBase64({ alphabet: "base64url", omitPadding: true }))
    }
  })

  test("decoding well-formed hex and base64 matches Uint8Array's own", () => {
    for (const bytes of samples) {
      const hex = bytes.toHex()
      const decodedHex = new Uint8Array(bytes.length)
      expect(writeHexJs(decodedHex, hex.toUpperCase())).toBe(bytes.length)
      expect(decodedHex).toEqual(bytes)
      for (const text of [bytes.toBase64(), bytes.toBase64({ omitPadding: true }), bytes.toBase64({ alphabet: "base64url" })]) {
        const decoded = new Uint8Array(bytes.length + 3)
        const written = decodeBase64Lenient(decoded, text)
        expect(decoded.subarray(0, written)).toEqual(bytes)
      }
    }
  })

  test("decodes malformed hex and base64 as Node does", () => {
    expect([...encode("12zz34", "hex")]).toEqual([0x12])
    expect([...encode("\u0141\u0142", "hex")]).toEqual([0xab])
    expect([...encode("QU JD\nRA==", "base64")]).toEqual([...encode("ABCD", "latin1")])
    expect([...encode("QQ==QUJD", "base64")]).toEqual([0x41])
    expect([...encode("Q", "base64")]).toEqual([])
    expect([...encode("-_8", "base64")]).toEqual([0xfb, 0xff])
    expect([...encode("\u0141QID", "base64")]).toEqual([1, 2, 3])
  })

  test("latin1, ascii and utf16le text keep every byte as Node does", () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, index) => index & 0xff)
    expect(decode(bytes, "latin1")).toBe(String.fromCharCode(...bytes))
    expect(decode(bytes, "ascii")).toBe(String.fromCharCode(...bytes.map((byte) => byte & 0x7f)))
    expect(decode(new Uint8Array([0x00, 0xd8, 0x41, 0x00, 0x42]), "utf16le")).toBe("\ud800A")
    expect([...encode("\ud800\u20ac", "utf16le")]).toEqual([0x00, 0xd8, 0xac, 0x20])
  })
})
