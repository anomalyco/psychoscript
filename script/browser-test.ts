#!/usr/bin/env bun

// Runs test/browser/entry.ts's test files in Chromium, Firefox and WebKit through Playwright, from a page served on
// loopback (a secure context, which crypto.randomUUID needs). Install the browsers first:
// `bunx playwright install chromium firefox webkit`. Pass engine names to run only those.

import path from "node:path"
import { chromium, firefox, webkit } from "playwright"
import type { Outcome } from "../test/browser/bun-test.js"

const root = path.join(import.meta.dir, "..")
const shims = path.join(root, "test/browser")

// Tests that can't pass in a browser, by name, and why. Every other test must pass in every engine.
const skips: ReadonlyArray<{ readonly name: string; readonly engines?: ReadonlyArray<string>; readonly why: string }> = [
  { name: "Buffer", why: "browsers have no Buffer, so programs get none" },
  { name: "base64 alphabet, omitPadding", why: "compares with Buffer" },
  {
    name: "Headers > rejects what it cannot build from",
    why: "Headers validates names and values with the host's Headers, whose messages differ by engine",
  },
  { name: "resumes in a fresh process", why: "spawns Bun" },
  { name: "another process compiles the same bytecode", why: "spawns Bun" },
  {
    name: "String methods read and update lastIndex like exec",
    engines: ["webkit"],
    why: "JavaScriptCore leaves a sticky RegExp's lastIndex at 0 after replace; the RegExp is the engine's",
  },
  {
    name: "the default sort converts equal huge BigInts once",
    engines: ["firefox"],
    why: "SpiderMonkey takes about 3 s to turn a million-bit BigInt into decimal text",
  },
]

const built = await Bun.build({
  entrypoints: [path.join(shims, "entry.ts")],
  target: "browser",
  format: "esm",
  // package.json says the package has no side effects, but test files register tests when imported.
  ignoreDCEAnnotations: true,
  plugins: [
    {
      name: "browser-test-shims",
      setup: (build) => {
        build.onResolve({ filter: /^bun:test$/ }, () => ({ path: path.join(shims, "bun-test.ts") }))
        build.onResolve({ filter: /^node:(path|url)$/ }, () => ({ path: path.join(shims, "node.ts") }))
      },
    },
  ],
})
if (!built.success) throw new AggregateError(built.logs, "The browser bundle failed to build")
const bundle = await built.outputs[0]!.text()

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/tests.js"
      ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
      : new Response("<!doctype html><meta charset=utf-8><title>psychoscript</title>", { headers: { "content-type": "text/html" } }),
})

const engines = { chromium, firefox, webkit }
const chosen = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines)
let failed = 0
for (const name of chosen) {
  const started = performance.now()
  const browser = await engines[name as keyof typeof engines].launch()
  try {
    const page = await browser.newPage()
    await page.goto(server.url.href)
    const skipped = skips.filter((skip) => skip.engines?.includes(name) ?? true).map((skip) => skip.name)
    const outcomes: Array<Outcome> = await page.evaluate(async (skipped) => {
      const bundle = "/tests.js"
      await import(bundle)
      const run = (globalThis as unknown as { runTests: (skip: (name: string) => string | undefined) => Promise<Array<Outcome>> }).runTests
      return run((test) => skipped.find((part) => test.includes(part)))
    }, skipped)
    const count = (status: Outcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length
    for (const outcome of outcomes.filter((outcome) => outcome.status === "failed")) {
      console.log(`\n✗ ${name}: ${outcome.name}\n${outcome.error}`)
    }
    failed += count("failed")
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.log(`${name}: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped in ${seconds}s`)
  } finally {
    await browser.close()
  }
}
await server.stop()
process.exit(failed === 0 ? 0 : 1)
