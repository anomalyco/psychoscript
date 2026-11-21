// Launch control: a release-day mission control on one responsive canvas. A header with a live clock and T+ counter,
// four KPI tiles with rolling numbers and sparklines (a row of 4 on wide cards, 2×2 on phones), a streaming area chart
// that scrolls in real time, a gauge cluster and an event ticker. Tap a tile to focus its series in the chart; hover
// or drag the chart to read values. Everything is simulated: a launch-day story with a traffic surge, a brief latency
// spike, an autoscale and recovery, a staged rollout reaching 100%, and signups climbing.
//
// Posts: one canvas, so each displayed frame is one frame request plus one draw. Frames are paced to every vsync on
// displays up to ~100 Hz and to every 2nd/3rd vsync above that (≤ 100 frames, ≤ ~200 posts a second): the program
// measures the display's frame period and, when it must skip vsyncs, asks for the next frame just after the last
// skipped one, so timer jitter can't make it miss its vsync. It renders only when the layout class (phone/desktop)
// changes; in full screen the canvas fills the screen (`fill`) and the layout follows `frame.height`.

const SAMPLE_MS = 500
const WINDOW_S = 60
const HISTORY = 150
const MIN_FRAME_MS = 10
const PROBE_MS = 1500
const INTRO_MS = 1300
const PHONE = 640

const KPIS = [
  { id: "rps", label: "REQUESTS", tiny: "REQS", short: "Requests / s", unit: "rps", color: "#22d3ee", light: "#0891b2", up: true },
  { id: "p95", label: "P95 LATENCY", tiny: "P95", short: "p95 latency", unit: "ms", color: "#a78bfa", light: "#7c3aed", up: false },
  { id: "err", label: "ERROR RATE", tiny: "ERRORS", short: "Error rate", unit: "%", color: "#fbbf24", light: "#d97706", up: false },
  { id: "sig", label: "SIGNUPS", tiny: "SIGNUPS", short: "Signups", unit: "total", color: "#34d399", light: "#059669", up: true },
]

const TAGS = {
  DEPLOY: { dark: "#22d3ee", light: "#0891b2" },
  ALERT: { dark: "#fb7185", light: "#e11d48" },
  RESOLVED: { dark: "#34d399", light: "#059669" },
  SCALE: { dark: "#fbbf24", light: "#d97706" },
  SIGNUP: { dark: "#a78bfa", light: "#7c3aed" },
  TRAFFIC: { dark: "#38bdf8", light: "#0284c7" },
  INFO: { dark: "#94a3b8", light: "#64748b" },
  RELEASE: { dark: "#34d399", light: "#059669" },
}

const STORY = [
  { at: 2.2, tag: "SIGNUP", text: "New team signup from Lisbon" },
  { at: 4.5, tag: "DEPLOY", text: "eu-west-1 at 75%", region: 1, pct: 75 },
  { at: 8.5, tag: "TRAFFIC", text: "Launch post trending · traffic +40%" },
  { at: 11, tag: "DEPLOY", text: "ap-south-1 at 50%", region: 2, pct: 50 },
  { at: 15.5, tag: "ALERT", text: "p95 > 400 ms on api-gateway" },
  { at: 17.5, tag: "DEPLOY", text: "Rollout paused by guardrail" },
  { at: 20.5, tag: "SCALE", text: "api-gateway 12 → 20 pods" },
  { at: 27.5, tag: "RESOLVED", text: "p95 back under 150 ms" },
  { at: 31, tag: "DEPLOY", text: "Rollout resumed" },
  { at: 36, tag: "DEPLOY", text: "eu-west-1 at 100%", region: 1, pct: 100 },
  { at: 44, tag: "DEPLOY", text: "ap-south-1 at 100%", region: 2, pct: 100 },
  { at: 52, tag: "DEPLOY", text: "sa-east-1 at 100%", region: 3, pct: 100 },
  { at: 58, tag: "RELEASE", text: "Live in all regions" },
]

const PAST = [
  { ago: 312, tag: "DEPLOY", text: "us-east-1 at 100%" },
  { ago: 186, tag: "SIGNUP", text: "Signup from Toronto" },
  { ago: 95, tag: "DEPLOY", text: "eu-west-1 at 50%" },
  { ago: 41, tag: "INFO", text: "CDN cache warmed · 97% hit" },
  { ago: 12, tag: "SIGNUP", text: "Signup from Osaka" },
]

const CITIES = ["Lisbon", "Osaka", "Berlin", "São Paulo", "Austin", "Nairobi", "Seoul", "Dublin", "Toronto", "Lyon", "Bangalore", "Melbourne", "Oslo", "Mexico City", "Warsaw", "Cape Town"]
const FILLERS = [
  { tag: "INFO", text: "Webhook queue drained" },
  { tag: "INFO", text: "CDN cache hit ratio 97%" },
  { tag: "TRAFFIC", text: "Peak: new record for rps" },
  { tag: "SCALE", text: "worker pool 8 → 10" },
  { tag: "INFO", text: "Status page: all green" },
]

const DARK = {
  bg: "#05080f",
  panel: "#0a1020",
  panelTop: "#0d1528",
  border: "#18233b",
  borderHi: "#24324f",
  grid: "#141e33",
  gridA: "#8ba0c71c",
  text: "#e8eef9",
  muted: "#7b88a5",
  dim: "#46536f",
  track: "#151f36",
  glowA: "#22d3ee14",
  glowB: "#a78bfa12",
  live: "#fb7185",
  tip: "#0e1730",
}
const LIGHT = {
  bg: "#f4f7fb",
  panel: "#ffffff",
  panelTop: "#fbfcfe",
  border: "#e2e8f0",
  borderHi: "#cbd5e1",
  grid: "#eef2f7",
  gridA: "#33415514",
  text: "#0f172a",
  muted: "#64748b",
  dim: "#94a3b8",
  track: "#e8edf4",
  glowA: "#22d3ee10",
  glowB: "#a78bfa10",
  live: "#e11d48",
  tip: "#ffffff",
}

