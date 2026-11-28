// What the browser job bundles: the test files that run in browsers, registered with the bun:test stand-in.
import { run } from "./bun-test.js"
import "../portable.test.js"
import "../vm.test.js"
import "../stdlib.test.js"
import "../snapshot.test.js"
import "../bigint.test.js"
import "../limits.test.js"

Object.assign(globalThis, { runTests: run })
