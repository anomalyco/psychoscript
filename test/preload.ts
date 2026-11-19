import { setRoundTrip } from "../src/runtime/execute.js"
import { accessorRule, nativeRule } from "../src/runtime/objects.js"

// Every test run checks that natives are made only with the intrinsics, and that no built-in reaches a program
// getter or setter it has no path for.
nativeRule.check = true
accessorRule.check = true

if (process.env.PSYCHOSCRIPT_ROUNDTRIP === "1") {
  setRoundTrip(true)
}
