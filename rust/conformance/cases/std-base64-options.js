// Uint8Array.prototype.toBase64 and Uint8Array.fromBase64 options: alphabet, omitPadding and lastChunkHandling, read
// through getters, and what they refuse.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const bytes = new Uint8Array([251, 255])
let reads = 0
return [
  bytes.toBase64({ alphabet: "base64url" }), bytes.toBase64({ omitPadding: true }),
  bytes.toBase64({ alphabet: "base64url", omitPadding: 1 }), bytes.toBase64({}),
  bytes.toBase64({ get alphabet() { reads++; return "base64url" } }), reads,
  [...Uint8Array.fromBase64("-_8=", { alphabet: "base64url" })], [...Uint8Array.fromBase64("+/8")],
  [...Uint8Array.fromBase64("AQ", { lastChunkHandling: "stop-before-partial" })],
  [...Uint8Array.fromBase64("AQ=", { lastChunkHandling: "stop-before-partial" })],
  [...Uint8Array.fromBase64("AR==")], [...Uint8Array.fromBase64(" A Q = = ")],
  [...Uint8Array.fromBase64("AQ==", { lastChunkHandling: "strict" })],
  Buffer.from([251, 255]).toString("base64url"), [...Buffer.from("-_8", "base64url")],
  attempt(() => Uint8Array.fromBase64("-_8=")), attempt(() => Uint8Array.fromBase64("A")),
  attempt(() => Uint8Array.fromBase64("AQ", { lastChunkHandling: "strict" })),
  attempt(() => Uint8Array.fromBase64("AR==", { lastChunkHandling: "strict" })),
  attempt(() => Uint8Array.fromBase64("AQ==x")), attempt(() => new Uint8Array(1).toBase64({ alphabet: "hex" })),
  attempt(() => new Uint8Array(1).toBase64(null)), attempt(() => Uint8Array.fromBase64("AQ", 1)),
  attempt(() => Uint8Array.fromBase64("AQ", { lastChunkHandling: "partial" })),
]
