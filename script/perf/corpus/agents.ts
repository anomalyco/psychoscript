// 30 small agent-style programs with async host tools: JSON, map/filter/sort, Map/Set, regex, string building,
// try/catch, Promise.all, a class and URL. Each body is ~200-600 characters, like a typical tool-calling program.
import type { Host } from "../../../src/index.js"

const repo = (id: number) => ({ id, name: "repo" + id, archived: id % 7 === 0, stars: (id * 37) % 200, forks: id % 11, updated: "2026-11-" + String(1 + (id % 27)).padStart(2, "0") + "T10:00:00Z" })
const repos = Array.from({ length: 40 }, (_, i) => repo(i))
const labels = ["bug", "perf", "docs", "ui", "infra"]
const issues = Array.from({ length: 20 }, (_, i) => ({
  number: 100 + i,
  title: "Issue " + i + " about " + labels[i % 5],
  labels: [labels[i % 5], labels[(i * 3) % 5]],
  state: i % 3 === 0 ? "closed" : "open",
  created: "2026-11-" + String(1 + (i % 9)).padStart(2, "0") + "T0" + (i % 10) + ":00:00Z",
  user: { login: "user" + (i % 6) },
  comments: Array.from({ length: i % 4 }, (_, j) => ({ author: "c" + j, body: "comment " + j + " on " + i })),
}))
const file = (path: string) =>
  Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? "export function fn" + i + "(a, b) {" : i % 5 === 4 ? "}" : "  const v" + i + " = a + b * " + i + " // " + path)).join("\n")
const ls = Array.from({ length: 25 }, (_, i) => "-rw-r--r--  1 u  staff  " + ((i * 7919) % 50000) + " Nov 27 10:00 file" + i + ".ts").join("\n")
const config = { service: { name: "api", port: 8080, replicas: 3, env: { NODE_ENV: "production", LOG: "info" } }, db: { host: "db.local", pool: { min: 2, max: 10 } }, features: { a: true, b: false, c: true } }

export const agentGlobals = (host: typeof Host) => ({
  listRepos: host.fn(() => repos, { type: "async" }),
  getRepo: host.fn(([a]: any) => ({ ...repo(a.id), owner: { login: "o" + a.id }, languages: { ts: 10, rs: 3 } }), { type: "async" }),
  searchIssues: host.fn(() => issues, { type: "async" }),
  readFile: host.fn(([a]: any) => file(a.path), { type: "async" }),
  bash: host.fn(([a]: any) => (a.command.startsWith("cat") ? JSON.stringify(config) : ls), { type: "async" }),
  fetchJson: host.fn(([a]: any) => {
    if (a.url.includes("missing")) throw new Error("404 Not Found: " + a.url)
    return config
  }, { type: "async" }),
  getUser: host.fn(([a]: any) => ({ login: a.login, name: "User " + a.login, followers: a.login.length * 13 }), { type: "async" }),
  writeFile: host.fn(([a]: any) => ({ ok: true, bytes: a.content.length }), { type: "async" }),
})

