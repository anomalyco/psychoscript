// The `assert` and `common` modules Node's buffer tests use, written to run inside psychoscript. The runner puts this
// before each test, turns `require(...)` into `__require(...)`, and runs each top-level statement on its own so one
// failing statement doesn't hide the rest.

class AssertionError extends Error {
  constructor(message) {
    super(message)
    this.name = "AssertionError"
    this.code = "ERR_ASSERTION"
  }
}

const __SKIP = new Error("__SKIP__")
const __failures = []
const __mustCalls = []

function __inspect(value, depth = 0) {
  if (typeof value === "string") {
    if (!value.includes("'")) return `'${value}'`
    if (!value.includes('"')) return `"${value}"`
    return `'${value.replaceAll("'", "\\'")}'`
  }
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value)
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "function") return `[Function: ${value.name || "(anonymous)"}]`
  if (value === null || typeof value !== "object") return String(value)
  if (Buffer.isBuffer(value)) {
    const shown = [...value.subarray(0, 50)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")
    return `<Buffer${shown ? ` ${shown}` : ""}${value.length > 50 ? ` ... ${value.length - 50} more bytes` : ""}>`
  }
  if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]"
  if (value instanceof Uint8Array) return `Uint8Array(${value.length}) [ ${[...value].join(", ")} ]`
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[ ${value.map((item) => __inspect(item, depth + 1)).join(", ")} ]`
  if (value instanceof Error) return `${value.name}: ${value.message}`
  const keys = Object.keys(value)
  return keys.length === 0 ? "{}" : `{ ${keys.map((key) => `${key}: ${__inspect(value[key], depth + 1)}`).join(", ")} }`
}

function __deepEqual(actual, expected, strict) {
  if (strict ? Object.is(actual, expected) : actual == expected || (actual !== actual && expected !== expected)) return true
  if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) return false
  if (strict && Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false
  if (Object.prototype.toString.call(actual) !== Object.prototype.toString.call(expected)) return false
  if (actual instanceof Uint8Array) {
    if (!(expected instanceof Uint8Array) || actual.length !== expected.length) return false
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) return false
    return true
  }
  if (actual instanceof Date) return actual.getTime() === expected.getTime()
  if (actual instanceof RegExp) return String(actual) === String(expected)
  if (actual instanceof Error && (actual.message !== expected.message || actual.name !== expected.name)) return false
  if (Array.isArray(actual) && actual.length !== expected.length) return false
  const keys = Object.keys(actual)
  if (keys.length !== Object.keys(expected).length) return false
  return keys.every((key) => Object.hasOwn(expected, key) && __deepEqual(actual[key], expected[key], strict))
}

function __fail(message, fallback) {
  if (message instanceof Error) throw message
  throw new AssertionError(message === undefined ? fallback : message)
}

function __checkError(error, expected, message) {
  if (expected === undefined) return
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && error instanceof expected) return
    if (expected === Error || expected.prototype instanceof Error) {
      __fail(message, `The error is expected to be an instance of "${expected.name}". Received ${__inspect(error)}`)
    }
    if (expected.call({}, error) !== true) __fail(message, `The validation function is expected to return "true". Received ${__inspect(error)}`)
    return
  }
  if (expected instanceof RegExp) {
    if (!expected.test(String(error))) __fail(message, `The input did not match the regular expression ${expected}. Input: ${__inspect(String(error))}`)
    return
  }
  if (typeof error !== "object" || error === null) __fail(message, `Expected an error object, received ${__inspect(error)}`)
  const keys = Object.keys(expected)
  if (expected instanceof Error) keys.push("name", "message")
  for (const key of keys) {
    const want = expected[key]
    const got = error[key]
    if (typeof got === "string" && want instanceof RegExp) {
      if (!want.test(got)) __fail(message, `${key}: ${__inspect(got)} does not match ${want}`)
    } else if (!__deepEqual(got, want, true)) {
      __fail(message, `${key}: expected ${__inspect(want)}, received ${__inspect(got)}`)
    }
  }
}

// psychoscript rejects circular values, so `assert.ok` and `assert.strict` are copies rather than `assert` itself.
const __ok = (value, message) => {
  if (!value) __fail(message, `The expression evaluated to a falsy value: ${__inspect(value)}`)
}
const __assert = function assert(value, message) {
  __ok(value, message)
}
__assert.ok = __ok
__assert.AssertionError = AssertionError
__assert.fail = (message) => __fail(message, "Failed")
__assert.strictEqual = (actual, expected, message) => {
  if (!Object.is(actual, expected)) __fail(message, `Expected values to be strictly equal: ${__inspect(actual)} !== ${__inspect(expected)}`)
}
__assert.notStrictEqual = (actual, expected, message) => {
  if (Object.is(actual, expected)) __fail(message, `Expected "actual" to be strictly unequal to: ${__inspect(expected)}`)
}
__assert.equal = (actual, expected, message) => {
  if (!(actual == expected || (actual !== actual && expected !== expected))) __fail(message, `${__inspect(actual)} == ${__inspect(expected)}`)
}
__assert.notEqual = (actual, expected, message) => {
  if (actual == expected) __fail(message, `${__inspect(actual)} != ${__inspect(expected)}`)
}
__assert.deepStrictEqual = (actual, expected, message) => {
  if (!__deepEqual(actual, expected, true)) __fail(message, `Expected values to be strictly deep-equal: ${__inspect(actual)} vs ${__inspect(expected)}`)
}
__assert.notDeepStrictEqual = (actual, expected, message) => {
  if (__deepEqual(actual, expected, true)) __fail(message, `Expected "actual" not to be strictly deep-equal to: ${__inspect(expected)}`)
}
__assert.deepEqual = (actual, expected, message) => {
  if (!__deepEqual(actual, expected, false)) __fail(message, `Expected values to be loosely deep-equal: ${__inspect(actual)} vs ${__inspect(expected)}`)
}
__assert.notDeepEqual = (actual, expected, message) => {
  if (__deepEqual(actual, expected, false)) __fail(message, `Expected "actual" not to be loosely deep-equal to: ${__inspect(expected)}`)
}
__assert.match = (string, regexp, message) => {
  if (typeof string !== "string" || !regexp.test(string)) __fail(message, `The input did not match the regular expression ${regexp}. Input: ${__inspect(string)}`)
}
__assert.doesNotMatch = (string, regexp, message) => {
  if (typeof string === "string" && regexp.test(string)) __fail(message, `The input was expected to not match ${regexp}. Input: ${__inspect(string)}`)
}
__assert.ifError = (value) => {
  if (value !== null && value !== undefined) throw value
}
__assert.throws = (fn, expected, message) => {
  if (typeof expected === "string") {
    message = expected
    expected = undefined
  }
  let threw = false
  let error
  try {
    fn()
  } catch (caught) {
    threw = true
    error = caught
  }
  if (!threw) __fail(message, `Missing expected exception${expected && expected.name ? ` (${expected.name})` : ""}.`)
  __checkError(error, expected, message)
}
__assert.doesNotThrow = (fn, expected, message) => {
  try {
    fn()
  } catch (error) {
    __fail(typeof expected === "string" ? expected : message, `Got unwanted exception: ${__inspect(error)}`)
  }
}
__assert.rejects = async (promise, expected, message) => {
  let threw = false
  let error
  try {
    await (typeof promise === "function" ? promise() : promise)
  } catch (caught) {
    threw = true
    error = caught
  }
  if (!threw) __fail(message, "Missing expected rejection.")
  __checkError(error, expected, message)
}
__assert.strict = Object.assign(function strict(value, message) {
  __ok(value, message)
}, __assert)

function __mustCall(fn, exact) {
  if (typeof fn === "number") {
    exact = fn
    fn = undefined
  }
  const record = { expected: exact === undefined ? 1 : exact, actual: 0, atLeast: false, name: fn ? fn.name : "" }
  __mustCalls.push(record)
  const target = fn || (() => {})
  return function (...args) {
    record.actual++
    return target.apply(this, args)
  }
}

const __common = {
  hasCrypto: false,
  hasIntl: false,
  isDebug: false,
  isWindows: false,
  enoughTestMem: false,
  mustCall: __mustCall,
  mustCallAtLeast(fn, minimum) {
    const wrapped = __mustCall(fn, minimum === undefined ? 1 : minimum)
    __mustCalls[__mustCalls.length - 1].atLeast = true
    return wrapped
  },
  mustSucceed(fn) {
    return __mustCall((error, ...args) => {
      __assert.ifError(error)
      if (typeof fn === "function") return fn(...args)
    })
  },
  mustNotCall(message) {
    return () => __fail(undefined, `function should not have been called${message ? `: ${message}` : ""}`)
  },
  expectsError(validator, exact) {
    return __mustCall((...args) => {
      if (args.length !== 1) __fail(undefined, `Expected one argument, got ${args.length}`)
      const error = args[0]
      __assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, "message"), false)
      __assert.throws(() => {
        throw error
      }, validator)
      return true
    }, exact)
  },
  invalidArgTypeHelper(input) {
    if (input == null) return ` Received ${input}`
    if (typeof input === "function") return ` Received function ${input.name}`
    if (typeof input === "object") {
      if (input.constructor && input.constructor.name) return ` Received an instance of ${input.constructor.name}`
      return ` Received ${__inspect(input)}`
    }
    let inspected = __inspect(input)
    // Node's helper passes the string itself as slice's first argument, so this slices from 0 to 0.
    if (inspected.length > 28) inspected = `${inspected.slice(inspected, 0, 25)}...`
    return ` Received type ${typeof input} (${inspected})`
  },
  skip() {
    throw __SKIP
  },
  printSkipMessage() {},
  expectWarning() {},
  allowGlobals() {},
  platformTimeout: (ms) => ms,
}

const __nodeBuffer = require("buffer")
const __buffer = {
  ...__nodeBuffer,
  kMaxLength: 2 ** 53 - 1,
  kStringMaxLength: 2 ** 29 - 24,
  constants: { MAX_LENGTH: 2 ** 53 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 },
  INSPECT_MAX_BYTES: 50,
}

function __require(name) {
  if (name === "assert" || name === "node:assert" || name === "assert/strict") return __assert
  if (name === "../common") return __common
  if (name === "buffer" || name === "node:buffer") return __buffer
  throw new Error(`Cannot find module '${name}' in the harness`)
}

function __record(index, line, error) {
  if (error === __SKIP) throw error
  __failures.push({ index, line, message: String(error && error.message !== undefined ? `${error.name}: ${error.message}` : error).slice(0, 300) })
}

function __finish(total) {
  __mustCalls.forEach((record) => {
    if (record.atLeast ? record.actual < record.expected : record.actual !== record.expected) {
      __failures.push({ index: -1, line: 0, message: `mustCall ${record.name}: expected ${record.expected}, called ${record.actual}` })
    }
  })
  return { total, failures: __failures }
}
