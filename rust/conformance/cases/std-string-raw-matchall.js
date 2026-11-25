const keys = []
for (const key in "😀") keys.push(key)
const it = "a1b2".matchAll(/\d/g)
const first = it.next().value[0]
await null
const re = /a/g
re.lastIndex = 2
return [Object.keys("😀"), Object.hasOwn("😀", "1"), Object.keys({ ..."😀" }), keys, Object.values("😀")[1].length, Object.entries("😀").length,
  String.raw({ raw: "xyz" }, 1, 2), [...String.raw({ raw: "😀" }, "-")].map((c) => c.charCodeAt(0)), String.raw({ raw: "" }, 1), Array.isArray(it), it[Symbol.iterator]() === it, first,
  [...it].map((m) => m.index), it.next().done, Object.prototype.toString.call(it), typeof it.map,
  "banana".matchAll(re).map((m) => m.index).toArray(), re.lastIndex, "a1b22".matchAll(/(\d+)/g).map((m) => m[1]).toArray()]
