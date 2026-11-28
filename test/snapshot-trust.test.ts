import { describe, expect, test } from "bun:test"
import { Runtime } from "../src/runtime.js"
import { createBuiltins } from "../src/runtime/intrinsics.js"
import { Interpreter } from "../src/runtime/interpreter.js"
import { compiledPrelude } from "../src/prelude/prelude.js"
import { savedFrames } from "../src/snapshot.js"
import { SnapshotError } from "../src/snapshot/codec.js"
import type { Snapshot } from "../src/snapshot/snapshot.js"
import { parseVmSource } from "./run.js"

// A snapshot can be forged: everything restored from one is checked, by the decoder or where a built-in reads it, and
// a bad value fails the resumed run with a SnapshotError: never a hang, a host crash, or an error the program can catch.

type Saved = { header: Snapshot["header"]; roots: Array<unknown>; records: Array<SavedRecord> }
type SavedRecord = { t: string; f?: Array<unknown>; v?: Array<unknown>; o?: Array<unknown>; e?: Array<unknown> }

const parse = (code: string) => {
  const parsed = parseVmSource(code)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.source
}

/** A run's state, saved at the first slice where `when` holds for the frames it has. */
const saved = (code: string, when: (snapshot: Saved, frames: Array<string>) => boolean = () => true): Saved => {
  const vm = new Interpreter<never>({ builtins: createBuiltins() }).vm
  vm.start(parse(code))
  vm.tripEvery = 7
  for (let slices = 0; slices < 100_000; slices++) {
    const stop = vm.run()
    if (stop.kind !== "slice") throw new Error(`the run ended before it was saved: ${JSON.stringify(stop)}`)
    const { snapshot } = vm.capture({ strict: true })
    const copy = JSON.parse(JSON.stringify(snapshot)) as Saved
    if (when(copy, savedFrames(snapshot))) return copy
  }
  throw new Error("no slice matched")
}

const ref = (value: unknown) => (value as [string, number])[1]
/** A cached `saved`, copied for each change. */
const once = (make: () => Saved) => {
  let made: Saved | undefined
  return () => structuredClone((made ??= make()))
}
const records = (snapshot: Saved, kind: string) => snapshot.records.filter((record) => record?.t === kind)
const items = (snapshot: Saved, array: unknown) => snapshot.records[ref(array)]!.v!

/** The registers of the saved frame running the prelude function `name`. */
const registersOf = (snapshot: Saved, name: string) => {
  const codes = compiledPrelude().codes
  const frame = records(snapshot, "Frame").find((record) => {
    const code = record.f![1] as [string, [string, string, number]]
    return code[1][1] === "@prelude" && codes[code[1][2]]!.name === name
  })!
  return items(snapshot, frame.f![4])
}

/** How a resumed run of `snapshot` ends: it must reject with a SnapshotError. */
const refused = async (snapshot: Saved) => {
  const outcome = await Runtime.make()
    .resume(snapshot as unknown as Snapshot)
    .run()
    .then(
      (result) => result,
      (error: unknown) => error,
    )
  if (!(outcome instanceof SnapshotError)) throw new Error(`expected a SnapshotError, got ${JSON.stringify(outcome)}`)
  return outcome.message
}

const tampered = async (snapshot: Saved, change: (snapshot: Saved) => void) => {
  change(snapshot)
  return refused(snapshot)
}

const sorting = once(() =>
  saved(
    `const a = Array.from({ length: 20000 }, (_, i) => String((i * 7919) % 20000)); a.sort(); return a[0]`,
    (snapshot, frames) => frames.includes("sortDefault") && Array.isArray(registersOf(snapshot, "sortDefault")[5]),
  ),
)
// sortDefault(target, into, holes, values, undefs) keeps its state in the register after them: an array of the keys,
// the order, a buffer, the next run, the merge width, and the merge's positions.
const arrayItems = (snapshot: Saved, array: unknown) => items(snapshot, snapshot.records[ref(array)]!.f![0])
const sortState = (snapshot: Saved) => arrayItems(snapshot, registersOf(snapshot, "sortDefault")[5])