export const agents: ReadonlyArray<string> = [
  // 1 canonical FP agent body
  `const repos = await listRepos({ org: "acme" })
const open = repos.filter((r) => !r.archived && r.stars > 10)
const details = await Promise.all(open.slice(0, 2).map((r) => getRepo({ id: r.id })))
const summary = details.map((d) => ({ name: d.name, owner: d.owner.login, langs: Object.keys(d.languages).join(", "), score: d.stars * 2 + d.forks }))
summary.sort((a, b) => b.score - a.score)
const text = summary.map((s, i) => \`\${i + 1}. \${s.name} (\${s.owner}) [\${s.langs}] score=\${s.score}\`).join("\\n")
return { count: open.length, top: summary[0]?.name ?? null, text }`,
  // 2 grep a file
  `const text = await readFile({ path: "src/a.ts" })
const hits = text.split("\\n").map((line, i) => ({ line: i + 1, text: line })).filter((l) => /export function/.test(l.text))
return { count: hits.length, first: hits.slice(0, 5) }`,
  // 3 parse ls
  `const out = await bash({ command: "ls -l src" })
const files = out.split("\\n").map((l) => l.trim().split(/\\s+/)).map((p) => ({ name: p[8], size: Number(p[4]) }))
files.sort((a, b) => b.size - a.size)
return files.slice(0, 5).map((f) => f.name + " " + f.size).join("\\n")`,
  // 4 group issues by label
  `const issues = await searchIssues({ q: "repo:acme/api is:issue" })
const byLabel = issues.reduce((acc, issue) => {
  for (const label of issue.labels) acc[label] = (acc[label] ?? 0) + 1
  return acc
}, {})
return byLabel`,
  // 5 stringify config
  `const cfg = await fetchJson({ url: "https://example.com/config.json" })
const pretty = JSON.stringify(cfg, null, 2)
console.log(pretty.split("\\n").length + " lines")
return pretty.length`,
  // 6 users in parallel
  `const logins = ["ann", "bob", "cy", "dee", "eve"]
const users = await Promise.all(logins.map((login) => getUser({ login })))
return users.map((u) => \`\${u.name} (@\${u.login}): \${u.followers} followers\`).join("\\n")`,
  // 7 markdown table from a file
  `const text = await readFile({ path: "src/b.ts" })
const rows = text.split("\\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("}"))
let md = "| # | line |\\n|---|---|\\n"
rows.slice(0, 15).forEach((r, i) => { md += "| " + (i + 1) + " | " + r.replace(/\\|/g, "\\\\|") + " |\\n" })
return md`,
  // 8 repo stats
  `const repos = await listRepos({ org: "acme" })
const stars = repos.map((r) => r.stars)
const total = stars.reduce((a, b) => a + b, 0)
return { total, avg: Math.round(total / stars.length), max: Math.max(...stars), min: Math.min(...stars) }`,
  // 9 failing tool with fallback
  `let cfg
try {
  cfg = await fetchJson({ url: "https://example.com/missing.json" })
} catch (e) {
  console.log("fetch failed: " + e.message)
  cfg = await fetchJson({ url: "https://example.com/config.json" })
}
return cfg.service.name`,
  // 10 write a generated file
  `const repos = await listRepos({ org: "acme" })
const content = repos.filter((r) => r.stars > 100).map((r) => "- " + r.name + ": " + r.stars).join("\\n")
const res = await writeFile({ path: "out/popular.md", content: "# Popular\\n" + content })
return res`,
  // 11 unique labels
  `const issues = await searchIssues({ q: "is:open" })
const set = new Set(issues.flatMap((i) => i.labels))
return Array.from(set).sort()`,
  // 12 word counts
  `const text = await readFile({ path: "src/c.ts" })
const counts = new Map()
for (const word of text.split(/\\W+/)) if (word) counts.set(word, (counts.get(word) ?? 0) + 1)
return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)`,
  // 13 entries transform
  `const cfg = await fetchJson({ url: "https://example.com/config.json" })
const flags = Object.fromEntries(Object.entries(cfg.features).filter(([, on]) => on).map(([k]) => [k.toUpperCase(), true]))
return { flags, env: Object.keys(cfg.service.env) }`,
  // 14 group by day
  `const issues = await searchIssues({ q: "created:>2026-11-01" })
const byDay = {}
for (const i of issues) {
  const day = new Date(i.created).toISOString().slice(0, 10)
  ;(byDay[day] ??= []).push(i.number)
}
return Object.keys(byDay).sort().map((d) => d + ": " + byDay[d].join(","))`,
  // 15 sequential tool calls
  `const results = []
for (const id of [3, 5, 8]) {
  const r = await getRepo({ id })
  results.push(r.name + "=" + r.stars)
}
return results.join("; ")`,
  // 16 padded table
  `const repos = await listRepos({ org: "acme" })
const lines = repos.slice(0, 12).map((r) => r.name.padEnd(10) + String(r.stars).padStart(5) + String(r.forks).padStart(4))
console.log(lines.join("\\n"))
return lines.length`,
  // 17 JSON from bash
  `const raw = await bash({ command: "cat config.json" })
const cfg = JSON.parse(raw)
return { port: cfg.service.port, pool: cfg.db.pool.max - cfg.db.pool.min }`,
  // 18 destructuring and spread
  `const cfg = await fetchJson({ url: "https://example.com/config.json" })
const { service: { env, ...service }, db } = cfg
const merged = { ...service, ...env, dbHost: db.host, replicas: service.replicas + 1 }
return merged`,
  // 19 matchAll function names
  `const text = await readFile({ path: "src/d.ts" })
const names = [...text.matchAll(/function (\\w+)\\(([^)]*)\\)/g)].map((m) => m[1] + "/" + m[2].split(",").length)
return names`,
  // 20 small class
  `class Tally {
  constructor() { this.items = [] }
  add(name, n) { this.items.push({ name, n }); return this }
  get total() { return this.items.reduce((a, b) => a + b.n, 0) }
}
const repos = await listRepos({ org: "acme" })
const t = new Tally()
for (const r of repos.slice(0, 10)) t.add(r.name, r.stars)
return { total: t.total, n: t.items.length }`,
  // 21 progress logs
  `const repos = await listRepos({ org: "acme" })
let done = 0
for (const r of repos.slice(0, 8)) {
  done++
  console.log(\`[\${done}/8] checked \${r.name}\`)
}
return "checked " + done`,
  // 22 find/some/every
  `const repos = await listRepos({ org: "acme" })
return {
  firstArchived: repos.find((r) => r.archived)?.name,
  idx: repos.findIndex((r) => r.stars > 150),
  anyBig: repos.some((r) => r.forks > 9),
  allNamed: repos.every((r) => r.name.startsWith("repo")),
}`,
  // 23 flatMap comments
  `const issues = await searchIssues({ q: "comments:>0" })
const comments = issues.flatMap((i) => i.comments.map((c) => ({ issue: i.number, author: c.author, body: c.body })))
return { n: comments.length, sample: comments.slice(0, 3) }`,
  // 24 optional chaining
  `const cfg = await fetchJson({ url: "https://example.com/config.json" })
return [cfg?.service?.env?.LOG ?? "none", cfg.cache?.ttl ?? 60, cfg.db?.pool?.max ?? 1, cfg.missing?.deep?.x ?? null]`,
  // 25 URL parsing
  `const urls = ["https://api.example.com/v1/items?page=2&limit=50", "https://example.com/search?q=psychoscript&sort=stars"]
const parsed = urls.map((u) => { const url = new URL(u); return { host: url.host, path: url.pathname, params: Object.fromEntries(url.searchParams) } })
const user = await getUser({ login: parsed[1].params.q })
return { parsed, user: user.name }`,
  // 26 number formatting
  `const repos = await listRepos({ org: "acme" })
const ratio = repos.map((r) => (r.forks / Math.max(1, r.stars)).toFixed(3))
const pct = ((repos.filter((r) => r.archived).length / repos.length) * 100).toFixed(1) + "%"
return { pct, top: ratio.slice(0, 5) }`,
  // 27 chunked parallel calls
  `const ids = Array.from({ length: 12 }, (_, i) => i)
const out = []
for (let i = 0; i < ids.length; i += 4) {
  const page = await Promise.all(ids.slice(i, i + 4).map((id) => getRepo({ id })))
  out.push(...page.map((r) => r.name))
}
return out.length`,
  // 28 localeCompare sort
  `const users = await Promise.all(["zoe", "Adam", "bea", "Carl"].map((login) => getUser({ login })))
return users.map((u) => u.name).sort((a, b) => a.localeCompare(b))`,
  // 29 line diff
  `const [a, b] = await Promise.all([readFile({ path: "src/a.ts" }), readFile({ path: "src/b.ts" })])
const la = a.split("\\n"), lb = b.split("\\n")
const changed = []
for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) changed.push(i + 1)
return { changed: changed.length, first: changed.slice(0, 5) }`,
  // 30 report
  `const [repos, issues] = await Promise.all([listRepos({ org: "acme" }), searchIssues({ q: "is:open" })])
const report = {
  repos: repos.length,
  open: issues.filter((i) => i.state === "open").length,
  byUser: issues.reduce((m, i) => ({ ...m, [i.user.login]: (m[i.user.login] ?? 0) + 1 }), {}),
}
return JSON.stringify(report, null, 2)`,
]
