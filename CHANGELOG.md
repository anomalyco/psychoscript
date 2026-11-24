# Changelog

## Unreleased

- Typed arrays are opt-in: `Runtime.make({ typedArrays: true })`. Without it, the
  default, programs and host functions behave as before they were added (0.2.1): no `ArrayBuffer`, `Uint16Array`,
  `Uint32Array`, `Int32Array`, `Float32Array` or `Float64Array`, a host function returning one fails at the call, and
  `Uint8Array` has no `buffer`; `globalNames` leaves them out.
- `ArrayBuffer`, `Uint16Array`, `Uint32Array`, `Int32Array`, `Float32Array` and `Float64Array`: views of one byte buffer
  with JS conversions, the methods 3D programs need, and fast indexed access. They (and `ArrayBuffer`s) are lent to
  synchronous host functions for the call, without a copy; async and durable ones get a copy. `Uint8Array` gains
  `buffer` and the `ArrayBuffer` constructor. A typed array ignores writes to numeric keys that are not indexes.
- `limits.maxHeapBytes`: an optional cap on what a run can still reach, measured in a fixed size model rather than
  process memory, so garbage never counts and the result is the same everywhere. A run over it stops with the new
  diagnostic kind `MemoryLimitExceeded`; a suspended run keeps its limit.
- `Uint8Array.prototype.byteLength` and `byteOffset`. They were `undefined`, so code that sized bytes with
  `byteLength` (such as a `fetch` response's `arrayBuffer()`) got no size.
- RegExp: `RegExp(re)` without `new` returns `re` when its `constructor` is `RegExp`; match results always have `groups`, and group objects (including
  `indices.groups` and the replace callback's groups) have a null prototype; `RegExp.prototype.source`/`flags`/flag
  getters read as on an empty pattern instead of throwing.
- `Number.prototype.toLocaleString` and `BigInt.prototype.toLocaleString` honor their locales and options through
  the host's Intl instead of ignoring them, and `Array.prototype.toLocaleString` passes both on to each element that
  is a primitive, an array or a date (without `Intl`, other elements' `toLocaleString` gets no arguments).
- Uint8Array: `toSorted`, `toReversed`, `with`, `copyWithin`, `setFromBase64`, `setFromHex`, array-like sources, and
  fractional lengths. Buffer: inherits Uint8Array's statics, `of`, `copyBytesFrom`, the `readUint*`/`writeUint*`
  aliases, and `from(bytes, offset, length)` copies the whole input as Node does. `TextEncoder.prototype.encodeInto`.
- `Symbol.toPrimitive` and `Symbol.toStringTag` work, and symbols have `Symbol.prototype`, `description`, and
  `toString` (`"Symbol(Symbol.iterator)"`).
- BigInt: literals, arithmetic, `BigInt()`, `BigInt.asIntN`/`asUintN`, the prototype methods, and Buffer's 64-bit
  `readBigInt64*`/`writeBigInt64*` methods. A BigInt is capped at
  2^20 bits and cannot cross to the host; `JSON.stringify` throws on one unless the program defines
  `BigInt.prototype.toJSON`. Snapshots keep BigInts.
- `String.prototype.matchAll` returns an iterator instead of an array; `String.raw` accepts a string `raw`; and
  `Object.keys`/`values`/`entries`/`assign`/`hasOwn`, object spread and `for...in` index a string by UTF-16 code unit.
- Promises: `Promise.try(nonFunction)` returns a rejected promise instead of throwing, and `new Promise` accepts bound
  functions as executors.
- `Array.fromAsync`; a `JSON.parse` reviver gets its third argument (`{ source }` for primitives); and
  `Array.prototype.toString` calls the receiver's `join`, as in JS.
- Object: `Object.fromEntries` accepts any entry value, `hasOwnProperty`/`propertyIsEnumerable` accept primitive
  receivers, own-property checks apply ToPropertyKey to object keys, `Object.prototype.toString` reports Math, JSON,
  crypto, TextEncoder/TextDecoder, symbols and async/generator functions, and `Object.getOwnPropertySymbols` exists.
- A `StreamingResponse` now has `type`, `clone()` and `reader.closed`; `blob()`, `formData()` and the body's `tee`,
  `pipeTo` and `pipeThrough` throw a TypeError instead of being undefined.
- Console: nested `undefined` prints as `undefined` (not `null`), `console.table` shows a table holding a function
  instead of `[opaque reference]`, and `console.assert`/`count`/`countReset`/`group`/`groupCollapsed`/`groupEnd`/
  `trace`/`time`/`timeLog`/`timeEnd` exist.

## 0.2.1

- `psychoscript/effect`: a plain function the host gives the program (inside a host function's result, such as a
  method of a returned object, or among the globals) may return an Effect again, as in 0.1; it runs with the run's
  services and the same failure mapping as a `Host.fn`'s Effect.
- The program sees a `Host.fn`'s own `name` and `length` again, not those of a wrapper.

## 0.2.0

**Breaking.**

- The root API is Promise-based: `runtime.execute`, `program.run`, `program.suspend` and `runtime.resume(...).run`
  return Promises, and host functions return values or Promises.
- The Effect API moved to `psychoscript/effect`. To migrate, change `from "psychoscript"` to
  `from "psychoscript/effect"`; nothing else changes.
- `effect` is now an optional peer dependency, needed only for `psychoscript/effect`.
- Host calls get `call.signal`, aborted when the run stops or a suspend interrupts the call.
- Aborting `execute(code, { signal })` or `run({ signal })` rejects with a `DOMException` named `"AbortError"`.
- A sync host function that returns a Promise now sees its signal abort when the run stops.

- Errors have a V8-style, non-enumerable `stack`: `name: message` and up to 10 `at fn (<program>:line:col)`
  frames, taken when the error is made and kept across a suspend and resume.
- Array destructuring, spread, `for...of`, `yield*`, `Array.from` and other iterable intake honour a program's
  replacement of `Array.prototype[Symbol.iterator]`, the built-in iterators' `next`, or an array's own
  `[Symbol.iterator]`. Runs that never replace them keep iterating arrays directly; the choice survives a
  suspend and resume. A default derived constructor passes its arguments on without iterating them.

## 0.1.0

First release.

- A confined JavaScript interpreter: strict-mode programs compiled to bytecode, with no ambient I/O, `eval` or
  prototype mutation, and a standard library covering the core built-ins plus `URL`, `Headers`, `Uint8Array` and
  `Buffer`.
- `Runtime.make` runs programs against host functions (`Host.fn`, `Host.durableFn`, `Host.namespace`) in Effect.
- Runs can be suspended, saved with `toBytes`, and resumed with `fromBytes` in another process of the same build.
- Time and output limits, and fixed caps on strings, arrays and pending promises.
