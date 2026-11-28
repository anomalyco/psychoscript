// The node:path and node:url functions test/run.ts imports, for the browser bundle; only their names are used there.
export const join = (...parts: Array<string>): string => parts.join("/").replace(/\/+/g, "/")
export const pathToFileURL = (file: string): URL => new URL(`file://${file.startsWith("/") ? "" : "/"}${file}`)
export default { join }
