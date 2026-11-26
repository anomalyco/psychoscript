// TextDecoder.decode takes an ArrayBuffer as well as a Uint8Array, and names both when it gets neither.
const d = new TextDecoder()
const buffer = new TextEncoder().encode("hé").buffer
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
return {
  buffer: attempt(() => d.decode(buffer)),
  view: attempt(() => d.decode(new Uint8Array(buffer, 1))),
  empty: attempt(() => d.decode(new ArrayBuffer(0))),
  array: attempt(() => d.decode([104, 105])),
  text: attempt(() => d.decode("hi")),
}
