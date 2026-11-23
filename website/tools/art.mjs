// Generates the vector artwork in site/art. Run with `bun art.mjs` from tools/.
//
// bg-wide.svg and bg-narrow.svg are the still versions of the liquid background
// that site/liquid.js paints with WebGPU. Keep `LAYOUTS` and `bandField` here in
// step with the same numbers in liquid.js.
import { writeFileSync, mkdirSync } from 'node:fs'
import { layout, flatSvg, INK } from './wordmark.mjs'

const out = new URL('../site/art/', import.meta.url)
mkdirSync(out, { recursive: true })
const save = (name, svg) => {
  writeFileSync(new URL(name, out), svg)
  console.log(name.padEnd(22), `${(svg.length / 1024).toFixed(1)} KB`)
}

const C = {
  ink: INK,
  cream: '#f6e3bd',
  yellow: '#f9bb2d',
  amber: '#f59a23',
  orange: '#f26a21',
  red: '#e8401f',
  pink: '#ee5a8f',
  magenta: '#d2378c',
  purple: '#8a3d9e',
  teal: '#1f9c9b',
  aqua: '#6cc7b6',
  green: '#5d9a4c',
  moss: '#3f7a56',
  lime: '#a9c35c',
}

const n1 = (n) => Math.round(n * 10) / 10
const TAU = Math.PI * 2
const polar = (cx, cy, r, a) => [n1(cx + r * Math.cos(a)), n1(cy + r * Math.sin(a))]
const svg = (w, h, body, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${attrs}>\n${body}\n</svg>\n`

// Smooth open curve through points (Catmull-Rom as cubic Beziers), without the leading M.
function through(points) {
  let d = ''
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    d += `C${n1(p1[0] + (p2[0] - p0[0]) / 6)} ${n1(p1[1] + (p2[1] - p0[1]) / 6)} ${n1(p2[0] - (p3[0] - p1[0]) / 6)} ${n1(p2[1] - (p3[1] - p1[1]) / 6)} ${n1(p2[0])} ${n1(p2[1])}`
  }
  return d
}

// ---- Liquid background, still version -------------------------------------

const RAY_COLORS = [C.yellow, C.pink, C.amber, C.magenta, C.yellow, C.orange, C.pink, C.amber]
const BAND_COLORS = [
  C.pink, C.yellow, C.orange, C.teal, C.purple, C.magenta, C.amber, C.red, C.aqua, C.pink,
  C.yellow, C.purple, C.orange, C.teal, C.magenta, C.yellow, C.red, C.purple, C.amber, C.pink,
]
const RING_COLORS = [C.orange, C.yellow, C.pink, C.purple, C.teal, C.yellow, C.red]
const RAY_COUNT = 40

const LAYOUTS = {
  wide: {
    width: 1440,
    height: 960,
    band: 78,
    center: [800, 370],
    top: { base: 400, amp: 108, freq: 0.75, phase: -1.1 },
    burst: { x0: 380, spread: 270, falloff: 190 },
    rings: [
      [60, 600, 150, RING_COLORS],
      [690, 960, 150, [C.pink, C.yellow, C.teal, C.orange, C.purple, C.yellow]],
    ],
    clouds: [
      [545, 100, 1.5, 'cream'],
      [70, 690, 1.3, 'purple'],
      [20, 820, 1.15, 'teal'],
    ],
  },
  narrow: {
    width: 600,
    height: 2400,
    band: 64,
    center: [310, 300],
    top: { base: 520, amp: 70, freq: 0.75, phase: -1.1 },
    burst: { x0: -40, spread: 430, falloff: 105 },
    rings: [
      [-10, 700, 120, RING_COLORS],
      [610, 1180, 130, [C.pink, C.yellow, C.teal, C.orange, C.purple, C.yellow]],
      [40, 1640, 120, RING_COLORS],
    ],
    clouds: [
      [420, 70, 0.95, 'cream'],
      [530, 660, 0.9, 'purple'],
      [20, 1340, 1.0, 'teal'],
    ],
  },
}

const topEdge = (L, x) => L.top.base + L.top.amp * Math.sin((x / L.width) * TAU * L.top.freq + L.top.phase)
const burstEdge = (L, y) => L.burst.x0 + L.burst.spread * Math.exp(-y / L.burst.falloff)

// How far a point sits below the ribbons' top edge.
function depth(L, x, y) {
  return (
    y -
    topEdge(L, x) -
    26 * Math.sin((x * TAU) / 640 + y * 0.00625 + 0.4) -
    7 * Math.sin((x * TAU) / 290 - y * 0.01125)
  )
}

// Band number at a point, growing by one per ribbon downward.
const bandField = (L, x, y) => depth(L, x, y) / L.band + 1.3 * Math.sin(x / 250 + 1 + y / 200)

function solveY(fn, target, lo, hi) {
  for (let i = 0; i < 44; i++) {
    const mid = (lo + hi) / 2
    if (fn(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function ribbons(L, stroke = 3.5) {
  const xs = []
  for (let x = -40; x <= L.width + 40.1; x += 30) xs.push(x)
  const bottom = L.height + 600
  const contour = (k) => xs.map((x) => [x, solveY((y) => bandField(L, x, y), k, -600, bottom)])
  const top = xs.map((x) => [x, solveY((y) => depth(L, x, y), 0, -600, bottom)])
  const topPath = `M${n1(top[0][0])} ${n1(top[0][1])}${through(top)}`
  let s = ''
  let prev = contour(-4)
  for (let k = -4; Math.min(...prev.map((p) => p[1])) < L.height; k++) {
    const next = contour(k + 1)
    const back = [...next].reverse()
    s += `<path d="M${n1(prev[0][0])} ${n1(prev[0][1])}${through(prev)}L${n1(back[0][0])} ${n1(back[0][1])}${through(back)}Z" fill="${BAND_COLORS[(((k % 20) + 20) % 20)]}"/>`
    prev = next
  }
  return `<clipPath id="below"><path d="${topPath}L${L.width + 40} ${bottom}L-40 ${bottom}Z"/></clipPath>
<g stroke="${C.ink}" stroke-width="${stroke}" stroke-linejoin="round"><g clip-path="url(#below)">${s}</g><path d="${topPath}" fill="none"/></g>`
}

function rays(L) {
  const [cx, cy] = L.center
  const radius = Math.hypot(L.width, 960) * 1.2
  let s = ''
  for (let i = 0; i < RAY_COUNT; i++) {
    const a0 = (i / RAY_COUNT) * TAU
    const a1 = ((i + 1) / RAY_COUNT) * TAU + 0.004
    s += `<path d="M${cx} ${cy}L${polar(cx, cy, radius, a0).join(' ')}L${polar(cx, cy, radius, a1).join(' ')}Z" fill="${RAY_COLORS[i % RAY_COLORS.length]}"/>`
  }
  const edge = []
  for (let y = 0; y <= 960; y += 30) edge.push([burstEdge(L, y), y])
  const clip = `M${n1(edge[0][0])} 0${through(edge)}L${L.width} 960L${L.width} 0Z`
  return `<clipPath id="burst"><path d="${clip}"/></clipPath><g clip-path="url(#burst)">${s}</g>`
}

function bullseye(cx, cy, radius, colors, step = 22, stroke = 3.5) {
  let s = ''
  for (let r = radius, i = 0; r > 4; r -= step, i++)
    s += `<circle cx="${cx}" cy="${cy}" r="${n1(r)}" fill="${colors[i % colors.length]}"/>`
  return `<g stroke="${C.ink}" stroke-width="${stroke}">${s}</g>`
}

// Scalloped cloud: outlined union of circles. Same lobes as CLOUD in liquid.js.
const PUFF = [
  [0, 0, 34],
  [44, -22, 40],
  [96, -30, 46],
  [150, -14, 40],
  [192, 4, 30],
  [40, 14, 30],
  [96, 16, 34],
  [150, 16, 30],
]
const CLOUD_FILL = { cream: C.cream, purple: C.purple, teal: C.teal }
// Background clouds: puffs on a flat base, the same shape liquid.js draws.
const CLOUD = [
  [-72, -14, 27],
  [-38, -36, 35],
  [6, -52, 43],
  [52, -35, 35],
  [88, -13, 25],
]
function cloud(x, y, scale, kind, stroke = 3.5) {
  const at = ([cx, cy, r]) => `cx="${n1(x + cx * scale)}" cy="${n1(y + cy * scale)}" r="${n1(r * scale)}"`
  const base = `x="${n1(x - 92 * scale)}" y="${n1(y - 22 * scale)}" width="${n1(200 * scale)}" height="${n1(36 * scale)}" rx="${n1(18 * scale)}"`
  const rim = `stroke="${C.ink}" stroke-width="${stroke * 2}" fill="${C.ink}"`
  return `<g><rect ${base} ${rim}/>${CLOUD.map((c) => `<circle ${at(c)} ${rim}/>`).join('')}<g fill="${CLOUD_FILL[kind]}"><rect ${base}/>${CLOUD.map((c) => `<circle ${at(c)}/>`).join('')}</g></g>`
}

function background(L) {
  return svg(
    L.width,
    L.height,
    `<rect width="${L.width}" height="${L.height}" fill="${C.ink}"/>
${rays(L)}
${ribbons(L)}
${L.rings.map(([x, y, r, colors]) => bullseye(x, y, r, colors)).join('\n')}
${L.clouds.map(([x, y, s, kind]) => cloud(x, y, s, kind)).join('\n')}`,
  )
}

// ---- Objects ---------------------------------------------------------------

function star(cx, cy, r, fill, rot = -90, points = 5, inner = 0.45) {
  let d = ''
  for (let i = 0; i < points * 2; i++) {
    const [x, y] = polar(cx, cy, i % 2 ? r * inner : r, ((rot + (i * 180) / points) * Math.PI) / 180)
    d += `${i ? 'L' : 'M'}${x} ${y}`
  }
  return `<path d="${d}Z" fill="${fill}"/>`
}

function planet(cx, cy, r) {
  const ring = (clip) =>
    `<g ${clip} fill="none"><ellipse rx="${r * 1.95}" ry="${r * 0.46}" stroke="${C.ink}" stroke-width="${r * 0.3}"/><ellipse rx="${r * 1.95}" ry="${r * 0.46}" stroke="${C.yellow}" stroke-width="${r * 0.2}"/><ellipse rx="${r * 1.95}" ry="${r * 0.46}" stroke="${C.orange}" stroke-width="${r * 0.045}"/></g>`
  return `<g transform="translate(${cx} ${cy}) rotate(-20)">
<clipPath id="pfront"><rect x="${-r * 2.4}" y="0" width="${r * 4.8}" height="${r}"/></clipPath>
<clipPath id="pball"><circle r="${r}"/></clipPath>
${ring('')}
<circle r="${r}" fill="${C.magenta}"/>
<g clip-path="url(#pball)" fill="none">
<path d="M${-r} ${-r * 0.42}Q0 ${-r * 0.2} ${r} ${-r * 0.5}" stroke="${C.pink}" stroke-width="${r * 0.26}"/>
<path d="M${-r} ${r * 0.34}Q0 ${r * 0.62} ${r} ${r * 0.3}" stroke="${C.purple}" stroke-width="${r * 0.3}"/>
<path d="M${-r} ${r * 0.8}Q0 ${r * 1.05} ${r} ${r * 0.76}" stroke="${C.pink}" stroke-width="${r * 0.16}"/>
</g>
<circle r="${r}" fill="none" stroke="${C.ink}" stroke-width="3.5"/>
${ring('clip-path="url(#pfront)"')}
</g>`
}

// Ringed planet and stars for the dark corner of the sky.
function sky() {
  return svg(
    520,
    240,
    `${star(58, 52, 17, C.aqua, -80)}${star(340, 62, 13, C.aqua, -100)}${star(415, 34, 15, C.cream, -86)}${star(486, 22, 11, C.aqua, -95)}${star(74, 200, 16, C.aqua, -70)}
${star(270, 34, 5, C.yellow, 0, 4, 0.4)}${star(30, 118, 4, C.yellow, 0, 4, 0.4)}${star(300, 150, 5, C.yellow, 0, 4, 0.4)}${star(230, 205, 4, C.cream, 0, 4, 0.4)}${star(118, 28, 4, C.cream, 0, 4, 0.4)}
${planet(172, 104, 60)}`,
  )
}

function flower() {
  const r = 92
  let petals = ''
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3
    const [px, py] = polar(0, 0, r * 0.62, a)
    const [qx, qy] = polar(0, 0, r * 0.5, a)
    petals += `<circle cx="${px}" cy="${py}" r="${n1(r * 0.46)}" fill="${C.pink}" stroke="${C.ink}" stroke-width="3.5"/><circle cx="${qx}" cy="${qy}" r="${n1(r * 0.24)}" fill="${C.magenta}" opacity=".55"/>`
  }
  let dots = ''
  for (let i = 0; i < 14; i++) {
    const [px, py] = polar(0, 0, r * 0.3, (i / 14) * TAU)
    dots += `<circle cx="${px}" cy="${py}" r="${n1(r * 0.052)}" fill="${C.yellow}" stroke="${C.ink}" stroke-width="1.6"/>`
  }
  return svg(
    210,
    210,
    `<g transform="translate(105 105)">${petals}<circle r="${n1(r * 0.36)}" fill="${C.orange}" stroke="${C.ink}" stroke-width="3.5"/>${dots}<circle r="${n1(r * 0.2)}" fill="${C.yellow}" stroke="${C.ink}" stroke-width="2.5"/></g>`,
  )
}

function sun(cx, cy, r) {
  const N = 20
  const half = (TAU / N) * 0.56
  const flame = (i, r0, r1, fill, sway) => {
    const a = (i / N) * TAU
    const len = r1 - r0
    const p = (rr, aa) => polar(0, 0, rr, aa).join(' ')
    return `<path d="M${p(r0, a - half)}C${p(r0 + len * 0.45, a - half * 1.25)} ${p(r0 + len * 0.7, a - half * 0.2 - sway * 0.4)} ${p(r1, a + sway)}C${p(r0 + len * 0.78, a + half * 0.7 + sway * 0.5)} ${p(r0 + len * 0.4, a + half * 1.35)} ${p(r0, a + half)}Z" fill="${fill}"/>`
  }
  let long = ''
  let short = ''
  for (let i = 0; i < N; i++) {
    if (i % 2) short += flame(i, r * 0.9, r * 1.82, C.yellow, 0.07)
    else long += flame(i, r * 0.9, r * 2.5, C.orange, -0.1) + flame(i, r * 0.9, r * 1.75, C.amber, -0.05)
  }
  const eye = (s) =>
    `<g transform="scale(${s} 1)"><path d="M-37 -24Q-22 -37 -7 -25" fill="none" stroke-width="3.2"/><path d="M-35 -9Q-21 -21 -7 -9Q-21 -1 -35 -9Z" fill="${C.cream}" stroke-width="2.4"/><circle cx="-21" cy="-10.5" r="5.2" fill="${C.ink}" stroke="none"/><path d="M-34 -2Q-21 5 -9 -2" fill="none" stroke-width="1.6"/></g>`
  return `<g transform="translate(${cx} ${cy})" stroke="${C.ink}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
${short}${long}
<circle r="${r}" fill="${C.yellow}" stroke-width="3.5"/>
<circle cx="-36" cy="16" r="9" fill="${C.amber}" stroke="none"/><circle cx="36" cy="16" r="9" fill="${C.amber}" stroke="none"/>
${eye(1)}${eye(-1)}
<path d="M-4 -12C-5 0 -9 10 -8 15Q-4 21 0 17Q4 21 8 15" fill="none" stroke-width="2.4"/>
<path d="M-14 31Q-6 25 0 28Q6 25 14 31Q0 35 -14 31Z" fill="${C.red}" stroke-width="2"/>
<path d="M-11 33Q0 43 11 33" fill="${C.orange}" stroke-width="2"/>
<path d="M-7 49Q0 53 7 49" fill="none" stroke-width="1.8"/>
</g>`
}

const SCENE = { width: 760, height: 600, computer: [300, 302, 1.12] }

function computer() {
  const [ox, oy, s] = SCENE.computer
  const skew = 'matrix(1 -0.088 0 1 0 0)'
  return `<g transform="translate(${ox} ${oy}) scale(${s})" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">
<ellipse cx="180" cy="262" rx="250" ry="16" fill="${C.ink}" opacity=".28" stroke="none"/>
<path d="M274 189.9L392 205L392 247L274 235.9Z" fill="#c49a68"/>
<path d="M-44 217.9L-18 202L250 178L345 172L392 205L274 189.9Z" fill="#f1dcb1"/>
<g transform="${skew}">
<rect x="-44" y="214" width="318" height="46" rx="8" fill="#e4c594"/>
<rect x="188" y="230" width="62" height="9" rx="2.5" fill="${C.ink}" stroke="none"/>
<circle cx="170" cy="235" r="3.5" fill="${C.red}" stroke-width="1.5"/>
<path d="M-24 228H30M-24 237H30M-24 246H30" stroke-width="2.5" opacity=".55"/>
</g>
<path d="M250 -22L345 -6L345 172L250 178Z" fill="#cfa978"/>
<path d="M276 30L322 36M276 46L322 52M276 62L322 68M276 78L322 84" stroke-width="2.5" opacity=".5"/>
<g transform="${skew}">
<rect x="0" y="0" width="250" height="200" rx="18" fill="#ecd2a4"/>
<rect x="16" y="14" width="218" height="152" rx="16" fill="#d6b382" stroke-width="2.5"/>
<rect x="30" y="26" width="190" height="126" rx="24" fill="#161d18" stroke-width="3.5"/>
<path d="M44 50Q52 38 70 36" fill="none" stroke="#3d5a44" stroke-width="3" opacity=".8"/>
<rect x="22" y="176" width="54" height="12" rx="3" fill="#d6b382" stroke-width="2"/>
<circle cx="208" cy="182" r="5.5" fill="#c49a68" stroke-width="2"/><circle cx="228" cy="182" r="5.5" fill="#c49a68" stroke-width="2"/>
</g>
</g>`
}

// Sun, rainbow, hills and the terminal. The prompt text is HTML laid over the screen.
function scene() {
  const { width: W, height: H } = SCENE
  const bands = [C.red, C.amber, C.yellow, C.teal, C.pink, C.purple]
  const cx = 290
  let bow = ''
  let lines = ''
  bands.forEach((color, i) => {
    const r = 279 - i * 22
    bow += `<path d="M${cx - r} ${H}A${r} ${r} 0 0 1 ${cx + r} ${H}" stroke="${color}" stroke-width="22"/>`
  })
  for (let i = 0; i <= bands.length; i++) {
    const r = 290 - i * 22
    lines += `<path d="M${cx - r} ${H}A${r} ${r} 0 0 1 ${cx + r} ${H}"/>`
  }
  const puff = (x, y, s) => {
    const at = ([px, py, r]) => `cx="${n1(x + px * s)}" cy="${n1(y + py * s)}" r="${n1(r * s)}"`
    return (
      PUFF.map((c) => `<circle ${at(c)} fill="${C.ink}" stroke="${C.ink}" stroke-width="6"/>`).join('') +
      PUFF.map((c) => `<circle ${at(c)} fill="${C.cream}"/>`).join('') +
      `<circle ${at([96, 24, 18])} fill="#bfd9cf" opacity=".8"/><circle ${at([146, 20, 13])} fill="#bfd9cf" opacity=".8"/>`
    )
  }
  return svg(
    W,
    H,
    `<g fill="none">${bow}<g stroke="${C.ink}" stroke-width="3.5">${lines}</g></g>
${puff(250, 96, 0.62)}${puff(372, 146, 0.5)}
<g stroke="${C.ink}" stroke-width="3.5" stroke-linejoin="round">
<path d="M96 ${H}C150 520 200 446 262 452C310 456 330 420 382 414C450 406 500 452 560 440C640 424 700 450 ${W} 486L${W} ${H}Z" fill="${C.moss}"/>
<path d="M150 470C200 480 240 470 270 480M400 436C440 446 470 470 520 462" fill="none" stroke-width="2" opacity=".5"/>
<path d="M30 ${H}C90 548 170 486 262 500C350 514 420 520 500 492C590 462 680 478 ${W} 520L${W} ${H}Z" fill="${C.green}"/>
<path d="M120 548C200 520 280 524 340 540M150 572C230 544 300 548 352 562M560 500C620 492 690 500 ${W - 10} 530" fill="none" stroke="${C.moss}" stroke-width="2.5"/>
<path d="M0 ${H}C60 572 150 538 250 552C350 566 430 580 530 552C620 528 700 536 ${W} 566L${W} ${H}Z" fill="${C.lime}"/>
<path d="M0 ${H}C120 580 260 574 400 590C540 606 660 584 ${W} 590L${W} ${H}Z" fill="${C.yellow}"/>
</g>
${computer()}`,
  )
}

// Still sun for browsers without WebGPU; liquid.js paints the live one.
const sunStill = () => svg(340, 340, sun(170, 170, 62))

// Where the terminal's glass sits inside scene.svg, as fractions of the image.
function screenBox() {
  const [ox, oy, s] = SCENE.computer
  const { width: W, height: H } = SCENE
  const left = ox + 42 * s
  const right = ox + 208 * s
  const top = oy + (40 - 0.088 * 125) * s
  const bottom = oy + (138 - 0.088 * 125) * s
  return {
    left: n1((left / W) * 100),
    top: n1((top / H) * 100),
    width: n1(((right - left) / W) * 100),
    height: n1(((bottom - top) / H) * 100),
  }
}

// Cream cloud behind the headline card. It stretches to the card's box.
function card() {
  const d =
    'M58 104A62 62 0 0 1 146 56A72 60 0 0 1 286 30A84 52 0 0 1 432 32A72 46 0 0 1 556 58A64 64 0 0 1 636 136A60 110 0 0 1 632 330A52 52 0 0 1 580 406Q340 412 96 406A62 62 0 0 1 26 330A52 62 0 0 1 20 216A52 62 0 0 1 58 104Z'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 16 688 402" width="688" height="402" preserveAspectRatio="none">
<path d="${d}" fill="${C.cream}" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
</svg>
`
}

// Paper tooth and uneven ink, tiled over the whole poster with multiply.
function paper() {
  return svg(
    480,
    480,
    `<filter id="p" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="11" stitchTiles="stitch" result="tooth"/>
<feColorMatrix in="tooth" type="matrix" values="0 0 0 0 .35  0 0 0 0 .24  0 0 0 0 .14  0 0 0 .8 -.32"/>
</filter>
<rect width="480" height="480" filter="url(#p)"/>`,
  )
}

function favicon() {
  const p = layout([{ ch: 'P', scale: 1, rot: -6, dy: 0 }], { size: 400 })
  return flatSvg(p, {
    fill: C.orange,
    fat: 14,
    pad: 60,
    label: 'Psychoscript',
    background: `<rect x="-200" y="-500" width="900" height="900" fill="${C.ink}"/>`,
  })
}

save('favicon.svg', favicon())
save('bg-wide.svg', background(LAYOUTS.wide))
save('bg-narrow.svg', background(LAYOUTS.narrow))
save('sky.svg', sky())
save('flower.svg', flower())
save('scene.svg', scene())
save('sun.svg', sunStill())
save('paper.svg', paper())
console.log('terminal screen box (% of scene.svg):', screenBox())
