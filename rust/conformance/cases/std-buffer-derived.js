// Uint8Array methods that make new bytes make them of the receiver's kind: a Buffer's are a Buffer. Dates' locale
// forms are en-US in local time, and refuse null locales or options.
const attempt = (f) => { try { return f() } catch (e) { return e.name + ": " + e.message } }
const b = Buffer.from("abc")
const made = [b.map((x) => x + 1), b.filter((x) => x > 97), Uint8Array.prototype.slice.call(b, 1), Uint8Array.prototype.subarray.call(b, 2)]
const d = new Date(Date.UTC(2024, 0, 15, 13, 5, 9))
return [
  ...made.map((x) => [Buffer.isBuffer(x), x.toString()]), Buffer.isBuffer(new Uint8Array(1).map((x) => x)),
  String(new Uint8Array([1, 2]).slice(1)),
  d.toLocaleString(), d.toLocaleDateString(), d.toLocaleTimeString(), d.toLocaleString("en-US"),
  attempt(() => d.toLocaleString(null)), attempt(() => d.toLocaleTimeString(undefined, null)),
]
