#!/usr/bin/env bun

import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pack } from "./pack-tarball.js"

const tarball = await pack()
// SAFETY: the manifest pins effect as a dev dependency.
const effect = ((await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()) as {
  devDependencies: Record<string, string>
}).devDependencies.effect

// The README example must run under Node and Bun once installed from the tarball.
const program = `
import { Effect } from "effect"
import { Host, Runtime } from "psychoscript"
const runtime = Runtime.make({ globals: () => ({ double: Host.fn(([n]) => Effect.succeed(Number(n) * 2)) }) })
const result = await Effect.runPromise(runtime.execute("return [await double(21), [1, 2, 3].map((x) => x + 1)]"))
if (JSON.stringify(result) !== '{"ok":true,"value":[42,[2,3,4]],"metadata":null}') throw new Error(JSON.stringify(result))
`
const consumer = await mkdtemp(path.join(tmpdir(), "psychoscript-"))
try {
  await Bun.write(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: { psychoscript: `file:${tarball}`, effect } }),
  )
  await Bun.write(path.join(consumer, "example.mjs"), program)
  await $`npm install --ignore-scripts --no-audit --no-fund`.cwd(consumer)
  await $`node example.mjs`.cwd(consumer)
  await $`bun example.mjs`.cwd(consumer)
} finally {
  await rm(consumer, { recursive: true, force: true })
}
