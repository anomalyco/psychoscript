/**
 * The JavaScript engine running psychoscript, as a speed hint: it picks the program the VM warms its main loop with,
 * once per process, and nothing else. Never base a security decision on it.
 */
export type Engine = "jsc" | "v8" | "spidermonkey"

export const engines: ReadonlyArray<Engine> = ["jsc", "v8", "spidermonkey"]

let preferred: Engine | undefined

/** Records the host's `engine` option; the first one given wins. */
export const preferEngine = (engine: Engine): void => {
  preferred ??= engine
}

/** The host's `engine` option, or the engine `Error.stack`'s layout suggests, or undefined when it suggests none. */
export const currentEngine = (): Engine | undefined => preferred ?? detectEngine()

// `stack` is non-standard, so its layout tells the engines apart (a host may patch it; this is only a hint): V8 (Node
// >= 21) makes it an accessor on each error, JavaScriptCore (Bun, Safari) a data property on each error, SpiderMonkey
// an accessor on Error.prototype.
const detectEngine = (): Engine | undefined => {
  if (typeof Object.getOwnPropertyDescriptor(Error.prototype, "stack")?.get === "function") return "spidermonkey"
  const own = Object.getOwnPropertyDescriptor(new Error(), "stack")
  if (typeof own?.get === "function") return "v8"
  if (own !== undefined && "value" in own) return "jsc"
  return undefined
}
