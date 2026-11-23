// Builds the PSYCHOSCRIPT lettering from Chicle (SIL OFL) glyph outlines.
// Each letter is scaled, turned and lifted on its own, then drawn as a fattened
// shape over the letter before it, so the word reads as hand lettering.
import opentype from 'opentype.js'
import { readFileSync } from 'node:fs'

const font = opentype.parse(readFileSync(new URL('./fonts/Chicle-Regular.ttf', import.meta.url)).buffer)

export const INK = '#1d1614'
const r1 = (n) => Math.round(n * 10) / 10

function glyphCommands(char, size) {
  const glyph = font.charToGlyph(char)
  const k = size / font.unitsPerEm
  return { commands: glyph.getPath(0, 0, size).commands, advance: glyph.advanceWidth * k, glyph }
}

function transform(commands, { scale, rot, x, y, pivotX }) {
  const a = (rot * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const pt = (px, py) => {
    const sx = (px - pivotX) * scale
    const sy = py * scale
    return [r1(x + pivotX * scale + sx * cos - sy * sin), r1(y + sx * sin + sy * cos)]
  }
  let d = ''
  let box = [Infinity, Infinity, -Infinity, -Infinity]
  const grow = ([px, py]) => {
    box = [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)]
    return `${px} ${py}`
  }
  for (const c of commands) {
    if (c.type === 'Z') d += 'Z'
    else if (c.type === 'M' || c.type === 'L') d += `${c.type}${grow(pt(c.x, c.y))}`
    else if (c.type === 'Q') d += `Q${grow(pt(c.x1, c.y1))} ${grow(pt(c.x, c.y))}`
    else if (c.type === 'C') d += `C${grow(pt(c.x1, c.y1))} ${grow(pt(c.x2, c.y2))} ${grow(pt(c.x, c.y))}`
  }
  return { d, box }
}

// letters: [{ ch, scale, rot, dy }]; returns letter paths laid out left to right.
export function layout(letters, { size = 400, tracking = -10, originX = 0, originY = 0 } = {}) {
  let x = originX
  const out = []
  let prev = null
  for (const l of letters) {
    const g = glyphCommands(l.ch, size)
    if (prev) x += font.getKerningValue(prev, g.glyph) * (size / font.unitsPerEm) * l.scale
    const { d, box } = transform(g.commands, {
      scale: l.scale,
      rot: l.rot,
      x,
      y: originY + l.dy,
      pivotX: g.advance / 2,
    })
    out.push({ d, box })
    x += (g.advance + tracking) * l.scale
    prev = g.glyph
  }
  return out
}

