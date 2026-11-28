// Runs fuzz-driver.js with Node's own Buffer: reads the cases as JSON on stdin and writes the traces as JSON.
import { readFileSync } from "node:fs"

const driver = readFileSync(new URL("./fuzz-driver.js", import.meta.url), "utf8")
const runCases = new Function(`${driver}\nreturn runCases`)()
const input = readFileSync(0, "utf8")
process.stdout.write(JSON.stringify(runCases(JSON.parse(input))))
