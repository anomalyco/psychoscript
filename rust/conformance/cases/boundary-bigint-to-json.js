// A program's BigInt.prototype.toJSON applies to the result, as JSON.stringify applies it.
BigInt.prototype.toJSON = function (key) { return `${this}@${key}` }
return [{ c: 3n }, 4n, new Set([5n]), new Map([[6n, 7n]])]
