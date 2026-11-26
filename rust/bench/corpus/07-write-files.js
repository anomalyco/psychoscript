const files = {
  "a.js": "let sum = 0\nfor (let i = 0; i < 3000000; i++) {}\nreturn sum",
  "b.js": "const f = (n) => n\nlet sum = 0\nfor (let i = 0; i < 3000000; i++) sum = f(i)\nreturn sum",
  "c.js": "const o = { a: 1 }\nlet sum = 0\nfor (let i = 0; i < 3000000; i++) sum = sum + o.a\nreturn sum",
  "d.js": "return 1",
}
for (const [k, v] of Object.entries(files)) await tools.write({ path: "/tmp/micro/" + k, content: v })
return Object.keys(files).length + " files"
