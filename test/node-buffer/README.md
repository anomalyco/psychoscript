# Node's Buffer tests

The `test-buffer-*.js` files are copied unchanged from Node's `test/parallel` at tag v24.16.0 (commit
c7d10158bc31036de6783d66beaaaf551e3167aa), the Node version CI uses. They are Node's, under its MIT license
([LICENSE](LICENSE)).

`test/node-buffer.test.ts` runs each one inside psychoscript. `run.ts` runs every top-level statement on its own,
so one failure doesn't hide the rest, and `harness.js` provides the parts of `assert` and `test/common` the tests
use. `expected.json` lists, per file, the lines of the statements known to fail, nearly all for language features
psychoscript lacks (other typed arrays, `DataView`, `Symbol()`, `Object.setPrototypeOf`, `vm`, extending
`String`, `process`) or for parts of the module it leaves out (`SlowBuffer`, Node's internal bindings).

`bun run script/node-buffer.ts` prints each file's pass count; `--write` regenerates `expected.json`, and `--node`
runs the tests with the built package under Node.

Left out: tests of `SlowBuffer`, `buffer.constants`, `isUtf8`/`isAscii`, `util.inspect`, `SharedArrayBuffer` and
resizable buffers, Node's internal bindings and command-line flags, deprecation warnings, worker threads, child
processes, and strings of 4 GB.

`fuzz.ts`, `fuzz-driver.js` and `fuzz-node.mjs` are the differential fuzz `test/buffer-fuzz.test.ts` runs against
Node 24.