async function main(data) {
  const title = String((data && data.title) || "Launch control")
  const release = String((data && data.release) || "v2.4.0")
  let sim = null
  const ui_ = { focus: 0, hover: null, hoverAt: -1e9, down: false, tileHover: -1, tileHoverAt: -1e9, flash: [0, 0, 0, 0] }
  const view = { height: 0, phone: null, width: 0, full: false }
  const shown = { kpi: [0, 0, 0, 0], gauge: [0, 0, 0], lo: null, hi: null, focusAt: -1e9, ticker: [] }
  let box = null

  const onPointer = (p) => {
    const now = widget.now()
    // Hit-test the layout last drawn (in full screen it follows the grown canvas, not `view.height`).
    const b = box || layout(p.width || view.width || 760, view.layoutHeight, view.full)
    if (p.kind === "down") {
      const tile = b.tiles.findIndex((r) => inside(r, p.x, p.y))
      if (tile >= 0) {
        ui_.focus = tile === ui_.focus ? (tile + 1) % 4 : tile
        ui_.focusAt = now
        shown.focusAt = now
        ui_.flash[tile] = now
        shown.lo = null
        return
      }
      if (inside(b.plot, p.x, p.y, 8)) {
        ui_.down = true
        ui_.hover = { x: clamp(p.x, b.plot.x, b.plot.x + b.plot.w), y: p.y }
        ui_.hoverAt = now
      }
      return
    }
    if (p.kind === "up") {
      if (ui_.down) ui_.hoverAt = now - 1000
      ui_.down = false
      return
    }
    // move: a hover (desktop, no button) or a drag
    ui_.tileHover = b.tiles.findIndex((r) => inside(r, p.x, p.y))
    ui_.tileHoverAt = now
    if (ui_.down || inside(b.plot, p.x, p.y, 4)) {
      ui_.hover = { x: clamp(p.x, b.plot.x, b.plot.x + b.plot.w), y: p.y }
      ui_.hoverAt = now
    } else if (!ui_.down) ui_.hoverAt = Math.min(ui_.hoverAt, now - 2000)
  }

  const show = () =>
    widget.render(
      ui.column({ gap: 0, align: "stretch" }, [
        ui.canvas({
          key: "board",
          height: view.height,
          fill: true,
          alt:
            title +
            " · " +
            release +
            ": live release dashboard with requests/s, p95 latency, error rate and signups, a streaming chart, rollout, apdex and CPU gauges and an event ticker",
          onPointer,
        }),
      ]),
    )

  view.height = baseHeight(760)
  view.layoutHeight = view.height
  show()
  let frameAt = -1e9
  let last = widget.now()
  const start = last
  // Frame pacing: `period` is the display's frame time (the least of the recent intervals measured between frames
  // asked for straight after the previous one); above ~100 Hz the loop skips vsyncs, waking just after the last
  // skipped one, and re-measures with one straight request every PROBE_MS.
  const pace = { period: 0, samples: [], probeAt: 0, seen: false, prevT: NaN, prevAt: 0 }
  while (true) {
    const stride = pace.period > 0 ? Math.max(1, Math.ceil(MIN_FRAME_MS / pace.period - 0.05)) : 1
    const probe = stride > 1 && widget.now() >= pace.probeAt
    let straight = true
    if (stride > 1 && !probe) {
      const wait = frameAt + (stride - 1) * pace.period + 1 - widget.now()
      if (wait > 0) {
        straight = false
        await widget.sleep(wait)
      }
    }
    if (probe) pace.probeAt = widget.now() + PROBE_MS
    const frame = await widget.frame()
    frameAt = widget.now()
    measure(pace, frame, frameAt, straight)
    const width = Math.max(240, Number(frame && frame.width) || 760)
    const full = !!(frame && frame.fullscreen)
    const base = baseHeight(width)
    view.width = width
    view.full = full
    // In full screen the client grows the canvas (`fill`; `height` is its least) and says how tall it is.
    view.layoutHeight = full ? Math.max(base, Math.floor(Number(frame.height) || base)) : base
    if (base !== view.height) {
      view.height = base
      show()
    }
    // The simulation (and its minute of history) is built after the first await, keeping the first slice short.
    if (!sim) sim = makeSim()
    const now = widget.now()
    const dt = clamp((now - last) / 1000, 0, 0.1)
    last = now
    sim.advance(now)
    box = layout(width, view.layoutHeight, full, full && frame ? frame.close : null)
    const dark = !(frame && frame.dark === false)
    widget.draw("board", paint(box, sim, ui_, shown, now, now - start, dt, dark, title, release))
  }
}

// One frame interval, when the frame was asked for straight after the previous one (from the frames' own `t`, in
// seconds, else from arrival times).
function measure(pace, frame, at, straight) {
  const t = Number(frame && frame.t) * 1000
  if (straight && pace.seen) {
    const byT = t - pace.prevT
    const interval = byT > 2 && byT < 100 ? byT : at - pace.prevAt
    if (interval > 2 && interval < 100) {
      pace.samples.push(interval)
      if (pace.samples.length > 6) pace.samples.shift()
      let least = pace.samples[0]
      for (const s of pace.samples) least = Math.min(least, s)
      pace.period = least
    }
  }
  pace.seen = true
  pace.prevT = t
  pace.prevAt = at
}

// ---------- layout ----------

function baseHeight(width) {
  return width < PHONE ? 778 : 648
}

// `close`: in full screen, the close button's area in canvas coordinates when it overlaps the canvas
// (widgets-fullscreen.md), else null. Only the header reaches that high; it ends 12 px left of the area.
function layout(W, H, full, close) {
  const phone = W < PHONE
  const pad = phone ? 10 : W >= 720 ? 16 : 12
  const gap = phone ? 8 : 12
  const inner = W - pad * 2
  const header = { x: pad, y: pad, w: inner, h: phone ? 50 : 48 }
  if (close && close.y < header.y + header.h && close.x < header.x + header.w)
    header.w = Math.max(120, Math.min(header.w, close.x - 12 - header.x))
  let y = header.y + header.h + (phone ? 8 : 10)
  const tiles = []
  if (phone) {
    const tw = (inner - gap) / 2
    const th = 86
    for (let i = 0; i < 4; i++) tiles.push({ x: pad + (i % 2) * (tw + gap), y: y + Math.floor(i / 2) * (th + gap), w: tw, h: th })
    y += th * 2 + gap * 2
  } else {
    const tw = (inner - gap * 3) / 4
    for (let i = 0; i < 4; i++) tiles.push({ x: pad + i * (tw + gap), y, w: tw, h: 100 })
    y += 100 + gap
  }
  const base = baseHeight(W)
  const extra = Math.max(0, H - base)
  const chart = { x: pad, y, w: inner, h: (phone ? 206 : 238) + extra }
  y += chart.h + gap
  let gauges, ticker
  if (phone) {
    gauges = { x: pad, y, w: inner, h: 146 }
    y += gauges.h + gap
    ticker = { x: pad, y, w: inner, h: H - pad - y }
  } else {
    const gw = Math.round((inner - gap) * 0.5)
    gauges = { x: pad, y, w: gw, h: H - pad - y }
    ticker = { x: pad + gw + gap, y, w: inner - gw - gap, h: H - pad - y }
  }
  const left = phone ? 40 : 48
  const plot = { x: chart.x + left, y: chart.y + 46, w: chart.w - left - 14, h: chart.h - 46 - 28 }
  return { W, H, phone, pad, gap, header, tiles, chart, plot, gauges, ticker, full }
}