export function bounds(paths) {
  return paths.reduce(
    (b, p) => [Math.min(b[0], p.box[0]), Math.min(b[1], p.box[1]), Math.max(b[2], p.box[2]), Math.max(b[3], p.box[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  )
}

// The poster title: black blob behind, each letter outlined in ink and filled
// with a mottled red-to-amber gradient.
export function posterSvg(paths, { fat = 12, line = 8, blob = 30, shadow = [10, 16], pad = 8, label }) {
  const b = bounds(paths)
  const m = fat / 2 + line + blob + pad
  const x0 = b[0] - m
  const y0 = b[1] - m
  const w = b[2] - b[0] + 2 * m + shadow[0]
  const h = b[3] - b[1] + 2 * m + shadow[1]
  const defs = paths.map((p, i) => `<path id="l${i}" d="${p.d}"/>`).join('')
  const all = paths.map((_, i) => `<use href="#l${i}"/>`).join('')
  const blobW = fat + 2 * line + 2 * blob
  const letters = paths
    .map(
      (_, i) =>
        `<use href="#l${i}" fill="${INK}" stroke="${INK}" stroke-width="${fat + 2 * line}"/>` +
        `<use href="#l${i}" fill="url(#fill)" stroke="url(#fill)" stroke-width="${fat}"/>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(x0)} ${r1(y0)} ${r1(w)} ${r1(h)}" width="${Math.round(w)}" height="${Math.round(h)}" role="img" aria-label="${label}">
<defs>
${defs}
<linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="0" y1="${r1(b[1])}" x2="0" y2="${r1(b[3])}">
<stop offset="0" stop-color="#ee3a1a"/><stop offset=".45" stop-color="#f4511c"/><stop offset=".78" stop-color="#f7791f"/><stop offset="1" stop-color="#f9a425"/>
</linearGradient>
<filter id="print" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency=".011 .017" numOctaves="3" seed="7" result="blotch"/>
<feColorMatrix in="blotch" type="matrix" values="0 0 0 0 .74  0 0 0 0 .1  0 0 0 0 .06  0 0 0 1.6 -.84" result="dark"/>
<feColorMatrix in="blotch" type="matrix" values="0 0 0 0 1  0 0 0 0 .72  0 0 0 0 .2  1.4 0 0 0 -.78" result="light"/>
<feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="3" result="grain"/>
<feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 .84  0 0 0 0 .5  0 0 0 1.4 -.92" result="fleck"/>
<feMerge result="marks"><feMergeNode in="dark"/><feMergeNode in="light"/><feMergeNode in="fleck"/></feMerge>
<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4 0 0 0 -2" result="orange"/>
<feComposite in="marks" in2="orange" operator="in" result="clipped"/>
<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="clipped"/></feMerge>
</filter>
</defs>
<g stroke-linejoin="round" stroke-linecap="round">
<g fill="${INK}" stroke="${INK}" stroke-width="${blobW}"><g transform="translate(${shadow[0]} ${shadow[1]})">${all}</g>${all}</g>
<g filter="url(#print)">${letters}</g>
</g>
</svg>
`
}

// Flat one-colour lettering for the header logo and favicon.
export function flatSvg(paths, { fill, fat = 6, pad = 4, label, background = '' }) {
  const b = bounds(paths)
  const m = fat / 2 + pad
  const w = b[2] - b[0] + 2 * m
  const h = b[3] - b[1] + 2 * m
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(b[0] - m)} ${r1(b[1] - m)} ${r1(w)} ${r1(h)}" width="${Math.round(w)}" height="${Math.round(h)}" role="img" aria-label="${label}">${background}<path d="${paths.map((p) => p.d).join('')}" fill="${fill}" stroke="${fill}" stroke-width="${fat}" stroke-linejoin="round"/></svg>
`
}

const spell = (text, rows) => [...text].map((ch, i) => ({ ch, scale: rows[i][0], rot: rows[i][1], dy: rows[i][2] }))

// One line, rising to the right and swelling in the middle like the poster.
export const arch = () =>
  layout(
    spell('Psychoscript', [
      [1.1, -5, 18],
      [0.88, -7, -30],
      [0.92, -4, -58],
      [1.0, -5, -84],
      [1.1, -2, -102],
      [1.14, -3, -114],
      [1.16, 1, -122],
      [1.14, -1, -128],
      [1.08, 2, -130],
      [1.04, 0, -132],
      [1.02, 3, -128],
      [0.98, 4, -126],
    ]),
    { tracking: -12 },
  )

// Two lines for narrow screens.
export const stacked = () => {
  const top = layout(
    spell('Psycho', [
      [1.0, -6, 0],
      [0.9, -6, -28],
      [0.96, -3, -46],
      [1.02, -3, -58],
      [1.06, 0, -62],
      [1.04, 3, -58],
    ]),
    { tracking: -12 },
  )
  const tb = bounds(top)
  const bottomRaw = layout(
    spell('script', [
      [1.0, -4, 0],
      [1.04, -2, -8],
      [1.06, 1, -12],
      [1.06, -1, -14],
      [1.04, 2, -10],
      [1.0, 5, -4],
    ]),
    { tracking: -6, size: 470 },
  )
  const bb = bounds(bottomRaw)
  const dx = (tb[0] + tb[2]) / 2 - (bb[0] + bb[2]) / 2 + 36
  const dy = tb[3] - bb[1] - 40
  const bottom = layout(
    spell('script', [
      [1.0, -4, 0],
      [1.04, -2, -8],
      [1.06, 1, -12],
      [1.06, -1, -14],
      [1.04, 2, -10],
      [1.0, 5, -4],
    ]),
    { tracking: -6, size: 470, originX: dx, originY: dy },
  )
  return [...top, ...bottom]
}

export const flat = (text = 'Psychoscript') =>
  layout(
    [...text].map((ch) => ({ ch, scale: 1, rot: 0, dy: 0 })),
    { tracking: 4 },
  )
