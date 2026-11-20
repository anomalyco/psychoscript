#!/usr/bin/env bun
// Writes demo/fixtures.js from an opencode checkout's @opencode/widget: the served program (prelude + "\n" + source)
// of every built-in template, its mode, and example data, plus a few demo-only templates (fetch, a runaway loop, a
// full-screen layout switch). Usage: bun scripts/fixtures.ts [path/to/opencode/packages/widget]

import { readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const widget = path.resolve(process.argv[2] ?? path.join(root, "../../../oc-widgets/packages/widget"))
const src = path.join(widget, "src")
const prelude = await Bun.file(path.join(src, "prelude.js")).text()
const FIRST = ["suggestions", "form", "confirm", "chart", "backdrop", "minigame"]
const rank = (n: string) => (FIRST.includes(n) ? FIRST.indexOf(n) : FIRST.length)
const names = (await readdir(path.join(src, "templates")))
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.slice(0, -3))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
const diagrams: Record<string, unknown> = await import(path.join(widget, "test/fixtures/diagrams.ts"))
  .then((m) => m.examples as Record<string, unknown>)
  .catch(() => ({}))

const LIVE = new Set(["minigame"])

/** A placeholder photo: an SVG gradient with a caption, as a data URI. */
const photo = (label: string, a: string, b: string) =>
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><circle cx="470" cy="150" r="70" fill="#fff" fill-opacity=".25"/><path d="M0 380 L180 250 L320 360 L450 280 L640 400 L640 480 L0 480Z" fill="#000" fill-opacity=".2"/><text x="40" y="440" font-family="sans-serif" font-size="40" font-weight="600" fill="#fff">${label}</text></svg>`,
  )

const data: Record<string, unknown> = {
  suggestions: {
    title: "Which landing page direction should we build?",
    options: [
      { label: "Bold gradient", note: "Big hero, product shots below", images: [photo("Hero", "#7c3aed", "#db2777"), photo("Features", "#2563eb", "#7c3aed")], recommended: true },
      { label: "Minimal", note: "Text-first, one screenshot", images: [photo("Minimal", "#334155", "#64748b")] },
      { label: "Playful", images: [photo("Playful", "#f59e0b", "#ef4444"), photo("Mascot", "#10b981", "#06b6d4"), photo("Footer", "#0ea5e9", "#6366f1")] },
    ],
  },
  form: {
    title: "Deploy settings",
    description: "Pick how the **staging** deploy should run. You can change these later in `deploy.toml`.",
    submitLabel: "Deploy",
    fields: [
      { key: "name", type: "text", label: "Release name", placeholder: "v1.2.0" },
      { key: "replicas", type: "number", label: "Replicas", min: 1, max: 8, default: 2 },
      { key: "canary", type: "boolean", label: "Canary rollout", default: true },
      {
        key: "region",
        type: "select",
        label: "Region",
        options: [
          { value: "us-east", label: "US East" },
          { value: "eu-west", label: "EU West" },
          { value: "ap-south", label: "Asia Pacific" },
        ],
      },
      { key: "notes", type: "text", label: "Notes", multiline: true },
    ],
  },
  confirm: { title: "Delete the staging database?", message: "This drops **all tables** in `staging`. It can't be undone.", confirmLabel: "Delete", danger: true },
  chart: {
    title: "Build time by week",
    kind: "bar",
    unit: "s",
    choose: true,
    labels: ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"],
    series: [
      { label: "Linux", values: [312, 298, 305, 280, 266, 240, 236, 221] },
      { label: "macOS", values: [402, 395, 380, 371, 350, 344, 330, 318], color: "#f59e0b" },
    ],
  },
  backdrop: { title: "Release 2.0 is out", preset: "aurora", text: "Thanks to everyone who tested the **beta**. Drag the slider to change the speed." },
  minigame: { title: "Tap the dots", seconds: 15 },
  ...diagrams,
}

const DEMO = {
  "fetch-demo": {
    mode: "live",
    capabilities: { https: { hosts: ["api.github.com"] } },
    data: { title: "GitHub status" },
    source: `async function main(data) {
  const show = (lines, tone) => widget.render(ui.column({ gap: 2, fullscreen: false }, [
    ui.text(data.title, { style: "title" }),
    ...lines.map((l) => ui.text(l, { style: "code", tone })),
    ui.row({ gap: 1 }, [ui.button("again", "Fetch again", { variant: "primary" }), ui.button("local", "Try http://localhost"), ui.button("other", "Try example.com")]),
  ]))
  show(["press a button"])
  let url = "https://api.github.com/zen"
  while (true) {
    try {
      const r = await widget.fetch(url)
      show(["GET " + url, "status " + r.status, (await r.text()).slice(0, 120)], "success")
    } catch (e) {
      show(["GET " + url, e.kind + ": " + e.message], "error")
    }
    let ev = await widget.event()
    // Focus and key events (widgets-input.md) arrive too: wait for a press.
    while (ev.type !== "press") ev = await widget.event()
    url = ev.id === "local" ? "http://localhost/x" : ev.id === "other" ? "https://example.com/" : "https://api.github.com/zen"
  }
}`,
  },
  "local-demo": {
    mode: "live",
    localNetwork: true,
    capabilities: { https: { hosts: ["localhost:4173"] } },
    data: { title: "Local network (dev mode)" },
    source: `async function main(data) {
  const show = (lines, tone) => widget.render(ui.column({ gap: 1, fullscreen: false }, [
    ui.text(data.title, { style: "title" }),
    ...lines.map((l) => ui.text(l, { style: "code", tone })),
  ]))
  const url = "http://localhost:4173/demo/demo.css"
  try {
    const r = await widget.fetch(url)
    show(["GET " + url, "status " + r.status + ", " + (await r.text()).length + " bytes"], "success")
  } catch (e) {
    show(["GET " + url, e.kind + ": " + e.message], "error")
  }
  await widget.event()
}`,
  },
  "keys-demo": {
    mode: "step",
    data: { title: "Keyboard and mouse" },
    source: `function init() { return { capture: false, focus: false, captured: false, last: "-", keys: 0, moved: 0, buttons: 0, hover: 0 } }
