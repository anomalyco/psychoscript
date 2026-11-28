// Runs the operation lists test/node-buffer/fuzz.ts makes against whatever `Buffer` is in scope, and records what each
// one returned or threw and the bytes of every buffer after it. The same source runs inside psychoscript and in Node.

function fuzzHex(bytes) {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16)
  return out
}

function fuzzDecode(value, slots) {
  if (!Array.isArray(value)) return value
  const tag = value[0]
  if (tag === "u") return undefined
  if (tag === "nan") return NaN
  if (tag === "inf") return value[1] * Infinity
  if (tag === "negz") return -0
  if (tag === "big") return BigInt(value[1])
  if (tag === "slot") return slots[value[1]]
  if (tag === "arr") return value[1].map((item) => fuzzDecode(item, slots))
  if (tag === "obj") return {}
  if (tag === "like") return { length: value[1].length, ...value[1].map((item) => fuzzDecode(item, slots)) }
  if (tag === "json") return { type: "Buffer", data: value[1] }
  if (tag === "valueOf") {
    const inner = fuzzDecode(value[1], slots)
    return { valueOf: () => inner }
  }
  if (tag === "toString") {
    const inner = fuzzDecode(value[1], slots)
    return { toString: () => inner }
  }
  if (tag === "ab") return new Uint8Array(value[1]).buffer
  if (tag === "u8") return new Uint8Array(value[1])
  throw new Error("unknown tag " + tag)
}

function fuzzEncode(result, target) {
  if (result === undefined) return ["u"]
  if (typeof result === "number") {
    if (result !== result) return ["nan"]
    if (Object.is(result, -0)) return ["negz"]
    if (result === Infinity || result === -Infinity) return ["inf", result > 0 ? 1 : -1]
    return result
  }
  if (typeof result === "bigint") return ["big", String(result)]
  if (typeof result === "string" || typeof result === "boolean" || result === null) return result
  if (result === target) return ["self"]
  if (result instanceof Uint8Array) return ["bytes", Buffer.isBuffer(result), fuzzHex(result)]
  if (Array.isArray(result)) return ["arr", result.map((item) => fuzzEncode(item))]
  if (typeof result === "object") {
    const out = {}
    for (const key of Object.keys(result)) out[key] = fuzzEncode(result[key])
    return ["obj", out]
  }
  return ["other", typeof result]
}

function fuzzError(error) {
  if (error === null || typeof error !== "object") return ["throw", String(error)]
  return ["err", String(error.name), error.code === undefined ? null : String(error.code), String(error.message)]
}

function fuzzMissing(value, slots) {
  if (!Array.isArray(value)) return false
  if (value[0] === "slot") return slots[value[1]] === null || slots[value[1]] === undefined
  return value.some((item) => fuzzMissing(item, slots))
}

// Node reads a UTF-16 search's buffers as 16-bit units in place, which on an odd byteOffset gives wrong answers or
// never returns, so those searches are left out.
const fuzzUtf16 = ["ucs2", "ucs-2", "utf16le", "utf-16le"]
function fuzzMisaligned(op, slots) {
  if (op.m !== "indexOf" && op.m !== "lastIndexOf" && op.m !== "includes") return false
  if (!op.a.some((arg) => typeof arg === "string" && fuzzUtf16.includes(arg.toLowerCase()))) return false
  const odd = (value) => value instanceof Uint8Array && value.byteOffset % 2 === 1
  return odd(slots[op.t]) || op.a.some((arg) => Array.isArray(arg) && arg[0] === "slot" && odd(slots[arg[1]]))
}

function runCase(ops) {
  const slots = []
  const trace = []
  for (const op of ops) {
    // A buffer whose making failed leaves its slot empty, and operations on it are skipped.
    if ((op.t !== undefined && slots[op.t] === null) || fuzzMissing(op.a, slots)) {
      if (op.push) slots.push(null)
      trace.push(["skip"], "")
      continue
    }
    if (fuzzMisaligned(op, slots)) {
      trace.push(["skip"], "")
      continue
    }
    let entry
    try {
      const args = op.a.map((arg) => fuzzDecode(arg, slots))
      let result
      let target
      if (op.k === "static") result = Buffer[op.m](...args)
      else if (op.k === "new") result = op.m === "Buffer" ? new Buffer(...args) : new Uint8Array(...args)
      else if (op.k === "call") result = Buffer(...args)
      else {
        target = slots[op.t]
        // A plain Uint8Array has no Buffer methods: they are called on it as Node's generic ones.
        const generic = op.k === "generic" || !Buffer.isBuffer(target)
        result = generic ? Buffer.prototype[op.m].call(target, ...args) : target[op.m](...args)
      }
      if (op.zero && result instanceof Uint8Array) result.fill(0)
      entry = ["ok", fuzzEncode(result, target)]
      if (op.push) slots.push(result instanceof Uint8Array ? result : null)
    } catch (error) {
      entry = fuzzError(error)
      if (op.push) slots.push(null)
    }
    trace.push(entry, slots.map((slot) => (slot === null ? "-" : fuzzHex(slot))).join(" "))
  }
  return trace
}

function runCases(cases) {
  return cases.map(runCase)
}