function inside(r, x, y, slack) {
  const s = slack || 0
  return x >= r.x - s && x <= r.x + r.w + s && y >= r.y - s && y <= r.y + r.h + s
}

// ---------- simulation ----------

function makeSim() {
  const sim = {
    series: [[], [], [], []],
    times: [],
    head: 0,
    t: -HISTORY * SAMPLE_MS,
    walk: { rps: 0, p95: 0, err: 0, cpu: 0 },
    signups: 18240,
    rollout: [100, 50, 25, 10],
    paused: false,
    events: [],
    story: 0,
    nextFiller: 3.5,
    nextCity: 5,
    cpu: 41,
    apdex: 0.97,
    pods: 12,
  }
  PAST.forEach((item) => push(sim, { at: -item.ago * 1000, tag: item.tag, text: item.text, past: true }))
  for (let i = 0; i <= HISTORY; i++) step(sim)
  sim.advance = (now) => {
    let guard = 0
    while (sim.t <= now + SAMPLE_MS && guard++ < 400) step(sim)
    sim.now = now
    storyTick(sim, now / 1000)
  }
  return sim
}

function bump(s, a, peak, b) {
  if (s <= a || s >= b) return 0
  const u = s < peak ? (s - a) / (peak - a) : 1 - (s - peak) / (b - peak)
  return u * u * (3 - 2 * u)
}

function incident(s) {
  // The story incident at 14-30 s, then milder ones every 90 s.
  if (s < 60) return { lat: bump(s, 13.5, 19, 29), err: bump(s, 14.5, 19.5, 27), surge: bump(s, 7, 16, 34), amp: 1 }
  const k = Math.floor((s - 60) / 90)
  const local = s - 60 - k * 90
  return { lat: 0.55 * bump(local, 40, 45, 53), err: 0.5 * bump(local, 41, 45.5, 51), surge: 0.6 * bump(local, 34, 42, 58), amp: 0.6 }
}

function ou(x, theta, sigma) {
  return x - theta * x + sigma * (Math.random() * 2 - 1 + (Math.random() * 2 - 1)) * 0.7
}

function step(sim) {
  const s = sim.t / 1000
  const w = sim.walk
  w.rps = ou(w.rps, 0.08, 0.035)
  w.p95 = ou(w.p95, 0.12, 0.035)
  w.err = ou(w.err, 0.12, 0.06)
  w.cpu = ou(w.cpu, 0.1, 0.03)
  const inc = incident(s)
  const ramp = 0.5 + 0.5 * Math.tanh((s + 10) / 80)
  const rps = Math.max(200, (2500 + 1700 * ramp) * (1 + w.rps + 0.42 * inc.surge + 0.03 * Math.sin(s / 3.7)))
  const scaled = s > 20.5 && s < 60 ? 1 : 0
  const p95 = Math.max(60, (112 + 10 * Math.sin(s / 5.3)) * (1 + w.p95) + 380 * inc.lat * (1 + 0.25 * Math.random()))
  const err = Math.max(0.03, 0.16 * (1 + w.err) + 1.85 * inc.err * (1 + 0.3 * Math.random()))
  const conv = 0.0019 * (1 - 0.5 * inc.err)
  sim.signups += Math.max(0, Math.round(rps * conv * (SAMPLE_MS / 1000) * (0.4 + Math.random() * 1.2)))
  sim.cpu = clamp(36 + (rps / 6000) * 34 + 22 * inc.lat - 6 * scaled + 100 * w.cpu, 8, 97)
  sim.apdex = clamp(0.985 - Math.max(0, p95 - 110) / 1000 - err / 30, 0.4, 0.995)
  const values = [rps, p95, err, sim.signups]
  for (let i = 0; i < 4; i++) {
    sim.series[i].push(values[i])
    if (sim.series[i].length > HISTORY + 4) sim.series[i].shift()
  }
  sim.times.push(sim.t)
  if (sim.times.length > HISTORY + 4) sim.times.shift()
  sim.t += SAMPLE_MS
}

// The value of series i at time ms, interpolated between samples.
function valueAt(sim, i, ms) {
  const times = sim.times
  const first = times[0]
  const f = (ms - first) / SAMPLE_MS
  const k = Math.floor(f)
  const list = sim.series[i]
  if (k < 0) return list[0]
  if (k >= list.length - 1) return list[list.length - 1]
  const u = f - k
  return list[k] + (list[k + 1] - list[k]) * u
}

function storyTick(sim, s) {
  while (sim.story < STORY.length && STORY[sim.story].at <= s) {
    const item = STORY[sim.story++]
    if (item.region !== undefined) sim.rollout[item.region] = item.pct
    if (item.tag === "DEPLOY" && item.text.indexOf("paused") >= 0) sim.paused = true
    if (item.text.indexOf("resumed") >= 0) sim.paused = false
    if (item.tag === "SCALE") sim.pods = 20
    if (item.at > 55 && item.tag === "RELEASE") sim.rollout = [100, 100, 100, 100]
    push(sim, { at: item.at * 1000, tag: item.tag, text: item.text })
  }
  if (s >= sim.nextCity) {
    const city = CITIES[Math.floor(Math.random() * CITIES.length)]
    const plan = Math.random() < 0.3 ? "Team plan · " : ""
    push(sim, { at: s * 1000, tag: "SIGNUP", text: plan + "Signup from " + city })
    sim.nextCity = s + 2.6 + Math.random() * 3.2
  }
  if (s >= 60) {
    const local = (s - 60) % 90
    const k = Math.floor((s - 60) / 90)
    if (local >= 42 && sim.alerted !== k) {
      sim.alerted = k
      push(sim, { at: s * 1000, tag: "ALERT", text: "p95 > 300 ms on checkout" })
    }
    if (local >= 52 && sim.resolved !== k) {
      sim.resolved = k
      push(sim, { at: s * 1000, tag: "RESOLVED", text: "checkout latency recovered" })
    }
    if (s >= sim.nextFiller) {
      const item = FILLERS[Math.floor(Math.random() * FILLERS.length)]
      push(sim, { at: s * 1000, tag: item.tag, text: item.text })
      sim.nextFiller = s + 9 + Math.random() * 8
    }
  }
}

function push(sim, event) {
  sim.events.unshift(event)
  if (sim.events.length > 14) sim.events.pop()
}

// ---------- painting ----------

