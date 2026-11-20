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

// The README examples must run under Node and Bun once installed from the tarball: the Promise one without effect
// installed, and the Effect one with it.
const promise = `
import { Host, Runtime } from "psychoscript"
const runtime = Runtime.make({ globals: () => ({ double: Host.fn(([n]) => Number(n) * 2) }) })
const result = await runtime.execute("return [await double(21), [1, 2, 3].map((x) => x + 1)]")
if (JSON.stringify(result) !== '{"ok":true,"value":[42,[2,3,4]],"metadata":null}') throw new Error(JSON.stringify(result))
`
const withEffect = `
import { Effect } from "effect"
import { Host, Runtime } from "psychoscript/effect"
const runtime = Runtime.make({ globals: () => ({ double: Host.fn(([n]) => Effect.succeed(Number(n) * 2)) }) })
const result = await Effect.runPromise(runtime.execute("return await double(21)"))
if (JSON.stringify(result) !== '{"ok":true,"value":42,"metadata":null}') throw new Error(JSON.stringify(result))
`

const consume = async (dependencies: Record<string, string>, program: string) => {
  const consumer = await mkdtemp(path.join(tmpdir(), "psychoscript-"))
  try {
    await Bun.write(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
    await Bun.write(path.join(consumer, "example.mjs"), program)
    await $`npm install --ignore-scripts --no-audit --no-fund`.cwd(consumer)
    if (!("effect" in dependencies) && (await Bun.file(path.join(consumer, "node_modules/effect/package.json")).exists())) {
      throw new Error("effect was installed without being asked for")
    }
    await $`node example.mjs`.cwd(consumer)
    await $`bun example.mjs`.cwd(consumer)
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

await consume({ psychoscript: `file:${tarball}` }, promise)
await consume({ psychoscript: `file:${tarball}`, effect }, withEffect)
