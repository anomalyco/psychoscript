// Node's Buffer encodings, as pure functions over bytes and strings: what `Buffer.from(string, encoding)`,
// `buf.write`, `buf.toString` and `buf.fill` do in Node, without the host's Buffer. Native codecs (TextEncoder,
// TextDecoder, Uint8Array's base64 and hex methods) are used where they give the same result, and JS where Node's
// rules differ: latin1, ascii and utf16le, and Node's lenient base64 and hex decoding.

export type Encoding = "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex"

/** Node's encoding lookup (`getEncodingOps`): case-insensitive names, with `ucs2`, `binary` and the dashed aliases. */
export const encodingOf = (name: string): Encoding | undefined => {
  switch (name.length) {
    case 3:
      return name.toLowerCase() === "hex" ? "hex" : undefined
    case 4: {
      const lower = name.toLowerCase()
      return lower === "utf8" ? "utf8" : lower === "ucs2" ? "utf16le" : undefined
    }
    case 5: {
      const lower = name.toLowerCase()
      return lower === "utf-8" ? "utf8" : lower === "ascii" ? "ascii" : lower === "ucs-2" ? "utf16le" : undefined
    }
    case 6: {
      const lower = name.toLowerCase()
      return lower === "latin1" || lower === "binary" ? "latin1" : lower === "base64" ? "base64" : undefined
    }
    case 7:
      return name.toLowerCase() === "utf16le" ? "utf16le" : undefined
    case 8:
      return name.toLowerCase() === "utf-16le" ? "utf16le" : undefined
    case 9:
      return name.toLowerCase() === "base64url" ? "base64url" : undefined
  }
  return undefined
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

// Feature-detected once: where a host lacks them (Node 24, older browsers), the JS paths below give the same bytes.
type NativeBase64 = {
  toBase64?: (this: Uint8Array, options?: { alphabet?: string; omitPadding?: boolean }) => string
  toHex?: (this: Uint8Array) => string
  setFromBase64?: (
    this: Uint8Array,
    text: string,
    options?: { alphabet?: string; lastChunkHandling?: string },
  ) => { read: number; written: number }
}
const nativeCodecs = Uint8Array.prototype as unknown as NativeBase64
const nativeToBase64 = typeof nativeCodecs.toBase64 === "function" ? nativeCodecs.toBase64 : undefined
const nativeToHex = typeof nativeCodecs.toHex === "function" ? nativeCodecs.toHex : undefined
const nativeSetFromBase64 = typeof nativeCodecs.setFromBase64 === "function" ? nativeCodecs.setFromBase64 : undefined
const nativeSetFromHex =
  typeof (nativeCodecs as { setFromHex?: unknown }).setFromHex === "function"
    ? (nativeCodecs as unknown as { setFromHex: (this: Uint8Array, text: string) => { read: number; written: number } })
        .setFromHex
    : undefined

/** UTF-8 bytes of `text`, as Node counts them: an unpaired surrogate is the three bytes of U+FFFD. */
export const byteLengthUtf8 = (text: string): number => {
  let length = text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) continue
    if (code < 0x800) {
      length += 1
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A pair is two units and four bytes.
        length += 2
        i++
        continue
      }
    }
    length += 2
  }
  return length
}

const base64ByteLength = (text: string): number => {
  let length = text.length
  if (text.charCodeAt(length - 1) === 0x3d) length--
  if (length > 1 && text.charCodeAt(length - 1) === 0x3d) length--
  return (length * 3) >>> 2
}

/** `Buffer.byteLength(text, encoding)`: for base64 and hex an estimate from the length, as in Node. */
export const byteLength = (text: string, encoding: Encoding): number => {
  switch (encoding) {
    case "utf8":
      return byteLengthUtf8(text)
    case "utf16le":
      return text.length * 2
    case "latin1":
    case "ascii":
      return text.length
    case "base64":
    case "base64url":
      return base64ByteLength(text)
    case "hex":
      return text.length >>> 1
  }
}

/** The bytes of `text` in `encoding`, as `Buffer.from(text, encoding)` makes them. */
export const encode = (text: string, encoding: Encoding): Uint8Array => {
  switch (encoding) {
    case "utf8":
      return encoder.encode(text)
    case "utf16le": {
      const bytes = new Uint8Array(text.length * 2)
      writeUtf16le(bytes, text)
      return bytes
    }
    case "latin1":
    case "ascii": {
      const bytes = new Uint8Array(text.length)
      writeLatin1(bytes, text)
      return bytes
    }
    case "hex": {
      const bytes = new Uint8Array(text.length >>> 1)
      const written = writeHex(bytes, text)
      return written === bytes.length ? bytes : bytes.slice(0, written)
    }
    case "base64":
    case "base64url": {
      const bytes = new Uint8Array(base64ByteLength(text))
      const written = writeBase64(bytes, text, encoding)
      // Only malformed input decodes to fewer bytes than the estimate.
      return written === bytes.length ? bytes : bytes.slice(0, written)
    }
  }
}

