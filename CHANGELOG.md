# Changelog

## Unreleased

- Typed arrays are opt-in: `Runtime.make({ typedArrays: true })` (Rust: `Runtime::typed_arrays(true)`). Without it, the
  default, programs and host functions behave as before they were added (0.2.1): no `ArrayBuffer`, `Uint16Array`,
  `Uint32Array`, `Int32Array`, `Float32Array` or `Float64Array`, a host function returning one fails at the call, and
  `Uint8Array` is unchanged; `globalNames` leaves them out.
- `Host.error(name, message)` (Rust: `HostError::located(name, message)`, a new `HostValue::Located`): a host call
  that fails with it, sync or async, thrown, rejected or as an Effect's failure, throws a real error of that standard
  class in the program, located at the call: its `stack` names the call, and uncaught the run fails with
  `TypeError: message (line L, col C)`. Other names make an `Error`. Returned as a value, it is an error like any
  other.
- Installs from git (`github:anomalyco/psychoscript#<commit>`): a `prepare` script installs the dev dependencies and
  builds `dist/`, since package managers don't install a git dependency's dev dependencies. Bun runs it only for a
  trusted dependency (`trustedDependencies`).
- `ArrayBuffer`, `Uint16Array`, `Uint32Array`, `Int32Array`, `Float32Array` and `Float64Array`: views of one byte
  buffer with JS conversions, the methods 3D programs need, and fast indexed access. They (and `ArrayBuffer`s) are
  lent to synchronous host functions for the call, without a copy. `Uint8Array` gains `byteLength`, `byteOffset`,
  `buffer` and the `ArrayBuffer` constructor. A typed array ignores writes to numeric keys that are not indexes.
- `limits.maxHeapBytes`: an optional cap on what a run can still reach, measured in a fixed size model rather than
  process memory, so garbage never counts and the result is the same everywhere. A run over it stops with the new
  diagnostic kind `MemoryLimitExceeded`; a suspended run keeps its limit.
- `limits.maxValueDepth`: how deep a value may nest where it crosses to or from the host (result, arguments, return
  values) and in `JSON.stringify`; 32 by default as before, at most 256. In the Rust implementation these copies take
  a fraction of the stack they did (a debug build's argument copy a fifth), and a saved call's argument no longer has
  a depth past which the state can't be read back; snapshots from earlier builds don't resume.
- `translate: { functions: "mark" }`: a program function inside a host call's argument, or in the run's result,
  crosses as `Host.functionMarker` (Rust: `HostValue::FunctionMarker`, `Data::FunctionMarker`) instead of failing
  the call or being left out.
- BigInt: literals, arithmetic, `BigInt()`, `BigInt.asIntN`/`asUintN`, the prototype methods, and Buffer's 64-bit
  `readBigInt64*`/`writeBigInt64*` methods. A BigInt is capped at
  2^20 bits and cannot cross to the host; `JSON.stringify` throws on one unless the program defines
  `BigInt.prototype.toJSON`. Snapshots keep BigInts.

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
