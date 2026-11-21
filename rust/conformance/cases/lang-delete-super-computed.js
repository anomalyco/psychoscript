// `delete super[key]` throws a ReferenceError before converting the key to a property key: the key's `toString` and
// `valueOf` never run.
var converted = false
var key = {
  toString() {
    converted = true
    return "x"
  },
  valueOf() {
    converted = true
    return "x"
  },
}
var obj = {
  m() {
    delete super[key]
  },
}
var name
try {
  obj.m()
} catch (error) {
  name = error.name
}
return [name, converted]