function view(state, data) {
  return ui.column({ gap: 1, capture: state.capture ? "pointer" : undefined }, [
    ui.text(data.title, { style: "title" }),
    ui.canvas({ id: "pad", height: 110 }),
    ui.text("focus " + state.focus + " · captured " + state.captured, { style: "code" }),
    ui.text("last " + state.last + " · keys " + state.keys + " · moved " + state.moved + " · buttons " + state.buttons, { style: "code" }),
    ui.text("hover " + state.hover, { style: "code" }),
    ui.row({ gap: 1 }, [ui.button("capture", state.capture ? "Stop asking for the mouse" : "Ask for the mouse")]),
  ])
}
function update(state, event) {
  if (event.type === "focus") return { ...state, focus: event.value }
  if (event.type === "capture") return { ...state, captured: event.value }
  if (event.type === "key") return { ...state, last: event.value.kind + " " + event.value.key, keys: state.keys + 1 }
  if (event.type === "pointer" && event.value.kind === "move" && event.value.down === false) return { ...state, hover: state.hover + 1 }
  if (event.type === "pointer" && event.value.dx !== undefined) return { ...state, moved: state.moved + Math.abs(event.value.dx) + Math.abs(event.value.dy) }
  if (event.type === "pointer" && event.value.button !== undefined) return { ...state, buttons: state.buttons + 1 }
  if (event.id === "capture") return { ...state, capture: !state.capture }
  return state
}
function draw(state, data, frame) {
  const g = ui.draw()
  g.rrect(0, 0, frame.width, frame.height, 8, state.captured ? "accent" : "surface")
  const hint = state.captured ? "mouse captured: move it, Esc releases" : state.capture ? "click here to give it the mouse" : state.focus ? "type: keys go to the widget" : "click to focus"
  g.text(frame.width / 2, frame.height / 2 + 5, hint, { align: "center", color: state.captured ? "bg" : "muted" })
  return g
}`,
  },
  "keys-live": {
    mode: "live",
    data: { title: "Keys in a live widget" },
    source: `async function main(data) {
  const s = { focus: false, captured: false, last: "-", keys: 0, moved: 0 }
  while (true) {
    widget.render(ui.column({ gap: 1, fullscreen: false }, [
      ui.text(data.title, { style: "title" }),
      ui.canvas({ id: "pad", height: 70 }),
      ui.text("focus " + s.focus + " · captured " + s.captured + " · last " + s.last + " · keys " + s.keys + " · moved " + s.moved, { style: "code" }),
      ui.button("capture", "Capture the mouse"),
    ]))
    const g = ui.draw()
    g.rrect(0, 0, 2000, 70, 8, s.captured ? "accent" : "surface")
    widget.draw("pad", g)
    const e = await widget.event()
    if (e.id === "capture") widget.capturePointer ? widget.capturePointer() : __host.post({ type: "capture", value: true })
    if (e.type === "focus") s.focus = e.value
    if (e.type === "capture") s.captured = e.value
    if (e.type === "key") { s.last = e.value.kind + " " + e.value.key; s.keys++ }
    if (e.type === "pointer" && e.value.dx !== undefined) s.moved += Math.abs(e.value.dx) + Math.abs(e.value.dy)
  }
}`,
  },
  "clock-demo": {
    mode: "live",
    data: { title: "Running time" },
    source: `async function main(data) {
  let resumed = 0
  let paused = 0
  while (true) {
    widget.render(ui.column({ gap: 1 }, [
      ui.text(data.title, { style: "title" }),
      ui.text("running " + (widget.now() / 1000).toFixed(1) + " s", { style: "code" }),
      ui.text("resumed " + resumed + "x, paused " + paused + " ms in all", { style: "caption", tone: "muted" }),
    ]))
    const next = await widget.next({ timeout: 100 })
    if (next.type === "resumed") { resumed++; paused += next.pausedMs }
  }
}`,
  },
  "shader-demo": {
    mode: "live",
    data: { title: "Shader driven by a live program" },
    source: `const WGSL = \`fn shade(frag: vec2f) -> vec4f {
  let uv = frag / widget.resolution;
  let d = distance(uv, widget.values[0].yz);
  let glow = exp(-d * d * 40.0) * (0.6 + 0.6 * widget.values[0].w);
  let base = vec3f(0.08, 0.1, 0.16) + vec3f(0.2, 0.1, 0.4) * (0.5 + 0.5 * sin(widget.values[0].x * 2.0 + uv.x * 6.0));
  return vec4f(base + vec3f(0.3, 0.6, 1.0) * glow, 1.0);
}\`

async function main(data) {
  const s = { down: 0, move: 0, up: 0, hover: 0, x: 0.5, y: 0.5, pressed: 0, frames: 0 }
  while (true) {
    widget.render(ui.column({ gap: 1 }, [
      ui.text(data.title, { style: "title" }),
      ui.shader(WGSL, { id: "orb", height: 160, fps: 0, values: [widget.now() / 1000, s.x, s.y, s.pressed], alt: "A glowing orb that follows the pointer" }),
      ui.text("frames " + s.frames + " · down " + s.down + " · move " + s.move + " · up " + s.up + " · hover " + s.hover, { style: "caption", tone: "muted" }),
    ]))
    const next = await widget.next({ frame: true })
    if (next.type === "frame") s.frames++
    if (next.type === "event" && next.event.type === "pointer") {
      const v = next.event.value
      // Hover moves (no button held) light the orb dimly; drags count as moves.
      if (v.kind === "move" && v.down === false) s.hover++
      else s[v.kind]++
      s.x = v.x / v.width
      s.y = v.y / v.height
      s.pressed = v.kind === "up" ? 0 : 1
    }
  }
}`,
  },
  "runaway-demo": {
    mode: "live",
    data: { title: "A runaway loop" },
    source: `async function main(data) {
  widget.render(ui.column({ gap: 2 }, [ui.text(data.title, { style: "title" }), ui.text("Press to spin forever: the host stops it after 50 ms.", { tone: "muted" }), ui.button("spin", "Spin", { variant: "danger" })]))
  while ((await widget.event()).id !== "spin") {}
  let n = 0
  while (true) n++
}`,
  },
  "fullscreen-demo": {
    mode: "step",
    data: { title: "Pulse" },
    source: `function init() { return { full: false, taps: 0 } }
function view(state, data) {
  return ui.column({ gap: 2, fullscreen: true }, [
    ui.text(data.title + (state.full ? " (full screen)" : ""), { style: "title" }),
    !state.full && ui.text("Expand me: the canvas fills the screen and the text goes away.", { tone: "muted" }),
    ui.canvas({ id: "pulse", height: 140, fill: state.full, fps: 60 }),
    ui.text("taps: " + state.taps, { style: "caption" }),
  ])
}
function update(state, event) {
  if (event.type === "fullscreen") return { ...state, full: event.value }
  if (event.type === "pointer" && event.value.kind === "down") return { ...state, taps: state.taps + 1 }
  return state
}
function draw(state, data, frame) {
  const g = ui.draw()
  const r = Math.min(frame.width, frame.height) * (0.25 + 0.08 * Math.sin(frame.t * 3))
  g.rect(0, 0, frame.width, frame.height, "surface")
  g.circle(frame.width / 2, frame.height / 2, r, { fill: { radial: [frame.width / 2, frame.height / 2, r], stops: [[0, "accent"], [1, "#00000000"]] } })
  g.text(12, 22, frame.width + " x " + frame.height + (frame.fullscreen ? " full screen" : ""), { color: "muted", mono: true })
  if (frame.pointer) g.circle(frame.pointer.x, frame.pointer.y, frame.pointer.down ? 14 : 8, { stroke: "text", width: 2 })
  return g
}`,
  },
}

const fixtures: Record<string, { mode: string; source: string; data: unknown; capabilities?: unknown; localNetwork?: boolean }> = {}
for (const name of names) {
  if (data[name] === undefined) {
    console.warn(`no example data for ${name}: skipped`)
    continue
  }
  const source = await Bun.file(path.join(src, "templates", `${name}.js`)).text()
  fixtures[name] = { mode: LIVE.has(name) ? "live" : "step", source, data: data[name] }
}
for (const [name, t] of Object.entries(DEMO))
  fixtures[name] = {
    mode: t.mode,
    source: t.source,
    data: t.data,
    ...("capabilities" in t ? { capabilities: t.capabilities } : {}),
    ...("localNetwork" in t ? { localNetwork: t.localNetwork } : {}),
  }

const out = path.join(root, "demo/fixtures.js")
await Bun.write(
  out,
  `// Generated by scripts/fixtures.ts from ${path.relative(root, widget)}. Do not edit.\n// The served program of each is prelude + "\\n" + source.\nexport const prelude = ${JSON.stringify(prelude)}\nexport const fixtures = ${JSON.stringify(fixtures, null, 1)}\n`,
)
console.log(`${Object.keys(fixtures).length} fixtures -> ${path.relative(process.cwd(), out)}`)
