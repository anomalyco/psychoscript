import { cases, selfCases } from "./history.js"
import { agents } from "./agents.js"

/** Programs the cells time. Sentinels are the targets a polluted history slows down on JSC when `Vm.exec` is stuck in a bad compile. */
export const targets: Readonly<Record<string, string>> = {
  loop: selfCases.loop,
  closures: selfCases.closures,
  classes: selfCases.classes,
  fib: selfCases.fib,
  closureCall: cases.closureCall,
  protoMethod: cases.protoMethod,
  forLoop: cases.forLoop,
  objects: selfCases.objects,
  sort: selfCases.sort,
  strings: selfCases.strings,
  filterCb: selfCases.filterCb,
  propRead: cases.propRead,
  accessors: `const o = { _v: 1, get v() { return this._v }, set v(x) { this._v = x } }
const p = Object.create(o)
let sum = 0
for (let i = 0; i < 100000; i++) { p.v = i; sum += p.v + o.v }
return sum`,
  agent: agents[0]!,
  empty: "return 1",
}

export const sentinels = ["classes", "protoMethod", "accessors"]
