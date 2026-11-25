// Reference counterpart of bench/examples/embed.rs. Usage: bun bench/ref/embed.ts [code]
import { reference, toolsGlobal } from "../../conformance/reference.js"

// The reference: the package from PSYCHOSCRIPT_REF, or by default the repository root. The programs reach one host
// global, `tools`, the namespace of conformance/reference.ts (`tools.echo`, `tools.git.status`, ... all async).
const ref = await reference(process.env.PSYCHOSCRIPT_REF)
const Effect = ref.Effect
const tools = toolsGlobal(ref)
const runtime = ref.Language.Runtime.make({ globals: () => ({ tools }) })

const result = await Effect.runPromise(runtime.execute(process.argv[2] ?? "return 1"))
for (const line of result.logs ?? []) console.error(line)
if (!result.ok) {
  console.error(`${result.error.kind}: ${result.error.message}`)
  process.exit(1)
}
console.log(JSON.stringify(result.value))