/**
 * Writes `text` into `target` (a view of exactly the bytes `buf.write` may use) and returns how many bytes it wrote.
 * Like Node, it writes no partial character in UTF-8 and UTF-16LE.
 */
export const write = (target: Uint8Array, text: string, encoding: Encoding): number => {
  if (target.length === 0) return 0
  switch (encoding) {
    case "utf8":
      return encoder.encodeInto(text, target).written
    case "utf16le":
      return writeUtf16le(target, text)
    case "latin1":
    case "ascii":
      return writeLatin1(target, text)
    case "hex":
      return writeHex(target, text)
    case "base64":
    case "base64url":
      return writeBase64(target, text, encoding)
  }
}

/**
 * The bytes `buf.fill(text, encoding)` repeats, at most `room` of them: UTF-8 and UTF-16LE whole (the fill cuts them
 * where it ends, even mid-character), and the others as `write` would put them in `room` bytes.
 */
export const fillBytes = (text: string, encoding: Encoding, room: number): Uint8Array => {
  if (encoding === "utf8" || encoding === "utf16le") return encode(text, encoding)
  const bytes = new Uint8Array(Math.min(room, encoding === "latin1" || encoding === "ascii" ? text.length : room))
  return bytes.subarray(0, write(bytes, text, encoding))
}

/** `buf.toString(encoding, start, end)` of the bytes `bytes` views. */
export const decode = (bytes: Uint8Array, encoding: Encoding): string => {
  switch (encoding) {
    case "utf8":
      return decoder.decode(bytes)
    case "latin1":
      return latin1(bytes)
    case "ascii":
      return ascii(bytes)
    case "utf16le":
      return utf16le(bytes)
    case "hex":
      return hex(bytes)
    case "base64":
    case "base64url":
      return base64(bytes, encoding)
  }
}

/** How long `decode` would make its string, without making it. */
export const decodedLength = (length: number, encoding: Encoding): number => {
  switch (encoding) {
    case "utf8":
    case "latin1":
    case "ascii":
      return length
    case "utf16le":
      return length >>> 1
    case "hex":
      return length * 2
    case "base64":
      return Math.ceil(length / 3) * 4
    case "base64url":
      return Math.ceil((length * 4) / 3)
  }
}

// String.fromCharCode takes its arguments on the stack, so long runs go in chunks.
const CHUNK = 0x2000

const units = (codes: Uint16Array): string => {
  if (codes.length <= CHUNK) return String.fromCharCode.apply(null, codes as unknown as Array<number>)
  let text = ""
  for (let i = 0; i < codes.length; i += CHUNK) {
    text += String.fromCharCode.apply(null, codes.subarray(i, i + CHUNK) as unknown as Array<number>)
  }
  return text
}

// windows-1252 decodes like latin1 except for bytes 0x80 to 0x9f, most of which it maps above U+00FF: when nothing
// above U+00FF came out, it gave the latin1 string, far faster than String.fromCharCode does on long runs. Where the
// host's TextDecoder lacks it, the units are widened instead (never surrogates, so the UTF-16 decoder keeps them).
const windows1252 = (() => {
  try {
    return new TextDecoder("windows-1252")
  } catch {
    return undefined
  }
})()
const wide = new TextDecoder("utf-16le", { ignoreBOM: true })
const latin1 = (bytes: Uint8Array): string => {
  if (bytes.length <= 64) return String.fromCharCode.apply(null, bytes as unknown as Array<number>)
  if (windows1252 !== undefined) {
    const text = windows1252.decode(bytes)
    if (!/[^\x00-\xff]/.test(text)) return text
  }
  return wide.decode(new Uint16Array(bytes))
}

const ascii = (bytes: Uint8Array): string => {
  const text = latin1(bytes)
  if (!/[^\x00-\x7f]/.test(text)) return text
  // Node clears the high bit of each byte.
  const codes = new Uint16Array(bytes)
  for (let i = 0; i < codes.length; i++) codes[i]! &= 0x7f
  return bytes.length <= 64 ? units(codes) : wide.decode(codes)
}

const utf16le = (bytes: Uint8Array): string => {
  const length = bytes.length >>> 1
  const codes = new Uint16Array(length)
  for (let i = 0; i < length; i++) codes[i] = bytes[2 * i]! | (bytes[2 * i + 1]! << 8)
  // Unpaired surrogates stay as they are, which the UTF-16 decoder would replace.
  return units(codes)
}

