import { type Options, Parser, type Program, type TokenType, tokTypes } from "acorn"
import { bigIntTextTooLong, fitsBigIntSize } from "./limits.js"

/** The message of the parse error a BigInt literal past the size limit gets. */
export const BIGINT_LITERAL_TOO_LARGE = "Maximum BigInt size exceeded"

/**
 * Parses a program with acorn, refusing a BigInt literal past the size limit (as engines do when parsing). Acorn makes
 * a literal's value with the engine's `BigInt()`, which Firefox and Safari refuse past 2^20 bits with their own
 * RangeError, and which takes quadratic time on long decimal text, so a literal that is clearly too large is refused
 * before it is converted.
 */
export const parseScript = (code: string, options: Options): Program => BigIntLimitParser.parse(code, options)

// Acorn's tokenizer internals this relies on, which its types leave out.
interface Tokenizer {
  pos: number
  input: string
  type: TokenType
  value: unknown
  raise(pos: number, message: string): never
  readNumber(startsWithDot: boolean): void
  readRadixNumber(radix: number): void
}

const decimalLiteral = /(?:0|[1-9](?:_?\d)*)n/y
const radixLiterals: Record<number, RegExp> = {
  16: /0[xX][\da-fA-F](?:_?[\da-fA-F])*n/y,
  8: /0[oO][0-7](?:_?[0-7])*n/y,
  2: /0[bB][01](?:_?[01])*n/y,
}

const BigIntLimitParser = Parser.extend((Base) => {
  const Limited = class extends Base {}
  const tokenizer = Limited.prototype as unknown as Tokenizer
  const readNumber = tokenizer.readNumber
  const readRadixNumber = tokenizer.readRadixNumber
  tokenizer.readNumber = function (this: Tokenizer, startsWithDot) {
    if (startsWithDot) return readNumber.call(this, startsWithDot)
    readLimited(this, decimalLiteral, 10, () => readNumber.call(this, startsWithDot))
  }
  tokenizer.readRadixNumber = function (this: Tokenizer, radix) {
    readLimited(this, radixLiterals[radix]!, radix, () => readRadixNumber.call(this, radix))
  }
  return Limited
})

const readLimited = (tokenizer: Tokenizer, literal: RegExp, radix: number, read: () => void): void => {
  const start = tokenizer.pos
  literal.lastIndex = start
  const text = literal.exec(tokenizer.input)?.[0]
  if (text === undefined) return read()
  const digits = text.slice(radix === 10 ? 0 : 2, -1).replaceAll("_", "")
  if (bigIntTextTooLong(digits, radix)) tokenizer.raise(start, BIGINT_LITERAL_TOO_LARGE)
  try {
    read()
  } catch (error) {
    // The engine's own limit, should the estimate above have let a literal through that it refuses.
    if (error instanceof RangeError) tokenizer.raise(start, BIGINT_LITERAL_TOO_LARGE)
    throw error
  }
  if (tokenizer.type === tokTypes.num && typeof tokenizer.value === "bigint" && !fitsBigIntSize(tokenizer.value)) {
    tokenizer.raise(start, BIGINT_LITERAL_TOO_LARGE)
  }
}