function paint(b, sim, ui_, shown, now, age, dt, dark, title, release) {
  const g = ui.draw()
  const C = dark ? DARK : LIGHT
  const intro = clamp(age / INTRO_MS, 0, 1)
  const k = 1 - Math.exp(-dt * 7)

  // Backdrop: near-black blue with two soft colour glows.
  g.rrect(0, 0, b.W, b.H, 14, C.bg)
  if (dark) {
    g.circle(b.W * 0.12, 0, b.W * 0.55, { fill: { radial: [b.W * 0.12, 0, b.W * 0.55], stops: [[0, C.glowA], [1, "#22d3ee00"]] } })
    g.circle(b.W * 0.9, b.H, b.W * 0.6, { fill: { radial: [b.W * 0.9, b.H, b.W * 0.6], stops: [[0, C.glowB], [1, "#a78bfa00"]] } })
  }

  const wall = wallNow(now)
  if (shown.launch === undefined) shown.launch = wall.utc - (42 * 60 + 13) * 1000
  header(g, b, C, now, age, wall, Math.floor((wall.utc - shown.launch) / 1000), title, release)

  // Rolling KPI values: ease toward the live head value (counted up from 0 during the intro).
  const head = sim.now
  const live = [0, 1, 2, 3].map((i) => valueAt(sim, i, head))
  const prev = [0, 1, 2, 3].map((i) => valueAt(sim, i, head - WINDOW_S * 1000))
  const ramp = ease(clamp((age - 150) / 1000, 0, 1))
  for (let i = 0; i < 4; i++) {
    const target = live[i] * ramp
    shown.kpi[i] = intro < 1 ? target : shown.kpi[i] + (target - shown.kpi[i]) * Math.min(1, k * 1.6)
  }
  for (let i = 0; i < 4; i++) tile(g, b, C, dark, sim, ui_, shown, i, live[i], prev[i], now, age)

  chart(g, b, C, dark, sim, ui_, shown, now, age, k, wall)
  gauges(g, b, C, dark, sim, shown, age, k)
  ticker(g, b, C, dark, sim, shown, now, age, k)
  return g
}

// Alpha is never nested: clients disagree on whether `alpha` multiplies the current alpha (Android) or replaces it
// (Rune, iOS). Every `alpha` sits in its own save/restore with nothing fading around it, so all clients agree.
// A panel's state: its intro fade and slide, opened with `save` (closed by the caller's `restore`).
function reopen(g, a) {
  g.save()
  if (a < 1) {
    g.alpha(a)
    g.translate(0, (1 - a) * 10)
  }
}

// Draws `draw` at opacity `alpha` (absolute) inside a panel opened with `appear`: closes the panel's state, draws in a
// save of its own with the panel's slide, then reopens the panel's state.
function faded(g, appear, alpha, draw) {
  const a = ease(appear)
  g.restore()
  g.save()
  if (a < 1) g.translate(0, (1 - a) * 10)
  g.alpha(alpha)
  draw()
  g.restore()
  reopen(g, a)
}

function panel(g, r, C, dark, accent, appear) {
  const a = ease(appear)
  if (a <= 0) return false
  reopen(g, a)
  g.rrect(r.x, r.y, r.w, r.h, 12, { fill: { linear: [0, r.y, 0, r.y + r.h], stops: [[0, C.panelTop], [1, C.panel]] } })
  g.rrect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 11.5, { stroke: accent || C.border, width: 1 })
  return true
}

function header(g, b, C, now, age, wall, elapsed, title, release) {
  const h = b.header
  const a = ease(clamp(age / 500, 0, 1))
  g.save().alpha(a)
  const pulse = (now % 1600) / 1600
  const cx = h.x + 8
  const cy = h.y + 15
  g.circle(cx, cy, 4 + pulse * 9, { fill: C.live + hex(0.45 * (1 - pulse)) })
  g.circle(cx, cy, 8, { fill: { radial: [cx, cy, 8], stops: [[0, C.live + "66"], [1, C.live + "00"]] } })
  g.circle(cx, cy, 4, C.live)
  g.text(cx + 12, cy + 4, "LIVE", { size: 10, weight: 700, color: C.live, mono: true })
  const titleSize = b.phone ? 17 : 19
  const clockW = b.phone ? 96 : 132
  const max = Math.floor((h.w - clockW - 70) / (titleSize * 0.56))
  g.text(cx + 52, cy + 6, clip(title, max), { size: titleSize, weight: 700, color: C.text })
  const line = release + "  ·  T+" + hms(elapsed) + (b.phone ? "" : "  ·  4 regions  ·  api, web, workers")
  const zone = wall.zone + (b.phone && wall.zone.length > 5 ? "" : "  ·  release day")
  const zoneW = zone.length * 10.5 * 0.6
  g.text(h.x, h.y + h.h - 6, clip(line, Math.floor((h.w - zoneW - 14) / (11.5 * 0.6))), { size: 11.5, color: C.muted, mono: true })
  g.text(h.x + h.w, h.y + (b.phone ? 22 : 24), dayClock(wall.local), { size: b.phone ? 20 : 26, weight: 600, align: "right", mono: true, color: C.text })
  g.text(h.x + h.w, h.y + h.h - 6, zone, { size: 10.5, align: "right", color: C.dim, mono: true })
  g.restore()
}

