// @typed_arrays true
// Hands a 30k-float Float32Array to a host function 60 times, which reads its bytes in place.
const vertices = new Float32Array(30000)
for (let i = 0; i < vertices.length; i++) vertices[i] = i * 0.25
let check = 0
for (let frame = 0; frame < 60; frame++) {
  vertices[0] = frame
  check = (check + tools.upload(vertices)) % 1000003
}
return check
