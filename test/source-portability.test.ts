import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parse } from "acorn"

// psychoscript runs in browsers as well as Node and Bun (the browser job runs test/portable.test.ts and others there),
// so src/ imports no Node modules and touches Node-only globals only behind a `typeof` check in the same file.

const root = path.join(import.meta.dir, "..", "src")
const nodeOnly = new Set(["process", "Bun", "Deno", "require", "module", "exports", "__dirname", "__filename", "global",
  "setImmediate", "clearImmediate", "Buffer"])
// Files that use one unguarded because nothing reaches them without it.
const allowed: Record<string, ReadonlyArray<string>> = {
  // Its global is installed only where the host has a Buffer (runtime/globals.ts).
  "stdlib/buffer.ts": ["Buffer"],
}

const transpiler = new Bun.Transpiler({ loader: "ts" })
const files = Array.from(new Bun.Glob("**/*.ts").scanSync(root)).sort()

describe("src is portable", () => {
  test("imports only its own files, acorn, and effect from src/effect", async () => {
    const imports = await Promise.all(
      files.map(async (file) =>
        transpiler
          .scanImports(await Bun.file(path.join(root, file)).text())
          .map((entry) => entry.path)
          .filter((specifier) => !specifier.startsWith(".") && specifier !== "acorn" && !(specifier === "effect" && file.startsWith("effect/")))
          .map((specifier) => `${file}: ${specifier}`),
      ),
    )
    expect(imports.flat()).toEqual([])
  })

  test("uses Node-only globals only behind a typeof check", async () => {
    const found = await Promise.all(
      files.map(async (file) => {
        const code = transpiler.transformSync(await Bun.file(path.join(root, file)).text())
        const tree = parse(code, { ecmaVersion: "latest", sourceType: "module" })
        const names = references(tree)
        // A guard, or a local of the same name, covers the whole file.
        const covered = new Set([...names.filter((name) => name.guard).map((name) => name.name), ...declared(tree)])
        return names
          .filter((name) => !covered.has(name.name) && !allowed[file]?.includes(name.name))
          .map((name) => `${file}: ${name.name}`)
      }),
    )
    expect([...new Set(found.flat())]).toEqual([])
  })
})

type Reference = { readonly name: string; readonly guard: boolean }

// Identifiers naming a Node-only global, skipping property names and object keys; `guard` marks `typeof name`.
const references = (node: unknown, guard = false): Array<Reference> => {
  if (Array.isArray(node)) return node.flatMap((item) => references(item))
  if (typeof node !== "object" || node === null) return []
  const record = node as Record<string, unknown> & { type?: string; name?: string; computed?: boolean }
  if (record.type === "Identifier") return nodeOnly.has(record.name!) ? [{ name: record.name!, guard }] : []
  if (record.type === "UnaryExpression" && record.operator === "typeof") return references(record.argument, true)
  return Object.entries(record).flatMap(([key, value]) => {
    if (key === "loc" || key === "start" || key === "end") return []
    if (!record.computed && ((record.type === "MemberExpression" && key === "property") || key === "key")) return []
    return references(value)
  })
}

// Names the file declares itself: variables, functions, parameters and catch bindings.
const declared = (node: unknown): Array<string> => {
  if (Array.isArray(node)) return node.flatMap(declared)
  if (typeof node !== "object" || node === null) return []
  const record = node as Record<string, unknown>
  return [...bindingNames([record.id, record.param, record.params]), ...Object.values(record).flatMap(declared)]
}

const bindingNames = (node: unknown): Array<string> => {
  if (Array.isArray(node)) return node.flatMap(bindingNames)
  if (typeof node !== "object" || node === null) return []
  const record = node as Record<string, unknown> & { type?: string; name?: string }
  if (record.type === "Identifier") return [record.name!]
  if (record.type === "AssignmentPattern") return bindingNames(record.left)
  if (record.type === "RestElement") return bindingNames(record.argument)
  if (record.type === "ArrayPattern") return bindingNames(record.elements)
  if (record.type === "ObjectPattern") return bindingNames((record.properties as Array<Record<string, unknown>>).map((property) => property.value ?? property.argument))
  return []
}