function tile(g, b, C, dark, sim, ui_, shown, i, live, prev, now, age) {
  const r = b.tiles[i]
  const kpi = KPIS[i]
  const color = dark ? kpi.color : kpi.light
  const focused = ui_.focus === i
  const appear = clamp((age - 60 - i * 70) / 520, 0, 1)
  const hovered = ui_.tileHover === i && now - ui_.tileHoverAt < 2500
  const accent = focused ? color + "aa" : hovered ? C.borderHi : null
  if (!panel(g, r, C, dark, accent, appear)) return
  if (focused) {
    g.rrect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, 14, { stroke: color + "30", width: 3 })
    g.rrect(r.x + 1, r.y + 1, r.w - 2, r.h * 0.6, 11, { fill: { linear: [0, r.y, 0, r.y + r.h * 0.6], stops: [[0, color + "1c"], [1, color + "00"]] } })
  }
  const flash = clamp(1 - (now - ui_.flash[i]) / 450, 0, 1)
  if (flash > 0) g.rrect(r.x, r.y, r.w, r.h, 12, { fill: color + hex(0.18 * flash) })
  // accent bar
  g.rrect(r.x + 12, r.y + 10, 14, 3, 1.5, color)
  const ph = b.phone
  // value
  const v = shown.kpi[i]
  const text = fmt(i, v)
  const size = ph ? 22 : r.w > 190 ? 28 : 25
  const vy = r.y + (ph ? 44 : 50)
  g.text(r.x + 12, vy, text, { size, weight: 600, color: C.text, mono: true })
  const unitX = r.x + 12 + text.length * size * 0.6 + 4
  if (unitX + kpi.unit.length * 11 * 0.6 <= r.x + r.w - 8) g.text(unitX, vy, kpi.unit, { size: 11, color: C.muted, mono: true })
  // delta vs a minute ago
  // Signups: new ones; error rate: percentage points (a relative change of a rate reads as "▲ 1042%"); else percent.
  const change = i === 3 || i === 2 ? live - prev : prev > 0 ? ((live - prev) / prev) * 100 : 0
  const good = kpi.up ? change >= 0 : change <= 0
  const mag = Math.abs(change)
  const amount = i === 3 ? "+" + group(Math.round(mag)) : i === 2 ? mag.toFixed(2) + "pp" : mag.toFixed(mag >= 99.5 ? 0 : 1) + "%"
  // A change that rounds to nothing is neutral: no arrow, muted.
  const flat = !/[1-9]/.test(amount)
  const tone = flat ? C.muted : good ? (dark ? "#34d399" : "#059669") : dark ? "#fb7185" : "#e11d48"
  const dtext = flat ? amount.replace("+", "") : (change >= 0 ? "▲ " : "▼ ") + amount
  const dw = dtext.length * 5.8 + 12
  const labelSize = ph ? 9.5 : 10
  // The label ends 6 px before the delta pill, else its short form.
  const label = 32 + kpi.label.length * labelSize * 0.6 + 6 <= r.w - dw - 10 ? kpi.label : kpi.tiny
  g.text(r.x + 32, r.y + 15, label, { size: labelSize, weight: 600, color: focused ? C.text : C.muted, mono: true })
  const appearDelta = clamp((age - 700 - i * 60) / 300, 0, 1)
  if (appearDelta > 0)
    faded(g, appear, appearDelta, () => {
      g.rrect(r.x + r.w - dw - 10, r.y + 6, dw, 17, 8.5, { fill: tone + "1f" })
      g.text(r.x + r.w - 10 - dw / 2, r.y + 18, dtext, { size: 10, weight: 600, align: "center", color: tone })
    })
  // sparkline: the last minute
  const sx = r.x + 12
  const sw = r.w - 24
  const top = r.y + (ph ? 54 : 62)
  const bottom = r.y + r.h - 10
  const n = 40
  const head = sim.now
  const vals = []
  let lo = 1e18
  let hi = -1e18
  for (let j = 0; j <= n; j++) {
    const val = valueAt(sim, i, head - WINDOW_S * 1000 + (j / n) * WINDOW_S * 1000)
    vals.push(val)
    lo = Math.min(lo, val)
    hi = Math.max(hi, val)
  }
  const span = hi - lo || 1
  const reveal = ease(clamp((age - 200 - i * 70) / 900, 0, 1))
  const count = Math.max(1, Math.round(n * reveal))
  const pts = []
  for (let j = 0; j <= count; j++) pts.push([sx + (j / n) * sw, bottom - ((vals[j] - lo) / span) * (bottom - top)])
  const line = pts.map((p, j) => [j === 0 ? "M" : "L", p[0], p[1]])
  const fill = line.concat([["L", pts[pts.length - 1][0], bottom], ["L", sx, bottom], ["Z"]])
  // Three stops: a client that fills a path with its gradient's middle stop (Rune) still shows a tint.
  g.path(fill, { fill: { linear: [0, top, 0, bottom], stops: [[0, color + (focused ? "40" : "26")], [0.5, color + (focused ? "1e" : "12")], [1, color + "00"]] } })
  g.path(line, { stroke: color, width: focused ? 1.8 : 1.4 })
  const end = pts[pts.length - 1]
  g.circle(end[0], end[1], 5, { fill: { radial: [end[0], end[1], 5], stops: [[0, color + "88"], [1, color + "00"]] } })
  g.circle(end[0], end[1], 2, color)
  g.restore()
}

