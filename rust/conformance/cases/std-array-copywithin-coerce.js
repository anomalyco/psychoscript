// copyWithin reads the array's length once, before `start`'s `valueOf` can shrink it: the copy still runs over the
// original length, from indexes that the shrink has made holes, and grows the array back with holes between.
function longDenseArray() {
  var a = [0]
  for (var i = 0; i < 1024; i++) a[i] = i
  return a
}
var target
function shorten() {
  target.length = 20
  return 1
}
target = longDenseArray()
var result = target.copyWithin(1000, { valueOf: shorten })
return [result.length, result[1000], result[1018], 20 in result, 999 in result, 1019 in result]
