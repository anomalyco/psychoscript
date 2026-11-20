# Changelog

## Unreleased

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