function chart(g, b, C, dark, sim, ui_, shown, now, age, k, wall) {
  const r = b.chart
  const p = b.plot
  const i = ui_.focus
  const kpi = KPIS[i]
  const color = dark ? kpi.color : kpi.light
  const appear = clamp((age - 180) / 520, 0, 1)
  if (!panel(g, r, C, dark, null, appear)) return
  const head = sim.now
  const span = WINDOW_S * 1000
  // Visible samples, plus the interpolated head.
  const times = sim.times
  const list = sim.series[i]
  const pts = []
  const x0 = head - span
  let lo = 1e18
  let hi = -1e18
  for (let j = 0; j < times.length; j++) {
    const t = times[j]
    if (t < x0 - SAMPLE_MS) continue
    if (t >= head) break
    pts.push([t, list[j]])
  }
  pts.push([head, valueAt(sim, i, head)])
  for (const q of pts) {
    lo = Math.min(lo, q[1])
    hi = Math.max(hi, q[1])
  }
  // A smoothed, padded y range (snaps on a focus change).
  const padv = (hi - lo) * 0.18 + (i === 2 ? 0.05 : i === 3 ? 4 : 5)
  let tlo = Math.max(0, lo - padv)
  let thi = hi + padv
  if (i === 1) thi = Math.max(thi, 320)
  if (i === 2) thi = Math.max(thi, 1.2)
  if (shown.lo === null) {
    shown.lo = tlo
    shown.hi = thi
  } else {
    shown.lo += (tlo - shown.lo) * k
    shown.hi += (thi - shown.hi) * k
  }
  const ylo = shown.lo
  const yhi = shown.hi
  const X = (t) => p.x + ((t - x0) / span) * p.w
  const Y = (v) => p.y + p.h - ((v - ylo) / (yhi - ylo || 1)) * p.h

  // Title row (dimmed for a moment after a focus change; no alpha otherwise, so it never nests in the panel's fade).
  const fa = clamp((now - shown.focusAt) / 350, 0, 1)
  g.circle(r.x + 18, r.y + 22, 4, color)
  g.circle(r.x + 18, r.y + 22, 9, { fill: { radial: [r.x + 18, r.y + 22, 9], stops: [[0, color + "55"], [1, color + "00"]] } })
  const title = () => {
    g.text(r.x + 30, r.y + 26, kpi.short, { size: 14, weight: 700, color: C.text })
    g.text(r.x + 30 + kpi.short.length * 7.9 + 8, r.y + 26, b.phone ? "60 s" : "last 60 s · " + kpi.unit, { size: 11, color: C.muted, mono: true })
  }
  if (fa < 1) faded(g, appear, 0.35 + 0.65 * fa, title)
  else title()
  const headVal = valueAt(sim, i, head)
  g.text(r.x + r.w - 14, r.y + 26, fmt(i, shown.kpi[i]) + " " + kpi.unit, { size: 13, weight: 600, align: "right", color, mono: true })
  if (!b.phone) g.text(r.x + r.w - 14 - (fmt(i, shown.kpi[i]).length + kpi.unit.length + 1) * 7.8 - 12, r.y + 26, "tap a KPI to focus", { size: 10.5, align: "right", color: C.dim })

  // The line, drawn in from the left during the intro.
  const reveal = ease(clamp((age - 280) / 1000, 0, 1))
  const limit = p.x + p.w * reveal
  const line = []
  let lastPt = null
  for (let j = 0; j < pts.length; j++) {
    let xx = X(pts[j][0])
    let yy = Y(pts[j][1])
    if (xx < p.x) {
      const nx = pts[j + 1]
      if (!nx) continue
      const x2 = X(nx[0])
      if (x2 <= p.x) continue
      const u = (p.x - xx) / (x2 - xx)
      yy = yy + (Y(nx[1]) - yy) * u
      xx = p.x
    }
    if (xx > limit) {
      if (lastPt) {
        const u = (limit - lastPt[0]) / (xx - lastPt[0] || 1)
        line.push(["L", limit, lastPt[1] + (yy - lastPt[1]) * u])
        lastPt = [limit, lastPt[1] + (yy - lastPt[1]) * u]
      }
      break
    }
    line.push([line.length === 0 ? "M" : "L", xx, yy])
    lastPt = [xx, yy]
  }
  const bottom = p.y + p.h
  // The area: a gradient fill, then a box fading to the panel colour toward the bottom. Clients that fill a path
  // with one colour (Rune paints a path's gradient as its middle stop) still get the fade from the box; the others
  // get the same look as before. Grid, markers and the line go on top.
  if (line.length > 1) {
    const fill = line.concat([["L", lastPt[0], bottom], ["L", line[0][1], bottom], ["Z"]])
    g.path(fill, { fill: { linear: [0, p.y, 0, bottom], stops: [[0, color + "70"], [0.5, color + "42"], [1, color + "14"]] } })
    g.rect(p.x - 1, p.y, p.w + 2, p.h + 1, { fill: { linear: [0, p.y, 0, bottom], stops: [[0, C.panel + "00"], [0.35, C.panel + "40"], [1, C.panel + "f2"]] } })
  }

  // Horizontal gridlines with labels.
  const ticks = niceTicks(ylo, yhi, b.phone ? 3 : 4)
  for (const tv of ticks) {
    const yy = Y(tv)
    if (yy < p.y - 1 || yy > p.y + p.h + 1) continue
    g.line(p.x, yy, p.x + p.w, yy, { stroke: C.gridA, width: 1 })
    g.text(p.x - 8, yy + 3.5, axis(i, tv), { size: 10, align: "right", color: C.dim, mono: true })
  }
  // Vertical time grid every 15 s of (local) wall time, scrolling with the data.
  const step15 = 15000
  const lastTick = Math.floor(wall.local / step15) * step15
  for (let q = 0; q < 6; q++) {
    const tw = lastTick - q * step15
    const t = head - (wall.local - tw)
    const xx = X(t)
    if (xx < p.x + 18 || xx > p.x + p.w - 18) continue
    g.line(xx, p.y, xx, p.y + p.h, { stroke: C.gridA, width: 1 })
    g.text(xx, p.y + p.h + 17, dayClock(tw), { size: 9.5, align: "center", color: C.dim, mono: true })
  }
  // SLO threshold lines.
  const slo = i === 1 ? 300 : i === 2 ? 1 : null
  if (slo !== null && slo < yhi) {
    const yy = Y(slo)
    const red = dark ? "#fb7185" : "#e11d48"
    g.path(dash(p.x, yy, p.x + p.w, 6, 5), { stroke: red + "77", width: 1 })
    g.text(p.x + 6, yy - 5, "SLO " + (i === 1 ? "300 ms" : "1%"), { size: 9.5, weight: 600, color: red + "cc", mono: true })
  }
  // Event markers from the ticker.
  for (const ev of sim.events) {
    if (ev.tag === "SIGNUP" || ev.tag === "INFO") continue
    const xx = X(ev.at)
    if (xx < p.x + 2 || xx > p.x + p.w - 2) continue
    const c = tagColor(ev.tag, dark)
    g.line(xx, p.y + 6, xx, p.y + p.h, { stroke: c + "33", width: 1 })
    g.circle(xx, p.y + 6, 3, c)
  }

  if (line.length > 1) {
    g.path(line, { stroke: color + "22", width: 7, cap: "round" })
    g.path(line, { stroke: color + "40", width: 3.5, cap: "round" })
    g.path(line, { stroke: color, width: 1.8, cap: "round" })
    // Glowing leading edge.
    const hx = lastPt[0]
    const hy = lastPt[1]
    g.line(hx, p.y, hx, bottom, { stroke: color + "26", width: 1 })
    g.rect(hx - 26, p.y, 26, p.h, { fill: { linear: [hx - 26, 0, hx, 0], stops: [[0, color + "00"], [1, color + "12"]] } })
    const pulse = (now % 1400) / 1400
    g.circle(hx, hy, 5 + pulse * 12, { stroke: color + hex(0.5 * (1 - pulse)), width: 1.5 })
    g.circle(hx, hy, 14, { fill: { radial: [hx, hy, 14], stops: [[0, color + "77"], [1, color + "00"]] } })
    g.circle(hx, hy, 3.5, dark ? "#ffffff" : color)
    if (reveal >= 1) {
      const label = fmt(i, headVal)
      const lw = label.length * 6.6 + 12
      const ly = clamp(hy - 22, p.y - 2, p.y + p.h - 18)
      const lx = Math.min(hx - lw - 8, p.x + p.w - lw)
      g.rrect(lx, ly, lw, 17, 5, { fill: C.tip + "e6", stroke: color + "88", width: 1 })
      g.text(lx + lw / 2, ly + 12.5, label, { size: 10.5, weight: 600, align: "center", color: dark ? "#ffffff" : color, mono: true })
    }
  }

  // Crosshair and tooltip.
  const hoverAge = now - ui_.hoverAt
  const ha = ui_.down ? 1 : clamp(1 - (hoverAge - 2200) / 400, 0, 1)
  if (ui_.hover && ha > 0 && reveal >= 1) {
    const hx = clamp(ui_.hover.x, p.x, p.x + p.w)
    const t = x0 + ((hx - p.x) / p.w) * span
    const v = valueAt(sim, i, t)
    const hy = Y(v)
    faded(g, appear, ha, () => {
      g.path(dash(hx, p.y, p.y + p.h, 3, 3, true), { stroke: C.muted + "aa", width: 1 })
      g.line(p.x, hy, p.x + p.w, hy, { stroke: color + "33", width: 1 })
      g.circle(hx, hy, 8, { fill: color + "33" })
      g.circle(hx, hy, 4, { fill: C.bg, stroke: color, width: 2 })
      const secs = (head - t) / 1000
      const l1 = fmt(i, v) + " " + kpi.unit
      const l2 = dayClock(wall.local - (head - t)) + "  ·  " + (secs < 0.5 ? "now" : "−" + secs.toFixed(1) + "s")
      const tw = Math.max(l1.length * 7.8, l2.length * 6.1) + 20
      const tx = hx + 12 + tw > p.x + p.w ? hx - 12 - tw : hx + 12
      const ty = clamp(hy - 52, p.y, p.y + p.h - 44)
      g.rrect(tx, ty, tw, 42, 8, { fill: C.tip + "f2", stroke: color + "88", width: 1 })
      g.text(tx + 10, ty + 18, l1, { size: 13, weight: 700, color: C.text, mono: true })
      g.text(tx + 10, ty + 33, l2, { size: 10, color: C.muted, mono: true })
    })
  }
  g.restore()
}