const hexDigits = "0123456789abcdef"
const hexPairs = Uint16Array.from({ length: 256 }, (_, byte) => hexDigits.charCodeAt(byte >> 4) | (hexDigits.charCodeAt(byte & 15) << 8))
const hexPairsSwapped = hexPairs.map((pair) => (pair >> 8) | ((pair & 0xff) << 8))
const bigEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 0

const hex = (bytes: Uint8Array): string => {
  if (nativeToHex !== undefined) return nativeToHex.call(bytes)
  return hexJs(bytes)
}

/** Lowercase hex in JS, for hosts without `Uint8Array.prototype.toHex`. */
export const hexJs = (bytes: Uint8Array): string => {
  // Each byte's two digits are one 16-bit store, in the host's byte order.
  const pairs = new Uint16Array(bytes.length)
  const table = bigEndian ? hexPairsSwapped : hexPairs
  for (let i = 0; i < bytes.length; i++) pairs[i] = table[bytes[i]!]!
  return decoder.decode(new Uint8Array(pairs.buffer))
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const base64Codes = Uint8Array.from(base64Alphabet, (char) => char.charCodeAt(0))
const base64UrlCodes = Uint8Array.from(base64UrlAlphabet, (char) => char.charCodeAt(0))

const pairTables: Partial<Record<"base64" | "base64url", Uint16Array>> = {}
const base64Pairs = (encoding: "base64" | "base64url") =>
  (pairTables[encoding] ??= Uint16Array.from({ length: 4096 }, (_, n) => {
    const codes = encoding === "base64" ? base64Codes : base64UrlCodes
    const first = codes[n >> 6]!
    const second = codes[n & 63]!
    return bigEndian ? (first << 8) | second : first | (second << 8)
  }))

const base64 = (bytes: Uint8Array, encoding: "base64" | "base64url"): string => {
  if (nativeToBase64 !== undefined) {
    return encoding === "base64"
      ? nativeToBase64.call(bytes)
      : nativeToBase64.call(bytes, { alphabet: "base64url", omitPadding: true })
  }
  return base64Js(bytes, encoding)
}

/** Base64 in JS, padded for `base64` and unpadded for `base64url` as Node writes them. */
export const base64Js = (bytes: Uint8Array, encoding: "base64" | "base64url"): string => {
  const codes = encoding === "base64" ? base64Codes : base64UrlCodes
  const whole = bytes.length - (bytes.length % 3)
  const rest = bytes.length - whole
  const chars = new Uint8Array((whole / 3) * 4 + (rest === 0 ? 0 : encoding === "base64" ? 4 : rest + 1))
  // Twelve bits at a time: two characters, one 16-bit store.
  const pairs = new Uint16Array(chars.buffer, 0, (whole / 3) * 2)
  const table = base64Pairs(encoding)
  for (let i = 0, k = 0; i < whole; i += 3, k += 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    pairs[k] = table[n >> 12]!
    pairs[k + 1] = table[n & 0xfff]!
  }
  let k = (whole / 3) * 4
  if (rest > 0) {
    const n = (bytes[whole]! << 16) | (rest === 2 ? bytes[whole + 1]! << 8 : 0)
    chars[k++] = codes[n >> 18]!
    chars[k++] = codes[(n >> 12) & 63]!
    if (rest === 2) chars[k++] = codes[(n >> 6) & 63]!
    if (encoding === "base64") while (k < chars.length) chars[k++] = 0x3d
  }
  return decoder.decode(chars)
}

const writeLatin1 = (target: Uint8Array, text: string): number => {
  // Node keeps the low byte of each UTF-16 unit, for ascii too.
  const length = Math.min(target.length, text.length)
  for (let i = 0; i < length; i++) target[i] = text.charCodeAt(i)
  return length
}

const writeUtf16le = (target: Uint8Array, text: string): number => {
  const length = Math.min(target.length >>> 1, text.length)
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i)
    target[2 * i] = code
    target[2 * i + 1] = code >> 8
  }
  return length * 2
}

// Node's decoding tables (deps/nbytes). It reads each UTF-16 unit as its low byte, so "\u0141" decodes as "A".
const unhex = new Int8Array(256).fill(-1)
for (const [index, char] of [..."0123456789"].entries()) unhex[char.charCodeAt(0)] = index
for (const [index, char] of [..."abcdef"].entries()) {
  unhex[char.charCodeAt(0)] = 10 + index
  unhex[char.toUpperCase().charCodeAt(0)] = 10 + index
}
const unbase64 = new Int8Array(256).fill(-1)
for (const [index, char] of [...base64Alphabet].entries()) unbase64[char.charCodeAt(0)] = index
unbase64["-".charCodeAt(0)] = 62
unbase64["_".charCodeAt(0)] = 63

