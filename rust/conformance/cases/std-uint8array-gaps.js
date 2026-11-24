const t = (f) => { try { const r = f(); return r instanceof Uint8Array ? [...r] : r } catch (e) { return [e.name, e.message, e.code ?? null] } }
const like = { length: 2, 0: 10, 1: "20" }
const into = new Uint8Array(3)
into.set(like, 1)
const b = new Uint8Array([3, 1, 2])
const hex = new Uint8Array(3), base64 = new Uint8Array(3)
let got = 0
const getters = { get length() { got++; return 2 }, get 0() { got++; return 1 }, 1: 2 }
const sorted = new Uint8Array([5, 1, 4]).toSorted((x, y) => { got++; return y - x })
const u = new Uint8Array(4)
return [[...new Uint8Array(like)], [...Uint8Array.from(like, (v) => v * 2)], [...into], new Uint8Array(3.9).length, [...Uint8Array.from(getters)], got,
  new Uint8Array(NaN).length, Uint8Array.from(/x/).length, Uint8Array.from(5).length, t(() => Uint8Array.from(null)), t(() => Uint8Array.from(undefined)),
  t(() => new Uint8Array(-1)), t(() => new Uint8Array(Infinity)), t(() => new Uint8Array(-0.5)).length, t(() => new Uint8Array(() => 1)), t(() => Uint8Array.from({ length: 2 ** 53 })),
  [...b.toSorted()], [...b.toSorted((x, y) => y - x)], [...sorted], [...b.toReversed()], [...b.with(-1, 300)], [...b], t(() => b.with(3, 1)), t(() => b.with(-4, 1)),
  [...b.with(1.5, 9)], [...b.with("x", 7)], t(() => b.toSorted(5)), b.toSorted() instanceof Uint8Array,
  [...new Uint8Array([1, 2, 3, 4, 5]).copyWithin(0, 3)], [...new Uint8Array([1, 2, 3, 4, 5]).copyWithin(-2, 0, 2)], [...new Uint8Array([1, 2, 3, 4, 5]).copyWithin(1, 0)],
  hex.setFromHex("abcd"), [...hex], base64.setFromBase64("AQID"), [...base64],
  [t(() => u.setFromHex("abzz")), [...u]], t(() => new Uint8Array(3).setFromHex("abc")), t(() => new Uint8Array(2).setFromBase64("AQID")),
  [t(() => u.setFromBase64("AQID@@@@")), [...u]], t(() => new Uint8Array(4).setFromBase64("AQIDBA", { lastChunkHandling: "stop-before-partial" })),
  t(() => new Uint8Array(4).setFromBase64(" AQ ID ")), t(() => new Uint8Array(4).setFromBase64("AQ", { lastChunkHandling: "strict" })), t(() => new Uint8Array(1).setFromBase64("AQID")),
  t(() => new Uint8Array(2).setFromBase64(1)), t(() => new Uint8Array(2).setFromBase64("AA", null)), t(() => new Uint8Array(4).setFromBase64("-_8", { alphabet: "base64url" })),
  t(() => new Uint8Array(0).setFromHex("zz")), t(() => Uint8Array.prototype.setFromHex.call([], "aa")),
  new Uint8Array(5).subarray(1, 3).byteOffset, new Uint8Array(5).subarray(1, 3).byteLength, new Uint8Array(2).buffer, "byteLength" in new Uint8Array(1),
  t(() => { const x = new Uint8Array(2); x.byteLength = 1 }), t(() => Uint8Array.prototype.byteOffset)]