function gauges(g, b, C, dark, sim, shown, age, k) {
  const r = b.gauges
  if (!panel(g, r, C, dark, null, clamp((age - 300) / 520, 0, 1))) return
  g.text(r.x + 14, r.y + 22, "SYSTEM", { size: 10, weight: 600, color: C.muted, mono: true })
  const done = sim.rollout.filter((v) => v >= 100).length
  g.text(r.x + r.w - 14, r.y + 22, sim.paused ? "rollout paused" : done + "/4 regions at 100%", {
    size: 10,
    align: "right",
    color: sim.paused ? (dark ? "#fbbf24" : "#d97706") : C.dim,
    mono: true,
  })
  const rollout = sim.rollout.reduce((s, v) => s + v, 0) / 4
  // Apdex on a 0.3-1 scale, so the incident dip shows as a short red arc.
  const values = [rollout / 100, (sim.apdex - 0.3) / 0.7, sim.cpu / 100]
  const sweep = ease(clamp((age - 350) / 1000, 0, 1))
  for (let j = 0; j < 3; j++) shown.gauge[j] += (values[j] - shown.gauge[j]) * (sweep < 1 ? 1 : k)
  const labels = ["ROLLOUT", "APDEX", "CPU"]
  const texts = [
    Math.round(shown.gauge[0] * 100 * sweep) + "%",
    (0.3 + shown.gauge[1] * 0.7 * sweep).toFixed(2),
    Math.round(shown.gauge[2] * 100 * sweep) + "%",
  ]
  const subs = [sim.paused ? "paused" : "4 regions", "target 0.90", sim.pods + " pods"]
  const colors = [
    dark ? "#34d399" : "#059669",
    sim.apdex < 0.85 ? (dark ? "#fb7185" : "#e11d48") : dark ? "#22d3ee" : "#0891b2",
    sim.cpu > 75 ? (dark ? "#fbbf24" : "#d97706") : dark ? "#a78bfa" : "#7c3aed",
  ]
  // Each gauge: ticks 12 px outside the arc, a caption 14 px below it; centred in the space under the title.
  const cw = r.w / 3
  const room = r.h - 38
  // The ticks reach rad + 12: keep neighbouring gauges apart on narrow cards.
  const rad = Math.max(18, Math.min(cw * 0.36, cw / 2 - 15, (room - 29) / 2))
  const cy = r.y + 30 + 12 + rad + (room - (2 * rad + 29)) / 2
  const A0 = Math.PI * 0.75
  const SW = Math.PI * 1.5
  for (let j = 0; j < 3; j++) {
    const cx = r.x + cw * j + cw / 2
    const color = colors[j]
    const v = clamp(shown.gauge[j], 0, 1) * sweep
    g.path(arc(cx, cy, rad, A0, A0 + SW), { stroke: C.track, width: 7, cap: "round" })
    // ticks
    const ticks = []
    for (let q = 0; q <= 10; q++) {
      const a = A0 + (SW * q) / 10
      const r1 = rad + 8
      const r2 = rad + (q % 5 === 0 ? 12 : 10)
      ticks.push(["M", cx + Math.cos(a) * r1, cy + Math.sin(a) * r1], ["L", cx + Math.cos(a) * r2, cy + Math.sin(a) * r2])
    }
    g.path(ticks, { stroke: C.dim + "88", width: 1 })
    if (v > 0.002) {
      const segs = arc(cx, cy, rad, A0, A0 + SW * v)
      g.path(segs, { stroke: color + "2a", width: 15, cap: "round" })
      g.path(segs, { stroke: color, width: 7, cap: "round" })
      const ea = A0 + SW * v
      const ex = cx + Math.cos(ea) * rad
      const ey = cy + Math.sin(ea) * rad
      g.circle(ex, ey, 9, { fill: { radial: [ex, ey, 9], stops: [[0, color + "aa"], [1, color + "00"]] } })
      g.circle(ex, ey, 2.4, dark ? "#ffffff" : C.panel)
    }
    const vs = rad > 34 ? 18 : 15
    g.text(cx, cy + vs * 0.3, texts[j], { size: vs, weight: 600, align: "center", color: C.text, mono: true })
    g.text(cx, cy + vs * 0.3 + 14, labels[j], { size: 9, weight: 600, align: "center", color: C.muted, mono: true })
    g.text(cx, cy + rad + 14, subs[j], { size: 9.5, align: "center", color: C.dim, mono: true })
  }
  g.restore()
}

