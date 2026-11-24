console.log({ a: undefined }, [undefined], [, 1], undefined, null, { b: [undefined, null] }); console.table([{ a: 1, f: () => 2 }]); console.table(() => 1); console.table(Promise.resolve(1))
console.assert(true, "hidden"); console.assert(false, "x", 1); console.assert(0, { a: 1 }); console.assert()
console.count(); console.count(); console.count("x"); console.countReset(); console.count(); console.countReset("y"); console.count(5)
console.group("G"); console.log("a\nb"); console.groupCollapsed(); console.warn("w"); console.table([1]); console.dir({ x: 1 }); console.groupEnd()
console.groupEnd(); console.groupEnd(); console.log("out"); console.trace("t", 1); console.trace()
console.log(Symbol.iterator, [Symbol.toStringTag], { s: Symbol.toPrimitive })
console.timeEnd(); console.timeLog("q"); console.time("z"); console.time("z")
console.group("H")
for (let i = 0; i < 3; i++) { console.count("loop"); await tools.echo({ id: i }) }
console.countReset("loop"); console.count("loop"); console.groupEnd(); console.log("after")
return [typeof console.time, console.count.length, Object.keys(console)]