const writeHex = (target: Uint8Array, text: string): number => {
  const length = Math.min(target.length, text.length >>> 1)
  // The native decoder takes only whole, valid hex; it gives the same bytes for that.
  if (nativeSetFromHex !== undefined && length === text.length >>> 1 && text.length % 2 === 0) {
    try {
      return nativeSetFromHex.call(target, text).written
    } catch {
      // Not all hex: Node keeps the pairs before the first that isn't, below.
    }
  }
  return writeHexJs(target, text, length)
}

/** Node's hex decoding in JS: pairs of hex digits up to the first pair that isn't one. */
export const writeHexJs = (target: Uint8Array, text: string, length = Math.min(target.length, text.length >>> 1)) => {
  for (let i = 0; i < length; i++) {
    const high = unhex[text.charCodeAt(2 * i) & 0xff]!
    const low = unhex[text.charCodeAt(2 * i + 1) & 0xff]!
    if (high < 0 || low < 0) return i
    target[i] = (high << 4) | low
  }
  return length
}

const writeBase64 = (target: Uint8Array, text: string, encoding: "base64" | "base64url"): number => {
  // Node first tries strict forgiving-base64 and falls back to its lenient decoder, which gives the same bytes for every
  // string the strict one accepts; the native decoder only speeds up input that is well formed and fits.
  if (nativeSetFromBase64 !== undefined) {
    try {
      const result = nativeSetFromBase64.call(target, text, { alphabet: encoding, lastChunkHandling: "loose" })
      if (result.read === text.length) return result.written
    } catch {
      // Malformed for the strict decoder: the lenient one below decides.
    }
  }
  return decodeBase64Lenient(target, text)
}

/**
 * Node's lenient base64 decoder (nbytes `Base64Decode`), step for step: both alphabets, characters outside them
 * skipped, decoding stops at `=`, and a lone last character is dropped. Writes at most `target.length` bytes.
 */
export const decodeBase64Lenient = (target: Uint8Array, text: string): number => {
  const srclen = text.length
  const dstlen = target.length
  let size = srclen
  let decoded = 0
  if (size >= 2) {
    if (text.charCodeAt(size - 1) === 0x3d) {
      size--
      if (text.charCodeAt(size - 1) === 0x3d) size--
    }
    decoded = size > 1 ? Math.floor(size / 4) * 3 + ((size % 4) + 1 >> 1) : 0
  }
  const available = dstlen < decoded ? dstlen : decoded
  const maxK = available - (available % 3)
  let maxI = srclen - (srclen % 4)
  const position = { i: 0, k: 0 }
  while (position.i < maxI && position.k < maxK) {
    const i = position.i
    const a = unbase64[text.charCodeAt(i) & 0xff]!
    const b = unbase64[text.charCodeAt(i + 1) & 0xff]!
    const c = unbase64[text.charCodeAt(i + 2) & 0xff]!
    const d = unbase64[text.charCodeAt(i + 3) & 0xff]!
    if ((a | b | c | d) < 0) {
      if (!decodeGroupSlow(target, text, position)) return position.k
      maxI = position.i + (srclen - position.i) - ((srclen - position.i) % 4)
      continue
    }
    const k = position.k
    target[k] = (a << 2) | (b >> 4)
    target[k + 1] = ((b & 15) << 4) | (c >> 2)
    target[k + 2] = ((c & 3) << 6) | d
    position.i += 4
    position.k += 3
  }
  if (position.i < srclen && position.k < dstlen) decodeGroupSlow(target, text, position)
  return position.k
}

// One group of four legal characters, skipping the others; false once decoding has to stop.
const decodeGroupSlow = (target: Uint8Array, text: string, position: { i: number; k: number }): boolean => {
  const srclen = text.length
  const dstlen = target.length
  let hi = 0
  for (let step = 0; step < 4; step++) {
    let lo: number
    for (;;) {
      const c = text.charCodeAt(position.i) & 0xff
      lo = unbase64[c]!
      position.i++
      if (lo >= 0) break
      if (c === 0x3d || position.i >= srclen) return false
    }
    if (step === 1) target[position.k++] = ((hi & 0x3f) << 2) | ((lo & 0x30) >> 4)
    else if (step === 2) target[position.k++] = ((hi & 0x0f) << 4) | ((lo & 0x3c) >> 2)
    else if (step === 3) target[position.k++] = ((hi & 0x03) << 6) | (lo & 0x3f)
    if (position.i >= srclen) return false
    if (position.k >= dstlen) return false
    hi = lo
  }
  return true
}
