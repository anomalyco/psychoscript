import { parse, type Node } from "acorn"

// Runs one of Node's buffer tests inside psychoscript, each top-level statement on its own (see harness.js). Takes the
// runtime as an argument so the same runner drives the source build under Bun and the built package under Node.

export type Execute = (
  code: string,
) => Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string; readonly location?: { readonly line: number } } }
>

export type Failure = { readonly line: number; readonly message: string }

export type Outcome = {
  /** The test's top-level statements, each run on its own. */
  readonly total: number
  /** The statements that threw, by their line in the test, and `mustCall` counts that were off (line 0). */
  readonly failures: ReadonlyArray<Failure>
  readonly skipped?: boolean
}

type Statement = Node & { kind?: string; id?: { name: string }; directive?: string; loc: { start: { line: number } } }

/** The test's top-level statements as code that records each one's failure and goes on. */
const statements = (source: string) => {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    locations: true,
  }) as unknown as { body: Array<Statement> }
  return program.body.flatMap((node) => {
    if (node.type === "ExpressionStatement" && node.directive !== undefined) return []
    const text = source.slice(node.start, node.end).replace(/\brequire\(/g, "__require(")
    // Function declarations stay as they are, so they are hoisted; declarations become `var`s, so they outlive the
    // `try` block around them.
    if (node.type === "FunctionDeclaration") return [{ line: 0, code: text }]
    const body =
      node.type === "VariableDeclaration"
        ? `var${text.slice(node.kind!.length)}`
        : node.type === "ClassDeclaration"
          ? `var ${node.id!.name} = ${text}`
          : text
    return [{ line: node.loc.start.line, code: body }]
  })
}

export const runNodeTest = async (execute: Execute, harness: string, source: string): Promise<Outcome> => {
  const parts = statements(source)
  const lines = parts.filter((part) => part.line > 0).map((part) => part.line)
  // A failure the program can't catch ends the whole run; that statement is then counted as failed and left out.
  const dropped = new Map<number, string>()
  for (;;) {
    const code: Array<string> = [harness]
    const starts: Array<number> = []
    let row = harness.split("\n").length + 1
    let index = 0
    for (const part of parts) {
      starts.push(row)
      if (part.line === 0) code.push(part.code)
      else {
        const message = dropped.get(index)
        code.push(
          message === undefined
            ? `try {\n${part.code}\n} catch (__error) { __record(${index}, ${part.line}, __error) }`
            : `__record(${index}, ${part.line}, ${JSON.stringify(message)})`,
        )
        index++
      }
      row += code.at(-1)!.split("\n").length
    }
    code.push(`return __finish(${lines.length})`)
    const result = await execute(code.join("\n"))
    if (result.ok) return result.value as Outcome
    if (result.error.message.includes("__SKIP__")) return { total: lines.length, failures: [], skipped: true }
    const line = result.error.location?.line
    const at = line === undefined ? -1 : starts.findLastIndex((start) => start <= line)
    const statement = at < 0 ? -1 : parts.slice(0, at + 1).filter((part) => part.line > 0).length - 1
    if (statement < 0 || parts[at]!.line === 0 || dropped.has(statement)) {
      return { total: lines.length, failures: lines.map((line) => ({ line, message: result.error.message })) }
    }
    dropped.set(statement, result.error.message)
  }
}
