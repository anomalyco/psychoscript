import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Host } from "../src/effect/host-function.js";
import { Runtime } from "../src/effect/runtime.js";
import { value } from "./run.js";

const nested = (depth: number, leaf: unknown): unknown =>
  depth === 0 ? leaf : { a: nested(depth - 1, leaf) };

const fromHost = (result: unknown, code = "return got()") =>
  Effect.runPromise(
    Runtime.make({ globals: () => ({ got: Host.fn(() => result) }) }).execute(
      code,
    ),
  );

describe("plain host results", () => {
  test("a primitive past the depth limit fails as an object there would", async () => {
    expect(
      await fromHost(
        nested(32, 1),
        "let v = got(); let n = 0; while (typeof v === 'object') { v = v.a; n++ } return [n, v]",
      ),
    ).toMatchObject({ ok: true, value: [32, 1] });
    for (const leaf of [1, { b: 1 }]) {
      const result = await fromHost(nested(33, leaf));
      expect(result).toMatchObject({ ok: false });
      if (!result.ok)
        expect(result.error.message).toContain(
          "exceeds the maximum value depth of 32",
        );
    }
    const array = await fromHost([nested(32, [1])]);
    expect(array).toMatchObject({ ok: false });
  });

  test("keys keep their order and kind; holes, __proto__ and null prototypes cross as they are", async () => {
    const record = Object.create(null) as Record<string, unknown>;
    record.b = 1;
    record[2] = "two";
    record.a = [1, , 3];
    Object.defineProperty(record, "__proto__", {
      value: { x: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(record, "hidden", { value: 1, enumerable: false });
    expect(
      await fromHost(
        record,
        "const v = got(); return [Object.keys(v), 1 in v.a, v.a.length, Object.getPrototypeOf(v) === Object.prototype, Object.hasOwn(v, '__proto__'), v.__proto__.x]",
      ),
    ).toMatchObject({
      ok: true,
      value: [["2", "b", "a", "__proto__"], false, 3, true, true, 1],
    });
  });

  test("a circular result is still refused", async () => {
    const loop: Record<string, unknown> = { a: [] };
    (loop.a as Array<unknown>).push(loop);
    const result = await fromHost(loop);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.error.message).toContain("produced a circular value");
  });
});

describe("host JSON bindings", () => {
  test("a hole in a bound array stays a hole", async () => {
    expect(
      await value("return [1 in xs, xs.length, xs[2]]", {
        xs: [1, , 3] as never,
      }),
    ).toEqual([false, 3, 3]);
  });
});

describe("JSON.parse", () => {
  test("a __proto__ key is an own property and index keys come first", async () => {
    expect(
      await value(
        `const v = JSON.parse('{"b":1,"__proto__":{"x":1},"1":2,"a":{"c":[1,{}]}}'); return [Object.keys(v), Object.getPrototypeOf(v) === Object.prototype, Object.hasOwn(v, "__proto__"), Object.entries(v.a)]`,
      ),
    ).toEqual([["1", "b", "__proto__", "a"], true, true, [["c", [1, {}]]]]);
  });
});

describe("Object.keys and Object.entries", () => {
  test("index keys first, then names in order; symbols and hidden keys left out; getters read", async () => {
    expect(
      await value(
        `const o = { z: 1, 10: "ten", a: 2, 2: "two", [Symbol.iterator]: 3, get g() { return this.a + 1 } }
Object.defineProperty(o, "hidden", { value: 4, enumerable: false })
return [Object.keys(o), Object.entries(o), Object.keys({ "01": 1, "-1": 2, "4294967295": 3, "1.5": 4 })]`,
      ),
    ).toEqual([
      ["2", "10", "z", "a", "g"],
      [
        ["2", "two"],
        ["10", "ten"],
        ["z", 1],
        ["a", 2],
        ["g", 3],
      ],
      ["01", "-1", "4294967295", "1.5"],
    ]);
  });
});

describe("object literals", () => {
  test("__proto__ is an own data key; duplicate, accessor and spread keys keep their places", async () => {
    expect(
      await value(
        `const proto = { inherited: 1 }
const a = { __proto__: proto, own: 2 }
const b = { ["__proto__"]: 5 }
const c = { x: 1, y: 2, x: 3 }
const d = { get x() { return 1 }, x: 2 }
const e = { x: 1, get x() { return 9 } }
const f = { ...{ a: 1, b: 2 }, a: 3, c: 4 }
return [Object.getPrototypeOf(a) === Object.prototype, a.__proto__ === proto, Object.keys(a), Object.hasOwn(b, "__proto__"), Object.getPrototypeOf(b) === Object.prototype, Object.entries(c), Object.getOwnPropertyDescriptor(d, "x"), e.x, Object.entries(f)]`,
      ),
    ).toEqual([
      true,
      true,
      ["__proto__", "own"],
      true,
      true,
      [
        ["x", 3],
        ["y", 2],
      ],
      { value: 2, writable: true, enumerable: true, configurable: true },
      9,
      [
        ["a", 3],
        ["b", 2],
        ["c", 4],
      ],
    ]);
  });
});

describe("array element writes of objects", () => {
  test("a write that closes a cycle fails; one that does not is stored", async () => {
    expect(
      await value(
        "const a = [0]; const o = { a }; a[1] = { o: {} }; a[0] = {}; return [a.length, typeof a[1].o]",
      ),
    ).toEqual([2, "object"]);
    for (const write of ["a[0] = { list: [a] }", "a[1] = { o }", "a[0] = a"])
      expect(
        String(
          await value(
            `const a = [0]; const o = { a }; ${write}; return 1`,
          ).catch((error) => error),
        ),
      ).toContain("circular value");
  });
});

describe("string and Math built-ins", () => {
  test("objects still convert through their own methods; primitives as they are", async () => {
    expect(
      await value(
        `const b = { toString() { return "b" } }
const n = { valueOf() { return 3 } }
return ["abc".includes(b), "abc".startsWith("b", { valueOf() { return 1 } }), String.prototype.padStart.call(5, 3, "0"), "x".padEnd(n, b), Math.abs(n), Math.max(1, n), Math.pow(2, n), "abc".at(-1), "ab".repeat(2)]`,
      ),
    ).toEqual([true, true, "005", "xbb", 3, 3, 8, "c", "abab"]);
  });
});
