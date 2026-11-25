// BigInts passed to other built-ins: those that need a number refuse one, those that need text or a key take its
// decimal text, and collections and promises keep it as it is.
const attempt = (f) => { try { const v = f(); return typeof v === "bigint" ? `${v}n` : v } catch (e) { return e.name + ": " + e.message } }
const gen = function* () { yield 1n; yield* [2n] }
return [
  attempt(() => structuredClone(1n)), attempt(() => Object.keys(1n)), attempt(() => Object.entries(2n)),
  attempt(() => Object.assign({}, 1n)), attempt(() => Array.from(1n)), attempt(() => [...1n]),
  attempt(() => new Date(1n)), attempt(() => Math.max(1n)), attempt(() => String.fromCharCode(65n)),
  attempt(() => "abc".at(1n)), attempt(() => Number.isInteger(1n)), attempt(() => Number.prototype.toFixed.call(1n)),
  attempt(() => isFinite(1n)), attempt(() => parseInt(10n, 16)), attempt(() => encodeURIComponent(12n)),
  attempt(() => new Array(1n).length), attempt(() => Array.of(1n).length), attempt(() => [1, 2, 3].at(1n)),
  attempt(() => "x" in 1n), attempt(() => 1n instanceof Object), attempt(() => new Uint8Array([1n])),
  attempt(() => { const u = new Uint8Array(1); u[0] = 1n; return u[0] }), attempt(() => Buffer.from([1n])),
  attempt(() => Date.UTC(1n)), attempt(() => JSON.stringify({ [1n]: 1 })), attempt(() => Object.fromEntries([[1n, 2]])),
  attempt(() => Object.keys(Object.defineProperty({}, 1n, { value: 1, enumerable: true }))),
  attempt(() => [NaN, 0n].includes(0)), attempt(() => "a".repeat(1n)), attempt(() => new Set([0n]).has(-0n)),
  attempt(() => Object.is(1n, 1)), attempt(() => Array.prototype.join.call({ length: 1n })),
  attempt(() => ({ 1: 2 }).hasOwnProperty(1n)), attempt(() => String(new Error(1n).message)),
  attempt(() => new Error("x", { cause: 1n }).cause), attempt(() => [...gen()].map(String).join()),
  attempt(() => { switch (2n) { case 2: return "number"; case 2n: return "bigint"; default: return "none" } }),
  attempt(() => [1n, 2n].map((x) => x * 2n).reduce((a, b) => a + b)), attempt(() => [3n, 1n].findIndex((x) => x === 1n)),
  attempt(() => new WeakMap().set(1n, 1)), attempt(() => new WeakSet().add(1n)), attempt(() => Symbol.iterator in [1n]),
  attempt(() => [5n, 6n].lastIndexOf(6n)), attempt(() => [1n].fill(2n)[0]), attempt(() => String.raw`${1n}`),
  attempt(() => ((n) => n)`${2n}`), attempt(() => new URLSearchParams({ a: 1n }).toString()),
  attempt(() => Object.getOwnPropertyNames(3n)), attempt(() => Object.getOwnPropertyDescriptor(1n, "x")),
  attempt(() => Object.freeze(1n)), attempt(() => Object.isFrozen(1n)), attempt(() => Array.isArray(1n)),
  attempt(() => new Headers({ a: 1n }).get("a")), attempt(() => new TextEncoder().encode(1n).length),
  attempt(() => btoa(1n)), attempt(() => new URL(1n)), attempt(() => [1, 2, 3].slice(-1n)),
  attempt(() => Math.min()), attempt(() => Promise.resolve(3n) instanceof Promise), attempt(() => typeof (async () => 1n)()),
  await (async () => String(await 7n))(), await Promise.resolve(8n).then(String), attempt(() => [, 1n].join()),
  attempt(() => Object.prototype.toString.call(Object.getPrototypeOf(1n))), attempt(() => (1n).hasOwnProperty("x")),
  attempt(() => 1n.toString.call(2n)), attempt(() => 5n[Symbol.iterator]),
]