describe("a forged snapshot is refused", () => {
  test("a default sort's state", async () => {
    expect(await tampered(sorting(), (s) => (sortState(s)[4] = 0))).toContain("merge width is 0")
    expect(await tampered(sorting(), (s) => (sortState(s)[3] = -1))).toContain("out of range")
    expect(await tampered(sorting(), (s) => (sortState(s)[5] = 1e9))).toContain("out of range")
    expect(await tampered(sorting(), (s) => (sortState(s)[0] = 7))).toContain("sort's state")
    expect(await tampered(sorting(), (s) => arrayItems(s, sortState(s)[1]).pop())).toContain("differ in length")
    expect(await tampered(sorting(), (s) => arrayItems(s, sortState(s)[1]).fill(1e9))).toContain("out of range")
    expect(await tampered(sorting(), (s) => arrayItems(s, sortState(s)[0]).fill(true))).toContain("sort key")
    expect(await tampered(sorting(), (s) => (registersOf(s, "sortDefault")[4] = 1e12))).toContain("out of range")
    expect(await tampered(sorting(), (s) => (registersOf(s, "sortDefault")[2] = -5))).toContain("out of range")
    expect(await tampered(sorting(), (s) => (registersOf(s, "sortDefault")[1] = "x"))).toContain("sort's kind")
    expect(await tampered(sorting(), (s) => (registersOf(s, "sortDefault")[3] = 4))).toContain("not an array")
  }, 30_000)

  test("a sort with a comparator's merge", async () => {
    const merging = once(() =>
      saved(`const a = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 3000); a.sort((x, y) => x - y); return a[0]`, (_, frames) =>
        frames.includes("sortWith"),
      ),
    )
    // sortWith(target, into, holes, comparator, work, undefs, merges), then merged, merge, middle, high, left, right.
    expect(await tampered(merging(), (s) => (registersOf(s, "sortWith")[11] = 1e9))).toContain("out of range")
    expect(await tampered(merging(), (s) => (registersOf(s, "sortWith")[10] = -1))).toContain("out of range")
    expect(await tampered(merging(), (s) => (registersOf(s, "sortWith")[4] = "work"))).toContain("not an array")
  }, 30_000)

  test("the console's state and logs", async () => {
    const logging = once(() => saved(`console.group("g"); console.count(); for (let i = 0; i < 50; i++) console.log(i); return 1`))
    const ctx = (s: Saved) => records(s, "Interpreter")[0]!.f!
    expect(await tampered(logging(), (s) => (ctx(s)[0] = 123))).toContain("console's state")
    expect(await tampered(logging(), (s) => (ctx(s)[6] = -1))).toContain("console's state")
    expect(await tampered(logging(), (s) => (ctx(s)[6] = 0.5))).toContain("console's state")
    expect(await tampered(logging(), (s) => (items(s, ctx(s)[0]!)[0] = 7))).toContain("console's state")
    const state = (s: Saved) => s.records[ref(ctx(s)[5])]!.e!
    expect(await tampered(logging(), (s) => (state(s)[state(s).indexOf("indent") + 1] = 123))).toContain("console's state")
    expect(await tampered(logging(), (s) => (state(s)[state(s).indexOf("indent") + 1] = "\n"))).toContain("console's state")
  }, 30_000)

  test("the scheduler, the host calls, and frames", async () => {
    const running = once(() =>
      saved(`const p = Promise.resolve(1).then((x) => x + 1); let n = 0; for (let i = 0; i < 200; i++) n += await p; return n`),
    )
    const scheduler = (s: Saved) => records(s, "VmScheduler")[0]!.f!
    expect(await tampered(running(), (s) => (scheduler(s)[3] = 1e6))).toContain("head")
    expect(await tampered(running(), (s) => (scheduler(s)[5] = -1))).toContain("VmScheduler")
    expect(await tampered(running(), (s) => (scheduler(s)[2] = 5))).toContain("VmScheduler")
    expect(await tampered(running(), (s) => (records(s, "HostCalls")[0]!.f![0] = 5))).toContain("HostCalls")
    expect(await tampered(running(), (s) => (records(s, "HostCalls")[0]!.f![4] = -1))).toContain("HostCalls")
    expect(await tampered(running(), (s) => (records(s, "PromiseObj")[0]!.f![0] = "weird"))).toContain("PromiseObj")
    // A register holding something no instruction leaves there.
    const scheduler_ = (s: Saved) => s.records.findIndex((record) => record?.t === "VmScheduler")
    expect(
      await tampered(running(), (s) => {
        const regs = items(s, records(s, "Frame")[0]!.f![4])
        regs[0] = ["r", scheduler_(s)]
      }),
    ).toContain("register")
  }, 30_000)

  test("program values that hold the VM's own records, and built-ins' fields", async () => {
    const values = once(() =>
      saved(
        `const m = new Map([[1, "a"]]); const r = /a+/g; const it = [1, 2, 3].values(); const o = { a: [1, 2] }
         let f = () => o; let n = 0; for (let i = 0; i < 300; i++) n += o.a.length; return [m.get(1), r.source, it.next().value, f(), n]`,
      ),
    )
    const frame = (s: Saved) => s.records.findIndex((record) => record?.t === "Frame")
    expect(await tampered(values(), (s) => (items(s, records(s, "Arr")[0]!.f![0])[0] = ["r", frame(s)]))).toContain("Arr")
    expect(await tampered(values(), (s) => (records(s, "Arr")[0]!.f![0] = "items"))).toContain("Arr")
    expect(
      await tampered(values(), (s) => {
        const props = records(s, "Obj").find((record) => record.o!.includes("a"))!.o!
        props[props.indexOf("a") + 1] = ["r", frame(s)]
      }),
    ).toContain("program value")
    expect(await tampered(values(), (s) => (records(s, "RegExpObj")[0]!.f![0] = "("))).toBeString()
    expect(await tampered(values(), (s) => (records(s, "Position")[0]!.f![0] = -1))).toContain("Position")
    expect(await tampered(values(), (s) => (records(s, "Position")[0]!.f![3] = "sideways"))).toContain("Position")
    expect(await tampered(values(), (s) => (records(s, "OrderedTable")[0]!.f![0] = 5))).toContain("OrderedTable")
    expect(await tampered(values(), (s) => (records(s, "Cell")[0]!.f![0] = ["r", frame(s)]))).toContain("Cell")
    expect(await tampered(values(), (s) => (records(s, "DateObj")[0] ? 0 : (records(s, "Arr")[0]!.f![1] = 1)))).toContain(
      "Arr",
    )
  }, 30_000)

  // Random damage to real snapshots: whatever it changes, the run ends (a result or a SnapshotError), without a hang and
  // without an engine error leaking the interpreter's own source (JavaScriptCore quotes it).
  test("random changes never hang the host or leak its errors", async () => {
    const programs = [
      sorting(),
      saved(`const m = new Map(); const s = new Set(); const out = []
        for (let i = 0; i < 400; i++) { m.set(i, [i]); s.add(String(i)); out.push({ i, d: new Date(i) }) }
        console.log(out.length); return [m.size, s.size, JSON.stringify(out).length]`),
      saved(`async function* g() { for (let i = 0; i < 300; i++) yield i }
        let n = 0; for await (const x of g()) n += x; const re = /x(y)?/g; return [n, "xyx".replace(re, "z"), [3, 1, 2].toSorted()]`),
      saved(`function* g() { for (let i = 0; i < 300; i++) yield [i] } let n = 0; for (const [x] of g()) n += x
        const all = await Promise.all([1, Promise.resolve(2), (async () => 3)()]); class A { #x = 1; get x() { return this.#x } }
        class B extends A { constructor() { super() } } const r = await Promise.allSettled([Promise.reject(new Error("e")), 1])
        const it = new Map([[1, 2]]).entries(); const fr = [...it]; return [n, all, new B().x, r.length, fr, Array.from({ length: 300 }, (_, i) => i).reduce((a, b) => a + b)]`),
    ]
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const junk = [-1, 0, 1e12, 0.5, "x", "", true, null, ["u"], ["n", "NaN"], ["b", "ff"], [], ["s", "iterator"]]
    for (let round = 0; round < 300; round++) {
      const snapshot = structuredClone(programs[round % programs.length]!)
      const record = snapshot.records[random(snapshot.records.length)]!
      const fields = record.f ?? record.v ?? record.o ?? record.e
      if (fields === undefined || fields.length === 0) continue
      const pick = random(junk.length + 1)
      fields[random(fields.length)] =
        pick === junk.length ? ["r", random(snapshot.records.length)] : structuredClone(junk[pick])
      const outcome = await Runtime.make({ limits: { timeoutMs: 2000 } })
        .resume(snapshot as unknown as Snapshot)
        .run()
        .then(
          (result) => result,
          (error: unknown) => error,
        )
      if (outcome instanceof SnapshotError) continue
      expect(outcome).not.toBeInstanceOf(Error)
      expect(JSON.stringify(outcome)).not.toMatch(/\(In '|is not an object \(evaluating/)
    }
  }, 120_000)
})
