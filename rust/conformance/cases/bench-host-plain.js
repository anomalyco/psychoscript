// bench-host-bytes.js with a plain array, which the host gets as a copy and turns into float32 bytes itself.
const vertices = new Array(30000).fill(0)
for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.25
let check = 0
for (let frame = 0; frame < 60; frame++) {
  vertices[0] = frame
  check = (check + tools.upload(vertices)) % 1000003
}
return check