function ticker(g, b, C, dark, sim, shown, now, age, k) {
  const r = b.ticker
  const appear = clamp((age - 380) / 520, 0, 1)
  if (!panel(g, r, C, dark, null, appear)) return
  const pa = ease(appear)
  g.text(r.x + 14, r.y + 22, "EVENTS", { size: 10, weight: 600, color: C.muted, mono: true })
  const blink = 0.5 + 0.5 * Math.sin(now / 260)
  g.circle(r.x + r.w - 82, r.y + 18.5, 3, { fill: (dark ? "#34d399" : "#059669") + hex(0.4 + 0.6 * blink) })
  g.text(r.x + r.w - 14, r.y + 22, "streaming", { size: 10, align: "right", color: C.dim, mono: true })
  const rowH = b.phone ? 26 : 29
  const top = r.y + (b.phone ? 31 : 34)
  const rows = Math.max(1, Math.floor((r.h - (b.phone ? 34 : 38)) / rowH))
  // Each event's displayed slot eases toward its index; new ones slide in from above.
  // New ones start a row above the topmost (so rows never overlap while they move) and fade in.
  const slots = shown.ticker
  const keep = []
  let topY = 0
  for (const x of slots) topY = Math.min(topY, x.y)
  sim.events.forEach((ev, index) => {
    let s = slots.find((x) => x.ev === ev)
    if (!s) s = slots.length > 0 ? { ev, y: Math.min(index, topY) - 1, a: 0, born: now } : { ev, y: index, a: 1, born: now }
    s.target = index
    keep.push(s)
  })
  shown.ticker = keep
  const introRow = (index) => clamp((age - 450 - index * 90) / 420, 0, 1)
  for (const s of keep) {
    s.y += (s.target - s.y) * Math.min(1, k * 1.4)
    s.a += (1 - s.a) * Math.min(1, k * 1.2)
  }
  const tagW = b.phone ? 62 : 70
  const timeW = 34
  // Rows are drawn outside the panel's save, with the panel's fade multiplied in: clients disagree on whether a
  // nested `alpha` multiplies (Android) or replaces (Rune, iOS), so alpha is never nested under a fading panel.
  g.restore()
  for (const s of keep) {
    if (s.y > rows - 0.05 || s.y <= -0.5) continue
    const ia = introRow(s.target)
    const fadeOut = clamp(rows - 0.05 - s.y, 0, 1)
    const alpha = clamp(s.a * ia * Math.min(1, fadeOut) * clamp(1 + 2 * s.y, 0, 1) * pa, 0, 1)
    if (alpha <= 0.01) continue
    const y = top + s.y * rowH
    const slide = (1 - ease(ia)) * 24 - (1 - s.a) * 22
    const ev = s.ev
    const c = tagColor(ev.tag, dark)
    g.save().alpha(alpha)
    if (pa < 1) g.translate(0, (1 - pa) * 10)
    const fresh = clamp(1 - (now - s.born) / 1600, 0, 1)
    if (fresh > 0 && !ev.past && age > 1500) g.rrect(r.x + 6, y + 1, r.w - 12, rowH - 3, 7, { fill: c + hex(0.13 * fresh) })
    g.rrect(r.x + 12 + slide, y + 6, tagW, 16, 5, { fill: c + "1f", stroke: c + "44", width: 1 })
    g.text(r.x + 12 + slide + tagW / 2, y + 17.5, ev.tag, { size: 8.5, weight: 700, align: "center", color: c, mono: true })
    const max = Math.floor((r.w - tagW - timeW - 40) / 6.3)
    g.text(r.x + 12 + tagW + 10 + slide, y + 18, clip(ev.text, max), { size: 11.5, color: C.text })
    g.text(r.x + r.w - 14, y + 18, ago(now - ev.at), { size: 10, align: "right", color: C.dim, mono: true })
    if (s.y + 1 < rows - 0.2) g.line(r.x + 12, y + rowH - 1, r.x + r.w - 12, y + rowH - 1, { stroke: C.grid, width: 1 })
    g.restore()
  }
}

// ---------- helpers ----------

function arc(cx, cy, r, a0, a1) {
  const out = [["M", cx + Math.cos(a0) * r, cy + Math.sin(a0) * r]]
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)))
  const d = (a1 - a0) / n
  const kk = (4 / 3) * Math.tan(d / 4)
  for (let i = 0; i < n; i++) {
    const s = a0 + d * i
    const e = s + d
    const x1 = cx + Math.cos(s) * r
    const y1 = cy + Math.sin(s) * r
    const x2 = cx + Math.cos(e) * r
    const y2 = cy + Math.sin(e) * r
    out.push(["C", x1 - Math.sin(s) * r * kk, y1 + Math.cos(s) * r * kk, x2 + Math.sin(e) * r * kk, y2 - Math.cos(e) * r * kk, x2, y2])
  }
  return out
}

// A dashed line as one path: horizontal from (x1, y) to x2, or vertical at x from y1 to y2.
function dash(a, b, c, on, off, vertical) {
  const out = []
  if (vertical) {
    for (let y = b; y < c; y += on + off) out.push(["M", a, y], ["L", a, Math.min(c, y + on)])
  } else {
    for (let x = a; x < c; x += on + off) out.push(["M", x, b], ["L", Math.min(c, x + on), b])
  }
  return out
}

function niceTicks(lo, hi, count) {
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v)
  return out
}

function fmt(i, v) {
  if (i === 0) return group(Math.round(v))
  if (i === 1) return String(Math.round(v))
  if (i === 2) return v.toFixed(2)
  return group(Math.round(v))
}

function axis(i, v) {
  if (i === 0) return v >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k" : String(Math.round(v))
  if (i === 2) return v.toFixed(Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2)
  if (i === 3) return v >= 10000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v))
  return String(Math.round(v))
}

function group(n) {
  const s = String(Math.abs(Math.round(n)))
  let out = ""
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ","
    out += s[i]
  }
  return (n < 0 ? "-" : "") + out
}

function hms(total) {
  const t = Math.max(0, Math.floor(total))
  return pad2(Math.floor(t / 3600)) + ":" + pad2(Math.floor(t / 60) % 60) + ":" + pad2(t % 60)
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n)
}

// The wall clock: `utc` ms, `local` ms (shifted by the VM's time zone, so hms(local) is the user's local time) and the
// zone's name ("UTC", "UTC+2", "UTC-5:30"). A host without a time zone reports UTC; without `Date` it runs from
// 14:00:00 local.
function wallNow(now) {
  if (typeof Date === "undefined" || typeof Date.now !== "function") return { utc: 50400000 + now, local: 50400000 + now, zone: "local" }
  const d = new Date()
  const utc = d.getTime()
  const off = typeof d.getTimezoneOffset === "function" ? Number(d.getTimezoneOffset()) : 0
  const minutes = Number.isFinite(off) && Math.abs(off) <= 18 * 60 ? -Math.round(off) : 0
  return { utc, local: utc + minutes * 60000, zone: zoneName(minutes) }
}

function zoneName(minutes) {
  if (minutes === 0) return "UTC"
  const m = Math.abs(minutes)
  return "UTC" + (minutes > 0 ? "+" : "-") + Math.floor(m / 60) + (m % 60 ? ":" + pad2(m % 60) : "")
}

function dayClock(ms) {
  return hms((((Math.floor(ms / 1000) % 86400) + 86400) % 86400))
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 3) return "now"
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m"
  return Math.floor(s / 3600) + "h"
}

function tagColor(tag, dark) {
  const c = TAGS[tag] || TAGS.INFO
  return dark ? c.dark : c.light
}

function clip(text, max) {
  if (max < 4) return ""
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v
}

function ease(t) {
  const u = clamp(t, 0, 1)
  return 1 - Math.pow(1 - u, 3)
}

function hex(alpha) {
  const value = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return "0123456789abcdef"[value >> 4] + "0123456789abcdef"[value & 15]
}
