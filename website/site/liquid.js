import { createSound } from './sound.js'
import { SAYINGS, spoken as lineLength, mouthAt } from './voice.worklet.js'

// The hero, painted with WebGPU.
//
// The background is a real fluid. A small velocity field is stirred by slow
// vortices and by the pointer, kept incompressible with a pressure solve, and
// used to carry a "dye" texture. The dye holds a phase (which ring of colour a
// drop belongs to) and the direction it left the sun in. The sun keeps
// emitting fresh rings, the fluid folds them into marbling, and the last pass
// turns the phase into flat poster bands with pen lines, then draws the sun,
// hills, terminal, clouds and lettering over it.
//
// Without WebGPU the page keeps the still SVGs from tools/art.mjs.

const INK = '#1d1614'
const PAPER = '#f6e3bd'
const P = {
  yellow: '#f9bb2d',
  amber: '#f59a23',
  orange: '#f26a21',
  red: '#e8401f',
  pink: '#ee5a8f',
  magenta: '#d2378c',
  purple: '#8a3d9e',
  teal: '#1f9c9b',
  aqua: '#6cc7b6',
  blue: '#2c6fa6',
  sea: '#3f9a6a',
  moss: '#3f7a56',
  green: '#5d9a4c',
  lime: '#a9c35c',
}
// The neighbouring pigment each colour leans toward across a shape.
const MATE = {
  [P.yellow]: P.amber,
  [P.amber]: P.orange,
  [P.orange]: P.red,
  [P.red]: P.magenta,
  [P.pink]: P.magenta,
  [P.magenta]: P.purple,
  [P.purple]: P.magenta,
  [P.teal]: P.blue,
  [P.aqua]: P.teal,
}
const RAYS = [P.yellow, P.pink, P.amber, P.magenta, P.yellow, P.orange, P.pink, P.amber]
const BANDS = [
  P.pink, P.yellow, P.orange, P.teal, P.purple, P.magenta, P.amber, P.red, P.aqua, P.pink,
  P.yellow, P.purple, P.orange, P.teal, P.magenta, P.yellow, P.red, P.purple, P.amber, P.pink,
]
const RAINBOW = [P.red, P.amber, P.yellow, P.teal, P.pink, P.purple]
// Cloud kinds: cream, purple, teal. Lit top, body, and shaded underside.
const CLOUD_LIGHT = ['#fdf3da', '#a85cba', '#3bb5ae']
const CLOUD_BODY = [PAPER, P.purple, P.teal]
const CLOUD_SHADE = ['#bfd2c6', '#6a2d84', '#157a80']
// Cloud puffs as balls: x, y (up), z (toward the eye), radius.
const CLOUD = [
  [-72, 10, 0, 27],
  [-38, 30, -8, 35],
  [6, 44, 0, 43],
  [52, 30, -6, 35],
  [88, 10, 0, 25],
  [-20, 8, 16, 30],
  [34, 6, 18, 32],
]
const PLANET = [P.magenta, P.pink, P.purple, P.pink]

// Everything tunable. Lengths are design units: the hero is `width` units wide.
export const settings = {
  maxPixelRatio: 2,
  maxPixels: 6.2e6, // the most the picture is drawn with, however big the screen
  speed: 1,
  liquid: {
    wavelength: 92, // width of one ring of colour as it leaves the sun
    rate: 0.5, // rings the sun gives off each second
    rays: 16, // wedges the rings are cut into (even; 0 for plain rings)
    cell: 6, // design units per velocity texel
    solve: 14, // pressure iterations
    warm: 200, // steps run before the first frame, so it starts already marbled
    mirrors: 8, // the liquid is shown through a kaleidoscope of this many mirrored pairs round the sun (0 for none)
    turn: 0.02, // how fast the kaleidoscope turns, radians a second
    soft: 0.96, // how sharp the mirrors' seams are: 1 is a hard crease, less is a rounder fold
  },
  wide: {
    width: 1440, // the hero is at least this many design units wide
    height: 900, // and at least this many tall; one or the other is exact
    line: 3.4, // pen width
    band: 78, // ribbon thickness
    clouds: [
      [-55, 250, 0.9, 0], // x (from the right edge if negative), y (from the bottom if negative), scale, kind
      [70, -210, 1.3, 1],
      [20, -80, 1.15, 2],
    ],
    // Inside the .scene box: x and y as shares of its width and height, scale as a share of its width.
    aim: Math.PI, // the slice of the fluid the kaleidoscope repeats points this way from the sun
    planet: [139, 140, 65], // x, y, radius
    flowers: [
      [78, -58, 104], // x, y up from the hero's bottom edge, radius
      [228, -6, 58],
    ],
    focal: 760, // the lens the land is seen through, in design units
    sun: [0.0, 0.435, 0.15],
    sceneClouds: [
      [-0.3, 0.2, 0.00085],
      [0.42, 0.12, 0.00066],
    ],
    // The 3D terminal: where its middle sits in the box, box widths per world unit, and the view angles.
    machine: { at: [0.62, 0.68], size: 0.22, yaw: 0.52, pitch: 0.25 },
  },
  narrow: {
    width: 600,
    height: 0, // as tall as its content
    line: 4,
    band: 64,
    clouds: [
      [420, 70, 0.95, 0],
      [530, 660, 0.9, 1],
      [20, -505, 1.0, 2],
    ],
    aim: -Math.PI / 2,
    planet: [108, 76, 44],
    flowers: [
      [40, -70, 96],
      [560, -20, 60],
    ],
    focal: 520,
    horizon: 330, // the land comes higher up a tall screen
    sun: [0.66, 0.1, 0.105],
    sceneClouds: [
      [0.4, 0.16, 0.00085],
      [0.53, 0.3, 0.00066],
    ],
    machine: { at: [0.6, 0.72], size: 0.2, yaw: 0.52, pitch: 0.25 },
  },
}

// The land the picture flies over. Lengths are world units.
const LAND = {
  horizon: 205, // design units above the hero's bottom edge
  eye: 4.6, // how high the eye flies
  far: 240, // past this the land is lost in haze
  speed: 1.6, // how fast the eye flies up the valley, a second
  mini: 0.9, // the size of a little walker
}

// The terminal's parts, in world units. Shared by the shader and by the page,
// which pins the real prompt text onto the glass.
const MACHINE = {
  target: [0.02, 0.45, 0],
  monitor: { centre: [0, 0.64, -0.04], half: [0.5, 0.41, 0.42] },
  glass: { centre: [0, 0.035], half: [0.375, 0.27], depth: 0.05 },
  neck: { centre: [0, 0.19, -0.06], half: [0.36, 0.045, 0.3] },
  base: { centre: [0.04, 0.075, 0.03], half: [0.72, 0.075, 0.5] },
}
const f = (n) => (Number.isInteger(n) ? `${n}.0` : `${n}`)

// Night is day's colours turned: warm goes to blue and violet, teal to mint.
// LAMP undoes it, for lights that should stay warm after dark.
const NIGHT = [
  [0.08, 0.08, 0.6],
  [0, 0.76, 0.24],
  [0.48, 0.24, 0.48],
]
const inverse = (m) => {
  const [[a, b, c], [d, e, g], [h, i, j]] = m
  const det = a * (e * j - g * i) - b * (d * j - g * h) + c * (d * i - e * h)
  return [
    [(e * j - g * i) / det, (c * i - b * j) / det, (b * g - c * e) / det],
    [(g * h - d * j) / det, (a * j - c * h) / det, (c * d - a * g) / det],
    [(d * i - e * h) / det, (b * h - a * i) / det, (a * e - b * d) / det],
  ]
}
// WGSL matrices are written a column at a time.
const mat3 = (m) => `mat3x3f(${[0, 1, 2].map((col) => m.map((row) => row[col].toFixed(5)).join(', ')).join(', ')})`
const v3 = (a) => `vec3f(${a.map(f).join(', ')})`
const v2 = (a) => `vec2f(${a.map(f).join(', ')})`

const vec3 = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `vec3f(${((n >> 16) / 255).toFixed(4)}, ${(((n >> 8) & 255) / 255).toFixed(4)}, ${((n & 255) / 255).toFixed(4)})`
}
const list = (type, items) => `array<${type}, ${items.length}>(${items.join(', ')})`

// The audit. Compliance officers from NormalScript come down out of the sky in
// a row, all alike, and march up the valley in step, laying it grey behind
// them; then the valley deals with them, one at a time. Times are seconds
// after it begins.
const AUDIT = {
  first: 74, // when it first happens on its own, seconds in
  every: [110, 150], // and how long until the next: between these
  land: 3.2, // how long they take to come down
  flower: 5.0, // one takes root
  balloon: 6.3, // one's briefcase fills with air
  jump: 7.6, // the terminal jumps; it lands 0.9 s later and one of them is thrown in the river
  roar: 9.9, // the sun opens its mouth for one
  turn: 0.45, // how long after that one is gone the last of them stops
  tall: 3.2, // how tall an officer is, in world units
  gap: 2.15, // how far apart they march
  pace: 0.8, // how long their step is
  far: 26, // how far off they march
}

export const shader = /* wgsl */ `
struct Uniforms {
  frame: vec4f,    // canvas width and height in pixels, time, design width
  look: vec4f,     // the way to the light on screen (x, y), pen width
  liquid: vec4f,   // ring wavelength, phase of the ring leaving the sun now, wedge count, mirrored pairs
  dye: vec4f,      // dye texture width and height, hero height in design units, the way the kaleidoscope's slice points
  pointer: vec4f,  // x, y, strength
  sun: vec4f,      // x, y, face radius (0 hides it)
  scene: vec4f,    // x, y, width, height of the box holding rainbow, hills and terminal
  camRight: vec4f, // the terminal's camera: screen right, screen up, and the way back to the eye
  camUp: vec4f,
  camBack: vec4f,
  machine: vec4f,  // where the terminal's middle lands (x, y), design units per world unit (0 hides it), strides walked
  sunRight: vec4f, // the sun's own camera
  sunUp: vec4f,
  sunBack: vec4f,
  planet: vec4f,   // x, y, radius (0 hides it and the stars)
  lean: vec4f,     // how far the pointer has pulled the view, x and y; how far round the sun's short flames have turned, and its long ones
  title: vec4f,     // the lettering's box: x, y, width, height (0 width hides it)
  titleInfo: vec4f, // its distance field: range, outline width, shadow offset x and y, all in texels
  titleSize: vec4f, // texture width and height, and how many texels deep its alpha reaches
  flowers: array<vec4f, 2>, // x, y, radius (0 hides it)
  clouds: array<vec4f, 6>,
  beam: vec4f,     // where the sun's lasers land (x, y) and their power, 0 to 1
  mood: vec4f,     // the sun: eyes alight 0 to 1, maw open 0 to 1, crying 0 to 1, tears of blood (1) or water (0)
  blooms: array<vec4f, 12>,     // grown flowers: where the foot is (x, y), time born, time set alight (0 if never)
  bloomLooks: array<vec4f, 12>, // their head size and a seed for everything else
  weather: vec4f,  // rain 0 to 1, seconds since lightning struck, where the bolt lands (x) and a seed for its shape
  sky: vec4f,      // rainbow 0 to 1, blood in the liquid 0 to 1, how far below its place the sun is, how far its light reaches
  bolt: vec4f,     // the height the bolt starts from, and the height it lands at
  critters: array<vec4f, 8>,    // little walkers: x, z, the way they face, where they are in their gait
  critterHows: array<vec4f, 8>, // struck down 0 to 1, seed, stride 0 to 1, how far they dip to their work
  world: vec4f,    // the eye flying up the valley: x, z; the water's height; the lens in design units
  orb: vec4f,      // sun (0) or moon (1), how far round the wheel they are as they change places (0 when still, above 0 toward night, below toward day), night 0 to 1, the vanishing point's x
  sites: array<vec4f, 8>, // what is being built: x, z, how much is built (0 to 1) plus how much of the wire to the next is strung (0 to 1), family + fractional variation seed
  gait: vec4f,     // the terminal's stride in its own ground plane (x, z), how high its body rides, and how far its boots are off the ground in a jump
  pulse: vec4f,    // a building just finished: where (x, y), seconds ago, design units per world unit there
  grade: vec4f,    // the mood: what every colour is multiplied by
  motes: array<vec4f, 24>, // sparks and confetti: x, y, how much life is left (1 to 0), kind (0 spark, 1 confetti, 2 petal, 3 sigil) plus a seed
  face: vec4f,     // the sun's look: brows from sorrow (-1) to anger (1), lids from wide (-1) to shut (1), mouth from frown (-1) to grin (1), mouth rounded in a gasp 0 to 1
  eyes: vec4f,     // its eyes: rolled back 0 to 1, lit from inside 0 to 1, the hue they light in, pupils widened 0 to 1
  script: array<vec4f, 5>, // what the terminal has written, oldest line first: seed, length in signs, how many are written yet, the sign it opens with
  scriptInfo: vec4f,       // how far the lines have still to scroll up (1 to 0), how many lines there are
  lift: vec4f,     // the planet's beam: where it lands (x, y), how strong it is (0 to 1), seconds since it came on
  motesBox: vec4f, // the box every spark in the air is inside, in design units: least x and y, greatest x and y
  misc: vec4f,     // how high on the hero the tallest flower reaches (y); how much faster than usual the picture flies; how hard it shakes; how far the mandala has unfolded
  scorches: array<vec4f, 16>, // where the lasers have burnt the ground: x, z, when, and how wide
  stomps: array<vec4f, 12>, // where the terminal's boots last came down: x, z, when, and how big the boot is there (below zero if it came down in water)
  spare: array<vec4f, 2>,
  snake: array<vec4f, 24>, // from nose to tail: projected x, y, radius, world depth from the eye
  snakeBox: vec4f, // min and max corners in design units, including tongue and shadow
  snakeLook: vec4f, // head axis (screen x, y), tongue extension, blink phase
  officers: array<vec4f, 32>, // the audit: see officerInk in createShow
  watch: vec4f, // gaze on the unit globe, radius of pupil, appetite
  boss: vec4f, // scan-band occupation, whole takeover (vs teaser), tape damage, seed
  villageBounds: array<vec4f, 8>, // each site's projected extent, including room for ink and heave
  villageBand: vec4f, // union of those rectangles
  vCoil: array<vec4f,24>, // world spine (x,y,z,r)
  vFloor: array<vec4f,24>, // terrain contact: projected x,y, forward depth, strength
  vHead: vec4f, vSide: vec4f, vStamp: vec4f,
  vRuns: array<vec4f,4>, // enclosing rectangles of six successive segments and their shadows
  bossRig: vec4f, // yaw, nod, jaw hinge, seconds on camera
  comet: array<vec4f,4>, // two billboards: xy, width, atlas row / trail direction xy, angle, impact age
  fireBox: vec4f, // union of projected fire, smoke and receivers (design units)
  fireDesk: vec4f, // visible cells, case damage, time since contact, repair sparks
  fireGrid: array<vec4f, 16>, // 8x8 screen bins, each an exact 24-bit integer
  fireBase: array<vec4f, 24>, // centre of footprint: x, y, z; growing radius
  fireDraw: array<vec4f, 24>, // projected foot of moving flame, units/metre, depth
  fireLife: array<vec4f, 24>, // flame, smoke, black earth, independent phase
  fireForm: array<vec4f, 24>, // plume width, height, slope, wet steam
  fireSites: array<vec4f, 2>, // burning windows by site
  fireHaze: vec4f, // the box above the flames where the air shimmers (design units)
  fireHazeK: vec4f, // how hot it is there (0 to 1), design units per world unit
  talk: vec4f, // the sun (or moon) speaking: lips apart, rounded, teeth shown, tongue tip shown, 0 to 1
  talkFace: vec4f, // brows raised, a blink, how much the talking mouth has taken over (0 to 1)
  cosmos: vec4f,    // space behind the paint (see show.cosmos): how far the paint has parted (0 to 1), seconds since it began, unused, how far everybody is singing (0 to 1)
  chorusBeat: vec4f, // the chorus: beats since it began, how wide the mouths are open (0 to 1), how far it has swelled (0 to 1)
  stars: array<vec4f, 14>, // the stars that play: x, y, seconds since each last sang; the star its thread came from times 4, plus its kind, plus 0.9 times how loud
  deskStamp: vec4f, // where the terminal's own picture (deskMap) lies on the canvas: its corner in pixels
  walkerBox: array<vec4f, 8>,  // each little walker's rectangle on the canvas in pixels (x0, y0, x1, y1; empty when it is not drawn)
  walkerTile: array<vec4f, 8>, // and what to add to a pixel of it to find it in walkerMap
  villageTile: array<vec4f, 8>, // what to add to a pixel of each building to find it in walkerMap
  legs: array<vec4f, 18>, // the terminal's joints for the moment, set by poseTerminal: its six hips, then knees, then feet
  walkerLegs: array<vec4f, 144>, // each little walker's joints for the moment, set by poseWalkers: 18 each, its hips, knees and feet
  heaving: array<vec4f, 12>, // for each footfall still moving the ground: how hard and live it is, the wave's radius, its height, the dent's depth
  cloudTile: array<vec4f, 6>, // what to add to a pixel of each cloud's rectangle to find it in cloudMap
  sunStamp: vec4f, // where the sun's own picture (sunMap) lies on the canvas: its corner in pixels
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var titleMap: texture_2d<f32>;
@group(0) @binding(2) var titleSampler: sampler;
const viperActive = true;
@group(0) @binding(5) var vInk: texture_2d<f32>;
@group(0) @binding(6) var vDepth: texture_2d<f32>;
@group(0) @binding(3) var dyeMap: texture_2d<f32>;
@group(0) @binding(4) var faceMap: texture_2d<f32>; // depth-tested transparent head render
@group(0) @binding(7) var daxMap: texture_2d<f32>;
@group(0) @binding(8) var cometMap: texture_2d<f32>;
@group(0) @binding(9) var fireMap: texture_2d<f32>;
@group(0) @binding(10) var deskMap: texture_2d<f32>; // the terminal, drawn by drawDesk: colour and coverage
@group(0) @binding(11) var walkerMap: texture_2d<f32>; // the little walkers, drawn by drawWalker: colour and distance
@group(0) @binding(14) var cloudMap: texture_2d<f32>; // the clouds, drawn by cloudMain before the picture (not for the takeover)
@group(0) @binding(13) var skyMap: texture_2d<f32>;
@group(0) @binding(15) var sunMap: texture_2d<f32>; // the sun or the moon, drawn by sunMain before the picture (not for the takeover) // the sky, drawn by skyMain before the picture (not for the takeover)
@group(0) @binding(12) var walkerInk: texture_2d<f32>; // and their ink and edge // art/fire.png: flame heat in red, smoke in green, 8x8 frames
const takeoverLive: bool = true;
const cosmosLive: bool = false; // on only in the pipelines drawn while the cosmos or the chorus is on (see createLiquid)
var<private> daxBand: bool;
var<private> orbMoon: f32; // whether the body being drawn at this pixel is the moon

const TAU = 6.283185307;
const INK = ${vec3(INK)};
const PAPER = ${vec3(PAPER)};
const YELLOW = ${vec3(P.yellow)};
const AMBER = ${vec3(P.amber)};
const ORANGE = ${vec3(P.orange)};
const RED = ${vec3(P.red)};
const MOSS = ${vec3(P.moss)};
const GREEN = ${vec3(P.green)};
const LIME = ${vec3(P.lime)};
const SEA = ${vec3(P.sea)};
const PINK = ${vec3(P.pink)};
const PURPLE = ${vec3(P.purple)};
const TEAL = ${vec3(P.teal)};
const AQUA = ${vec3(P.aqua)};
const HAZE = ${vec3('#9bb8a8')};
const HAZE_FAR = ${vec3('#7f8fc0')};
const NIGHT = ${mat3(NIGHT)};
const LAMP = ${mat3(inverse(NIGHT))};
const EYE = ${f(LAND.eye)};
const FAR = ${f(LAND.far)};
const MINI = ${f(LAND.mini)};
const SUNWARD = vec3f(-0.5064, 0.7494, -0.4253); // the way to the light, over the eye's left shoulder
const SUN_MID = ${vec3('#f8ab28')};
const SUN_SHADE = ${vec3('#ef8623')};
const MOON_LIGHT = ${vec3('#fff6e0')};
const MOON_MID = ${vec3('#e3d3c2')};
const MOON_SHADE = ${vec3('#8f86b8')};
const LIGHT = vec3f(-0.4494, 0.799, 0.3995); // from the upper left, a little toward the eye
const CASE_LIGHT = ${vec3('#f8e8c4')};
const CASE_MID = ${vec3('#ecd0a0')};
const CASE_SHADE = ${vec3('#c69d69')};
const TARGET = ${v3(MACHINE.target)};
const MON_C = ${v3(MACHINE.monitor.centre)};
const MON_B = ${v3(MACHINE.monitor.half)};
const GLASS_C = ${v2(MACHINE.glass.centre)};
const GLASS_B = ${v2(MACHINE.glass.half)};
const WELL = ${f(MACHINE.glass.depth)};
const NECK_C = ${v3(MACHINE.neck.centre)};
const NECK_B = ${v3(MACHINE.neck.half)};
const BASE_C = ${v3(MACHINE.base.centre)};
const BASE_B = ${v3(MACHINE.base.half)};

@vertex
fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

// Tables that never change, in constant memory rather than in every pixel's own (see stage1.py in .preview/perf-frame).
const K_BOW_0 = ${list('vec3f', RAINBOW.map(vec3))};
const K_CRATERS_1 = array<vec3f, 5>(vec3f(-0.62, 0.5, 0.11), vec3f(0.7, -0.3, 0.12), vec3f(-0.74, -0.22, 0.085), vec3f(0.42, 0.74, 0.075), vec3f(-0.3, -0.8, 0.06));
const K_STARS_2 = array<vec3f, 3>(vec3f(-1.49, 0.98, 0.14), vec3f(1.68, 1.35, 0.13), vec3f(-0.70, -1.54, 0.11));
const K_LACQUERS_3 = array<vec3f,4>(RED, TEAL, ${vec3('#de5095')}, ${vec3('#7950a8')});
const K_PAPERS_4 = array<vec3f,4>(${vec3('#ffdba1')}, ${vec3('#f6d6b3')}, ${vec3('#a4e4d4')}, ${vec3('#ffcc90')});
const K_SHELLS_5 = array<vec3f, 5>(CASE_MID, ${vec3('#f0a3c4')}, ${vec3('#8fd6c8')}, ${vec3('#f5cf63')}, ${vec3('#b9a0e8')});
const K_CLOUD_LIGHT_6 = ${list('vec3f', CLOUD_LIGHT.map(vec3))};
const K_CLOUD_BODY_7 = ${list('vec3f', CLOUD_BODY.map(vec3))};
const K_CLOUD_SHADE_8 = ${list('vec3f', CLOUD_SHADE.map(vec3))};
const K_PUFFS_9 = ${list('vec4f', CLOUD.map((c) => `vec4f(${c.map(f).join(', ')})`))};
const K_TINTS_10 = array<vec3f, 4>(PAPER, AQUA, YELLOW, PINK);
const K_HUES_11 = array<vec3f, 4>(AQUA, YELLOW, PINK, LIME);
const K_DYES_12 = array<vec3f, 6>(TEAL, PINK, YELLOW, AQUA, ORANGE, PAPER);
const K_REVERSE_DYES_13 = array<vec3f, 6>(AQUA, PURPLE, ORANGE, TEAL, PINK, YELLOW);
const K_BANDS_14 = ${list('vec3f', BANDS.map(vec3))};
const K_STEPS_15 = array<vec3f, 8>(GREEN, MOSS, SEA, LIME, YELLOW, AMBER, PINK, PURPLE);

fn hash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2f(1.0, 0.0)), s.x),
    mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), s.x),
    s.y,
  );
}

fn fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 3; i++) {
    sum += amp * noise(q);
    q = mat2x2f(1.6, 1.2, -1.2, 1.6) * q + 17.0;
    amp *= 0.5;
  }
  return sum / 0.875;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn turn(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

// Flat poster colour that leans slowly toward its neighbour across a shape,
// printed on paper with a little tooth. at moves with the flow; still does not.
fn paint(base: vec3f, mate: vec3f, at: vec2f, still: vec2f, seed: f32) -> vec3f {
  let lean = fbm(at * 0.0042 + vec2f(seed * 7.31, seed * 3.17));
  let c = mix(base, mate, smoothstep(0.38, 0.82, lean) * 0.26);
  return c * (0.972 + 0.05 * noise(still * 2.3));
}

// Coverage of a shape whose edge is dist pixels away (positive inside).
fn fill(dist: f32) -> f32 {
  return smoothstep(-0.7, 0.7, dist);
}

// 1 on a pen line of half-width pen, given the distance to it, both in pixels.
fn stroke(dist: f32, pen: f32) -> f32 {
  return 1.0 - smoothstep(pen - 0.7, pen + 0.7, dist);
}

fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// A sign of the script nobody can read: a few strokes between the points of a
// three by four grid, and sometimes a ring. p is in the sign's own box, 0 to 1
// each way. Returns the distance to the nearest stroke.
fn rune(p0: vec2f, seed: f32) -> f32 {
  var p = p0;
  // Half of them are the same on both sides, like a face or a tree, and some stand on their heads.
  if (hash(vec2f(seed, 70.0)) > 0.5) { p.x = 0.5 - abs(p.x - 0.5); }
  if (hash(vec2f(seed, 72.0)) > 0.7) { p.y = 1.0 - p.y; }
  var best = 1e9;
  let count = 3 + i32(hash(vec2f(seed, 71.0)) * 3.0);
  for (var i = 0; i < 5; i++) {
    if (i >= count) { break; }
    let k = f32(i) * 3.1;
    let a = vec2f(floor(hash(vec2f(seed, k)) * 3.0), floor(hash(vec2f(seed, k + 1.0)) * 4.0));
    let way = i32(hash(vec2f(seed, k + 2.0)) * 4.0);
    let b = clamp(a + select(select(select(vec2f(1.0, -1.0), vec2f(1.0, 1.0), way == 2), vec2f(0.0, 1.0), way == 1), vec2f(1.0, 0.0), way == 0), vec2f(0.0), vec2f(2.0, 3.0));
    let start = a * vec2f(0.5, 0.3333);
    let run = b * vec2f(0.5, 0.3333) - start;
    let off = p - start;
    let sort = hash(vec2f(seed, k + 2.6));
    if (sort < 0.5 || dot(run, run) < 0.001) {
      // A straight stroke.
      best = min(best, length(off - run * clamp(dot(off, run) / max(dot(run, run), 1e-5), 0.0, 1.0)));
    } else if (sort < 0.76) {
      // A bow drawn between the same two points.
      let mid = start + run * 0.5;
      let r = length(run) * 0.5;
      let side = dot(p - mid, vec2f(-run.y, run.x)) * select(-1.0, 1.0, sort < 0.63);
      best = min(best, select(min(length(off), length(p - start - run)), abs(length(p - mid) - r), side >= 0.0));
    } else if (sort < 0.9) {
      // A dot, and a stroke half as long.
      best = min(best, max(length(p - start - run) - 0.045, 0.0));
      best = min(best, length(off - run * clamp(dot(off, run) / max(dot(run, run), 1e-5), 0.0, 0.5)));
    } else {
      // A small ring.
      best = min(best, abs(length(p - start - run * 0.5) - 0.1));
    }
  }
  let extra = hash(vec2f(seed, 77.0));
  if (extra > 0.6) {
    let middle = vec2f(0.5, 0.3333 * (1.0 + floor(hash(vec2f(seed, 78.0)) * 2.0)));
    best = min(best, select(abs(length(p - middle) - 0.17), max(length(p - middle) - 0.06, 0.0), extra > 0.85));
  }
  return best;
}

// The terminal's face, which comes up on its screen when something startles
// it: wide eyes that look at whatever it is, and a mouth that opens with fright.
fn startled(screen: vec3f, uv: vec2f, px: f32, pen: f32, t: f32, fright: f32, gaze: vec2f) -> vec3f {
  let unit = 0.26 * px;
  let phosphor = vec3f(0.55, 1.0, 0.6) * 1.9;
  let at = uv + fright * 0.03 * vec2f(sin(t * 53.0), cos(t * 47.0));
  // It blinks, unless it is too frightened to.
  let lid = fract(t * 0.37);
  let blink = smoothstep(0.0, 0.025, lid) * (1.0 - smoothstep(0.045, 0.085, lid)) * (1.0 - smoothstep(0.2, 0.5, fright));
  let eye = vec2f(abs(at.x) - 0.42, (at.y - 0.2) / (1.0 - 0.9 * blink));
  let wide = 0.23 + 0.07 * fright;
  var color = vec3f(0.03, 0.07, 0.045) + screen * 0.12;
  color = mix(color, phosphor, stroke(abs(length(eye) - wide) * unit, pen * 0.75));
  color = mix(color, phosphor, fill((0.1 - 0.035 * fright - length(eye - gaze * vec2f(sign(at.x), 1.0) * vec2f(sign(at.x), 1.0) * 0.1)) * unit));
  let brow = abs(eye.y - wide - 0.12 - 0.1 * fright + 0.25 * eye.x * eye.x);
  color = mix(color, phosphor, stroke(brow * unit, pen * 0.6) * step(abs(eye.x), 0.24));
  let gape = vec2f(0.12 + 0.05 * fright, 0.05 + 0.2 * fright * (0.8 + 0.2 * sin(t * 21.0)));
  let mouth = (length((at - vec2f(0.0, -0.44)) / gape) - 1.0) * min(gape.x, gape.y);
  color = mix(color, phosphor, stroke(abs(mouth) * unit, pen * 0.75));
  return color;
}

// What the terminal has written on its screen: lines of signs, the newest
// being written a sign at a time with a block cursor after it. Every line opens
// with the sign of what happened, in its own colour. uv is the place on the
// glass, -1 to 1 each way; px is pixels per unit of the terminal.
fn written(screen: vec3f, uv: vec2f, px: f32, pen: f32, t: f32) -> vec3f {
  let count = u.scriptInfo.y;
  let col = (uv.x + 0.84) / 1.68 * 8.0;
  let row = (0.8 - uv.y) / 1.6 * 4.0;
  let rowAt = row + max(count - 4.0, 0.0) - u.scriptInfo.x;
  let line = floor(rowAt);
  if (col < 0.0 || col >= 8.0 || row < 0.0 || row > 4.0 || line < 0.0 || line >= count) { return screen; }
  let script = u.script[i32(line)];
  let c = floor(col);
  let gp = (vec2f(fract(col), 1.0 - fract(rowAt)) - 0.5) * vec2f(1.3, 1.5) + 0.5;
  let fade = smoothstep(0.0, 0.4, row);
  let phosphor = vec3f(0.55, 1.0, 0.6) * 1.8;
  let done = min(script.z, script.y);
  var color = screen;
  if (c == 0.0) {
    let tint = 0.55 + 0.45 * cos(TAU * (script.w * 7.0 + vec3f(0.0, 0.33, 0.67)));
    color = mix(color, tint * 2.3, fade * stroke(rune(gp, script.w * 100.0) * 0.07 * px, pen * 0.7));
  } else if (c - 1.0 < done) {
    let seed = script.x + c * 1.7;
    if (hash(vec2f(seed, 5.0)) > 0.14) {
      color = mix(color, phosphor, fade * clamp(done - c + 1.0, 0.0, 1.0) * stroke(rune(gp, seed) * 0.07 * px, pen * 0.55));
    }
  } else if (line == count - 1.0 && c - 1.0 == ceil(done)) {
    let block = roundRect(gp - 0.5, vec2f(0.34, 0.42), 0.05) * 0.07 * px;
    color = mix(color, phosphor, fade * fill(-block) * (0.55 + 0.45 * step(0.5, fract(t * 1.2))));
  }
  return color;
}

// One flame of the sun in polar form: how far inside its edge the point is (x)
// and how far inside its hot streak (y), in face radii. Flames are leaf-shaped:
// they touch at the face, swell, then taper to a wavering tip.
fn flame(r: f32, theta: f32, index: f32, seed: f32, reach: f32, t: f32) -> vec2f {
  let phase = hash(vec2f(index, seed)) * TAU;
  let len = reach * (1.0 + 0.05 * sin(t * 0.5 + phase));
  let along = clamp((r - 0.9) / (len - 0.9), 0.0, 1.0);
  var delta = theta - index * TAU / 16.0;
  delta -= TAU * round(delta / TAU);
  let lick = 0.34 * sin(along * 5.6 - t * 0.7 + phase) * pow(along, 1.3);
  let side = abs(delta * r - lick);
  let w = r * 0.2 * pow(1.0 - along, 0.8) - 0.012;
  if (r >= len) { return vec2f(-1.0, -1.0); }
  return vec2f(w - side, w * 0.36 - side - 0.03 - 0.3 * smoothstep(0.55, 1.0, along));
}

// The sun's face, or the moon's. p is in face radii, y down. Returns the
// colour over base. u.face and u.eyes say what look is on it.
// Where something on the calm face has got to once the maw has pushed it out of
// the way (the inverse of what face() does to find what is under a point).
fn crowded(q: vec2f, maw: f32, t: f32) -> vec2f {
  let agape = maw * maw * (3.0 - 2.0 * maw);
  let breath = 1.0 + 0.012 * sin(t * 5.0) * agape;
  let mawC = vec2f(0.0, mix(0.43, 0.24, agape));
  let mawRx = mix(0.2, 0.62, smoothstep(0.0, 0.62, maw)) * breath;
  let mawRy = max(0.62 * smoothstep(0.04, 1.0, maw) * breath, 0.0005);
  let fromMaw = q - mawC;
  let mawFar = max(length(fromMaw), 1e-4);
  let mawDir = fromMaw / mawFar;
  let mawR = mawRx * mawRy / length(vec2f(mawRy * mawDir.x, mawRx * mawDir.y));
  let lipR = mawR * mix(1.0, 1.17, smoothstep(0.0, 0.5, maw));
  let toRim = dot(mawC, mawDir);
  let rim = max(-toRim + sqrt(max(toRim * toRim - dot(mawC, mawC) + 0.94, 0.0)), lipR + 0.02);
  let squeeze = (rim - lipR) / rim;
  return mawC + mawDir * (mawFar * squeeze + lipR);
}

fn face(p0: vec2f, base: vec3f, pen: f32, unit0: f32, gaze: vec2f, alight: f32, maw: f32, t: f32) -> vec3f {
  // When the maw opens the whole face makes room for it: the mouth it has
  // stretches wide, the jaw drops, and everything else is pushed out from the
  // hole and crowded against the rim of the head.
  let agape = maw * maw * (3.0 - 2.0 * maw);
  let breath = 1.0 + 0.012 * sin(t * 5.0) * agape;
  let mawC = vec2f(0.0, mix(0.43, 0.24, agape));
  let mawRx = mix(0.2, 0.62, smoothstep(0.0, 0.62, maw)) * breath;
  let mawRy = max(0.62 * smoothstep(0.04, 1.0, maw) * breath, 0.0005);
  let fromMaw = p0 - mawC;
  let mawFar = max(length(fromMaw), 1e-4);
  let mawDir = fromMaw / mawFar;
  let mawR = mawRx * mawRy / length(vec2f(mawRy * mawDir.x, mawRx * mawDir.y));
  let lipR = mawR * mix(1.0, 1.17, smoothstep(0.0, 0.5, maw));
  let toRim = dot(mawC, mawDir);
  let rim = max(-toRim + sqrt(max(toRim * toRim - dot(mawC, mawC) + 0.94, 0.0)), lipR + 0.02);
  let squeeze = (rim - lipR) / rim;
  let p = mawC + mawDir * max(mawFar - lipR, 0.0) / squeeze;
  let unit = unit0 * mix(1.0, squeeze, 0.5);
  let m = vec2f(abs(p.x), p.y);
  let side = select(-1.0, 1.0, p.x >= 0.0);
  var c = base;
  let anger = max(u.face.x, 0.0);
  let sorrow = max(-u.face.x, 0.0);
  let smile = u.face.z;
  let glad = max(smile, 0.0);
  let gasp = u.face.w;
  let roll = u.eyes.x;
  let glow = u.eyes.y;
  let tint = 0.5 + 0.5 * cos(TAU * (u.eyes.z + vec3f(0.0, 0.33, 0.67)));

  // Cheeks that flush when it smiles, and shadow between brow and lid.
  let cheek = m - vec2f(0.53, 0.2 - 0.03 * glad);
  c = mix(c, mix(ORANGE, RED, 0.4 * glad), (0.3 + 0.25 * glad) * exp(-dot(cheek, cheek) / 0.03));
  let socket = (m - vec2f(0.38, -0.37)) * vec2f(1.0, 2.1);
  c = mix(c, ORANGE, 0.42 * exp(-dot(socket, socket) / 0.035));

  // Eyes: an almond between two lids, heavy on top. The lids blink, droop,
  // squeeze and fly open; angry, they slant down toward the nose.
  let eye = vec2f(0.37, -0.215);
  let s = (m.x - eye.x) / 0.235;
  let span = max(1.0 - s * s, 0.0);
  let wink = fract(t * 0.19 + 0.4);
  let blink = smoothstep(0.0, 0.02, wink) * (1.0 - smoothstep(0.03, 0.085, wink)) * (1.0 - alight);
  let shut = clamp(max(max(u.face.y, blink), u.talkFace.y), 0.0, 1.0);
  let wide = max(-u.face.y, 0.0);
  let lower = eye.y + (0.064 - 0.024 * glad) * pow(span, 0.8) - 0.014 * s;
  let lidUp = eye.y - (0.108 + 0.05 * wide) * pow(span, 0.7) - 0.014 * s;
  let upper = mix(lidUp + (0.055 * anger * max(-s, 0.0) + 0.05 * sorrow * max(s, 0.0)) * span, lower - 0.006, shut);
  let open = step(abs(s), 1.0) * fill((m.y - upper) * unit) * fill((lower - m.y) * unit);
  var ball = vec3f(0.99, 0.94, 0.78);
  ball = mix(ball, vec3f(0.87, 0.72, 0.6), fill((upper + 0.032 - m.y) * unit)); // the lid's shadow
  // Both eyes look the same way, so undo the mirror for the gaze. In a trance they roll back.
  let centre = vec2f(eye.x - 0.012 + gaze.x * side, eye.y - 0.024 + gaze.y - 0.2 * roll);
  let iris = length(m - centre);
  let spoke = atan2(m.y - centre.y, m.x - centre.x);
  var ring = mix(vec3f(0.8, 0.5, 0.14), vec3f(0.52, 0.26, 0.07), smoothstep(0.04, 0.088, iris));
  ring = mix(ring, vec3f(0.36, 0.17, 0.05), 0.55 * step(0.5, fract(spoke / TAU * 16.0)) * step(0.05, iris));
  ball = mix(ball, ring, fill((0.09 - iris) * unit));
  ball = mix(ball, INK, stroke(abs(iris - 0.09) * unit, pen * 0.45));
  ball = mix(ball, INK, fill((0.043 * (1.0 + 0.5 * u.eyes.w) - iris) * unit));
  ball = mix(ball, vec3f(1.6), fill((0.02 - length(m - centre - vec2f(-0.03, -0.028))) * unit));
  ball = mix(ball, vec3f(1.25), fill((0.009 - length(m - centre - vec2f(0.03, 0.03))) * unit));
  // Firing, the whole eye burns: red, then yellow, then white at the middle.
  ball = mix(ball, RED, alight);
  ball = mix(ball, YELLOW * 1.6, alight * fill((0.1 - iris) * unit));
  ball = mix(ball, vec3f(3.0, 2.8, 2.4), alight * fill((0.05 - iris) * unit));
  // In a trance they light from inside, in whatever colour the moment is.
  ball = mix(ball, tint * (1.2 + 1.6 * glow) + 0.3, glow * (1.0 - 0.55 * fill((0.09 - iris) * unit)));
  c = mix(c, ball, open);

  var ink = 0.0;
  let inEye = step(abs(s), 1.0);
  ink = max(ink, inEye * stroke(abs(m.y - upper) * unit, pen * 1.5));
  ink = max(ink, inEye * stroke(abs(m.y - lower) * unit, pen * 0.7));
  // Lashes at the outer corner, a crease over the lid, a fold under the eye.
  ink = max(ink, stroke(segment(m, vec2f(eye.x + 0.225, eye.y - 0.012), vec2f(eye.x + 0.3, eye.y + 0.012)) * unit, pen * 0.9));
  ink = max(ink, (1.0 - shut) * stroke(segment(m, vec2f(eye.x + 0.2, eye.y - 0.058), vec2f(eye.x + 0.27, eye.y - 0.075)) * unit, pen * 0.7));
  ink = max(ink, (1.0 - shut) * stroke(segment(m, vec2f(eye.x + 0.155, eye.y - 0.09), vec2f(eye.x + 0.21, eye.y - 0.125)) * unit, pen * 0.6));
  ink = max(ink, step(abs(s - 0.05), 0.82) * stroke(abs(m.y - (lidUp - 0.052)) * unit, pen * 0.6));
  ink = max(ink, 0.6 * step(abs(s - 0.05), 0.55) * stroke(abs(m.y - (lower + 0.05)) * unit, pen * 0.5));

  // Brows: a crescent, thick in the middle. They tilt with the mood and lift in surprise.
  let b = (m.x - 0.39) / 0.275;
  let arch = max(1.0 - b * b, 0.0);
  let tilt = (0.06 * sorrow - 0.065 * anger) * b - 0.05 * wide - 0.035 * u.talkFace.x;
  let browTop = -0.452 - 0.1 * arch + tilt;
  let browLow = -0.445 - 0.058 * arch + tilt;
  ink = max(ink, step(abs(b), 1.0) * fill((m.y - browTop) * unit) * fill((browLow - m.y) * unit));
  // A frown line between them when it is angry.
  ink = max(ink, anger * stroke(segment(m, vec2f(0.05, -0.47), vec2f(0.075, -0.39)) * unit, pen * 0.6));

  // Nose: one side of the bridge, the wings, the tip.
  let n0 = vec2f(-0.125, -0.41);
  let n1 = vec2f(-0.07, -0.2);
  let n2 = vec2f(-0.075, 0.0);
  let n3 = vec2f(-0.125, 0.1);
  let bridge = min(min(segment(p, n0, n1), segment(p, n1, n2)), segment(p, n2, n3));
  ink = max(ink, stroke(bridge * unit, pen * 0.85));
  let wing = m - vec2f(0.1, 0.135);
  ink = max(ink, step(-0.02, wing.x + wing.y * 0.6) * stroke(abs(length(wing) - 0.062) * unit, pen * 0.85));
  let tip = 0.172 + 0.03 * max(1.0 - (m.x / 0.075) * (m.x / 0.075), 0.0);
  ink = max(ink, step(m.x, 0.075) * stroke(abs(m.y - tip) * unit, pen * 0.8));
  let nostril = (m - vec2f(0.062, 0.163)) * vec2f(1.0, 2.2);
  ink = max(ink, fill((0.027 - length(nostril)) * unit));

  // Mouth: a bowed upper lip over a fuller lower one. Its corners rise in a
  // grin and fall in a frown, and the lips part in a gasp.
  // Speaking (u.talk), the lips part and round with each sound and the smile eases off.
  let talk = u.talkFace.z;
  let pucker = u.talk.y * talk;
  let grin = (1.0 + 0.16 * glad) * (1.0 - 0.36 * pucker) * (1.0 + 0.06 * u.talk.z * talk);
  let k = m.x / (0.26 * grin);
  let mouth = 0.428 - (0.02 + 0.05 * mix(smile, min(smile, 0.12), talk)) * k * k + 0.012 * pucker;
  let gape = max(0.06 * gasp * (1.0 - talk), 0.1 * u.talk.x * talk) * sqrt(max(1.0 - k * k * mix(1.6, 1.05, pucker), 0.0));
  let bow = mouth - gape - 0.07 * pow(max(1.0 - k * k, 0.0), 0.62) + 0.034 * exp(-(m.x * m.x) / 0.0022);
  let j = m.x / (0.2 * grin);
  let under = mouth + gape + 0.004 + 0.09 * pow(max(1.0 - j * j, 0.0), 0.72);
  c = mix(c, RED, 0.92 * step(k, 1.0) * fill((m.y - bow) * unit) * fill((mouth - gape - m.y) * unit));
  c = mix(c, mix(ORANGE, RED, 0.25), 0.85 * step(j, 1.0) * fill((m.y - mouth - gape) * unit) * fill((under - m.y) * unit));
  c = mix(c, vec3f(0.26, 0.03, 0.07), step(0.003, gape) * fill((gape - abs(m.y - mouth)) * unit));
  if (talk > 0.01) {
    // Teeth under the top lip while the jaw is nearly shut, and the tongue's tip for th and l.
    let inside = step(0.003, gape) * fill((gape - abs(m.y - mouth)) * unit);
    let top = mouth - gape;
    let teeth = u.talk.z * talk * step(k, 0.8);
    c = mix(c, vec3f(1.0, 0.95, 0.84), inside * teeth * fill((top + 0.026 - m.y) * unit));
    ink = max(ink, inside * teeth * stroke(abs(m.y - top - 0.026) * unit, pen * 0.4));
    let tongue = (m - vec2f(0.0, mouth + gape * 0.55)) / vec2f(0.11, 0.035 + 0.6 * gape);
    c = mix(c, ${vec3('#d4434f')}, inside * u.talk.w * talk * fill((1.0 - length(tongue)) * 0.03 * unit));
  }
  c = mix(c, vec3f(1.45, 1.15, 0.95), 0.75 * fill((0.011 - length((m - vec2f(0.075, mouth + gape + 0.05)) * vec2f(0.3, 1.0))) * unit));
  ink = max(ink, step(k, 1.19) * stroke(abs(abs(m.y - mouth) - gape) * unit, pen * 1.1));
  ink = max(ink, step(k, 1.0) * stroke(abs(m.y - bow) * unit, pen * 0.65));
  ink = max(ink, step(j, 1.0) * stroke(abs(m.y - under) * unit, pen * 0.75));
  ink = max(ink, step(m.x, 0.085) * stroke(abs(m.y - (0.575 + gape + 0.012 * m.x / 0.085)) * unit, pen * 0.5));
  // A dimple at each corner of a grin.
  let dimple = m - vec2f(0.33 * grin, mouth - 0.01);
  ink = max(ink, glad * step(0.0, dimple.x) * stroke(abs(length(dimple) - 0.05) * unit, pen * 0.55) * step(abs(dimple.y), 0.045));

  // Chin.
  let chin = 0.735 + 0.028 * max(1.0 - (m.x / 0.14) * (m.x / 0.14), 0.0);
  ink = max(ink, step(m.x, 0.14) * stroke(abs(m.y - chin) * unit, pen * 0.6));

  // Finer work: a jewel on the brow that lights with the eyes, and a curl on each cheek.
  let jewel = (1.0 - abs(p.x) / 0.05 - abs(p.y + 0.66) / 0.085) * 0.043 * unit;
  c = mix(c, mix(RED, tint * 2.6 + 0.4, max(glow, alight)), fill(jewel));
  c = mix(c, vec3f(1.5, 1.2, 1.0), fill(jewel - 0.02 * unit) * step(p.x, 0.0));
  ink = max(ink, stroke(abs(jewel), pen * 0.6));
  ink = max(ink, 0.9 * fill((0.013 - min(length(m - vec2f(0.1, -0.66)), length(m - vec2f(0.17, -0.63)))) * unit));
  let curl = m - vec2f(0.56, 0.24 - 0.03 * glad);
  let curlFar = length(curl);
  let wind = abs(fract(curlFar / 0.034 - atan2(curl.y, curl.x) / TAU) - 0.5) * 0.034;
  ink = max(ink, 0.75 * stroke(wind * unit, pen * 0.4) * step(curlFar, 0.085) * step(0.012, curlFar));

  // It weeps, water or blood. A tear wells at the lid, runs down the cheek
  // gathering speed with a wet trail behind it, and drops from the jaw; the
  // trail dries before the next. Two to an eye, each on its own clock.
  if (u.mood.z > 0.01) {
    let tear = mix(${vec3('#86dcee')}, ${vec3('#c20f1d')}, u.mood.w);
    let fall = m.y - (eye.y + 0.06);
    c = mix(c, tear, 0.8 * u.mood.z * inEye * (1.0 - shut) * stroke(abs(m.y - lower + 0.012) * unit, pen * 0.6));
    for (var i = 0; i < 2; i++) {
      let n = f32(i);
      let clock = fract(t / 4.2 + n * 0.5 + 0.23 * step(0.0, p.x));
      let run = clamp(clock / 0.6, 0.0, 1.0);
      let head = 1.02 * run * run;
      let path = eye.x - 0.05 + 0.1 * n + (0.04 - 0.02 * n) * sin(fall * 6.0 + n * 2.0) + (0.12 - 0.1 * n) * fall;
      let girth = (0.007 + 0.013 * smoothstep(0.0, max(head, 0.01), fall)) * (1.0 - smoothstep(0.62, 0.95, clock)) * u.mood.z;
      let trail = (girth - abs(m.x - path)) * unit;
      let on = step(0.0, fall) * step(fall, head) * step(dot(p, p), 0.94) * step(0.002, girth);
      c = mix(c, tear, on * fill(trail));
      c = mix(c, vec3f(1.5), on * fill(trail - girth * 0.55 * unit) * step(m.x, path));
      ink = max(ink * (1.0 - on * fill(trail)), on * stroke(abs(trail), pen * 0.45));
      if (clock < 0.6) {
        let headX = eye.x - 0.05 + 0.1 * n + (0.04 - 0.02 * n) * sin(head * 6.0 + n * 2.0) + (0.12 - 0.1 * n) * head;
        let r = 0.036 * smoothstep(0.0, 0.1, clock) * u.mood.z;
        let off = vec2f(m.x - headX, fall - head);
        let drop = teardrop(off, r) * unit;
        let whole = step(dot(p, p), 0.94) * step(0.002, r);
        c = mix(c, tear, whole * fill(-drop));
        c = mix(c, mix(tear, vec3f(1.0), 0.5), whole * fill(-drop - r * 0.35 * unit));
        c = mix(c, vec3f(1.7), whole * fill((r * 0.3 - length(off - vec2f(-r * 0.3, -r * 0.1))) * unit));
        ink = max(ink * (1.0 - whole * fill(-drop)), whole * stroke(abs(drop), pen * 0.6));
      }
    }
  }

  // Sometimes the mouth opens into a sandworm's maw: pleated lips round a
  // ribbed gullet with a furnace at the bottom, and six rows of long hooked
  // fangs, each row smaller and darker than the last and turning against it.
  if (maw > 0.002) {
    // The mouth it has stretches wide, then the jaw drops and it rounds out as
    // it gapes. Everything inside is drawn for the full circle and squashed to fit.
    let wide = 0.47;
    // A tremor runs through it at full gape.
    let q = mawDir * (mawFar / mawR) * wide * (1.0 + 0.008 * agape * sin(t * 31.0 + mawFar * 40.0));
    let unit = unit0 * max(mawR, 0.002) / wide;
    let r = length(q);
    let a = atan2(q.y, q.x);
    let down = 1.0 - r / wide; // 0 at the lips, 1 at the middle
    var gullet = mix(${vec3('#7a0c1c')}, vec3f(0.09, 0.02, 0.04), smoothstep(0.05, 0.75, down));
    let rib = abs(fract(log(max(r / wide, 0.03)) * 3.2 - t * 0.7) - 0.5) * r / 3.2;
    gullet = mix(gullet, ${vec3('#b5161f')}, 0.7 * stroke(rib * unit, pen * 0.6) * (1.0 - smoothstep(0.3, 0.8, down)));
    // The furnace at the bottom lights last and goes out first.
    gullet += vec3f(3.0, 1.5, 0.35) * smoothstep(0.7, 1.0, down) * (0.8 + 0.2 * sin(t * 4.0)) * smoothstep(0.55, 1.0, maw);
    for (var k = 0; k < 6; k++) {
      let j = f32(k);
      let way = select(-1.0, 1.0, k % 2 == 0);
      let row = wide * 0.985 * pow(0.79, j);
      let sector = TAU / (30.0 - 4.0 * j);
      // Each row of fangs slides out of the gum after the one outside it.
      let len = row * 0.4 * smoothstep(0.22 + 0.07 * j, 0.62 + 0.07 * j, maw);
      if (len < 0.0005) { continue; }
      let depth = clamp((row - r) / len, -1.0, 2.0);
      let la = a + way * t * (0.45 + 0.3 * j) + j * 0.7 - way * 0.55 * sector * depth * depth;
      let local = la - sector * round(la / sector);
      let girth = 0.34 * sector * row * pow(max(1.0 - depth, 0.0), 0.75);
      let tooth = min(girth - abs(local) * r, min(depth, 1.0) * len) * unit;
      gullet = mix(gullet, INK, fill(tooth + pen));
      var enamel = mix(vec3f(1.0, 0.96, 0.84), ${vec3('#dfb273')}, step(0.0, local * way));
      enamel = mix(enamel, vec3f(1.5, 1.45, 1.3), stroke(abs(local * way * r + girth * 0.45) * unit, pen * 0.32) * step(0.12, depth));
      enamel = mix(enamel, ${vec3('#c4563a')}, 1.0 - smoothstep(0.0, 0.3, depth));
      gullet = mix(gullet, enamel * (1.0 - 0.12 * j), fill(tooth));
    }
    // Spit stretches between the lips as they part, thins, and snaps.
    for (var k = 0; k < 4; k++) {
      let n = f32(k);
      let sx = wide * (-0.5 + 0.33 * n + 0.05 * sin(n * 2.3));
      let chord = sqrt(max(wide * wide - sx * sx, 0.0));
      let snap = smoothstep(0.4 + 0.06 * n, 0.58 + 0.06 * n, maw);
      let thick = 0.016 * wide * (1.0 - 0.6 * smoothstep(0.1, 0.5, maw)) * (1.0 + 2.5 * pow(abs(q.y) / max(chord, 0.01), 3.0));
      let on = step(chord * snap, abs(q.y)) * step(abs(q.y), chord) * (1.0 - smoothstep(0.8, 0.97, maw));
      let strand = (thick - abs(q.x - sx - 0.014 * sin(q.y * 20.0 + t * 3.0 + n))) * unit0 * mawRx / wide;
      gullet = mix(gullet, vec3f(1.05, 0.84, 0.8), 0.85 * on * fill(strand));
    }
    var lip = mix(${vec3('#d8452a')}, ${vec3('#f2802d')}, fill((0.5 - abs(fract(a / TAU * 26.0) - 0.5) - 0.25) * r * 0.24 * unit));
    lip = mix(${vec3('#9e1f1c')}, lip, smoothstep(wide, wide * 1.09, r));
    // The lips swell out of the mouth's own as it opens.
    let lips = (wide * mix(1.0, 1.17, smoothstep(0.0, 0.5, maw)) - r) * unit;
    let appear = smoothstep(0.002, 0.07, maw);
    c = mix(c, mix(mix(c, lip, fill(lips)), gullet, fill((wide - r) * unit)), appear);
    ink = mix(ink, max(ink * (1.0 - fill(lips)), max(stroke(abs(lips), pen), stroke(abs(wide - r) * unit, pen))), appear);
  }

  return mix(c, INK, ink);
}

// The land: a river valley the picture flies up for ever. x is across, y up,
// z the way the eye is going. Keep river and ground in step with world.river
// and world.ground in the page's code.
fn river(z: f32) -> f32 {
  return 3.2 * sin(z * 0.045) + 1.4 * sin(z * 0.117 + 1.0);
}

// The land with the waves from the terminal's footfalls running through it.
fn ground(p: vec2f) -> f32 {
  return bed(p) + heaved(p);
}

// The land at rest.
fn bed(p: vec2f) -> f32 {
  let off = abs(p.x - river(p.y));
  let a = 0.5 + 0.5 * sin(p.x * 0.19 + 1.7 * sin(p.y * 0.083));
  let b = 0.5 + 0.5 * sin(p.y * 0.131 + 1.3 * sin(p.x * 0.097) + 2.0);
  return -0.75 + 0.55 * smoothstep(1.0, 3.2, off) + smoothstep(1.0, 14.0, off) * (0.35 + 2.7 * a * b + 0.3 * sin(p.x * 0.53 + p.y * 0.41));
}

fn eyeAt() -> vec3f {
  return vec3f(u.world.x, EYE, u.world.y);
}

// The ray from the eye through a point of the hero.
fn eyeRay(d: vec2f) -> vec3f {
  return normalize(vec3f(d.x - u.orb.w, u.dye.z - d.y - u.look.w, u.world.w));
}

// Where a point of the world lands on the hero (x, y), and how many design units a world unit covers there.
fn onHero(p: vec3f) -> vec3f {
  let k = u.world.w / max(p.z - u.world.y, 0.01);
  return vec3f(u.orb.w + (p.x - u.world.x) * k, u.dye.z - u.look.w - (p.y - EYE) * k, k);
}

// Follows a ray out to the land. Returns how far it went (-1 if it is lost in
// the haze), and for the nearest ridge it skimmed on the way, how many pixels
// clear it passed and how far off that was.
fn landAt(ro: vec3f, rd: vec3f, pxPerTurn: f32, until: f32) -> vec3f {
  var far = max((ro.y - 3.3) / -rd.y, 0.0);
  var last = far;
  var lastGap = 1e9;
  var graze = vec2f(1e9, 0.0);
  // (Once it is under the ground, the same loop halves the step it went under on five times.)
  var a = 0.0;
  var b = 0.0;
  var halving = 0;
  for (var i = 0; i < 101; i++) {
    if (halving == 0 && i >= 96) { break; }
    let at = select(far, 0.5 * (a + b), halving > 0);
    let p = ro + rd * at;
    let gap = p.y - ground(p.xz);
    if (halving > 0) {
      if (gap < 0.0) { b = at; } else { a = at; }
      halving += 1;
      if (halving > 5) { return vec3f(b, graze); }
      continue;
    }
    if (gap < 0.0) {
      a = last;
      b = far;
      halving = 1;
      continue;
    }
    if (gap > lastGap && lastGap / last * pxPerTurn < graze.x) { graze = vec2f(lastGap / last * pxPerTurn, last); }
    lastGap = gap;
    last = far;
    far += max(gap * 0.6, 0.012 * far);
    if (far > until) { break; }
  }
  return vec3f(-1.0, graze);
}

fn rotY(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(c, 0.0, -s), vec3f(0.0, 1.0, 0.0), vec3f(s, 0.0, c));
}

// The land's colours: striped fields on the valley floor, each in its hedge,
// and above them terraces banded by height like the liquid's rings, lit from
// one side. p is the point, far how far off it is.
// How far the waves running out from the terminal's footfalls lift the ground at a point.
fn heaved(at: vec2f) -> f32 {
  // The footfalls still moving the ground come first in the list; spare[0] says
  // how many there are and the circle they can reach.
  let reach = u.spare[0];
  if (reach.w < 0.5 || length(at - reach.xy) > reach.z) { return 0.0; }
  var heave = 0.0;
  for (var i = 0; i < 12; i++) {
    if (f32(i) >= reach.w) { break; }
    let k = u.heaving[i]; // (see packUniforms)
    let away = length(at - u.stomps[i].xy);
    let front = k.y;
    if (abs(away - front) > 5.5 && away > 3.5) { continue; }
    // It comes up out of nothing and dies away to nothing: a dent under the
    // boot that springs back, and a wave running out from it.
    heave += k.x * (k.z * sin((away - front) * 2.2) * exp(-pow((away - front) / 1.9, 2.0)) - k.w * exp(-away * away / 1.4));
  }
  return heave;
}

// The nearest print a boot has left in the ground: where a point is in it
// (across and heel to toe, in boots), how fresh it is (1 to 0), and its size.
fn printAt(at: vec2f) -> vec4f {
  var print = vec4f(1e9, 1e9, 0.0, 1.0);
  for (var i = 0; i < 12; i++) {
    let stomp = u.stomps[i];
    let age = u.frame.z - stomp.z;
    if (stomp.w <= 0.0 || age < 0.0 || age > 5.5) { continue; }
    let off = (at - stomp.xy) / stomp.w;
    let q = vec2f(0.88 * off.x - 0.47 * off.y, 0.47 * off.x + 0.88 * off.y);
    if (dot(q, q) < dot(print.xy, print.xy)) { print = vec4f(q, 1.0 - smoothstep(2.6, 5.4, age), stomp.w); }
  }
  return print;
}

fn landColor(p: vec3f, far: f32, d: vec2f, scale: f32, pen: f32) -> vec3f {
  let e = 0.04 + 0.004 * far;
  var rise = vec2f(0.0); // (the ground ahead less the ground behind, across and along)
  for (var k = 0; k < 4; k++) {
    let way = select(-1.0, 1.0, k % 2 == 0);
    let g = ground(p.xz + select(vec2f(0.0, e), vec2f(e, 0.0), k < 2) * way);
    if (k < 2) { rise.x += way * g; } else { rise.y += way * g; }
  }
  let slope = rise / (2.0 * e);
  let n = normalize(vec3f(-slope.x, 1.0, -slope.y));
  let px = u.world.w / far * scale; // pixels per world unit, seen face on
  let steep = max(length(slope), 0.07);
  let flat = px * 0.45 / steep; // pixels on screen for each unit of height
  var tone: vec3f;
  var ink = 0.0;
  let heave = heaved(p.xz);
  let tier = (p.y - heave - 0.62) / 0.4; // the terraces ride the wave from a footfall
  if (tier < 0.0) {
    let cell = floor(p.xz / 5.5);
    let luck = hash(cell);
    // The wind goes through the crops.
    let run = select(p.x, p.z, luck > 0.5) * 1.5 + 0.35 * sin(select(p.z, p.x, luck > 0.5) * 0.9) + 0.09 * sin(u.frame.z * 1.3 + p.x * 0.6 + p.z * 0.4) + 1.5 * heave;
    let edge = (0.5 - abs(fract(run) - 0.5)) / 1.5 * px * 0.6;
    let stripe = select(1.0 - fill(edge), fill(edge), i32(floor(run)) % 2 == 0);
    let kind = i32(hash(cell + 9.1) * 3.0);
    let a = select(select(LIME, GREEN, kind == 1), YELLOW, kind == 2);
    let b = select(select(mix(LIME, YELLOW, 0.45), mix(GREEN, LIME, 0.6), kind == 1), AMBER, kind == 2);
    // Furrows fade out where they get too fine to draw.
    tone = mix(mix(a, b, 0.5), mix(a, b, stripe), smoothstep(2.0, 6.0, px / 1.5));
    let hedge = (0.5 - abs(fract(p.xz / 5.5) - 0.5)) * 5.5;
    ink = stroke(min(hedge.x, hedge.y) * px * 0.6, pen * 0.8) * smoothstep(3.0, 9.0, px);
    ink = max(ink, stroke(-tier * 0.4 * flat, pen * 0.8) * smoothstep(3.0, 9.0, px));
  } else {
    tone = K_STEPS_15[clamp(i32(floor(tier)), 0, 7)];
    ink = stroke((0.5 - abs(fract(tier) - 0.5)) * 0.4 * flat, pen * 0.8) * smoothstep(1.5, 5.0, 0.4 * flat);
  }
  // Sand where it meets the water.
  let shore = p.y - u.world.z;
  tone = mix(tone, PAPER, fill((0.14 - shore) * flat));
  ink = max(ink, stroke(abs(shore - 0.14) * flat, pen * 0.7) * smoothstep(3.0, 8.0, px));
  tone = mix(tone * vec3f(0.6, 0.57, 0.8), tone, smoothstep(0.5, 0.56, dot(n, SUNWARD)));

  // A footpath of pale stones along each bank.
  let bank = abs(abs(p.x - river(p.z)) - 3.1 - 0.4 * sin(p.z * 0.21));
  tone = mix(tone, PAPER * 0.96, 0.85 * step(0.4, fract(p.z * 0.9)) * fill((0.1 - bank) * px * 0.6) * step(0.25, shore) * smoothstep(3.0, 7.0, px));

  // A boot leaves its print: the sole pressed into the ground, tread and
  // heel, with a lip of thrown-up earth and cracks running out of it.
  let trod = printAt(p.xz);
  if (trod.z > 0.0 && dot(trod.xy, trod.xy) < 9.0) {
    let unit = px * 0.6 * trod.w;
    let q = trod.xy;
    let edge = length(q / vec2f(0.8, 1.3)) - 1.0 + 0.1 * smoothstep(0.0, 1.0, q.y) * 0.0;
    let rim = edge * 0.8; // near enough in boots
    let pressed = tone * vec3f(0.5, 0.44, 0.68);
    tone = mix(tone, pressed, trod.z * fill(-rim * unit));
    // The tread: bars across the sole, and the heel apart from it.
    let inner = fill((-0.16 - rim) * unit);
    let bars = fill((0.3 - abs(fract(q.y * 2.6 + 0.2) - 0.5)) / 2.6 * unit) * step(-0.38, q.y);
    let heel = fill((q.y + 0.5) * -unit);
    tone = mix(tone, pressed * vec3f(0.62, 0.6, 0.8), trod.z * inner * max(bars, heel));
    // Light catches the lip on the side away from the sun.
    tone = mix(tone, tone * 1.22 + 0.06, trod.z * fill((0.11 - abs(rim - 0.13)) * unit) * (0.55 + 0.45 * smoothstep(-0.4, 0.4, q.x - q.y)));
    let spoke = atan2(q.y, q.x) / TAU * 11.0 + trod.w * 37.0;
    let reach = 0.25 + 0.75 * hash(vec2f(floor(spoke), 5.0));
    let crack = abs(fract(spoke) - 0.5 - 0.14 * sin(rim * 9.0 + floor(spoke))) / 11.0 * TAU * (rim + 1.0);
    ink = max(ink, trod.z * stroke(crack * unit, pen * 0.42) * step(0.05, rim) * (1.0 - smoothstep(reach * 0.6, reach, rim)));
    ink = max(ink, trod.z * stroke(abs(rim) * unit, pen * 0.8));
  }

  // Bushes dotted about, each a ball standing on the ground with its shadow
  // beside it, and now and then one in blossom. A bush can hide ground well
  // behind it, so the plots between here and the eye are looked in too.
  if (px > 2.2) {
    let eye = eyeAt();
    let ray = normalize(p - eye);
    let toward = normalize(p.xz - eye.xz);
    for (var j = 2; j >= 0; j--) {
      let plot = floor((p.xz - toward * 3.5 * f32(j)) / 3.7);
      let chance = hash(plot + 3.3);
      if (chance < 0.6) { continue; }
      let centre = (plot + 0.3 + 0.4 * vec2f(hash(plot + 1.1), hash(plot + 2.2))) * 3.7;
      let foot = ground(centre);
      if (foot - u.world.z < 0.3) { continue; }
      let r = 0.36 + 0.3 * hash(plot + 4.4);
      if (j == 0) {
        tone = mix(tone, tone * vec3f(0.42, 0.38, 0.6), 0.7 * fill((r - length(p.xz - centre - vec2f(0.45, -0.3))) * px * 0.6));
      }
      let ball = vec3f(centre.x + 0.03 * sin(u.frame.z * 1.4 + centre.x), foot + r * 0.8, centre.y);
      let near = dot(ball - eye, ray);
      let rel = eye + ray * near - ball;
      let edge = (r - length(rel)) * u.world.w / near * scale;
      let sort = hash(plot + 8.8);
      let leaf = select(select(select(SEA, GREEN, sort > 0.35), MOSS, sort > 0.65), PINK, chance > 0.93);
      var bush = mix(leaf * vec3f(0.6, 0.58, 0.8), leaf, smoothstep(-0.1, 0.1, (rel.y * 0.8 - rel.x * 0.6) / r - 0.1));
      bush = mix(bush, leaf * 1.2 + 0.06, smoothstep(0.5, 0.6, (rel.y * 0.8 - rel.x * 0.6) / r));
      // Some carry berries, and the ones in blossom pale flowers.
      if (sort > 0.8 || chance > 0.93) {
        let dots = rel.xy / r * 2.3 + sort * 7.0;
        let dot = (0.2 - length(fract(dots) - 0.5 - 0.2 * (vec2f(hash(floor(dots) + sort), hash(floor(dots) + 3.0)) - 0.5))) * r / 2.3 * u.world.w / near * scale;
        bush = mix(bush, select(RED, PAPER, chance > 0.93), fill(dot) * step(length(rel) / r, 0.82));
      }
      tone = mix(tone, bush, fill(edge));
      ink = max(ink * (1.0 - fill(edge)), stroke(abs(edge), pen * 0.75));
    }
  }

  // The shadows of whatever stands on it.
  // Nearest footprint wins. Do the square root and edge softening once.
  var walkerGap = 1e6;
  var siteGap = 1e6;
  for (var i = 0; i < 8; i++) {
    let m = p.xz - u.critters[i].xy;
    walkerGap = min(walkerGap,dot(m,m));
    let off = p.xz - u.sites[i].xy - vec2f(0.3,-0.2);
    siteGap = min(siteGap, dot(off,off) + 3.1*(1.0-smoothstep(0.0,0.28,u.sites[i].z)));
  }
  let shade = max(1.0-smoothstep(0.55,1.15,sqrt(walkerGap)/MINI),1.0-smoothstep(0.9,1.7,sqrt(siteGap)));
  tone = mix(tone, tone * vec3f(0.42, 0.38, 0.6), 0.75 * shade);

  // The audit: where the officers have trodden the land is grey tiles, a lane
  // behind each of them, until the valley's colours come back down it. And
  // the officers cast shadows.
  if (u.officers[0].x > 0.0) {
    let mark = audited(p.xz, px, px * clamp((EYE - p.y) / far, 0.03, 1.0), u.frame.z);
    let dull = dot(tone, vec3f(0.3, 0.55, 0.15));
    tone = mix(tone, mix(vec3f(0.74, 0.75, 0.77) * mark.w, vec3f(dull), 0.1), mark.x);
    ink = max(ink * (1.0 - 0.9 * mark.x), mark.y);
    tone = mix(tone, tone * 1.25 + vec3f(0.3, 0.26, 0.08), mark.z);
    // When the last of them comes round the whole valley is brighter for a moment.
    tone = max(mix(vec3f(dull), tone, 1.0 + 0.45 * u.officers[0].w), vec3f(0.0)) * (1.0 + 0.14 * u.officers[0].w);
    var dark = 0.0;
    for (var i = 0; i < 5; i++) {
      let who = u.officers[10 + 4 * i];
      if (who.z <= 0.0 || who.w == 0.0) { continue; }
      dark = max(dark, min(abs(who.w), 1.0) * (1.0 - smoothstep(0.45, 1.0, length(p.xz - u.officers[11 + 4 * i].xy - vec2f(0.34, -0.22)) / 0.85)));
    }
    tone = mix(tone, tone * vec3f(0.42, 0.38, 0.6), 0.7 * dark);
  }

  let c = mix(tone * (0.972 + 0.05 * noise(d * 2.3)), INK, ink * (1.0 - smoothstep(50.0, 150.0, far)));
  return mix(c, HAZE, smoothstep(60.0, FAR, far));
}

fn dyeLoad(c: vec2i) -> vec4f {
  // Past an edge the texture is read back on itself, like a mirror.
  let last = vec2i(textureDimensions(dyeMap)) - 1;
  return textureLoad(dyeMap, clamp(last - abs(last - abs(c)), vec2i(0), last), 0);
}

// Where in the fluid a point of the hero looks. A slow pulse runs outward from
// the sun, and a kaleidoscope round the sun repeats one slice of the fluid,
// mirrored, all the way round, turning slowly.
fn lens(at: vec2f) -> vec2f {
  if (u.sun.z <= 0.0) { return at; }
  let r = at - u.sun.xy;
  let len = length(r);
  let reach = len * (1.0 + 0.022 * sin(u.frame.z * 0.8 - len * 0.007));
  var a = atan2(r.y, r.x);
  if (u.liquid.w >= 1.0) {
    let span = TAU / u.liquid.w;
    a -= ${f(settings.liquid.turn)} * u.frame.z;
    // Folded back and forth like a triangle wave, but with the corners rounded
    // off, so each mirror's seam is a soft fold and not a crease.
    a = u.dye.w - span / TAU * asin(${f(settings.liquid.soft)} * cos(TAU * a / span));
  }
  return u.sun.xy + reach * vec2f(cos(a), sin(a));
}

// The dye straight under a point of the fluid.
fn dyeUnder(at: vec2f) -> vec4f {
  let p = at / vec2f(u.frame.w, u.dye.z) * u.dye.xy - 0.5;
  let i = vec2i(floor(p));
  let f = fract(p);
  return mix(
    mix(dyeLoad(i), dyeLoad(i + vec2i(1, 0)), f.x),
    mix(dyeLoad(i + vec2i(0, 1)), dyeLoad(i + vec2i(1, 1)), f.x),
    f.y,
  );
}

// The dye at a point of the hero: x is its phase, yz the direction it left the sun in.
fn dyeAt(point: vec2f) -> vec4f {
  let p = lens(point) / vec2f(u.frame.w, u.dye.z) * u.dye.xy - 0.5;
  let i = vec2i(floor(p));
  let f = fract(p);
  return mix(
    mix(dyeLoad(i), dyeLoad(i + vec2i(1, 0)), f.x),
    mix(dyeLoad(i + vec2i(0, 1)), dyeLoad(i + vec2i(1, 1)), f.x),
    f.y,
  );
}

// The liquid. Each whole step of phase is a ring of flat colour, cut into
// wedges by the direction it left the sun in, so undisturbed it is a checkered
// sunburst and stirred it is marbling. Rings are shaded like inflated tubes
// and edged with a pen line that fades where the folds get too fine to draw.
fn liquid(d: vec2f, scale: f32, pen: f32) -> vec3f {
  let e = 1.5;
  let c = dyeAt(d);
  let l = dyeAt(d - vec2f(e, 0.0));
  let r = dyeAt(d + vec2f(e, 0.0));
  let above = dyeAt(d - vec2f(0.0, e));
  let below = dyeAt(d + vec2f(0.0, e));
  let grad = vec2f(r.x - l.x, below.x - above.x) / (2.0 * e);
  let slope = max(length(grad), 1e-5); // rings per design unit
  let phase = c.x + u.liquid.y;
  let ring = floor(phase);
  let f = phase - ring;
  let ringPx = scale / slope; // how many pixels wide the ring is here
  let edgePx = (0.5 - abs(f - 0.5)) * ringPx;

  // Wedges, where the direction survives the mixing.
  let m2 = max(dot(c.yz, c.yz), 1e-4);
  let around = atan2(c.z, c.y) / TAU * u.liquid.z;
  let aroundGrad = vec2f(c.y * (r.z - l.z) - c.z * (r.y - l.y), c.y * (below.z - above.z) - c.z * (below.y - above.y)) / (2.0 * e * m2) / TAU * u.liquid.z;
  let wedge = floor(around);
  let wedgePx = (0.5 - abs(around - wedge - 0.5)) / max(length(aroundGrad), 1e-5) * scale;
  let odd = ((i32(wedge) % 2) + 2) % 2;
  let cut = select(0.0, smoothstep(0.2, 0.55, sqrt(m2)), u.liquid.z > 0.0);
  let i = i32(ring);
  let here = K_BANDS_14[((i + 3 * odd) % 20 + 20) % 20];
  let next = K_BANDS_14[((i + 3 * (1 - odd)) % 20 + 20) % 20];
  var tone = mix(K_BANDS_14[(i % 20 + 20) % 20], mix(next, here, clamp(wedgePx + 0.5, 0.0, 1.0)), cut);

  // Each ring is a rounded, glossy tube, lit from where the lettering's light is:
  // bright on the side facing it, cool in the shade, with a hard white glint.
  let plump = smoothstep(6.0, 18.0, ringPx);
  let normal = normalize(vec3f(-1.2 * cos(f * 3.14159) * plump * grad / slope, 1.0));
  let toLight = normalize(vec3f(normalize(u.look.xy) * 0.82, 0.57));
  let facing = dot(normal, toLight);
  tone *= 0.66 + 0.46 * smoothstep(-0.1, 0.95, facing);
  tone = mix(tone, tone * vec3f(0.5, 0.36, 0.72), 0.55 * plump * (1.0 - smoothstep(-0.25, 0.35, facing)));
  let glint = pow(max(dot(normal, normalize(toLight + vec3f(0.0, 0.0, 1.0))), 0.0), 70.0);
  tone += vec3f(1.0, 0.96, 0.86) * 1.5 * plump * smoothstep(0.35, 0.75, glint);

  let ink = stroke(edgePx, pen) * smoothstep(pen * 2.0, pen * 4.5, ringPx);
  var color = mix(tone * (0.972 + 0.05 * noise(d * 2.3)), INK, ink);

  // Where the lasers have burnt through, the dark behind the liquid shows,
  // with stars in it, inside a glowing edge. The burn drifts with the fluid and heals.
  let t = u.frame.z;
  let burn = dyeUnder(d).w + 0.09 * (noise(d * 0.05 + vec2f(t * 0.3, -t * 0.2)) - 0.5);
  if (burn > 0.2) {
    let perBurn = scale / 0.03; // pixels for each unit of burn, near enough
    let cell = floor(d / 30.0);
    let star = length(d - (cell + 0.2 + 0.6 * vec2f(hash(cell), hash(cell + 7.7))) * 30.0);
    let twinkle = 0.6 + 0.4 * sin(t * 2.0 + hash(cell + 3.1) * TAU);
    var dark = mix(INK * 0.8, select(PAPER, ${vec3(P.aqua)}, hash(cell + 1.3) > 0.6), fill((1.6 * twinkle - star) * scale) * step(0.45, hash(cell + 5.5)));
    dark = mix(dark, ${vec3(P.purple)}, 0.16 * smoothstep(0.3, 0.9, noise(d * 0.012 + t * 0.05)));
    let glow = 1.7 * mix(RED, YELLOW, fill((burn - 0.43 - 0.03 * sin(t * 6.0 + d.x * 0.1)) * perBurn));
    color = mix(color, INK, stroke(abs(burn - 0.34) * perBurn, pen));
    color = mix(color, glow, fill((burn - 0.34) * perBurn));
    color = mix(color, INK, fill((burn - 0.5) * perBurn + pen));
    color = mix(color, dark, fill((burn - 0.5) * perBurn - pen));
  }
  return color;
}

// The liquid as the weather leaves it: a storm darkens it, and tears of blood
// turn it red and black.
// A cut-paper rosette. Every kite lifts two smaller ones on the same hinge.
fn paperRosette(delta: vec2f, scale: f32, pen: f32, age: f32, open: f32, under: vec3f) -> vec3f {
  let breath = sin(age * 13.0 - 2.0);
  let unit = max(0.0001, u.sun.z * 2.78 * open * (1.0 + 0.026 * breath));
  let fan = TAU / 8.0;
  let spin = u.frame.z * 0.028 + age * 0.24;
  let az = atan2(delta.y, delta.x + 1e-7) - spin;
  let theta = (fract(az / fan + 0.5) - 0.5) * fan;
  var q = (length(delta) * vec2f(cos(theta), sin(theta)) - vec2f(0.5 * u.sun.z, 0.0)) / unit;
  var px = unit * scale;
  let child = mix(0.42, 0.595, open);
  let swing = turn(-mix(0.12, 0.82 + 0.21 * breath, open));
  var color = under;
  for (var i = 0; i < 6; i++) {
    // Squeeze the leaf along its spine as the paper turns edge-on. The ink
    // width follows the piece down to the smallest fold rather than blobbing.
    let along = clamp(q.x, 0.0, 1.0);
    let wide = mix(0.22, 0.96, open);
    let ridge = q.y - 0.022 * along * (1.0 - along) * sin(10.0 * along + f32(i));
    let side = abs(ridge);
    let pleat = min(0.58 * q.x, 0.36 * (1.0 - q.x));
    let walls = pleat * select(1.48, 1.0, i == 0) * (1.0 + 0.10 * sin(6.0 * along));
    let edge = (wide * walls - side) * px * 0.89;
    let nib = min(pen * 0.94, px * 0.031);
    if (edge > -nib - 1.0) {
      let mid = fill(ridge * px);
      var dye = mix(K_DYES_12[i], K_REVERSE_DYES_13[i], mid);
      // A pale triangular facet catches the light on the mountain fold.
      dye = mix(dye, mix(K_DYES_12[i], PAPER, 0.50), fill(((q.x - 0.39) * 0.33 - side / wide) * px));
      let crease = stroke(side * px, nib * 0.58);
      dye = mix(dye, INK, 0.86 * crease);
      // A smaller kite punched out of the large one: real sky, not white.
      let window = (min((q.x - 0.23) * 0.57, (0.72 - q.x) * 0.32) * wide - side) * px * 0.94;
      dye = mix(dye, under, fill(window));
      dye = mix(dye, INK, stroke(abs(window), nib * 0.65));
      color = mix(color, dye, fill(edge));
      color = mix(color, INK, stroke(abs(edge), nib));
    }
    q = swing * vec2f(q.x - 0.80, abs(q.y)) / child;
    px *= child;
  }
  return color;
}

// The cosmos (see show.cosmos): space behind the paint. A spiral galaxy, tipped
// toward the eye, turns slowly about the sun, which is its heart: two arms in flat
// bands of the poster's inks with wobbly black edges and dark lanes of dust, a
// white-hot middle for the lens to bloom, and stars at three depths that drift
// past at different rates. Among them the players, which flare as they sing.
fn galaxy(d: vec2f, scale: f32, pen: f32) -> vec3f {
  let t = u.frame.z;
  let age = u.cosmos.y;
  let w = u.frame.w;
  let g = (turn(0.3) * (d - u.sun.xy)) * vec2f(1.0, 2.2) / (0.52 * w);
  let rho = length(g);
  let around = atan2(g.y, g.x);
  let lump = fbm(g * 2.4 + vec2f(3.1, 7.7));
  let swirl = 2.0 * around - 5.6 * log(rho + 0.03) + 0.02 * age + 1.4 * (lump - 0.5) + 0.07 * sin(rho * 37.0 + 3.0 * around);
  let arm = cos(swirl);
  let disc = exp(-1.6 * rho);
  let fade = 1.0 - smoothstep(1.2, 2.4, rho);
  // Deep space, violet-black, with clouds of colour in it: magenta, and teal.
  let haze = 0.6 * noise(d * 0.004 + vec2f(5.0, 1.0)) + 0.4 * noise(d * 0.011);
  var color = mix(vec3f(0.02, 0.012, 0.055), PURPLE * 0.42, smoothstep(0.5, 0.95, haze));
  color = mix(color, TEAL * 0.32, 0.8 * smoothstep(0.62, 0.95, noise(d * 0.006 + vec2f(9.0, 2.0))));
  // The galaxy's own light, soft round its arms and its heart.
  color += mix(PURPLE, PINK, disc) * (0.18 + 0.5 * smoothstep(-0.3, 1.0, arm)) * disc * fade;
  // The arms, in two bands with a pen line round each. How far a point is from
  // an edge goes by how far round the spiral it is, and how fast that changes here.
  let a = acos(clamp(arm, -1.0, 1.0));
  let perTurn = w * max(rho, 0.04) * scale / 12.0;
  let warm = 1.0 - smoothstep(0.06, 0.5, rho);
  let ridge = 1.0 - smoothstep(0.6, 1.6, rho);
  let outer = mix(mix(PINK * 1.1, AQUA * 1.15, smoothstep(0.45, 1.3, rho)), ORANGE * 1.3, warm) * (0.75 + 0.7 * disc);
  let inner = mix(mix(PAPER * 1.2, AQUA * 1.4, smoothstep(0.6, 1.4, rho)), YELLOW * 1.9, warm) * (0.9 + 1.1 * disc);
  let edge0 = (0.95 - a) * perTurn;
  let edge1 = (0.38 - a + 0.22 * (lump - 0.5)) * perTurn;
  color = mix(color, outer, fill(edge0) * fade);
  color = mix(color, inner, fill(edge1) * fade * ridge);
  // Dust, in lanes along the inside of each arm.
  let lane = smoothstep(0.88, 0.98, cos(swirl - 0.62)) * smoothstep(0.45, 0.62, noise(g * 17.0)) * smoothstep(0.05, 0.2, rho) * fade;
  color = mix(color, vec3f(0.11, 0.015, 0.1), 0.55 * lane);
  color = mix(color, INK, stroke(abs(edge0), pen * 0.85) * fade);
  color = mix(color, INK, 0.7 * stroke(abs(edge1), pen * 0.6) * fade * ridge);
  // The white-hot middle, mostly behind the sun.
  color += (YELLOW * 1.5 * exp(-pow(rho / 0.2, 2.0)) + PAPER * 2.6 * exp(-pow(rho / 0.07, 2.0))) * (1.0 - 0.55 * u.orb.z); // softer round the moon
  color *= 0.972 + 0.05 * noise(d * 2.3);
  // Stars at three depths, the nearer drifting past faster; more of them in the arms.
  for (var k = 0; k < 3; k++) {
    let n = f32(k);
    let size = 10.0 + 7.0 * n + 9.0 * n * n;
    let p = d + vec2f(-1.0, 0.18) * (1.2 + 4.5 * n) * age;
    let cell = floor(p / size);
    let h = hash(cell + 31.0 * n);
    if (h < 0.55 + 0.17 * n - 0.4 * max(arm, 0.0) * fade) { continue; }
    let off = p - (cell + 0.2 + 0.6 * vec2f(hash(cell + 3.3 + n), hash(cell + 8.1 + n))) * size;
    let twinkle = 0.7 + 0.3 * sin(t * (1.1 + 2.3 * h) + h * 50.0);
    let tint = K_TINTS_10[i32(fract(h * 13.0) * 4.0)] * (1.1 + 1.6 * n) * twinkle;
    color = mix(color, tint, fill(((0.55 + 0.6 * n) * twinkle - length(off)) * scale));
    if (k == 2) {
      let q = abs(off);
      color += tint * (1.0 - smoothstep(0.0, 0.9, min(q.x, q.y) * scale)) * max(0.0, 1.0 - max(q.x, q.y) / (4.5 * twinkle));
    }
  }
  // The players. Each is a little brighter than the rest; when it sings it swells
  // and throws out rays, a ring runs out from it, and a thread of light comes to it
  // from the star that sang before.
  for (var i = 0; i < 14; i++) {
    let s = u.stars[i];
    let code = i32(s.w);
    let tint = K_HUES_11[code % 4];
    let since = s.z;
    let flare = exp(-max(since, 0.0) * 2.4) * (0.4 + fract(s.w) / 0.9) * step(0.0, since);
    let off = d - s.xy;
    let len = length(off);
    let ringR = 8.0 + 140.0 * (1.0 - exp(-since * 1.8));
    let ringOn = select(0.0, exp(-since * 1.2) * smoothstep(0.0, 0.05, since), since >= 0.0 && since < 3.5);
    if (len < max(26.0 + 70.0 * flare, (ringR + 6.0) * step(0.001, ringOn))) {
      let radius = 8.0 + 9.0 * flare;
      let q = abs(off) / radius;
      let body = (1.0 - sqrt(q.x) - sqrt(q.y)) * radius * scale * 0.7;
      color += tint * (0.12 + 0.9 * flare) * exp(-len / (6.0 + 22.0 * flare));
      color = mix(color, INK, fill(body + pen * 0.9));
      color = mix(color, tint * (1.3 + 4.0 * flare), fill(body));
      color = mix(color, PAPER * (1.6 + 5.0 * flare), fill((radius * 0.28 - len) * scale));
      // A ring of its own colour round it always, so that it can be told from the rest.
      color = mix(color, tint * 1.4, 0.8 * stroke(abs(len - 15.0 - 6.0 * flare) * scale, pen * 0.45));
      if (flare > 0.02) {
        let spoke = abs(fract(atan2(off.y, off.x) * 1.2732395 + 0.5) - 0.5) * 0.7853982 * len;
        color += tint * 2.2 * flare * (1.0 - smoothstep(0.3, 1.2, spoke * scale)) * max(0.0, 1.0 - len / (70.0 * flare + 1.0));
      }
      if (ringOn > 0.0) {
        let band = abs(len - ringR) * scale;
        color = mix(color, INK, ringOn * stroke(band, pen * 1.2));
        color = mix(color, tint * 2.0, ringOn * stroke(band, pen * 0.55));
      }
    }
    if (since >= 0.0 && since < 0.8 && code / 4 != i) {
      let src = u.stars[code / 4].xy;
      let run = s.xy - src;
      let k = clamp(dot(d - src, run) / max(dot(run, run), 1.0), 0.0, 1.0);
      let reach = clamp(since / 0.14, 0.0, 1.0); // the light gets there in a seventh of a second
      let gap = length(d - src - run * k) * scale;
      color += tint * 2.4 * step(k, reach) * exp(-since * 4.5) * (1.0 - smoothstep(0.4, 1.6, gap));
      color += PAPER * 3.0 * (1.0 - reach * 0.7) * exp(-length(d - src - run * reach) * scale / 3.0) * exp(-since * 3.0);
    }
  }
  return color;
}

// The paint parting for the cosmos: holes open in it from round the sun outward,
// lit at their edges, and space shows through. On the way back they close again.
fn parted(d: vec2f, scale: f32, pen: f32, paint: vec3f) -> vec3f {
  let open = u.cosmos.x;
  let near = 1.0 - clamp(length((d - u.sun.xy) * vec2f(1.0, 1.5)) / (0.8 * u.frame.w), 0.0, 1.0);
  let field = 0.62 * clamp((fbm(d * 0.0045 + vec2f(1.7, 0.05 * u.cosmos.y)) - 0.22) / 0.56, 0.0, 1.0) + 0.38 * near;
  let edge = (field - 1.04 + 1.12 * open) * scale / 0.0055; // pixels in from the edge of a hole
  var color = paint * (1.0 - 0.35 * open);
  if (edge < -2.0 * pen - 2.0) { return color; }
  let rim = 3.0 * pen + 2.0;
  color = mix(color, INK, stroke(abs(edge), pen));
  color = mix(color, 1.2 * mix(PINK, PAPER, fill(edge - 0.5 * rim)), fill(edge));
  color = mix(color, INK, fill(edge - rim + pen));
  if (edge > rim - pen - 1.0) { color = mix(color, galaxy(d, scale, pen), fill(edge - rim - pen)); }
  return color;
}

fn heavens(d: vec2f, scale: f32, pen: f32) -> vec3f {
  if (cosmosLive && u.cosmos.x >= 1.0) { return galaxy(d, scale, pen); }
  var color = liquid(d, scale, pen);
  color = mix(color, color * vec3f(0.46, 0.44, 0.72), 0.62 * u.weather.x);
  color = mix(color, dot(color, vec3f(0.5, 0.4, 0.12)) * vec3f(1.5, 0.1, 0.14), 0.8 * u.sky.y);
  if (cosmosLive && u.cosmos.x > 0.0) { color = parted(d, scale, pen, color); }
  return color;
}

// The sky is drawn in a pass of its own before the picture, over the rows the land
// does not bury, and the picture reads it back at the same pixel: a small shader like
// this one keeps many more pixels in flight than the picture's can.
@fragment
fn skyMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let scale = u.frame.x / u.frame.w;
  return vec4f(heavens(position.xy / scale, scale, u.look.z * scale * 0.5), 1.0);
}

// The water in the valley: the liquid overhead mirrored in it and broken by
// ripples, lighter in the shallows where waves lap the shore, streaked with
// foam where the river runs, and glittering under the sun. p is the point on
// its surface, far how far off it is.
// How fast the water deepens here, per unit across the ground.
fn fwidthDeep(at: vec2f) -> f32 {
  return length(vec2f(ground(at + vec2f(0.1, 0.0)) - ground(at - vec2f(0.1, 0.0)), ground(at + vec2f(0.0, 0.1)) - ground(at - vec2f(0.0, 0.1)))) * 0.5;
}

fn waterColor(p: vec3f, far: f32, d: vec2f, scale: f32, pen: f32, t: f32, sunX: f32) -> vec3f {
  let rise = u.dye.z - d.y;
  let px = u.world.w / far * scale;
  let deep = u.world.z - ground(p.xz);
  let wobble = (sin(p.z * 2.1 + p.x * 0.7 + t * 1.4) + 0.5 * sin(p.z * 4.3 - p.x * 1.9 - t * 2.1) + 22.0 * heaved(p.xz)) * min(110.0 / far, 4.0);
  let above = vec2f(d.x + wobble, u.dye.z - 2.0 * u.look.w + rise + 0.3 * wobble);
  var tone = mix(heavens(above, scale, pen), mix(TEAL, AQUA, 0.35), 0.48) * 0.94;
  tone = mix(tone, mix(AQUA, PAPER, 0.35), 0.6 * (1.0 - smoothstep(0.0, 0.3, deep)));

  // Deeper water is darker, in bands with a line between them like the land's terraces.
  tone = mix(tone, tone * vec3f(0.78, 0.86, 1.0), smoothstep(0.38, 0.42, deep));
  tone = mix(tone, tone * vec3f(0.74, 0.8, 1.02), smoothstep(0.88, 0.92, deep));
  let contour = min(abs(deep - 0.4), abs(deep - 0.9));
  tone = mix(tone, tone * 0.62, 0.7 * stroke(contour / max(fwidthDeep(p.xz), 0.02) * 0.1 * px, pen * 0.4) * smoothstep(3.0, 8.0, px));

  // Rows of little waves ride the current toward the eye, each a curl with a pale crest.
  let chop = 0.55 + 0.45 * u.weather.x;
  let rows = vec2f((p.x - river(p.z)) * 0.8, (p.z + t * 2.6) * 0.42);
  let row = floor(rows.y);
  let cellAt = vec2f(rows.x + 0.5 * (row - 2.0 * floor(row / 2.0)), rows.y);
  let curl = fract(cellAt) - vec2f(0.5, 0.18);
  let lucky = step(1.0 - chop * 0.62, hash(floor(cellAt) + 11.0));
  let arc = abs(length(curl * vec2f(1.0, 1.9)) - 0.36);
  let crest = stroke(arc / 0.8 * px * 0.9, pen * 0.6) * step(0.0, curl.y) * lucky * smoothstep(0.3, 0.6, deep) * smoothstep(3.5, 9.0, px);
  tone = mix(tone, tone * 0.6, 0.8 * stroke((arc + 0.05) / 0.8 * px * 0.9, pen * 0.5) * step(0.0, curl.y) * lucky * smoothstep(0.3, 0.6, deep) * smoothstep(3.5, 9.0, px));
  tone = mix(tone, PAPER * 1.05, crest);

  // Waves lapping in toward the shore.
  let steep = max(length(vec2f(ground(p.xz + vec2f(0.1, 0.0)), ground(p.xz + vec2f(0.0, 0.1))) - (u.world.z - deep)) / 0.1, 0.07);
  let lap = fract(deep * 3.2 + t * 0.3);
  tone = mix(tone, PAPER, 0.85 * stroke((0.5 - abs(lap - 0.5)) / 3.2 / steep * px * 0.45, pen * 0.55) * (1.0 - smoothstep(0.25, 0.6, deep)) * smoothstep(3.0, 8.0, px));

  // Foam drawn out along the current, which runs toward the eye, fastest in midstream.
  let across = (p.x - river(p.z)) * 1.3;
  let lane = floor(across);
  let run = fract((p.z + t * (3.2 - 0.5 * abs(lane))) * 0.16 + hash(vec2f(lane, 3.0)) * 7.0);
  let streak = stroke(abs(fract(across) - 0.5 - 0.2 * sin(p.z * 0.8 + lane)) / 1.3 * px * 0.6, pen * 0.5) * smoothstep(0.0, 0.08, run) * (1.0 - smoothstep(0.3, 0.42, run));
  tone = mix(tone, PAPER, 0.7 * streak * smoothstep(0.15, 0.5, deep) * smoothstep(3.0, 8.0, px));

  // Lily pads ride the current down toward the eye, turning slowly, some in flower.
  if (px > 2.5) {
    let drift = vec2f(p.x - river(p.z), p.z + t * 1.2);
    let cell = floor(drift.y / 3.1);
    let luck = hash(vec2f(cell, 17.0));
    if (luck > 0.3) {
      let home = vec2f((hash(vec2f(cell, 3.0)) - 0.5) * 2.0, (cell + 0.3 + 0.4 * hash(vec2f(cell, 9.0))) * 3.1);
      let q = turn(t * 0.3 * (luck - 0.65) + luck * 20.0) * (drift - home);
      let r = 0.3 + 0.2 * hash(vec2f(cell, 5.0));
      let far2 = length(q);
      if (far2 < r + 0.2) {
        let ang = atan2(q.y, q.x);
        let unit = px * 0.6;
        let afloat = smoothstep(0.08, 0.2, deep) * smoothstep(2.5, 6.0, px);
        let pad = max(far2 - r, 0.22 * r - abs(ang) * far2);
        tone = mix(tone, tone * vec3f(0.5, 0.55, 0.75), 0.6 * afloat * fill((r - length(q - vec2f(0.08, -0.06))) * unit));
        var leaf = mix(GREEN, LIME, 0.3 + 0.5 * hash(vec2f(cell, 7.0)));
        leaf = mix(leaf, leaf * 0.72, stroke(abs(fract(ang / TAU * 9.0) - 0.5) / 9.0 * TAU * far2 * unit, pen * 0.3) * step(0.12 * r, far2));
        leaf = mix(leaf, leaf * 1.25 + 0.05, fill((0.5 * r - length(q - vec2f(-0.3, 0.3) * r)) * unit) * 0.5);
        tone = mix(tone, leaf, afloat * fill(-pad * unit));
        tone = mix(tone, INK, afloat * stroke(abs(pad) * unit, pen * 0.6));
        if (luck > 0.62) {
          let petals = far2 - r * (0.42 + 0.2 * cos(ang * 6.0 + luck * 9.0));
          tone = mix(tone, mix(PINK, PAPER, 0.25 + 0.45 * smoothstep(0.0, 0.6 * r, far2)), afloat * fill(-petals * unit));
          tone = mix(tone, INK, afloat * stroke(abs(petals) * unit, pen * 0.5));
          tone = mix(tone, YELLOW, afloat * fill((0.15 * r - far2) * unit));
        }
      }
    }
  }

  // Rings run out over the water from where a boot came down in it, or near it.
  for (var i = 0; i < 12; i++) {
    let stomp = u.stomps[i];
    let age = t - stomp.z;
    if (stomp.w == 0.0 || age < 0.0 || age > 4.0) { continue; }
    let away = length((p.xz - stomp.xy) * vec2f(1.0, 0.8));
    let boot = abs(stomp.w);
    if (away > 12.0) { continue; }
    let strong = select(0.55, 1.0, stomp.w < 0.0) * (1.0 - age / 4.0) * smoothstep(3.0, 8.0, px);
    for (var k = 0; k < 3; k++) {
      let ring = (age - 0.28 * f32(k)) * 2.7;
      if (ring <= 0.0) { continue; }
      let thin = 1.0 - 0.25 * f32(k);
      tone = mix(tone, tone * 0.55, 0.7 * strong * thin * stroke(abs(away - ring + 0.1) * px * 0.6, pen * 0.45));
      tone = mix(tone, PAPER * 1.05, strong * thin * stroke(abs(away - ring) * px * 0.6, pen * 0.6));
    }
    // And foam where it went in.
    if (stomp.w < 0.0) {
      let froth = noise(p.xz * 5.0 + stomp.z) * 0.3;
      tone = mix(tone, PAPER, (1.0 - smoothstep(0.0, 1.6, age)) * fill((boot * 1.5 + 0.9 * age - away - froth) * px * 0.6) * step(boot + 0.9 * age, away + froth));
    }
  }

  // Rain rings.
  if (u.weather.x > 0.0) {
    let cell = floor(p.xz / 1.4);
    let ring = fract(t * 0.9 + hash(cell) * 5.0);
    let drop = abs(length((fract(p.xz / 1.4) - 0.5) * 1.4) - ring * 0.6);
    tone = mix(tone, PAPER, 0.6 * u.weather.x * (1.0 - ring) * stroke(drop * px * 0.6, pen * 0.4) * step(hash(cell + 2.2), u.weather.x) * smoothstep(4.0, 9.0, px));
  }

  // The sun on the water.
  let path = exp(-pow((d.x - sunX) / (22.0 + 0.3 * (u.look.w - rise)), 2.0));
  let spark = smoothstep(0.76, 0.84, noise(vec2f(p.x * 1.4 + t * 0.5, p.z * 3.4 - t * 2.2)));
  tone += vec3f(1.5, 1.3, 0.8) * path * spark * smoothstep(2.0, 6.0, px);

  tone = mix(tone, dot(tone, vec3f(0.5, 0.4, 0.12)) * vec3f(1.5, 0.1, 0.14), 0.7 * u.sky.y);
  return mix(tone * (0.972 + 0.05 * noise(d * 2.3)), HAZE, smoothstep(60.0, FAR, far));
}

// Screen right, screen up and the way back to the eye for a view circling its subject.
fn orbit(yaw: f32, pitch: f32) -> mat3x3f {
  let back = vec3f(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
  let right = vec3f(cos(yaw), 0.0, -sin(yaw));
  return mat3x3f(right, cross(back, right), back);
}

// A cloud as a distance field: balls that melt into each other over a flat
// underside, each one drifting and breathing on its own.
// Where a cloud's puffs are just now and how big: they wander and breathe. Worked
// out once for each pixel of a cloud, not at every step of the way through it.
var<private> puffsNow: array<vec4f, ${CLOUD.length}>;
fn cloudPuffs(t: f32, seed: f32) {
  for (var j = 0; j < ${CLOUD.length}; j++) {
    let puff = K_PUFFS_9[j];
    let k = f32(j);
    let wander = 3.5 * vec3f(sin(t * 0.4 + k * 1.7 + seed), cos(t * 0.33 + k * 2.3 + seed), sin(t * 0.27 + k));
    puffsNow[j] = vec4f(puff.xyz + wander, puff.w * (1.0 + 0.06 * sin(t * 0.5 + k * 1.3 + seed)));
  }
}
fn cloudField(p: vec3f) -> f32 {
  var d = 1e9;
  for (var j = 0; j < ${CLOUD.length}; j++) {
    d = smin(d, length(p - puffsNow[j].xyz) - puffsNow[j].w, 10.0);
  }
  return -smin(-d, p.y + 13.0, 9.0);
}

// A 3D cloud in three flat tones with a pen line round every puff. at is the
// point on its view plane in cloud units (y up), unit is pixels per cloud unit.
// What it does to what is under it: that times a, plus rgb.
fn cloud3d(at: vec2f, unit: f32, pen: f32, still: vec2f, t: f32, seed: f32, light: vec3f, body: vec3f, shade: vec3f) -> vec4f {
  let view = orbit(0.32 * sin(t * 0.17 + seed), 0.2);
  let origin = vec3f(8.0, 18.0, 4.0) + view[0] * (at.x - 8.0) + view[1] * (at.y - 18.0) + view[2] * 220.0;
  cloudPuffs(t, seed);
  var travelled = 110.0;
  var previous = 1e9;
  var graze = 1e9;
  var hit = false;
  for (var i = 0; i < 72; i++) {
    let dist = cloudField(origin - view[2] * travelled);
    if (dist < 0.25) { hit = true; break; }
    if (dist > previous) { graze = min(graze, previous); }
    previous = dist;
    travelled += max(dist * 0.85, 0.6);
    if (travelled > 330.0) { break; }
  }
  if (!hit) { graze = min(graze, previous); }
  let outline = stroke(abs(graze * unit - pen), pen);
  if (!hit) { return vec4f(INK * outline, 1.0 - outline); }
  let p = origin - view[2] * travelled;
  let e = vec2f(0.5, -0.5);
  let n = normalize(
    e.xyy * cloudField(p + e.xyy) + e.yyx * cloudField(p + e.yyx) + e.yxy * cloudField(p + e.yxy) + e.xxx * cloudField(p + e.xxx),
  );
  let lit = dot(n, LIGHT);
  var tone = mix(shade, body, smoothstep(-0.08, -0.02, lit));
  tone = mix(tone, light, smoothstep(0.5, 0.56, lit));
  return vec4f(mix(tone * (0.972 + 0.05 * noise(still * 2.3)), INK, outline), 0.0);
}

// Where a point of the hero is on cloud c's view plane, in cloud units (y up), with z 1 if it is inside
// the box the cloud is drawn in and 0 if not.
fn cloudAt(c: i32, d: vec2f, t: f32) -> vec3f {
  let cloud = u.clouds[c];
  if (cloud.z <= 0.0) { return vec3f(0.0); }
  let seed = f32(c) * 2.1;
  let bob = vec2f(sin(t * 0.13 + seed) * 12.0, cos(t * 0.17 + seed) * 4.0) * cloud.z;
  let at = (d - cloud.xy - bob) / cloud.z * vec2f(1.0, -1.0);
  if (abs(at.x - 8.0) > 140.0 || at.y < -40.0 || at.y > 112.0) { return vec3f(0.0); }
  return vec3f(at, 1.0);
}

// Clouds drift, turn and breathe. What all of them do to what is under them: that times a, plus rgb.
fn cloudsOver(d: vec2f, scale: f32, pen: f32, t: f32) -> vec4f {
  var cover = vec4f(0.0, 0.0, 0.0, 1.0);
  for (var c = 0; c < 6; c++) {
    let at = cloudAt(c, d, t);
    if (at.z == 0.0) { continue; }
    let cloud = u.clouds[c];
    let kind = i32(cloud.w);
    // Storm clouds go dark.
    let gloom = mix(vec3f(1.0), vec3f(0.42, 0.4, 0.58), 0.8 * u.weather.x);
    let one = cloud3d(at.xy, cloud.z * scale, pen, d, t, f32(c) * 2.1, K_CLOUD_LIGHT_6[kind] * gloom, K_CLOUD_BODY_7[kind] * gloom, K_CLOUD_SHADE_8[kind] * gloom);
    cover = vec4f(cover.rgb * one.a + one.rgb, cover.a * one.a);
  }
  return cover;
}

// The clouds' own pass, one draw for each cloud over its tile of cloudMap (see packClouds), the tile a rectangle
// round it on the canvas.
@fragment
fn cloudMain(v: WalkerAt) -> @location(0) vec4f {
  let scale = u.frame.x / u.frame.w;
  return cloudsOver((v.position.xy - u.cloudTile[v.who].xy) / scale, scale, u.look.z * scale * 0.5, u.frame.z);
}

fn star5(point: vec2f, r: f32) -> f32 {
  let k1 = vec2f(0.809016994, -0.587785252);
  let k2 = vec2f(-k1.x, k1.y);
  var p = vec2f(abs(point.x), -point.y);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p = vec2f(abs(p.x), p.y - r);
  let ba = 0.45 * vec2f(-k1.y, k1.x) - vec2f(0.0, 1.0);
  let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

// Distance to an ellipse of radii r, negative inside.
fn oval(p: vec2f, r: vec2f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

// Cut-paper viper plates. A fang curves back toward the hinge as it narrows.
fn viperFang(p: vec2f, deep: f32, wide: f32) -> f32 {
  let v = clamp(p.y / deep, 0.0, 1.0);
  return max(abs(p.x + deep * 0.32 * v * v) - wide * (1.0 - v), max(-p.y, p.y - deep));
}
fn viperPlate(base: vec3f, pigment: vec3f, px: f32, edge: f32) -> vec3f {
  return mix(mix(base, INK, fill(edge - px)), pigment, fill(-px));
}

// A small scissored colour/depth plate, at most one draw per frame. Nothing
// outside the stamped rectangle evaluates the snake's geometry. +x noseward,
// +y up, +z across the skull. Both the hinge and the teeth rotate with the jaw.
fn vBall(p: vec3f, r: vec3f) -> f32 {
  let v=p/r;
  // Tangent-plane distance: a long jaw must not acquire a thick black halo at the tip.
  let l=length(v);
  return l*(l-1.0)/max(length(v/r),1e-5);
}
fn vPick(a: vec2f,b: vec2f) -> vec2f { return select(b,a,a.x<b.x); }
fn vSkull(p: vec3f, hinge: vec4f, taste: f32) -> vec2f {
  let pv=p.xy-vec2f(-0.82,0.0);
  let top=vec3f(vec2f(dot(pv,hinge.xy), dot(pv,vec2f(-hinge.y,hinge.x)))-vec2f(0.82,0.0),abs(p.z));
  let jaw=vec3f(vec2f(dot(pv,hinge.zw), dot(pv,vec2f(-hinge.w,hinge.z)))-vec2f(0.82,0.0),abs(p.z));
  let plate=vBall(top-vec3f(-0.30,0.34,0.02),vec3f(1.10,0.59,0.91));
  let nose=vBall(top-vec3f(0.86,0.24,0.0),vec3f(1.14,0.34,0.71));
  var m=vec2f(smin(plate,nose,0.21),1.0);
  m=vPick(m,vec2f(vBall(jaw-vec3f(0.29,-0.20,0),vec3f(1.64,0.30,0.74)),2.0));
  // The pleated web stops behind the fangs; you can see valley through the bite.
  m=vPick(m,vec2f(vBall(p-vec3f(-0.10,-0.13,0.0),vec3f(1.11,0.60,0.53)),3.0));
  m=vPick(m,vec2f(vBall(top-vec3f(-0.21,0.51,0.84),vec3f(0.49,0.31,0.28)),4.0));
  let spike=top-vec3f(-0.24,0.73,0.68);
  let hh=clamp(spike.y/0.62,0.0,1.0);
  m=vPick(m,vec2f(max(length(spike.xz+vec2f(0.44*hh,-0.14*hh))-0.28*(1.0-hh),max(-spike.y,spike.y-0.62))*0.79,7.0));
  m=vPick(m,vec2f(vBall(p-vec3f(0.29,-0.13,0.0),vec3f(0.57,0.43,0.68)),5.0));
  let nth=clamp(round((top.x-0.44)/0.48),0.0,2.0);
  let rootX=0.44+nth*0.48;
  let deep=0.38+0.11*nth+0.50*step(1.5,nth)*u.spare[1].y;
  let g=clamp((0.14-top.y)/deep,0.0,1.0);
  let fang=length(vec2f(top.x-rootX+deep*0.27*g*g,top.z-0.49+0.08*g))-(0.12+0.035*nth)*(1.0-g);
  m=vPick(m,vec2f(max(fang,max(top.y-0.14,0.14-deep-top.y))*0.87,6.0));
  let jr=1.42+0.40*clamp(round((jaw.x-1.42)/0.40),-1.0,0.0);
  let jh=clamp((jaw.y+0.12)/0.43,0.0,1.0);
  let milk=length(vec2f(jaw.x-jr+0.06*jh*jh,jaw.z-0.45)) - 0.13*(1.0-jh);
  m=vPick(m,vec2f(max(milk,max(-0.12-jaw.y,jaw.y-0.31)),6.0));
  let tx=p.x-0.78; let ex=0.78+1.65*taste; let fork=max(0.0,tx-ex);
  let wave=-0.22-0.24*u.spare[1].y + 0.16*taste*sin(3.3*tx-8.3*u.frame.z);
  let tongue=length(vec2f(p.y-wave,abs(p.z)-fork*0.58))-(0.095-0.072*smoothstep(0.0,0.70,fork));
  return vPick(m,vec2f(max(tongue,max(-tx,tx-ex-0.18-0.55*taste))*0.82,8.0));
}
struct ViperPrint { @location(0) ink: vec4f, @location(1) depths: vec4f }
@fragment fn drawViper(@builtin(position) pos: vec4f) -> ViperPrint {
  let scale=u.vStamp.z; let d=u.vStamp.xy+pos.xy/scale;
  let ray=eyeRay(d); let eye=eyeAt(); let pen=u.look.z*0.51;
  var front=1e6; var depth=0.0; var across=0.0; var loc=0.0; var idx=0;
  var N=vec3f(0,1,0); var shade=0.0; var shDepth=0.0; var edge=0.0;
  for(var run=0;run<4;run++) {
    let box=u.vRuns[run];
    if(any(d<box.xy) || any(d>box.zw)){continue;}
    for(var i=run*6;i<min(run*6+6,23);i++) {
    let a=u.snake[i]; let b=u.snake[i+1]; let s=u.vFloor[i]; let e=u.vFloor[i+1];
    let pad=max(a.z,b.z)*1.85+4.0;
    if (any(d < min(min(a.xy,b.xy),min(s.xy,e.xy))-pad) || any(d>max(max(a.xy,b.xy),max(s.xy,e.xy))+pad)){continue;}
    let sv=(e.xy-s.xy)*vec2f(1.0,1.8); let sd=(d-s.xy)*vec2f(1.0,1.8);
    let k=clamp(dot(sd,sv)/max(0.001,dot(sv,sv)),0.0,1.0);
    let shadow=(1.0-smoothstep(0.48,1.70,length(sd-k*sv)/max(1.0,mix(a.z,b.z,k))))*mix(s.w,e.w,k);
    if(shadow>shade){shade=shadow; shDepth=mix(s.z,e.z,k);}
    if (any(d<min(a.xy,b.xy)-pad) || any(d>max(a.xy,b.xy)+pad)){continue;}
    // Intersection of a ray and a capped world cylinder, including the nearly end-on case.
    let A=u.vCoil[i]; let B=u.vCoil[i+1]; let seg=B.xyz-A.xyz;
    let L=max(length(seg),0.0001); let T=seg/L; let o=eye-A.xyz;
    let V=ray-T*dot(ray,T); let O=o-T*dot(o,T); let vv=max(dot(V,V),1e-6);
    let t0=-dot(O,V)/vv; let foot=dot(o+ray*t0,T);
    let h=clamp(foot/L,0.0,1.0); let r=mix(A.w,B.w,h);
    let centre=A.xyz+seg*h; let along=dot(centre-eye,ray);
    let miss=length(eye+along*ray-centre)-r;
    let screen=miss*u.world.w/max(0.1,centre.z-eye.z);
    if(screen>pen+1.0/scale){continue;}
    let cyl=r*r-dot(O+V*t0,O+V*t0);
    var hit=t0-sqrt(max(cyl,0.0)/vv);
    let v=dot(o+ray*hit,T);
    if(v<0.0 || v>L || cyl<0.0 || vv<0.001){
      let cap=select(A,B,foot>L || v>L); let c=cap.xyz-eye;
      let footRay=dot(c,ray); let rad=cap.w*cap.w-dot(c-ray*footRay,c-ray*footRay);
      hit=select(along,footRay-sqrt(max(0.0,rad)),rad>=0.0);
    }
    // A grazing ink edge is not a nearer *surface* inside the adjacent cylinder.
    if(screen>0.0 && across>0.0 && abs(hit-front)<r*2.1){continue;}
    if(hit<=0.0 || (hit>=front && !(screen<0.0 && edge>0.75 && hit<front+r*2.1))){continue;}
    front=hit; depth=hit*ray.z; edge=smoothstep(-1.0,0.65,screen*scale);
    across=fill((pen-screen)*scale); idx=i;
    let surface=eye+hit*ray; loc=clamp(dot(surface-A.xyz,T)/L,0.0,1.0);
    N=normalize(surface-(A.xyz+loc*seg)+vec3f(0.00001));
    }
  }
  var pigment=INK;
  if(across>0.0){
    let T=normalize(u.vCoil[idx+1].xyz-u.vCoil[idx].xyz+vec3f(0.00001));
    let side=normalize(cross(T,vec3f(0,1,0))+vec3f(0.00001));
    let crown=dot(N,cross(side,T)); let phi=atan2(dot(N,side),crown);
    let back=f32(idx)+loc; let cell=fract(back*0.37+0.095*abs(phi))-0.5;
    let flank=abs(phi)-1.07;
    let inset=abs(cell)*2.7+0.61*abs(flank)-0.90;
    let skin=mix(TEAL,AQUA,smoothstep(-0.1,0.02,crown));
    pigment=viperPlate(skin,mix(PURPLE,PINK,0.48),inset*13.0,1.15);
    let blink=1.0-smoothstep(0.0,0.040,abs(fract(u.frame.z*0.26-floor(back*0.37+0.095*abs(phi))*0.057)-0.5));
    let gem=(abs(cell)*3.4+0.87*abs(flank)-0.57+0.43*blink)*13.0;
    pigment=viperPlate(pigment,YELLOW,gem,0.92);
    let slit=(abs(cell)*5.4+0.65*abs(flank)-0.29)*13.0;
    pigment=mix(pigment,INK,fill(-max(slit,gem)));
    let belly=1.0-smoothstep(-0.33,-0.27,crown);
    let cut=abs(fract(back*1.42+0.17*cos(phi))-0.5);
    pigment=mix(pigment,mix(mix(PAPER,YELLOW,0.22),INK,1.0-smoothstep(0.024,0.080,cut)),belly);
    let light=dot(N,SUNWARD);
    pigment*=mix(vec3f(0.46,0.48,0.66),vec3f(0.80,0.84,0.9),smoothstep(-0.24,-0.18,light));
    pigment*=mix(1.0,1.22,smoothstep(0.34,0.40,light));
    let gleam=dot(N,normalize(SUNWARD-ray));
    pigment=mix(pigment,mix(AQUA,PAPER,0.66),smoothstep(0.943,0.964,gleam)*0.93);
    pigment=mix(pigment,INK,edge);
  }
  let centre=u.vCoil[0].xyz; let unit=u.vHead.w;
  let up=normalize(cross(u.vSide.xyz,u.vHead.xyz))*sign(u.snakeLook.x);
  let basis=mat3x3f(u.vHead.xyz,up,u.vSide.xyz);
  let ro=transpose(basis)*(eye-centre)/unit; let rd=transpose(basis)*ray;
  let bound=vec3f(0.17,0.0,0.0); let line=dot(bound-ro,rd);
  let impact=length(ro+rd*line-bound);
  let farTongue=vec3f(2.88,-0.40,0.0); let long=dot(farTongue-ro,rd);
  let tongueRay=length(ro+rd*long-farTongue) < 1.22;
  let R=select(2.48,4.38,tongueRay);
  if(impact<R && line>0.0){
    let gape=u.spare[1].y; let high=0.055+0.31*gape; let low=-0.085-0.63*gape;
    let hinge=vec4f(cos(high),sin(high),cos(low),sin(low)); let taste=u.snakeLook.z;
    let deep=sqrt(max(0.0,R*R-impact*impact)); var travel=line-deep;
    var nearest=1e4; var nearAt=travel; var m=vec2f(99,0);
    let eps=max(0.004,0.31*u.snake[0].w/(u.world.w*scale*unit));
    for(var i=0;i<43;i++){
      m=vSkull(ro+travel*rd,hinge,taste);
      if(m.x<nearest){nearest=m.x; nearAt=travel;}
      if(m.x<eps || travel>line+deep){break;}
      travel+=max(eps,m.x*0.92);
    }
    let margin=pen*u.snake[0].w/(u.world.w*unit);
    if(nearest<margin+eps && nearAt*unit<front){
      let surf=ro+nearAt*rd;
      let a=vec2f(0.012,-0.012);
      let localN=normalize(a.xyy*vSkull(surf+a.xyy,hinge,taste).x+a.yyx*vSkull(surf+a.yyx,hinge,taste).x+a.yxy*vSkull(surf+a.yxy,hinge,taste).x+a.xxx*vSkull(surf+a.xxx,hinge,taste).x);
      let normal=basis*localN; let light=dot(normal,SUNWARD);
      let mat=vSkull(surf,hinge,taste).y;
      var c=AQUA;
      if(mat==1.0 || mat==7.0){
        c=mix(TEAL,LIME,smoothstep(0.20,0.24,normal.y));
        c=mix(c,PINK,smoothstep(1.05,1.09,surf.y));
        let nostril=length((surf.xy-vec2f(1.56,0.44+0.75*gape))*vec2f(0.9,1.4));
        c=mix(c,INK,1.0-smoothstep(0.07,0.105,nostril));
      }else if(mat==2.0){
        c=mix(PAPER,YELLOW,0.25); let scute=abs(fract(surf.x*1.8+0.74*surf.y)-0.5);
        c=mix(c,TEAL,(1.0-smoothstep(0.022,0.055,scute))*smoothstep(0.6,0.8,abs(localN.z)));
        let jawNormal=dot(localN.xy,vec2f(-hinge.w,hinge.z));
        c=mix(c,INK,smoothstep(0.12,0.26,jawNormal));
        c=mix(c,PINK*0.88,smoothstep(0.27,0.35,jawNormal));
        c=mix(c,mix(PURPLE,PINK,0.41),smoothstep(0.62,0.68,jawNormal));
      }else if(mat==3.0){ c=mix(PURPLE*0.49,PINK,smoothstep(-0.1,0.48,normal.y)); }
      else if(mat==6.0){ c=mix(PAPER,vec3f(1.0),0.36); }
      else if(mat==8.0){ c=PINK*1.14; }
      else {
        let gaze=vec2f(u.spare[1].z,-u.spare[1].w);
        let sideEye=mat==4.0;
        let eyeDir=normalize(-rd+vec3f(gaze*0.28,0.0));
        let rightEye=normalize(cross(eyeDir,vec3f(0.0,1.0,0.0)));
        let facing=vec2f(dot(localN,rightEye),dot(localN,cross(rightEye,eyeDir)));
        var pupil=length(facing*vec2f(1.0,0.87));
        c=mix(mix(PURPLE,PINK,0.75),PAPER,smoothstep(0.13,0.26,dot(localN,eyeDir)));
        c=mix(c,AQUA,1.0-smoothstep(0.51,0.56,pupil));
        if(sideEye){c=YELLOW; pupil=abs(facing.x)*1.11+0.27*abs(facing.y);}
        c=mix(c,INK,1.0-smoothstep(0.21,0.28,pupil));
        c=mix(c,vec3f(1.14),1.0-smoothstep(0.08,0.13,length(facing-vec2f(-0.10,0.17))));
      }
      c*=mix(vec3f(0.51,0.51,0.64),vec3f(0.85),smoothstep(-0.20,-0.13,light));
      c*=mix(1.0,1.25,smoothstep(0.30,0.37,light));
      c=mix(c,PAPER,smoothstep(0.92,0.96,dot(normal,normalize(SUNWARD-ray)))*0.76);
      let rim=smoothstep(0.085,0.19,-dot(normal,ray));
      pigment=mix(INK,c,rim*(1.0-smoothstep(eps*0.6,eps*1.7,nearest)));
      across=1.0-smoothstep(margin-eps,margin+eps,nearest); depth=nearAt*unit*ray.z;
    }
  }
  return ViperPrint(vec4f(pigment*across,across),vec4f(depth*across,shade,shDepth*shade,0));
}

// A petal lying along +x from its root at the origin, len long and wide at its
// widest. Pointed petals are a lens (two arcs meeting at each end); round ones an ellipse.
fn petal(p: vec2f, len: f32, wide: f32, pointed: bool) -> f32 {
  let q = vec2f(p.x - len * 0.5, abs(p.y));
  if (!pointed) { return oval(q, vec2f(len * 0.5, wide)); }
  let b = len * 0.5;
  let r = 0.5 * (wide + b * b / wide);
  let off = r - wide;
  let end = vec2f(abs(q.x), q.y);
  if ((end.x - b) * off > end.y * b) { return length(end - vec2f(b, 0.0)); }
  return length(end - vec2f(0.0, -off)) - r;
}

// The six bands of a rainbow petal, red first, chosen without an array.
fn bowColour(i: i32) -> vec3f {
  var c = PURPLE;
  c = select(c, ${vec3('#4a8fd8')}, i == 4);
  c = select(c, ${vec3('#5fd0c0')}, i == 3);
  c = select(c, YELLOW, i == 2);
  c = select(c, ORANGE, i == 1);
  return select(c, RED, i == 0);
}

// How far ring k of a flower has opened (0 to 1) for how open the whole flower
// is. The outer ring goes first, each inner one after it, and each swings a
// little past open before it settles.
fn unfurl(open: f32, k: f32) -> f32 {
  let x = clamp((open - 0.1 - 0.13 * k) / 0.55, 0.0, 1.0) - 1.0;
  return 1.0 + 2.2 * x * x * x + 1.2 * x * x;
}

// One petal lying along +x from its root at the origin, painted over color in
// flat tones: a heart and a throat at the root (throat says how far along it
// reaches), the body, a tip of its own, and the half beyond the fold in shade
// (side, -1 to 1, says which half faces the light and how squarely). notch
// cuts a fork into the tip, frill crimps it, veins fan along it. As scorch
// rises it browns and chars from the tip in.
fn petalPaint(color: vec3f, local: vec2f, len: f32, wide: f32, pointed: bool, notch: f32, frill: f32, veins: f32, throat: f32, unit: f32, pen: f32, heart: vec3f, deep: vec3f, body: vec3f, shade: vec3f, tip: vec3f, side: f32, scorch: f32) -> vec3f {
  let along = local.x / len;
  let across = local.y / wide;
  var sd = petal(local, len, wide, pointed);
  sd += frill * wide * 0.08 * sin(across * 9.0) * smoothstep(0.55, 0.95, along);
  sd = max(sd, notch * wide - length(local - vec2f(len + 0.35 * notch * wide, 0.0)));
  let s = sd * unit;
  if (s > pen * 1.25 + 1.0) { return color; }
  var tone = body;
  tone = mix(tone, tip, fill((along - 0.76 + 0.1 * across * across) * len * unit));
  tone = mix(tone, deep, fill((throat - along + 0.04 * cos(across * 4.0)) * len * unit));
  tone = mix(tone, heart, fill((throat * 0.62 - along + 0.03 * cos(across * 5.0)) * len * unit));
  if (veins > 0.0) {
    let spread = wide * (0.25 + along) / (veins * 0.5);
    let v = abs(fract(local.y / spread + 0.5) - 0.5) * spread;
    tone = mix(tone, shade * 0.85, 0.7 * stroke(v * unit, pen * 0.28) * smoothstep(throat * 0.8, throat + 0.06, along) * (1.0 - smoothstep(0.74, 0.88, along)));
  }
  // The fold: the half turned from the light lies in a cool flat shade.
  let away = fill(-sign(side) * local.y * unit) * smoothstep(0.05, 0.4, abs(side)) * smoothstep(0.06, 0.18, along);
  tone = mix(tone, mix(tone * vec3f(0.82, 0.74, 0.9), shade, 0.18), away);
  // A short gleam on the lit half, and the midrib.
  let gleam = abs(local.y - sign(side) * wide * 0.42 * sin(3.14159 * clamp(along, 0.0, 1.0)));
  tone = mix(tone, mix(body, vec3f(1.0, 0.98, 0.92), 0.55), stroke(gleam * unit, pen * 0.38) * smoothstep(0.32, 0.42, along) * (1.0 - smoothstep(0.6, 0.7, along)) * smoothstep(0.2, 0.5, abs(side)));
  tone = mix(tone, deep * 0.7, 0.85 * stroke(abs(local.y) * unit, pen * 0.3) * smoothstep(0.05, 0.12, along) * (1.0 - smoothstep(0.48, 0.64, along)));
  if (scorch > 0.0) {
    let front = 1.1 - 1.25 * scorch + 0.07 * sin(across * 7.0);
    tone = mix(tone, tone * vec3f(0.62, 0.5, 0.42), smoothstep(0.0, 0.5, scorch));
    tone = mix(tone, vec3f(0.17, 0.11, 0.09), fill((along - front) * len * unit));
    tone = mix(tone, vec3f(1.3, 0.55, 0.16), stroke((along - front) * len * unit, pen * 0.45) * smoothstep(0.0, 0.1, scorch) * (1.0 - smoothstep(0.55, 0.9, scorch)));
  }
  let c = mix(color, INK, fill(pen * 1.25 - s));
  return mix(c, tone, fill(-s));
}

// A ring of count petals round a flower's middle, the first lying along spin.
// Each lies over the next like a pinwheel, so every overlap has a front and a
// back and an inked edge between; only the two petals that can cover a point
// are drawn. A rainbow ring gives each petal its own colour.
fn petalRing(color: vec3f, far: f32, around: f32, count: f32, spin: f32, root: f32, len: f32, wide: f32, pointed: bool, notch: f32, frill: f32, veins: f32, throat: f32, unit: f32, pen: f32, heart: vec3f, deep: vec3f, body: vec3f, shade: vec3f, tip: vec3f, rainbow: bool, scorch: f32, seed: f32) -> vec3f {
  if (len < 0.02 || far < root - 0.02 || far > root + len * 1.1 + 0.03) { return color; }
  let sector = TAU / count;
  let light = normalize(u.look.xy);
  let j = floor((around - spin) / sector);
  var c = color;
  for (var m = 1; m >= 0; m--) {
    let idx = j + f32(m);
    let axis = idx * sector + spin;
    let local = far * vec2f(cos(around - axis), sin(around - axis)) - vec2f(root, 0.0);
    let n = idx - count * floor(idx / count + 0.001);
    let luck = hash(vec2f(n * 7.0 + count, seed * 113.0));
    var b = body;
    var sh = shade;
    var tp = tip;
    if (rainbow) {
      b = bowColour(i32(n) % 6);
      sh = b * vec3f(0.72, 0.6, 0.82);
      tp = mix(b, vec3f(1.0, 0.96, 0.86), 0.5);
    }
    let side = clamp(4.0 * dot(vec2f(-sin(axis), cos(axis)), light), -1.0, 1.0);
    c = petalPaint(c, local, len * (0.93 + 0.1 * luck), wide, pointed, notch, frill, veins, throat, unit, pen, heart, deep, b, sh, tp, side, scorch);
  }
  return c;
}

// The middle of a daisy or a sunflower: an inked dome packed with seeds set
// at the golden angle, a darker ring at its foot, a lit half and a gleam.
fn seedDisc(color: vec3f, at: vec2f, size: f32, unit: f32, pen: f32, seed: f32, rim: vec3f, mid: vec3f, pip: vec3f, scorch: f32) -> vec3f {
  let far = length(at);
  let s = (far - size) * unit;
  if (size < 0.01 || s > pen * 1.3 + 1.0) { return color; }
  let light = normalize(u.look.xy);
  var tone = mix(rim, mid, fill((size * 0.8 - far) * unit));
  tone = mix(tone, mix(tone, vec3f(1.0, 0.95, 0.8), 0.28), fill((dot(at, light) - 0.15 * size) * unit));
  var near = 1e9;
  for (var n = 0; n < 21; n++) {
    let i = f32(n);
    let a = i * 2.39996 + seed * 6.0;
    near = min(near, length(at - size * 0.84 * sqrt((i + 0.5) / 21.0) * vec2f(cos(a), sin(a))));
  }
  tone = mix(tone, pip, fill((size * 0.105 - near) * unit));
  tone = mix(tone, vec3f(1.5, 1.42, 1.18), fill((size * 0.12 - length(at - light * size * 0.5)) * unit));
  let c = mix(color, INK, fill(pen * 1.25 - s));
  return mix(c, mix(tone, vec3f(0.17, 0.11, 0.09), scorch), fill(-s));
}

// A shut bud in the head's middle, b head radii across: its petals wrapped in
// a spiral, held at the foot by three green sepals.
fn budPaint(color: vec3f, at: vec2f, b: f32, unit: f32, pen: f32, body: vec3f, shade: vec3f, scorch: f32) -> vec3f {
  let ash = vec3f(0.17, 0.11, 0.09);
  let green = mix(${vec3('#3fa56a')}, ash, scorch);
  let greenLit = mix(${vec3('#8fd46a')}, ash, scorch);
  let up = vec2f(-at.y, at.x) + vec2f(b * 0.85, 0.0); // +x runs up the bud from its foot
  let lean = clamp(4.0 * normalize(u.look.xy).x, -1.0, 1.0);
  var c = color;
  for (var i = 0; i < 2; i++) {
    let q = turn(select(0.62, -0.62, i == 0)) * up;
    let sd = petal(q, b * 1.3, b * 0.3, true) * unit;
    c = mix(c, INK, fill(pen * 1.25 - sd));
    c = mix(c, green, fill(-sd));
  }
  let sd = petal(up, b * 2.2, b * 0.78, true) * unit;
  var tone = mix(body, shade, 0.25);
  tone = mix(tone, tone * vec3f(0.74, 0.64, 0.84), fill(-at.x * sign(lean) * unit) * abs(lean));
  let v = clamp(up.x / (b * 2.2), 0.0, 1.0);
  for (var i = 0; i < 2; i++) {
    let fold = at.x - b * (0.62 - 1.3 * v + 0.35 * f32(i)) * (1.0 - 0.5 * v);
    tone = mix(tone, INK, 0.8 * stroke(abs(fold) * unit, pen * 0.4) * smoothstep(0.12, 0.25, v) * (1.0 - smoothstep(0.85, 0.95, v)));
  }
  c = mix(c, INK, fill(pen * 1.25 - sd));
  c = mix(c, mix(tone, ash, scorch), fill(-sd));
  let front = petal(up, b * 1.1, b * 0.34, true) * unit;
  c = mix(c, INK, fill(pen * 1.25 - front));
  c = mix(c, mix(green, greenLit, fill(at.x * sign(lean) * unit) * abs(lean)), fill(-front));
  c = mix(c, INK, 0.6 * fill(-front) * stroke(abs(at.x) * unit, pen * 0.3) * step(b * 0.15, up.x));
  return c;
}

// One ring of a flower's petals: how many, turned how far (in petals), where
// they start and how long and wide they are, pointed or round, how deep the
// fork in the tip, how crimped, how many veins, how far the throat runs, how
// much darker or paler than the body, and how green (1 for sepals). A ring
// of no petals is none.
struct RingSpec { count: f32, offs: f32, root: f32, len: f32, wide: f32, pointed: f32, notch: f32, frill: f32, veins: f32, throat: f32, dark: f32, pale: f32, green: f32 }

fn ringSpec(kind: i32, k: i32, daisy: bool) -> RingSpec {
  var r = RingSpec(0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0);
  if (kind == 0) {
    if (k == 0) { r = RingSpec(14.0, 0.5, 0.08, 0.9, 0.13, 0.0, 0.5, 0.0, 0.0, 0.3, 0.5, 0.0, 0.0); }
    else if (k == 1) { r = RingSpec(14.0, 0.0, 0.08, 0.72, 0.125, 0.0, 0.5, 0.0, 0.0, 0.32, 0.0, 0.0, 0.0); }
    else { r = RingSpec(11.0, 0.0, 0.06, 0.48, 0.11, 0.0, 0.4, 0.0, 0.0, 0.3, 0.0, 0.55, 0.0); }
  } else if (kind == 1) {
    let pointed = select(1.0, 0.0, daisy);
    let notch = select(0.0, 0.45, daisy);
    if (k == 0) { r = RingSpec(6.0, 0.29, 0.1, 0.58, 0.12, 1.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 1.0); }
    else if (k == 1) { r = RingSpec(13.0, 0.5, 0.18, 0.8, 0.1, pointed, notch, 0.0, 0.0, 0.3, 0.45, 0.2, 0.0); }
    else { r = RingSpec(13.0, 0.0, 0.18, 0.76, 0.105, pointed, notch, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0); }
  } else if (kind == 2) {
    if (k == 0) { r = RingSpec(5.0, 0.5, 0.04, 0.84, 0.21, 1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.25); }
    else if (k == 1) { r = RingSpec(5.0, 0.0, 0.04, 0.8, 0.2, 0.0, 0.0, 0.0, 3.0, 0.3, 0.0, 0.0, 0.0); }
  } else if (kind == 3) {
    if (k == 0) { r = RingSpec(2.0, 0.5, -0.06, 0.98, 0.6, 0.0, 0.0, 1.0, 4.0, 0.38, 0.3, 0.0, 0.0); }
    else if (k == 1) { r = RingSpec(2.0, 0.0, -0.06, 0.84, 0.55, 0.0, 0.0, 1.0, 4.0, 0.4, 0.0, 0.0, 0.0); }
  } else if (kind == 5) {
    if (k == 0) { r = RingSpec(8.0, 0.5, 0.04, 0.92, 0.2, 1.0, 0.0, 0.0, 0.0, 0.32, 0.4, 0.0, 0.0); }
    else if (k == 1) { r = RingSpec(8.0, 0.0, 0.04, 0.8, 0.2, 1.0, 0.0, 0.0, 3.0, 0.32, 0.0, 0.0, 0.0); }
    else { r = RingSpec(6.0, 0.29, 0.03, 0.55, 0.16, 1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.4, 0.0); }
  } else if (kind == 6) {
    if (k == 0) { r = RingSpec(5.0, 0.5, 0.0, 1.06, 0.4, 0.0, 0.0, 1.0, 3.0, 0.42, 0.55, 0.0, 0.0); }
    else if (k == 1) { r = RingSpec(5.0, 0.0, 0.0, 0.9, 0.46, 0.0, 0.3, 0.0, 5.0, 0.5, 0.0, 0.0, 0.0); }
  }
  return r;
}

// A flower head, at in head radii (y down). Six kinds, chosen by seed: a
// chrysanthemum of three offset rings, a sunflower or daisy round a seed
// dome, a passion flower with its rayed corona, a poppy of four crinkled
// petals round a seed pod, a morning glory that unwinds from a spiral, and a
// lotus; each with palettes of its own. A seed below 0 is the poster's own
// flower: five heart-tipped pink petals, hot at the heart, over five deeper
// ones, a ring of stamens and a golden dome. open runs from a shut bud (0) to
// full bloom (1); scorch from fresh (0) to burnt black (1).
fn bloomHead(at: vec2f, unit: f32, pen: f32, t: f32, seed: f32, open: f32, scorch: f32, under: vec3f) -> vec3f {
  let far = length(at);
  if (far > 1.12) { return under; }
  let poster = seed < 0.0;
  let kind = select(i32(fract(seed * 7.31) * 6.0) % 6, 6, poster);
  let tint = fract(seed * 41.37);
  let ash = vec3f(0.17, 0.11, 0.09);
  let light = normalize(u.look.xy);
  let around = atan2(at.y, at.x);
  let way = select(-1.0, 1.0, fract(seed * 5.1) > 0.5);
  // The petals swing round a little as they open, then only breathe.
  let rest = select(seed * 9.0 + 0.05 * sin(t * 0.7 + seed * 4.0), 0.07 * sin(t * 0.6) - 0.3, poster);
  let breath = select(1.0, 1.0 + 0.02 * sin(t * 1.3), poster);
  let e0 = unfurl(open, 0.0);
  let green = ${vec3('#3fa56a')};
  let greenDeep = ${vec3('#25704a')};
  let greenLit = ${vec3('#8fd46a')};
  let daisy = tint >= 0.45;

  // Each kind's colours: heart, throat, body, shade, tip, and its middle.
  var heart = ${vec3('#c02a7e')};
  var deep = ${vec3('#c02a7e')};
  var body = ${vec3('#f2609a')};
  var shade = ${vec3('#a8216e')};
  var tip = ${vec3('#fbd0de')};
  var mid = YELLOW;
  var rim = AMBER;
  var pip = ${vec3('#7c2a12')};
  var rainbow = false;
  if (kind == 0) {
    if (tint < 0.34) {
      heart = ${vec3('#c0391b')}; deep = ${vec3('#ef6f1f')}; body = ${vec3('#fbbf2f')}; shade = ${vec3('#e0761c')}; tip = ${vec3('#fff0b8')};
    } else if (tint > 0.67) {
      heart = ${vec3('#3f1a66')}; deep = ${vec3('#6a2d96')}; body = ${vec3('#b06ac4')}; shade = ${vec3('#6a2d96')}; tip = ${vec3('#f2c8f0')};
    }
    mid = ${vec3('#f5e06a')}; rim = deep; pip = heart;
  } else if (kind == 1) {
    if (!daisy) {
      heart = ${vec3('#c0391b')}; deep = ${vec3('#ef6f1f')}; body = YELLOW; shade = ${vec3('#e88a1c')}; tip = ${vec3('#ffe27a')};
      mid = ${vec3('#a8441a')}; rim = ${vec3('#5a2210')}; pip = ${vec3('#f5a02a')};
    } else {
      heart = ${vec3('#f5a02a')}; deep = ${vec3('#f28ab0')}; body = ${vec3('#fbf0d2')}; shade = ${vec3('#d9a6c0')}; tip = ${vec3('#f6a0c0')};
      mid = YELLOW; rim = ${vec3('#e8701f')}; pip = ${vec3('#b8431c')};
      rainbow = tint > 0.82;
    }
  } else if (kind == 2) {
    heart = ${vec3('#d9b8ec')}; deep = ${vec3('#c9a8e6')}; body = ${vec3('#fbf0e0')}; shade = ${vec3('#b9a0d6')}; tip = ${vec3('#e8f4ec')};
    if (tint > 0.5) { heart = ${vec3('#8a5ac4')}; deep = ${vec3('#a77ad6')}; body = ${vec3('#d9b8ec')}; shade = ${vec3('#8a5ac4')}; tip = ${vec3('#f4e6fa')}; }
  } else if (kind == 3) {
    heart = ${vec3('#2a1230')}; deep = ${vec3('#2a1230')}; body = RED; shade = ${vec3('#b02018')}; tip = ${vec3('#f5722a')};
    if (tint < 0.34) { body = ${vec3('#f5722a')}; shade = ${vec3('#d84a1a')}; tip = YELLOW; }
    else if (tint > 0.67) { body = PINK; shade = ${vec3('#c02a7e')}; tip = ${vec3('#f9a8c8')}; heart = ${vec3('#4a1240')}; deep = heart; }
  } else if (kind == 4) {
    heart = ${vec3('#ffe27a')}; deep = ${vec3('#fff4e6')}; body = ${vec3('#4a8fd8')}; shade = ${vec3('#2c5fa6')}; tip = ${vec3('#c8e0ff')};
    if (tint < 0.34) { body = ${vec3('#8a3d9e')}; shade = ${vec3('#5a2070')}; tip = ${vec3('#f2a8dc')}; }
    else if (tint > 0.67) { body = ${vec3(P.magenta)}; shade = ${vec3('#8a1f63')}; tip = ${vec3('#fbd0e8')}; }
    rainbow = fract(seed * 13.7) > 0.75;
  } else if (kind == 5) {
    heart = ${vec3('#3f9c9a')}; deep = AQUA; body = ${vec3('#94dcd2')}; shade = ${vec3('#3f9c9a')}; tip = ${vec3('#f4fbf6')};
    if (tint > 0.67) { heart = ${vec3('#f28ab0')}; deep = ${vec3('#fbe0ea')}; body = ${vec3('#fbf0e6')}; shade = ${vec3('#d8b8c8')}; tip = ${vec3('#f6a0c0')}; }
    else if (tint > 0.4) { heart = ${vec3('#e06a9a')}; deep = ${vec3('#f28ab0')}; body = ${vec3('#f7b0cc')}; shade = ${vec3('#d0588a')}; tip = ${vec3('#fff0f4')}; }
  } else {
    heart = ORANGE; deep = RED; body = PINK; shade = ${vec3('#c02a7e')}; tip = ${vec3('#fbbcd4')};
    pip = ${vec3('#c0501c')};
  }

  var color = under;
  let b = 0.5 * (1.0 - smoothstep(0.12, 0.5, open));
  if (b > 0.004) { color = budPaint(color, at, b, unit, pen, body, shade, scorch); }
  let cs = smoothstep(0.15, 0.6, open); // how far the middle has come out

  // The rings of petals, the back one first.
  for (var k = 0; k < 3; k++) {
    let spec = ringSpec(kind, k, daisy);
    if (spec.count < 1.0) { continue; }
    let e = unfurl(open, f32(k));
    let spin = rest + way * 0.7 * (1.0 - min(e, 1.0)) + spec.offs * TAU / spec.count;
    let g = spec.green;
    color = petalRing(color, far, around, spec.count, spin, spec.root, spec.len * e * breath, spec.wide, spec.pointed > 0.5, spec.notch, spec.frill, spec.veins, spec.throat, unit, pen,
      mix(heart, greenDeep, g), mix(deep, greenDeep, g), mix(mix(mix(body, shade, spec.dark), tip, spec.pale), green, g), mix(shade, greenDeep, g), mix(tip, greenLit, g), rainbow && g == 0.0, scorch, seed + 0.3 * f32(k));
  }

  if (kind == 2) {
    // The passion flower's corona: banded threads over a dark ground.
    let e2 = unfurl(open, 2.0);
    let reach = (0.6 + 0.035 * sin(around * 24.0 + seed * 5.0)) * e2;
    if (e2 > 0.05 && far < reach + 0.06) {
      let edge = (far - reach) * unit;
      color = mix(color, INK, fill(pen * 1.1 - edge));
      color = mix(color, mix(${vec3('#3a1458')}, ash, scorch), fill(-edge));
      let r = far / max(reach, 0.01);
      var thread = ${vec3('#5a6ae0')};
      thread = mix(thread, vec3f(1.0, 0.97, 0.94), step(0.86, r));
      thread = mix(thread, ${vec3('#9a4ac8')}, step(r, 0.68));
      thread = mix(thread, vec3f(1.0, 0.97, 0.94), step(r, 0.54));
      thread = mix(thread, ${vec3('#5a1f7a')}, step(r, 0.4));
      let wav = around * 24.0 / TAU + 0.12 * sin(far * 16.0 + seed * 3.0);
      let gap = abs(fract(wav) - 0.5) * TAU / 24.0 * far;
      color = mix(color, mix(thread, ash, scorch), fill((0.024 - gap) * unit) * fill(-edge - 0.5) * step(0.12, far));
    }
  } else if (kind == 4) {
    // Morning glory: one funnel of five pleated panels that unwinds from a
    // twist as it opens, pale stripes to its five points, a white throat.
    let twist = way * 2.2 * (1.0 - min(e0, 1.0)) * (1.0 - far);
    let ang = around - rest + twist;
    let p5 = ang * 5.0 / TAU;
    let cell = p5 - round(p5);
    let reach = (0.84 + 0.06 * cos(TAU * cell)) * e0;
    let s = (far - reach) * unit;
    if (e0 > 0.02 && s < pen * 1.25 + 1.0) {
      let r = far / max(reach, 0.01);
      var tone = body;
      if (rainbow) {
        tone = bowColour(5 - clamp(i32((r - 0.3) / 0.7 * 6.0), 0, 5));
      }
      tone = mix(tone, tip, fill((r - 0.86) * reach * unit) * select(1.0, 0.0, rainbow));
      let axis = round(p5) * TAU / 5.0 + rest - twist;
      let side = clamp(4.0 * dot(vec2f(-sin(axis), cos(axis)), light), -1.0, 1.0);
      tone = mix(tone, mix(tone * vec3f(0.82, 0.74, 0.9), shade, 0.18), fill(-sign(side) * cell * far * unit) * smoothstep(0.05, 0.4, abs(side)));
      let lane = abs(cell) * TAU / 5.0 * far;
      tone = mix(tone, mix(tip, vec3f(1.0), 0.3), fill((0.03 + 0.03 * far - lane) * unit) * step(0.3, r));
      tone = mix(tone, INK, 0.8 * stroke((0.5 - abs(cell)) * TAU / 5.0 * far * unit, pen * 0.35) * smoothstep(0.3, 0.36, r) * (1.0 - smoothstep(0.9, 0.97, r)));
      tone = mix(tone, deep, fill((0.3 - r) * reach * unit));
      tone = mix(tone, heart, fill((0.13 - r) * reach * unit));
      if (scorch > 0.0) {
        tone = mix(tone, tone * vec3f(0.62, 0.5, 0.42), smoothstep(0.0, 0.5, scorch));
        tone = mix(tone, ash, fill((r - 1.1 + 1.25 * scorch) * reach * unit));
      }
      color = mix(color, INK, fill(pen * 1.25 - s));
      color = mix(color, tone, fill(-s));
    }
  }

  if (cs > 0.0) {
    // A fringe of stamens: the poppy's dark, the lotus's and the poster flower's gold.
    if (kind == 3 || kind >= 5) {
      let count = select(select(18.0, 16.0, poster), 22.0, kind == 3);
      let inner = select(0.1 * cs, 0.19, poster);
      let fringe = select(select(0.25 * cs, 0.335, poster), 0.28 * cs, kind == 3);
      let thick = select(0.011, 0.013, poster);
      let bead = select(select(0.024 * cs, 0.036, poster), 0.026 * cs, kind == 3);
      let turned = select(around - rest, around - 0.1 * t, poster);
      let cell = (fract(turned * count / TAU) - 0.5) * TAU / count * far;
      let stalk = max(abs(cell) - thick, max(inner - far, far - fringe)) * unit;
      let threadTone = select(YELLOW, ${vec3('#2a1230')}, kind == 3);
      color = mix(color, INK, fill(pen * 0.8 - stalk));
      color = mix(color, mix(threadTone, ash, scorch), fill(-stalk));
      let dot5 = (bead - length(vec2f(far - fringe, cell))) * unit;
      let beadTone = select(ORANGE * 1.12, ${vec3('#f5e06a')}, kind == 3);
      color = mix(color, INK, fill(dot5 + pen * 0.8));
      color = mix(color, mix(beadTone, ash, scorch), fill(dot5));
      color = mix(color, mix(vec3f(1.4, 1.2, 0.9), ash, scorch), fill(dot5 - bead * 0.6 * unit));
    }
    if (kind <= 1 || poster) {
      color = seedDisc(color, at, select(select(select(0.33, 0.24, daisy), 0.13, kind == 0), 0.215, poster) * cs, unit, pen, select(seed, 0.5, poster), rim, mid, pip, scorch);
    } else if (kind == 3 || kind == 5) {
      // A seed pod: the poppy's starred, the lotus's pricked with holes.
      let poppy = kind == 3;
      let pod = (far - select(0.12, 0.13, poppy) * cs) * unit;
      color = mix(color, INK, fill(pen * 1.25 - pod));
      var podTone = mix(select(${vec3('#c8d84a')}, ${vec3('#9ab88a')}, poppy), select(${vec3('#eef08a')}, ${vec3('#c8dca8')}, poppy), fill(dot(at, light) * unit));
      let ray = (fract((around - rest) * 8.0 / TAU) - 0.5) * TAU / 8.0 * far;
      let a6 = round((around - rest) * 6.0 / TAU) * TAU / 6.0 + rest;
      let hole = min(length(at), length(at - 0.065 * cs * vec2f(cos(a6), sin(a6))));
      podTone = select(mix(podTone, ${vec3('#6a7a20')}, fill((0.018 * cs - hole) * unit)), mix(podTone, ${vec3('#6a2d76')}, stroke(abs(ray) * unit, pen * 0.6) * step(0.02 * cs, far)), poppy);
      color = mix(color, mix(podTone, ash, scorch), fill(-pod));
    } else if (kind == 2) {
      // Five anthers and three purple stigmas over a green ovary.
      let spin1 = rest + way * 0.7 * (1.0 - min(unfurl(open, 1.0), 1.0));
      let ovary = (far - 0.075 * cs) * unit;
      color = mix(color, INK, fill(pen * 1.2 - ovary));
      color = mix(color, mix(mix(green, greenLit, 0.4), ash, scorch), fill(-ovary));
      let a5 = round((around - spin1) * 5.0 / TAU) * TAU / 5.0 + spin1;
      let q5 = turn(-a5) * at - vec2f(0.17 * cs, 0.0);
      let anther = oval(q5, vec2f(0.035, 0.08) * cs + 0.001) * unit;
      color = mix(color, INK, fill(pen * 1.1 - anther));
      color = mix(color, mix(mix(${vec3('#d8e04a')}, ${vec3('#a0b03a')}, fill(-q5.y * way * unit)), ash, scorch), fill(-anther));
      let a3 = round((around - rest - 0.5) * 3.0 / TAU) * TAU / 3.0 + rest + 0.5;
      let dir3 = vec2f(cos(a3), sin(a3));
      let style = (segment(at, vec2f(0.0), dir3 * 0.13 * cs) - 0.016 * cs) * unit;
      let knob = (length(at - dir3 * 0.14 * cs) - 0.034 * cs) * unit;
      let stig = min(style, knob);
      color = mix(color, INK, fill(pen * 1.0 - stig));
      color = mix(color, mix(${vec3('#7a2a8e')}, ash, scorch), fill(-stig));
    }
  }
  return color;
}

// A tongue of flame standing on at = (0, 0), y up, one unit tall. Returns how
// far inside it the point is, as a share of the flame's half-width there.
fn tongue(at: vec2f, t: f32, seed: f32) -> f32 {
  let k = clamp(at.y, 0.0, 1.0);
  let girth = 0.34 * pow(sin(3.14159 * pow(k, 0.5)), 0.85);
  let lick = 0.16 * sin(k * 5.0 - t * 11.0 + seed * 4.0) * k;
  return select(-1.0, girth - abs(at.x - lick), at.y > 0.0 && at.y < 1.0);
}

// A whole flower: it sprouts where the sun's lasers touch the ground, rises on
// a swaying stem, opens, and if it is hit again burns down to nothing.
// spot is x, row, time born, time set alight; look is head size and seed.
fn bloom(d: vec2f, scale: f32, pen: f32, t: f32, spot: vec4f, look: vec4f, baseY: f32, under: vec3f) -> vec3f {
  let size = look.x;
  let seed = look.y;
  let age = t - spot.z;
  if (size <= 0.0 || age < 0.0) { return under; }
  let burn = select(0.0, clamp((t - spot.w) / 1.4, 0.0, 1.0), spot.w > 0.0);
  let rise = clamp((age - 0.1) / 1.5, 0.0, 1.0);
  let grow = (1.0 - pow(1.0 - rise, 3.0)) * (1.0 - smoothstep(0.45, 1.0, burn));
  let tall = size * 2.7 * grow;
  let chorusSway = select(0.0, size * 0.32 * u.cosmos.w * sin(3.14159265 * u.chorusBeat.x) * grow, cosmosLive); // (it sways to the chorus)
  let sway = size * 0.4 * sin(t * 0.9 + seed * 9.0) * grow + chorusSway;
  let base = vec2f(spot.x, baseY);
  let head = base + vec2f(sway, -tall);
  let r = size * (0.3 + 0.7 * smoothstep(0.2, 1.0, grow)) * select(1.0, 1.0 + 0.22 * u.cosmos.w * u.chorusBeat.y, cosmosLive);
  let alight = spot.w > 0.0; // flames reach higher and wider than the flower
  if (abs(d.x - spot.x) > size * select(1.6, 1.9, alight) + abs(chorusSway) + select(0.0, 0.22 * size * u.cosmos.w * u.chorusBeat.y, cosmosLive) || d.y < head.y - size * select(1.25, 2.6, alight) || d.y > baseY + 8.0) { return under; }
  var color = under;
  let ash = vec3f(0.17, 0.11, 0.09);
  let leafy = mix(${vec3('#3fa56a')}, ash, smoothstep(0.0, 0.7, burn));
  let leafLit = mix(${vec3('#8fd46a')}, ash, smoothstep(0.0, 0.7, burn));

  // The stem bends the other way from the head and tapers as it climbs. Two
  // leaves curl off it, each with a midrib, the half facing the light paler.
  let bend = base + vec2f(-sway * 0.7, -tall * 0.55);
  // Only near the stem and below the head is there stem or leaf to draw.
  let reachX = size * 0.95;
  if (d.y > head.y - size * 0.1 && d.x > min(min(base.x, bend.x), head.x) - reachX && d.x < max(max(base.x, bend.x), head.x) + reachX) {
    var stem = 1e9;
    var last = base;
    for (var i = 1; i <= 8; i++) {
      let k = f32(i) / 8.0;
      let point = mix(mix(base, bend, k), mix(bend, head, k), k);
      stem = min(stem, segment(d, last, point) - size * mix(0.085, 0.048, k));
      last = point;
    }
    let light = normalize(u.look.xy);
    for (var i = 0; i < 2; i++) {
      let k = select(0.52, 0.27, i == 0);
      let on = mix(mix(base, bend, k), mix(bend, head, k), k);
      let way = select(1.0, -1.0, (i == 0) == (fract(seed * 13.0) > 0.5));
      let rise = 0.55 + 0.12 * sin(t * 1.1 + seed * 5.0 + f32(i));
      let axis = vec2f(way * cos(rise), -sin(rise));
      let across = vec2f(-axis.y, axis.x);
      let reach = size * (0.82 - 0.12 * f32(i)) * max(grow, 0.01);
      var q = vec2f(dot(d - on, axis), dot(d - on, across));
      q.y -= way * 0.38 * q.x * q.x / reach; // the tip droops
      let leaf = petal(q, reach, reach * 0.22, true) * scale;
      color = mix(color, INK, fill(pen * 1.4 - leaf));
      let lit = clamp(4.0 * dot(across, light), -1.0, 1.0);
      color = mix(color, mix(leafy, mix(leafy, leafLit, abs(lit)), fill(q.y * sign(lit) * scale)), fill(-leaf));
      color = mix(color, INK, 0.65 * fill(-leaf) * stroke(abs(q.y) * scale, pen * 0.35) * (1.0 - smoothstep(0.75, 0.9, q.x / reach)));
    }
    let stalk = stem * scale;
    color = mix(color, INK, fill(pen * 1.5 - stalk));
    color = mix(color, leafy, fill(-stalk));
    color = mix(color, leafLit, fill(-stalk - size * 0.04 * scale));
  }

  // The head turns with the sway and tips back a little toward the sky.
  var face = turn(0.2 * sway / max(size, 0.001)) * (d - head) / r;
  face.y *= 1.1;
  color = bloomHead(face, r * scale, pen, t, seed, smoothstep(0.25, 1.0, grow) * (1.0 - 0.35 * u.orb.z), smoothstep(0.0, 0.6, burn), color); // they close a little at night

  // Alight: three tongues of flame over the head.
  if (burn > 0.0 && burn < 1.0) {
    let blaze = sqrt(sin(3.14159 * burn)) * size;
    for (var i = 0; i < 3; i++) {
      let k = f32(i);
      let tall2 = blaze * (2.0 + 0.5 * sin(t * 9.0 + k * 2.0 + seed));
      let at = (d - head - vec2f((k - 1.0) * size * 0.5, size * 0.3)) / tall2 * vec2f(1.0, -1.0);
      let inside = tongue(at, t, seed + k) * tall2 * scale;
      color = mix(color, INK, fill(inside + pen * 1.5));
      color = mix(color, RED, fill(inside));
      color = mix(color, ORANGE, fill(inside - 0.07 * tall2 * scale));
      color = mix(color, YELLOW * 1.6, fill(inside - 0.16 * tall2 * scale));
    }
  }
  return color;
}

// The audit's mark on the land at a point: how grey it is, the line between
// its tiles, how bright the colour coming back over it is, and the tile's shade.
// px is pixels per world unit across the valley there, deep along it.
fn audited(at: vec2f, px: f32, deep: f32, t: f32) -> vec4f {
  let lanes = u.officers[1]; // where the lanes begin (z) and when, which bank they are on (-1 or 1), how far apart they are
  let tile = u.officers[2];  // how far the first lane is from the river, half a lane's width, a tile's length, how fast they march
  let s = (at.x - river(at.y)) * lanes.z - tile.x;
  let lane = floor(s / lanes.w + 0.5);
  let run = (at.y - lanes.x) / tile.z;
  if (lane < 0.0 || lane > 4.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // How far up the valley his lane has got, when the valley dealt with him (0 if it has not), and whether he rolls it.
  let who = u.officers[3 + i32(lane)];
  let across = abs(s - lane * lanes.w);
  let row = floor(run);
  var mid = lanes.x + (row + 0.5) * tile.z;
  var inside = 0.0;
  if (who.z > 0.5) {
    // The roller lays it without a break.
    mid = at.y;
    inside = min((tile.y * 1.12 - across) * px, min(who.x + 0.75 - at.y, at.y - lanes.x + 16.0 * (t - lanes.y)) * deep);
  } else {
    // Where they come down the grey runs out behind them, tile after tile; after
    // that a tile is laid as he treads on it. Each grows from its middle.
    let ahead = mid - lanes.x;
    let laid = smoothstep(-0.1, 0.12, t - lanes.y - select(-ahead / 16.0, ahead / tile.w, ahead > 0.0)) * step(mid, who.x + 0.3 * tile.z);
    inside = min((tile.y * laid - across) * px, (0.5 * laid - abs(fract(run) - 0.5)) * tile.z * deep) - 1.0 + laid;
  }
  var grey = fill(inside - 0.4);
  var line = 0.55 * stroke(abs(inside - 0.4), 0.6) * smoothstep(1.5, 4.0, tile.z * deep);
  // Dealt with, his lane takes its colours back from where he was, a tile at a time, each bright for a moment.
  var flash = 0.0;
  if (who.y > 0.0 && t > who.y) {
    let front = who.x + 1.5 - 13.0 * (t - who.y);
    let back = smoothstep(0.0, 1.0, mid - front);
    flash = grey * exp(-max(mid - front, 0.0) / 3.4) * step(front, mid);
    grey *= 1.0 - back;
    line *= 1.0 - back;
  }
  return vec4f(grey, line, flash, 0.93 + 0.05 * hash(vec2f(lane * 7.0 + 3.0, row)) + 0.05 * step(0.5, fract((lane + row) * 0.5)));
}

// A flat shape with a pen line round it. sd is how far outside its edge the
// point is, in pixels (negative inside).
fn inked(under: vec3f, tone: vec3f, sd: f32, line: f32) -> vec3f {
  return mix(mix(under, INK, fill(line - sd)), tone, fill(-sd));
}

// A bowler hat. p is from the middle of its brim, y up, in officer heights.
// bud (0 to 1) opens a flower in its band.
fn bowler(under: vec3f, p: vec2f, unit: f32, rim: f32, bud: f32) -> vec3f {
  let dome = max(oval(p, vec2f(0.132, 0.142)), -p.y);
  let brim = roundRect(p, vec2f(0.205, 0.02), 0.02);
  var c = inked(under, vec3f(0.2, 0.2, 0.245), min(dome, brim) * unit, rim);
  c = mix(c, vec3f(0.46, 0.47, 0.53), fill(-max(dome + 0.014, abs(p.y - 0.048) - 0.018) * unit));
  if (bud > 0.0) {
    let at = p - vec2f(0.07, 0.066);
    let spoke = atan2(at.y, at.x) / TAU * 5.0 + 0.25;
    let leaf = length(vec2f(length(at) - 0.052 * bud, (fract(spoke) - 0.5) / 5.0 * TAU * 0.052)) - 0.034 * bud;
    c = inked(c, PINK, leaf * unit, rim * 0.6);
    c = inked(c, YELLOW, (length(at) - 0.029 * bud) * unit, rim * 0.6);
  }
  return c;
}

// A briefcase. p is from its middle, y toward the handle, in officer heights.
fn briefcase(under: vec3f, p: vec2f, unit: f32, rim: f32) -> vec3f {
  let handle = max(abs(length(p - vec2f(0.0, 0.08)) - 0.036) - 0.011, 0.078 - p.y);
  var c = inked(under, vec3f(0.2, 0.2, 0.245), handle * unit, rim * 0.8);
  let box = roundRect(p, vec2f(0.112, 0.086), 0.024);
  c = inked(c, vec3f(0.31, 0.32, 0.37), box * unit, rim);
  c = mix(c, vec3f(0.19, 0.19, 0.23), fill(-max(box + 0.012, abs(p.y - 0.036) - 0.006) * unit));
  c = mix(c, vec3f(0.86, 0.86, 0.82), fill(-roundRect(p - vec2f(0.0, 0.036), vec2f(0.02, 0.017), 0.006) * unit));
  return c;
}

// The paint roller, seen from behind the man who pushes it, in his heights.
// fall (0 to 1) lets its pole drop to the ground beside it.
fn paintRoller(under: vec3f, q: vec2f, unit: f32, rim: f32, fall: f32) -> vec3f {
  let lean = 1.47 * fall;
  let foot = vec2f(0.0, 0.1);
  let grip = foot + 0.5 * vec2f(sin(lean), cos(lean));
  var c = inked(under, vec3f(0.7, 0.71, 0.74), (segment(q, foot, grip) - 0.016) * unit, rim * 0.8);
  c = inked(c, vec3f(0.24, 0.24, 0.29), (segment(q, mix(foot, grip, 0.72), grip) - 0.025) * unit, rim * 0.8);
  let drum = segment(q, vec2f(-0.275, 0.092), vec2f(0.275, 0.092)) - 0.062;
  c = inked(c, vec3f(0.93, 0.93, 0.9), drum * unit, rim);
  // Wet with grey underneath, and capped at each end.
  c = mix(c, vec3f(0.66, 0.67, 0.7), fill(-max(drum + 0.012, q.y - 0.078) * unit));
  c = mix(c, vec3f(0.24, 0.24, 0.29), fill(-max(drum, 0.262 - abs(q.x)) * unit));
  return c;
}

// One compliance officer: a little grey man in a bowler hat, seen from behind
// as he marches away, or from in front once he has turned round. P is where
// his feet are on the hero (x, y), how tall he is there, and how far off he
// is (in the air, less than nothing: how dark his shadow still is); Q is
// where on the land his shadow falls, Q.z is his step
// (-1 to 1: one foot off the ground, then the other) and Q.w how far he has
// turned over; R is what he is (0 carries a briefcase, 1 pushes the roller, 2
// is taking root, 3 has a balloon, 4 is only a hat on the river) and what that
// needs; S is which way he faces (1 away, -1 toward the eye), how far his
// arms are thrown up, how far his hat has left his head, and how far the
// colour has got into him.
fn officer(d: vec2f, scale: f32, pen: f32, t: f32, P: vec4f, Q: vec4f, R: vec4f, S: vec4f, under: vec3f) -> vec3f {
  let unit = P.z * scale; // pixels per officer
  let rim = min(pen * 0.95, unit * 0.036);
  let kind = i32(R.x + 0.5);
  let raw = (d - P.xy) / P.z * vec2f(1.0, -1.0);
  var color = under;

  if (kind == 4) {
    // Only his hat is left, riding the river, with a ring running out from it.
    let ring = abs(length(raw * vec2f(1.0, 2.7)) - 0.29 - 0.05 * sin(t * 2.6 + R.y));
    color = mix(color, PAPER * 1.12, 0.75 * R.z * stroke(ring * unit, rim * 0.6));
    let hp = turn(0.13 * sin(t * 1.9 + R.y)) * (raw - vec2f(0.0, 0.015 * sin(t * 2.6 + R.y) - 0.2 * (1.0 - R.z)));
    return mix(color, bowler(color, hp, unit, rim, 0.0), fill(raw.y * unit));
  }

  var q = raw;
  if (Q.w != 0.0) { q = turn(Q.w) * (q - vec2f(0.0, 0.5)) + vec2f(0.0, 0.5); }
  // Taking root, he narrows into a stem.
  var age = 0.0;
  var squeeze = 0.0;
  if (kind == 2) {
    age = t - R.y;
    squeeze = smoothstep(0.15, 1.05, age);
  }
  let facing = S.x < 0.0; // toward the eye
  let thin = max(abs(S.x), 0.07) * (1.0 - 0.94 * squeeze);
  let qb = vec2f(q.x / thin, q.y);
  let ub = unit * thin;
  let m = vec2f(abs(qb.x), qb.y);
  let right = qb.x >= 0.0;
  let up = S.y;

  // His suit is grey until the colour gets into him, from the shoes up.
  let band = K_BOW_0[i32(floor(qb.y * 12.0 + 12.0)) % 6];
  let turned = step(0.001, S.w) * fill((S.w * 1.25 - 0.1 - qb.y + 0.02 * sin(qb.x * 40.0 + t * 7.0)) * unit);
  let leafy = smoothstep(0.15, 0.8, squeeze);
  let cloth = mix(mix(vec3f(0.6, 0.62, 0.67), band, turned), ${vec3('#3fa56a')}, leafy);
  let dark = mix(mix(vec3f(0.43, 0.44, 0.5), band * vec3f(0.74, 0.68, 0.86), turned), ${vec3('#2f8a58')}, leafy);
  let skin = mix(mix(vec3f(0.87, 0.86, 0.83), vec3f(1.0, 0.85, 0.72), turned), ${vec3('#8fd46a')}, leafy);
  let hair = mix(mix(vec3f(0.29, 0.29, 0.34), ${vec3('#7a3b1e')}, turned), ${vec3('#2f8a58')}, leafy);
  let shoe = mix(vec3f(0.13, 0.12, 0.15), ${vec3('#2f8a58')}, leafy);

  var fig = color;
  if (kind == 1 && R.y <= 0.0) { fig = paintRoller(fig, qb, ub, rim, 0.0); }

  // Legs: the foot that is off the ground shows its sole.
  let lift = select(max(Q.z, 0.0), max(-Q.z, 0.0), right);
  let foot = vec2f(0.078 + 0.1 * lift * up, 0.05 + 0.1 * lift);
  fig = inked(fig, dark, (segment(m, vec2f(0.066, 0.4), foot + vec2f(0.0, 0.03)) - 0.058) * ub, rim);
  let sole = oval(m - foot - vec2f(0.004, -0.006 + 0.012 * lift), vec2f(0.068, 0.046 + 0.022 * lift));
  fig = inked(fig, mix(shoe, vec3f(0.6, 0.58, 0.56), select(smoothstep(0.15, 0.5, lift), 0.0, facing) * (1.0 - leafy)), sole * ub, rim);

  // What he carries hangs from his right hand; an arm on each side.
  let liftL = max(Q.z, 0.0);
  let liftR = max(-Q.z, 0.0);
  var swingL = mix(0.06 + 0.07 * (0.5 - liftL), 2.45 + 0.25 * sin(t * 9.0), up);
  var swingR = mix(0.06 + 0.07 * (0.5 - liftR), 2.45 + 0.25 * sin(t * 9.0 + 1.3), up);
  if (kind == 3) { swingR = mix(swingR, 2.98, smoothstep(0.0, 0.45, R.y)); }
  if (kind == 1) {
    swingL = mix(-0.22, swingL, R.y);
    swingR = mix(-0.22, swingR, R.y);
  }
  let shoulder = vec2f(0.178, 0.715);
  let pushing = kind == 1 && R.y <= 0.0;
  let handL = shoulder + select(0.285 + 0.035 * (0.5 - liftL) * (1.0 - up), 0.2, pushing) * vec2f(sin(swingL), -cos(swingL));
  let handR = shoulder + select(0.285 + 0.035 * (0.5 - liftR) * (1.0 - up), 0.2, pushing) * vec2f(sin(swingR), -cos(swingR));
  let hand = select(handL, handR, right);
  if (kind == 0 && right) {
    let hang = normalize(hand - shoulder);
    let rel = m - hand - hang * 0.12 - vec2f(0.035, 0.0) * (1.0 - up);
    fig = briefcase(fig, vec2f(rel.x * hang.y - rel.y * hang.x, -dot(rel, hang)), ub, rim);
  }

  let torso = roundRect(qb - vec2f(0.0, 0.575), vec2f(0.176, 0.21), 0.085);
  fig = inked(fig, cloth, torso * ub, rim);
  if (facing) {
    // A white shirt front and a tie.
    let front = max(torso + 0.016, (m.x - (qb.y - 0.56) * 0.5) * 0.89);
    fig = mix(fig, mix(vec3f(0.97, 0.97, 0.95), cloth, leafy), fill(-front * ub));
    fig = mix(fig, mix(mix(vec3f(0.2, 0.2, 0.25), PINK, turned), dark, leafy), fill(-max(front, m.x - 0.02) * ub));
  } else {
    // The vent in the back of his jacket, and his collar.
    fig = mix(fig, INK, 0.7 * stroke(m.x * ub, rim * 0.4) * step(qb.y, 0.5) * fill(-(torso + 0.01) * ub));
    fig = mix(fig, mix(vec3f(0.97, 0.97, 0.95), cloth, leafy), fill(-max(torso + 0.016, 0.752 - qb.y) * ub) * step(m.x, 0.085));
  }
  fig = inked(fig, mix(cloth, dark, 0.35), (segment(m, shoulder, hand) - 0.045) * ub, rim);
  fig = inked(fig, skin, (length(m - hand) - 0.038) * ub, rim * 0.8);

  // His head: from behind, hair and two ears; from in front, a face that gives nothing away until the colour reaches it.
  let headAt = vec2f(0.0, 0.84);
  fig = inked(fig, skin, (length(m - headAt - vec2f(0.112, -0.012)) - 0.03) * ub, rim * 0.8);
  fig = inked(fig, select(hair, skin, facing), (length(qb - headAt) - 0.118) * ub, rim);
  if (facing) {
    let glad = smoothstep(0.75, 1.0, S.w);
    fig = mix(fig, INK, fill((0.019 - length(m - headAt - vec2f(0.046, 0.0))) * ub));
    let grin = max(abs(length(qb - headAt - vec2f(0.0, -0.022)) - 0.05) - 0.009, qb.y - headAt.y + 0.04);
    let flat = segment(qb, headAt + vec2f(-0.032, -0.062), headAt + vec2f(0.032, -0.062)) - 0.008;
    fig = mix(fig, INK, fill(-mix(flat, grin, glad) * ub));
  }
  if (kind != 2) {
    fig = bowler(fig, qb - vec2f(0.0, 0.915 + S.z), ub, rim, smoothstep(0.8, 1.0, S.w));
  }

  if (kind == 3) {
    // His briefcase fills with air, takes on colour and goes up on its string.
    let e = R.y * R.y * (3.0 - 2.0 * R.y);
    let half = mix(vec2f(0.112, 0.086), vec2f(0.3, 0.34), e);
    let mid = handR + mix(vec2f(0.035, -0.12), vec2f(0.05 * sin(t * 1.4 + P.x * 0.02) - 0.1, 0.34 + half.y), e);
    let bp = qb - mid;
    fig = mix(fig, INK, e * stroke(segment(qb, handR, mid - vec2f(0.0, half.y)) * ub, rim * 0.4));
    fig = inked(fig, YELLOW, oval(bp + vec2f(0.0, half.y + 0.012), vec2f(0.034, 0.03) * max(e, 0.01)) * ub, rim * 0.7);
    let bag = roundRect(bp, half, mix(0.024, 0.3, e));
    let across = clamp(bp.x / (half.x * sqrt(max(1.0 - pow(bp.y / half.y, 2.0), 0.05))), -1.0, 1.0);
    let gore = (asin(across) / 3.14159 + 0.5) * 6.0;
    var skinB = mix(vec3f(0.31, 0.32, 0.37), K_BOW_0[(i32(floor(gore)) + i32(R.w) + 6) % 6], smoothstep(0.08, 0.55, e));
    let seam = min(fract(gore), 1.0 - fract(gore)) * 0.5236 * half.x * sqrt(max(1.0 - across * across, 0.02)) * sqrt(max(1.0 - pow(bp.y / half.y, 2.0), 0.05));
    skinB = mix(skinB, INK, 0.8 * e * stroke(seam * ub, rim * 0.35));
    skinB = mix(skinB, vec3f(1.25), 0.85 * e * fill((0.052 - length((bp - half * vec2f(-0.42, 0.4)) * vec2f(1.0, 0.62))) * ub));
    fig = inked(fig, skinB, bag * ub, rim);
  }

  // Thrown in the river, he goes under at the waterline; and in a flood he wades.
  var there = 1.0 - smoothstep(0.8, 1.0, squeeze);
  if (kind <= 1 && R.z > 0.0) { there *= fill((R.z - d.y) * scale); }
  color = mix(color, fig, there);

  if (kind == 2) {
    // He lets go of his briefcase, a flower comes up where he stood, and it wears his hat.
    let down = smoothstep(0.1, 0.5, age);
    let rest = mix(handR + vec2f(0.035, -0.12), vec2f(0.3, 0.092), down * down);
    color = briefcase(color, turn(-0.12 * down) * (q - rest), unit, rim);
    let size = R.w;
    color = bloom(d, scale, pen, t, vec4f(P.x, 0.0, R.y, 0.0), vec4f(size, R.z, 0.0, 0.0), P.y, color);
    let rise = clamp((age - 0.1) / 1.5, 0.0, 1.0);
    let grow = 1.0 - pow(1.0 - rise, 3.0);
    let top = vec2f(P.x + size * 0.4 * sin(t * 0.9 + R.z * 9.0) * grow, P.y - size * 2.7 * grow - 0.8 * size * (0.3 + 0.7 * smoothstep(0.2, 1.0, grow)));
    let worn = vec2f(P.x, P.y - 0.915 * P.z);
    let rides = smoothstep(0.0, 0.12 * P.z, worn.y - top.y);
    let hatAt = vec2f(mix(worn.x, top.x, rides), min(worn.y, top.y));
    color = bowler(color, turn(0.22 * rides) * ((d - hatAt) / P.z * vec2f(1.0, -1.0)), unit, rim, 0.0);
  }
  return color;
}

// All of them: those on the ground, behind the terminal, or those in the air, in front of everything.
fn officers(under: vec3f, d: vec2f, scale: f32, pen: f32, t: f32, groundZ: f32, grounded: bool) -> vec3f {
  var color = under;
  if (grounded) {
    // The roller, where it was dropped.
    let prop = u.officers[8];
    if (prop.z > 0.0) {
      let q = (d - prop.xy) / prop.z * vec2f(1.0, -1.0);
      if (abs(q.x) < 0.7 && q.y > -0.15 && q.y < 0.75) {
        color = paintRoller(color, q, prop.z * scale, min(pen * 0.95, prop.z * scale * 0.036), prop.w);
      }
    }
  }
  for (var i = 4; i >= 0; i--) {
    let P = u.officers[10 + 4 * i];
    if (P.z <= 0.0 || (P.w > 0.0) != grounded) { continue; }
    let off = d - P.xy;
    if (abs(off.x) > 1.35 * P.z || off.y > 0.75 * P.z || off.y < -2.9 * P.z) { continue; }
    var seen = 1.0;
    if (grounded) {
      seen = smoothstep(-0.28, 0.08, groundZ - P.w + 1.1);
      if (seen <= 0.0) { continue; }
    }
    color = mix(color, officer(d, scale, pen, t, P, u.officers[11 + 4 * i], u.officers[12 + 4 * i], u.officers[13 + 4 * i], color), seen);
  }
  return color;
}

// What a ray finds of a thing standing on the land: its colour and how far off
// it is (-1 for a miss), and the pen line round it with how far off that is.
struct Seen {
  color: vec3f,
  far: f32,
  ink: f32,
  edge: f32,
}

// A six-legged walker's joints, set for the moment by pose().
var<private> hips: array<vec3f, 6>;
var<private> knees: array<vec3f, 6>;
var<private> feet: array<vec3f, 6>;
var<private> bodyShift: vec3f; // the body rides up and down on its legs
var<private> bodyRoll: f32;    // and rolls, about a line along it at height bodyPivot
var<private> bodyPivot: f32;

// Into the body's own space, and back out.
fn intoBody(p: vec3f) -> vec3f {
  let q = p - bodyShift - vec3f(0.0, bodyPivot, 0.0);
  let c = cos(bodyRoll);
  let s = sin(bodyRoll);
  return vec3f(c * q.x + s * q.y, c * q.y - s * q.x + bodyPivot, q.z);
}
fn outOfBody(q: vec3f) -> vec3f {
  let c = cos(bodyRoll);
  let s = sin(bodyRoll);
  return vec3f(c * q.x - s * (q.y - bodyPivot), s * q.x + c * (q.y - bodyPivot) + bodyPivot, q.z) + bodyShift;
}

// Sets the legs of a walker in its own space (x right, y up, z ahead). It
// walks like an insect, three feet down at a time: a foot stays where it was
// put while the body passes over, then swings ahead in an arc. Each leg is two
// bones solved from hip to foot, knee up and out. phase counts whole gaits;
// stride is one step in the ground plane; hip is where the hips sit (out,
// up, spacing along the body); tilt is the slope of the ground under it.
// curl (0 to 1) draws the legs up against the body.
fn pose(phase: f32, stride: vec2f, hip: vec3f, reach: f32, floorY: f32, tilt: vec2f, thigh: f32, shin: f32, lift: f32, curl: f32) {
  let stepping = min(length(stride) * 4.0, 1.0);
  for (var i = 0; i < 6; i++) {
    let side = select(-1.0, 1.0, i % 2 == 0);
    let row = f32(i / 2) - 1.0;
    let g = fract(phase + select(0.0, 0.5, (i + i / 2) % 2 == 0));
    let swing = clamp((g - 0.62) / 0.38, 0.0, 1.0);
    let glide = swing * swing * (3.0 - 2.0 * swing);
    let along = select(0.5 - g / 0.62, glide - 0.5, g > 0.62);
    let root = outOfBody(vec3f(side * hip.x, hip.y, row * hip.z));
    var foot = vec3f(side * reach * (1.0 - 0.1 * abs(row)), 0.0, row * hip.z * 2.3) + vec3f(stride.x, 0.0, stride.y) * along;
    foot.y = floorY + dot(tilt, foot.xz) + lift * stepping * sin(3.14159 * swing);
    foot = mix(foot, root + vec3f(side * 0.32 * thigh, 0.75 * thigh, row * 0.1), curl);
    let span = foot - root;
    let len = length(span);
    let dir = span / len;
    let d = clamp(len, abs(thigh - shin) + 0.02, thigh + shin - 0.01);
    let a = (thigh * thigh - shin * shin + d * d) / (2.0 * d);
    let pole = vec3f(side * 0.4, 1.0, 0.0);
    let up = normalize(pole - dir * dot(pole, dir));
    hips[i] = root;
    knees[i] = root + dir * a + up * sqrt(max(thigh * thigh - a * a, 0.0));
    feet[i] = root + dir * d;
  }
}

// The legs as posed: distance, then part (4 limb, 5 joint or foot). r is the
// thigh's radius, the shin's, and the joints'. (Parts: 4 thigh, 7 shin, 5 joint or foot.)
fn limbs(p: vec3f, r: vec3f) -> vec2f {
  var best = vec2f(1e9, 4.0);
  for (var i = 0; i < 6; i++) {
    let thigh = taper(p, hips[i], knees[i], r.x, r.x * 0.74);
    if (thigh < best.x) { best = vec2f(thigh, 4.0); }
    let shin = taper(p, knees[i], feet[i], r.y, r.y * 0.42);
    if (shin < best.x) { best = vec2f(shin, 7.0); }
    let pad = (length((p - feet[i] - vec3f(0.0, r.y * 0.25, 0.0)) * vec3f(1.0, 1.7, 1.0)) - r.y * 0.95) * 0.7;
    let joint = min(min(length(p - knees[i]) - r.z, length(p - hips[i]) - r.z * 1.08), pad);
    if (joint < best.x) { best = vec2f(joint, 5.0); }
  }
  return best;
}

var<private> hoseAt: f32;    // how far down its leg the nearest bit of hose is: 0 at the hip, 1 at the boot
var<private> nearFoot: vec3f; // where the point is from the nearest foot, in boot sizes

// Legs of striped rubber hose, bent through the knee, with a big boot on each
// foot. r is the hose's radius, boot the size of a boot; four leaves out the
// middle pair. Distance, then part (13 hose, 10 boot, 11 its sole, 12 its cuff).
var<private> terminalLegs:u32;
// The joints hoseLegs draws: the terminal's (four) from the uniforms, a walker's as pose() set them.
var<private> legRig: u32; // which little walker's legs these are (set by drawWalker)
fn hipAt(i: i32, four: bool) -> vec3f { if (four) { return u.legs[i].xyz; } return u.walkerLegs[legRig * 18u + u32(i)].xyz; }
fn kneeAt(i: i32, four: bool) -> vec3f { if (four) { return u.legs[6 + i].xyz; } return u.walkerLegs[legRig * 18u + 6u + u32(i)].xyz; }
fn footAt(i: i32, four: bool) -> vec3f { if (four) { return u.legs[12 + i].xyz; } return u.walkerLegs[legRig * 18u + 12u + u32(i)].xyz; }
fn hoseLegs(p: vec3f, r: f32, boot: f32, four: bool) -> vec2f {
  var best = vec2f(1e9, 13.0);
  let pieces = select(2, 4, four);
  for (var i = 0; i < 6; i++) {
    if (four && (i / 2 == 1 || (terminalLegs & (1u<<u32(i)))==0u)) { continue; }
    let hip = hipAt(i, four);
    let foot = footAt(i, four);
    let ankle = foot + vec3f(0.0, 0.25 * boot, 0.0);
    if (length(p - (hip + foot) * 0.5) - length(hip - foot) * 0.5 - 0.55 > best.x) { continue; }
    // A curve from hip to ankle that passes through the knee.
    let bend = 2.0 * kneeAt(i, four) - 0.5 * (hip + ankle);
    var last = hip;
    for (var j = 1; j <= pieces; j++) {
      let k = f32(j) / f32(pieces);
      let next = mix(mix(hip, bend, k), mix(bend, ankle, k), k);
      let pa = p - last;
      let ba = next - last;
      let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      let far = length(pa - ba * h) - r;
      if (far < best.x) {
        best = vec2f(far, 13.0);
        hoseAt = (f32(j) - 1.0 + h) / f32(pieces);
      }
      last = next;
    }
    let f = (p - foot) / boot;
    let upper = min((length((f - vec3f(0.0, 0.11, 0.09)) / vec3f(0.17, 0.125, 0.26)) - 1.0) * 0.125, length(f - vec3f(0.0, 0.14, -0.04)) - 0.15) * boot;
    if (upper < best.x) { best = vec2f(upper, 10.0); nearFoot = f; }
    let sole = max((length((f - vec3f(0.0, 0.03, 0.085)) / vec3f(0.195, 0.09, 0.285)) - 1.0) * 0.09, f.y - 0.055) * boot;
    if (sole < best.x) { best = vec2f(sole, 11.0); nearFoot = f; }
    let cuff = (length(vec2f(length(f.xz - vec2f(0.0, -0.03)) - 0.105, f.y - 0.27)) - 0.052) * boot;
    if (cuff < best.x) { best = vec2f(cuff, 12.0); nearFoot = f; }
  }
  return best;
}

// The colour of a leg where the ray met it, and the ink on it: bands round the
// hose, and a boot with a toe cap, laces, a sole and a rolled cuff.
fn legColor(p: vec3f, part: f32, lit: f32, px: f32, pen: f32, r: f32, boot: f32, four: bool) -> vec4f {
  let again = hoseLegs(p, r, boot, four);
  let shade = vec3f(0.66, 0.56, 0.78);
  var ink = 0.0;
  var c = vec3f(0.95, 0.87, 0.74);
  if (part == 13.0) {
    let bands = select(6.0, 10.0, four);
    let band = hoseAt * bands + 0.5;
    c = K_BOW_0[i32(band) % 6];
    ink = stroke(min(fract(band), 1.0 - fract(band)) / bands * select(1.4, 1.9, four) * px, pen * 0.5);
  } else if (part == 11.0) {
    c = ${vec3('#e8703a')};
  } else if (part == 10.0) {
    let f = nearFoot;
    ink = step(0.05, f.y) * stroke(abs(f.z - 0.2 - 0.25 * f.x * f.x) * boot * px, pen * 0.5);
    ink = max(ink, step(abs(f.x), 0.1) * step(-0.03, f.z) * step(f.z, 0.15) * step(0.12, f.y) * stroke(abs(fract(f.z / 0.06) - 0.5) * 0.06 * boot * px, pen * 0.45));
  }
  c = mix(c * shade, c, smoothstep(0.0, 0.08, lit));
  c = mix(c, min(c * 1.1 + 0.04, vec3f(1.0)), smoothstep(0.6, 0.66, lit));
  return vec4f(c, ink);
}

// A little walking computer in its own units: a monitor on a chassis with an
// aerial, on six legs. Distance, then part (1 monitor, 3 chassis, 4 limb or
// aerial, 5 joint, 6 the aerial's knob).
fn miniSdf(p: vec3f) -> vec2f {
  let q = intoBody(p);
  let shell = roundBox(q - vec3f(0.0, 0.68, 0.0), vec3f(0.5, 0.4, 0.4), 0.1);
  let well = roundBox(q - vec3f(0.0, 0.7, 0.42), vec3f(0.37, 0.27, 0.07), 0.06);
  var best = vec2f(max(shell, -well), 1.0);
  let hull = roundBox(q - vec3f(0.0, 0.2, 0.0), vec3f(0.44, 0.085, 0.38), 0.07);
  if (hull < best.x) { best = vec2f(hull, 3.0); }
  let aerial = capsule(q, vec3f(0.3, 1.0, -0.15), vec3f(0.38, 1.44, -0.22), 0.022);
  if (aerial < best.x) { best = vec2f(aerial, 4.0); }
  let knob = length(q - vec3f(0.38, 1.5, -0.22)) - 0.08;
  if (knob < best.x) { best = vec2f(knob, 6.0); }
  let legs = hoseLegs(p, 0.07, 0.72, false);
  if (legs.x < best.x) { best = legs; }
  return best;
}

// One of the little walkers, as the ray from the eye finds it. who is x, z,
// the way it faces and where it is in its gait; how is struck down (0 to 1),
// a seed, its stride (0 standing, 1 running) and how far it dips to its work.
fn mini(ro: vec3f, rd: vec3f, who: vec4f, how: vec4f, scale: f32, pen: f32, t: f32, still: vec2f) -> Seen {
  var seen = Seen(vec3f(0.0), -1.0, 0.0, 1e9);
  // Not near it on the hero: nothing more to do.
  let reach = u.world.w / max(who.y - ro.z, 0.01);
  if (who.y - ro.z < 5.0 || abs(u.orb.w + (who.x - ro.x) * reach - still.x) > 1.8 * MINI * reach) { return seen; }
  let base = vec3f(who.x, ground(who.xy) + 2.4 * max(heaved(who.xy), 0.0), who.y); // tossed by the wave from a footfall
  let mid = base + vec3f(0.0, 0.75 * MINI, 0.0);
  let oc = ro - mid;
  let b = dot(oc, rd);
  let disc = b * b - dot(oc, oc) + 3.1 * MINI * MINI;
  if (disc < 0.0) { return seen; }

  let spin = rotY(who.z);
  let lo = (transpose(spin) * (ro - base)) / MINI;
  let ld = transpose(spin) * rd;
  let dead = how.x;
  // It bobs twice a gait, sways from foot to foot, dips to its work, and struck, rolls onto its back.
  bodyShift = vec3f(0.0, mix(0.035 * sin(who.w * TAU * 2.0) * how.z - 0.14 * how.w, -0.12, dead), 0.0);
  bodyRoll = 3.0 * dead + 0.05 * sin(who.w * TAU) * how.z;
  bodyPivot = 0.6;
  // (Its legs are posed once a frame, by poseWalkers.)

  var far = max(-b - sqrt(disc), 0.0) / MINI;
  let end = (-b + sqrt(disc)) / MINI;
  var previous = 1e9;
  var graze = 1e9;
  var part = 0.0;
  for (var i = 0; i < 48; i++) {
    let m = miniSdf(lo + ld * far);
    if (m.x < 0.004) { part = m.y; break; }
    if (m.x > previous) { graze = min(graze, previous); }
    previous = m.x;
    far += m.x * 0.85;
    if (far > end) { break; }
  }
  let px = MINI * u.world.w / (mid.z - ro.z) * scale; // pixels per unit of its own
  seen.ink = stroke(abs(graze * px - pen), pen);
  seen.edge = length(mid - ro);
  if (part == 0.0) { return seen; }

  let p = lo + ld * far;
  let e = vec2f(0.003, -0.003);
  let n = normalize(e.xyy * miniSdf(p + e.xyy).x + e.yyx * miniSdf(p + e.yyx).x + e.yxy * miniSdf(p + e.yxy).x + e.xxx * miniSdf(p + e.xxx).x);
  let lit = dot(n, transpose(spin) * SUNWARD);
  let ash = vec3f(0.2, 0.15, 0.14);
  let shell = mix(K_SHELLS_5[i32(fract(how.y * 7.3) * 5.0)], ash, dead);
  var tone = mix(shell * vec3f(0.62, 0.52, 0.72), shell, smoothstep(0.06, 0.12, lit));
  tone = mix(tone, mix(shell, vec3f(1.0), 0.5), smoothstep(0.6, 0.66, lit));
  var ink = 0.0;
  let q = intoBody(p);
  if (part == 1.0) {
    ink = stroke(edgeDistance(q - vec3f(0.0, 0.68, 0.0), vec3f(0.5, 0.4, 0.4), 0.1) * px, pen * 0.8);
    let g = q.xy - vec2f(0.0, 0.7);
    let glass = roundRect(g, vec2f(0.37, 0.27), 0.06);
    if (glass < 0.0 && q.z > 0.3) {
      // The screen: two bright eyes that blink over a grin; crosses once it is struck.
      let uv = g / vec2f(0.37, 0.27);
      var screen = mix(${vec3('#0b2a1b')}, ${vec3('#165a36')}, 0.5 + 0.5 * sin(uv.y * 14.0 + t * 3.0));
      let wink = fract(t * 0.23 + how.y);
      let blink = 1.0 - 0.9 * smoothstep(0.0, 0.03, wink) * (1.0 - smoothstep(0.04, 0.08, wink));
      let eyes = vec2f(abs(uv.x) - 0.42, uv.y - 0.14);
      let alive = roundRect(eyes, vec2f(0.17, 0.36 * blink), 0.08) * 0.3 * px;
      let cross = (0.07 - min(abs(eyes.x + eyes.y * 0.75), abs(eyes.x - eyes.y * 0.75))) * 0.3 * px;
      let glow = mix(fill(-alive), fill(cross) * step(length(eyes * vec2f(1.0, 0.75)), 0.3), smoothstep(0.4, 0.6, dead));
      screen = mix(screen, mix(${vec3('#8dff9a')} * 1.9, RED * 1.7, smoothstep(0.4, 0.6, dead)), glow);
      let grin = (0.075 - abs(length(uv - vec2f(0.0, 0.05)) - 0.6)) * 0.3 * px;
      screen = mix(screen, ${vec3('#8dff9a')} * 1.6, fill(grin) * step(uv.y, -0.3) * (1.0 - dead));
      if (cosmosLive && u.cosmos.w > 0.0) {
        // In the chorus it sings: its eyes shut in two happy arcs, its mouth round and opening on the beat.
        let open = u.chorusBeat.y;
        var song = mix(${vec3('#0b2a1b')}, ${vec3('#165a36')}, 0.5 + 0.5 * sin(uv.y * 14.0 + t * 3.0));
        let lids = (0.07 - abs(length(eyes - vec2f(0.0, -0.12)) - 0.2)) * 0.3 * px;
        song = mix(song, ${vec3('#8dff9a')} * 1.9, fill(lids) * step(-0.1, eyes.y));
        let gape = vec2f(0.2 + 0.06 * open, 0.07 + 0.3 * open);
        let lips = (length((uv - vec2f(0.0, -0.42)) / gape) - 1.0) * min(gape.x, gape.y) * 0.3 * px;
        song = mix(song, ${vec3('#05170c')}, fill(-lips));
        song = mix(song, ${vec3('#8dff9a')} * 1.7, stroke(abs(lips), pen * 0.6));
        screen = mix(screen, song, u.cosmos.w * (1.0 - dead));
      }
      tone = mix(mix(shell * 0.5, INK, 0.4), screen, fill(-(glass + 0.035) * px));
      ink = max(ink, stroke(abs(glass + 0.035) * px, pen * 0.7));
    }
  } else if (part == 3.0) {
    tone = mix(tone, tone * vec3f(0.7, 0.6, 0.78), 0.6);
    ink = stroke(edgeDistance(q - vec3f(0.0, 0.2, 0.0), vec3f(0.44, 0.085, 0.38), 0.07) * px, pen * 0.7);
  } else if (part == 5.0) {
    var rubber = mix(${vec3('#231a33')}, ${vec3('#59457e')}, smoothstep(0.0, 0.08, lit));
    rubber = mix(rubber, ${vec3('#b9a4ee')}, smoothstep(0.6, 0.66, lit));
    tone = mix(rubber, vec3f(1.9), smoothstep(0.9, 0.94, lit));
  } else if (part == 6.0) {
    tone = mix(mix(ORANGE, YELLOW * 1.5, smoothstep(0.0, 0.3, lit)), ash, dead);
  } else if (part == 7.0) {
    tone = tone * vec3f(0.5, 0.44, 0.66);
  } else if (part >= 10.0) {
    let leg = legColor(p, part, lit, px, pen, 0.07, 0.72, false);
    tone = mix(leg.rgb, ash, dead);
    ink = max(ink, leg.a);
  }
  let c = mix(tone * (0.972 + 0.05 * noise(still * 2.3)), INK, max(ink, seen.ink));
  seen.color = mix(c, HAZE, smoothstep(60.0, FAR, far * MINI));
  seen.far = far * MINI;
  return seen;
}

// The concert in the valley. Four handmade families of turned and folded forms.
// Distances in the little model are real 3-D distances; holes see through to the landscape.
var<private> villageKind: i32;
var<private> lifts: vec4f;
var<private> wig: vec4f;
var<private> azimuth: vec2f;
var<private> scaffold: vec3f; // gallery width, height, tube radius (zero after lock-in)

fn villageCloser(a: vec2f, d: f32, id: f32) -> vec2f {
  return select(a, vec2f(d, id), d < a.x);
}
fn villageDrum(r: f32, y: f32, halfH: f32, wide: f32) -> f32 {
  let d = vec2f(r - wide, abs(y) - halfH);
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
fn villageTurn(v: vec2f, cs: vec2f) -> vec2f {
  return vec2f(dot(v, cs), dot(v, vec2f(-cs.y, cs.x)));
}
fn villageHoop(q: vec2f, away: f32, r: f32, tube: f32) -> f32 {
  return length(vec2f(length(q) - r, away)) - tube;
}

// Three toadstool houses share a root. The big canopy comes up behind the two buds.
// A concave gill side, a rolled lip, a crown tapering to a gold nipple.
fn bellHouse(p: vec3f, stem: f32, cap: f32, radius: f32) -> vec2f {
  let r = length(p.xz);
  let h = stem;
  let collar = 0.30 * radius + 0.10 * max(0.0, 1.0 - abs(p.y / max(0.01, h)));
  var best = vec2f(villageDrum(r, (p.y - 0.5*h + 0.32), 0.5*h + 0.32, collar), 1.0);
  let y = p.y - h;
  let rad = radius * cap;
  let dome = (length(vec2f(r, (y + 0.13*rad) * 1.32)) - rad) * 0.75;
  let gill = (0.19 * rad - 0.32 * r - y) * 0.95;
  best = villageCloser(best, max(dome,gill), select(6.0, 3.0, gill > dome));
  return villageCloser(best, length(vec3f(p.x, y - 0.62 * rad, p.z)) - 0.16 * rad, 4.0);
}

// A pavilion roof: four curved copper sails, corners kicked high in the air.
fn pavilionTier(p: vec3f, w: f32, loft: f32, cs: vec2f, mat: f32) -> vec2f {
  let v = abs(villageTurn(p.xz, cs));
  let r = max(v.x,v.y);
  let corner = min(v.x,v.y) / max(w, 0.005);
  var d = vec2f(villageDrum(r, 0.5*loft - p.y - 0.18, 0.5*loft + 0.18, 0.42*w), 1.0);
  let eave = (p.y - loft) - 0.18*w*min(corner*corner, 1.0);
  let hip = max(0.0, 1.0 - r / max(w,0.005));
  let top = w * (0.08 + 0.76*hip*hip);
  let roof = max(max(r-w, -eave-0.09*w), (eave-top)*0.62);
  d = villageCloser(d, roof, select(mat, 3.0, eave < 0.025*w));
  return d;
}

// Onion cupola: a belly tangent to a concave spire. Rotational symmetry is broken
// by the inlaid ribs on the finished dome rather than by noise in its distance field.
fn cupola(p: vec3f, drum: f32, bulb: f32, w: f32) -> vec2f {
  let r = length(p.xz);
  var d = vec2f(villageDrum(r, p.y - 0.5*drum + 0.16, 0.5*drum + 0.16, w*0.50), 1.0);
  let y = p.y-drum;
  let r0 = max(0.001, bulb);
  let level = y/r0;
  let belly = length(vec2f(r, (y-0.46*bulb)*1.15)) - 0.77*bulb;
  let waist = max(0.0, 1.0 - (level-0.81)/0.97);
  let spire = (r - 0.65*bulb*waist*waist)*0.59;
  let fruit = select(belly*0.86, max(spire,y-1.78*bulb), level > 0.81);
  d = villageCloser(d, max(fruit,-y-0.03*w), 7.0);
  d = villageCloser(d, villageDrum(r,y+0.02*w,0.082*w,0.64*w), 3.0);
  return villageCloser(d, length(vec3f(p.x,y-1.68*bulb,p.z))-0.095*bulb, 4.0);
}

fn worksSdf(p: vec3f) -> vec2f {
  let a = lifts.x; let b = lifts.y; let c = lifts.z; let e = lifts.w;
  var d = vec2f(1e6, 0.0);
  if (villageKind == 0) {
    // The fan garden, like a cluster of parasols with their cloth being drawn taut.
    let pair = vec3f(abs(p.x)-1.03*a, p.y, p.z+0.23*a);
    let left = select(0.88,1.10,p.x > 0.0);
    d = bellHouse(pair, 1.56 * b * left, c, 0.74*a);
    let lead = p - vec3f(0.14*c,0.0,0.39*a);
    let big = bellHouse(lead, a*1.39 + c*(1.32+0.06*wig.z), e, 1.27*a);
    if (big.x < d.x) { d = big; }
  } else if (villageKind == 1) {
    // Three roofs, each with its own eave. Each upper
    // storey slides through the solid hip of the roof below (no floating slabs).
    d = pavilionTier(p,1.16*a,0.99*a,vec2f(1.0,0.0),2.0);
    let mid = pavilionTier(p-vec3f(0.0,1.47*a,0.0),0.89*b,0.61*b,azimuth,5.0);
    if (mid.x < d.x) { d = mid; }
    let high = 1.47*a+1.01*b;
    let top = pavilionTier(p-vec3f(0.0,high,0.0),0.66*c,0.52*c,azimuth.yx,2.0);
    if (top.x < d.x) { d = top; }
    let q = p-vec3f(0.0,high+0.89*c,0.0);
    d = villageCloser(d, max((length(q.xz)+0.23*q.y-0.20*e)*0.97,max(-q.y,q.y-0.85*e)),3.0);
    d = villageCloser(d, length(q-vec3f(0.0,0.43*e,0.0))-0.14*e,4.0);
  } else if (villageKind == 2) {
    // Three domes, on a stepped terrace. The side minarets go up in succession.
    let r = max(abs(p.x)*0.71, abs(p.z));
    d = vec2f(villageDrum(r,p.y-0.12*a+0.2,0.12*a+0.2,1.11*a), 5.0);
    d = villageCloser(d, villageDrum(r,p.y-0.39*a,0.16*a,0.99*a),3.0);
    let pair = vec3f(abs(p.x)-1.03*a,p.y-0.51*a,p.z+0.14*a);
    let turret = cupola(pair,select(1.19*b,1.41*c,p.x>0.0),0.52*c,0.54*a);
    if (turret.x < d.x) { d = turret; }
    let onion = cupola(p-vec3f(0.0,0.53*a,0.18*a),1.72*b,(1.06+0.025*wig.z)*e,1.22*a);
    if (onion.x < d.x) { d = onion; }
  } else {
    // The orrery. Its two piers become a pointed horseshoe arch with a real
    // opening. A double meridian and a striped planet turn in the open crown.
    let r = length(p.xz);
    d = vec2f(villageDrum(r,p.y-0.18*a+0.2,0.18*a+0.2,1.20*a),5.0);
    let v = vec2f(abs(p.x),p.y-0.91*b-0.31*a);
    let u0 = vec2f(v.x+0.17*a,max(v.y,0.0));
    let hoop = abs(length(u0)-0.94*a)-0.21*a;
    let arch = max(max(hoop,abs(p.z)-0.31*a),0.28*a-p.y);
    d = villageCloser(d, arch, 1.0);
    let foot = 0.31*a+0.92*b+0.92*a;
    d = villageCloser(d, villageDrum(r,p.y-foot,0.12*a,0.65*a),3.0);
    let q = p-vec3f(0.0,foot+1.02*c,0.0);
    d = villageCloser(d, villageHoop(q.xy,q.z,1.0*c,0.105*c), 3.0);
    let v1 = villageTurn(q.xz,azimuth);
    let inclined = villageTurn(vec2f(q.y,v1.y),vec2f(0.43,0.90283));
    d = villageCloser(d, villageHoop(vec2f(v1.x,inclined.x),inclined.y,1.12*e,0.083*e),5.0);
    d = villageCloser(d, length(q)-0.47*e,8.0);
    d = villageCloser(d, length(q-vec3f(0.0,1.11*c,0.0))-0.13*e,4.0);
  }
  if (scaffold.z > 0.0001) {
    // The survey cage is open geometry, not a grid painted over opaque walls.
    // Brass uprights carry a wire rectangle a little ahead of the masonry.
    let rail = abs(p.xz) - vec2f(scaffold.x, 0.70*scaffold.x);
    let posts = max(length(rail) - scaffold.z, max(p.y-scaffold.y,-p.y-0.25));
    let rim = max(abs(max(rail.x,rail.y)),abs(p.y-scaffold.y))-scaffold.z;
    d = villageCloser(d,min(posts,rim),9.0);
  }
  return d;
}

fn works(ro: vec3f, rd: vec3f, site: vec4f, blaze: f32, scale: f32, pen: f32, t: f32, still: vec2f) -> Seen {
  var seen = Seen(vec3f(0.0), -1.0, 0.0, 1e9);
  let seed = fract(site.w);
  villageKind = i32(site.w);
  let built = min(site.z,1.0);
  let g = smoothstep(vec4f(0.0,0.16,0.39,0.62),vec4f(0.37,0.60,0.84,1.0),vec4f(built));
  lifts = g*(1.0+0.20*g*(1.0-g));
  let sz = 0.87+0.24*seed;
  let tall = (2.2*g.x+0.95*g.y+1.35*g.z+1.0*g.w)*sz;
  let radius = (1.91*g.x+0.1)*sz;
  let foot = ground(site.xy) - 0.23 + 0.62 * max(heaved(site.xy),0.0);
  let base = vec3f(site.x,foot,site.y);
  let px = u.world.w / max(site.y-ro.z,1.0)*scale;
  let slack = (2.4*pen+1.5)/px;
  // Ray against the current footprint and height (two cylinder roots and two slab faces).
  // Start on the near face, not at the eye. Land and holes get their real depth.
  let oc = ro-base;
  let aa = dot(rd.xz,rd.xz);
  let footT = -dot(oc.xz,rd.xz)/aa;
  let side = oc.xz+rd.xz*footT;
  let disc = (radius+slack)*(radius+slack)-dot(side,side);
  if (disc < 0.0) { return seen; }
  let delta = sqrt(disc/aa);
  let t0 = footT-delta;
  let end = footT+delta;
  let yy = oc.y+rd.y*vec2f(t0,end);
  if (max(yy.x,yy.y)< -0.65*sz-slack || min(yy.x,yy.y)>tall+slack) { return seen; }
  let spin = rotY(0.54*(seed-0.5) + select(0.0,0.36,villageKind==1));
  let lo = transpose(spin)*(oc+rd*t0)/sz;
  let ld = transpose(spin)*rd;
  let tempo = t*(0.29+0.15*seed)+seed*16.0;
  wig = vec4f(cos(tempo),sin(tempo),sin(tempo*1.7),0.0);
  let twist = select(tempo, 0.58*wig.y + 0.33,villageKind==1);
  azimuth = vec2f(cos(twist),sin(twist));
  let survey=smoothstep(0.0,0.16,built)*(1.0-smoothstep(0.46,0.82,built));
  scaffold=vec3f(1.30*lifts.x, built*(2.8-0.9*built)+0.46*survey, 0.036*survey);
  let unitPx = px*sz;
  let eps = max(0.0014,0.29/unitPx);
  var dist = 0.0;
  var minGap = 1e6;
  var minAt = 0.0;
  var id = 0.0;
  for (var j=0; j<36; j++) {
    let sample = worksSdf(lo+ld*dist);
    if (sample.x < eps) { id=sample.y; break; }
    if (sample.x < minGap) { minGap=sample.x; minAt=dist; }
    dist += max(eps,sample.x*0.97);
    if (dist*sz > end-t0) { break; }
  }
  seen.edge = t0+minAt*sz;
  if (id == 0.0) {
    seen.ink=stroke(minGap*unitPx,pen*0.93)*smoothstep(0.01,0.10,built);
    return seen;
  }
  let p = lo+ld*dist;
  let k = vec2f(1.0,-1.0)*max(0.002,0.34/unitPx);
  let n = normalize(k.xyy * worksSdf(p+k.xyy).x + k.yyx * worksSdf(p+k.yyx).x + k.yxy * worksSdf(p+k.yxy).x + k.xxx * worksSdf(p+k.xxx).x);
  let lit = dot(spin*n,SUNWARD);
  let palette = i32(seed*3.999);
  let lacquer = K_LACQUERS_3[palette];
  let ivory = K_PAPERS_4[palette];
  var body = select(lacquer,ivory,id==1.0);
  if (id==3.0 || id==4.0) { body=YELLOW; }
  if (id==5.0) { body=select(${vec3('#247f92')},${vec3('#b74771')},palette==1); }
  let theta = atan2(n.z,n.x);
  let detail = smoothstep(5.0,16.0,unitPx);
  let grain = 0.972+0.05*noise(still*2.3);
  var ink = 0.0;
  if (id==1.0 && villageKind==3) {
    let q = vec2f(abs(p.x)+0.17*lifts.x, max(0.0,p.y-0.91*lifts.y-0.31*lifts.x));
    let stone = atan2(q.y,q.x)*10.0+0.6;
    body=mix(ivory,ORANGE,0.87*smoothstep(0.0,0.14,cos(stone)));
    ink=stroke(abs(cos(stone))*unitPx*0.095,pen*0.6)*detail;
    let accent=abs(length(q)-1.04*lifts.x);
    body=mix(body,YELLOW,stroke(accent*unitPx,pen*1.1));
  } else if (id==1.0) {
    // Bands of ogee-arched windows. Flatten them well before sub-pixel scale.
    let az = select(theta/TAU,select(p.x,p.z,abs(n.x)>abs(n.z))*0.32,villageKind==1 || villageKind==3);
    let uv = fract(vec2f(az*6.0+seed,p.y*1.39+0.17))-0.5;
    let pane = max(abs(uv.x)-0.23,max(-uv.y-0.27,uv.y+1.4*uv.x*uv.x-0.28));
    let windows = fill(-pane*unitPx*0.55)*detail*(1.0-smoothstep(0.40,0.75,abs(n.y)));
    body=mix(body,mix(${vec3('#402142')}, LAMP*vec3f(1.85,0.94,0.27),u.orb.z),windows);
    if (blaze>0.0) {
      let fl=0.62*noise(vec2f(uv.x*5.0+seed*9.0+theta*3.0,p.y*3.0-t*3.2))+0.38*noise(vec2f(uv.x*11.0,p.y*7.0-t*5.1));
      let inside=fireHeat(0.5+0.5*fl-0.45*uv.y);
      body=mix(body,mix(inside,LAMP*inside,u.orb.z),blaze*windows);
    }
    ink=stroke(abs(pane)*unitPx*0.55,pen*0.42)*windows;
  } else if (id==7.0 || id==6.0 || id==8.0) {
    // Painted ribs turn around the onion. The fan canopy has scalloped petals,
    // and the orrery's pearl has bands of flame wrapped around its equator.
    let stripe=sin(theta*select(8.0,6.0,id==7.0)+select(1.1*n.y,2.9*n.y,id==7.0)+seed*7.0);
    body=mix(body,select(PINK,YELLOW,palette==2),detail*smoothstep(0.14,0.23,stripe)*0.76);
    if (id==8.0) { body=mix(YELLOW,RED,smoothstep(0.1,0.22,sin(n.y*13.0+2.2*n.x+wig.y))); }
    ink=stroke(abs(stripe-0.18)*unitPx*0.072,pen*0.42)*detail*smoothstep(0.13,0.6,length(n.xz));
  } else if (id==2.0 || id==5.0) {
    // Gold piping where the copper sail turns under; not a texture-noise edge.
    ink=0.6*(1.0-smoothstep(0.06,0.18,abs(n.y)))*detail;
  } else if (id==9.0) {
    body=mix(AQUA, LAMP*vec3f(0.81,1.5,1.35),u.orb.z);
  }
  var tone=mix(body*vec3f(0.49,0.41,0.65),body,smoothstep(-0.03,0.05,lit));
  tone=mix(tone,mix(body,PAPER,0.40),smoothstep(0.57,0.64,lit)*(1.0-u.orb.z*0.50));
  if (id==4.0) { tone=mix(mix(AMBER,YELLOW*1.35,smoothstep(-0.02,0.09,lit)),LAMP*vec3f(2.2,1.31,0.37),u.orb.z); }
  ink=max(ink, (1.0-smoothstep(0.04,0.22,-dot(n,ld)))*0.78);
  let wire = smoothstep(0.01,0.14,built)*(1.0-smoothstep(0.61,0.98,built));
  let ruled = min(abs(fract(theta/TAU*8.0+0.5)-0.5)*0.5, abs(fract(p.y*2.0+0.5)-0.5)*0.5);
  tone=mix(tone,AQUA,wire*stroke(ruled*unitPx,pen*0.67)*0.9);
  var glowAdd=vec3f(0.0);
  if (blaze>0.0) {
    let soot=sin(p.y*4.0+cos(theta*9.0))+0.5*sin(theta*15.0+p.y*3.0);
    tone=mix(tone,vec3f(0.09,0.06,0.07),0.7*blaze*smoothstep(0.0,1.3,soot)*step(1.5,id));
    let ring=theta/TAU*3.0+seed;
    let up=p.y/(0.6+2.4*blaze);
    var lick=0.0;
    if (up<1.0 && textureDimensions(fireMap).x>8u) { lick=flipbook(vec2f(fract(ring),1.0-0.019-up*0.96),t*20.0+floor(ring)*19.0+seed*60.0,60.0,0u); }
    let T=blaze*1.15*lick*(1.0-smoothstep(0.75,1.0,up))*smoothstep(-0.05,0.0,p.y);
    let rim=1.0-smoothstep(0.04,0.22,-dot(n,ld));
    glowAdd=0.8*flameRamp(T)*smoothstep(0.05,0.3,T)+fireHeat(0.45+0.15*lick)*rim*blaze*0.25;
    glowAdd=mix(glowAdd,LAMP*glowAdd,u.orb.z);
    tone*=1.0-0.85*smoothstep(0.05,0.5,T);
  }
  seen.far=t0+dist*sz;
  seen.color=mix(mix(tone*grain,INK,ink)+glowAdd,HAZE,smoothstep(60.0,FAR,seen.far));
  return seen;
}

// A tear in the air: round below, drawn to a point above. p is from its middle, y down.
fn teardrop(p: vec2f, r: f32) -> f32 {
  return select(abs(p.x) - r * (1.0 + p.y / (2.6 * r)), length(p) - r, p.y > 0.0);
}

// Straight runs between random points: the zigzag of a bolt.
fn jag(y: f32, seed: f32) -> f32 {
  let i = floor(y);
  return mix(hash(vec2f(i, seed)), hash(vec2f(i + 1.0, seed)), fract(y)) - 0.5;
}

// Where a bolt is, k of the way down from top to the ground at x.
fn boltX(k: f32, x: f32, tall: f32, seed: f32) -> f32 {
  let lean = (hash(vec2f(seed, 1.0)) - 0.5) * 0.45 * tall;
  return x + lean * (1.0 - k) + (jag(k * 7.0, seed) * 0.2 + jag(k * 23.0, seed + 5.0) * 0.05) * tall * pow(sin(k * 3.14159), 0.6);
}

// How far inside a lightning bolt the point d is, in design units: a jagged
// stroke from top down to the ground at x, girth thick at the top and thinner
// below, with three forks that leave it and taper away to nothing. Only the
// part that has grown so far (0 to 1 of the way down) is there.
fn boltInside(d: vec2f, x: f32, top: f32, ground: f32, seed: f32, grown: f32, girth: f32) -> f32 {
  let tall = max(ground - top, 1.0);
  let k = (d.y - top) / tall;
  if (k < 0.0 || k > grown + 0.02) { return -1e9; }
  var inside = girth * mix(1.0, 0.55, k) * smoothstep(grown + 0.02, grown - 0.03, k) - abs(d.x - boltX(k, x, tall, seed));
  for (var j = 0; j < 3; j++) {
    let luck = hash(vec2f(seed, 10.0 + f32(j)));
    let fork = 0.14 + 0.22 * f32(j) + 0.1 * luck;
    let long = 0.2 + 0.14 * hash(vec2f(seed, 20.0 + f32(j)));
    let run = (k - fork) / long;
    if (run < 0.0 || run > 1.0) { continue; }
    let way = select(-1.0, 1.0, luck > 0.5);
    let at = boltX(fork, x, tall, seed) + way * (k - fork) * tall * (0.5 + 0.5 * luck) + jag(k * 31.0, seed + 9.0 * f32(j)) * 0.035 * tall * min(run * 6.0, 1.0);
    inside = max(inside, girth * 0.6 * (1.0 - run) - abs(d.x - at) * 0.8);
  }
  return inside;
}

// One of the sun's lasers, from an eye to where it lands: a straight hard
// shaft of light, white down the middle and inked at the edge, with flame
// licking back along it and pulses running down its core; light spills round
// it; and where it lands a burst with nested points, a ring thrown out over
// the ground, and embers.
fn laser(d: vec2f, scale: f32, pen: f32, t: f32, eye: vec2f, hit: vec2f, power: f32, under: vec3f) -> vec3f {
  let run = hit - eye;
  let len = max(length(run), 1.0);
  let way = run / len;
  let rel = d - eye;
  let s = dot(rel, way);
  let along = clamp(s / len, 0.0, 1.0);
  let side = rel.x * way.y - rel.y * way.x;
  let off = length(rel - run * along);
  let splash = d - hit;
  let big = u.sun.z;
  if (off > big * 0.75 && dot(splash, splash) > big * big * 4.0) { return under; }
  var color = under;

  // The light it throws on everything near it.
  let stout = power * big * mix(0.105, 0.08, along);
  color += vec3f(1.0, 0.42, 0.16) * 0.2 * power * exp(-off * off / (stout * stout * 14.0 + 1.0));
  color += vec3f(1.0, 0.6, 0.25) * 0.22 * power * exp(-dot(splash * vec2f(1.0, 2.0), splash * vec2f(1.0, 2.0)) / (big * big * 0.9));

  // The shaft. Flames lick back along its edge toward the eye.
  let lick = noise(vec2f(s * 0.06 + t * 14.0, select(3.0, 9.0, side > 0.0)));
  let girth = stout * (1.0 + 0.07 * sin(s * 0.1 - t * 38.0) + 0.5 * lick * lick * lick);
  let inside = (girth - off) * scale;
  let beat = pow(0.5 + 0.5 * sin(s * 0.09 - t * 44.0), 3.0);
  color = mix(color, INK, fill(inside + pen * 1.7));
  color = mix(color, RED, fill(inside));
  color = mix(color, ORANGE, fill(inside - stout * 0.2 * scale));
  color = mix(color, YELLOW * 1.05, fill(inside - stout * 0.38 * scale));
  color = mix(color, vec3f(1.22, 1.18, 1.05) * (1.0 + 0.2 * beat), fill((stout * 0.34 - off) * scale));

  // Where it leaves the eye: a hard point of light with four fine rays.
  let near = rel / max(power * big, 0.001);
  let glare = exp(-abs(near.x) * 9.0) * exp(-abs(near.y) * 60.0) + exp(-abs(near.y) * 9.0) * exp(-abs(near.x) * 60.0);
  color += vec3f(0.9, 0.82, 0.6) * power * (0.8 * glare + 0.8 * exp(-dot(near, near) * 110.0));

  // Where it lands: a ring runs out over the ground,
  for (var k = 0; k < 2; k++) {
    let ride = fract(t * 1.5 + f32(k) * 0.5);
    let ringD = abs(length(splash * vec2f(1.0, 2.7)) - power * big * (0.3 + 1.3 * ride)) * 0.6 * scale;
    let line = pen * 1.5 * (1.0 - ride) * (1.0 - ride) * power;
    color = mix(color, INK, stroke(ringD, line + pen * 0.8) * step(0.01, line));
    color = mix(color, vec3f(1.1, 1.0, 0.7), stroke(ringD, line) * step(0.01, line));
  }
  // a burst, its points nested one colour inside the next and slowly turning,
  let bearing = atan2(splash.y, splash.x);
  let points = pow(abs(cos(bearing * 4.5 + t * 2.6)), 2.2);
  let flick = 0.9 + 0.1 * sin(t * 33.0);
  let burst = (power * big * (0.2 + 0.5 * points) * flick - length(splash)) * scale;
  color = mix(color, INK, fill(burst + pen * 1.7));
  color = mix(color, RED, fill(burst));
  color = mix(color, ORANGE, fill(burst - 0.045 * big * scale));
  color = mix(color, YELLOW * 1.05, fill(burst - 0.095 * big * scale));
  color = mix(color, vec3f(1.25, 1.2, 1.06), fill(burst - 0.16 * big * scale));
  // four long fine rays through it,
  let cross = turn(0.4 + 0.2 * sin(t * 2.0)) * splash / max(power * big, 0.001);
  color += vec3f(0.8, 0.7, 0.5) * power * (exp(-abs(cross.x) * 3.2) * exp(-abs(cross.y) * 46.0) + exp(-abs(cross.y) * 3.2) * exp(-abs(cross.x) * 46.0)) * 0.7;
  // and embers thrown up and falling back.
  for (var k = 0; k < 7; k++) {
    let f = f32(k);
    let ride = fract(t * (1.5 + 0.21 * f) + f * 0.37);
    let lob = vec2f(cos(f * 2.4 + 1.0) * 1.3, -1.9 * (0.6 + 0.4 * sin(f * 5.1))) * ride + vec2f(0.0, 2.3 * ride * ride);
    let ember = (power * big * 0.05 * (1.0 - ride) - length(splash - lob * big * power)) * scale;
    color = mix(color, INK, fill(ember + pen));
    color = mix(color, vec3f(1.2, 1.05, 0.6), fill(ember));
  }
  return color;
}

// Its satellites are eyeballs too. Their pupils point back at the mother eye.
fn orbiter(off: vec2f, r: f32, home: vec2f, unit: f32, pen: f32, which: i32, under: vec3f) -> vec3f {
  let q = off / r;
  let d = length(q);
  let px = r * unit;
  if ((d - 1.0) * px > pen + 1.0) { return under; }
  var c = mix(PINK, PAPER, fill((0.84 - length(q - vec2f(-0.1, 0.19))) * px));
  let iris = length(q - 0.34 * home);
  c = mix(c, INK, fill((0.63 - iris) * px));
  c = mix(c, select(AQUA, YELLOW, which == 0), fill((0.51 - iris) * px));
  c = mix(c, INK, fill((0.29 - iris) * px));
  c = mix(c, vec3f(1.4), fill((0.16 - length(q - 0.34 * home - vec2f(-0.15, 0.22))) * px));
  return mix(mix(under, INK, fill((1.0 - d) * px + pen)), c, fill((1.0 - d) * px));
}

// A folded screen print: the iris is on the sphere, the lids slide over it,
// the two white reflections sit on the surface of the glass, not on the iris.
fn watchIris(lens: vec2f, gaze: vec2f, at: vec2f, px: f32, white: vec3f) -> vec3f {
  let r = length(lens);
  let limbus = 0.645;
  if ((r - limbus) * px > 1.0) { return white; }
  let a = atan2(lens.y, lens.x);
  let t = u.frame.z;
  let pupil = max(0.084, u.watch.z);
  // As the pupil opens, the fibres accordion up against the limbal ring.
  let v = clamp((r - pupil) / (0.605 - pupil), 0.0, 1.0);
  let w = a + 0.17 * v - 0.12 * sin(5.1 * v + 3.0 * a) - 0.026 * t;
  let fibre = cos(23.0 * w + 0.70 * sin(7.0 * w) + 0.35 * sin(13.0 * w));
  let lobe = 11.0 * a + t * 0.29 - 1.6 * v + 0.7 * sin(4.0 * a);
  let collarette = 0.31 + 0.095 * cos(lobe) + 0.043 * cos(2.0 * lobe);
  let violet = vec3f(0.175, 0.12, 0.31);
  let lapis = vec3f(0.105, 0.31, 0.48);
  let peacock = vec3f(0.10, 0.67, 0.66);
  let mint = vec3f(0.56, 0.94, 0.78);
  var iris = mix(lapis, peacock, smoothstep(0.0, 0.36, 1.0 - v));
  // Curved tapered cuts in the blue, outlined in indigo with a turquoise lip.
  let groove = fibre - (0.72 - 1.64 * v * (1.0 - 0.53 * v));
  iris = mix(iris, mint, smoothstep(-0.45, -0.10, groove) * (0.89 - 0.3 * v));
  iris = mix(iris, lapis * 0.76, smoothstep(-0.05, 0.29, groove));
  // Every other dark cut splits: a fleck of sea-glass nested inside the
  // longer fibre, not another stripe drawn across it.
  let lap = 0.5 + 0.5 * cos(8.0 * w - 2.0 * v);
  let split = smoothstep(0.78, 0.97, fibre) * smoothstep(0.31, 0.50, v) * (1.0 - smoothstep(0.65 + 0.2 * lap, 0.95, v));
  iris = mix(iris, mix(TEAL, mint, 0.75 * lap), split * (0.42 + 0.5 * lap));
  // Prussian blue round the rim, viridian at the foot of the fibres.
  iris *= mix(vec3f(0.88, 1.08, 0.83), vec3f(0.93, 0.89, 1.13), smoothstep(0.42, 0.96, v));
  let amber = mix(ORANGE, YELLOW * 1.09, smoothstep(-0.8, 0.5, sin(17.0 * w - 2.0 * v)));
  let gold = mix(amber, LAMP * vec3f(1.04, 0.84, 0.43), (0.35 + 0.19 * cos(lobe)) * u.orb.z);
  let edge = (collarette - v) * (0.605 - pupil) * px;
  iris = mix(iris, violet, fill(edge + 0.016 * px));
  iris = mix(iris, gold, fill(edge - 0.005 * px));
  iris = mix(iris, mix(PINK, RED, 0.47), fill((0.12 + 0.045 * cos(lobe) - v) * (0.605 - pupil) * px));
  iris = mix(iris, violet * 0.71, fill((r - 0.598) * px));
  iris = mix(iris, INK, fill((r - 0.623) * px));
  var c = mix(white, iris, fill((limbus - r) * px));
  // The second eye, ivory and coral in a pool of almost black ink.
  let little = turn(-0.11) * lens / pupil;
  let ly = little.y + 0.055;
  let almond = (0.42 * (1.0 - little.x * little.x / 0.615) - abs(ly)) * pupil * px;
  var well = mix(vec3f(0.075, 0.054, 0.111), violet * 0.73, smoothstep(0.14, 0.92, -little.y));
  let jewel = length(vec2f(little.x, ly) - 0.19 * gaze);
  var tiny = mix(vec3f(1.09, 0.99, 0.78), PINK, fill((0.36 - jewel) * pupil * px));
  tiny = mix(tiny, INK, fill((0.224 - jewel) * pupil * px));
  tiny = mix(tiny, vec3f(1.42), fill((0.078 - length(vec2f(little.x + 0.075, ly - 0.115) - 0.19 * gaze)) * pupil * px));
  c = mix(c, mix(well, tiny, fill(almond)), fill((pupil - r) * px));
  // An oval reflection and its little bead of light. They slide over the
  // print when it looks away, as on a curved watch crystal.
  let wet = turn(-0.55) * (at - 0.60 * gaze - vec2f(-0.235, 0.285));
  let shine = max(0.070 - length(wet * vec2f(0.64, 1.28)), 0.028 - length(wet - vec2f(0.172, -0.020)));
  // Cool bounced light on the opposite edge of the cornea, a broken arc.
  let reflected = smoothstep(0.03, 0.19, lens.x) * smoothstep(0.10, 0.27, -lens.y);
  c = mix(c, vec3f(0.83, 0.95, 0.79), 0.69 * reflected * fill((0.011 - abs(r - 0.541)) * px));
  c = mix(c, vec3f(1.45, 1.37, 1.19), fill(shine * px));
  return c;
}

fn watchGlobe(at: vec2f, px: f32, pen: f32, still: vec2f, axis: vec3f, t: f32, under: vec3f) -> vec3f {
  let q = turn(0.055) * at;
  let r = length(q);
  let bite = u.watch.w;
  // A quick downstroke, a slower upstroke. The beam holds the eye wide.
  let phase = fract(0.143 * t + 0.34 + 0.031 * sin(0.77 * t));
  let blink = smoothstep(0.0, 0.022, phase) * (1.0 - smoothstep(0.030, 0.078, phase));
  let opened = (1.0 - u.planet.w) * (1.0 - blink * (1.0 - bite));
  let arch = 1.0 - q.x * q.x / 0.952;
  let top = (-0.12 + (0.885 + bite * 0.14) * opened) * arch;
  let bottom = (-0.12 - (0.475 + bite * 0.18) * opened) * arch;
  var color = under;
  if (r < 1.07) {
    let sphere = vec3f(at, sqrt(max(0.0, 1.0 - r * r)));
    let contour = (1.0 - r + 0.005 * sin(q.x * 15.0 + q.y * 4.0) + 0.003 * sin(q.y * 12.0)) * px;
    let lit = dot(sphere, LIGHT);
    let crease = (q.y - top) * inverseSqrt(1.0 + 1.8 * q.x * q.x);
    // Rose-lacquer lids, gold piping, a second engraving following their fold.
    let hem = q.y - bottom + 0.14 * arch;
    var lid = mix(vec3f(0.40, 0.15, 0.34), PINK * 0.91, fill((hem + 0.045) * px));
    lid = mix(lid, ORANGE, fill((hem + 0.26) * px) * fill((-hem - 0.20) * px));
    lid = mix(lid, mix(RED, ORANGE, 0.66), fill(crease * px));
    lid = mix(lid, YELLOW, fill((crease - 0.090) * px));
    lid = mix(lid, mix(RED, PINK, 0.65), fill((crease - 0.164) * px));
    lid = mix(lid, INK, stroke(abs(crease - 0.18) * px, pen * 0.54));
    let fan = crease + 0.24 * q.x * q.x;
    lid = mix(lid, PURPLE, fill((fan - 0.39) * px));
    lid = mix(lid, PINK, fill((fan - 0.57) * px));
    lid = mix(lid, YELLOW, fill((fan - 0.77) * px));
    lid *= 0.69 + 0.34 * smoothstep(-0.44, 0.72, lit);
    let almond = min(min(top - q.y, q.y - bottom), arch) * px;
    if (almond > -1.0) {
      // Paper ivory on the light side, a sea-glass terminator, a warm rim.
      let dusk = smoothstep(-0.42, 0.27, lit);
      var shell = mix(vec3f(0.56, 0.74, 0.72), vec3f(1.0, 0.945, 0.815), dusk);
      shell = mix(shell, vec3f(1.02, 0.80, 0.67), (1.0 - smoothstep(0.07, 0.40, sphere.z)) * 0.8);
      let side = abs(q.x);
      let run = 0.98 - side;
      let forkY = (0.46 * sign(q.x) + 0.09) * run + 0.025 * sin(29.0 * run) + 0.02 * sin(16.0 * q.x);
      let branch = forkY + 0.65 * max(run - 0.125, 0.0);
      let vein = min(abs(q.y - forkY), abs(q.y - branch) + max(0.125 - run, 0.0));
      shell = mix(shell, vec3f(0.75, 0.29, 0.39), 0.77 * smoothstep(0.55, 0.79, side) * fill((0.003 + 0.010 * side - vein) * px));
      let gaze = u.watch.xy;
      let normal = vec3f(gaze, sqrt(max(0.01, 1.0 - dot(gaze, gaze))));
      let across = normalize(cross(vec3f(0, 1, 0), normal));
      let lens = vec2f(dot(sphere, across), dot(sphere, cross(normal, across)));
      var eye = shell;
      if (dot(sphere, normal) > 0.0) { eye = watchIris(lens, gaze, at, px, shell); }
      eye *= 0.79 + 0.23 * smoothstep(-0.40, 0.75, lit);
      // Short shadow just beneath the heavy upper lid; a sliver of reflected
      // ivory along the lower meniscus. Both follow the lids, not the iris.
      eye *= mix(vec3f(1), vec3f(0.68, 0.66, 0.75), 1.0 - smoothstep(0.025, 0.098, -crease));
      let meniscus = fill((0.009 - abs(q.y - bottom - 0.043)) * px) * smoothstep(0.22, 0.66, abs(q.x)) * opened;
      eye = mix(eye, vec3f(1.21, 1.11, 0.94), meniscus * 0.9);
      lid = mix(lid, eye, fill(almond));
    }
    lid = mix(lid, INK, stroke(abs(almond), pen * 0.78));
    lid = mix(lid, INK, stroke(abs(crease) * px, pen * 1.12) * fill(arch * px));
    // Intersect a ray to the light with the actual annulus. The shadow bends
    // round the ball and also crosses the closed lid.
    let sunward = vec3f(-0.38, 0.81, 0.46);
    let h = -dot(sphere, axis) / dot(sunward, axis);
    let rr = length(sphere + h * sunward);
    let shade = smoothstep(0.0, 0.06, h) * smoothstep(1.41, 1.49, rr) * (1.0 - smoothstep(1.76, 1.85, rr));
    lid = mix(lid, lid * vec3f(0.58, 0.57, 0.74), shade * 0.78);
    color = mix(mix(color, INK, fill(contour + 0.86 * pen)), lid * (0.985 + 0.027 * noise(still * 2.3)), fill(contour - 0.49 * pen));
  }
  // Seven quill lashes: each curves out of its own moving root, swells into
  // a little flame, and tapers back to a point. A second cut leaves gold in it.
  if (q.y > -0.16 && q.y < 1.59) {
    for (var i = 0; i < 7; i++) {
      let k = f32(i - 3) / 3.0;
      let x = k * 0.84;
      let root = vec2f(x, (-0.12 + (0.885 + bite * 0.14) * opened) * (1.0 - x * x / 0.952));
      let delta = vec2f(k * 0.39 + 0.085, (0.61 - 0.20 * k * k + 0.065 * cos(f32(i) * 3.14159)) * (0.31 + 0.69 * opened));
      let p = q - root;
      let v = dot(p, delta) / dot(delta, delta);
      if (v < -0.04 || v > 1.03) { continue; }
      let f = clamp(v, 0.0, 1.0);
      let curve = dot(p, normalize(vec2f(delta.y, -delta.x))) + (0.34 - 0.07 * k) * f * (1.0 - f);
      let width = (0.031 + 0.176 * f * (1.0 - f)) * (1.0 - f * f);
      let d = min(min(width - abs(curve), (v + 0.025) * 0.49), (1.0 - v) * 0.49) * px;
      color = mix(color, INK, fill(d));
      color = mix(color, mix(ORANGE, YELLOW, 0.60), fill((width * 0.53 - abs(curve + 0.009)) * px) * smoothstep(0.09, 0.35, f) * (1.0 - smoothstep(0.78, 0.95, f)));
    }
  }
  return color;
}

// Saturn's record: the paper can be seen between the blue LP, its copper
// outer groove, and the hairline orbit carrying the two smaller eyes.
fn planet(at: vec2f, unit: f32, pen: f32, still: vec2f, t: f32, under: vec3f) -> vec3f {
  let r2 = dot(at, at);
  if (r2 > 6.00) { return under; }
  var color = under;
  for (var i = 0; i < 3; i++) {
    let s = K_STARS_2[i];
    let p = abs(at - s.xy);
    if (max(p.x, p.y) > 0.27) { continue; }
    let a = s.z * (1.0 + 0.13 * sin(t * 1.32 + f32(i) * 2.5));
    let d = (a - p.x * 1.20 - p.y * 0.77 - p.x * p.y * 37.0) * unit;
    color = mix(color, INK, fill(d + pen * 0.46));
    color = mix(color, select(vec3f(1.14, 0.93, 0.56), AQUA * 1.16, i == 0), fill(d - pen * 0.32));
  }
  if (r2 > 4.76) { return color; }
  let axis = normalize(vec3f(-0.325 + 0.046 * sin(0.21 * t), 1.0, 0.53 + 0.050 * sin(0.34 * t)));
  let slope = -axis.xy / axis.z;
  let z = dot(slope, at);
  let disc = vec3f(at, z);
  let rr = length(disc);
  let east = normalize(vec3f(axis.y, -axis.x, 0.0));
  let north = cross(east, axis);
  var cover = 0.0;
  var band = INK;
  if (rr > 1.28 && rr < 2.12) {
    let px = unit * rr / max(0.001, length(at + z * slope));
    let ribbon = 0.17 - abs(rr - 1.60);
    let lip = 0.044 - abs(rr - 1.877);
    let wire = 0.010 - abs(rr - 2.001);
    cover = fill(max(max(ribbon, lip), wire) * px + 0.67 * pen);
    // Thin records of print colour, with a broad turquoise stripe left quiet.
    band = mix(band, PINK, fill(ribbon * px));
    band = mix(band, mix(PURPLE, PINK, 0.21), fill((rr - 1.484) * px) * fill((1.553 - rr) * px));
    band = mix(band, TEAL, fill((rr - 1.553) * px) * fill((1.742 - rr) * px));
    band = mix(band, AQUA * 1.10, fill((rr - 1.614) * px) * fill((1.736 - rr) * px));
    band = mix(band, PAPER, fill((0.016 - abs(rr - 1.755)) * px));
    band = mix(band, ORANGE, fill(lip * px));
    band = mix(band, YELLOW * 1.12, fill((0.019 - abs(rr - 1.897)) * px));
    band = mix(band, PAPER, fill(wire * px));
    let burnish = smoothstep(0.72, 0.96, dot(disc / rr, normalize(east - 0.55 * north)));
    band = mix(band, vec3f(1.28, 1.12, 0.85), burnish * fill((0.016 - abs(rr - 1.685)) * px));
    // The far side runs through the sphere's shadow, strongest at the umbra.
    let sunlight = normalize(vec3f(-0.38, 0.81, 0.46));
    let h = max(0.0, -dot(disc, sunlight));
    let umbra = smoothstep(0.0, 0.18, h) * (1.0 - smoothstep(0.91, 1.07, length(disc + sunlight * h)));
    band *= mix(vec3f(1.0), vec3f(0.55, 0.57, 0.75), umbra);
  }
  var moons = array<vec3f, 2>();
  for (var i = 0; i < 2; i++) {
    let a = t * (0.30 - 0.045 * f32(i)) + 0.73 + f32(i) * 2.41;
    moons[i] = (2.001 - 0.12 * f32(i)) * (east * cos(a) + north * sin(a));
  }
  // Out at the nodes nothing can overlap the globe. Both moons ride on the
  // ribbon there: don't swap a moon through the ink as its centre crosses z=0.
  if (r2 >= 2.63) {
    color = mix(color, band, cover);
    let back = select(1, 0, moons[0].z < moons[1].z);
    for (var k = 0; k < 2; k++) {
      let i = (back + k) % 2;
      color = orbiter(at - moons[i].xy, 0.123 - 0.031 * f32(i), normalize(-moons[i].xy), unit, pen * 0.66, i, color);
    }
    return color;
  }
  if (z < 0.0) { color = mix(color, band, cover); }
  for (var i = 0; i < 2; i++) {
    if (moons[i].z < 0.0) { color = orbiter(at - moons[i].xy, 0.123 - 0.031 * f32(i), normalize(-moons[i].xy), unit, pen * 0.66, i, color); }
  }
  color = watchGlobe(at, unit, pen, still, axis, t, color);
  if (z >= 0.0) { color = mix(color, band, cover); }
  for (var i = 0; i < 2; i++) {
    if (moons[i].z >= 0.0) { color = orbiter(at - moons[i].xy, 0.123 - 0.031 * f32(i), normalize(-moons[i].xy), unit, pen * 0.66, i, color); }
  }
  return color;
}

// Signed distances from the lettering's texture, in texels and positive inside:
// even letters, odd letters, the black shape behind them, and how deep inside a letter.
fn titleField(uv: vec2f) -> vec4f {
  var texel: vec4f;
  if (takeoverLive && daxBand) { texel=textureSampleLevel(daxMap,titleSampler,uv,0.0); }
  else { texel=textureSampleLevel(titleMap,titleSampler,uv,0.0); }
  return vec4f((texel.rgb - 0.5) * 2.0 * u.titleInfo.x, texel.a * u.titleSize.z);
}

// Each letter is a slab of hard candy: red at the top of the lettering through
// to amber at the bottom, with a rounded rim that catches the light on one
// side, falls into shadow on the other, and carries a thin white streak. A
// shine crosses the word now and then. height is 0 at the top and 1 at the
// bottom; inside is design units in from the edge; outward points out of the letter.
fn candy(at: vec2f, height: f32, inside: f32, outward: vec2f, perPixel: f32, t: f32) -> vec3f {
  var c = mix(mix(${vec3('#e62e1c')}, ${vec3('#f4611c')}, smoothstep(0.0, 0.55, height)), ${vec3('#fba428')}, smoothstep(0.45, 1.0, height));
  let rimWidth = 8.0;
  let rim = 1.0 - clamp(inside / rimWidth, 0.0, 1.0);
  let facing = dot(outward, normalize(u.look.xy));
  let lit = facing * rim;
  let soft = 1.2 / (rimWidth * perPixel);
  c = mix(c, vec3f(1.0, 0.84, 0.36), 0.92 * smoothstep(0.2 - soft, 0.2 + soft, lit));
  c = mix(c, vec3f(0.62, 0.06, 0.1), 0.88 * smoothstep(0.2 - soft, 0.2 + soft, -lit));
  c = mix(c, vec3f(1.7, 1.66, 1.5), stroke(abs(rim - 0.5) * rimWidth * perPixel, 0.8 * perPixel) * smoothstep(0.5, 0.72, facing));
  let sweep = at.x + at.y * 0.6 - (fract(t * 0.1) * 3.4 - 1.0) * u.frame.w;
  c = mix(c, vec3f(1.0, 0.96, 0.82), 0.45 * fill((30.0 - abs(sweep)) * perPixel));
  return c * (0.972 + 0.05 * noise(at * 2.3));
}

fn capsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}

fn ellipsoid(p: vec3f, r: vec3f) -> f32 {
  return (length(p / r) - 1.0) * min(r.x, min(r.y, r.z));
}

// The sun's head in relief, in face radii: a flattened ball with cheeks, a brow
// ridge, a nose, lidded eyes, lips and a chin. x right, y up, z toward the eye.
fn sunHead(p: vec3f) -> f32 {
  let m = vec3f(abs(p.x), p.y, p.z);
  var d = ellipsoid(p, vec3f(1.0, 1.0, 0.56));
  d = smin(d, length(m - vec3f(0.5, -0.17, 0.3)) - 0.2, 0.2);
  d = smin(d, capsule(m, vec3f(0.1, 0.47, 0.47), vec3f(0.63, 0.44, 0.33), 0.06), 0.12);
  d = smin(d, capsule(p, vec3f(0.0, 0.36, 0.47), vec3f(0.0, -0.13, 0.63), 0.066), 0.1);
  d = smin(d, length(m - vec3f(0.075, -0.16, 0.56)) - 0.066, 0.05);
  d = -smin(-d, length(m - vec3f(0.37, 0.2, 0.63)) - 0.15, 0.08);
  d = smin(d, ellipsoid(m - vec3f(0.37, 0.213, 0.41), vec3f(0.2, 0.12, 0.13)), 0.04);
  d = smin(d, ellipsoid(p - vec3f(0.0, -0.395, 0.47), vec3f(0.22, 0.05, 0.085)), 0.05);
  d = smin(d, ellipsoid(p - vec3f(0.0, -0.478, 0.455), vec3f(0.16, 0.058, 0.085)), 0.05);
  d = smin(d, length(p - vec3f(0.0, -0.72, 0.31)) - 0.14, 0.16);
  return d;
}

fn sunNormal(p: vec3f) -> vec3f {
  let e = vec2f(0.002, -0.002);
  return normalize(e.xyy * sunHead(p + e.xyy) + e.yyx * sunHead(p + e.yyx) + e.yxy * sunHead(p + e.yxy) + e.xxx * sunHead(p + e.xxx));
}

// The sun: flames on two waving sheets behind a head carved in relief. at is the
// point on the sun's view plane in face radii, unit is pixels per face radius.
// What a pen or a colour laid over cover (see sun) at strength k makes of it.
fn laid(cover: vec4f, ink: vec3f, k: f32) -> vec4f {
  return vec4f(mix(cover.rgb, ink, k), cover.a * (1.0 - k));
}

// (It returns what it does to what is under it: that times a, plus rgb.)
fn sun(at: vec2f, unit: f32, pen: f32, still: vec2f, t: f32) -> vec4f {
  var color = vec4f(0.0, 0.0, 0.0, 1.0);
  let back = u.sunBack.xyz;
  let origin = u.sunRight.xyz * at.x + u.sunUp.xyz * at.y + back * 5.0;
  let step12 = TAU / 16.0;
  let moon = orbMoon;

  // The moon has no flames: a ring of light and a turning ring of dashes instead.
  if (moon > 0.5) {
    let r = length(at);
    let dash = step(0.5, fract(atan2(at.y, at.x) / TAU * 40.0 + t * 0.02));
    let halo = max(stroke(abs(r - 1.4) * unit, pen * 0.8), stroke(abs(r - 1.66) * unit, pen * 0.55) * dash);
    color = laid(color, MOON_LIGHT * 1.5, halo);
  }

  for (var ring = 0; ring < 2; ring++) {
    if (moon > 0.5) { break; }
    let long = ring == 1;
    // Find where the ray meets this ring's sheet, which ripples in depth.
    let layer = select(-0.44, -0.26, long);
    var p = origin - back * ((origin.z - layer) / back.z);
    var r = length(p.xy);
    var theta = atan2(p.y, p.x);
    var ripple = r * 2.4 - t * 0.7 + theta * 2.0 + f32(ring) * 2.0;
    let sheet = layer - 0.1 * (r - 1.0) + 0.13 * sin(ripple) * smoothstep(1.0, 1.7, r);
    p = origin - back * ((origin.z - sheet) / back.z);
    r = length(p.xy);
    theta = atan2(p.y, p.x);
    ripple = r * 2.4 - t * 0.7 + theta * 2.0 + f32(ring) * 2.0;

    let offset = select(step12 * 0.5, 0.0, long) + 0.05 * sin(t * 0.3) + select(u.lean.z, u.lean.w, long);
    let nearest = round((theta - offset) / step12);
    var best = vec2f(-9.0, -9.0);
    var who = 0.0;
    for (var n = -1; n <= 1; n++) {
      let index = nearest + f32(n);
      let f = flame(r, theta - offset, index, select(3.0, 7.0, long), select(2.05, 3.05, long), t);
      if (f.x > best.x) { best = f; who = index; }
    }

    // The sheet tilts as it ripples, so each flame catches the light in bands.
    let slopeOut = -0.1 + 0.312 * cos(ripple) * smoothstep(1.0, 1.7, r);
    let slopeRound = 0.26 * cos(ripple) * smoothstep(1.0, 1.7, r) / max(r, 0.4);
    let outward = p.xy / max(r, 0.001);
    let normal = normalize(vec3f(-(slopeOut * outward + slopeRound * vec2f(-outward.y, outward.x)), 1.0));
    let lit = smoothstep(0.37, 0.43, dot(normal, LIGHT));
    let body = mix(select(ORANGE, SUN_MID, long), select(AMBER, YELLOW, long), lit);
    var fire = paint(body, body, p.xy * u.sun.z, still, who + f32(ring) * 31.0);
    fire = mix(fire, select(RED, ORANGE, long), fill(best.y * unit) * smoothstep(1.05, 1.3, r));
    color = laid(color, fire, fill(best.x * unit));
    color = laid(color, INK, stroke(abs(best.x * unit), pen * 0.9));
  }

  if (dot(at, at) < 1.8) {
    var travelled = 3.6;
    var previous = 1e9;
    var graze = 1e9;
    var hit = false;
    for (var i = 0; i < 56; i++) {
      let dist = sunHead(origin - back * travelled);
      if (dist < 0.0015) { hit = true; break; }
      if (dist > previous) { graze = min(graze, previous); }
      previous = dist;
      travelled += dist * 0.75;
      if (travelled > 6.5) { break; }
    }
    let outline = stroke(abs(graze * unit - pen * 1.1), pen * 1.1);
    if (hit) {
      let p = origin - back * travelled;
      let n = sunNormal(p);
      let lit = dot(n, LIGHT);
      var skin = mix(mix(SUN_SHADE, MOON_SHADE, moon), mix(SUN_MID, MOON_MID, moon), smoothstep(-0.02, 0.04, lit));
      skin = mix(skin, mix(YELLOW, MOON_LIGHT, moon), smoothstep(0.2, 0.26, lit));
      skin = paint(skin, skin, p.xy * u.sun.z, still, 77.0);
      // Engraver's hatching in the shade, following the curve of the head.
      let hatch = stroke(abs(fract((p.x * 0.55 + p.y + 0.3 * n.x) * 14.0) - 0.5) / 14.0 * unit, pen * 0.3);
      skin = mix(skin, mix(${vec3('#c7551a')}, ${vec3('#5f5a94')}, moon), 0.75 * hatch * (1.0 - smoothstep(-0.1, 0.08, lit)));
      // The moon is cratered.
      var pits = 0.0;
      if (moon > 0.5) {
        for (var i = 0; i < 5; i++) {
          let off = p.xy - K_CRATERS_1[i].xy;
          skin = mix(skin, MOON_SHADE, 0.7 * fill((K_CRATERS_1[i].z - length(off)) * unit));
          skin = mix(skin, MOON_LIGHT, fill((K_CRATERS_1[i].z - length(off)) * unit) * fill((length(off + vec2f(-0.03, 0.03)) - K_CRATERS_1[i].z) * unit));
          pits = max(pits, stroke(abs(length(off) - K_CRATERS_1[i].z) * unit, pen * 0.6));
        }
      }
      let gaze = clamp(vec2f(u.lean.x, u.lean.y) * vec2f(0.3, 0.5), vec2f(-0.07, -0.035), vec2f(0.07, 0.035));
      color = vec4f(mix(face(vec2f(p.x, -p.y), skin, pen, unit, gaze, u.mood.x, u.mood.y, t), INK, max(outline, pits)), 0.0);
    } else {
      color = laid(color, INK, outline);
    }
  }
  return color;
}

// The sun's own pass, over a square round it (see sunBox): where it is and which way it has rolled
// worked out as fragmentMain does.
@fragment
fn sunMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let scale = u.frame.x / u.frame.w;
  let d = (position.xy + u.sunStamp.xy) / scale;
  var sunNow = u.sun.xy + vec2f(0.0, u.sky.z);
  let wheel = abs(u.orb.y);
  var roll = 0.0;
  orbMoon = u.orb.x;
  if (wheel > 0.0) {
    let swing = mix(1.75, 1.13, smoothstep(600.0, 1440.0, u.frame.w));
    let arm = 520.0 / (1.0 - cos(swing));
    let goingOut = swing * wheel;
    let comingIn = -swing * (1.0 - wheel);
    let leaving = sunNow + arm * vec2f(sin(goingOut), 1.0 - cos(goingOut));
    let arriving = sunNow + arm * vec2f(sin(comingIn), 1.0 - cos(comingIn));
    let newcomer = dot(d - arriving, d - arriving) < dot(d - leaving, d - leaving);
    let toNight = u.orb.y > 0.0;
    sunNow = select(leaving, arriving, newcomer);
    roll = select(goingOut, comingIn, newcomer);
    orbMoon = select(0.0, 1.0, newcomer == toNight);
  }
  let swell = 1.0 + 0.13 * u.mood.y * u.mood.y * (3.0 - 2.0 * u.mood.y);
  let upright = (d - sunNow) / (u.sun.z * swell) * vec2f(1.0, -1.0);
  let at = vec2f(upright.x * cos(roll) - upright.y * sin(roll), upright.x * sin(roll) + upright.y * cos(roll));
  if (dot(at, at) >= 13.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return sun(at, u.sun.z * swell * scale, u.look.z * scale * 0.5, d, u.frame.z);
}

// The tab's face, as it was on the grey page: at is in face radii, y up.
fn smiley(at: vec2f, unit: f32, pen: f32, t: f32) -> vec3f {
  let q = vec2f(at.x, -at.y);
  var c = vec3f(0.99, 0.77, 0.19) * (1.07 - 0.17 * smoothstep(-0.5, 1.0, q.y + 0.3 * q.x));
  c = mix(c, vec3f(1.0, 0.97, 0.8), 0.5 * smoothstep(0.34, 0.1, length((q - vec2f(-0.38, -0.46)) * vec2f(1.0, 1.7))));
  c = mix(c, vec3f(0.95, 0.42, 0.45), 0.55 * smoothstep(0.17, 0.08, length(vec2f(abs(q.x) - 0.6, q.y - 0.2))));
  let wink = fract(t / 3.0 + 0.4);
  let shut = smoothstep(0.0, 0.02, wink) * (1.0 - smoothstep(0.035, 0.07, wink));
  let look = 0.05 * vec2f(sin(t * 1.3), cos(t * 0.9));
  let e = vec2f(abs(q.x - look.x) - 0.32, q.y - look.y + 0.17);
  let socket = vec2f(0.17, 0.215 * (1.0 - 0.9 * shut));
  c = mix(c, vec3f(0.02, 0.015, 0.02), fill((1.0 - length(e / socket)) * socket.x * unit));
  c = mix(c, vec3f(1.0), fill((0.06 - length(e - socket * vec2f(0.34 * sign(q.x - look.x), -0.38))) * unit) * (1.0 - shut));
  let gm = q - vec2f(look.x * 0.5, 0.07);
  let span = 1.05;
  let end = vec2f(look.x * 0.5, 0.07) + 0.44 * vec2f(sin(span) * select(-1.0, 1.0, gm.x > 0.0), cos(span));
  let grin = select(length(q - end), abs(length(gm) - 0.44), abs(atan2(gm.x, gm.y)) < span) - 0.05;
  c = mix(c, INK, fill(-grin * unit));
  return c;
}

// What is under that: a grey face that has never been surprised by anything.
fn greyFace(at: vec2f, unit: f32, pen: f32) -> vec3f {
  let q = vec2f(at.x, -at.y);
  var c = vec3f(0.76) * (1.03 - 0.08 * smoothstep(-0.5, 1.0, q.y));
  let lens = roundRect(vec2f(abs(q.x) - 0.33, q.y + 0.16), vec2f(0.24, 0.16), 0.05);
  c = mix(c, vec3f(0.86), fill(-lens * unit));
  c = mix(c, vec3f(0.3), stroke(abs(lens) * unit, pen * 0.9));
  c = mix(c, vec3f(0.3), stroke(segment(q, vec2f(-0.09, -0.18), vec2f(0.09, -0.18)) * unit, pen * 0.9));
  c = mix(c, vec3f(0.25), fill((0.045 - length(vec2f(abs(q.x) - 0.33, q.y + 0.15))) * unit));
  c = mix(c, vec3f(0.3), stroke(segment(q, vec2f(-0.2, 0.36), vec2f(0.2, 0.36)) * unit, pen * 1.1));
  return c;
}

// A sticker rolled back on itself where it is being peeled: how far behind
// the line a point is (across), how far along it (side), and the line's own place.
fn rolled(across: f32, side: f32, line: f32, unit: f32, pen: f32, under: vec3f) -> vec3f {
  let wide = 0.2;
  let chord = sqrt(max(1.0 - line * line, 0.0));
  if (chord <= 0.0 || across < -0.05 || across > wide + 0.05) { return under; }
  let k = clamp(across / wide, 0.0, 1.0);
  let body = min(min(across, wide - across), chord - abs(side)) * unit;
  var c = PAPER * (0.66 + 0.5 * sin(3.14159 * k)) + 0.25 * exp(-pow((k - 0.62) / 0.08, 2.0));
  c = mix(c, INK, stroke(abs(body), pen));
  return mix(under, c, fill(body + pen));
}

// The sun takes its face off like a sticker. Under it is the tab's smiley;
// under that, for a moment, something grey; and then its own face is rolled
// back on from the top. k runs from 0 to 1 over the whole of it.
// xy = which plate won this scan band, its horizontal registration error.
fn takeoverBand(y: f32) -> vec2f {
  if (u.boss.x >= 1.0) { return vec2f(1.0,0.0); }
  let tick = floor(u.frame.z*20.0) + u.boss.w;
  let band = floor(y * (0.05 + 0.074 * hash(vec2f(tick,2.0))) + 11.0 * hash(vec2f(tick,5.0)));
  let slip = u.boss.z * 49.0 * (hash(vec2f(band,tick+9.0))-0.5) * step(0.5,hash(vec2f(tick+3.0,band)));
  return vec2f(step(hash(vec2f(band,tick)),u.boss.x*1.02-0.01),slip);
}

fn bossed(at: vec2f, unit: f32, t: f32, under: vec3f) -> vec3f {
  let q=at-vec2f(0.0,0.09+0.047*sin(u.bossRig.w*2.8));
  if (abs(q.x)>1.12 || abs(q.y)>1.75) { return under; }
  let uv=0.5+q*vec2f(1.0,-1.0)/3.72;
  let split=vec2f(u.boss.z*0.018,0.0);
  let p=textureSampleLevel(faceMap,titleSampler,uv,0.0);
  var rgb=p.rgb;
  if(u.boss.z>0.0){rgb=vec3f(textureSampleLevel(faceMap,titleSampler,uv+split,0.0).r,p.g,textureSampleLevel(faceMap,titleSampler,uv-split,0.0).b);}
  let rim=vec2f(2.1/3.72/unit*u.frame.x/u.frame.w,0.0);
  let edge=max(max(textureSampleLevel(faceMap,titleSampler,uv+rim,0.0).a,textureSampleLevel(faceMap,titleSampler,uv-rim,0.0).a),max(textureSampleLevel(faceMap,titleSampler,uv+rim.yx,0.0).a,textureSampleLevel(faceMap,titleSampler,uv-rim.yx,0.0).a));
  return mix(mix(under,INK,edge),rgb,p.a);
}

// Two slots: the preceding card's cooling impact can overlap the next emission.
fn cometInk(d: vec2f, s: f32, t: f32, under: vec3f) -> vec3f {
  var c=under;
  for(var j=0;j<2;j++){
    let card=u.comet[j*2]; let trail=u.comet[j*2+1];
    if(card.z<=0.0){ continue; }
    let q=d-card.xy;
    if(trail.w>0.0){
      let age=trail.w; let k=1.0-age;
      let reach=110.0*(1.0-k*k);
      if(any(abs(q)>vec2f(reach+3.0))){continue;}
      let r=length(q); let a=atan2(q.y,q.x+0.0001);
      let lobes=0.52+0.15*sin(a*5.0+card.w)+0.12*cos(a*9.0-age*3.0);
      let flash=(reach*(1.25-0.80*age)*lobes-r)*s;
      let ring=abs(r-(reach-5.0)*(0.91+0.05*sin(6.0*a)));
      c=mix(c,INK,k*fill((1.6+4.0*k-ring)*s));
      c=mix(c,vec3f(1.0,0.53,0.12),k*fill((3.0*k-ring)*s));
      c=mix(c,INK,k*fill(flash+2.0*s)); c=mix(c,vec3f(1.0,0.19,0.08),k*fill(flash));
      c=mix(c,vec3f(1.48,1.16,0.56),k*fill(flash-reach*0.18*s));
      // Ink chips fling out of the hot centre and cool at the edge of the ring.
      let slices=6.2831853/8.0;
      let ray=round((a-card.w*0.14)/slices)*slices+card.w*0.14;
      let chip=q-reach*0.86*vec2f(cos(ray),sin(ray));
      let chipSD=(reach*0.12-abs(dot(chip,vec2f(cos(ray),sin(ray))))-2.3*abs(dot(chip,vec2f(-sin(ray),cos(ray)))))*s;
      c=mix(c,INK,k*fill(chipSD+s));c=mix(c,vec3f(1.41,0.87,0.19),k*fill(chipSD)); continue;
    }
    let w=card.z;
    if(abs(q.x)>w*1.15 || abs(q.y)>w*1.05){continue;}
    let dir=normalize(trail.xy+vec2f(0.0001));
    let p=vec2f(-dot(q,dir),dot(q,vec2f(-dir.y,dir.x)))/w;
    if(p.x>0.0 && p.x<0.99 && abs(p.y)<0.41){
      let k=min(1.0,p.x/0.90);
      let curl=p.y-k*(0.065*sin(k*8.0-t*8.0)+0.018*sin(k*17.0+t*7.0));
      let tongues=(0.19+0.042*sin(k*13.0-t*6.0))*(1.0-k)*(1.0-k)+0.032*(1.0-k);
      let wick=0.058*(1.0-k)-abs(curl+0.10+0.035*sin(k*11.0-t*7.0))-max(0.0,p.x-0.7);
      let other=0.047*(1.0-k)-abs(curl-0.10-0.025*sin(k*12.0-t*9.0))-max(0.0,p.x-0.64);
      let ember=0.034-abs(p.x-0.83-0.04*sin(t*8.0))-2.1*abs(curl+0.114);
      let sd=max(max(tongues-abs(curl)-max(0.0,p.x-0.90),ember),max(wick,other))*w*s;
      c=mix(c,INK,fill(sd+min(2.2*s,0.015*w*s)*(1.0-k)));
      c=mix(c,vec3f(0.99,0.20,0.055),fill(sd));
      c=mix(c,vec3f(1.16,0.55,0.075),fill(sd-max(1.0,0.019*w*s)));
      c=mix(c,vec3f(1.3,1.05,0.42),fill((tongues*0.26-abs(curl))*w*s));
    }
    let local=turn(trail.z)*q/w*vec2f(1.0,360.0/128.0)+0.5;
    if(all(local>vec2f(0.0)) && all(local<vec2f(1.0))){
      let ink=textureSampleLevel(cometMap,titleSampler,vec2f(local.x,(card.w+local.y)/12.0),0.0);
      c=mix(c,ink.rgb,ink.a);
    }
  }
  return c;
}

fn unmasked(at: vec2f, unit: f32, pen: f32, t: f32, k: f32, under: vec3f) -> vec3f {
  if (dot(at, at) > 1.6) { return under; }
  let ease1 = smoothstep(0.03, 0.26, k);
  let ease2 = smoothstep(0.46, 0.6, k);
  let ease3 = smoothstep(0.74, 0.9, k);
  let first = mix(1.25, -1.25, ease1 * ease1 * (3.0 - 2.0 * ease1)); // its own face comes off downward
  let second = mix(1.25, -1.25, ease2 * ease2 * (3.0 - 2.0 * ease2)); // the smiley comes off sideways
  let third = mix(1.25, -1.25, ease3 * ease3 * (3.0 - 2.0 * ease3)); // and its own face goes back on from the top
  let disc = (0.985 - length(at)) * unit;
  var below = smiley(at, unit, pen, t);
  below = mix(below, greyFace(at, unit, pen), fill((at.x - second) * unit));
  below = rolled(second - at.x, at.y, second, unit, pen, below);
  below = mix(below, INK, stroke(abs(disc), pen * 1.4));
  let bare = fill((at.y - first) * unit) * fill((third - at.y) * unit) * fill(disc + pen * 1.4);
  var c = mix(under, below, bare);
  c = mix(c, rolled(first - at.y, at.x, first, unit, pen, c), fill(disc + pen * 1.4));
  c = mix(c, rolled(third - at.y, at.x, third, unit, pen, c), fill(disc + pen * 1.4) * step(0.0001, ease3));
  return c;
}

fn roundRect(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn roundBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// The monitor's housing narrows toward the back, like a CRT.
fn monitorHalf(z: f32) -> vec3f {
  let k = mix(0.8, 1.0, smoothstep(-0.44, 0.12, z));
  return vec3f(MON_B.x * k, MON_B.y * k, MON_B.z);
}

// A limb that narrows from ra at a to rb at b.
fn taper(p: vec3f, a: vec3f, b: vec3f, ra: f32, rb: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

const FLOOR = -0.42;

// The terminal as a distance field: distance, then part (1 monitor, 2 neck, 3 base, 4 and 5 its legs).
var<private> droopedEar:vec3f;
fn machine(p: vec3f) -> vec2f {
  let q = p - bodyShift;
  let pm = q - MON_C;
  let well = roundBox(vec3f(pm.xy - GLASS_C, pm.z - MON_B.z), vec3f(GLASS_B, WELL), 0.07);
  var best = vec2f(max(roundBox(pm, monitorHalf(pm.z), 0.055), -well), 1.0);
  let neck = roundBox(q - NECK_C, NECK_B, 0.02);
  if (neck < best.x) { best = vec2f(neck, 2.0); }
  let base = roundBox(q - BASE_C, BASE_B, 0.03);
  if (base < best.x) { best = vec2f(base, 3.0); }
  // Two aerials with a bulb on each.
  var rightRod=capsule(q,vec3f(0.12,1.04,-0.12),droopedEar,0.016);
  if(u.fireDesk.y>0.001){
    let elbow=vec3f(0.215,1.325,-0.152);
    rightRod=min(capsule(q,vec3f(0.12,1.04,-0.12),elbow,0.016),capsule(q,elbow,droopedEar,0.016));
  }
  let ears = min(capsule(q, vec3f(-0.12, 1.04, -0.12), vec3f(-0.36, 1.5, -0.18), 0.016), rightRod);
  if (ears < best.x) { best = vec2f(ears, 7.0); }
  let bulbs = min(length(q - vec3f(-0.36, 1.5, -0.18)), length(q - droopedEar)) - 0.05;
  if (bulbs < best.x) { best = vec2f(bulbs, 9.0); }
  let walk = hoseLegs(p, 0.085, 1.0, true);
  if (walk.x < best.x) { best = walk; }
  return best;
}

fn machineNormal(p: vec3f) -> vec3f {
  let e = vec2f(0.0015, -0.0015);
  return normalize(
    e.xyy * machine(p + e.xyy).x + e.yyx * machine(p + e.yyx).x + e.yxy * machine(p + e.yxy).x + e.xxx * machine(p + e.xxx).x,
  );
}

// For a point on a rounded box: how far along the surface to the nearest edge.
fn edgeDistance(p: vec3f, b: vec3f, r: f32) -> f32 {
  let e = abs(p) - b + r;
  let top = max(e.x, max(e.y, e.z));
  var best = 1e9;
  for (var a = 0; a < 3; a++) {
    if (e[a] >= top) { continue; }
    best = min(best, select(0.785 * r - e[a], r * abs(atan2(e[a], top) - 0.785), e[a] > 0.0));
  }
  return best;
}

// The terminal, drawn like the rest: flat tones by which way a face points,
// and pen lines on silhouettes, edges and fittings. at is the point on the view
// plane in world units, px is pixels per world unit. Returns colour and coverage.
// Where a point of the terminal's world falls on the plane it is seen through.
fn onPlane(p: vec3f) -> vec2f {
  let q = p - TARGET;
  return vec2f(dot(q, u.camRight.xyz), dot(q, u.camUp.xyz));
}
// How far a point of that plane is outside a box seen through it (the box's shadow on the plane, squared off).
fn offBox(at: vec2f, c: vec3f, b: vec3f) -> f32 {
  let e = abs(at - onPlane(c)) - vec2f(dot(abs(u.camRight.xyz), b), dot(abs(u.camUp.xyz), b));
  return max(e.x, e.y);
}
// Whether the ray through this point of the plane passes anywhere near the
// terminal as it stands now (pose first). Seen straight on, a ray misses a
// ball if it passes its middle by more than its radius; so most of the box
// the terminal is drawn in need not be felt through at all.
fn nearTerminal(at: vec2f, slack: f32) -> bool {
  terminalLegs=0u;
  let shellHit=min(min(offBox(at,MON_C+bodyShift,MON_B+0.01),offBox(at,BASE_C+bodyShift,BASE_B+0.01)),offBox(at,NECK_C+bodyShift,NECK_B+0.01))<slack;
  let root = onPlane(bodyShift);
  let rodHit=min(segment(at - root, onPlane(vec3f(-0.12, 1.04, -0.12) + TARGET), onPlane(vec3f(-0.36, 1.5, -0.18) + TARGET)),
          segment(at - root, onPlane(vec3f(0.12, 1.04, -0.12) + TARGET), onPlane(droopedEar + TARGET))) < 0.06 + slack + 0.23*u.fireDesk.y;
  for (var i = 0; i < 6; i++) {
    if (i / 2 == 1) { continue; }
    let ankle = u.legs[12 + i].xyz + vec3f(0.0, 0.25, 0.0);
    let bow = 0.25 * length(u.legs[6 + i].xyz - 0.5 * (u.legs[i].xyz + ankle)); // how far the hose curves off the straight lines through its knee
    let knee = onPlane(u.legs[6 + i].xyz);
    if (min(segment(at,onPlane(u.legs[i].xyz),knee),segment(at,knee,onPlane(ankle)))<0.09+bow+slack ||
        length(at-onPlane(u.legs[12 + i].xyz+vec3f(0.0,0.14,0.06)))<0.37+slack) {terminalLegs|=1u<<u32(i);}
  }
  return shellHit || rodHit || terminalLegs!=0u;
}

// A soft puff of smoke, q inside the unit circle.
fn smokeCurl(q:vec2f, units:f32, steam:f32) -> vec4f {
  let r=length(q);
  let n=0.62*noise(q*2.3+vec2f(0.0,-u.frame.z*0.8))+0.38*noise(q*5.1+3.0-vec2f(0.0,u.frame.z*1.3));
  let a=(1.0-smoothstep(0.2,1.0,r))*smoothstep(0.22,0.72,n);
  let color=mix(mix(vec3f(0.16,0.14,0.16),vec3f(0.36,0.33,0.36),n),vec3f(0.82,0.86,0.88),steam);
  return vec4f(color, a*0.85);
}

// Blackbody-ish emission for a temperature 0 (cold) to 1 (white hot), HDR.
fn fireHeat(T: f32) -> vec3f {
  let r=smoothstep(0.05,0.6,T);
  return vec3f(1.5*r, 0.06*r+1.1*smoothstep(0.42,1.0,T), 0.75*smoothstep(0.78,1.3,T));
}

fn fireFbm(p0: vec2f, octaves: i32) -> f32 {
  var p=p0; var a=0.5; var sum=0.0;
  for(var i=0;i<octaves;i++){ sum+=a*noise(p); p=mat2x2f(1.6,1.2,-1.2,1.6)*p+vec2f(3.1,7.7); a*=0.5; }
  return sum;
}

// One frame of a flipbook in art/fire.png, cross-faded into the next so it plays
// smoothly at any rate. uv is across and down the frame; channel 0 is the flame's
// heat (60 frames), 1 the smoke's density (64). Stored as square roots.
fn flipbook(uv: vec2f, frame: f32, count: f32, channel: u32) -> f32 {
  let f=floor(frame); let k=frame-f;
  let a=f-count*floor(f/count); let b=select(a+1.0,0.0,a+1.0>=count);
  let at=clamp(uv,vec2f(0.01),vec2f(0.99))/8.0;
  let sa=textureSampleLevel(fireMap,titleSampler,at+vec2f(a%8.0,floor(a/8.0))/8.0,0.0)[channel];
  let sb=textureSampleLevel(fireMap,titleSampler,at+vec2f(b%8.0,floor(b/8.0))/8.0,0.0)[channel];
  return mix(sa*sa,sb*sb,k);
}

// What a flame's heat looks like: deep red where it is thin, orange through the
// body, yellow to white in the core, which goes past 1 so the lens blooms it.
fn flameRamp(e: f32) -> vec3f {
  return vec3f(1.75*smoothstep(0.0,0.45,e), 1.2*smoothstep(0.3,1.08,e)*(0.25+0.75*e), 0.9*pow(smoothstep(0.72,1.1,e),2.0));
}

fn terminal(at: vec2f, px: f32, pen: f32, still: vec2f, t: f32) -> vec4f {
  let back = u.camBack.xyz;
  let origin = TARGET + u.camRight.xyz * at.x + u.camUp.xyz * at.y + back * 4.0;
  // It walks: the body rides on six legs whose feet keep to the ground going by.
  bodyShift = vec3f(0.02 * sin(u.machine.w * TAU), u.gait.z, 0.0); // it shifts its weight from one set of feet to the other
  bodyRoll = 0.0;
  bodyPivot = 0.0;
  // (Its legs are posed once a frame, by poseTerminal.)
  var travelled = 0.0;
  var previous = 1e9;
  var graze = 1e9; // the closest the ray came to something it then passed
  var part = 0.0;
  droopedEar=vec3f(0.30+0.31*u.fireDesk.y,1.58-0.22*u.fireDesk.y,-0.18);
  let steps = select(0, 80, nearTerminal(at, 2.5 * pen / px + 0.012));
  for (var i = 0; i < steps; i++) {
    let m = machine(origin - back * travelled);
    if (m.x < 0.0012) { part = m.y; break; }
    if (m.x > previous) { graze = min(graze, previous); }
    previous = m.x;
    travelled += m.x * 0.8;
    if (travelled > 8.0) { break; }
  }
  let outline = stroke(abs(graze * px - pen), pen);
  if (part == 0.0) {
    // Missed: a soft shadow where the ray meets the ground under the base.
    let ground = origin - back * ((origin.y - FLOOR) / back.y);
    let shadow = roundRect(ground.xz - BASE_C.xz - vec2f(0.1, -0.06), BASE_B.xz + 0.05, 0.3);
    var dark = 0.3 * fill(-shadow * px);
    var dust = 0.0;
    for (var i = 0; i < 6; i++) {
      // Each foot has its own small shadow, fainter the higher it is lifted,
      // and puts up a ring of dust when it comes down.
      if (i / 2 == 1) { continue; }
      let foot = u.legs[12 + i].xyz;
      let off = length((ground.xz - foot.xz - vec2f(0.0, 0.08)) * vec2f(1.0, 0.7));
      dark = max(dark, 0.5 * (1.0 - smoothstep(0.17, 0.33, off)) * (1.0 - clamp((foot.y - FLOOR) * 5.0, 0.0, 1.0)));
      let g = fract(u.machine.w + select(0.0, 0.5, (i + i / 2) % 2 == 0));
      let age = g / 0.2;
      if (age < 1.0) { dust = max(dust, (1.0 - age) * stroke(abs(off - 0.2 - 0.4 * (1.0 - (1.0 - age) * (1.0 - age))) * px * 0.5, pen * 0.45)); }
    }
    return vec4f(mix(INK, PAPER, dust * (1.0 - outline)), max(max(outline, dark), 0.75 * dust));
  }

  let hitAt = origin - back * travelled;
  let n = machineNormal(hitAt);
  let p = hitAt - bodyShift;
  let lit = dot(n, normalize(vec3f(-0.45, 0.8, 0.4)));
  var tone = mix(CASE_SHADE, CASE_MID, smoothstep(0.06, 0.12, lit));
  tone = mix(tone, CASE_LIGHT, smoothstep(0.58, 0.64, lit));
  var ink = outline;

  if (part >= 10.0) {
    let leg = legColor(hitAt, part, lit, px, pen, 0.085, 1.0, true);
    return vec4f(mix(leg.rgb * (0.972 + 0.05 * noise(still * 2.3)), INK, max(ink, leg.a)), 1.0);
  }
  if (part == 5.0) {
    // Joints of dark rubber with a hard glint.
    var rubber = mix(${vec3('#231a33')}, ${vec3('#59457e')}, smoothstep(0.0, 0.08, lit));
    rubber = mix(rubber, ${vec3('#b9a4ee')}, smoothstep(0.6, 0.66, lit));
    rubber = mix(rubber, vec3f(1.9), smoothstep(0.9, 0.94, lit));
    return vec4f(mix(rubber * (0.972 + 0.05 * noise(still * 2.3)), INK, ink), 1.0);
  }
  if (part == 4.0) {
    // Thighs of the same plastic as the case.
    return vec4f(mix(tone * (0.972 + 0.05 * noise(still * 2.3)), INK, ink), 1.0);
  }
  if (part == 7.0) {
    // Shins and aerials of dark metal.
    var metal = mix(${vec3('#33284e')}, ${vec3('#7a66b4')}, smoothstep(0.02, 0.1, lit));
    metal = mix(metal, ${vec3('#cdbdf5')}, smoothstep(0.62, 0.68, lit));
    return vec4f(mix(metal * (0.972 + 0.05 * noise(still * 2.3)), INK, ink), 1.0);
  }
  if (part == 9.0) {
    // The bulbs on its aerials take turns to light.
    let lit0 = step(0.0, p.x) * step(0.5, fract(t * 0.8)) + step(p.x, 0.0) * step(fract(t * 0.8), 0.5);
    return vec4f(mix(mix(${vec3('#8c1f1c')}, RED * 2.4 + vec3f(0.5, 0.3, 0.1), lit0), INK, ink), 1.0);
  }

  if (part == 1.0) {
    let pm = p - MON_C;
    let damage=u.fireDesk.y;
    if(damage>0.001){
      let ventCorner=pm-vec3f(0.42,0.22,0.25);
      let grain=noise(pm.xy*26.0+pm.z*14.0);
      let smudge=length(ventCorner*vec3f(1.1,1.2,0.61));
      let soot=damage*(1.0-smoothstep(0.045,0.48,smudge+0.045*grain));
      tone=mix(tone,mix(vec3f(0.25,0.14,0.18),INK,grain),0.91*soot);
      // A buckle in the thin metal rim: opposing shadow and sliver of light.
      let dent=pm.xy-vec2f(0.37,0.26);
      let nick=abs(dent.y+0.48*dent.x-0.27*abs(dent.x))*px;
      let crease=stroke(nick,pen*0.72)*damage*(1.0-smoothstep(0.012,0.13,length(dent)))*max(n.z,0.0);
      tone=mix(tone,INK,crease);
    }
    ink = max(ink, stroke(edgeDistance(pm, monitorHalf(pm.z), 0.055) * px, pen));
    let g = pm.xy - GLASS_C;
    let well = roundRect(g, GLASS_B, 0.07);
    if (pm.z > MON_B.z - 0.006) {
      // The bezel: rim of the well, two knobs, a name plate.
      ink = max(ink, stroke(abs(well) * px, pen) * step(0.5, n.z));
      let knob = min(length(pm.xy - vec2f(0.3, -0.333)), length(pm.xy - vec2f(0.4, -0.333))) - 0.03;
      tone = mix(tone, CASE_SHADE, fill(-knob * px) * step(0.5, n.z));
      ink = max(ink, stroke(abs(knob) * px, pen * 0.7) * step(0.5, n.z));
      let plate = roundRect(pm.xy - vec2f(-0.31, -0.333), vec2f(0.12, 0.024), 0.012);
      tone = mix(tone, mix(CASE_MID, CASE_SHADE, 0.6), fill(-plate * px) * step(0.5, n.z));
      ink = max(ink, stroke(abs(plate) * px, pen * 0.6) * step(0.5, n.z));
    } else if (well < 0.0 && pm.z > MON_B.z - WELL - 0.02) {
      // Inside the well: shaded walls, then the glass.
      let glass = well + 0.035;
      var uv = g / GLASS_B;
      if(damage>0.001 && u.fireDesk.z<1.7){
        let roll=fract(u.fireDesk.z*1.6)*2.8-1.4;
        let shear=(1.0-smoothstep(0.11,0.23,abs(uv.y-roll)))*exp(-2.65*u.fireDesk.z);
        uv.x+=0.42*shear*sin(u.fireDesk.z*23.0); uv.y-=0.25*shear;
      }
      var screen = vec3f(0.045, 0.075, 0.055) + vec3f(0.03, 0.12, 0.06) * (1.0 - 0.6 * dot(uv, uv));
      // Slow green rings drift across the tube behind the prompt.
      let rings = sin(length(uv * vec2f(1.4, 1.0) - 0.5 * vec2f(sin(t * 0.31), cos(t * 0.23))) * 9.0 - t * 1.1);
      screen += vec3f(0.01, 0.07, 0.03) * smoothstep(0.2, 0.9, rings);
      screen = written(screen, uv, px, pen, t);
      // Its face comes up when the sun roars, lightning lands or the planet takes someone.
      let fright = max(max(u.mood.y, 1.0 - smoothstep(0.5, 1.3, u.weather.y)), select(0.0, u.cosmos.w * (0.35 + 0.65 * u.chorusBeat.y), cosmosLive)); // (and sings in the chorus)
      // And when the pointer comes close it looks to see who is there.
      let curious = 1.0 - smoothstep(0.75, 1.25, length((u.pointer.xy - u.machine.xy - vec2f(0.0, -0.2 * u.machine.z)) / u.machine.z));
      let awe = max(u.lift.z, curious);
      if (max(fright, awe) > 0.01) {
        var what = u.sun.xy;
        if (u.lift.z > fright) { what = mix(u.planet.xy, u.lift.xy, 0.5 + 0.5 * sin(t * 2.6)); } else if (curious > fright) { what = u.pointer.xy; }
        let gaze = normalize((what - u.machine.xy) * vec2f(1.0, -1.0) + vec2f(0.0001, 0.0));
        screen = mix(screen, startled(screen, uv, px, pen, t, fright, gaze), smoothstep(0.0, 0.2, max(fright, awe)));
      }
      screen *= 0.9 + 0.1 * sin(g.y * 300.0);
      screen += vec3f(0.07, 0.1, 0.08) * smoothstep(0.35, 0.0, abs(uv.x + uv.y * 0.7 + 1.05));
      if(damage>0.001){
        let pane=g/GLASS_B;
        let line0=abs(pane.y-(0.34*pane.x+0.19-0.105*abs(sin(12.0*pane.x+0.4))-0.08*abs(sin(4.3*pane.x))));
        let fork=abs(pane.y-(0.35+1.18*(pane.x-0.38)+0.055*sin(22.0*pane.x)));
        let branch=min(line0,max(fork,max(0.44-pane.x,pane.x-0.80)))*GLASS_B.y*px;
        let wake=smoothstep(0.0,0.12,pane.x-0.97+2.30*damage);
        let crack=stroke(branch,pen*0.44)*wake;
        screen=mix(screen,mix(SEA,PAPER,0.72),crack*min(0.89,damage*3.1));
      }
      screen *= 0.97 + 0.03 * sin(t * 6.0);
      tone = mix(mix(CASE_SHADE, INK, 0.35), screen, fill(-glass * px));
      ink = max(ink, stroke(abs(glass) * px, pen * 0.85));
    }
    if (n.x > 0.5) {
      // Vents on the side.
      let side = vec2f(pm.z, pm.y);
      var vent = 1e9;
      for (var i = 0; i < 4; i++) {
        let y = 0.14 - f32(i) * 0.08;
        vent = min(vent, segment(side, vec2f(-0.27, y), vec2f(0.03, y)));
      }
      ink = max(ink, 0.8 * stroke(vent * px, pen * 0.7));
    }
  } else if (part == 2.0) {
    tone = mix(tone, CASE_SHADE, 0.55);
    ink = max(ink, stroke(edgeDistance(p - NECK_C, NECK_B, 0.02) * px, pen));
  } else {
    let pb = p - BASE_C;
    ink = max(ink, stroke(edgeDistance(pb, BASE_B, 0.03) * px, pen));
    if (n.z > 0.5) {
      // Drive slot, a light, and vents on the front.
      let slot = roundRect(pb.xy - vec2f(0.38, 0.0), vec2f(0.15, 0.014), 0.012);
      ink = max(ink, fill(-slot * px));
      let lamp = length(pb.xy - vec2f(0.15, 0.0)) - 0.017;
      tone = mix(tone, RED, fill(-lamp * px));
      ink = max(ink, stroke(abs(lamp) * px, pen * 0.6));
      var vent = 1e9;
      for (var i = 0; i < 3; i++) {
        let y = 0.03 - f32(i) * 0.03;
        vent = min(vent, segment(pb.xy, vec2f(-0.6, y), vec2f(-0.4, y)));
      }
      ink = max(ink, 0.8 * stroke(vent * px, pen * 0.7));
    }
    if (n.y > 0.5) {
      // The monitor's shadow on the base.
      let shadow = roundRect(pb.xz - vec2f(0.06, -0.1), vec2f(0.5, 0.42), 0.1);
      tone = mix(tone, CASE_MID, 0.8 * fill(-shadow * px));
    }
  }
  return vec4f(mix(tone * (0.972 + 0.05 * noise(still * 2.3)), INK, ink), 1.0);
}

// The terminal in a pass of its own, over a rectangle round it, so that the
// picture's big function need not carry it: the picture reads deskMap instead.
@fragment fn drawDesk(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let scale = u.frame.x / u.frame.w;
  var d = (position.xy + u.deskStamp.xy) / scale;
  if (takeoverLive && u.boss.x>0.0 && u.boss.y>0.0) { d.x+=takeoverBand(d.y).y; }
  let deskAt = (d - u.machine.xy) / u.machine.z * vec2f(1.0, -1.0);
  return terminal(deskAt, u.machine.z * scale, u.look.z * scale * 0.5, d, u.frame.z);
}

// The little walkers in a pass of their own, one draw for each over its tile of
// the atlas: what mini() sees there, for the picture's walker loop to read.
struct WalkerAt { @builtin(position) position: vec4f, @location(0) @interpolate(flat) who: u32 }
@vertex fn walkerVertex(@builtin(vertex_index) i: u32, @builtin(instance_index) who: u32) -> WalkerAt {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return WalkerAt(vec4f(corners[i], 0.0, 1.0), who);
}
struct WalkerPrint { @location(0) seen: vec4f, @location(1) ink: vec4f }
@fragment fn drawWalker(v: WalkerAt) -> WalkerPrint {
  let scale = u.frame.x / u.frame.w;
  var d = (v.position.xy - u.walkerTile[v.who].xy) / scale;
  if (takeoverLive && u.boss.x>0.0 && u.boss.y>0.0) { d.x+=takeoverBand(d.y).y; }
  legRig = v.who;
  let seen = mini(eyeAt(), eyeRay(d), u.critters[v.who], u.critterHows[v.who], scale, u.look.z * scale * 0.5, u.frame.z, d);
  return WalkerPrint(vec4f(seen.color, seen.far), vec4f(seen.ink, seen.edge, 0.0, 0.0));
}

// The village's buildings in the same pass, into the same atlas, one draw for each.
@fragment fn drawWorks(v: WalkerAt) -> WalkerPrint {
  let scale = u.frame.x / u.frame.w;
  var d = (v.position.xy - u.villageTile[v.who].xy) / scale;
  if (takeoverLive && u.boss.x>0.0 && u.boss.y>0.0) { d.x+=takeoverBand(d.y).y; }
  let seen = works(eyeAt(), eyeRay(d), u.sites[v.who], u.fireSites[v.who/4u][v.who%4u], scale, u.look.z * scale * 0.5, u.frame.z, d);
  return WalkerPrint(vec4f(seen.color, seen.far), vec4f(seen.ink, seen.edge, 0.0, 0.0));
}

// Where the lettering is read from for a point of the picture.
fn titleAt(d: vec2f, t: f32) -> vec2f {
  // A slow wave travels along the word, under a finer shimmer.
  let waver = 1.7 * vec2f(sin(d.y * 0.021 + t * 0.5), sin(d.x * 0.013 - t * 0.4)) + vec2f(0.0, 7.0 * sin(d.x * 0.0058 - t * 1.2));
  // It is jelly: it swells under the pointer, and shudders when the sun roars.
  let reach = d - u.pointer.xy;
  let bulge = -reach * 0.4 * exp(-dot(reach, reach) / 8000.0);
  let shudder = u.mood.y * 3.5 * vec2f(sin(t * 47.0 + d.y * 0.06), cos(t * 39.0 + d.x * 0.05));
  let throb = (u.title.xy + 0.5 * u.title.zw - d) * 0.045 * u.chorusBeat.z * u.chorusBeat.y; // it sings too
  return d + waver + bulge + shudder + select(vec2f(0.0), throb, cosmosLive);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {

  let scale = u.frame.x / u.frame.w; // pixels per design unit
  var d = position.xy / scale;
  var tape=vec2f(0.0);
  if (takeoverLive && u.boss.x>0.0) {
    tape=takeoverBand(d.y);
    if (u.boss.y>0.0){d.x+=tape.y;daxBand=tape.x>0.5;}
  }
  let t = u.frame.z;
  let pen = u.look.z * scale * 0.5;

  // When day and night change over the sun and the moon ride one wheel: one goes
  // down the right of the sky as the other comes up the left, and each rolls with it.
  var sunNow = u.sun.xy + vec2f(0.0, u.sky.z);
  let wheel = abs(u.orb.y);
  var roll = 0.0;
  var sunIs = sunNow;  // where the sun is and where the moon is, for the light
  var moonIs = sunNow;
  orbMoon = u.orb.x;
  if (wheel > 0.0) {
    // (A tighter wheel on a narrow page, so that both are still in the picture as they pass.)
    let swing = mix(1.75, 1.13, smoothstep(600.0, 1440.0, u.frame.w));
    let arm = 520.0 / (1.0 - cos(swing));
    let goingOut = swing * wheel;
    let comingIn = -swing * (1.0 - wheel);
    let leaving = sunNow + arm * vec2f(sin(goingOut), 1.0 - cos(goingOut));
    let arriving = sunNow + arm * vec2f(sin(comingIn), 1.0 - cos(comingIn));
    let newcomer = dot(d - arriving, d - arriving) < dot(d - leaving, d - leaving);
    let toNight = u.orb.y > 0.0;
    sunNow = select(leaving, arriving, newcomer);
    roll = select(goingOut, comingIn, newcomer);
    orbMoon = select(0.0, 1.0, newcomer == toNight);
    sunIs = select(arriving, leaving, toNight);
    moonIs = select(leaving, arriving, toNight);
  }
  let rain = u.weather.x;
  let height = u.dye.z;

  // Below the far edge of the land nothing of the sky or the sun can be seen: the land is drawn over all of it.
  let buried = (u.look.w - (height - d.y)) * scale >= 0.7;
  var color = vec3f(0.0);
  var soft = 0.0; // how far out of focus this part of the picture is, for the lens
  // Night closes in on the setting sun from the moon's side of the picture, and
  // daylight spreads back out from the rising one.
  var nightHere = u.orb.z;
  if (wheel > 0.0) {
    // Night comes across the picture from the moon's side as it climbs.
    let side = (length(d - sunIs) - length(d - moonIs)) / max(length(sunIs - moonIs), 1.0);
    nightHere = smoothstep(-0.55, 0.55, side + (2.0 * u.orb.z - 1.0) * 1.6);
  }
  let rise = height - d.y;
  let eye = eyeAt();
  // The lettering lies over everything. It is found first, and under the solid
  // part of its black shape nothing else is drawn at all.
  var lettered = false;
  if (u.title.z > 0.0) {
    let inkUv = (titleAt(d, t) - u.title.xy) / u.title.zw;
    if (inkUv.x > 0.0 && inkUv.x < 1.0 && inkUv.y > 0.0 && inkUv.y < 1.0) {
      lettered = (titleField(inkUv).z + 1.2 * sin(t * 0.45 + d.x * 0.008)) * u.title.z / u.titleSize.x * scale >= 0.7;
    }
  }
  // The terminal stands in front of the sky, the sun and the whole valley. It is
  // worked out next, and where it is solid none of what is behind it is drawn.
  var desk = vec4f(0.0);
  var deskAt = vec2f(0.0);
  var onDesk = false;
  var deskShift = vec3f(0.0);
  if (u.machine.z > 0.0) {
    deskAt = (d - u.machine.xy) / u.machine.z * vec2f(1.0, -1.0);
    onDesk = abs(deskAt.x) < 2.3 && deskAt.y > -1.15 && deskAt.y < 1.3 + u.gait.w;
    if (onDesk && !lettered) {
      desk = textureLoad(deskMap, vec2i(position.xy - u.deskStamp.xy), 0); // (drawn by drawDesk)
      deskShift = vec3f(0.02 * sin(u.machine.w * TAU), u.gait.z, 0.0); // how the terminal's body rides on its legs
    }
  }
  if (desk.a < 1.0 && !lettered) {
  if (!buried) { if (takeoverLive) { color = heavens(d, scale, pen); } else { color = textureLoad(skyMap, vec2i(position.xy), 0).rgb; } }
  let unfold = u.misc.w;
  if (unfold > 0.001 && u.sun.z > 0.0) {
    let open = smoothstep(0.0, 0.36, unfold) * (1.0 - smoothstep(0.62, 1.0, unfold));
    let delta = d - sunNow;
    let reach = u.sun.z * (0.54 + 6.8 * open) + 3.0;
    if (dot(delta, delta) < reach * reach) {
      color = paperRosette(delta, scale, pen, unfold, open, color);
    }
  }
  // Stars come out in the dark (the cosmos brings its own).
  let starry = select(nightHere, nightHere * (1.0 - u.cosmos.x), cosmosLive);
  if (starry > 0.0 && !buried) {
    let cell = floor(d / 26.0);
    let star = length(d - (cell + 0.2 + 0.6 * vec2f(hash(cell), hash(cell + 7.7))) * 26.0);
    let size = (0.7 + 1.6 * hash(cell + 2.9)) * (0.75 + 0.25 * sin(t * (1.0 + 2.0 * hash(cell + 4.1)) + hash(cell) * TAU));
    color = mix(color, LAMP * vec3f(1.7), starry * fill((size - star) * scale) * step(0.74, hash(cell + 5.5)));
    // The signs of the last things that happened are written in the stars.
    for (var k = 0; k < 3; k++) {
      let n = f32(k);
      let size = 84.0 + 14.0 * n;
      let home = vec2f(u.frame.w * (0.1 + 0.4 * n * (1.9 - 0.9 * n)), height * (0.5 - 0.17 * n * (2.0 - n))) + vec2f(4.0 * sin(t * 0.2 + n), 0.0);
      let q = (d - home) / size * vec2f(0.66, -1.0) + vec2f(0.5, 0.5);
      if (q.x < -0.2 || q.x > 1.2 || q.y < -0.2 || q.y > 1.2) { continue; }
      let sign = u.script[k + 1].w * 100.0;
      let seen = starry * step(0.001, u.script[k + 1].w) * (0.6 + 0.4 * sin(t * 0.7 + n * 2.0));
      color = mix(color, LAMP * vec3f(1.0, 1.25, 1.5), 0.55 * seen * stroke(rune(q, sign) * size * scale, pen * 0.3));
      let knot = round(q / vec2f(0.5, 0.3333)) * vec2f(0.5, 0.3333);
      let twinkle = 1.6 + 1.0 * sin(t * 2.0 + knot.x * 9.0 + knot.y * 5.0 + n);
      color = mix(color, LAMP * vec3f(2.2), seen * fill((twinkle - length(q - knot) * size) * scale) * step(abs(knot.x - 0.5), 0.6) * step(abs(knot.y - 0.5), 0.6));
    }
    // Now and then a star falls.
    let fall = t / 6.5;
    let which = floor(fall);
    let life = fract(fall) / 0.12;
    if (life < 1.0) {
      let began = vec2f(u.frame.w * (0.1 + 0.8 * hash(vec2f(which, 1.0))), height * (0.04 + 0.3 * hash(vec2f(which, 2.0))));
      let way = normalize(vec2f(select(-1.0, 1.0, hash(vec2f(which, 3.0)) > 0.5), 0.5));
      let head = began + way * 330.0 * life;
      let back = dot(head - d, way);
      let taper = 1.0 - clamp(back / 120.0, 0.0, 1.0);
      let off = length(d - head + way * clamp(back, 0.0, 120.0));
      color = mix(color, LAMP * vec3f(2.4, 2.4, 2.8), starry * (1.0 - life * life) * taper * fill((0.4 + 1.8 * taper - off) * scale));
    }
  }

  if (u.planet.z > 0.0) {
    let at = (d - u.planet.xy - vec2f(0.0, 3.0 * sin(t * 0.45))) / u.planet.z * vec2f(1.0, -1.0);
    if (dot(at, at) < 6.0) {
      color = planet(at, u.planet.z * scale, pen, d, t, color);
    }
  }

  // The sun, in front of the liquid it gives off and behind the hills.
  if (u.sun.z > 0.0 && !buried) {
    // It swells toward you as it roars.
    let swell = 1.0 + 0.13 * u.mood.y * u.mood.y * (3.0 - 2.0 * u.mood.y);
    let upright = (d - sunNow) / (u.sun.z * swell) * vec2f(1.0, -1.0);
    let at = vec2f(upright.x * cos(roll) - upright.y * sin(roll), upright.x * sin(roll) + upright.y * cos(roll));
    if (dot(at, at) < 13.0) {
      if(takeoverLive && tape.x>0.5) {
        let shake=select(tape.y/u.sun.z,0.0,u.boss.y>0.0);
        color=bossed(at+vec2f(shake,0.0),u.sun.z*swell*scale,t,color);
      } else {
        var lit: vec4f;
        if (takeoverLive) { lit = sun(at, u.sun.z * swell * scale, pen, d, t); } else { lit = textureLoad(sunMap, vec2i(position.xy - u.sunStamp.xy), 0); }
        color = color * lit.a + lit.rgb;
        if (u.spare[1].x > 0.0) { color = unmasked(at, u.sun.z * swell * scale, pen, t, u.spare[1].x, color); }
      }
    }
  }

  // After the rain, a rainbow draws itself across the sky from left to right.
  if (u.sky.x > 0.0) {
    let foot = vec2f(u.frame.w * 0.5, height - 60.0);
    let arc = d - foot;
    let span = min(u.frame.w * 0.44, height * 0.72);
    let band = (span - length(arc)) / 17.0;
    let drawn = fill((u.sky.x * 3.3 - 0.1 - (atan2(-arc.y, -arc.x) + 0.0)) * length(arc) * scale);
    if (band > -0.5 && band < 6.5 && arc.y < 0.0) {
      let index = clamp(i32(floor(band)), 0, 5);
      let across = fract(band);
      var tone = K_BOW_0[index] * (0.72 + 0.4 * smoothstep(0.0, 0.5, across) * (1.0 - smoothstep(0.5, 1.0, across) * 0.6));
      tone += vec3f(1.3, 1.25, 1.1) * stroke(abs(across - 0.3) * 17.0 * scale, 0.9 * scale) * 0.55;
      let inBow = fill(band * 17.0 * scale) * fill((6.0 - band) * 17.0 * scale) * drawn;
      color = mix(color, tone * (0.972 + 0.05 * noise(d * 2.3)), inBow);
      color = mix(color, INK, drawn * stroke(abs(band - round(band)) * 17.0 * scale, pen) * step(-0.25, band) * step(band, 6.25));
    }
  }

  // By day a skein of birds crosses the sky, one way and then the other.
  let sweep = t / 34.0 + 0.35;
  let flight = fract(sweep) / 0.6;
  if (flight < 1.0 && u.orb.z < 0.9) {
    let way = select(-1.0, 1.0, i32(floor(sweep)) % 2 == 0);
    let lead = vec2f(mix(-90.0, u.frame.w + 90.0, select(1.0 - flight, flight, way > 0.0)), height - u.look.w - 150.0 - 40.0 * sin(flight * 5.0) - 40.0 * hash(vec2f(floor(sweep), 3.0)));
    for (var i = 0; i < 7; i++) {
      let row = f32((i + 1) / 2);
      let wingSide = select(-1.0, 1.0, i % 2 == 0);
      let at = d - lead - vec2f(-way * row * 21.0, wingSide * row * 10.0 + 3.0 * sin(t * 1.3 + f32(i)));
      if (abs(at.x) > 13.0 || abs(at.y) > 9.0) { continue; }
      let flap = sin(t * 7.0 + f32(i) * 1.7);
      let m = vec2f(abs(at.x), at.y);
      let elbow = vec2f(5.0, -2.0 - 3.0 * flap);
      let wing = min(segment(m, vec2f(0.0), elbow), segment(m, elbow, vec2f(10.0, -1.0 + 2.5 * flap)));
      color = mix(color, INK, (1.0 - u.orb.z) * stroke(wing * scale, pen * 0.85));
    }
  }

  // Far mountains, and under them the land: a river valley the picture flies up for ever.
  let ray = eyeRay(d);
  var soilHit=false; var waterHit=false;
  var landFar = 1e9; // how far off whatever is drawn here is
  if (rise < u.look.w + 30.0) {
    let peaks = u.look.w + 9.0 + 9.0 * sin(d.x * 0.011 + u.world.x * 0.02 + 1.0) + 5.0 * sin(d.x * 0.029 - u.world.x * 0.03) + 2.0 * sin(d.x * 0.071);
    let range = (peaks - rise) * scale;
    color = mix(color, paint(HAZE_FAR, HAZE_FAR, d, d, 80.0), fill(range));
    color = mix(color, INK, stroke(abs(range), pen));
    soft = 0.6 * fill(range);
  }
  var viperReceiver = -1.0; // how far off the land is here, where it is the land that is seen
  // What stands on the land: the village, then only the terrain that can occlude it.
  var penDepth = 1e9;
  var landPen = 0.0;
  if (all(d >= u.villageBand.xy) && all(d <= u.villageBand.zw)) {
    for (var i = 0; i < 8; i++) {
      let box = u.villageBounds[i];
      if (u.sites[i].z <= 0.0 || any(d < box.xy) || any(d > box.zw)) { continue; }
      let texel = vec2i(position.xy + u.villageTile[i].xy);
      let lit = textureLoad(walkerMap, texel, 0); // (drawn by drawWorks)
      let inked = textureLoad(walkerInk, texel, 0);
      let seen = Seen(lit.rgb, lit.w, inked.x, inked.y);
      if (seen.far > 0.0 && seen.far < landFar) {
        color = seen.color; soilHit=false; waterHit=false;
        landFar = seen.far;
      } else if (seen.ink > 0.0 && seen.edge < penDepth) {
        penDepth = seen.edge;
        landPen = seen.ink;
      }
    }
  }
  if (rise < u.look.w + 1.0 && (landFar >= 1e8 || eye.y + min(0.0,ray.y)*landFar < 3.35)) {
    let hit = landAt(eye, ray, u.world.w * scale, min(FAR,landFar+0.07));
    let pool = (EYE - u.world.z) / max(-ray.y, 1e-4);
    var tone = HAZE;
    if (hit.x > 0.0 && hit.x < min(pool,landFar)) {
      tone = landColor(eye + ray * hit.x, hit.x, d, scale, pen);
      landFar = hit.x; soilHit=true;
      viperReceiver = hit.x;
    } else if (pool < min(FAR,landFar)) {
      tone = waterColor(eye + ray * pool, pool, d, scale, pen, t, sunNow.x); waterHit=true;
      landFar = pool;
    }
    else if (landFar < 1e8) { tone = color; }
    // A pen line along every ridge the ray skimmed over.
    tone = mix(tone, INK, stroke(abs(hit.y - pen), pen) * step(hit.z, min(landFar, pool)) * (1.0 - smoothstep(60.0, 170.0, hit.z)));
    color = mix(color, tone, fill((u.look.w - rise) * scale));
  }

  if (penDepth < landFar) { color = mix(color,INK,landPen); }
  if (rise < u.look.w + 70.0) {
    for (var i = 0; i < 8; i++) {
      let box = u.walkerBox[i];
      if (any(position.xy < box.xy) || any(position.xy >= box.zw)) { continue; } // (its ray misses it)
      let texel = vec2i(position.xy + u.walkerTile[i].xy);
      let lit = textureLoad(walkerMap, texel, 0); // (drawn by drawWalker)
      let inked = textureLoad(walkerInk, texel, 0);
      let seen = Seen(lit.rgb, lit.w, inked.x, inked.y);
      if (seen.far > 0.0 && seen.far < landFar) {
        color = seen.color; soilHit=false; waterHit=false;
        landFar = seen.far;
      } else if (seen.edge < landFar) {
        color = mix(color, INK, seen.ink);
      }
    }
  }

  if(u.fireDesk.x>0.0 && all(d>=u.fireBox.xy) && all(d<=u.fireBox.zw)) {
    let tile=min(vec2u(7),vec2u(8.0*d/vec2f(u.frame.w,height)));
    let id=8u*tile.y+tile.x;
    var bits=u32(u.fireGrid[id/4u][id%4u]);
    if(bits!=0u){
      let zHit=ray.z*landFar;
      let surface=eye+ray*landFar;
      var light=0.0; var bed=0.0; var smoulder=0.0; var shine=0.0;
      var plate=vec4f(0.0); var flameDepth=landFar;
      var fume=vec4f(0.0); // the smoke, premultiplied, under the flames
      let atlas=textureDimensions(fireMap).x>8u;
      let airTint=mix(vec3f(0.9,0.38,0.09),LAMP*vec3f(0.9,0.38,0.09),u.orb.z)*(0.035+1.0*u.orb.z);
      while(bits!=0u){
        let i=firstTrailingBit(bits); bits=bits&(bits-1u);
        let base=u.fireBase[i]; let life=u.fireLife[i]; let draw=u.fireDraw[i];
        let flick=0.82+0.09*sin(t*7.3+life.w*40.0)+0.06*sin(t*13.1+life.w*17.0)+0.05*sin(t*2.9+life.w*5.0);
        let off=surface-base.xyz;
        if(all(abs(off.xz)<vec2f(base.w+2.6)) && abs(off.y)<4.1){
          let r=length(off.xz); let dist=length(off*vec3f(1.0,0.75,1.0));
          light=max(light,life.x*flick*(1.0-smoothstep(base.w*0.3,base.w+2.6,dist)));
          if(soilHit && r<base.w+0.3 && surface.y>u.world.z+0.10){
            let grain=noise(surface.xz*4.1);
            let scar=base.w-r+0.34*(grain-0.5)+0.13*sin(surface.z*7.0+surface.x*3.7);
            let edge=smoothstep(-0.05,0.09,scar);
            bed=max(bed,life.z*edge);
            let rim=1.0-smoothstep(0.0,0.45,abs(scar-0.1));
            smoulder=max(smoulder,edge*(life.x*(0.4+0.6*rim)+0.32*life.y));
          }
        }
        if(waterHit && life.x>0.01){
          let dz=base.z-surface.z;
          if(dz>-0.6 && dz<10.0 && abs(surface.x-base.x)<base.w+3.0){
            let ripple=noise(vec2f(surface.x*3.0,surface.z*12.0-t*2.2));
            shine+=life.x*flick*exp(-pow((surface.x-base.x)/(0.45+0.3*base.w+0.07*dz),2.0))*(1.0-smoothstep(0.0,10.0,dz))*smoothstep(0.3,0.75,ripple);
          }
        }
        if(draw.w>=zHit+0.04 || max(life.x,life.y)<0.001 || !atlas) {continue;}
        let form=u.fireForm[i];
        let rel=(d-draw.xy)*vec2f(1.0,-1.0)/draw.z;
        let R=base.w; let H=form.y;
        if(rel.y < -(2.25*H+0.5*R) || rel.y > max(7.5*H,4.5*H+0.5*R) || rel.x < -(2.95*H+0.6*R) || rel.x > 3.5*H+0.6*R) {continue;}
        let front=smoothstep(-0.04,0.02,zHit-draw.w);
        let tall=H*3.2*(0.45+0.55*life.x);
        // The air round it glows, to nothing at its edge.
        let glowR=length((rel-vec2f(0.0,0.35*tall))/vec2f(1.0,1.15))/(0.9*tall+0.4*R);
        if(glowR<1.0 && life.x>0.002){ plate=vec4f(plate.rgb+airTint*(life.x*flick*front*(exp(-3.0*glowR)-0.0498)/0.9502),plate.a); }
        // Smoke: a plume six flame heights tall rising out of the flames, leaning downwind.
        let hs=H*6.0; let rise=(rel.y-0.45*tall)/hs;
        if(life.y>0.002 && rise>0.0 && rise<1.0){
          let x=(rel.x-0.3*hs*rise*rise)/(0.55*hs)*select(1.0,-1.0,fract(life.w*7.0)>0.5);
          if(abs(x)<0.5){
            let dens=flipbook(vec2f(0.5+x,1.0-rise),t*14.0+life.w*64.0,64.0,1u)*life.y*smoothstep(0.0,0.15,rise)*front;
            let a=min(0.55,1.4*dens);
            var c=mix(vec3f(0.15,0.13,0.12),vec3f(0.82,0.85,0.88),form.w);
            c+=mix(vec3f(0.85,0.32,0.06),LAMP*vec3f(0.85,0.32,0.06),u.orb.z)*life.x*(1.0-smoothstep(0.0,0.35,rise))*0.7;
            fume=vec4f(fume.rgb*(1.0-a)+c*a,fume.a+(1.0-fume.a)*a);
          }
        }
        if(life.x<0.002 || rel.y>1.6*tall) {continue;}
        let tallF=1.3*tall; // the flames stand taller than the glow round them is measured by
        // Flames: one at the foot, which runs ahead at the burning edge, and one to either side along it.
        for(var j=-1;j<=1;j++){
          let fj=f32(j); let hj=hash(vec2f(fj+3.0,life.w*31.0));
          let side=select(1.0,smoothstep(0.35,1.1,R)*(0.7+0.3*hj),j!=0);
          let hf=tallF*(1.0-0.22*abs(fj))*(0.9+0.2*hj);
          let up=rel.y/hf;
          let x=(rel.x-fj*0.6*R-0.15*hf*up*up)/(0.8*hf)*select(1.0,-1.0,hj>0.5);
          if(side<0.01 || up< -0.02 || up>=1.0 || abs(x)>=0.5){continue;}
          let heat=flipbook(vec2f(0.5+x,1.0-0.019-up*0.96),t*21.0*(0.9+0.2*hj)+hj*60.0+life.w*37.0,60.0,0u);
          let e=pow(heat,1.3)*(0.55+0.45*life.x)*side*flick*1.12;
          let col=mix(flameRamp(e),LAMP*flameRamp(e),u.orb.z);
          let a=0.8*smoothstep(0.05,0.7,e)*front;
          plate=vec4f(plate.rgb*(1.0-a)+col*front*min(1.0,e*6.0),plate.a+(1.0-plate.a)*a);
          if(a>0.6) {flameDepth=draw.w/ray.z;}
        }
        // Sparks: tiny hot points with short streaks, riding up on the heat.
        if(abs(rel.x)<0.8*tall){
          let unit=draw.z*scale;
          for(var j=0;j<3;j++){
            let k=f32(j); let hs2=hash(vec2f(k+1.0,life.w*17.0+3.0));
            let ph=fract(t*(0.45+0.3*hs2)+hs2);
            let at=vec2f((hs2-0.5)*0.6*tall+0.25*tall*ph*ph+0.1*tall*ph*sin(t*1.3+k*2.0),tall*(0.3+1.2*ph));
            let way=normalize(vec2f(0.2+0.3*cos(t*1.9+k*2.3),1.0));
            let off=rel-at;
            let gap=length(off-way*clamp(dot(off,way),-0.05*tall,0.0))*unit;
            let glint=(1.0-smoothstep(0.3,1.0,gap))*(1.0-ph)*smoothstep(0.0,0.08,ph)*life.x*front;
            plate=vec4f(plate.rgb+mix(vec3f(3.0,1.4,0.4),LAMP*vec3f(3.0,1.4,0.4),u.orb.z)*glint,plate.a);
          }
        }
      }
      // Firelight: warms what it falls on, and after dark it is most of the light there is.
      let warm=color*vec3f(0.55,0.2,0.03)*light+vec3f(0.2,0.075,0.012)*light;
      color+=mix(warm,LAMP*(warm*2.0),u.orb.z);
      if(bed>0.001){
        // The ember bed: coals split by dark cracks, each breathing at its own pace, cooling to grey ash.
        let cp=surface.xz*5.5; let cell=floor(cp);
        var f1=9.0; var f2=9.0; var near=cell;
        for(var cy=-1;cy<=1;cy++){ for(var cx=-1;cx<=1;cx++){
          let g=cell+vec2f(f32(cx),f32(cy));
          let dd=length(cp-g-vec2f(hash(g),hash(g+19.7)));
          if(dd<f1){f2=f1;f1=dd;near=g;} else if(dd<f2){f2=dd;}
        }}
        let crack=smoothstep(0.02,0.13,f2-f1);
        let luck=hash(near+3.1);
        let breath=0.6+0.4*sin(t*(1.2+2.2*luck)+luck*31.0);
        let coal=smoulder*(0.08+0.92*crack*breath*luck*luck)*(1.0-0.5*f1);
        let ash=mix(vec3f(0.075,0.05,0.06),vec3f(0.38,0.36,0.35),smoothstep(0.5,0.85,noise(surface.xz*2.7))*crack*(1.0-smoothstep(0.0,0.4,smoulder)));
        color=mix(color,ash,bed*0.93);
        let ember=0.85*fireHeat(0.2+0.7*coal)*smoothstep(0.03,0.35,coal)*bed;
        color+=mix(ember,LAMP*ember,u.orb.z);
      }
      if(shine>0.001){
        let glint=fireHeat(0.55+0.3*min(shine,1.0))*min(shine,1.2)*0.8;
        color+=mix(glint,LAMP*glint,u.orb.z);
      }
      color=color*(1.0-fume.a)+fume.rgb;
      color=color*(1.0-plate.a)+plate.rgb; landFar=flameDepth;
    }
  }

  // The lens is focused on the middle of the valley: the far land is soft, and the ground under the eye.
  if (landFar < 1e8) { soft = max(0.6 * smoothstep(55.0, 180.0, landFar), 0.7 * (1.0 - smoothstep(5.0, 10.0, landFar))); }

  // A building finished: a ring of light runs out from it over the ground.
  if (u.pulse.z < 2.5) {
    let age = u.pulse.z / 2.5;
    let out = length((d - u.pulse.xy) * vec2f(1.0, 2.4)) / u.pulse.w;
    let ring = exp(-pow((out - 0.6 - 7.0 * (1.0 - pow(1.0 - age, 3.0))) / (0.25 + age), 2.0));
    color += vec3f(1.5, 1.05, 0.4) * ring * (1.0 - age) * (1.0 - age);
  }

  // Tears that have left the jaw: they stretch as they fall, and where they
  // land a ring runs out and a crown of droplets jumps up.
  if (u.mood.z > 0.05 && u.sun.z > 0.0) {
    let tear = mix(${vec3('#86dcee')}, ${vec3('#c20f1d')}, u.mood.w);
    for (var i = 0; i < 4; i++) {
      let n = f32(i / 2);
      let way = select(-1.0, 1.0, i % 2 == 0);
      let clock = fract(t / 4.2 + n * 0.5 + 0.23 * step(0.0, way));
      let jaw = vec3f(way * (0.436 + 0.03 * n), -0.865, 0.25);
      let start = sunNow + u.sun.z * vec2f(dot(jaw, u.sunRight.xyz), -dot(jaw, u.sunUp.xyz));
      let landY = height - u.look.w + 22.0 + 20.0 * n;
      let r = u.sun.z * 0.06 * u.mood.z;
      if (clock > 0.6) {
        let fell = (clock - 0.6) / 0.4;
        let off = (d - vec2f(start.x, mix(start.y, landY, fell * fell))) / vec2f(1.0 - 0.15 * fell, 1.0 + 0.9 * fell);
        let sd = teardrop(off, r) * scale;
        color = mix(color, INK, fill(pen * 1.3 - sd));
        color = mix(color, tear, fill(-sd));
        color = mix(color, mix(tear, vec3f(1.0), 0.5), fill(-sd - r * 0.4 * scale));
        color = mix(color, vec3f(1.8), fill((r * 0.28 - length(off - vec2f(-r * 0.32, -r * 0.05))) * scale));
      } else if (clock < 0.2 && t > 4.2) {
        let age = clock / 0.2;
        let out = 1.0 - (1.0 - age) * (1.0 - age);
        let off = d - vec2f(start.x, landY);
        let ring = abs(length(off * vec2f(1.0, 2.8)) - r * (0.6 + 3.2 * out));
        color = mix(color, INK, (1.0 - age) * stroke(ring * scale, pen * 1.1));
        color = mix(color, mix(tear, vec3f(1.3), 0.5), (1.0 - age) * stroke(ring * scale, pen * 0.5));
        for (var j = 0; j < 5; j++) {
          let a = (f32(j) - 2.0) * 0.5;
          let at = vec2f(sin(a) * r * 2.6 * out, -cos(a) * r * 4.5 * out + r * 5.0 * age * age);
          let bead = (r * 0.3 * (1.0 - 0.7 * age) - length(off - at)) * scale;
          color = mix(color, INK, fill(bead + pen * 0.9));
          color = mix(color, tear, fill(bead));
        }
      }
    }
  }

  // The garden the sun has grown, the farthest flower first.
  if (d.y > u.misc.x) {
    for (var i = 0; i < 12; i++) {
      if (u.bloomLooks[i].x <= 0.0) { continue; }
      color = bloom(d, scale, pen, t, u.blooms[i], u.bloomLooks[i], u.blooms[i].y, color);
    }
  }

  // The village/terrain already give the closest hit on this ray.
  if (viperActive && all(d > u.snakeBox.xy) && all(d < u.snakeBox.zw)) {
    let uv=(d-u.vStamp.xy)*u.vStamp.z/vec2f(textureDimensions(vInk));
    let ink=textureSampleLevel(vInk,titleSampler,uv,0.0);
    let info=textureSampleLevel(vDepth,titleSampler,uv,0.0).xyz;
    let landZ=landFar*ray.z;
    let contact=info.y*(1.0-smoothstep(1.2,3.5,abs(landZ-info.z/max(info.y,0.001))));
    if(landFar==viperReceiver){color *= mix(vec3f(1.0),vec3f(0.47,0.43,0.62),contact);}
    let z=info.x/max(ink.a,0.00001);
    let visible=smoothstep(-0.045,0.045,landZ-z);
    color=color*(1.0-ink.a*visible)+ink.rgb*visible;
    soft*=1.0-ink.a*visible;
  }

  // The audit: the compliance officers who are on the ground.
  if (u.officers[0].x > 0.0) {
    color = officers(color, d, scale, pen, t, landFar * ray.z, true);
  }

  } // (everything behind the terminal)

  if (u.machine.z > 0.0) {
    let at = deskAt;
    if (onDesk) {
      let m = desk;
      color = mix(color, m.rgb, m.a);
      if(u.fireDesk.y>0.001){
        let vent=onPlane(MON_C+deskShift+vec3f(MON_B.x,0.145,0.025));
        let q=at-vent;
        if(q.y>-0.10 && q.y<0.78 && q.x>-0.14 && q.x<0.65){
          let drift=fract(t*0.60);
          let ventSmoke=(q-vec2f(0.02+0.33*drift+0.045*sin(t*3.0+drift*4.0),drift*0.66))/(0.023+0.122*drift);
          if(dot(ventSmoke,ventSmoke)<1.0){
            let curl=smokeCurl(ventSmoke,(0.023+0.122*drift)*scale*u.machine.z,0.22);
            color=mix(color,curl.rgb,curl.a*u.fireDesk.y*0.87*sin(drift*3.14159));
          }
          let spray=max(u.fireDesk.w*0.58,exp(-3.5*u.fireDesk.z));
          for(var j=0;j<3;j++){
            let n=f32(j); let f=fract(t*1.17+0.343*n);
            let off=q-vec2f((0.18+0.12*n)*f,(0.72-0.18*n)*f-0.78*f*f);
            let spark=fill((0.015-abs(off.x)-0.49*abs(off.y))*scale*u.machine.z);
            color=mix(color,vec3f(1.28,0.89,0.36),spark*spray*sin(f*3.14159));
          }
        }
      }
      soft *= 1.0 - m.a;
    }
  }

  if (!lettered) {
  // Clouds drift, turn and breathe (drawn by cloudMain, except in the takeover).
  var clouded = false;
  var inCloud = 0; // (each tile with this pixel in it holds the same)
  for (var c = 0; c < 6; c++) { if (cloudAt(c, d, t).z > 0.0) { clouded = true; inCloud = c; } }
  if (clouded) {
    var cover: vec4f;
    if (takeoverLive) { cover = cloudsOver(d, scale, pen, t); } else { cover = textureLoad(cloudMap, vec2i(position.xy + u.cloudTile[inCloud].xy), 0); }
    color = color * cover.a + cover.rgb;
  }

  for (var i = 0; i < 2; i++) {
    let bloom = u.flowers[i];
    if (bloom.z <= 0.0) { continue; }
    let at = (d - bloom.xy) / bloom.z;
    if (dot(at, at) < 1.3) {
      // The poster's own flower, and a pale blue lotus.
      color = bloomHead(at, bloom.z * scale, pen, t, select(0.12087, -1.0, i == 0), 1.0 - select(0.5, 0.0, i == 0) * u.orb.z, 0.0, color);
      soft = max(soft, 0.55 * (1.0 - smoothstep(0.85, 1.05, length(at)))); // right under the lens
    }
  }

  // Butterflies about the near flowers. They keep out of the rain.
  for (var i = 0; i < 3; i++) {
    let k = f32(i);
    let home = u.flowers[0].xy + vec2f(70.0 + 80.0 * k, -95.0 - 26.0 * k);
    let at = d - home - vec2f(90.0 * sin(t * 0.31 + k * 2.1) + 30.0 * sin(t * 0.83 + k), 46.0 * sin(t * 0.47 + k * 1.3) + 14.0 * sin(t * 1.9 + k));
    if (dot(at, at) > 330.0 || rain > 0.5 || u.flowers[0].z <= 0.0) { continue; }
    let flap = 0.22 + 0.78 * abs(sin(t * 8.0 + k * 2.0));
    let q = turn(0.5 * sin(t * 0.6 + k)) * at;
    let w = vec2f(abs(q.x) / flap, q.y);
    let wing = min(oval(w - vec2f(6.5, -3.0), vec2f(6.0, 5.2)), oval(w - vec2f(4.6, 4.2), vec2f(4.4, 3.6)));
    let show = 1.0 - smoothstep(0.3, 0.5, rain);
    color = mix(color, INK, show * fill((pen * 0.9 - wing) * scale));
    color = mix(color, K_BOW_0[(i * 2 + 1) % 6], show * fill(-wing * scale));
    color = mix(color, PAPER, show * fill((1.6 - length(w - vec2f(7.0, -3.0))) * scale));
    color = mix(color, INK, show * fill((1.3 - segment(q, vec2f(0.0, -5.0), vec2f(0.0, 5.0))) * scale));
  }

  // Rain, in three depths, slanting on the wind.
  if (rain > 0.0) {
    for (var layer = 0; layer < 3; layer++) {
      let k = f32(layer);
      let pitch = 26.0 + 16.0 * k;
      let slant = vec2f(d.x + d.y * 0.24, d.y);
      let lane = floor(slant.x / pitch);
      let luck = hash(vec2f(lane, k * 7.0));
      let run = fract(slant.y / (190.0 + 80.0 * k) - t * (2.6 + 0.9 * k) + luck * 9.0);
      let streak = stroke(abs(fract(slant.x / pitch) - 0.5 - 0.3 * (luck - 0.5)) * pitch * scale, (0.5 + 0.4 * k) * scale) * (1.0 - smoothstep(0.0, 0.16 + 0.05 * k, run)) * step(luck, rain);
      color = mix(color, vec3f(0.8, 0.97, 1.12), (0.3 + 0.2 * k) * streak);
    }
  }

  } // (everything under the lettering)

  // Lightning. A thin leader runs down from the cloud; when it lands the whole
  // path flares white, then cools through blue to violet as it thins away. A
  // ring of light runs out over the ground from where it struck.
  let boltAge = u.weather.y;
  let hot = select(0.0, exp(-(boltAge - 0.14) * 5.0) * smoothstep(0.14, 0.17, boltAge), boltAge > 0.14);
  if (boltAge < 1.3) {
    let grown = 1.0 - pow(1.0 - clamp(boltAge / 0.14, 0.0, 1.0), 2.0);
    let there = select(1.0, smoothstep(0.0, 0.1, hot), boltAge > 0.3);
    let girth = 1.5 + 5.5 * hot;
    let inside = boltInside(d, u.weather.z, u.bolt.x, u.bolt.y, u.weather.w, grown, girth) * scale;
    color = mix(color, INK, there * fill(inside + pen * 1.3));
    color = mix(color, mix(${vec3('#7a5cff')}, ${vec3('#9fe8ff')}, hot) * (1.0 + hot), there * fill(inside));
    color = mix(color, vec3f(5.0, 5.2, 6.0), there * fill(inside - girth * 0.5 * scale) * smoothstep(0.02, 0.3, hot));
    if (boltAge > 0.14) {
      let since = boltAge - 0.14;
      let out = length((d - vec2f(u.weather.z, u.bolt.y)) * vec2f(1.0, 2.6));
      let ring = exp(-pow((out - 16.0 - 190.0 * (1.0 - exp(-since * 3.2))) / (7.0 + 30.0 * since), 2.0));
      color += vec3f(1.0, 1.25, 1.9) * ring * exp(-since * 3.4) + vec3f(1.5, 1.7, 2.3) * hot * exp(-out * out / 500.0);
    }
  }

  // The sun's lasers, one from each eye.
  if (u.beam.z > 0.0 && u.sun.z > 0.0) {
    for (var i = 0; i < 2; i++) {
      // (The eyes are crowded up against the brow while the maw is open, and the whole head swells.)
      let pushed = crowded(vec2f(select(-0.37, 0.37, i == 0), -0.22), u.mood.y, t);
      let socket = vec3f(pushed.x, -pushed.y, sqrt(max(0.04, 0.94 - dot(pushed, pushed)))) * (1.0 + 0.13 * u.mood.y * u.mood.y * (3.0 - 2.0 * u.mood.y));
      let eye = sunNow + u.sun.z * vec2f(dot(socket, u.sunRight.xyz), -dot(socket, u.sunUp.xyz));
      color = laser(d, scale, pen, t, eye, u.beam.xy, u.beam.z, color);
    }
  }

  if(takeoverLive && u.boss.y>0.0 && (u.comet[0].z+u.comet[2].z)>0.0){color=cometInk(d,scale,t,color);}

  // The lettering, last so it sits over everything. Behind it a stack of
  // rainbow copies steps back toward the sun and snakes from side to side;
  // then the black shape, each letter's outline and its banded fill. The whole
  // thing wavers like something seen through heat.
  if (u.title.z > 0.0) {
    let at = titleAt(d, t);
    let uv = (at - u.title.xy) / u.title.zw;
    if (uv.x > -0.1 && uv.x < 1.1 && uv.y > -0.25 && uv.y < 1.4) {
      let texel = u.title.z / u.titleSize.x; // design units per texel
      let px = texel * scale;
      let swell = 1.2 * sin(t * 0.45 + d.x * 0.008);
      let away = normalize(at - select(vec2f(at.x, at.y + 1.0), u.sun.xy, u.sun.z > 0.0));
      let side = vec2f(-away.y, away.x);
      let sd = titleField(uv);
      // (Where the black shape is solid the stack behind it cannot be seen, and is not drawn.)
      if ((sd.z + swell) * px < 0.75) {
        for (var k = 13; k >= 1; k--) {
          let depth = f32(k);
          let shift = away * depth * 4.6 + side * 6.0 * sin(t * 1.1 - depth * 0.5) * depth / 13.0;
          let copy = titleField(uv + shift / u.title.zw).z + swell;
          if ((copy + 1.5 / texel) * px <= -0.7) { continue; } // (both fills below are 0: it is nowhere near)
          if (k % 2 == 1) { color = mix(color, INK, fill((copy + 1.5 / texel) * px)); }
          if (k < 13) { color = mix(color, K_BOW_0[((k - 1) / 2) % 6] * (0.972 + 0.05 * noise(d * 2.3)), fill(copy * px)); }
        }
      }
      let hop = 1.5 / u.titleSize.xy;
      let slopeX = titleField(uv + vec2f(hop.x, 0.0)) - titleField(uv - vec2f(hop.x, 0.0));
      let slopeY = titleField(uv + vec2f(0.0, hop.y)) - titleField(uv - vec2f(0.0, hop.y));
      color = mix(color, INK, fill((sd.z + swell) * px));
      if(takeoverLive && u.boss.y*u.boss.z>0.0){
        let shift=vec2f((4.0+abs(tape.y)*0.43)*u.boss.z/u.title.z,0.0);
        let ink0=titleField(uv-shift); let ink1=titleField(uv+shift);
        color+=u.boss.z*vec3f(0.78*fill(max(ink0.x,ink0.y)*px),0.49*fill(max(ink1.x,ink1.y)*px),0.75*fill(max(ink1.x,ink1.y)*px));
      }
      for (var layer = 0; layer < 2; layer++) {
        let letter = select(sd.y, sd.x, layer == 0);
        let inward = select(vec2f(slopeX.y, slopeY.y), vec2f(slopeX.x, slopeY.x), layer == 0);
        let outward = -inward / max(length(inward), 1e-4);
        color = mix(color, INK, fill((letter + u.titleInfo.y) * px));
        // (Outside the letter, where fill() is 0, its colour and glint are not worked out.)
        if (letter * px > -0.7) {
          color = mix(color, candy(d, uv.y, letter * texel, outward, scale, t), fill(letter * px));
          // Now and then a glint crosses the lettering.
          let glint = exp(-pow((d.x + d.y * 0.5 - (fract(t / 8.0) * 3.0 - 0.6) * u.frame.w) / 38.0, 2.0));
          color += (vec3f(0.5, 0.42, 0.3) * glint + vec3f(0.35, 0.31, 0.24) * pow(glint, 9.0)) * fill(letter * px);
        }
      }
    }
  }

  // Where the glint is hottest the lens flares: a star, with a long streak through it.
  if (u.title.z > 0.0) {
    let high = u.title.y + 0.3 * u.title.w;
    let spot = vec2f((fract(t / 8.0) * 3.0 - 0.6) * u.frame.w - 0.5 * high, high);
    let ride = (spot.x - u.title.x) / u.title.z;
    let lit = smoothstep(0.0, 0.16, ride) * (1.0 - smoothstep(0.84, 1.0, ride));
    if (lit > 0.0) {
      let off = (d - spot) / (u.title.w * 0.5);
      let twinkle = 0.75 + 0.25 * sin(t * 23.0);
      let streak = exp(-abs(off.y) * 26.0) * exp(-abs(off.x) * 1.5);
      let rays = exp(-abs(off.x) * 30.0) * exp(-abs(off.y) * 4.5);
      let slant = turn(0.785) * off;
      let fine = exp(-abs(slant.x) * 40.0) * exp(-abs(slant.y) * 9.0) + exp(-abs(slant.y) * 40.0) * exp(-abs(slant.x) * 9.0);
      color += lit * twinkle * (vec3f(0.7, 1.0, 1.6) * streak * 0.7 + vec3f(1.6, 1.5, 1.2) * (0.45 * rays + 0.3 * fine) + vec3f(1.1) * exp(-dot(off, off) * 500.0));
    }
  }

  // Fireflies over the valley after dark.
  if (u.orb.z > 0.0 && height - d.y < u.look.w + 30.0) {
    for (var i = 0; i < 14; i++) {
      let k = f32(i);
      let z = u.world.y + 15.0 + 70.0 * fract(hash(vec2f(k, 1.0)) - u.world.y / 70.0);
      let x = river(z) + (hash(vec2f(k, 2.0)) - 0.5) * 22.0 + 0.8 * sin(t * 0.7 + k);
      let at = onHero(vec3f(x, 0.5 + 1.6 * hash(vec2f(k, 3.0)) + 0.3 * sin(t * 1.1 + k * 2.0), z));
      let glow = 0.5 + 0.5 * sin(t * (1.5 + hash(vec2f(k, 4.0))) + k * 3.0);
      color = mix(color, LAMP * vec3f(2.6, 2.8, 0.9), u.orb.z * glow * fill((max(0.07 * at.z, 1.4) - length(d - at.xy)) * scale));
    }
  }

  // And those of them who are in the air.
  if (u.officers[0].y > 0.0) {
    color = officers(color, d, scale, pen, t, 1e9, false);
  }

  // The planet takes a walker up in a beam of light, rings of it climbing.
  if (u.lift.z > 0.0) {
    let top = u.planet.xy + vec2f(0.0, 3.0 * sin(t * 0.45)) + u.watch.xy * vec2f(1.0, -1.0) * u.planet.z;
    let axis = u.lift.xy - top;
    let h = clamp(dot(d - top, axis) / dot(axis, axis), 0.0, 1.0);
    let wide = mix(0.3 * u.planet.z, 1.0 * u.planet.z + 26.0, h) * (0.94 + 0.06 * sin(t * 17.0));
    let across = length(d - top - axis * h);
    let off = across - wide;
    let root = smoothstep(-0.09, 0.42, dot(d - top, axis) / max(1.0, length(axis) * u.planet.z));
    let inside = fill(-off * scale) * root;
    // Rings of light climb it, with dust going up among them; it is green at the heart and pink at the edges.
    let climb = fract(h * 11.0 + t * 3.4);
    let rings = smoothstep(0.0, 0.12, climb) * (1.0 - smoothstep(0.42, 0.56, climb));
    let core = exp(-pow(across / (0.3 * wide + 1.0), 2.0));
    var light = mix(vec3f(0.14, 0.9, 0.55), vec3f(0.95, 0.3, 0.8), smoothstep(0.45, 1.0, across / wide)) * (0.28 + 0.8 * rings) + vec3f(0.7, 1.0, 0.75) * core * 0.3;
    let run = length(axis);
    let side = dot(d - top, vec2f(-axis.y, axis.x) / run) / wide;
    let lane = floor(side * 4.0 + 4.0);
    let luck = hash(vec2f(lane, 3.0));
    let rise = fract(h * (2.0 + 3.0 * luck) + t * (0.8 + 1.3 * luck) + luck * 7.0) - 0.5;
    let dust = length(vec2f(rise / (2.0 + 3.0 * luck) * run, (fract(side * 4.0) - 0.5) * 0.25 * wide));
    light += vec3f(1.2, 1.5, 1.1) * fill((1.4 + 1.4 * luck - dust) * scale) * step(0.25, luck);
    color = mix(color, color * 0.66 + light * 0.95, 0.88 * u.lift.z * inside);
    color += light * 0.12 * u.lift.z * exp(-max(off, 0.0) / (0.3 * wide + 6.0)) * (1.0 - inside);
    color = mix(color, vec3f(0.85, 1.35, 1.1), 0.9 * root * u.lift.z * stroke(abs(off) * scale, pen * 0.45));
    // A pool of it on the ground.
    let lying = (d - u.lift.xy) * vec2f(1.0, 2.8);
    let pool = length(lying) - (1.0 * u.planet.z + 26.0) * (0.9 + 0.1 * sin(t * 9.0));
    color = mix(color, color * 0.55 + vec3f(0.3, 0.9, 0.62), 0.65 * u.lift.z * fill(-pool * scale));
    color = mix(color, vec3f(0.9, 1.5, 1.2), u.lift.z * stroke(abs(pool) * scale, pen * 0.45));
    // A ring of marks runs round it.
    let marks = step(0.5, fract(atan2(lying.y, lying.x) / TAU * 12.0 + t * 1.2));
    color = mix(color, vec3f(1.0, 0.5, 0.9) * 1.4, u.lift.z * marks * stroke(abs(pool - 7.0) * scale, pen * 0.5));
  }

  // Sparks, confetti and petals thrown up by whatever has just happened.
  if (all(d > u.motesBox.xy) && all(d < u.motesBox.zw)) {
    for (var i = 0; i < 24; i++) {
      let mote = u.motes[i];
      if (mote.z <= 0.0) { continue; }
      let off = d - mote.xy;
      if (abs(off.x) > 56.0 || abs(off.y) > 56.0) { continue; }
      let kind = i32(mote.w);
      let seed = fract(mote.w);
      let fade = smoothstep(0.0, 0.25, mote.z);
      if (kind == 0) {
        color = mix(color, mix(RED, YELLOW, mote.z) * 2.2, fade * fill((1.2 + 2.2 * mote.z - length(off)) * scale));
      } else if (kind == 8) {
        // Steam off the water where the lasers meet it.
        let puff = 5.0 + 15.0 * (1.0 - mote.z) - length(off + vec2f(3.0 * sin(seed * 40.0 + t * 3.0), 0.0));
        let lobe = 4.0 + 10.0 * (1.0 - mote.z) - length(off - vec2f(7.0, 5.0) * (1.0 - mote.z + 0.3) * vec2f(sign(seed - 0.5), 1.0));
        let cloud = max(puff, lobe);
        color = mix(color, INK, 0.7 * fade * stroke(abs(cloud) * scale, pen * 0.4));
        color = mix(color, PAPER * 1.06, 0.85 * fade * fill(cloud * scale));
      } else if (kind == 7) {
        // A walker on its way up to the planet, turning over and kicking.
        let big = 7.0 + 21.0 * mote.z;
        let spun = turn(0.5 * sin(t * 11.0) + (1.0 - mote.z) * 9.0 + seed * 9.0) * off;
        let box = roundRect(spun, vec2f(big, big * 0.82), big * 0.25);
        let kick = 0.35 * big * sin(t * 15.0 + seed * 5.0);
        let legs = min(segment(spun, vec2f(-0.5 * big, 0.7 * big), vec2f(-0.75 * big + kick, 1.55 * big)), segment(spun, vec2f(0.5 * big, 0.7 * big), vec2f(0.75 * big - kick, 1.55 * big))) - 0.16 * big;
        color = mix(color, INK, fill((pen * 0.9 - min(box, legs)) * scale));
        color = mix(color, ORANGE, fill(-legs * scale));
        color = mix(color, PAPER, fill(-box * scale));
        color = mix(color, vec3f(0.06, 0.2, 0.14), fill(-roundRect(spun + vec2f(0.0, 0.08 * big), vec2f(big * 0.66, big * 0.48), big * 0.16) * scale));
        // Its face: two wide eyes and a round mouth.
        let stare = length(vec2f(abs(spun.x) - 0.26 * big, spun.y + 0.2 * big)) - 0.12 * big;
        let cry = abs(length(spun - vec2f(0.0, 0.12 * big)) - 0.1 * big) - 0.035 * big;
        color = mix(color, vec3f(0.5, 2.2, 1.2), fill(-min(stare, cry) * scale));
      } else if (kind == 9) {
        // The visitor's own pointer on its way up to the planet, turning over.
        let grown = 0.75 + 1.0 * mote.z;
        let q = turn(0.5 * sin(t * 11.0) + (1.0 - mote.z) * 9.0) * off / grown;
        let a = abs(q);
        let arm = vec2f(max(a.x, a.y), min(a.x, a.y));
        let sight = min(abs(length(q) - 4.5), length(vec2f(clamp(arm.x, 6.0, 13.0) - arm.x, arm.y))) * grown * scale;
        color = mix(color, INK, stroke(sight, 2.5 * grown * scale));
        color = mix(color, PAPER * 1.25, stroke(sight, 1.0 * grown * scale));
      } else if (kind == 10) {
        // A drop of blood out of a mouth that has just shut on somebody.
        let size = 2.3 + 3.6 * seed;
        let drop = size - length(off * vec2f(1.0, 0.8) + vec2f(0.0, -0.35 * size * smoothstep(0.0, size, -off.y)));
        color = mix(color, vec3f(0.86, 0.04, 0.1), fade * fill(drop * scale));
        color = mix(color, vec3f(1.5, 0.5, 0.5), fade * fill((size * 0.26 - length(off + vec2f(size * 0.3))) * scale));
        color = mix(color, INK, fade * stroke(abs(drop) * scale, pen * 0.45));
      } else if (kind == 11) {
        // And a bone, turning over as it falls.
        let long = 6.5 + 5.5 * seed;
        let q = turn(seed * 40.0 + (1.0 - mote.z) * (9.0 + 14.0 * seed) * sign(seed - 0.5)) * off;
        let knob = length(vec2f(abs(q.x) - long, abs(q.y) - 0.2 * long)) - 0.27 * long;
        let bone = min(segment(q, vec2f(-long, 0.0), vec2f(long, 0.0)) - 0.17 * long, knob);
        color = mix(color, INK, fade * fill((pen * 0.8 - bone) * scale));
        color = mix(color, PAPER * 1.12, fade * fill(-bone * scale));
      } else if (kind == 6) {
        // A drop of water thrown up, with a glint on it.
        let size = 1.3 + 3.4 * seed;
        let drop = size - length(off * vec2f(1.0, 0.82));
        color = mix(color, mix(AQUA, PAPER, 0.55), fade * fill(drop * scale));
        color = mix(color, PAPER * 1.4, fade * fill((size * 0.3 - length(off + vec2f(size * 0.3))) * scale));
        color = mix(color, INK, fade * stroke(abs(drop) * scale, pen * 0.45));
      } else if (kind == 5) {
        // Word of what happened, on its way to the terminal.
        let tint = 0.55 + 0.45 * cos(TAU * (seed * 7.0 + vec3f(0.0, 0.33, 0.67)));
        let lit = smoothstep(1.0, 0.9, mote.z) * smoothstep(0.0, 0.14, mote.z);
        color = mix(color, tint * 2.6 + 0.8, fill((3.0 * lit - length(off)) * scale));
        color += tint * 0.45 * lit * exp(-dot(off, off) / 70.0);
      } else if (kind == 4) {
        // A fish out of the river, nose along its path.
        let k = floor(seed * 100.0 + 0.01);
        let way = select(-1.0, 1.0, fract(seed * 100.0 + 0.01) > 0.25);
        let along = normalize(vec2f(way, 10.6 * (0.5 - mote.z)));
        var q = vec2f(dot(off, along), dot(off, vec2f(-along.y, along.x)) * way) / (k * 1.5);
        // It thrashes its tail in the air.
        q.y += 0.07 * sin(t * 22.0 + seed * 60.0) * smoothstep(0.1, -0.45, q.x);
        let body = (length(q / vec2f(0.3, 0.125)) - 1.0) * 0.125;
        let tail = max(max(abs(q.y) - (-q.x - 0.2) * 0.8, -q.x - 0.46), q.x + 0.2);
        let fin = max(length((q - vec2f(-0.02, -0.1)) / vec2f(0.16, 0.1)) - 1.0, q.y + 0.08) * 0.1;
        let fish = min(min(body, tail), fin) * k * 1.5 * scale;
        color = mix(color, INK, fade * fill(pen * 0.9 - fish));
        // Banded like everything else here, with a pale belly.
        var skin = K_BOW_0[i32(floor((q.x + 0.5) * 9.0 + seed * 600.0)) % 6];
        skin = mix(skin, PAPER * 1.1, smoothstep(0.0, 0.06, q.y) * step(body, 0.0));
        color = mix(color, skin * 1.1, fade * fill(-fish));
        color = mix(color, PAPER * 1.3, fade * fill((0.05 - length(q - vec2f(0.17, -0.02))) * k * 1.5 * scale));
        color = mix(color, INK, fade * fill((0.028 - length(q - vec2f(0.18, -0.02))) * k * 1.5 * scale));
      } else if (kind == 3) {
        // The sign of what just happened, rising from where it happened.
        // It is a word of two or three glyphs: the first says what kind of thing
        // it was, the rest are never the same twice. It comes in small and
        // grows, and fades as it goes.
        let which = floor(seed * 20.0 + 0.001);
        let vary = fract(seed * 20.0 + 0.001);
        let arrive = smoothstep(1.0, 0.93, mote.z);
        let grow = (15.0 + 9.0 * (1.0 - mote.z)) * (0.6 + 0.4 * arrive);
        let cell = grow * 1.3;
        let count = 2.0 + floor(vary * 2.0);
        let place = off.x / cell + count * 0.5;
        let nth = clamp(floor(place), 0.0, count - 1.0);
        let glyph = select(floor(vary * 9973.0) + nth * 17.0 + 3.0, which * 5.0, nth < 0.5);
        let far = rune((vec2f(place - nth, -off.y / cell + 0.5) - 0.5) * 1.3 + 0.5, glyph) * cell / 1.3 * scale;
        let tint = 0.55 + 0.45 * cos(TAU * (which / 20.0 * 7.0 + 0.11 * nth + vec3f(0.0, 0.33, 0.67)));
        color = mix(color, INK, fade * arrive * stroke(far, pen * 1.5));
        color = mix(color, tint * 2.1, fade * arrive * stroke(far, pen * 0.7));
      } else {
        let spun = turn(seed * 40.0 + t * (4.0 + 8.0 * seed)) * off;
        let flake = select(roundRect(spun * vec2f(1.0, 1.0 + 1.5 * abs(sin(t * 6.0 + seed * 20.0))), vec2f(4.0, 2.6), 0.6), oval(spun, vec2f(5.0, 2.6)), kind == 2);
        color = mix(color, INK, fade * fill((pen * 0.9 - flake) * scale));
        color = mix(color, K_BOW_0[i32(seed * 6.0) % 6], fade * fill(-flake * scale));
      }
    }
  }

  // Lightning lights everything, and the light dies away.
  color += hot * vec3f(0.13, 0.15, 0.22);

  // The mood of the moment, then night where it has fallen, with the last of
  // the day burning at its edge.
  color *= u.grade.rgb;
  if (nightHere > 0.0) {
    color = mix(color, NIGHT * color, nightHere);
    color += vec3f(1.2, 0.4, 0.16) * 0.2 * nightHere * (1.0 - nightHere) * 4.0;
  }
  if (wheel > 0.0) {
    // Low in the sky each of them throws its own light a long way: gold from the sun, silver from the moon.
    let low = sin(wheel * 3.14159);
    color *= mix(vec3f(1.0), vec3f(1.16, 0.74, 0.5), low * (1.0 - nightHere) * exp(-length(d - sunIs) / 640.0));
    color += vec3f(0.3, 0.46, 0.9) * 0.12 * low * nightHere * exp(-length(d - moonIs) / 520.0);
  }

  // Before sunrise everything is dark. Light spreads out from the sun in a
  // bright front, and whatever it reaches takes its colours.
  if (u.sky.w < 30000.0) {
    let reach = length(d - sunNow);
    let lit = 1.0 - smoothstep(u.sky.w - 150.0, u.sky.w, reach);
    let cell = floor(d / 34.0);
    let star = length(d - (cell + 0.2 + 0.6 * vec2f(hash(cell), hash(cell + 7.7))) * 34.0);
    let night = color * vec3f(0.05, 0.045, 0.1) + vec3f(0.9, 0.95, 1.2) * fill((1.3 - star) * scale) * step(0.55, hash(cell + 5.5)) * step(d.y, height - 190.0) * 0.5;
    let front = exp(-pow((reach - u.sky.w + 40.0) / 34.0, 2.0)) * smoothstep(0.0, 300.0, u.sky.w) ;
    color = mix(night, color, lit) + vec3f(2.2, 1.3, 0.45) * front * 0.55;
  }

  if(takeoverLive && u.boss.y*u.boss.z>0.0){color*=1.0-0.19*u.boss.z*step(0.55,fract(d.y*0.36+t*3.0));}
  return vec4f(color, soft);
}
`

// After the picture: anything brighter than paper white (lasers, embers, glints)
// spills light round itself. The bright parts are shrunk step by step, spread
// back up, and added to the picture.
export const glowShader = /* wgsl */ `
@group(0) @binding(0) var sourceMap: texture_2d<f32>;
@group(0) @binding(1) var bilinear: sampler;
@group(0) @binding(2) var glowMap: texture_2d<f32>;
@group(0) @binding(4) var frontMap: texture_2d<f32>; // the grey page that lies over the picture until its tab is taken
@group(0) @binding(5) var runeMap: texture_2d<f32>;  // the same page with every word of it written in the terminal's script
@group(0) @binding(6) var noticeMap: texture_2d<f32>; // art/notice.png: the grey notice that comes up over the picture
@group(0) @binding(7) var pageMap: texture_2d<f32>;   // art/page.png: a perfectly ordinary page of an encyclopedia
@group(0) @binding(8) var flareMap: texture_2d<f32>;  // the light thrown about inside the lens, drawn small by flares()
@group(0) @binding(9) var paperMap: texture_2d<f32>;  // the paper, which never changes, drawn once by paper()

struct Lens {
  frame: vec4f, // time, pixels per design unit, how wide the maw gapes, how far a footfall's ripple runs in pixels
  sun: vec4f,   // the sun's place in pixels, seconds since a shock went off, its force
  shock: vec4f, // where it went off, in pixels; how much faster than usual the picture is flying; the horizon's height in pixels
  tread: vec4f, // where the terminal last put its feet down, in pixels, how long ago (0 to 1), how hard
  jolt: vec4f,  // how hard the whole picture is being shaken
  gate: vec4f,  // the grey page: where its tab sits in pixels, how far along its taking is in seconds (0 and the page is whole), 1 if there is a page at all
  tab: vec4f,   // half the tab's width in pixels, how closely it is being looked at (0 to 1), where the pointer is in pixels
  beat: vec4f,  // seconds the grey page has been up, the sun's radius in pixels, how hard the tab is pressed, how near the pointer has come to it (0 to 1)
  // What the show is putting on in front of the lens, as the show's act.lens gives it (raw; lengths are in design units, so multiply by frame.y):
  // [0], [1] the picture as browser windows and the page that breaks in; [2], [3] the notice; [4], [5] the dive into the terminal's screen; [6], [7] spare.
  acts: array<vec4f, 8>,
  haze: vec4f,  // the box over the flames where the air shimmers, in pixels
  hazeK: vec4f, // how hot (0 to 1), pixels per world unit there, how far it shifts the picture in pixels
  // [72] (eggs) the picture as the eye planet sees it: how far it has it (0 to 1), seconds in, the planet's middle in design units.
  stare: vec4f,
}
@group(0) @binding(3) var<uniform> lens: Lens;

@vertex
fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

fn four(uv: vec2f, reach: vec2f) -> vec3f {
  return 0.25 * (
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(-1.0, -1.0), 0.0).rgb +
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(1.0, -1.0), 0.0).rgb +
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(-1.0, 1.0), 0.0).rgb +
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(1.0, 1.0), 0.0).rgb
  );
}

// Half size, keeping only what is brighter than white.
@fragment
fn bright(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(sourceMap));
  let c = four(position.xy * 2.0 / size, 1.0 / size);
  return vec4f(c * smoothstep(1.0, 1.45, max(c.r, max(c.g, c.b))), 1.0);
}

@fragment
fn shrink(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(sourceMap));
  return vec4f(four(position.xy * 2.0 / size, 1.0 / size), 1.0);
}

// Double size, added onto what is already there.
@fragment
fn spread(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(sourceMap));
  return vec4f(four(position.xy / (size * 2.0), 1.0 / size), 1.0);
}

fn speck(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q += dot(q, q.yx + 33.33);
  return fract((q.x + q.y) * q.y);
}

fn cloudy(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let k = f * f * (3.0 - 2.0 * f);
  return mix(mix(speck(i), speck(i + vec2f(1.0, 0.0)), k.x), mix(speck(i + vec2f(0.0, 1.0)), speck(i + vec2f(1.0, 1.0)), k.x), k.y);
}

fn spun(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

// The poster's rainbow, one colour running softly into the next.
fn bowAt(x: f32) -> vec3f {
  var bow = ${list('vec3f', RAINBOW.map(vec3))};
  let k = fract(x) * 6.0;
  let i = i32(floor(k));
  return mix(bow[i % 6], bow[(i + 1) % 6], smoothstep(0.3, 0.7, fract(k)));
}

// Out to one and a little past it, then back.
fn overshoot(x: f32) -> f32 {
  let k = clamp(x, 0.0, 1.0) - 1.0;
  return 1.0 + 2.4 * k * k * k + 1.4 * k * k;
}

// The grey page at a point; swap is how far its words there have turned into glyphs.
fn greyPage(q: vec2f, size: vec2f, swap: f32) -> vec3f {
  let plain = textureSampleLevel(frontMap, bilinear, q / size, 0.0).rgb;
  if (swap <= 0.0) { return plain; }
  let script = textureSampleLevel(runeMap, bilinear, q / size, 0.0).rgb;
  return mix(plain, script, swap);
}

// How far down the page the picture has run in a column (x and the answer in
// tabs), a seconds after the tab was taken. It comes down in runs: some
// columns start early, and thin ones race ahead of the rest.
fn poured(x: f32, a: f32) -> vec2f {
  let lag = cloudy(vec2f(x * 0.3, 7.0));
  let fine = cloudy(vec2f(x * 1.15, 23.0));
  let since = max(a - 0.3 - 0.9 * lag - 0.15 * fine, 0.0);
  return vec2f(12.0 * since * since + 1.4 * since + 6.0 * since * fine * fine, since);
}

// How far a column of the grey page has run down (x and the answer in tabs),
// a seconds after the tab was taken, and for how long it has been running.
// Some columns give way before others, and here and there a thin run races ahead.
fn melted(x: f32, a: f32) -> vec2f {
  let lag = cloudy(vec2f(x * 0.3, 7.0));
  let fine = cloudy(vec2f(x * 1.15, 23.0));
  let since = max(a - 0.95 - 0.75 * lag - 0.1 * fine, 0.0);
  // Runs: one to every couple of tabs' width, each with its own girth and
  // its own moment, round at the tip the way a run of paint is.
  var runs = 0.0;
  var running = 0.0;
  let cell = floor(x / 3.2);
  for (var i = -1; i <= 1; i++) {
    let id = cell + f32(i);
    let mid = (id + 0.25 + 0.5 * speck(vec2f(id, 67.0))) * 3.2;
    let girth = 0.5 + 0.75 * speck(vec2f(id, 71.0));
    let begun = max(a - 0.95 - 0.9 * speck(vec2f(id, 61.0)), 0.0);
    let across = (x - mid) / girth;
    let round = sqrt(max(1.0 - across * across, 0.0));
    runs = max(runs, (6.5 * begun * begun + 2.0 * begun) * (0.55 + 0.8 * speck(vec2f(id, 73.0))) * round);
    running = max(running, begun * round);
  }
  return vec2f((6.5 * since * since + 1.2 * since) * (0.5 + 0.55 * fine * fine) + runs, max(since, running));
}

// Where the tab's face is, a seconds after the tab was taken: on the tab,
// then up and once round on its way to where the sun is.
fn faceAt(a: f32, seat: vec2f, sun: vec2f, h: f32) -> vec2f {
  let leap = smoothstep(0.2, 1.45, a);
  let way = leap * leap * (3.0 - 2.0 * leap);
  let round = 6.2831853 * leap - 1.5708;
  return mix(seat, sun, way) + 2.8 * h * sin(3.14159 * leap) * vec2f(cos(round), sin(round));
}

// The grey page that lies over the picture, the little tab sitting on it, and
// what happens when the tab is taken: its face leaps up to where the sun is
// and becomes the sun, a hole opens round it rimmed with the poster's rainbow,
// and the page goes soft, takes on colour, and is drawn in and swallowed.
fn front(under: vec3f, p: vec2f, size: vec2f) -> vec3f {
  let TURN = 6.2831853;
  let INK = ${vec3(INK)};
  let a = lens.gate.z;
  let g = lens.beat.x;
  let h = lens.tab.x;
  let u = h / 32.0;
  let look = lens.tab.y;
  let press = lens.beat.z;
  let home = lens.gate.xy;
  let sunR = lens.beat.y;
  // How alive the tab is. Left alone it is as grey as the page, and sits
  // still; it wakes as someone comes near, and once taken it is wide awake.
  let taken = step(0.0001, a);
  let life = max(max(lens.beat.w, look), taken);

  // Where the face is: on the tab, then on its way to the sun.
  let leap = smoothstep(0.2, 1.45, a);
  let way = leap * leap * (3.0 - 2.0 * leap);
  let flying = sin(3.14159 * leap);
  let bob = sin(TURN * g / 3.0) * (0.3 + 0.7 * life);
  let seat = home - vec2f(0.0, 3.0 * u * bob);
  let heart = faceAt(a, seat, lens.sun.xy, h);

  // The hole: first wide enough to show the sun, then, when the sun roars, everything.
  let blast = pow(max(a - 2.5, 0.0) / 1.45, 2.3);
  let reach = step(1.5, a) * (sunR * 2.3 * overshoot((a - 1.5) / 0.8) * (1.0 + 0.03 * sin(a * 10.0)) + blast * length(size) * 1.3);
  let rel = p - heart;
  let far = max(length(rel), 0.001);
  let dir = rel / far;
  let around = atan2(rel.y, rel.x);
  let wavy = 1.0 + 0.06 * sin(around * 12.0 + a * 2.2 + g) + 0.04 * sin(around * 5.0 - a * 3.1) + 0.1 * (cloudy(dir * 2.6 + vec2f(a * 0.9, 4.0)) - 0.5);
  let edge = reach * wavy;
  let thick = (26.0 * smoothstep(1.5, 1.75, a) + 70.0 * smoothstep(1.7, 3.4, a)) * u;
  let past = far - edge;
  if (past < -200.0 * u && a > 2.1) { return under; }

  // The page. It goes in three acts. First a ring runs out from the tab and
  // every word it passes turns into the terminal's script. Then the page
  // goes soft: it shimmers, sags, and begins to run down itself like wax,
  // glossy where it bulges, faster in some places than others, its top edge
  // coming away from the top of the window. Last the sun roars and what is
  // left is blown off.
  let leaving = 1.0 - smoothstep(0.1, 0.7, a);
  let toTab = p - home;
  let off = max(length(toTab), 0.001);
  let bearing = atan2(toTab.y, toTab.x);
  let pulse = life * (0.82 + 0.18 * sin(TURN * g / 2.0)) * (0.6 + 0.95 * look) * leaving + 2.5 * exp(-a * 5.0) * taken;
  let aura = exp(-off / (h * 2.5)) * pulse;
  let soft = smoothstep(0.85, 1.6, a);
  var q = p;
  q += aura * 2.2 * u * vec2f(sin(p.y / (7.0 * u) + TURN * g / 3.0), cos(p.x / (9.0 * u) + TURN * g / 2.0));
  if (a > 0.0) {
    let ring = exp(-pow((off - 1500.0 * u * a) / (50.0 * u), 2.0)) * exp(-1.5 * a);
    q -= toTab / off * 18.0 * u * ring;
    let pull = 30.0 * u * pow(max(a - 1.4, 0.0), 2.0) + 2600.0 * u * blast;
    let twist = 0.25 * smoothstep(1.3, 2.6, a) * exp(-far / (520.0 * u));
    q = heart + spun(twist) * (q - heart + dir * pull * (0.3 + 0.7 * exp(-far / (700.0 * u))));
    // Heat coming off it.
    q += soft * 5.0 * u * vec2f(sin(q.y / (60.0 * u) + g * 4.2 + a * 3.0), cos(q.x / (80.0 * u) + g * 3.1));
    q += soft * (1.0 - smoothstep(1.6, 2.6, a)) * 1.6 * u * vec2f(sin(q.y / (5.0 * u) + a * 23.0), 0.0);
  }
  // How far this column has run, and how that changes from one column to the next.
  let run = melted(q.x / h, a);
  let lower = 0.3 + 0.7 * clamp(q.y / size.y, 0.0, 1.0); // the further down the page, the further it has run
  let step2 = 2.0 * u;
  let slope = (melted((q.x + step2) / h, a).x - melted((q.x - step2) / h, a).x) * h / (2.0 * step2) * lower;
  // Before it runs it sags.
  let limp = 0.65 * cloudy(vec2f(q.x / (64.0 * u), 31.0)) + 0.35 * cloudy(vec2f(q.x / (22.0 * u), 37.0));
  let sag = soft * (0.06 + 0.5 * limp * limp);
  let fallen = q.y - run.x * h * lower;
  let gone = -fallen / sqrt(1.0 + slope * slope);
  let src = vec2f(q.x, fallen / (1.0 + sag) - 26.0 * u * sag);

  // Its words turn into the terminal's script as the ring passes, a block at a time.
  let block = floor(p / (52.0 * u));
  let turns = 0.12 + 0.6 * off / (1000.0 * u) + 0.1 * speck(block + 3.0);
  let flip = clamp((a - turns) / 0.18, 0.0, 1.0);
  let swap = smoothstep(0.3, 0.7, flip);
  let split = dir * (aura * 1.6 + 2.0 * soft) * u;
  var plain = greyPage(src, size, swap);
  if (soft > 0.0) {
    // Going soft, it goes out of focus a little.
    let blur = 1.5 * u * soft;
    plain = 0.4 * plain + 0.15 * (greyPage(src + vec2f(blur, blur), size, swap) + greyPage(src + vec2f(-blur, blur), size, swap) + greyPage(src + vec2f(blur, -blur), size, swap) + greyPage(src - vec2f(blur, blur), size, swap));
  }
  var c = plain;
  if (dot(split, split) > 0.01) { c = vec3f(greyPage(src + split, size, swap).r, plain.g, greyPage(src - split, size, swap).b); }
  let inked = smoothstep(0.075, 0.2, 1.0 - dot(plain, vec3f(0.3333)));
  if (a > 0.0) {
    // As a word turns it flares, and what is written in script is written in the poster's colours.
    let paint = bowAt(src.x / (300.0 * u) + src.y / (520.0 * u) + 0.3 * a);
    let spark = sin(3.14159 * flip);
    c = mix(c, mix(paint * 0.7, INK, 0.35), inked * smoothstep(0.5, 1.0, flip));
    c = mix(c, paint * 1.5 + 0.3, inked * spark * spark);
  }
  // It takes on colour as it softens, more the nearer the hole.
  let pale = dot(c, vec3f(0.3333));
  let close = exp(-max(past - thick, 0.0) / (170.0 * u));
  let dye = bowAt(around / TURN + far / (430.0 * u) - a * 0.45 - g / 6.0 + 0.5 * (1.0 - pale));
  c = mix(c, dye * mix(0.12, 1.12, smoothstep(0.4, 0.92, pale)), clamp(soft * (0.1 + 0.9 * close * step(1.45, a)) * (0.7 + 1.6 * (1.0 - pale)) * (1.0 - inked) + 0.3 * smoothstep(1.6, 2.5, a) + smoothstep(2.5, 3.15, a), 0.0, 1.0));
  // Running, it is wet: light on one shoulder of every run, shade in the fold on the other.
  if (run.y > 0.0) {
    let wet = smoothstep(0.0, 0.35, run.y);
    c *= 1.0 - 0.3 * wet * smoothstep(0.15, 0.9, slope);
    c *= 1.0 + 0.12 * wet * clamp(-slope, 0.0, 1.0);
    c += vec3f(1.0, 0.98, 0.92) * 0.5 * wet * exp(-pow((slope + 0.5) / 0.17, 2.0)) * smoothstep(0.35, 0.7, cloudy(vec2f(q.x / (46.0 * u), fallen / (210.0 * u))));
  }

  // The tab's light on the page: a wash of colour, slow rays, and sparks going radius.
  let rays = pow(0.5 + 0.5 * cos(bearing * 9.0 + TURN * g / 6.0), 6.0) * exp(-off / (h * 4.4)) * 0.3 * pulse;
  // Looked at, it sends rings out over the page.
  let ripple = pow(0.5 + 0.5 * cos(TURN * (off / (h * 1.5) - g * 1.5)), 8.0) * exp(-off / (h * 4.0)) * look * leaving;
  // What is written near it has caught some of the colour.
  let glow = bowAt(bearing / TURN + g / 6.0 + off / (h * 9.0));
  c = mix(c, glow * 0.8, clamp(3.0 * (aura + rays) * (1.0 - pale) * 2.2, 0.0, 0.9));
  c = mix(c, glow * 1.1, clamp(0.78 * aura + rays + 0.5 * ripple, 0.0, 0.9));
  for (var i = 0; i < 9; i++) {
    let f = f32(i);
    let orbit = TURN * (f / 9.0 + g / 15.0 * (1.0 + f32(i % 3)) * select(-1.0, 1.0, i % 2 == 0));
    let ringR = h * (2.1 + 0.55 * sin(TURN * (g / 5.0 + f * 0.37)) + 0.22 * f32(i % 4)) * (1.0 + 3.0 * smoothstep(0.0, 0.6, a));
    let twinkle = pow(0.5 + 0.5 * sin(TURN * (g / 2.0 + f * 0.61)), 2.0);
    let s = (p - home - ringR * vec2f(cos(orbit), 0.82 * sin(orbit))) / (h * (0.1 + 0.2 * twinkle));
    let star = smoothstep(0.0, 0.3, 1.0 - sqrt(abs(s.x)) - sqrt(abs(s.y)));
    c = mix(c, mix(vec3f(1.0), bowAt(f / 9.0 + g / 6.0), 0.45) * 1.15, star * life * (leaving + taken * (1.0 - smoothstep(0.5, 0.9, a))) * (0.5 + 0.5 * twinkle));
  }

  // The page's own top edge, as it comes away and runs down: thick, wet, and in the poster's colours.
  if (run.y > 0.0) {
    let lip = 30.0 * u * smoothstep(0.0, 0.45, run.y);
    let lane = clamp(-gone / max(lip, 0.001), 0.0, 0.9999) * 4.0;
    var brim = bowAt((floor(lane) + 0.5) / 6.0 + 0.16 + 0.1 * a);
    brim = mix(brim, INK, smoothstep(1.3 * u, 0.5 * u, (0.5 - abs(fract(lane) - 0.5)) / 4.0 * lip));
    brim = mix(brim, INK, smoothstep(3.0 * u, 2.0 * u, min(-gone, lip + gone)));
    brim += vec3f(1.0, 0.98, 0.92) * 0.35 * exp(-pow((slope + 0.42) / 0.16, 2.0));
    let outside = smoothstep(-0.7, 0.7, past);
    c = mix(c, brim, smoothstep(-lip - 0.7, -lip + 0.7, gone) * smoothstep(0.0, 0.12, run.y) * outside);
    // Above that edge there is no picture yet. Paint in the poster's colours pours down after the page,
    // band over band, wider the further up, and only the hole shows what is behind it all.
    if (gone > -0.7) {
      let deep = max(gone, 0.0) / max(lip, 0.001);
      let band = 3.0 * log2(1.0 + deep);
      let girth = 0.231 * lip * (1.0 + deep); // how wide a band is just here
      var pour = bowAt((-floor(band) - 0.5) / 6.0 + 0.16 + 0.1 * a);
      // Wet, like the page it follows: a light down one shoulder of every run and shade in the fold of the other.
      pour *= 1.0 - 0.22 * smoothstep(0.15, 0.9, slope);
      pour += vec3f(1.0, 0.98, 0.92) * 0.3 * exp(-pow((slope + 0.42) / 0.16, 2.0)) * smoothstep(0.3, 0.75, cloudy(vec2f(q.x / (46.0 * u), gone / (190.0 * u) - 0.6 * a)));
      pour = mix(pour, INK, smoothstep(1.4 * u, 0.6 * u, (0.5 - abs(fract(band) - 0.5)) * girth));
      c = mix(c, pour, smoothstep(-0.7, 0.7, gone));
    }
  }

  // The tab: a square of blotter paper with a perforated edge, a spiral printed on it, turning.
  let fall = max(a - 0.2, 0.0);
  if (fall < 1.3) {
    let tilt = -0.14 + 0.05 * sin(TURN * g / 5.0) + 0.09 * look * sin(TURN * g * 2.0) + 6.0 * fall;
    let grown = (1.0 + 0.16 * look) * (1.0 - 0.14 * press) * (1.0 - 0.2 * sin(3.14159 * clamp(a / 0.2, 0.0, 1.0))) * (1.0 + 1.6 * fall);
    let sheet = seat + vec2f(70.0 * u * fall, (900.0 * fall - 160.0) * u * fall);
    // Its shadow on the page.
    let lying = (p - seat - vec2f(0.0, h * 1.3 + 3.0 * u * bob)) / vec2f(h * 1.05, h * 0.26);
    c *= 1.0 - 0.24 * exp(-dot(lying, lying)) * (1.0 - smoothstep(0.0, 0.25, fall));
    let l = spun(-tilt) * (p - sheet) / (h * grown);
    let b = abs(l);
    let along = select(l.x, l.y, b.x > b.y);
    let paper = (length(max(b - 0.9, vec2f(0.0))) + min(max(b.x, b.y) - 0.9, 0.0) - 0.1 + 0.03 * cos(along * 3.14159 * 9.0)) * h * grown;
    // It has a little thickness, seen from just above.
    let under2 = spun(-tilt) * (p - sheet - vec2f(0.0, 0.085 * h * grown)) / (h * grown);
    let lower = (length(max(abs(under2) - 0.9, vec2f(0.0))) + min(max(abs(under2).x, abs(under2).y) - 0.9, 0.0) - 0.1) * h * grown;
    c = mix(c, vec3f(0.6, 0.56, 0.5), smoothstep(0.75, -0.75, lower) * (1.0 - smoothstep(0.9, 1.3, fall)));
    if (paper < 1.5) {
      var card = mix(vec3f(0.95), vec3f(0.985, 0.96, 0.9), life) * (0.95 + 0.06 * cloudy(l * 7.0 + 3.0));
      card = mix(card, vec3f(0.78, 0.74, 0.68), smoothstep(-0.07 * h, 0.0, paper) * step(0.0, l.y + l.x * 0.3));
      let rho = length(l);
      let bend = log(rho + 0.06) * 1.35 - atan2(l.y, l.x) / TURN * 2.0 - g / 3.0 + 0.05 * sin(atan2(l.y, l.x) * 6.0 + TURN * g / 2.0);
      let band = fract(bend) * 6.0;
      var art = bowAt((floor(band) + 0.5) / 6.0) * 1.06;
      art = mix(art, INK, smoothstep(1.0 * u, 0.4 * u, (0.5 - abs(fract(band) - 0.5)) / 6.0 * (rho + 0.06) / 1.35 * h * grown));
      art = mix(vec3f(dot(art, vec3f(0.3, 0.59, 0.11)) * 0.75 + 0.2), art, life); // printed in greys until someone comes near
      let frame = (max(b.x, b.y) - 0.8) * h * grown;
      card = mix(card, art, smoothstep(0.7, -0.7, frame));
      card = mix(card, INK, smoothstep(1.4 * u, 0.6 * u, abs(frame)));
      card += 0.4 * life * exp(-pow((l.x + 0.6 * l.y - (fract(g / 3.0) * 6.0 - 3.0)) / 0.2, 2.0));
      c = mix(c, card, smoothstep(0.75, -0.75, paper) * (1.0 - smoothstep(0.9, 1.3, fall)));
    }
  }

  // The face: on the tab a smiley, in the sky the sun.
  let shown = 1.0 - smoothstep(2.2, 2.4, a);
  if (shown > 0.0) {
    let size0 = h * 0.62 * (1.0 + 0.16 * look) * (1.0 - 0.14 * press) * (1.0 - 0.2 * sin(3.14159 * clamp(a / 0.2, 0.0, 1.0)));
    let radius = mix(size0, sunR * 0.98, overshoot((a - 0.2) / 1.25) * taken * step(0.2, a));
    // On its way it leaves itself behind in every colour.
    if (flying > 0.001) {
      for (var i = 5; i >= 1; i--) {
        let before = a - 0.06 * f32(i);
        let then = smoothstep(0.2, 1.45, before);
        let was = faceAt(before, seat, lens.sun.xy, h);
        let wasR = mix(size0, sunR * 0.98, overshoot((before - 0.2) / 1.25) * step(0.2, before)) * (1.0 - 0.09 * f32(i)) * smoothstep(0.0, 0.25, sin(3.14159 * then));
        let ghost = length(p - was) - wasR;
        c = mix(c, INK, smoothstep(0.7, -0.7, ghost - 1.8 * u) * step(0.5, wasR));
        c = mix(c, bowAt(f32(i) / 6.0 + a * 0.8) * 1.05, smoothstep(0.7, -0.7, ghost) * step(0.5, wasR));
      }
    }
    let lean = mix((-0.14 + 0.05 * sin(TURN * g / 5.0)) * (0.3 + 0.7 * life) + 0.09 * look * sin(TURN * g * 2.0), 0.0, way) + TURN * way;
    let m = spun(-lean) * (p - heart) / radius;
    let line = max(1.6 * u, 0.045 * radius);
    // It puts out rays as it goes: by the time it lands it is a sun.
    let grow = smoothstep(0.3, 1.0, leap) * (1.0 + 0.12 * sin(3.14159 * smoothstep(0.75, 1.0, leap)));
    if (grow > 0.0) {
      let about = atan2(m.y, m.x) + 0.4 * sin(a * 3.0) * (1.0 - leap);
      let petal = pow(abs(cos(8.0 * about)), 0.55);
      let ray = (length(m) - 1.0 - grow * (0.25 + 1.2 * petal)) * radius;
      var beam = vec3f(0.97, 0.63, 0.14);
      beam = mix(beam, vec3f(0.95, 0.42, 0.13), smoothstep(0.93, 0.96, abs(cos(8.0 * about))) * smoothstep(1.2, 1.3, length(m)));
      c = mix(c, INK, smoothstep(0.7, -0.7, ray - line) * shown);
      c = mix(c, beam, smoothstep(0.7, -0.7, ray) * shown);
    }
    let disc = (length(m) - 1.0) * radius;
    if (disc < 2.0 * u + 1.0) {
      var face = vec3f(0.99, 0.77, 0.19) * (1.07 - 0.17 * smoothstep(-0.5, 1.0, m.y + 0.3 * m.x));
      face = mix(face, vec3f(1.0, 0.97, 0.8), 0.5 * smoothstep(0.34, 0.1, length((m - vec2f(-0.38, -0.46)) * vec2f(1.0, 1.7))));
      face = mix(face, vec3f(0.95, 0.42, 0.45), (0.55 + 0.25 * look) * life * (1.0 - way) * smoothstep(0.17 + 0.05 * look, 0.08, length(vec2f(abs(m.x) - 0.6 - 0.08 * look, m.y - 0.2 + 0.2 * look))));
      face = mix(vec3f(dot(face, vec3f(0.3, 0.59, 0.11)) * 0.86 + 0.1), face, life); // grey until someone comes near
      // It looks at whoever is there, and now and then it blinks. Its pupils
      // are small while it is left alone and enormous once it is not; on its
      // way to the sky they are whirlpools.
      let gaze = clamp((lens.tab.zw - heart) / (h * 6.0), vec2f(-1.0), vec2f(1.0)) * 0.06 * (1.0 - way) * life;
      let wink = fract(g / 3.0 + 0.4);
      let shut = smoothstep(0.0, 0.02, wink) * (1.0 - smoothstep(0.035, 0.07, wink)) * (1.0 - look) * (1.0 - taken);
      let glad = smoothstep(0.0, 0.25, a) * (1.0 - 0.75 * smoothstep(0.8, 1.0, leap));
      let wide = (1.0 + 0.3 * flying) * mix(1.0, 0.62, smoothstep(0.8, 1.0, leap));
      let e = vec2f(abs(m.x - gaze.x) - mix(0.32 - 0.03 * look, 0.37, way), m.y - gaze.y + mix(0.17 + 0.05 * look, 0.2, way));
      // Black dots. Looked at, they grow big and wet; taken, they blow wide open.
      let blown = smoothstep(0.0, 0.25, a);
      let bright = max(look, blown);
      let socket = vec2f(mix(0.075, 0.1, life), mix(0.095, 0.125, life) * (1.0 - 0.9 * shut)) * mix(1.0, 1.55, look) * mix(1.0, 1.75 - 0.55 * look, blown) * wide;
      let within = length(e / socket);
      let eye = (within - 1.0) * socket.x * radius;
      var ball = vec3f(0.02, 0.015, 0.02);
      // A thin ring of iris is all that is left round the pupil, and it turns.
      let spoke = atan2(e.y, e.x * sign(m.x - gaze.x));
      ball = mix(ball, bowAt(spoke / TURN + g / 3.0) * 0.95, blown * smoothstep(0.78, 0.86, within));
      let whirl = fract(log(within + 0.04) * 1.1 - spoke / TURN - a * 2.2) * 6.0;
      var pool = bowAt((floor(whirl) + 0.5) / 6.0);
      pool = mix(pool, INK, smoothstep(0.12, 0.04, 0.5 - abs(fract(whirl) - 0.5)));
      ball = mix(ball, pool, flying * smoothstep(0.1, 0.3, flying));
      face = mix(face, INK, smoothstep(0.7, -0.7, eye - line * 0.35 * life));
      face = mix(face, ball, smoothstep(0.7, -0.7, eye));
      let glint = (length(e - socket * vec2f(0.34 * sign(m.x - gaze.x), -0.38)) - socket.x * mix(0.3, 0.36, life)) * radius;
      let glint2 = (length(e + socket * vec2f(0.3 * sign(m.x - gaze.x), -0.42)) - socket.x * 0.15) * radius;
      face = mix(face, vec3f(1.0), smoothstep(0.7, -0.7, min(glint, glint2)) * bright * (1.0 - 0.8 * flying));
      // A small polite smile. Looked at, it does not open: it spreads, and
      // goes on spreading, until it is most of the way round the face. Taken, it falls open.
      let mm = m - vec2f(gaze.x * 0.5, 0.06 + gaze.y * 0.5);
      let settled = smoothstep(0.7, 1.0, leap);
      let grinR = mix(mix(0.3, 0.44, life), 0.61, look) * mix(1.0, 0.4, settled);
      let grinAt = vec2f(gaze.x * 0.5, mix(mix(0.12, 0.07, life), -0.02, look) + 0.2 * settled + gaze.y * 0.5);
      let span = mix(mix(0.7, 1.05, life), 2.0, look);
      let gm = m - grinAt;
      let end = grinAt + grinR * vec2f(sin(span) * select(-1.0, 1.0, gm.x > 0.0), cos(span));
      let grin = (select(length(m - end), abs(length(gm) - grinR), abs(atan2(gm.x, gm.y)) < span) - mix(0.05, 0.068, look)) * radius;
      let gape = max(length(mm * vec2f(1.0, mix(1.6, 1.0, glad))) - 0.52 * mix(0.45, 1.0, glad), 0.14 - mm.y) * radius;
      var mouth = mix(vec3f(0.33, 0.05, 0.1), vec3f(0.95, 0.4, 0.5), smoothstep(0.7, -0.7, (length(mm - vec2f(0.0, 0.62)) - 0.27) * radius));
      face = mix(face, mouth, smoothstep(0.7, -0.7, gape) * glad);
      face = mix(face, INK, smoothstep(line * 0.5 + 0.7, line * 0.5 - 0.7, abs(gape)) * glad);
      face = mix(face, INK, smoothstep(0.7, -0.7, grin) * (1.0 - glad));
      face = mix(face, INK, smoothstep(line + 0.7, line - 0.7, abs(disc)) * step(disc, 0.0) + smoothstep(0.7, -0.7, disc) * smoothstep(-line - 0.7, -line + 0.7, disc));
      c = mix(c, face, smoothstep(0.75, -0.75, disc) * shown);
    }
  }
  // The sky opens out of the middle of the face: the rim runs out through
  // it and through its rays, and what is inside is the sun itself.
  // The rim of the hole: the rainbow under the title, inked on both sides.
  if (a > 1.5) {
    let lane = clamp(past / thick + 0.035 * sin(around * 9.0 + g * 2.0), 0.0, 0.9999) * 6.0;
    var rim = bowAt((floor(lane) + 0.5) / 6.0 + 0.5);
    rim = mix(rim, INK, smoothstep(1.3 * u, 0.5 * u, (0.5 - abs(fract(lane) - 0.5)) / 6.0 * thick));
    rim = mix(rim, INK, smoothstep(3.2 * u, 2.2 * u, min(past, thick - past)));
    // Its light falls on the page round it,
    c += vec3f(1.0, 0.9, 0.66) * 0.2 * exp(-max(past - thick, 0.0) / (52.0 * u)) * smoothstep(1.5, 1.8, a);
    c = mix(c, rim, smoothstep(thick + 0.7, thick - 0.7, past));
    // and the sheet it is cut through shades what is just inside it: a hole, not a picture stuck on.
    let shade = 1.0 - 0.5 * exp(past / (30.0 * u)) * (1.0 - smoothstep(3.0, 3.7, a));
    c = mix(c, under * shade, smoothstep(0.7, -0.7, past));
  }
  // The flash as it is taken, and again as the face lands in the sky.
  c += vec3f(1.0, 0.95, 0.85) * 0.9 * exp(-a * 9.0) * taken * exp(-off / (h * 5.0));
  c += vec3f(1.0, 0.92, 0.7) * 0.5 * exp(-max(a - 1.5, 0.0) * 6.0) * step(1.5, a) * exp(-far / (sunR * 2.4));
  return c;
}

// How far a column of the notice has run down the picture, b seconds into its
// burning: x is how far along the card the column is (0 to 1), near where the
// lasers landed, wide the card's width. Gives the run in card heights and the
// seconds it has been running. The columns nearest the lasers go first, and
// thin ones race ahead of the rest.
fn slumped(x: f32, near: f32, wide: f32, b: f32) -> vec2f {
  let lag = cloudy(vec2f(x * wide * 0.02, 7.0));
  let fine = cloudy(vec2f(x * wide * 0.075, 23.0));
  let since = max(b - 0.55 - 2.3 * abs(x - near) - 0.45 * lag - 0.15 * fine, 0.0);
  return vec2f((1.05 * since * since + 0.16 * since) * (0.65 + 0.7 * fine * fine), since);
}

// The notice NormalScript puts up over the picture (lens.acts[2] and [3]):
// a grey card pinned to the middle of the bottom edge, and the greyness that
// seeps out of it a block at a time, taking the picture's colours and its
// wobble; the sun keeps it off itself. Then the lasers land on the card. A
// hole burns out through it from where they land, rimmed with the poster's
// rainbow; what is printed on it takes colour and runs like wax; column by
// column it slides off the bottom; and colour floods back over the grey from
// the same place, for a while brighter than it was.
fn notice(under: vec3f, p: vec2f, size: vec2f) -> vec3f {
  let TURN = 6.2831853;
  let INK = ${vec3(INK)};
  let k = lens.frame.y;
  let t = lens.frame.x;
  let dome = lens.acts[2].x;   // how far round the sun the greyness is kept off, as the sun's radius
  let card = lens.acts[2].zw;  // the card's width and height
  let corner = vec2f(0.5 * (size.x / k - card.x), lens.acts[2].y); // its top left corner
  let reach = lens.acts[3].x;  // how far from the card the greyness has got
  let b = lens.acts[3].y;      // seconds the card has been burning
  let hit = lens.acts[3].zw;   // where the lasers landed on it
  let d = p / k;
  var c = under;

  let rel = d - hit;
  let far = max(length(rel), 0.001);
  let around = atan2(rel.y, rel.x);
  var wavy = 1.0;
  if (b > 0.0) { wavy += 0.06 * sin(around * 9.0 + b * 2.2 + t) + 0.045 * sin(around * 5.0 - b * 3.1) + 0.12 * (cloudy(rel / far * 2.6 + vec2f(b * 0.9, 4.0)) - 0.5); }
  // How far behind the returning colour's front this place is.
  let won = 20.0 + 150.0 * b + 80.0 * b * b - far / wavy;

  // The greyness.
  let cell = 13.0;
  let block = floor(d / cell);
  let drift = vec2f(3.0, t * 0.04);
  let o = abs((block + 0.5) * cell - corner - 0.5 * card) - 0.5 * card;
  let taken = reach - length(max(o, vec2f(0.0))) - min(max(o.x, o.y), 0.0) - 84.0 * cloudy(block * 0.085 + drift) - 22.0 * speck(block + 11.0);
  var grey = smoothstep(0.0, 16.0, taken) * smoothstep(dome * 1.3, dome * 2.0 + 0.001, length(p - lens.sun.xy) / k);
  if (b > 0.0) { grey *= smoothstep(14.0, -50.0, won); }
  if (grey > 0.0) {
    // What it has taken is the same picture drawn straight, with no colour in
    // it; and the longer it has had it, the paler.
    let plain = min(textureSampleLevel(sourceMap, bilinear, p / size, 0.0).rgb, vec3f(1.0));
    let tone = dot(plain, vec3f(0.3, 0.59, 0.11));
    let u = abs(d - corner - 0.5 * card) - 0.5 * card;
    let depth = reach - length(max(u, vec2f(0.0))) - min(max(u.x, u.y), 0.0) - 84.0 * cloudy(d / cell * 0.085 + drift) - 22.0;
    let deep = smoothstep(0.0, 180.0, depth);
    var dull = mix(tone, 0.95 - 0.34 * (1.0 - tone), 0.85 * deep);
    // It rules the picture into squares, plainest where it has only just taken them.
    let seam = abs(fract(d / cell) - 0.5);
    dull *= 1.0 - (0.035 + 0.075 * (1.0 - smoothstep(0.0, 70.0, depth))) * smoothstep(0.5 - 1.3 / (cell * min(k, 1.5)), 0.5 - 0.3 / (cell * min(k, 1.5)), max(seam.x, seam.y));
    c = mix(c, vec3f(dull), grey);
  }
  if (b > 0.0) {
    // Colour comes back from where the lasers landed, brighter than it was, behind a ring of light.
    let ease = 1.0 - smoothstep(2.3, 3.6, b);
    let fresh = smoothstep(-20.0, 26.0, won) * exp(-max(won, 0.0) / 200.0) * ease * smoothstep(0.0, 0.3, b);
    let tone = dot(c, vec3f(0.3, 0.59, 0.11));
    c = (vec3f(tone) + (c - tone) * (1.0 + 0.6 * fresh)) * (1.0 + 0.12 * fresh);
    c += bowAt(around / TURN * 2.0 + 0.4 * b) * 0.2 * exp(-pow(won / 24.0, 2.0)) * ease * smoothstep(0.0, 0.3, b);
  }

  // The card.
  let local = d - corner;
  if (local.x < -40.0 || local.x > card.x + 40.0 || local.y < -40.0) { return c; }
  // Its shadow on the picture.
  let lie = abs(local - 0.5 * card - vec2f(0.0, 7.0)) - 0.5 * card + 6.0;
  let shade = length(max(lie, vec2f(0.0))) + min(max(lie.x, lie.y), 0.0) - 6.0;
  c *= 1.0 - 0.3 * (1.0 - smoothstep(-8.0, 26.0, shade)) * (1.0 - smoothstep(0.1, 1.4, b));

  // Burning, each column of it slides down and is drawn out long, like wax;
  // before a column goes, it is already sagging.
  var q = local;
  var gone = -1.0e4; // how far above the top edge of what is left of its column this place is
  var run = vec2f(0.0);
  let soft = smoothstep(0.0, 0.8, b);
  if (b > 0.0) {
    let near = (hit.x - corner.x) / card.x;
    let x = local.x / card.x;
    run = slumped(x, near, card.x, b);
    let lean = (slumped(x + 3.0 / card.x, near, card.x, b).x - slumped(x - 3.0 / card.x, near, card.x, b).x) * card.y / 6.0;
    gone = (run.x * card.y - local.y) / sqrt(1.0 + lean * lean);
    let limp = 0.65 * cloudy(vec2f(local.x / 30.0, 31.0)) + 0.35 * cloudy(vec2f(local.x / 10.0, 37.0));
    let sag = smoothstep(0.1, 1.6, b) * (0.03 + 0.34 * limp * limp);
    q.x += soft * 2.2 * sin(local.y / 13.0 + t * 3.1 + b * 3.0);
    q.y = (local.y - 0.5 * run.x * card.y) / (1.0 + 0.8 * run.y + sag);
  }
  let e = abs(q - 0.5 * card) - 0.5 * card + 6.0;
  let sd = length(max(e, vec2f(0.0))) + min(max(e.x, e.y), 0.0) - 6.0;
  // The hole the lasers have burnt in it.
  let past = far - (22.0 * overshoot(b / 0.3) + 34.0 * b + 34.0 * b * b) * wavy;
  let thick = 11.0 + 21.0 * smoothstep(0.2, 1.8, b);
  var cover = smoothstep(0.75, -0.75, sd * k);
  if (b > 0.0) { cover *= smoothstep(0.75, -0.75, gone * k) * smoothstep(-0.75, 0.75, past * k); }

  if (cover > 0.001) {
    // What is printed on it: the wide card at the top of the art, the narrow one under it.
    let art = select(vec4f(0.0, 0.0, 640.0, 168.0), vec4f(0.0, 180.0, 560.0, 296.0), card.y > 0.4 * card.x);
    var face = vec3f(0.0);
    for (var i = 0; i < 4; i++) {
      let tap = clamp(q + (vec2f(f32(i % 2), f32(i / 2)) - 0.5) * 0.5 / k, vec2f(0.5), card - 0.5);
      face += 0.25 * textureSampleLevel(noticeMap, bilinear, (art.xy + tap * art.zw / card) / vec2f(640.0, 480.0), 0.0).rgb;
    }
    face = mix(face, vec3f(0.85), smoothstep(-1.0 - 0.5 / k, -1.0 + 0.5 / k, sd));
    if (b > 0.0) {
      // What is printed takes the poster's colours, the nearest to the hole first;
      // then the card does, most of all near the hole and where it has begun to run.
      let pale = dot(face, vec3f(0.3333));
      let inked = smoothstep(0.075, 0.2, 1.0 - pale);
      let turns = 0.12 + 1.5 * far / card.x + 0.25 * cloudy(local / 40.0);
      let paint = bowAt(q.x / 150.0 + q.y / 260.0 + 0.3 * b);
      face = mix(face, mix(paint * 0.7, INK, 0.35), inked * smoothstep(turns, turns + 0.45, b));
      let close = exp(-max(past - thick, 0.0) / 70.0);
      let dye = bowAt(around / TURN + far / 215.0 - b * 0.45 + 0.5 * (1.0 - pale));
      face = mix(face, dye * mix(0.12, 1.12, smoothstep(0.4, 0.92, pale)), clamp(smoothstep(0.0, 0.5, b) * (0.05 + 0.95 * close) * (0.7 + 1.6 * (1.0 - pale)) * (1.0 - inked) + 0.7 * smoothstep(0.0, 0.8, run.y) + 0.6 * smoothstep(0.7, 2.4, b), 0.0, 1.0));
      // Going soft, it is inked round like everything else in the picture.
      face = mix(face, INK, soft * smoothstep(-3.4, -2.2, sd));
      // The rim of the hole: the poster's rainbow, inked on both sides.
      if (past < thick + 2.0) {
        let lane = clamp(past / thick + 0.035 * sin(around * 9.0 + t * 2.0), 0.0, 0.9999) * 4.0;
        var rim = bowAt((floor(lane) + 0.5) / 6.0 + 0.5) * 1.08;
        rim = mix(rim, INK, smoothstep(1.2, 0.5, (0.5 - abs(fract(lane) - 0.5)) / 4.0 * thick));
        rim = mix(rim, INK, smoothstep(2.6, 1.8, min(past, thick - past)));
        face = mix(face, rim, smoothstep(thick + 0.75 / k, thick - 0.75 / k, past));
      }
      // The top edge of a column that is running: the same rainbow.
      if (run.y > 0.0) {
        let lip = 20.0 * smoothstep(0.0, 0.45, run.y);
        let lane = clamp(-gone / max(lip, 0.001), 0.0, 0.9999) * 3.0;
        var rim = bowAt((floor(lane) + 0.5) / 6.0 + 0.16 + 0.1 * b);
        rim = mix(rim, INK, smoothstep(1.2, 0.5, (0.5 - abs(fract(lane) - 0.5)) / 3.0 * lip));
        rim = mix(rim, INK, smoothstep(2.6, 1.8, min(-gone, lip + gone)));
        face = mix(face, rim, smoothstep(-lip - 0.75 / k, -lip + 0.75 / k, gone) * smoothstep(0.0, 0.12, run.y));
      }
    }
    c = mix(c, face, cover);
  }
  if (b > 0.0) {
    // The edge of the hole glows while the lasers are on it, and there is a flash as they land.
    let alight = smoothstep(0.0, 0.12, b) * (1.0 - smoothstep(1.5, 2.8, b));
    c += vec3f(1.0, 0.7, 0.28) * 0.75 * alight * exp(-abs(past) / 13.0) * (1.0 - smoothstep(0.0, 40.0, shade));
    c += vec3f(1.0, 0.95, 0.85) * 0.9 * smoothstep(0.0, 0.07, b) * exp(-b * 6.0) * exp(-far / 60.0);
  }
  return c;
}

// The dive into the terminal's screen. Outside it the picture is as ever.
// Inside it is the same picture as the terminal has it: every place is a sign
// of its script, more of the sign written the brighter the place, lit in
// phosphor on a tube. One goes in through the glass, and out through the glass
// of the terminal that is walking about in there.

// The glass of the terminal: half its width and height and how round its corners are, in the terminal's units.
const DIVE_GLASS = vec3f(${f(MACHINE.glass.half[0] - 0.035)}, ${f(MACHINE.glass.half[1] - 0.035)}, 0.035);
// One sign's place on the tube, in design units.
const DIVE_CELL = vec2f(10.0, 12.5);

// How far outside the edge of a box with round corners p is.
fn diveBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let e = abs(p) - half + r;
  return length(max(e, vec2f(0.0))) + min(max(e.x, e.y), 0.0) - r;
}

// A sign of the script, as the terminal writes them: strokes between the
// points of a three by four grid. much is how much of it has been written:
// the first stroke comes with very little light, the fifth needs nearly all
// there is. p is in the sign's own box. Returns the distance to the writing.
fn diveSign(p0: vec2f, seed: f32, much: f32) -> f32 {
  var p = p0;
  if (speck(vec2f(seed, 70.0)) > 0.5) { p.x = 0.5 - abs(p.x - 0.5); }
  if (speck(vec2f(seed, 72.0)) > 0.7) { p.y = 1.0 - p.y; }
  var best = 1e9;
  for (var i = 0; i < 5; i++) {
    let shown = smoothstep(0.0, 0.16, much - 0.03 - 0.17 * f32(i));
    if (shown <= 0.0) { break; }
    let k = f32(i) * 3.1;
    let a = vec2f(floor(speck(vec2f(seed, k)) * 3.0), floor(speck(vec2f(seed, k + 1.0)) * 4.0));
    let way = i32(speck(vec2f(seed, k + 2.0)) * 4.0);
    let b = clamp(a + select(select(select(vec2f(1.0, -1.0), vec2f(1.0, 1.0), way == 2), vec2f(0.0, 1.0), way == 1), vec2f(1.0, 0.0), way == 0), vec2f(0.0), vec2f(2.0, 3.0));
    let start = a * vec2f(0.5, 0.3333);
    let run = b * vec2f(0.5, 0.3333) - start;
    let off = p - start;
    let sort = speck(vec2f(seed, k + 2.6));
    var d = 0.0;
    if (sort < 0.5 || dot(run, run) < 0.001) {
      d = length(off - run * clamp(dot(off, run) / max(dot(run, run), 1e-5), 0.0, 1.0));
    } else if (sort < 0.76) {
      let mid = start + run * 0.5;
      let side = dot(p - mid, vec2f(-run.y, run.x)) * select(-1.0, 1.0, sort < 0.63);
      d = select(min(length(off), length(p - start - run)), abs(length(p - mid) - length(run) * 0.5), side >= 0.0);
    } else if (sort < 0.9) {
      d = min(max(length(p - start - run) - 0.045, 0.0), length(off - run * clamp(dot(off, run) / max(dot(run, run), 1e-5), 0.0, 0.5)));
    } else {
      d = abs(length(p - start - run * 0.5) - 0.1);
    }
    best = min(best, d + (1.0 - shown) * 0.14);
  }
  return best;
}

// The picture on the terminal's tube. p is the place in the picture, in
// pixels; seen is how many pixels of the screen a pixel of the picture takes
// just now (the signs are only drawn when they are big enough to be seen).
fn tube(p: vec2f, size: vec2f, seen: f32) -> vec3f {
  let scale = lens.frame.y;
  let t = lens.frame.x;
  let centre = 0.5 * size;
  let m = (p - centre) / centre;
  let cell = DIVE_CELL * scale;
  let id = floor(p / cell);
  let f = fract(p / cell);
  let fine = smoothstep(2.4, 6.0, cell.x * seen);

  // What the picture is in this sign's place.
  let uv = mix(p, (id + 0.5) * cell, fine) / size;
  let reach = max(cell * 0.25, vec2f(0.5 / seen)) / size;
  var shade = 0.25 * (
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(-1.0, -1.0), 0.0).rgb +
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(1.0, -1.0), 0.0).rgb +
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(-1.0, 1.0), 0.0).rgb +
    textureSampleLevel(sourceMap, bilinear, uv + reach * vec2f(1.0, 1.0), 0.0).rgb
  );
  let spilt = textureSampleLevel(glowMap, bilinear, p / size, 0.0).rgb;
  shade = min(shade, vec3f(1.2)) + 0.35 * spilt;
  let much = smoothstep(0.07, 1.0, dot(shade, vec3f(0.3, 0.59, 0.11)));
  // And what it is at this very point: the signs are lit by the picture
  // itself, so a pen line still crosses them as a line.
  let here = mix(shade, min(textureSampleLevel(sourceMap, bilinear, p / size, 0.0).rgb, vec3f(1.2)) + 0.35 * spilt, fine);
  let light = smoothstep(0.07, 1.0, dot(here, vec3f(0.3, 0.59, 0.11)));

  // Phosphor: green, amber where the picture is warm, and a little of the poster's own colour in it.
  let pure = here / max(max(here.r, max(here.g, here.b)), 0.05);
  let warm = smoothstep(0.15, 0.7, here.r - here.b);
  var glow = mix(vec3f(0.3, 1.0, 0.48), vec3f(1.0, 0.72, 0.22), warm);
  glow = mix(glow, pure * pure, 0.34);

  // The sign. Every so often a place writes itself another.
  var ink = 0.0;
  var halo = 0.0;
  if (fine > 0.0) {
    let unit = min(cell.x / 1.34, cell.y / 1.5);
    let gp = (f - 0.5) * cell / unit + 0.5;
    let soft = 0.8 / (unit * seen);
    let luck = speck(id + 11.0);
    let age = t * (0.1 + 0.22 * luck) + luck * 40.0;
    let turn = fract(age);
    let thick = 0.04 + 0.075 * much;
    var d = diveSign(gp, 1.0 + 800.0 * speck(id + vec2f(3.0, 7.13 * floor(age))), much);
    if (turn < 0.1) {
      let old = diveSign(gp, 1.0 + 800.0 * speck(id + vec2f(3.0, 7.13 * (floor(age) - 1.0))), much);
      d = mix(old, d, smoothstep(0.0, 0.1, turn));
    }
    ink = smoothstep(soft, -soft, d - thick);
    // Its glow stays in its own place.
    let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    halo = exp(-max(d - thick, 0.0) / 0.2) * smoothstep(0.0, 0.3, edge);
  }
  let lit = mix(0.5 * much, ink + 0.3 * halo * much, fine);
  var c = glow * (0.04 + 0.27 * light * light + 0.3 * smoothstep(0.85, 1.1, light)) + glow * lit * (0.5 + 0.95 * light);
  c += here * vec3f(0.5, 0.95, 0.6) * 0.1 + spilt * glow * 0.3;

  // The prompt: a line of script along the bottom, twice the size, being
  // written a sign at a time, and its cursor.
  let big = 2.0 * cell;
  let floor0 = size.y - 3.1 * big.y;
  let lane = vec2f(p.x - 2.0 * big.x, p.y - floor0) / big;
  c *= 1.0 - 0.72 * smoothstep(-0.7, 0.0, lane.y);
  if (fine > 0.0 && lane.y > 0.0 && lane.y < 1.0 && lane.x > 0.0) {
    let unit = min(big.x / 1.34, big.y / 1.5);
    let gp = (fract(lane) - 0.5) * big / unit + 0.5;
    let soft = 0.8 / (unit * seen);
    let spell = t / 8.0;
    let line = floor(spell);
    let since = fract(spell) * 8.0;
    let written = min(since * 7.0, 5.0 + floor(speck(vec2f(line, 5.0)) * 9.0));
    let going = smoothstep(0.0, 0.3, since) * (1.0 - smoothstep(7.3, 7.9, since));
    let col = floor(lane.x);
    var mark = 0.0;
    var tint = vec3f(0.55, 1.0, 0.6) * 1.35;
    if (col == 0.0) {
      // It opens with a sign in a colour of its own, as the terminal's lines do.
      tint = (0.55 + 0.45 * cos(6.2831853 * (speck(vec2f(line, 9.0)) + vec3f(0.0, 0.33, 0.67)))) * 1.6;
      mark = smoothstep(soft, -soft, diveSign(gp, 300.0 + line, 1.0) - 0.085);
    } else if (col >= 2.0 && col - 2.0 < written) {
      if (speck(vec2f(col, line + 0.5)) > 0.16) {
        mark = clamp(written - (col - 2.0), 0.0, 1.0) * smoothstep(soft, -soft, diveSign(gp, 20.0 + col * 1.7 + line * 13.0, 1.0) - 0.075);
      }
    } else if (col - 2.0 == ceil(written)) {
      mark = smoothstep(soft, -soft, diveBox(gp - 0.5, vec2f(0.4, 0.56), 0.06)) * (0.5 + 0.5 * smoothstep(-0.25, 0.25, sin(t * 7.0)));
    }
    c = mix(c, tint, mark * going * fine);
  }

  // The tube itself: lines, a slow roll, a flicker, the glass, and its edge.
  let pitch = max(round(2.7 * scale), 3.0);
  c *= 1.0 - 0.26 * smoothstep(1.8, 3.0, pitch * seen) * (0.5 - 0.5 * cos(6.2831853 * p.y / pitch));
  let roll = fract(p.y / size.y - t * 0.09);
  c *= 1.0 + 0.16 * exp(-pow((roll - 0.5) / 0.07, 2.0)) + 0.012 * sin(t * 47.0);
  c += vec3f(0.05, 0.08, 0.06) * 0.6 * smoothstep(0.5, 0.0, abs(m.x + m.y * 0.7 + 1.05));
  let rim = -diveBox(p - centre, centre, 0.085 * size.y) / size.y;
  c *= 0.12 + 0.88 * smoothstep(-0.004, 0.09, rim);
  return c + vec3f(0.006, 0.014, 0.01);
}

// The tube's glass bulges a little toward whoever is looking: the place on
// the flat picture that a point of the glass shows.
fn diveBulge(p: vec2f, size: vec2f, much: f32) -> vec2f {
  let centre = 0.5 * size;
  let m = (p - centre) / centre;
  return centre + (p - centre) * (1.0 + 0.014 * much * (dot(m, m) - 2.0));
}

// The picture seen small, when a pixel of the screen is of a good many of the picture's.
fn diveSmall(place: vec2f, size: vec2f, small: f32) -> vec3f {
  let reach = 0.5 / small / size;
  var sum = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    let turn = f32(i) * 2.39996;
    sum += textureSampleLevel(sourceMap, bilinear, place / size + vec2f(cos(turn), sin(turn)) * sqrt((f32(i) + 0.5) / 8.0) * reach, 0.0).rgb;
  }
  return min(sum / 8.0, vec3f(1.0));
}

// How many times smaller than life the picture on the terminal's glass is:
// it keeps its shape and fits within the glass.
fn diveFit(size: vec2f) -> f32 {
  let unit = lens.acts[4].w * lens.frame.y;
  return min(DIVE_GLASS.x * 0.95 * length(lens.acts[5].xy) * unit / (0.5 * size.x), DIVE_GLASS.y * 0.95 * lens.acts[5].z * unit / (0.5 * size.y));
}

// The terminal's glass, from a place q in the picture it stands in: the place
// in the picture on the glass (from that picture's middle), and how far inside
// the edge of that picture and of the glass q is, in pixels of its own picture.
fn diveGlass(q: vec2f, size: vec2f, fit: f32) -> vec4f {
  let unit = lens.acts[4].w * lens.frame.y;
  let lie = lens.acts[5].xyz;
  let along = normalize(lie.xy);
  let v = q - lens.acts[4].yz * lens.frame.y;
  let mx = v.x / along.x;
  let inner = vec2f(mx, v.y - along.y * mx) / fit;
  let g = vec2f(v.x / (lie.x * unit), (v.y - lie.y / lie.x * v.x) / (lie.z * unit));
  return vec4f(inner, -diveBox(inner, 0.5 * size, 0.07 * size.y) * fit, -diveBox(g, DIVE_GLASS.xy, DIVE_GLASS.z) * unit);
}

const DIVE_PAPER = vec3f(0.96, 0.89, 0.74);

// A print of the picture: a pen line round it. edge is how far inside its
// edge the pixel is, and small how much smaller than life the print is.
fn divePrint(art: vec3f, edge: f32, small: f32, size: vec2f) -> vec3f {
  let pen = min(1.8 * lens.frame.y, 0.012 * size.y * small);
  return mix(art, ${vec3(INK)}, smoothstep(pen + 0.6, pen - 0.6, edge));
}

// The terminal in the picture on the tube has the picture on its own glass, as
// a print with paper round it: its colour, and how much of the pixel it
// covers. seen is how many pixels of the screen a pixel of the tube's picture takes.
fn divePinned(place: vec2f, size: vec2f, seen: f32) -> vec4f {
  let fit = diveFit(size);
  let on = diveGlass(place, size, fit);
  let pane = smoothstep(-0.75, 0.75, on.w * seen);
  if (pane <= 0.0) { return vec4f(0.0); }
  var c = DIVE_PAPER;
  if (on.z * seen > -1.0) {
    let art = divePrint(diveSmall(0.5 * size + on.xy, size, fit * seen), on.z * seen, fit * seen, size);
    c = mix(c, art, smoothstep(-0.75, 0.75, on.z * seen));
  }
  return vec4f(c, pane);
}

// Where the dive has the lens at one pixel of the screen.
struct Plunge {
  outside: vec2f, // the place in the picture round the terminal that it shows
  inside: vec2f,  // and the place in the picture on the terminal's screen
  pole: vec2f,    // the place the lens is heading for: it alone stays where it is
  cover: f32,     // how much of the pixel is the inside
  glass: f32,     // how much of it is the terminal's glass
  grown: f32,     // how many times larger than life the outside is seen
  small: f32,     // how many times smaller than life the inside is
  frame: f32,     // how far inside the edge of the inside it is, in pixels of the screen
  k: f32,         // how far through the glass: 0 before it, 1 the other side
}

fn plunged(p: vec2f, size: vec2f) -> Plunge {
  let inTube = lens.acts[4].x >= 1.0;
  let k = fract(lens.acts[4].x);
  let rush = lens.acts[5].w;
  let glassAt = lens.acts[4].yz * lens.frame.y;
  let along = normalize(lens.acts[5].xy);
  let centre = 0.5 * size;
  let fit = diveFit(size);
  let s = pow(fit, k);
  let pole = centre + (glassAt - centre) / (1.0 - fit);
  let eye = pole + (centre - pole) * s;
  // In the terminal everything is seen through its tube's glass, until the lens is through the next.
  var off = p - centre;
  if (inTube) { off = diveBulge(p, size, 1.0 - smoothstep(0.3, 1.0, k)) - centre; }
  // Going fast, the middle of what is seen swells toward the eye.
  let swell = off * (1.0 - 0.2 * rush * (1.0 - 0.5 * dot(off / centre, off / centre)));
  // The glass is seen a little from one side; the lens squares up to it on the way in.
  let square = k * k * (3.0 - 2.0 * k);
  let q = eye + s * vec2f(mix(1.0, along.x, square) * swell.x, mix(0.0, along.y, square) * swell.x + swell.y);
  let on = diveGlass(q, size, fit);
  // The picture comes up on the glass as the lens sets off. In the terminal it is there already.
  let come = select(smoothstep(0.02, 0.3, k), 1.0, inTube);
  // At the last the corners of the inside, which are round, fill out to the corners of the screen.
  let whole = smoothstep(0.84, 1.0, k) * smoothstep(-0.75, 0.75, -diveBox(on.xy, centre, 0.0) * fit / s);
  return Plunge(q, centre + on.xy, pole, max(come * smoothstep(-0.75, 0.75, on.z / s), whole), come * smoothstep(-0.75, 0.75, on.w / s), 1.0 / s, fit / s, on.z / s, k);
}

// The pixel as the dive leaves it. c0 is what the lens made of the place it was given.
fn dived(c0: vec3f, d: Plunge, at: vec2f, size: vec2f) -> vec3f {
  let rush = lens.acts[5].w;
  let mine = d.cover > 0.5; // c0 is of the inside
  var outer = vec3f(0.0);
  var inner = vec3f(0.0);
  var pane = vec3f(0.0);
  if (lens.acts[4].x < 1.0) {
    // On the way in: the picture round the terminal, drawn out long toward where the lens is going.
    if (d.cover < 1.0) {
      outer = c0;
      if (mine) { outer = textureSampleLevel(sourceMap, bilinear, d.outside / size, 0.0).rgb; }
      else if (rush > 0.01 || d.grown > 1.3) {
        var long = vec3f(0.0);
        let shake = speck(at);
        for (var i = 0; i < 9; i++) {
          let near = 1.0 - 0.13 * rush * (f32(i) + shake) / 9.0;
          let tap = textureSampleLevel(sourceMap, bilinear, (d.pole + (d.outside - d.pole) * near) / size, 0.0).rgb;
          long += tap * vec3f(f32(i), 4.0, 8.0 - f32(i)) / 36.0;
        }
        // Seen that large the print's grain would be boulders: it is left behind.
        long += textureSampleLevel(glowMap, bilinear, d.outside / size, 0.0).rgb * 0.42;
        outer = mix(outer, long, max(smoothstep(0.0, 0.6, rush) * 0.9, smoothstep(1.3, 2.5, d.grown)));
      }
    }
    if (d.cover > 0.0) {
      let place = diveBulge(d.inside, size, 1.0);
      inner = tube(place, size, d.small);
      // By the time the lens is through, the terminal in there has the picture on its own glass.
      let late = smoothstep(0.5, 0.95, d.k);
      if (late > 0.0) {
        let pinned = divePinned(place, size, d.small);
        inner = mix(inner, pinned.rgb, pinned.a * late);
      }
    }
    pane = vec3f(0.012, 0.03, 0.02);
  } else {
    // In the terminal, and on the way out of it: the tube all round, and the
    // picture, a print of it, on the glass of the terminal in there.
    if (d.cover < 1.0) { outer = tube(d.outside, size, d.grown); }
    if (d.cover > 0.0) {
      inner = c0;
      if (!mine) { inner = textureSampleLevel(sourceMap, bilinear, d.inside / size, 0.0).rgb; }
      let many = smoothstep(1.0, 0.4, d.small);
      if (many > 0.0) { inner = mix(inner, diveSmall(d.inside, size, d.small), many); }
      inner = mix(inner, divePrint(inner, d.frame, d.small, size), 1.0 - smoothstep(0.84, 1.0, d.k));
    }
    pane = DIVE_PAPER;
  }
  return mix(mix(outer, pane, d.glass), inner, d.cover);
}

// How near a point is to a box with rounded corners: less than nothing inside it.
fn roundedBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// How far a point is off the straight stroke from a to b.
fn offLine(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let run = b - a;
  return length(p - a - run * clamp(dot(p - a, run) / dot(run, run), 0.0, 1.0));
}

// To one by drawing back first, and going a little too far before settling.
fn swing(x: f32) -> f32 {
  let k = clamp(x, 0.0, 1.0);
  if (k < 0.5) { return 2.0 * k * k * (7.19 * k - 2.595); }
  let j = 2.0 * k - 2.0;
  return 0.5 * (j * j * (3.595 * j + 2.595) + 2.0);
}

// Away from nothing by leaning the other way first.
fn windUp(x: f32) -> f32 {
  let k = clamp(x, 0.0, 1.0);
  return k * k * (2.7 * k - 1.7);
}

// One of the eight browser windows the picture is shown in.
struct Pane {
  mid: vec3f,  // its middle: across, down, and away from the eye, in design units
  lean: vec3f, // turned about its upright, tipped, and rolled, in radians
  size: f32,   // 1 and its picture fills the screen
  born: f32,   // nothing until it has come out of the window it split from
}

// Where window i is, t seconds in. The picture draws back into one window;
// three times every window there is splits in two, into a cascade; they
// swing out into a carousel round the sun, are drawn into it, and open out
// of it as a ring, turning; then they close into one window again, which
// lets the picture go. dims is the screen in design units.
fn paneAt(i: i32, t: f32, dims: vec2f, pivot: vec2f) -> Pane {
  let TURN = 6.2831853;
  let tall = dims.y > dims.x;
  let n = f32(i);
  let middle = 0.5 * dims;
  let bit = vec3f(f32(i & 1), f32((i >> 1u) & 1), f32((i >> 2u) & 1));
  let since = (vec3f(t) - vec3f(0.95, 1.45, 1.95)) / 0.5;
  let split = vec3f(overshoot(since.x), overshoot(since.y), overshoot(since.z));
  let grown = (split.x + split.y + split.z) / 3.0;
  var it: Pane;
  it.born = mix(1.0, smoothstep(0.0, 0.25, since.x), bit.x) * mix(1.0, smoothstep(0.0, 0.25, since.y), bit.y) * mix(1.0, smoothstep(0.0, 0.25, since.z), bit.z);

  // The cascade: each a step down and to the right of the one before, and nearer.
  let rank = dot(bit * split, vec3f(1.0, 2.0, 4.0)) - 0.5 * dot(split, vec3f(1.0, 2.0, 4.0));
  it.mid = vec3f(middle + rank * select(vec2f(0.036 * dims.x, 0.04 * dims.y), vec2f(0.06 * dims.x, 0.054 * dims.y), tall), -34.0 * rank);
  it.lean = vec3f(-0.2, 0.05, 0.0) * grown;
  it.size = mix(0.62, select(0.44, 0.5, tall), grown);

  let fan = smoothstep(0.0, 1.0, (t - 2.3 - 0.06 * (7.0 - n)) / 0.85);
  if (fan > 0.0) {
    var mid: vec3f;
    var lean: vec3f;
    var size: f32;
    let core = vec3f(pivot, 0.0);
    let bloom = (t - 4.2) / 0.6;
    if (bloom <= 0.0) {
      // The carousel, faster and faster, and then into the sun.
      let lap = t - 2.3;
      let a = 1.014 + 0.9 * lap * lap + n * TURN / 8.0;
      let reach = select(vec3f(0.33 * dims.x, 0.2 * dims.y, 0.3 * dims.x), vec3f(0.31 * dims.x, 0.14 * dims.y, 0.5 * dims.x), tall);
      let drawn = windUp((t - 3.7) / 0.5);
      mid = mix(vec3f(mix(middle, pivot, 0.25) + reach.xy * vec2f(sin(a), cos(a)), -reach.z * cos(a)), core, drawn);
      lean = vec3f(-0.9 * sin(a), 0.2, 0.06 * sin(a)) * (1.0 - drawn);
      size = mix(select(0.25, 0.3, tall), 0.17, drawn);
      if (i > 0) { it.born *= 1.0 - 0.9 * clamp(drawn, 0.0, 1.0); }
    } else {
      // Out of the sun as a ring, each window's bar toward it, each lapped over the next like the leaves of a shutter.
      let spin = smoothstep(0.0, 1.0, (t - 4.7) / 0.85);
      var a = TURN / 16.0 + n * TURN / 8.0 + 0.25 * TURN * spin;
      a -= TURN * floor(a / TURN + 0.5);
      let open = overshoot(bloom);
      let ring = select(0.265 * dims.y, 0.295 * dims.x, tall);
      mid = mix(core, vec3f(pivot + ring * vec2f(sin(a), cos(a)), 0.0), open);
      lean = select(vec3f(0.42, 0.0, -a), vec3f(0.0, 0.42, 0.25 * TURN - a), tall) * smoothstep(0.0, 1.0, bloom);
      size = mix(0.17, select(0.25, 0.21, tall), open);
      if (i > 0) { it.born *= 1.0 - 0.9 * clamp(1.0 - open, 0.0, 1.0); }
      // And back into one.
      let back = (t - 5.5 - 0.02 * n) / 0.7;
      let home = windUp(back);
      mid = mix(mid, vec3f(middle, 0.0), home);
      lean *= 1.0 - home;
      size = mix(size, 0.62, home);
      if (i > 0) { it.born *= 1.0 - smoothstep(0.9, 1.0, back); }
    }
    it.mid = mix(it.mid, mid, fan);
    it.lean = mix(it.lean, lean, fan);
    it.size = mix(it.size, size, fan);
  }
  it.size = mix(1.0, it.size, swing(t / 0.75) - swing((t - 6.2) / 0.7));
  return it;
}

// The frame of an old browser window at a point of it. q is across from the
// picture's left edge and down from its top, in the picture's own units, so
// the bar is where q.y is less than nothing; u is the size of its fittings,
// fine how much of all this one pixel covers, rim how far the point is inside
// the dark line round the whole window (less than nothing: not in it). The
// answer is a grey, and how much of the point is frame and not picture.
fn windowFrame(q: vec2f, dims: vec2f, u: f32, fine: f32, rim: f32) -> vec4f {
  let f = 0.75 * fine;
  let lined = smoothstep(-f, f, rim);
  let frame = max(smoothstep(-f, f, max(max(-q.x, q.x - dims.x), max(-q.y, q.y - dims.y))), lined);
  if (frame <= 0.0) { return vec4f(0.0); }
  let wide = dims.x;
  // The strip the tabs sit on, the row of buttons under it, and the tab that is open.
  var k = vec3f(0.835);
  k = mix(k, vec3f(0.969), smoothstep(-f, f, q.y + 48.0 * u));
  k = mix(k, vec3f(0.969), smoothstep(f, -f, roundedBox(q - vec2f(201.0, -58.0) * u, vec2f(115.0, 22.0) * u, 8.0 * u)));
  if (q.y < -48.0 * u) {
    // Three round buttons.
    let button = vec2f(q.x - (22.0 + 20.0 * clamp(round((q.x / u - 22.0) / 20.0), 0.0, 2.0)) * u, q.y + 65.0 * u);
    k = mix(k, vec3f(0.63), smoothstep(f, -f, length(button) - 6.2 * u));
    // The tab: its mark, its name, its cross.
    k = mix(k, vec3f(0.6), smoothstep(f, -f, length(q - vec2f(104.0, -64.0) * u) - 5.5 * u));
    k = mix(k, vec3f(0.969), smoothstep(f, -f, length(q - vec2f(104.0, -64.0) * u) - 2.2 * u));
    k = mix(k, vec3f(0.52), smoothstep(f, -f, roundedBox(q - vec2f(170.0, -64.0) * u, vec2f(50.0, 2.8) * u, 2.8 * u)));
    let shut = abs(q - vec2f(298.0, -64.0) * u);
    k = mix(k, vec3f(0.5), smoothstep(f, -f, max(abs(shut.x - shut.y) * 0.7071 - 0.8 * u, max(shut.x, shut.y) - 3.6 * u)));
    // The tab that is not open, and the place a new one would go.
    k = mix(k, vec3f(0.72), smoothstep(f, -f, length(q - vec2f(336.0, -64.0) * u) - 5.0 * u));
    k = mix(k, vec3f(0.69), smoothstep(f, -f, roundedBox(q - vec2f(394.0, -64.0) * u, vec2f(44.0, 2.8) * u, 2.8 * u)));
    k = mix(k, vec3f(0.74), smoothstep(f, -f, max(abs(q.x - 462.0 * u) - 0.6 * u, abs(q.y + 64.0 * u) - 10.0 * u)));
    let plus = abs(q - vec2f(486.0, -64.0) * u);
    k = mix(k, vec3f(0.5), smoothstep(f, -f, max(min(plus.x, plus.y) - 0.8 * u, max(plus.x, plus.y) - 4.8 * u)));
  } else {
    // Back, forward, again.
    let arrow = vec2f(q.x - 23.0 * u, abs(q.y + 24.0 * u));
    k = mix(k, vec3f(0.45), smoothstep(f, -f, offLine(arrow, vec2f(-3.0, 0.0) * u, vec2f(3.5, 6.5) * u) - 0.95 * u));
    let onward = vec2f(51.0 * u - q.x, abs(q.y + 24.0 * u));
    k = mix(k, vec3f(0.74), smoothstep(f, -f, offLine(onward, vec2f(-3.0, 0.0) * u, vec2f(3.5, 6.5) * u) - 0.95 * u));
    let again = q - vec2f(79.0, -24.0) * u;
    k = mix(k, vec3f(0.45), smoothstep(f, -f, max(abs(length(again) - 6.0 * u) - 0.95 * u, min(again.x - 1.0 * u, -again.y - 1.0 * u))));
    k = mix(k, vec3f(0.45), smoothstep(f, -f, max(max(abs(again.x - 6.0 * u) - 2.6 * u, abs(again.y + 4.5 * u) - 2.6 * u), again.x - again.y - 13.2 * u)));
    // Where the address goes: a lock, the address, and what comes after it.
    let pill = roundedBox(q - vec2f(0.5 * (wide + 58.0 * u), -24.0 * u), vec2f(0.5 * (wide - 150.0 * u), 15.0 * u), 15.0 * u);
    k = mix(k, vec3f(0.915), smoothstep(f, -f, pill));
    k = mix(k, vec3f(0.8), smoothstep(f, -f, abs(pill) - 0.55 * u));
    k = mix(k, vec3f(0.45), smoothstep(f, -f, max(abs(length(q - vec2f(125.0, -26.5) * u) - 3.1 * u) - 0.85 * u, q.y + 25.0 * u)));
    k = mix(k, vec3f(0.45), smoothstep(f, -f, roundedBox(q - vec2f(125.0, -21.8) * u, vec2f(4.6, 3.7) * u, 1.2 * u)));
    k = mix(k, vec3f(0.4), smoothstep(f, -f, roundedBox(q - vec2f(218.0, -24.0) * u, vec2f(78.0, 2.8) * u, 2.8 * u)));
    k = mix(k, vec3f(0.7), smoothstep(f, -f, roundedBox(q - vec2f(352.0, -24.0) * u, vec2f(46.0, 2.8) * u, 2.8 * u)));
    // Three dots, and the line under it all.
    let dots = vec2f(q.x - wide + 23.0 * u, q.y + 24.0 * u - 7.0 * u * clamp(round((q.y / u + 24.0) / 7.0), -1.0, 1.0));
    k = mix(k, vec3f(0.45), smoothstep(f, -f, length(dots) - 1.8 * u));
    k = mix(k, vec3f(0.72), smoothstep(-f, f, q.y + 1.2 * u));
  }
  return vec4f(mix(k, ${vec3(INK)} * 1.35, lined), frame);
}

// What the windows make of a point of the screen.
struct Panes {
  at: vec2f,  // the place in the picture that shows there, in design units
  keep: f32,  // how much of that shows
  ink: vec3f, // the frames there, already weighed
  back: f32,  // how much of what is behind all the windows shows
  fine: f32,  // how many pixels of the picture one pixel of the screen takes in there
}

// The eight windows as they stand t seconds in, seen at p: every one is a
// sheet standing somewhere in front of the eye, the nearest one hit is the
// one seen, and each throws a soft shadow on whatever is farther off.
fn panes(p: vec2f, dims: vec2f, pivot: vec2f, t: f32, perUnit: f32) -> Panes {
  var seen: Panes;
  seen.at = p;
  seen.keep = 0.0;
  seen.ink = vec3f(0.0);
  seen.fine = 1.0;
  let u = 1.2 * clamp(dims.x / 1440.0, 0.5, 1.0);
  let framed = smoothstep(0.08, 0.55, t) * (1.0 - smoothstep(6.25, 6.85, t));
  let bar = 88.0 * u * framed;
  let curl = 13.0 * u * framed;
  let focal = 1.25 * max(dims.x, dims.y);
  let eye = vec3f(0.5 * dims, -focal);
  let ray = vec3f(p - 0.5 * dims, focal);
  let lift = vec2f(0.0, -0.5 * bar);
  var spots: array<vec2f, 8>;
  var depths: array<f32, 8>;
  var fines: array<f32, 8>;
  var borns: array<f32, 8>;
  var first = -1;
  var second = -1;
  var nearest = 1e9;
  var next = 1e9;
  for (var i = 0; i < 8; i++) {
    borns[i] = 0.0;
    let pane = paneAt(i, t, dims, pivot);
    if (pane.born <= 0.0) { continue; }
    let cs = cos(pane.lean);
    let sn = sin(pane.lean);
    let across = vec3f(cs.x * cs.z, cs.x * sn.z, -sn.x);
    let down = vec3f(sn.y * sn.x * cs.z - cs.y * sn.z, sn.y * sn.x * sn.z + cs.y * cs.z, sn.y * cs.x);
    let face = cross(across, down);
    let square = dot(ray, face);
    if (abs(square) < 1e-3) { continue; }
    let reach = dot(pane.mid - eye, face) / square;
    if (reach <= 0.0) { continue; }
    let hit = eye + ray * reach - pane.mid;
    let spot = vec2f(dot(hit, across), dot(hit, down)) / pane.size;
    let fine = reach / (perUnit * pane.size) * min(length(ray) / abs(square), 3.0);
    spots[i] = spot;
    depths[i] = reach;
    fines[i] = fine;
    borns[i] = pane.born;
    let rim = framed * max(3.0 * u, 1.5 * fine);
    if (roundedBox(spot - lift, 0.5 * dims + vec2f(rim, rim + 0.5 * bar), curl) < fine) {
      if (reach < nearest) {
        second = first;
        next = nearest;
        first = i;
        nearest = reach;
      } else if (reach < next) {
        second = i;
        next = reach;
      }
    }
  }
  // The shadows: on the nearest window, on the one behind it, and on what is behind them all.
  var light = vec3f(1.0);
  let soft = 64.0 * u;
  for (var i = 0; i < 8; i++) {
    if (borns[i] <= 0.0) { continue; }
    let shape = roundedBox(spots[i] - lift - vec2f(0.0, 22.0 * u), 0.5 * dims + vec2f(0.0, 0.5 * bar), curl + 8.0 * u);
    let dark = 0.56 * framed * borns[i] * smoothstep(soft, -0.5 * soft, shape);
    if (dark <= 0.0) { continue; }
    light *= 1.0 - dark * vec3f(smoothstep(0.0, 0.012, nearest - depths[i]), smoothstep(0.0, 0.012, next - depths[i]), 1.0);
  }
  var cover = 0.0;
  if (first >= 0) {
    let rim = framed * max(3.0 * u, 1.5 * fines[first]);
    let shape = roundedBox(spots[first] - lift, 0.5 * dims + vec2f(rim, rim + 0.5 * bar), curl);
    cover = smoothstep(0.75 * fines[first], -0.75 * fines[first], shape);
    let frame = windowFrame(spots[first] + 0.5 * dims, dims, u, fines[first], shape + rim);
    seen.ink = cover * frame.a * frame.rgb * light.x;
    seen.keep = cover * (1.0 - frame.a) * light.x;
    seen.at = spots[first] + 0.5 * dims;
    seen.fine = fines[first] * perUnit;
  }
  if (second >= 0 && cover < 0.999) {
    let rim = framed * max(3.0 * u, 1.5 * fines[second]);
    let shape = roundedBox(spots[second] - lift, 0.5 * dims + vec2f(rim, rim + 0.5 * bar), curl);
    let share = (1.0 - cover) * smoothstep(0.75 * fines[second], -0.75 * fines[second], shape);
    let frame = windowFrame(spots[second] + 0.5 * dims, dims, u, fines[second], shape + rim);
    seen.ink += share * frame.a * frame.rgb * light.y;
    let shown = share * (1.0 - frame.a) * light.y;
    if (shown > seen.keep) {
      seen.at = spots[second] + 0.5 * dims;
      seen.fine = fines[second] * perUnit;
    }
    seen.keep += shown;
    cover += share;
  }
  seen.back = (1.0 - cover) * light.z;
  return seen;
}

// The ordinary page at a point of it, taking in reach to each side.
fn pageAt(uv: vec2f, reach: vec2f) -> vec3f {
  return 0.25 * (
    textureSampleLevel(pageMap, bilinear, uv + reach * vec2f(-1.0, -1.0), 0.0).rgb +
    textureSampleLevel(pageMap, bilinear, uv + reach * vec2f(1.0, -1.0), 0.0).rgb +
    textureSampleLevel(pageMap, bilinear, uv + reach * vec2f(-1.0, 1.0), 0.0).rgb +
    textureSampleLevel(pageMap, bilinear, uv + reach * vec2f(1.0, 1.0), 0.0).rgb
  );
}

// How badly the ordinary page is being received, t seconds after it broke in:
// the burst it arrives in, the fight the picture puts up before it wins, and
// both together with the hum in between.
fn interference(t: f32) -> vec3f {
  let burst = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.45, 1.25, t));
  let fight = smoothstep(2.4, 2.9, t) * (1.0 - smoothstep(3.3, 4.1, t));
  return vec3f(burst, fight, max(max(burst, 0.75 * fight), 0.14 * smoothstep(0.0, 0.1, t)) * (1.0 - smoothstep(5.0, 5.55, t)));
}

// How far sideways the row through d has slipped, in design units: now and then a band of rows tears away from the rest.
fn slipped(d: vec2f, t: f32, seed: f32) -> f32 {
  let g = interference(t);
  let beat = floor(t * 14.0) + seed;
  let row = floor(d.y / 34.0 + 2.5 * cloudy(vec2f(d.y / 130.0, beat * 0.37)));
  let torn = step(0.95 - 0.4 * g.x - 0.16 * g.y, speck(vec2f(row, beat) + 11.0));
  return torn * (speck(vec2f(row, beat) + 3.0) - 0.5) * (300.0 * g.x + 70.0 * g.y + 18.0 * g.z);
}

// A perfectly ordinary page of an encyclopedia breaks in over half the
// picture, as badly received as a far-off station: its edge comes in jerks
// and will not hold still, its colours part, rows tear sideways, blocks of it
// turn up where they do not belong, a dark bar rolls down it and some of its
// dots have stuck. For a moment it nearly holds, and can be read. Then the
// picture comes through it in blocks, what is written on it takes the
// poster's colours, and the picture pours down over it as it did over the
// grey page. under is the picture at p.
fn brokenIn(under: vec3f, p: vec2f, size: vec2f) -> vec3f {
  let INK = ${vec3(INK)};
  let u = lens.frame.y;
  let t = lens.acts[1].x;
  let tall = lens.acts[1].z > 0.5;
  let seed = lens.acts[1].w;
  let d = p / u;
  let dims = size / u;
  let g = interference(t);
  let beat = floor(t * 12.0) + seed;

  // Its edge: down the middle of a wide screen (the page has the left half), across the middle of a tall one (it has the top).
  let span = select(dims.x, dims.y, tall);
  let along = select(d.y, d.x, tall);
  let across = select(d.x, d.y, tall);
  let come = clamp((t - 0.1) / 0.85, 0.0, 1.0) * 5.0;
  var edge = span * (0.1 * (floor(come) + smoothstep(0.5, 1.0, fract(come))) + 0.05 * g.z * (speck(vec2f(beat, 5.0)) - 0.5));
  let stair = floor(along / 38.0 + 2.0 * cloudy(vec2f(along / 150.0, beat * 0.41)));
  edge += (speck(vec2f(stair, beat)) - 0.5) * (20.0 + 330.0 * g.x + 110.0 * g.y) * step(0.45 - g.x - g.y, speck(vec2f(stair, beat + 7.0)));
  edge += (speck(vec2f(floor(along / 6.0), beat + 3.0)) - 0.5) * 12.0 * step(0.7, speck(vec2f(floor(along / 6.0), beat + 9.0)));
  let inside = smoothstep(0.5, -0.5, (across - edge) * u);

  // The picture pours down over it, and it runs like wax (as in front()).
  let a = max(t - 3.3, 0.0) * 1.55;
  let h = 32.0 * u;
  var q = p + smoothstep(2.9, 3.7, t) * 7.0 * u * vec2f(sin(p.y / (70.0 * u) + t * 4.2), cos(p.x / (90.0 * u) + t * 3.1));
  let run = poured(q.x / h + seed, a);
  let lean = (poured((q.x + 3.0 * u) / h + seed, a).x - poured((q.x - 3.0 * u) / h + seed, a).x) * h / (6.0 * u);
  let gone = (run.x * h - q.y) / sqrt(1.0 + lean * lean);
  let limp = 0.65 * cloudy(vec2f(q.x / (64.0 * u), 31.0)) + 0.35 * cloudy(vec2f(q.x / (22.0 * u), 37.0));
  let sag = smoothstep(0.1, 1.5, a) * (0.1 + 0.75 * limp * limp);
  q.y = max((q.y - 0.42 * run.x * h) / (1.0 + 0.9 * run.y + sag) - 30.0 * u * sag, 0.0);

  // Where on the page this is: it rolls into place, then scrolls on slowly; rows slip, blocks go astray.
  let sheet = vec2f(textureDimensions(pageMap));
  let perUnit = sheet.x / 720.0; // the page is 720 design units wide: half a wide screen
  let dot1 = sheet.x / 1024.0;   // and was drawn 1024 wide (tools/art/page.svg), with its article starting 176 in
  var spot = q / u * perUnit + vec2f(select(0.0, 176.0 * dot1, tall), 0.0);
  let rolling = 1.0 - smoothstep(0.15, 1.15, t);
  spot.y += 24.0 * dot1 * max(t - 1.0, 0.0) + 1.5 * sheet.y * rolling * rolling;
  spot.x += 2.0 * perUnit * slipped(d, t, seed);
  let cell = floor(d / vec2f(72.0, 40.0));
  let stray = floor(t * 9.0) + seed;
  if (speck(cell + vec2f(17.0, 29.0) * stray) < 0.015 + 0.3 * g.x + 0.16 * g.y) {
    spot += (vec2f(speck(cell + 1.3 + stray), speck(cell + 2.7 + stray)) - 0.5) * vec2f(640.0, 480.0) * dot1;
  }
  let bar = d.y / dims.y - (fract(0.27 * t + 0.1) * 1.3 - 0.15);
  let sync = exp(-bar * bar / 0.002);
  spot.x += 22.0 * dot1 * sync * (0.3 + g.z);
  spot -= sheet * floor(spot / sheet);
  let part = vec2f((0.7 + 15.0 * max(g.x, 0.7 * g.y) + 5.0 * sync) * dot1 / sheet.x, 0.0);
  // On a screen with fewer dots than the page has, each takes in all of the page that falls on it.
  let taken = 0.25 * max(perUnit / u - 1.0, 0.0) / sheet;
  let plain = pageAt(spot / sheet, taken);
  var page = vec3f(pageAt(spot / sheet + part, taken).r, plain.g, pageAt(spot / sheet - part, taken).b);

  // What is written on it takes the poster's colours, from its edge inward, and its paper yellows.
  let inked = smoothstep(0.075, 0.2, 1.0 - dot(plain, vec3f(0.3333)));
  let turns = 2.55 + 0.6 * clamp((edge - across) / (0.5 * span), 0.0, 1.0) + 0.25 * speck(floor(d / 52.0) + 3.0 + seed);
  let paint = bowAt(q.x / (300.0 * u) + q.y / (520.0 * u) + 0.3 * t);
  page = mix(page, mix(paint * 0.95, INK, 0.1), inked * smoothstep(turns, turns + 0.3, t));
  page *= mix(vec3f(1.0), vec3f(1.0, 0.95, 0.82), smoothstep(2.9, 3.9, t) * (1.0 - inked));

  // The bar that rolls down it, the lines it is drawn in, and the dots that have stuck.
  page *= 1.0 - 0.17 * sync;
  page += 0.2 * exp(-pow((bar - 0.062) / 0.004, 2.0));
  page *= 0.955 + 0.045 * step(0.5, fract(p.y / max(2.0, floor(2.5 * u + 0.5))));
  let dot4 = floor(d / 4.0);
  if (speck(dot4 + 13.0 * seed) > 0.9988) {
    let which = speck(dot4 + 5.0);
    page = select(select(vec3f(0.1, 1.0, 0.25), vec3f(1.0, 0.05, 0.9), which > 0.33), vec3f(0.1, 0.35, 1.0), which > 0.66);
  }
  let stuck = dims.y * (0.22 + 0.5 * speck(vec2f(seed, 3.0)));
  page = mix(page, vec3f(0.1, 0.95, 0.9), 0.85 * step(abs(d.y - stuck), 0.8) * step(0.3, speck(vec2f(beat, 23.0))));

  // The picture shows through it in blocks, more and more of them; and blocks of the page turn up out on the picture.
  let block = floor(d / vec2f(96.0, 54.0));
  let flick = floor(t * 7.0) + seed;
  var alpha = inside;
  alpha *= step(0.03 + 0.12 * g.x + 0.25 * g.y, speck(block + vec2f(31.0, 13.0) * flick));
  alpha *= step(0.01 + 0.1 * g.y, speck(floor(d / 24.0) + vec2f(7.0, 3.0) * flick));
  let ghost = step(speck(block + vec2f(5.0, 19.0) * flick), (0.5 * g.x + 0.14 * g.y + 0.012) * exp(-max(across - edge, 0.0) / 260.0));
  alpha = max(alpha, ghost * (1.0 - inside));

  // The lip of what is pouring down: the poster's rainbow, inked on both sides.
  if (run.y > 0.0) {
    let lip = 30.0 * u * smoothstep(0.0, 0.45, run.y);
    let lane = clamp(-gone / max(lip, 0.001), 0.0, 0.9999) * 4.0;
    var rim = bowAt((floor(lane) + 0.5) / 6.0 + 0.16 + 0.1 * a);
    rim = mix(rim, INK, smoothstep(1.3 * u, 0.5 * u, (0.5 - abs(fract(lane) - 0.5)) / 4.0 * lip));
    rim = mix(rim, INK, smoothstep(3.0 * u, 2.0 * u, min(-gone, lip + gone)));
    page = mix(page, rim, smoothstep(-lip - 0.7, -lip + 0.7, gone) * smoothstep(0.0, 0.12, run.y));
    alpha *= 1.0 - smoothstep(-0.7, 0.7, gone);
  }
  alpha *= 1.0 - smoothstep(5.3, 5.55, t);

  // Near its edge the picture's own colours have parted too.
  var picture = under;
  let closeBy = g.z * exp(-abs(across - edge) / 220.0);
  if (closeBy > 0.02) {
    let off = vec2f((3.0 + 26.0 * g.z) * closeBy * u, 0.0) / size;
    let here = textureSampleLevel(sourceMap, bilinear, p / size, 0.0).rgb;
    picture += vec3f(textureSampleLevel(sourceMap, bilinear, p / size + off, 0.0).r - here.r, 0.0, textureSampleLevel(sourceMap, bilinear, p / size - off, 0.0).b - here.b) * min(closeBy * 3.0, 1.0);
  }
  return mix(picture, page, alpha);
}

// The spilt light at a point, where there is enough of it to flare.
fn hot(uv: vec2f) -> vec3f {
  let g = textureSampleLevel(glowMap, bilinear, uv, 0.0).rgb;
  return g * smoothstep(0.7, 2.4, max(g.r, max(g.g, g.b)));
}

// Light that bright is also thrown about inside the lens: a long streak
// through it, and coloured ghosts of it across the middle of the picture. It
// is all soft, so it is drawn a quarter of the size and laid over by finish().
@fragment
fn flares(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / ceil(vec2f(textureDimensions(glowMap)) * 0.5);
  var flare = vec3f(0.0);
  for (var i = 1; i <= 7; i++) {
    let reach = vec2f(0.006 * f32(i * i) + 0.012 * f32(i), 0.0);
    flare += (hot(uv + reach) + hot(uv - reach)) * (1.0 - f32(i) / 8.0) * vec3f(0.5, 0.75, 1.25) * 0.02;
  }
  let across = vec2f(0.5) - uv;
  for (var i = 0; i < 4; i++) {
    let ghost = uv + across * (0.55 + 0.5 * f32(i));
    let rim = 1.0 - smoothstep(0.25, 0.5, length(ghost - 0.5));
    flare += hot(ghost) * bowAt(0.13 + 0.19 * f32(i)) * rim * 0.06;
  }
  let ring = uv + normalize(across + vec2f(1e-5)) * 0.32;
  flare += hot(ring) * bowAt(length(across) * 3.0) * 0.04 * (1.0 - smoothstep(0.3, 0.5, length(ring - 0.5)));
  return vec4f(flare, 1.0);
}

// The paper itself, which is the same from one frame to the next: how unevenly
// the ink took (red), where it has worn thin (green), and how far the hand
// that inked it wandered at this spot (blue and alpha).
@fragment
fn paper(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let sheet = position.xy / lens.frame.y;
  let mottle = 0.6 * cloudy(sheet / 2.1) + 0.4 * cloudy(sheet / 5.2 + 4.0);
  let took = (0.93 + 0.09 * mottle) * (0.965 + 0.07 * cloudy(sheet / 95.0 + 8.0));
  let worn = smoothstep(0.8, 0.95, cloudy(sheet / 1.6 + 40.0) * (0.3 + 0.7 * cloudy(sheet / 60.0 + 2.0)) * 1.45);
  return vec4f((took - 0.89) / 0.17, worn, cloudy(sheet / 6.5), cloudy(sheet / 6.5 + 9.2));
}

// The picture as a lens sees it and a press prints it. A shock bends what is
// behind it as it passes; a roar drags everything toward the mouth; colours
// part a little toward the corners; what is out of focus is soft; and over
// all of it there is film grain, a fine print screen, and darker corners.
// The picture as the eye planet sees it: a negative, its colours turned
// round, with the planet's scan going slowly round it and range rings
// running out. It spreads out of the planet and draws back into it.
fn planetSees(c: vec3f, p: vec2f, size: vec2f) -> vec3f {
  let scale = lens.frame.y;
  let k = lens.stare.x;
  let t = lens.stare.y;
  let rel = (p - lens.stare.zw * scale) / scale;
  let far = length(rel);
  let reach = k * (length(size) / scale + 320.0);
  let here = 1.0 - smoothstep(reach - 280.0, reach, far);
  if (here <= 0.0) { return c; }
  let n = vec3f(1.0) - clamp(c, vec3f(0.0), vec3f(1.0));
  let turn = 0.8 + 0.3 * t;
  let axis = vec3f(0.57735);
  var look = n * cos(turn) + cross(axis, n) * sin(turn) + axis * dot(axis, n) * (1.0 - cos(turn));
  let bearing = atan2(rel.y, rel.x) / 6.2831853;
  let behind = fract(0.16 * t - bearing);
  let trail = exp(-behind * 6.0) * smoothstep(0.0, 0.006, behind);
  look = look * (0.55 + 0.7 * trail) + vec3f(0.55, 1.0, 0.85) * 0.35 * exp(-behind * 70.0) * smoothstep(0.0, 0.003, behind);
  let rings = smoothstep(0.9, 1.0, cos(6.2831853 * (far / 150.0 - 0.5 * t)));
  look += vec3f(0.95, 0.45, 1.0) * 0.22 * rings * exp(-far / 1100.0);
  look *= 1.0 - 0.25 * smoothstep(0.35, 0.9, far / (length(size) / scale));
  return mix(c, max(look, vec3f(0.0)), here);
}

@fragment
fn finish(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(sourceMap));
  // While the grey page is whole there is nothing else to draw.
  if (lens.gate.w > 0.5 && lens.gate.z <= 0.0) { return vec4f(front(vec3f(0.0), position.xy, size), 1.0); }
  let scale = lens.frame.y;
  let maw = lens.frame.z;
  var at = position.xy;
  // The whole picture folds into a kaleidoscope round the sun, turns, and unfolds.
  if (lens.acts[6].x > 0.0) {
    let fold = lens.acts[6];
    let off = at - lens.sun.xy;
    let wedge = 6.2831853 / fold.z;
    let bearing = atan2(off.y, off.x);
    let folded = abs(fract((bearing - fold.y) / wedge) - 0.5) * wedge;
    let seen = fold.y * 0.5 + 1.5708 + folded - wedge * 0.25;
    let far = length(off) * (1.0 - 0.12 * fold.x);
    at = mix(at, lens.sun.xy + far * vec2f(cos(seen), sin(seen)), fold.x);
    at = size - abs(size - abs(at));
  }
  // The dive into the terminal's screen: the lens goes in through its glass.
  // (Whatever has already moved the place this pixel looks at is seen through it.)
  var plunge = Plunge(at, at, at, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0);
  if (lens.acts[4].x > 0.0) {
    plunge = plunged(at, size);
    at = select(plunge.outside, plunge.inside, plunge.cover > 0.5);
  }
  // @warp dive
  // The picture is being shown in browser windows: this pixel looks at whichever window is in front of it here.
  let paneFrom = at;
  var glass = Panes(at, 1.0, vec3f(0.0), 0.0, 1.0);
  if (lens.acts[0].x > 0.0) {
    glass = panes(at / scale, size / scale, lens.sun.xy / scale, lens.acts[0].x, scale);
    at = glass.at * scale;
  }
  // An ordinary page is breaking in (once there is a page to break in): rows of the picture slip sideways with it.
  let paged = lens.acts[1].x > 0.0 && textureDimensions(pageMap).x > 64u;
  if (paged) { at.x += scale * slipped(position.xy / scale, lens.acts[1].x, lens.acts[1].w); }
  // @warp windows
  // Something heavy has come down: the whole picture jumps.
  at += lens.jolt.x * 9.0 * scale * vec2f(sin(lens.frame.x * 71.0), cos(lens.frame.x * 59.0));

  // The hand that inked it was not quite steady: every line wanders a little, and breathes.
  let sheet = position.xy / scale;
  let drift = lens.frame.x * 0.07;
  at += scale * 2.6 * (vec2f(cloudy(sheet / 58.0 + vec2f(3.1, drift)), cloudy(sheet / 58.0 + vec2f(17.7 - drift, 5.0))) - 0.5);
  let stock = textureLoad(paperMap, vec2i(position.xy), 0);
  at += scale * 0.9 * (stock.ba - 0.5);

  // The ground gives under each step the terminal takes.
  if (lens.tread.w > 0.0) {
    let age = lens.tread.z;
    let off = (at - lens.tread.xy) * vec2f(1.0, 2.6);
    let far = length(off);
    let wave = exp(-pow((far - lens.frame.w * (0.12 + 0.88 * (1.0 - (1.0 - age) * (1.0 - age)))) / (0.14 * lens.frame.w), 2.0));
    at += off / max(far, 1e-3) * vec2f(1.0, 0.4) * wave * lens.tread.w * 4.5 * scale * (1.0 - age) * (1.0 - age);
  }

  if (lens.sun.w > 0.0 && lens.sun.z < 1.4) {
    let age = lens.sun.z;
    let off = (at - lens.shock.xy) * vec2f(1.0, 2.2);
    let far = length(off) / scale;
    let wave = exp(-pow((far - 16.0 - 440.0 * (1.0 - exp(-age * 2.4))) / (22.0 + 36.0 * age), 2.0));
    at += off / max(length(off), 1e-3) * vec2f(1.0, 0.45) * wave * lens.sun.w * 13.0 * scale * exp(-age * 2.6);
  }

  // Where the visitor has pressed, a ring runs out through the picture.
  let poked = lens.acts[7];
  let pokeLife = poked.w * smoothstep(0.0, 0.04, poked.z) * (1.0 - smoothstep(0.3, 0.7, poked.z));
  let pokeOff = position.xy - poked.xy * scale;
  let pokeFar = length(pokeOff) / scale;
  let pokeReach = 8.0 + 190.0 * (1.0 - exp(-poked.z * 3.4));
  if (pokeLife > 0.0) {
    let wave = exp(-pow((pokeFar - pokeReach) / (10.0 + 26.0 * poked.z), 2.0));
    at += pokeOff / max(length(pokeOff), 1e-3) * wave * pokeLife * 11.0 * scale;
  }

  if (lens.hazeK.x > 0.0) {
    if (all(position.xy > lens.haze.xy) && all(position.xy < lens.haze.zw)) {
      let k = (position.xy - lens.haze.xy) / (lens.haze.zw - lens.haze.xy);
      let edge = smoothstep(0.0, 0.2, k.x) * (1.0 - smoothstep(0.8, 1.0, k.x)) * smoothstep(0.0, 0.4, k.y) * (1.0 - smoothstep(0.82, 1.0, k.y));
      let hp = position.xy / lens.hazeK.y;
      let rise = lens.frame.x;
      let wob = vec2f(cloudy(hp * vec2f(2.4, 1.4) + vec2f(0.0, rise * 2.7)), cloudy(hp * vec2f(2.4, 1.4) + vec2f(7.3, rise * 3.2))) - 0.5;
      at += wob * vec2f(1.0, 0.55) * lens.hazeK.x * lens.hazeK.z * edge;
    }
  }
  let fromSun = at - lens.sun.xy;
  let pull = 0.006 * maw * smoothstep(60.0 * scale, 520.0 * scale, length(fromSun));
  let middle = (at / size - 0.5) * vec2f(size.x / size.y, 1.0);
  let corner = dot(middle, middle);
  let part = middle / vec2f(size.x / size.y, 1.0) * ((0.0016 + 0.0035 * maw) * corner) + vec2f(0.3, 0.18) * scale / size;
  let taps = select(1, 6, maw > 0.01);
  var c = vec3f(0.0);
  var softness = 0.0;
  for (var i = 0; i < taps; i++) {
    let spot = (lens.sun.xy + fromSun * (1.0 - pull * f32(i) / 5.0)) / size;
    let green = textureSampleLevel(sourceMap, bilinear, spot, 0.0);
    c += vec3f(textureSampleLevel(sourceMap, bilinear, spot + part, 0.0).r, green.g, textureSampleLevel(sourceMap, bilinear, spot - part, 0.0).b);
    softness += green.a;
  }
  c /= f32(taps);
  softness /= f32(taps);
  let uv = at / size;

  // Out of focus: the same place seen through a wider opening.
  if (softness > 0.03) {
    var wide = vec3f(0.0);
    for (var i = 0; i < 9; i++) {
      let turn = f32(i) * 2.39996;
      let reach = sqrt((f32(i) + 0.5) / 9.0) * softness * 3.4 * scale;
      wide += textureSampleLevel(sourceMap, bilinear, uv + vec2f(cos(turn), sin(turn)) * reach / size, 0.0).rgb;
    }
    c = mix(c, wide / 9.0, min(softness * 2.2, 1.0));
  }

  c = min(c, vec3f(1.0)) + textureSampleLevel(glowMap, bilinear, uv, 0.0).rgb * (0.42 + 0.3 * maw);

  // The light thrown about inside the lens (see flares()).
  c += textureSampleLevel(flareMap, bilinear, uv, 0.0).rgb;

  // Ink on paper: it took unevenly, pooled a little here and there, and has worn thin in spots (see paper()).
  c *= 0.89 + 0.17 * stock.r;
  c = mix(c, c + (vec3f(0.96, 0.89, 0.74) - c) * 0.13, stock.g);

  // Flying fast, streaks of light run out from where the picture is heading.
  if (lens.shock.z > 0.05) {
    let outward = position.xy - vec2f(lens.sun.x, lens.shock.w);
    let far = length(outward) / scale;
    let lane = atan2(outward.y, outward.x) / 6.2832 * 150.0;
    let luck = speck(vec2f(floor(lane), 7.0));
    let run = fract(far / 460.0 - lens.frame.x * (1.3 + luck) + luck * 9.0);
    let streak = step(0.7, luck) * smoothstep(0.22, 0.06, abs(fract(lane) - 0.5)) * smoothstep(0.0, 0.05, run) * (1.0 - smoothstep(0.08, 0.34, run)) * smoothstep(120.0, 420.0, far);
    c = mix(c, vec3f(1.0, 0.97, 0.86), 0.85 * min(lens.shock.z / 3.0, 1.0) * streak);
  }

  if (pokeLife > 0.0) {
    let band = 4.2 * pokeLife;
    let edge = abs(pokeFar - pokeReach);
    c = mix(c, vec3f(0.1137, 0.0863, 0.0784), clamp((band * 1.45 + 0.4 - edge) * scale + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.08, pokeLife));
    c = mix(c, bowAt(pokeFar / 70.0 - poked.z * 1.6) * 1.05, clamp((band - edge) * scale + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.08, pokeLife));
  }
  // Grain, a new frame of it twelve times a second, and a fine screen in the shadows.
  let light = dot(c, vec3f(0.3, 0.59, 0.11));
  let tick = floor(lens.frame.x * 12.0);
  let grain = speck(position.xy + vec2f(37.0, 17.0) * tick) + speck(position.xy * 1.7 - vec2f(11.0, 29.0) * tick) - 1.0;
  c *= 1.0 + 0.05 * grain * (1.0 - 0.6 * light);
  let pitch = 3.14159 / max(1.25 * scale, 1.6);
  let screen = sin((position.x + position.y) * 0.7071 * pitch) * sin((position.x - position.y) * 0.7071 * pitch);
  c *= 1.0 - 0.05 * (0.5 + 0.5 * screen) * (1.0 - smoothstep(0.1, 0.75, light));
  c *= 1.0 - 0.34 * smoothstep(0.22, 1.05, corner);
  if (lens.acts[0].x > 0.0) {
    // Behind the windows the picture has gone as grey as the page it began as, and only round the sun has it kept its colour.
    // A small window takes in several pixels of the picture with each of its own: it shows them all, not one in four.
    if (glass.keep > 0.0 && glass.fine > 1.2) {
      let taken = min(four(uv, 0.25 * glass.fine / size), vec3f(1.0)) + textureSampleLevel(glowMap, bilinear, uv, 0.0).rgb * (0.42 + 0.3 * maw);
      c = mix(c, taken * (1.0 - 0.34 * smoothstep(0.22, 1.05, corner)), 0.8 * smoothstep(1.2, 2.2, glass.fine));
    }
    var behind = c;
    if (glass.keep > 0.0 && glass.back > 0.0) { behind = textureSampleLevel(sourceMap, bilinear, paneFrom / size, 0.0).rgb; }
    let pale = 0.6 + 0.34 * dot(min(behind, vec3f(1.0)), vec3f(0.3, 0.59, 0.11));
    let sunny = 1.0 - smoothstep(1.2, 3.2, length(paneFrom - lens.sun.xy) / max(lens.acts[0].y * scale, 1.0));
    c = c * glass.keep + glass.ink + mix(vec3f(pale), behind, 0.1 + 0.75 * sunny) * glass.back;
  }
  if (paged) { c = brokenIn(c, position.xy, size); }
  // @over windows
  if (lens.acts[4].x > 0.0) { c = dived(c, plunge, position.xy, size); }
  // @over dive
  if (lens.acts[2].z > 0.0) { c = notice(c, position.xy, size); }
  // @over notice
  if (lens.stare.x > 0.0) { c = planetSees(c, position.xy, size); }
  if (lens.gate.w > 0.5) { c = front(c, position.xy, size); }
  return vec4f(c, 1.0);
}
`

// The fluid: a velocity field kept divergence-free, and the dye it carries.
// Every pass is a full-screen triangle drawn into one of the simulation's textures.
export const simShader = /* wgsl */ `
struct Sim {
  size: vec4f,    // hero width and height in design units, time step, time
  sun: vec4f,     // x, y, ring wavelength, rings per second
  pointer: vec4f, // x, y, and its velocity in design units a second
  grid: vec4f,    // velocity texture width and height, dye texture width and height
  pin: vec4f,     // radius round the sun where the dye is held to fresh rings
  shot: vec4f,    // where a laser is burning the liquid (x, y) and how hard
  blast: vec4f,   // where it churns the fluid (x, y) and how hard
  quake: vec4f,   // how hard the whole fluid is being shaken
}
@group(0) @binding(0) var<uniform> s: Sim;
@group(0) @binding(1) var velocityMap: texture_2d<f32>;
@group(0) @binding(2) var pressureMap: texture_2d<f32>; // x pressure, y divergence
@group(0) @binding(3) var dyeMap: texture_2d<f32>;
@group(0) @binding(4) var bilinear: sampler;

const TAU = 6.283185307;

@vertex
fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

fn hash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let k = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2f(1.0, 0.0)), k.x),
    mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), k.x),
    k.y,
  );
}

fn velocityAt(c: vec2i) -> vec2f {
  return textureLoad(velocityMap, clamp(c, vec2i(0), vec2i(s.grid.xy) - 1), 0).xy;
}

fn pressureAt(c: vec2i) -> f32 {
  return textureLoad(pressureMap, clamp(c, vec2i(0), vec2i(s.grid.xy) - 1), 0).x;
}

// Undisturbed, the dye is rings round the sun: phase falls with distance, and
// each drop remembers the direction it left in.
fn rings(x: vec2f) -> vec4f {
  let r = x - s.sun.xy;
  let len = max(length(r), 1e-3);
  return vec4f(-len / s.sun.z, r / len, 0.0);
}

// Carry the velocity along itself, let it die away, and stir it.
@fragment
fn moveVelocity(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / s.grid.xy;
  let x = uv * s.size.xy;
  let dt = s.size.z;
  let t = s.size.w;
  let here = textureSampleLevel(velocityMap, bilinear, uv, 0.0).xy;
  var v = textureSampleLevel(velocityMap, bilinear, uv - here * dt / s.size.xy, 0.0).xy * exp(-0.45 * dt);

  // Slow vortices wander the hero on looping paths, alternating which way they spin.
  let reach = min(s.size.x, s.size.y);
  for (var i = 0; i < 7; i++) {
    let k = f32(i);
    let home = s.size.xy * (0.5 + 0.46 * vec2f(sin(t * (0.05 + 0.013 * k) + k * 2.4), cos(t * (0.043 + 0.011 * k) + k * 4.1)));
    let r = x - home;
    let radius = reach * (0.13 + 0.05 * sin(k * 1.7 + t * 0.07));
    let spin = select(-1.0, 1.0, i % 2 == 0) * (0.75 + 0.35 * sin(t * 0.11 + k * 2.0));
    v += dt * 100.0 * spin * vec2f(-r.y, r.x) / radius * exp(-dot(r, r) / (radius * radius));
  }

  // A drifting field of small eddies keeps the whole surface restless.
  let n = x * 0.0045;
  let e = vec2f(0.35, 0.0);
  let drift = vec2f(t * 0.035, -t * 0.028);
  let eddy = vec2f(
    noise(n + e.yx + drift) - noise(n - e.yx + drift),
    noise(n - e.xy + drift) - noise(n + e.xy + drift),
  );
  v += dt * 62.0 * (1.0 + 9.0 * s.quake.x) * eddy;

  // A laser churns the liquid round where it lands, and a roar shakes all of it.
  let fine = x * 0.021 + vec2f(t * 2.3, -t * 1.9);
  let churn = vec2f(
    noise(fine + e.yx) - noise(fine - e.yx),
    noise(fine - e.xy) - noise(fine + e.xy),
  );
  let struck = x - s.blast.xy;
  v += dt * 2600.0 * churn * (s.blast.z * exp(-dot(struck, struck) / 12000.0) + 0.5 * s.quake.x);
  let away = x - s.sun.xy;
  let far = max(length(away), 1.0);
  v += dt * 900.0 * s.quake.x * vec2f(-away.y, away.x) / far * sin(far * 0.012 - t * 5.0);

  // The pointer drags the liquid under it along.
  let near = x - s.pointer.xy;
  let grip = exp(-dot(near, near) / 4200.0) * smoothstep(8.0, 60.0, length(s.pointer.zw));
  v = mix(v, clamp(s.pointer.zw, vec2f(-900.0), vec2f(900.0)), 0.55 * grip);

  return vec4f(v, 0.0, 1.0);
}

// How much the velocity is squeezing or stretching each cell, beside the last pressure.
@fragment
fn measure(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = vec2i(position.xy);
  let squeeze = 0.5 * (velocityAt(c + vec2i(1, 0)).x - velocityAt(c - vec2i(1, 0)).x + velocityAt(c + vec2i(0, 1)).y - velocityAt(c - vec2i(0, 1)).y);
  return vec4f(pressureAt(c) * 0.9, squeeze, 0.0, 1.0);
}

// One relaxation step toward the pressure that cancels that squeeze.
@fragment
fn relax(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = vec2i(position.xy);
  let squeeze = textureLoad(pressureMap, c, 0).y;
  let p = (pressureAt(c + vec2i(1, 0)) + pressureAt(c - vec2i(1, 0)) + pressureAt(c + vec2i(0, 1)) + pressureAt(c - vec2i(0, 1)) - squeeze) * 0.25;
  return vec4f(p, squeeze, 0.0, 1.0);
}

// Take the pressure's slope out of the velocity, leaving a flow that only swirls.
@fragment
fn swirl(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = vec2i(position.xy);
  let slope = 0.5 * vec2f(pressureAt(c + vec2i(1, 0)) - pressureAt(c - vec2i(1, 0)), pressureAt(c + vec2i(0, 1)) - pressureAt(c - vec2i(0, 1)));
  return vec4f(velocityAt(c) - slope, 0.0, 1.0);
}

fn dyeLoad(c: vec2i) -> vec4f {
  return textureLoad(dyeMap, clamp(c, vec2i(0), vec2i(s.grid.zw) - 1), 0);
}

// Carry the dye along the flow plus a steady push away from the sun, which
// keeps giving off fresh rings.
@fragment
fn moveDye(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / s.grid.zw;
  let x = uv * s.size.xy;
  let dt = s.size.z;
  let out = x - s.sun.xy;
  let len = max(length(out), 1e-3);
  let v = textureSampleLevel(velocityMap, bilinear, uv, 0.0).xy + out / len * s.sun.z * s.sun.w;
  let source = x - v * dt;
  var q = rings(source);
  if (source.x > 0.0 && source.y > 0.0 && source.x < s.size.x && source.y < s.size.y) {
    let p = source / s.size.xy * s.grid.zw - 0.5;
    let i = vec2i(floor(p));
    let f = fract(p);
    q = mix(
      mix(dyeLoad(i), dyeLoad(i + vec2i(1, 0)), f.x),
      mix(dyeLoad(i + vec2i(0, 1)), dyeLoad(i + vec2i(1, 1)), f.x),
      f.y,
    );
  }
  q.x -= s.sun.w * dt;
  // A moving pointer leaves a trail of new rings.
  let near = x - s.pointer.xy;
  q.x += dt * 3.0 * exp(-dot(near, near) / 2600.0) * smoothstep(8.0, 80.0, length(s.pointer.zw));
  // A laser burns a hole, which then heals.
  let struck = x - s.shot.xy;
  q.w = min(q.w * exp(-0.13 * dt) + dt * 4.5 * s.shot.z * exp(-dot(struck, struck) / 1300.0), 1.5);
  return mix(q, rings(x), 1.0 - smoothstep(s.pin.x * 0.55, s.pin.x, len));
}

@fragment
fn startDye(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return rings(position.xy / s.grid.zw * s.size.xy);
}
`

const VILLAGE_OFFSET = 840
const BOSS_RIG = 1096
const FIRE_OFFSET = 1116
const HAZE_OFFSET = 1580
const TALK_OFFSET = 1588
const COSMOS_OFFSET = 1596 // cosmos, chorusBeat, then the 14 stars
export const UNIFORM_FLOATS = 2484

// A camera circling its subject: screen right, screen up, and the way back to the eye.
export function orbit(yaw, pitch) {
  const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const up = [
    right[2] * back[1] - right[1] * back[2],
    right[0] * back[2] - right[2] * back[0],
    right[1] * back[0] - right[0] * back[1],
  ]
  return { right, up, back }
}

// Where the terminal is seen from. It sways a little, and leans toward the pointer.
export const camera = (layout, time, lean = [0, 0]) =>
  orbit(
    layout.machine.yaw + 0.05 * Math.sin(time * 0.35) + lean[0],
    layout.machine.pitch + 0.015 * Math.sin(time * 0.27 + 1) + lean[1],
  )

// The sun is seen nearly head on. It nods slowly and follows the pointer.
export const sunCamera = (time, lean = [0, 0]) =>
  orbit(0.16 * Math.sin(time * 0.31) + lean[0], 0.07 * Math.sin(time * 0.23 + 2) + lean[1])

// A CSS matrix that lays a boxWidth by boxHeight element flat on the terminal's
// glass. box is the .scene box [x, y, width, height] in the element's own pixels.
export function glassMatrix(layout, cam, box, boxWidth, boxHeight, bob = 0, shift = 0) {
  const k = layout.machine.size * box[2]
  const { monitor, glass, target } = MACHINE
  const halfW = glass.half[0] * 0.8
  const halfH = glass.half[1] * 0.74
  const corner = [
    monitor.centre[0] + glass.centre[0] - halfW - target[0],
    monitor.centre[1] + glass.centre[1] + halfH - target[1],
    monitor.centre[2] + monitor.half[2] - glass.depth - target[2],
  ]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const x = box[2] * layout.machine.at[0] + shift + k * dot(corner, cam.right)
  const y = box[3] * layout.machine.at[1] + bob - k * dot(corner, cam.up)
  const across = (2 * halfW * k) / boxWidth
  const down = (2 * halfH * k) / boxHeight
  return [across * cam.right[0], -across * cam.up[0], -down * cam.right[1], down * cam.up[1], x, y]
}

// scene is the .scene box in design units: [x, y, width, height].
// title is the lettering: { box: [x, y, width, height] in design units, map: its entry in art/title.json }.
// dye is the dye texture's [width, height]. design is the hero's width in design units.
export function packUniforms(out, { width, height, time, layout, design = layout.width, pointer, scene, cam, sunCam, bob = 0, lean = [0, 0], title, dye = [1, 1], light = [-0.49, -0.87], show, dawn = [0, 1e9], gait = { phase: 0, stride: [0, 0], lift: 0 } }) {
  const { wavelength, rate, rays, mirrors } = settings.liquid
  const heroHeight = height / (width / design)
  const place = ([x, y, ...rest]) => [x < 0 ? design + x : x, y < 0 ? heroHeight + y : y, ...rest]
  out.fill(0)
  out.set([width, height, time, design], 0)
  world.horizon = layout.horizon ?? LAND.horizon
  out.set([light[0], light[1], layout.line, world.horizon], 4)
  out.set([wavelength, (rate * time) % 20, rays, mirrors], 8)
  out.set([dye[0], dye[1], heroHeight, layout.aim], 12)
  out.set(pointer, 16)
  const clouds = layout.clouds.map(place)
  if (scene) {
    const [x, y, w, h] = scene
    out.set(sunAt(layout, scene), 20)
    out.set(scene, 24)
    out.set(cam.right, 28)
    out.set(cam.up, 32)
    out.set(cam.back, 36)
    out.set([x + w * layout.machine.at[0], y + h * layout.machine.at[1], w * layout.machine.size, gait.phase], 40)
    out.set(sunCam.right, 44)
    out.set(sunCam.up, 48)
    out.set(sunCam.back, 52)
    for (const [cx, cy, k] of layout.sceneClouds) clouds.push([x + w * cx, y + h * cy, w * k, 0])
  }
  out.set([layout.planet[0], layout.planet[1], layout.planet[2] * (1 + (show?.swell ?? 0)), show ? show.wink : 0], 56)
  out.set(show?.watch ?? [0.12, 0.04, 0.267, 0], 832)
  out.set(show?.boss ?? [0, 0, 0, 0], 836)
  out.fill(0,BOSS_RIG,BOSS_RIG+20)
  if(show?.bossRig) out.set(show.bossRig,BOSS_RIG)
  if(show?.comets) out.set(show.comets,BOSS_RIG+4)
  out.set(lean, 60)
  if (show?.whirl) out.set(show.whirl, 62)
  if (title) {
    out.set(title.box, 64)
    out.set([title.map.range, title.map.line, title.map.shadow[0], title.map.shadow[1]], 68)
    out.set([title.map.width, title.map.height, title.map.deep], 72)
  }
  layout.flowers.slice(0, 2).forEach((flower, i) => out.set([flower[0], heroHeight + flower[1], flower[2]], 76 + i * 4))
  clouds.slice(0, 6).forEach((c, i) => out.set(c, 84 + i * 4))
  out.set([0, 0, -9, layout.focal], 288)
  out.set([0, 1e9, 0, design / 2], 292)
  out.set([0, 0, 99, 0], 332)
  out.set([1, 1, 1, 0], 336)
  out.set([0, 0, 0.3, 0], 436)
  if (show) {
    out.set(show.beam, 108)
    out.set([show.beam[2], show.maw, show.tears[0], show.tears[1]], 112)
    out.set(show.weather, 212)
    out.set([show.sky[0], show.sky[1]], 216)
    out.set(show.bolt, 220)
    show.critters.slice(0, 8).forEach(([who, how], i) => {
      out.set(who, 224 + i * 4)
      out.set(how, 256 + i * 4)
    })
    show.blooms.slice(0, 12).forEach(([spot, look], i) => {
      out.set(spot, 116 + i * 4)
      out.set(look, 164 + i * 4)
    })
    out.set(show.world, 288)
    out.set(show.orb, 292)
    show.sites.slice(0, 8).forEach((site, i) => out.set(site, 296 + i * 4))
    // Conservative projection of a growing column. Do this eight times a frame,
    // not eight times for every fragment in the valley. Rectangles are design units.
    const v = show.view
    const band = [1e8, 1e8, -1e8, -1e8]
    for (let i = 0; i < show.sites.length; i++) {
      const [x,z,amount,key] = show.sites[i]
      if (amount <= 0 || z-v.z < 5) continue
      const seed = key % 1, sz = 0.87+0.24*seed
      const a = smooth(0,0.37,amount), b = smooth(0.16,0.60,amount), c = smooth(0.39,0.84,amount), e = smooth(0.62,1,amount)
      const r = (1.95*a+0.12)*sz, h = (2.2*a+0.95*b+1.35*c+e)*sz
      const y = world.ground(x,z)-0.23
      const z0 = Math.max(1,z-v.z-r), z1 = z-v.z+r
      const k0 = v.focal/z0, k1 = v.focal/z1
      const cx = v.cx, cy = v.height-world.horizon
      const off = x-v.x, bottom = world.eye-y+0.67*sz, top = world.eye-y-h-1.7
      const box = [cx+Math.min((off-r)*k0,(off-r)*k1)-4, cy+Math.min(top*k0,top*k1)-4,
        cx+Math.max((off+r)*k0,(off+r)*k1)+4, cy+Math.max(bottom*k0,bottom*k1)+4]
      out.set(box,VILLAGE_OFFSET+4*i)
      band[0]=Math.min(band[0],box[0]); band[1]=Math.min(band[1],box[1]); band[2]=Math.max(band[2],box[2]); band[3]=Math.max(band[3],box[3])
    }
    out.set(band,VILLAGE_OFFSET+32)
    packBrushFire(out, show, v, design, heroHeight)
    out.set(show.pulse, 332)
    out.set(show.grade, 336)
    out.set(show.face, 436)
    if (show.talk) out.set(show.talk, TALK_OFFSET)
    if (show.talkFace) out.set(show.talkFace, TALK_OFFSET + 4)
    show.script.forEach((line, i) => out.set(line, 444 + i * 4))
    out.set(show.scriptInfo, 464)
    out.set(show.lifting, 468)
    out.set(show.whale, 472)
    out[479] = show?.unfold ?? 0
    out[596] = show?.unmask ?? 0
    show.scorches.forEach((scorch, i) => out.set(scorch, 480 + i * 4))
    // Those still moving the ground go first, with how many there are and the circle they can reach.
    const moving = (stomp) => time - stomp[2] >= 0 && time - stomp[2] < (Math.abs(stomp[3]) / 0.9 > 1.25 ? 5.5 : 2.6) && stomp[3] !== 0
    const order = [...show.stomps].sort((a, b) => moving(b) - moving(a))
    order.forEach((stomp, i) => out.set(stomp, 544 + i * 4))
    const live = order.filter(moving)
    const cx = live.reduce((sum, stomp) => sum + stomp[0], 0) / (live.length || 1)
    const cz = live.reduce((sum, stomp) => sum + stomp[1], 0) / (live.length || 1)
    out.set([cx, cz, Math.max(0, ...live.map((stomp) => Math.hypot(stomp[0] - cx, stomp[1] - cz) + (time - stomp[2]) * 5.6 + 5.5)), live.length], 592)
    // What the shader's heaved() works out for each of them that does not depend on the point: once a frame, not at every step of every ray.
    const fr = Math.fround, ease = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k) }
    out.fill(0, 2408, 2456)
    live.forEach((stomp, i) => {
      const age = fr(fr(time) - fr(stomp[2])), hard = Math.min(Math.abs(fr(stomp[3])) / 0.9, 2.4), lasts = hard > 1.25 ? 5.5 : 2.6
      out.set([fr(ease(0, 0.1, age) * (1 - ease(0.65 * lasts, lasts, age))) * fr(hard), age * 5.6, 0.5 * Math.exp(-age * 0.75), 0.3 * Math.exp(-age * 3.2)], 2408 + 4 * i)
    })
    if (show.snake) {
      out.set(show.snake, 600)
      out.set(show.viperPose, 597)
      out.set(show.viperRig, 876)
      const x=Math.max(0,Math.floor(out[696])), y=Math.max(0,Math.floor(out[697]))
      const w=Math.min(out[3],Math.ceil(out[698]))-x, h=Math.min(out[14],Math.ceil(out[699]))-y
      const k=Math.min(1.15,out[0]/out[3],1022/Math.max(1,w),446/Math.max(1,h))
      out.set([x-1/k,y-1/k,k,0],1076)
    }
    if (show.officers) out.set(show.officers, 704)
    out.set(show.eyes, 440)
    show.motes.slice(0, 24).forEach((mote, i) => out.set(mote, 340 + i * 4))
    // Most of the picture has no spark near it and no flower: the box the sparks are in, and how high the tallest flower reaches.
    const lit = show.motes.slice(0, 24).filter((mote) => mote[2] > 0)
    const span = (pick, axis) => pick(...lit.map((mote) => mote[axis]))
    out.set(lit.length ? [span(Math.min, 0) - 57, span(Math.min, 1) - 57, span(Math.max, 0) + 57, span(Math.max, 1) + 57] : [1, 1, 0, 0], 472)
    out[476] = Math.min(1e6, ...show.blooms.slice(0, 12).map(([spot, look]) => spot[1] - 5.4 * look[0]))
    dawn = [dawn[0] + show.drop, dawn[1]]
  }
  const hop = show?.hop ?? [0, 0]
  // For the dive: where the middle of the terminal's glass is on the hero just now,
  // how big the terminal is, and how its glass lies (see Lens.acts [4] and [5]).
  if (show?.lens && scene) {
    const k = scene[2] * layout.machine.size
    const { monitor, glass, target } = MACHINE
    const middle = [
      monitor.centre[0] + glass.centre[0] + 0.02 * Math.sin(gait.phase * Math.PI * 2) - target[0],
      monitor.centre[1] + glass.centre[1] + gait.lift + hop[0] + hop[1] - target[1],
      monitor.centre[2] + monitor.half[2] - glass.depth - target[2],
    ]
    const along = (axis) => middle[0] * axis[0] + middle[1] * axis[1] + middle[2] * axis[2]
    show.lens.set([scene[0] + scene[2] * layout.machine.at[0] + k * along(cam.right), scene[1] + scene[3] * layout.machine.at[1] - k * along(cam.up), k, cam.right[0], -cam.up[0], cam.up[1]], 17)
  }
  out.set([gait.stride[0], gait.stride[1], gait.lift + hop[0] + hop[1], hop[0]], 328)
  out.set(dawn, 218)
  if (show?.cosmos) {
    out.set(show.cosmos, COSMOS_OFFSET)
    out.set(show.chorus, COSMOS_OFFSET + 4)
    if (show.cosmos[0] > 0) out.set(show.stars, COSMOS_OFFSET + 8)
    for (let i = 0; i < 6; i++) out[86 + i * 4] *= 1 + 0.07 * show.chorus[1] // the clouds swell on the beat
  }
  return out
}

// Bin each little fire on the CPU. The ground-light volume and the ink drawing
// share one rectangle. At a pixel only visit bits in its tile, back to front.
function packBrushFire(out, show, v, width, height) {
  if (!show.fireDesk) return
  const o = FIRE_OFFSET
  out.set(show.fireDesk, o + 5)
  out.set(show.fireWindows, o + 456)
  const list = show.fires
  if (!list.length) return
  const band = [width,height,0,0], haze = [width,height,0,0]
  let n = 0, hazeHot = 0, hazeK = 0, hazeW = 0
  for (const f of list) {
    const dz = f.fz - v.z
    if (dz < 1 || dz > world.far) continue
    const fade = smooth(1,6,dz)*(1-smooth(95,155,dz))
    if (!fade) continue
    const [x,y,k] = world.project(v,f.fx,f.fy,f.fz)
    const flameW = f.width, flameH = f.height
    const r = f.radius + 2.6
    const z0 = Math.max(0.25,f.z-v.z-r), z1 = Math.max(z0,f.z-v.z+r)
    const k0 = v.focal/z0, k1 = v.focal/z1, cx = v.cx, cy = height-world.horizon
    const a = f.x-v.x-r, b = f.x-v.x+r, top = world.eye-f.y-4.2, bot = world.eye-f.y+2.5
    const H = flameH, R = f.radius
    const lx = Math.max(0,Math.min(x-k*(2.95*H+0.6*R+0.1),cx+Math.min(a*k0,a*k1))-3)
    const rx = Math.min(width,Math.max(x+k*(3.5*H+0.6*R+0.1),cx+Math.max(b*k0,b*k1))+3)
    const ty = Math.max(0,Math.min(y-k*(Math.max(7.5*H,4.5*H+0.5*R)+0.1),cy+Math.min(top*k0,top*k1))-3)
    const by = Math.min(height,Math.max(y+k*(2.25*H+0.5*R+0.1),cy+Math.max(bot*k0,bot*k1))+3)
    if (rx<=lx || by<=ty) continue
    const bit = 1 << n
    for(let j=Math.floor(8*ty/height); j<=Math.min(7,Math.floor(8*by/height)); j++)
      for(let i=Math.floor(8*lx/width); i<=Math.min(7,Math.floor(8*rx/width)); i++) out[o+8+j*8+i]+=bit
    band[0]=Math.min(band[0],lx); band[1]=Math.min(band[1],ty)
    band[2]=Math.max(band[2],rx); band[3]=Math.max(band[3],by)
    const hot = f.heat*fade
    if (hot > 0.05) {
      haze[0]=Math.min(haze[0],x-k*flameW*1.4); haze[1]=Math.min(haze[1],y-k*flameH*3.0)
      haze[2]=Math.max(haze[2],x+k*(flameW*1.5+flameH*0.4)); haze[3]=Math.max(haze[3],y-k*flameH*0.15)
      hazeHot=Math.max(hazeHot,hot); hazeK+=k*hot; hazeW+=hot
    }
    out.set([f.x,f.y,f.z,f.radius],o+72+n*4)
    out.set([x,y,k,dz],o+168+n*4)
    out.set([f.heat*fade,f.smoke*fade,f.ash*fade,f.seed],o+264+n*4)
    out.set([flameW,flameH,f.slope,f.steam],o+360+n*4)
    n++
  }
  if (hazeW) {
    out.set([Math.max(0,haze[0]),Math.max(0,haze[1]),Math.min(width,haze[2]),Math.min(height,haze[3])],HAZE_OFFSET)
    out.set([hazeHot,hazeK/hazeW,0,0],HAZE_OFFSET+4)
  }
  out[o+4]=n; out.set(band,o)
}

// The kaleidoscope in reverse: where in the fluid the hero point [x, y] is looking.
export function intoFluid(layout, sun, [x, y], time) {
  const { mirrors, turn, soft } = settings.liquid
  if (mirrors < 1) return [x, y]
  const span = (Math.PI * 2) / mirrors
  const len = Math.hypot(x - sun[0], y - sun[1])
  let a = Math.atan2(y - sun[1], x - sun[0]) - turn * time
  a = layout.aim - (span / (Math.PI * 2)) * Math.asin(soft * Math.cos((Math.PI * 2 * a) / span))
  return [sun[0] + len * Math.cos(a), sun[1] + len * Math.sin(a)]
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))
const smooth = (a, b, x) => {
  const k = clamp01((x - a) / (b - a))
  return k * k * (3 - 2 * k)
}

// The land the picture flies over: a river valley that goes on for ever.
// Keep river and ground in step with the shader's.
export const world = {
  ...LAND,
  river: (z) => 3.2 * Math.sin(z * 0.045) + 1.4 * Math.sin(z * 0.117 + 1),
  ground(x, z) {
    const off = Math.abs(x - world.river(z))
    const a = 0.5 + 0.5 * Math.sin(x * 0.19 + 1.7 * Math.sin(z * 0.083))
    const b = 0.5 + 0.5 * Math.sin(z * 0.131 + 1.3 * Math.sin(x * 0.097) + 2)
    return -0.75 + 0.55 * smooth(1, 3.2, off) + smooth(1, 14, off) * (0.35 + 2.7 * a * b + 0.3 * Math.sin(x * 0.53 + z * 0.41))
  },
  // Where the eye is at a time. It follows the river loosely. cx is the
  // vanishing point's x on the hero, height the hero's, focal the lens.
  view: (time, { cx, height, focal, pan = 0, level = -0.35 }) => {
    const z = world.speed * time
    return { x: 0.7 * world.river(z + 10) + pan * 1.5, z, cx, height, focal, level }
  },
  // Where a point of the world lands on the hero: x, y, and design units per world unit there.
  project(view, x, y, z) {
    const k = view.focal / Math.max(z - view.z, 0.01)
    return [view.cx + (x - view.x) * k, view.height - world.horizon - (y - world.eye) * k, k]
  },
  // The point of the land or water under a point of the hero, or null for sky.
  pick(view, sx, sy) {
    const rise = view.height - sy
    if (rise > world.horizon - 2) return null
    const raw = [sx - view.cx, rise - world.horizon, view.focal]
    const len = Math.hypot(...raw)
    const rd = raw.map((n) => n / len)
    const at = (t) => [view.x + rd[0] * t, world.eye + rd[1] * t, view.z + rd[2] * t]
    let t = Math.max((world.eye - 3.3) / -rd[1], 0)
    let last = t
    for (let i = 0; i < 90 && t < world.far; i++) {
      const p = at(t)
      const gap = p[1] - world.ground(p[0], p[2])
      if (gap < 0) {
        let a = last
        let b = t
        for (let k = 0; k < 6; k++) {
          const m = (a + b) / 2
          const q = at(m)
          if (q[1] - world.ground(q[0], q[2]) < 0) b = m
          else a = m
        }
        const wet = (world.eye - view.level) / -rd[1]
        const [x, y, z] = at(Math.min(b, wet))
        return { x, y, z, wet: wet < b }
      }
      last = t
      t += Math.max(gap * 0.6, 0.012 * t)
    }
    return null
  },
}

// What goes on. The sun fires its lasers wherever the pointer is pressed, and
// at targets of its own when left alone: on the land they grow a flower, or
// burn one that is there, or fry a walker, or knock a building down; on the
// liquid they burn a hole. Storms come over and flood the valley. Little
// walking computers build a village as the land goes by. Now and then the sun
// sets and a moon comes up in its place.
// tick() moves it all on and returns what the picture and the fluid need.
// The cosmos, seconds after it begins: the paint takes `open` to part and as long
// to come back, and everybody sings from `chorus`. First at `first` s, then every
// `again` (if the sky is clear, and no change of day and night is near).
const COSMOS = { first: 66, again: [115, 140], lasts: 19, open: 2.6, chorus: 5.8 }
// Everybody singing, seconds after it begins: a chord, the next, then home (held
// from `home`, let go from `release`). Each chord is the four throats' notes in
// semitones over the choir's key, lowest first; tune is the terminal's, beat and note.
const CHORUS = {
  lasts: 10, beat: 0.6, home: 6, release: 8.4,
  chords: [[0, [-4, 3, 8, 12]], [3.6, [-2, 5, 10, 14]], [6, [0, 7, 12, 16]]],
  tune: [[0, 27], [1, 24], [2, 27], [3, 32], [4, 31], [5, 32], [6, 29], [7, 26], [8, 29], [9, 34], [10, 36], [11, 40]],
}
// The stars that play, as fractions of the width and of the sky's height (down to
// the land), where the lettering, the planet, the clouds and the terminal leave sky.
const PLAYERS = {
  wide: [[0.23, 0.035], [0.39, 0.02], [0.56, 0.04], [0.72, 0.025], [0.03, 0.43], [0.13, 0.47], [0.06, 0.62], [0.16, 0.68], [0.04, 0.74],
    [0.86, 0.13], [0.97, 0.17], [0.85, 0.52], [0.965, 0.6], [0.9, 0.75]],
  narrow: [[0.4, 0.026], [0.5, 0.052], [0.94, 0.031], [0.96, 0.098], [0.04, 0.634], [0.16, 0.66], [0.25, 0.63], [0.07, 0.887], [0.18, 0.955],
    [0.28, 0.93], [0.95, 0.66], [0.975, 0.784], [0.935, 0.897], [0.983, 0.955]],
}
// Each by pitch, lowest first: semitones over the choir's key, and its kind (0 glass,
// 1 bell, 2 bowed, 3 a soft pluck). The higher a star is in the sky, the higher it sings.
const STAR_PITCH = [31, 34, 36, 38, 39, 40, 41, 43, 44, 46, 48, 51, 53, 55]
const STAR_KIND = [2, 1, 2, 3, 1, 3, 0, 1, 3, 0, 1, 0, 3, 0]
const STAR_RANKS = Object.fromEntries(Object.entries(PLAYERS).map(([key, set]) => [key, set.map((p, i) => [p[1], i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)]))

// The stars' part, written afresh for each cosmos as [seconds in, star by pitch (0
// the lowest), how loud]. It keeps to a plan, so it never noodles: one star alone,
// a call and its answer upside down from the other end of the sky, a run up into the
// chorus, each chorus chord climbed with a canon a sixteenth behind, the home chord
// at the fastest, and a falling answer to close.
function composeStars(r) {
  const notes = []
  const pick = (list) => list[Math.floor(r() * list.length)]
  const tones = (pcs) => STAR_PITCH.flatMap((p, i) => (pcs.includes(p % 12) ? [i] : []))
  const at = (list, k) => list[Math.max(0, Math.min(list.length - 1, k))]
  const minor = tones([0, 3, 5, 7, 10])
  notes.push([1.5, at(minor, 7), 0.75])
  const shape = pick([[0, 1, 2], [0, 2, 1], [2, 1, 0], [0, 2, 4], [1, 0, 2]])
  const rhythm = pick([[0, 0.3, 0.6], [0, 0.3, 0.9], [0, 0.6, 0.9], [0, 0.45, 0.6]])
  const low = 1 + Math.floor(r() * 3), high = minor.length - 2 - Math.floor(r() * 2)
  shape.forEach((step, k) => notes.push([2.7 + rhythm[k], at(minor, low + step), 0.62]))
  shape.forEach((step, k) => notes.push([3.9 + rhythm[k], at(minor, high - step), 0.55]))
  for (let k = 0; k < 4; k++) notes.push([4.8 + 0.15 * k, at(minor, low + 1 + 2 * k), 0.4 + 0.06 * k])
  const c = COSMOS.chorus
  CHORUS.chords.forEach(([from, voices], j) => {
    const to = CHORUS.chords[j + 1]?.[0] ?? CHORUS.release
    const list = tones(voices.map((v) => ((v % 12) + 12) % 12))
    const fast = j === CHORUS.chords.length - 1
    const climb = fast ? [0, 1, 2, 3, 4, 5, 4, 3, 2, 3, 4, 5, 6, 5, 4, 5] : pick([[0, 1, 2, 3, 2, 1, 2, 3], [0, 2, 1, 3, 2, 4, 3, 1], [1, 2, 3, 4, 3, 2, 1, 2]])
    const base = fast ? 0 : 1 + Math.floor(r() * 2)
    const start = from + (j === 0 ? 0.6 : 0)
    for (let k = 0; start + k * (fast ? 0.15 : 0.3) < to - 0.05; k++) {
      const when = c + start + k * (fast ? 0.15 : 0.3)
      notes.push([when, at(list, base + climb[k % climb.length]), fast ? 0.42 : 0.5])
      if (!fast) notes.push([when + 0.15, at(list, base + climb[k % climb.length] - 2), 0.32])
    }
  })
  notes.push([c + CHORUS.release, at(tones([0]), 99), 0.8])
  const home = tones([0, 4, 7])
  ;[home.length - 1, home.length - 2, home.length - 4].forEach((k, n) => notes.push([c + CHORUS.lasts + 0.4 + [0, 0.3, 0.9][n], home[k], 0.6]))
  notes.push([c + CHORUS.lasts + 1.9, home[1], 0.7])
  return notes.sort((a, b) => a[0] - b[0])
}

export function createShow(seed = 11) {
  const stream = (state) => () => {
    state = (state + 0x6d2b79f5) | 0
    let n = Math.imul(state ^ (state >>> 15), 1 | state)
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
  const random = stream(seed)
  const snakeRandom = stream(seed ^ 0x534e414b)
  const auditRandom = stream(seed ^ 0x41554449)
  const blooms = []
  const beam = { x: 0, y: 0, power: 0, held: false, until: -1, burning: null }
  let nextShot = 9.5
  let nextRoar = 27.5
  let roarUntil = -1
  let maw = 0
  let mawSpeed = 0
  let last = null
  let view = null
  let pan = 0
  let events = []
  const grade = [1, 1, 1]

  // Everything that happens has a sign. The terminal writes a line that
  // opens with it, and the sign itself rises from where the thing happened.
  const SIGNS = ['flower', 'burn', 'fried', 'razed', 'built', 'strike', 'roar', 'rain', 'dry', 'rainbow', 'sunset', 'moonrise', 'moonset', 'sunrise', 'tears', 'blood', 'taken', 'breach']
  const script = [{ seed: 3.7, length: 6, typed: 6, sign: 0.9 }]
  let scrolled = -99
  let now = 0
  let castAt = -99
  let spells = 0
  // What the show is putting on in front of the lens: eight slots of four numbers (see Lens.acts).
  const lens = new Float32Array(36) // and [32] to [35], the planet's view (eggs)
  // The picture as browser windows, and the ordinary page that breaks in (lens slots 0 and 1).
  // The lens times both from when they start (paneAt and brokenIn), so these two lengths go with the shader.
  const windowsDuration = 6.9
  const breakDuration = 5.6
  let windowsAt = -Infinity
  let breakAt = -Infinity
  const lensRandom = stream(seed ^ 0x57494e44) // their own run of chances, so that nothing else in the show falls differently
  let nextWindows = 58 + 12 * lensRandom() // WINDOWS: first at 58 to 70 s
  let nextBreak = 95 + 15 * lensRandom() // BREAK-IN: first at 95 to 110 s
  let breakSeed = 0
  // What each is heard as, and when: seconds in, the event, where across the screen.
  const windowsCues = [[0.02, 'taken', 0], [0.95, 'jump', -0.3], [1.45, 'taken', 0], [1.95, 'jump', 0.3], [3.7, 'zoom', 0], [4.2, 'taken', 0], [6.3, 'taken', 0]]
  const breakCues = [[0.02, 'steam', -0.5], [0.12, 'comedown', -0.5], [2.7, 'steam', -0.5], [3.4, 'gulp', -0.5]]
  let windowsCue = 0
  let breakCue = 0
  // The grey page fights back: now and then NormalScript puts a notice up over
  // the picture. Times are in seconds, lengths in design units.
  const NOTICE = {
    first: 40, // when it first comes up by itself
    again: [90, 130], // and how long after that it is until the next one
    notBefore: 30, // never by itself before this
    rise: 0.7, // how long it takes to slide up
    seep: 3.3, // how long the greyness spreads before the sun turns on it
    fire: 1.6, // how long the lasers are held on it
    burn: 3.7, // from the lasers landing on the middle of it until nothing is left of it
    reach: 250, // how far from the card the greyness gets
    flood: 1.15, // accepted, how long the greyness takes to have the whole picture
    back: 1.6, // and how long colour then takes to come back out of the sun
    // The card on a wide screen and a narrow one: its size, how far it sits off
    // the bottom edge, and where on it its dark button is (x, y, width, height).
    wide: { w: 640, h: 168, gap: 24, button: [444, 43, 172, 36] },
    narrow: { w: 560, h: 296, gap: 20, button: [28, 212, 246, 56] },
  }
  const noticeRandom = stream(seed ^ 0x4e4f5449)
  let glare = 0 // how hard the sun is looking at it
  let notice = null // the one that is up: when it came, and when it was burnt or accepted
  let nextNotice = NOTICE.first
  // What a press of the pointer has done: a ring through the picture, and a prod in the wet paint of the sky.
  let pokes = 0
  let ring = { x: 0, y: 0, at: -99 }
  const prod = [0, 0, 0]
  let shielded = false // the lasers are on the notice, and do nothing to the land behind it
  const maskDuration = 5.4
  const BOSS = { lasts:10.6, slip:0.62, first:35, again:[70,110] }
  const bossRandom=stream(seed ^ 0x444158)
  let bossAt=-99, bossSpan=0, nextBoss=BOSS.first, nextTease=12.2
  let bossSeed=0, bossCue=0, bossImpact=0, bossSequence=-1, bossLaunch=[], bossGaze=0
  const hosting=t=>t>=bossAt && t<bossAt+bossSpan
  let maskAt = -Infinity
  let nextMask = 62
  const foldDuration = 5.2
  let foldAt = -Infinity
  let nextFold = 46 // the first takeover has the daylight slot before sunset
  // The cosmos and the chorus (see COSMOS). The stars' part is written when it
  // begins, from its own run of chances, and each star flares as its note comes.
  const cosmosRandom = stream(seed ^ 0x434f534d)
  let cosmosAt = -Infinity, nextCosmos = COSMOS.first, cosmosDue = COSMOS.first, chorusAt = -Infinity, chorused = true
  let score = [], scoreCue = 0, lastStar = -1
  const starSang = new Float32Array(14).fill(-99), starFrom = new Int32Array(14), starLoud = new Float32Array(14)
  const starInk = new Float32Array(56) // see stars in the shader's uniforms
  let space = 0, singing = 0, chorusMouth = 0, chorusBeats = 0, chorusSwell = 0
  const playersAt = () => {
    const [width, height] = size, sky = height - world.horizon
    return PLAYERS[width >= 760 ? 'wide' : 'narrow'].map(([x, y]) => [x * width, y * sky])
  }
  // One spectacle at a time, with a breath between them. (What a visitor asks for is not made to wait.)
  let stageUntil = 0
  const offstage = (time) => time >= stageUntil && diveAt === null && !diveFrom
  const stage = (time, seconds) => (stageUntil = time + seconds + 1.5)
  const unfoldDuration = 5.8
  let unfoldAt = -Infinity
  let nextUnfold = 16.6
  // The dive into the terminal's screen: where the eye rests (0 out in the
  // picture, 1 inside the terminal), when it set off for the other, and when
  // it comes back out by itself.
  const diveDuration = 2.7
  const diveStay = 20
  let diveFrom = 0
  let diveAt = null
  let diveBack = Infinity
  let size = [1440, 900]
  let machine = null
  let nextLeap = 5
  let jumpAt = -99
  let slammed = true
  let shake = 0
  let whale = null // out of the river: where it left the water, when, and which way it goes
  const WHALE = false // it was not a good whale
  const scorches = Array.from({ length: 16 }, () => [0, 0, -99, 0])
  let burnt = 0
  let steamAt = 0
  let planet = null
  let lift = null // the walker the planet is taking up, and since when
  // The visitor's pointer: where it is, since when it has been still, and
  // what has become of it (0 as it was, 1 taken by the planet, 2 given back as something else).
  const hand = { at: null, still: 0, state: 0, until: 0, form: 0 }
  const drawn = [] // the walkers the sun's roar is drawing up out of the valley
  let nextDrawn = 0
  let nextLift = 31.5
  const stomps = Array.from({ length: 12 }, () => [0, 0, -99, 0])
  let trodden = 0
  let lastBeat = null
  let ahead = 0 // seconds of flying gained (or lost) on the clock by going faster or slower
  const feed = (line) => {
    script.at(-1).typed = script.at(-1).length
    script.at(-1).mine = false
    script.push(line)
    if (script.length > 5) script.shift()
    if (script.length === 5) scrolled = now
  }
  // Room for one more mote. Nothing that can still be seen is taken away to
  // make it: a spark that has all but gone out gives up its place, and if there
  // is none, a new spark simply is not thrown. Signs, words and whoever is
  // being carried off always find room, at the cost of the faintest spark.
  const slight = (m) => m.kind < 3 || m.kind === 6 || m.kind === 8 || m.kind === 10
  const add = (mote) => {
    if (motes.length < 24) return motes.push(mote) > 0
    let faint = -1
    for (let i = 0; i < motes.length; i++) if (slight(motes[i]) && (faint < 0 || motes[i].life < motes[faint].life)) faint = i
    if (faint < 0 || (slight(mote) && motes[faint].life > 0.2)) return false
    motes.splice(faint, 1)
    motes.push(mote)
    return true
  }

  const say = (kind, x, y) => {
    const sign = (SIGNS.indexOf(kind) + 1) / 20
    if (kind === 'razed' || kind === 'fried') ashAt = now
    if (SPOKEN_ON[kind]) speak(now, kind, SPOKEN_ON[kind])
    else if (kind === 'flower' && now - ashAt < 25) speak(now, 'flower') // flowers out of the ash
    events.push({ kind, x: x === undefined || !view ? 0 : Math.max(-1, Math.min(1, (x - view.cx) / 700)) })
    feed({ seed: random() * 90, length: 3 + Math.floor(random() * 5), typed: 0, sign })
    if (x !== undefined) {
      add({ x, y, vx: 0, vy: -26, life: 1, fade: 0.5, kind: 3, seed: sign + 0.049 * random() })
      // Word of it flies to the terminal, which writes the line when it lands.
      if (machine) {
        const size = machine[2] ?? 160
        add({ x, y, vx: 0, vy: 0, fx: x, fy: y, tx: machine[0] - 0.1 * size, ty: machine[1] - 0.3 * size, life: 1, fade: 1 / (0.55 * 0.6), kind: 5, seed: sign, wait: 0.35 })
        script.at(-1).hold = 0.95
      }
    }
  }

  // What the sun says (SAYINGS in voice.worklet.js). Never more than a line in
  // nine seconds; a line on something that has just happened only now and then
  // (odds below); never over its own maw or roar, and cut short if one begins.
  // Catchphrases ('catch') by themselves, when nothing else is on.
  const voiceRandom = stream(seed ^ 0x564f4345)
  let saying = null // the line being said: which, when it began, how long it is, when it was cut short
  let lineAt = -99
  let nextSaying = 18 + 6 * voiceRandom()
  const catchLines = SAYINGS.map(([when], i) => (when === 'catch' ? i : -1)).filter((i) => i >= 0)
  for (let i = catchLines.length - 1; i > 0; i--) {
    const j = Math.floor(voiceRandom() * (i + 1))
    ;[catchLines[i], catchLines[j]] = [catchLines[j], catchLines[i]]
  }
  let catchCount = 0
  let wasLasing = false
  let hostedBefore = false
  let foldSpoken = -Infinity
  let roarWarned = -1
  let swallowedAt = -99
  let thankedFor = -99
  let ashAt = -99
  const mouthNow = [0, 0, 0, 0, 0, 0]
  const lastSaid = {}
  const mouthBusy = (time) => maw > 0.02 || time < roarUntil || (time >= cosmosAt && time < cosmosAt + COSMOS.lasts) || (time >= chorusAt && time < chorusAt + CHORUS.lasts)
  const utterance = (time, line) => {
    if (!SAYINGS[line]) return false
    saying = { line, at: time, length: lineLength(line), cut: Infinity }
    lineAt = time
    events.push({ kind: 'say', line, x: 0 })
    feed({ seed: voiceRandom() * 90, length: 3 + Math.floor(voiceRandom() * 4), typed: 0, sign: 0.93 })
    return true
  }
  const speak = (time, when, odds = 1 / 3) => {
    // (The few it always says, odds 1, are not kept back by the nine seconds.)
    if (saying || (odds < 1 && time - lineAt < 9) || mouthBusy(time) || hosting(time)) return false
    if (voiceRandom() >= odds) return false
    const pool = SAYINGS.map(([w], i) => (w === when ? i : -1)).filter((i) => i >= 0)
    if (!pool.length) return false
    // Not the same line twice running, where there is a choice.
    const before = pool.indexOf(lastSaid[when])
    const pick = before < 0 ? Math.floor(voiceRandom() * pool.length) : (before + 1 + Math.floor(voiceRandom() * (pool.length - 1))) % pool.length
    lastSaid[when] = pool[pick]
    return utterance(time, pool[pick])
  }
  // What it says about what has just happened (said through say() below).
  const SPOKEN_ON = { razed: 1 / 3, rain: 1 / 2, sunset: 1, sunrise: 1 }

  // The look on the sun's face. Each part follows what it wants on a spring
  // with no bounce, so every change of expression starts and ends gently.
  const mien = { brow: 0, lids: 0, smile: 0.3, gasp: 0, roll: 0, glow: 0, dilate: 0 }
  // The sun's two rings of flames turn about its head when it is beside itself: how far round each is, and how fast they are going.
  const whirl = [0, 0]
  let whirling = 0
  const mienSpeed = { brow: 0, lids: 0, smile: 0, gasp: 0, roll: 0, glow: 0, dilate: 0 }
  let hue = 0
  let wink = 0
  const watch = [0.12, 0.04, 0.267, 0] // gaze on unit globe (y up), pupil radius, appetite
  const watchRate = [0, 0, 0, 0]
  // Exact critically damped step. Pointer enter/leave, a new quarry or a
  // second flash retarget the same eye without resetting its velocity.
  function watchToward(i, want, rate, dt) {
    const off = watch[i] - want, v = watchRate[i] + rate * off, e = Math.exp(-rate * dt)
    watch[i] = want + (off + v * dt) * e
    watchRate[i] = (watchRate[i] - rate * v * dt) * e
  }
  let winkAt = -99
  let gulpAt = -99 // when the planet last swallowed someone
  let trance = { from: 66, until: 72.5 }
  let gladAt = -99
  let startledAt = -99

  // Sparks, confetti and petals: thrown from a point of the hero, they fly, fall and fade.
  const motes = []
  const burst = (x, y, count, kind, force = 150) => {
    for (let i = 0; i < count; i++) {
      const around = random() * 6.283
      const speed = force * (0.35 + 0.65 * random())
      add({ x, y, vx: Math.cos(around) * speed, vy: Math.sin(around) * speed - force * 0.7, life: 1, fade: 0.7 + 0.6 * random(), kind, seed: random() * 0.98 })
    }
  }

  // What comes back out of a mouth that has swallowed somebody: a little blood and a few bones.
  const remains = (x, y, bones = 3) => {
    for (let i = 0; i < 10; i++) {
      const around = -Math.PI * (0.12 + 0.76 * random())
      const speed = 80 + 150 * random()
      add({ x: x + 14 * (random() - 0.5), y, vx: Math.cos(around) * speed, vy: Math.sin(around) * speed * 0.8, pull: 620, life: 1, fade: 1.5 + 0.9 * random(), kind: 10, seed: random() * 0.98 })
    }
    for (let i = 0; i < bones; i++) {
      const way = (i - (bones - 1) / 2) / Math.max(1, bones - 1) + 0.3 * (random() - 0.5)
      add({ x, y, vx: 190 * way, vy: -150 - 90 * random(), pull: 560, life: 1, fade: 0.95 + 0.3 * random(), kind: 11, seed: 0.05 + random() * 0.9, wait: 0.08 + 0.09 * i })
    }
  }
  const fire = (x, y, time, seconds) => Object.assign(beam, { x, y, until: time + seconds, burning: null })
  const onHero = (x, y, z) => world.project(view, x, y, z)

  // Fixed world landmarks; the head is the only part that navigates. Store its
  // actual trail, indexed by distance travelled, not by elapsed time. When it
  // stops, the painted scales stop too (even as the camera continues past).
  const snakeInk = new Float32Array(104), viperPose = new Float32Array(3)
  const viperRig = new Float32Array(220) // world spheres, ground footprints, skull axes, stamp, four cull boxes
  let crossing = null, snakeWay = 1, nextSnake = -1
  function serpent(time, dt, pointer) {
    if (!crossing) {
      if (time < nextSnake) return null
      const at = nextSnake < 0 ? Math.min(time, 0) - 0.8 : time
      const oz = view.z - (time - at) * world.speed
      const phone = size[0] < 760
      const far = snakeRandom()*2, phase = snakeRandom()*6.28
      const knots = [ // time, position across the valley, distance in front of the travelling eye
        [-8,-1.4,32], [0,-0.19,29], [1.65,0.09,25], [2.85,0.23,31],
        [3.95,0.205,24.8], [5.1,phone ? 0.27 : 0.36,20.6], [6.35,phone ? 0.27 : 0.36,18.6],
        [7.65,0.55,20], [8.75,0.68,28], [10.15,0.735,21], [11.7,1.12,24], [15.4,1.92,28],
      ].map(([t, across, dep]) => {
        const z = dep + far + (phone ? -0.9 : 0)
        const cx = world.river(oz + t*world.speed + 10)*0.7
        return [t, cx + ((snakeWay > 0 ? across : 1-across)*size[0]-view.cx)*z/view.focal, oz + t*world.speed + z]
      })
      // One planted pair of knots. Give them zero velocity on both sides of the hold.
      knots[6][1] = knots[5][1]; knots[6][2] = knots[5][2]
      const tangent = (i,j) => i===5 || i===6 ? 0 : (knots[Math.min(i+1,11)][j] - knots[Math.max(i-1,0)][j]) / (knots[Math.min(i+1,11)][0] - knots[Math.max(i-1,0)][0])
      const walk = (t) => {
        const last = knots[11]
        if (t >= last[0]) return [last[1] + (t-last[0])*tangent(11,1), last[2] + (t-last[0])*tangent(11,2)]
        if (t < -8) return [knots[0][1]+(t+8)*tangent(0,1),knots[0][2]+(t+8)*tangent(0,2)]
        let i=0
        while (t > knots[i+1][0]) i++
        const a=knots[i], b=knots[i+1], span=b[0]-a[0], h=(t-a[0])/span, k=1-h
        const axis = j => k*k*(1+2*h)*a[j]+h*h*(3-2*h)*b[j]+span*h*k*(k*tangent(i,j)-h*tangent(i+1,j))
        return [axis(1),axis(2)]
      }
      const [x,z] = walk(-16)
      crossing = { at, walk, phase, tick:-16*40, trail:[[x,z,0]], yaw:0 }
      viperPose.fill(0)
    }
    const c = crossing, age = time-c.at, trail = c.trail
    // Catch up the leader at a fixed cadence, including when the page skips a frame.
    for (let n = c.tick+1, stop=Math.min(Math.floor(age*40),40*34); n<=stop; n++) {
      const [x,z]=c.walk(n/40), last=trail[trail.length-1], step=Math.hypot(x-last[0],z-last[1])
      if (step>0.04) trail.push([x,z,last[2]+step])
      c.tick=n
    }
    const nose=c.walk(age), last=trail[trail.length-1], distance=last[2]+Math.hypot(nose[0]-last[0],nose[1]-last[1])
    let j=trail.length-1, x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity
    const beat=age-5.08, lifted=smooth(-0.92,-0.08,beat)*(1-smooth(1.12,2.0,beat))
    const duck = 1 - 0.6*clamp01(maw)
    viperPose[0]=smooth(-0.16,0.25,beat)*(1-smooth(1.05,1.72,beat))*duck
    for (let i=0;i<24;i++) {
      const u=i/23, mark=distance-i*0.83
      while (j>0 && trail[j][2]>mark) j--
      const a=trail[j], b=trail[j+1] ?? nose
      const h=clamp01((mark-a[2])/Math.max(0.00001,(b[2] ?? distance)-a[2]))
      const x=a[0]+(b[0]-a[0])*h, z=a[1]+(b[1]-a[1])*h
      const land=world.ground(x,z), r=(0.055+0.395*(1-u**2.8))*(0.74+0.26*smooth(0,0.28,u))
      const water=smooth(-0.13,0.19,view.level-land)
      const y=Math.max(land,view.level)+r*(0.96-1.02*water)+(0.36+2.3*lifted)*duck*(1-smooth(0,0.32,u))
      const height=y-Math.max(land,view.level)
      const [sx,sy,k]=onHero(x,y,z), rad=r*k, at=i*4
      viperRig.set([x,y,z,r],at)
      const gx=x+0.35*height, gz=z+0.22*height
      const [shx,shy]=onHero(gx,Math.max(world.ground(gx,gz),view.level),gz)
      viperRig.set([shx,shy,gz-view.z, (1-0.75*smooth(0.38,2.9,height))*(1-0.66*water)],96+at)
      snakeInk.set([sx,sy,rad,z-view.z],at)
      const pad = rad*(i===0 ? 11.8 : 1.85)+5
      x0=Math.min(x0,sx-pad,shx-rad*2-4); x1=Math.max(x1,sx+pad,shx+rad*2+4)
      y0=Math.min(y0,sy-pad,shy-rad-4); y1=Math.max(y1,sy+pad,shy+rad+4)
    }
    for (let g=0;g<4;g++) {
      let xlo=Infinity,ylo=Infinity,xhi=-Infinity,yhi=-Infinity
      for(let i=g*6;i<=Math.min(23,g*6+6);i++) {
        const j=4*i, r=snakeInk[j+2]*1.86+4, sx=snakeInk[j], sy=snakeInk[j+1]
        const gx=viperRig[96+j], gy=viperRig[97+j]
        xlo=Math.min(xlo,sx-r,gx-r); xhi=Math.max(xhi,sx+r,gx+r)
        ylo=Math.min(ylo,sy-r,gy-r); yhi=Math.max(yhi,sy+r,gy+r)
      }
      viperRig.set([xlo,ylo,xhi,yhi],204+4*g)
    }
    if (age>8 && (snakeWay>0 ? x0>size[0] : x1<0) || viperRig[2]<view.z-3 && viperRig[94]<view.z-3 && y0>size[1]) {
      crossing=null; snakeWay*=-1; nextSnake=time+2.5+snakeRandom()*1.8; return null
    }
    // Nose leads into a turn, then swivels three-quarters toward the visitor.
    const aim=c.walk(age+0.24), past=c.walk(age-0.20)
    let yaw=Math.atan2(aim[1]-past[1],Math.max(0.8,snakeWay*(aim[0]-past[0])))
    yaw=yaw*(1-0.89*lifted)-0.54*lifted
    c.yaw += (yaw-c.yaw)*(-Math.expm1(-6*Math.max(dt,0)))
    const pitch=0.035+0.12*lifted, vx=snakeWay*Math.cos(c.yaw), vz=Math.sin(c.yaw)
    viperRig.set([vx*Math.cos(pitch),Math.sin(pitch),vz*Math.cos(pitch),viperRig[3]*2.30, -vz*snakeWay,0,vx*snakeWay,0],192)
    const tx=pointer ? snakeWay*(pointer[0]-snakeInk[0]) : 50*(1-lifted), ty=pointer ? pointer[1]-snakeInk[1] : -20
    const g=Math.hypot(tx,ty,45), follow=-Math.expm1(-12*Math.max(dt,0))
    viperPose[1]+=(tx/g-viperPose[1])*follow; viperPose[2]+=(ty/g-viperPose[2])*follow
    snakeInk.set([x0,y0,x1,y1,snakeWay,0,Math.max(viperPose[0]*0.9,smooth(-0.55,0.9,Math.sin(age*3.8+c.phase))),c.phase],96)
    return snakeInk
  }

  // The audit. What the picture is told of it, four numbers at a time: [0]
  // whether it is on, whether anyone is in the air, and how glad the valley is to be rid of them; [1] and [2] the grey
  // lanes; [3] to [7] each man's lane; [8] the dropped roller; and from [10]
  // four for each officer (see audited() and officer() in the shader).
  const officerInk = new Float32Array(128)
  let nextAudit = AUDIT.first
  let audit = null
  const beginAudit = (time) => {
    if (audit || !view) return false
    const wide = size[0] >= 760
    audit = {
      at: time,
      side: wide ? -1 : 1, // the bank they take: the one the terminal is not standing on
      first: wide ? 3.3 : 2.8, // how far the first of them is from the river
      pitch: wide ? AUDIT.gap : AUDIT.gap * 0.74,
      land: 0, // how far up the valley they come down
      // Which of them, counting from the river, meets which end.
      men: ['flung', 'balloon', 'turned', 'flower', 'eaten'].map((fate, i) => ({ i, fate, mode: 'fall', since: time, stops: 0, dealt: 0 })),
      roller: null,
      hue: Math.floor(auditRandom() * 6),
    }
    nextAudit = time + AUDIT.every[0] + (AUDIT.every[1] - AUDIT.every[0]) * auditRandom()
    startledAt = time
    return true
  }
  const inspect = (time, dt, sun, sinking) => {
    const A = audit
    const t = time - A.at
    const tall = AUDIT.tall
    const [width, height] = size
    const landed = t >= AUDIT.land
    // They come down where the eye will have them at the right distance, and keep that distance as they march.
    if (!A.down) A.land = view.z + world.speed * Math.max(0, AUDIT.land - t) + AUDIT.far
    const rank = landed ? view.z + AUDIT.far : A.land // how far up the valley the row has got
    A.rank = rank
    const step = Math.sin((Math.PI * (rank - A.land)) / AUDIT.pace)
    const lane = (i, z) => world.river(z) + A.side * (A.first + A.pitch * i)
    const floor = (x, z) => world.ground(x, z)
    const stand = (x, z, lift = 0) => {
      const [sx, sy, k] = onHero(x, floor(x, z) + lift, z)
      return [sx, sy, k * tall, Math.max(z - view.z, 0.01)]
    }
    // Where the valley is in flood they wade: the height on the hero of the water round a man, or 0 if he is on dry land.
    const wading = (x, z) => (view.level > floor(x, z) + 0.04 ? onHero(x, view.level, z)[1] : 0)
    const heardAt = (sx) => Math.max(-1, Math.min(1, (sx - view.cx) / 700))
    const bump = (k) => (k > 0 && k < 1 ? Math.sin(Math.PI * k) : 0)
    const fling = (m) => Object.assign(m, { mode: 'flung', since: time, from: [m.x, m.z], to: [world.river(m.z), m.z], takes: 0.95 + 0.035 * Math.abs(world.river(m.z) - m.x), stops: m.z, dealt: time })

    // They land together.
    if (landed && !A.down) {
      A.down = true
      shake = Math.max(shake, 0.3)
      events.push({ kind: 'step', x: 0.3 * A.side })
    }
    // The terminal jumps, and comes down hard.
    if (!A.jumped && t >= AUDIT.jump) {
      A.jumped = true
      if (time - jumpAt >= 1.5) {
        jumpAt = time
        slammed = false
        events.push({ kind: 'jump', x: 0.5 })
      }
      A.slamAt = jumpAt + 0.9
    }
    // The sun opens its mouth for one of them; if it is not there the planet has him.
    if (!A.roared && t >= AUDIT.roar) {
      A.roared = true
      A.maw = sun && sinking === 0 ? 'sun' : planet && !lift ? 'planet' : 'river'
      if (A.maw === 'sun') {
        roarUntil = time + 2.3
        say('roar')
      } else if (A.maw === 'planet') events.push({ kind: 'lift', x: -0.5 })
      A.eatAt = time + (A.maw === 'sun' ? 0.6 : 0.35)
    }
    const mouth = () => (A.maw === 'sun' ? [sun[0], sun[1] + 0.2 * sun[2] + 520 * sinking] : [planet[0], planet[1] + 0.3 * planet[2]])
    A.beam = null
    // The sun keeps its mouth shut and its beam to itself while they are
    // about, and the picture's other turns wait until they have been seen to.
    if (!A.tame) {
      nextShot = Math.max(nextShot, time + 2.5)
      nextRoar = Math.max(nextRoar, time + 8)
      nextFold = Math.max(nextFold, time + 4)
      nextUnfold = Math.max(nextUnfold, time + 4)
      nextMask = Math.max(nextMask, time + 4)
      nextNotice = Math.max(nextNotice, time + 4)
    }

    // Whatever is built in their way comes down.
    for (const site of sites) {
      const off = (site.x - world.river(site.z)) * A.side
      if (!landed || site.built <= 0 || site.falling || site.z - rank < (t < AUDIT.land + 0.3 ? -10 : -1) || site.z - rank > 3.6) continue
      if (!A.men.some((m) => m.mode === 'march' && Math.abs(off - A.first - A.pitch * m.i) < 2.7)) continue
      const [x, y] = onHero(site.x, world.ground(site.x, site.z) + 1, site.z)
      if (site.told) say('razed', x, y - 30)
      burst(x, y, 7, 1, 150)
      Object.assign(site, { falling: true, wire: 0, told: false })
    }

    officerInk.fill(0)
    let left = 0
    let flying = 0
    for (const m of A.men) {
      const since = () => time - m.since
      if (m.mode === 'fall' && landed) m.mode = 'march'
      if (m.mode === 'march') {
        Object.assign(m, { x: lane(m.i, rank), z: rank, stops: rank })
        if (m.fate === 'flower' && t >= AUDIT.flower) {
          Object.assign(m, { mode: 'flower', since: time, step, seed: auditRandom(), dealt: time + 0.45 })
          const [sx, sy] = stand(m.x, m.z)
          say('flower', sx, sy - 40)
        } else if (m.fate === 'balloon' && t >= AUDIT.balloon) {
          Object.assign(m, { mode: 'balloon', since: time })
          events.push({ kind: 'taken', x: heardAt(stand(m.x, m.z)[0]) })
        } else if (m.fate === 'flung' && A.slamAt && time >= A.slamAt + 0.08) fling(m)
        else if (m.fate === 'eaten' && A.eatAt && time >= A.eatAt) {
          if (A.maw === 'river') {
            fling(m)
            A.turnAt = time + 1.6
          } else Object.assign(m, { mode: 'eaten', since: time, from: stand(m.x, m.z), dealt: time })
        } else if (m.fate === 'turned' && A.turnAt && time >= A.turnAt) Object.assign(m, { mode: 'turned', since: time })
      }
      let P = null
      let Q = [m.x, m.z, 0, 0]
      let R = [m.fate === 'turned' ? 1 : 0, 0, 0, 0]
      let S = [1, 0, 0, 0]
      if (m.mode === 'fall') {
        // Down out of the sky, upright, all at one speed, to where they will stand.
        const at = stand(lane(m.i, A.land), A.land)
        P = [at[0], at[1] - (1 - t / AUDIT.land) * (at[1] + 8), at[2], -(clamp01(t / AUDIT.land) ** 3)]
        Q = [lane(m.i, A.land), A.land, 0, 0]
      } else if (m.mode === 'march') {
        // In step; and when the terminal lands they all leave the ground at once, hats last.
        P = stand(m.x, m.z, A.slamAt ? 1.2 * bump((time - A.slamAt) / 0.5) : 0)
        Q[2] = step
        R[2] = wading(m.x, m.z)
        S[2] = 0.13 * bump((t - AUDIT.land) / 0.36) + (A.slamAt ? 0.2 * bump((time - A.slamAt - 0.1) / 0.62) : 0)
        // The one the sun wants feels it first in his hat.
        if (m.fate === 'eaten' && A.roared && A.maw !== 'river') S[2] += 0.07 * smooth(-0.6, -0.1, time - A.eatAt) * (1 + 0.5 * Math.sin(time * 40))
      } else if (m.mode === 'flower') {
        P = stand(m.x, m.z)
        Q[2] = m.step
        R = [2, m.since, m.seed, 0.29 * P[2]]
        S[1] = smooth(0, 0.3, since())
        if (P[1] - 1.2 * P[2] > height || P[3] < 3 || P[0] + P[2] < 0 || P[0] - P[2] > width) m.mode = 'gone'
      } else if (m.mode === 'balloon') {
        // His briefcase fills, and takes him up still marching.
        const up = since() - 0.8
        if (up < 0) {
          Object.assign(m, { x: lane(m.i, rank), z: rank, stops: rank })
          m.at = stand(m.x, m.z)
        } else {
          if (!m.dealt) m.dealt = time
          m.at[0] += A.side * -(14 + 14 * Math.sin(up * 1.3)) * dt
          m.at[1] -= Math.min(175, 30 + 130 * up) * dt
          m.at[3] = -clamp01(1 - up / 0.7)
          Q = [m.x, m.z, 0, 0.07 * Math.sin(up * 1.7)]
        }
        P = m.at
        Q[2] = step
        R = [3, clamp01(since() / 0.95), 0, A.hue]
        if (P[1] < -0.1 * P[2]) m.mode = 'gone'
      } else if (m.mode === 'flung') {
        // Thrown by the ground, over and over, into the river.
        const k = since() / m.takes
        const x = m.from[0] + (m.to[0] - m.from[0]) * Math.min(k, 1)
        const z = m.from[1] + (m.to[1] - m.from[1]) * Math.min(k, 1)
        const base = Math.max(view.level, floor(m.from[0], m.from[1])) + (view.level - Math.max(view.level, floor(m.from[0], m.from[1]))) * Math.min(k, 1)
        const [sx, sy, unit] = onHero(x, base + 4 * 4.6 * k * (1 - k), z)
        P = [sx, sy, unit * tall, Math.max(z - view.z, 0.01)]
        Q = [x, z, Math.sin(since() * 15), -A.side * 4.2 * Math.PI * Math.min(k, 1) ** 0.9]
        S[1] = smooth(0, 0.12, since())
        if (k >= 1) R[2] = onHero(m.to[0], view.level, m.to[1])[1]
        if (k >= 1 && !m.wet) {
          m.wet = true
          stomps[trodden++ % 12] = [m.to[0], m.to[1], time, -1.1]
          const [wx, wy] = onHero(m.to[0], view.level, m.to[1])
          for (let i = 0; i < 7; i++) {
            add({ x: wx + (i - 3) * 9, y: wy - 5, vx: (i - 3) * 60, vy: -250 - 150 * auditRandom(), pull: 900, life: 1, fade: 1 / (0.55 * 0.9), kind: 6, seed: 0.3 + 0.7 * auditRandom() })
          }
          events.push({ kind: 'splash', x: heardAt(wx) })
          shake = Math.max(shake, 0.25)
        }
        if (k >= 1.32) Object.assign(m, { mode: 'hat', since: time, x: m.to[0], z: m.to[1], phase: auditRandom() * 6 })
      } else if (m.mode === 'eaten') {
        // Up into the sun's mouth, or the planet's.
        const k = clamp01(since() / 0.8)
        const e = k * k * k
        if (k > 0.12 && !m.cried) {
          m.cried = true
          events.push({ kind: 'scream', x: 0 })
        }
        const to = mouth()
        const unit = m.from[2] * (1 - 0.86 * e)
        P = [m.from[0] + (to[0] - m.from[0]) * e, m.from[1] + (to[1] + 0.5 * unit - m.from[1]) * e - 0.5 * m.from[2] * Math.sin(Math.PI * k) * (1 - k), unit, -clamp01(1 - since() / 0.3)]
        Q = [m.x, m.z, Math.sin(since() * 17), 7.5 * e]
        S[1] = smooth(0, 0.15, since())
        if (A.maw === 'planet') A.beam = [P[0], P[1] - 0.2 * P[2], 1 - e * e, since() + 0.35]
        if (k >= 1) {
          m.mode = 'gone'
          A.turnAt = time + AUDIT.turn
          shake = Math.max(shake, A.maw === 'sun' ? 0.6 : 0.3)
          burst(to[0], to[1], A.maw === 'sun' ? 4 : 9, 1, 190)
          if (A.maw === 'sun') {
            remains(to[0], to[1] + 0.12 * sun[2], 4)
            roarUntil = Math.min(roarUntil, time + 0.15) // it shuts its mouth on him
            gladAt = time
            say('taken', to[0], to[1] - 40)
            events.push({ kind: 'gulp', x: 0 })
          } else {
            winkAt = time + 0.25
            gulpAt = time
            say('taken', planet[0] + 1.6 * planet[2], planet[1] + planet[2])
          }
        }
      } else if (m.mode === 'hat') {
        // His hat comes up, and goes down the river.
        m.z -= 0.45 * dt
        m.x = world.river(m.z)
        const [sx, sy, unit] = onHero(m.x, view.level, m.z)
        P = [sx, sy, unit * tall, Math.max(m.z - view.z, 0.01)]
        Q = [1e6, 1e6, 0, 0]
        R = [4, m.phase, smooth(0.05, 0.6, since()), 0]
        if (sy - 0.3 * P[2] > height + 4 || P[3] < 3) m.mode = 'gone'
      } else if (m.mode === 'turned') {
        // The last of them stops, and there is no one. He lets the roller go
        // and turns round; the colour gets into him from the shoes up; and he
        // dances off.
        const k = since()
        S[2] = 0.14 * bump((k - 0.08) / 0.42)
        if (k >= 0.6 && !A.roller) A.roller = { x: m.x, z: m.z, at: time }
        R[1] = A.roller ? 1 : 0
        S[0] = Math.cos(Math.PI * clamp01((k - 0.6) / 0.42))
        if (k >= 1.25 && !m.dealt) {
          m.dealt = time
          A.tame = true
        }
        S[3] = smooth(0, 0.9, k - 1.25)
        if (k >= 1.9 && !m.sang) {
          m.sang = true
          gladAt = time
          const [sx, sy, unit] = stand(m.x, m.z)
          burst(sx, sy - 0.6 * unit, 10, 1, 170)
          events.push({ kind: 'cast', x: heardAt(sx) })
        }
        const dance = Math.max(0, k - 2.15)
        const beat = dance * 3.3
        const go = smooth(0.3, 1.3, dance)
        m.x += A.side * 3.6 * go * dt
        m.z += -1.1 * go * dt
        S[1] = smooth(0, 0.25, dance)
        S[2] += 0.1 * Math.abs(Math.sin(Math.PI * beat + 0.5)) * S[1]
        Q = [m.x, m.z, Math.sin(Math.PI * beat) * S[1], 0.2 * Math.sin(Math.PI * beat) * S[1]]
        P = stand(m.x, m.z, 0.5 * Math.abs(Math.sin(Math.PI * beat)) * S[1])
        R[2] = wading(m.x, m.z)
        if (P[0] + 0.7 * P[2] < 0 || P[0] - 0.7 * P[2] > width || P[1] - 1.2 * P[2] > height || P[3] < 3) m.mode = 'gone'
      }
      // His lane: how far it goes, and since when the colour has been coming back down it.
      officerInk.set([m.stops, m.dealt, m.fate === 'turned' ? 1 : 0, 0], 12 + 4 * m.i)
      if (m.mode === 'gone' || !P) continue
      left++
      if (P[3] <= 0) flying = 1
      officerInk.set([...P, ...Q, ...R, ...S], 40 + 16 * m.i)
    }

    // The roller lies where he let it go until the land has carried it by.
    if (A.roller && !A.roller.lost) {
      const [sx, sy, unit] = stand(A.roller.x, A.roller.z)
      const fall = clamp01((time - A.roller.at) / 0.45)
      if (sy - 0.2 * unit > height || A.roller.z - view.z < 3) A.roller.lost = true
      else {
        officerInk.set([sx, sy, unit, fall * fall], 32)
        left++
      }
    }

    const lastMan = A.men.find((m) => m.fate === 'turned')
    const glad = lastMan.dealt ? time - lastMan.dealt : 0
    officerInk.set([1, flying, t, smooth(0, 0.4, glad) * (1 - smooth(0.7, 2.8, glad))], 0)
    officerInk.set([A.land, A.at + AUDIT.land, A.side, A.pitch], 4)
    officerInk.set([A.first, 0.43 * A.pitch, 2 * AUDIT.pace, world.speed], 8)
    // It is over when they have all gone and the last of the grey has been washed out.
    if (!left && lastMan.dealt && time - lastMan.dealt > 3) {
      audit = null
      return null
    }
    return officerInk
  }

  // A new flower on the land at (x, z). The oldest makes way.
  const plant = (x, z, time) => {
    if (blooms.length >= 12) blooms.splice(blooms.indexOf(blooms.reduce((a, b) => (a.born < b.born ? a : b))), 1)
    const planted = { x, z, born: time, burnt: 0, size: 0.75 + 0.45 * random(), seed: random() }
    blooms.push(planted)
    return planted
  }
  // Somewhere on dry land ahead, for things that fall from the sky.
  const somewhere = () => {
    for (let tries = 0; tries < 8; tries++) {
      const z = view.z + 20 + 55 * random()
      const x = world.river(z) + (random() < 0.5 ? -1 : 1) * (2.6 + 11 * random())
      if (world.ground(x, z) > view.level + 0.15) return [x, z]
    }
    return null
  }
  const sprout = (time) => {
    const spot = somewhere()
    return spot && !blooms.some((b) => !b.burnt && Math.hypot(b.x - spot[0], b.z - spot[1]) < 2.2) ? plant(spot[0], spot[1], time) : null
  }

  // Weather: now and then a storm comes over. Rain grows flowers and fills the
  // valley, lightning burns and fries, and a rainbow follows. And now and then
  // the sun weeps, water one time and blood the next.
  let storm = { from: 54, until: 68 }
  let rainbowFrom = -99
  let nextBolt = 57
  let nextSprout = 0
  let wet = 0
  let raining = false
  const bolt = { x: 0, z: 0, seed: 0, at: -99, top: 0 }
  let cry = { from: 20.5, until: 26.5, blood: false }
  let crying = false

  // What is being built, in a ring: the nearest site is the next to be left behind.
  const sites = []
  let siteCount = 0
  let lastSite = 0
  const newSite = (z, built) => {
    const side = (siteCount % 2 ? 1 : -1) * (random() < 0.8 ? 1 : -1)
    let x = 0
    for (let tries = 0; tries < 8; tries++) {
      x = world.river(z) + side * (4 + 6 * random())
      if (world.ground(x, z) > 0.3) break
    }
    lastSite = z
    const seed = random()
    const family = (siteCount + 3 + Math.floor(siteCount/4)) % 4
    return { id: siteCount++, x, z, family, seed, built, wire: 0, told: built >= 1,
      hold: 6 + 9*seed, falling: false, regrowAt: -Infinity, speedSpell: false }
  }


  // Little walking computers. They build the village, come to look at the
  // pointer, and get fried by lasers and lightning.
  const minis = Array.from({ length: 8 }, () => ({ x: 0, z: 0, heading: 0, speed: 0, phase: random(), stride: 0, job: -1, struckAt: 0, dead: 0, dip: 0, seed: random() }))

  const begin = () => {
    for (let i = 0; i < 8; i++) sites.push(newSite(view.z + 27 + i * 8.5 + 3 * random(), i < 3 ? 1 : i === 3 ? 0.5 : 0))
    minis.forEach((m, i) => {
      m.z = view.z + 23 + i * 5.5
      m.x = world.river(m.z) + (i % 2 ? 1 : -1) * (2.6 + 2 * random())
      m.heading = random() * 6.28
    })
  }

  // Sixteen grass fires plus one chimney for each building. A blackened cell
  // keeps its spot until the grass grows back; saturation declines new sparks.
  const brush = [], fireRandom = stream(seed ^ 0x53fa75)
  let damage = 0, damageGoal = 0, contactAt = -99, nextCatch = -99, nextHiss = -99
  const scorchDesk = (time, amount) => {
    if (time-contactAt < 0.52) return
    contactAt=time; damageGoal=clamp01(damageGoal+amount)
  }
  const byDesk = (sx,sy,pad=0) => machine && Math.hypot((sx-machine[0])/(machine[2]*(0.70+pad)),(sy-machine[1]+0.19*machine[2])/(machine[2]*(0.67+pad)))<1
  const kindle = (x,z,time,angle,twig=0,boltHeat=false,parent=null) => {
    if (brush.length>=(twig?13:16) || z<view.z+1 || world.ground(x,z)<view.level+0.12 || (wet>0.65&&!boltHeat)) return false
    if (brush.some(f=>Math.hypot(f.x-x,f.z-z)<1.42)) return false
    const y=world.ground(x,z), seed=fireRandom()
    brush.push({x,y,z,startX:parent?.fx??x,startZ:parent?.fz??z,at:time,angle,twig,seed,span:2.9+2.0*seed,life:0,quench:0,radius:0,
      heat:0,ash:0,smoke:0,steam:0,fx:x,fy:y,fz:z,width:0.01,height:0.01,slope:0,next:0.97+0.36*seed,branches:0})
    return true
  }
  const lightHouse = (site,time) => {
    if (site.falling || site.singe!=null || site.built<0.15) return
    site.singe=time; site.fireDose=0; site.fireWet=0
    kindle(site.x,site.z-1,time,0.15)
    const [x]=onHero(site.x,world.ground(site.x,site.z),site.z)
    events.push({kind:'burn',x:Math.max(-1,Math.min(1,(x-view.cx)/700))})
  }
  const advanceBrush = (time,dt,rain) => {
    const count=brush.length
    for (let i=count-1;i>=0;i--) {
      const f=brush[i], age=time-f.at
      if (age>=23 || f.z<view.z-6) {brush.splice(i,1); continue}
      const soaked=rain>0.28 || f.y<view.level+0.04
      f.quench=clamp01(f.quench+dt*(soaked?0.54+0.9*rain:0))
      f.life=Math.min(f.span,f.life+dt*(1-f.quench))
      const grow=smooth(0,2.1,f.life), size=1.4+0.48*f.seed
      f.radius=size*(0.06+0.94*smooth(0,2.55,f.life))
      f.heat=smooth(0,0.46,age)*(1-smooth(0.44*f.span,f.span,age))*(1-f.quench)
      f.ash=smooth(0,0.72,f.life)*(1-smooth(9,23,age))
      f.smoke=smooth(0.15,1.0,age)*(1-smooth(f.span,f.span+3.1,age))
      const travel=smooth(0,1.25,f.life)
      f.steam=f.quench; f.fx=f.startX+(f.x-f.startX)*travel+0.70*f.radius*Math.sin(f.angle); f.fz=f.startZ+(f.z-f.startZ)*travel+0.70*f.radius*Math.cos(f.angle)
      f.fy=world.ground(f.fx,f.fz)
      f.slope=world.ground(f.fx+0.5,f.fz)-world.ground(f.fx-0.5,f.fz)
      f.width=(0.04+0.99*grow)*(0.95+0.32*f.seed)
      f.height=(1.05+0.64*f.seed)*(0.16+0.84*smooth(0,1.15,age))
      if (soaked && f.heat>0.22 && time>=nextHiss) {
        events.push({kind:'steam',x:Math.max(-1,Math.min(1,(onHero(f.fx,f.fy,f.fz)[0]-view.cx)/700))}); nextHiss=time+2.2
      }
      if(f.heat<0.10) continue
      for (const b of blooms) if (!b.burnt && age>0.65 && time-b.born>0.9 && Math.hypot(b.x-f.x,b.z-f.z)<f.radius+0.36) b.burnt=time
      for (const site of sites) if (Math.hypot(site.x-f.fx,site.z-f.fz)<0.94+f.width) lightHouse(site,time)
      if(soaked || f.twig>=6 || f.branches>=2 || age<f.next) continue
      // A fork of the fire follows the wind; of three directions it prefers the drier uphill run.
      const turn=f.angle+(f.branches===1 ? (f.seed<0.5?-1:1)*1.35 : 0.13*Math.sin(time*0.37))
      f.next=age+1.05; f.branches++
      const choices=[]
      for(const offset of [0,-0.59,0.59]) {
        const a=turn+offset, dx=Math.sin(a), dz=Math.cos(a), gap=1.59+0.22*f.seed
        const x=f.x+gap*dx,z=f.z+gap*dz, h=world.ground(x,z)
        if (h<view.level+0.16 || world.ground((f.x+x)*0.5,(f.z+z)*0.5)<view.level+0.16) continue
        choices.push({x,z,a,weight:h-0.24*Math.abs(offset)})
      }
      for(const c of choices.sort((a,b)=>b.weight-a.weight)) if(kindle(c.x,c.z,time,c.a,f.twig+1,false,f)) break
    }
  }

  // Lightning onto the land under the hero point (x, y), from a height.
  const strike = (x, y, time, top = 0) => {
    const spot = view && world.pick(view, x, y)
    if (!spot) return
    Object.assign(bolt, { x: spot.x, z: spot.z, seed: random() * 90, at: time, top, landed: false })
    const hit = blooms.find((b) => !b.burnt && Math.hypot(b.x - spot.x, b.z - spot.z) < 2.6)
    if (hit) hit.burnt = time + 0.16
    for (const m of minis) if (!m.struckAt && Math.hypot(m.x - spot.x, m.z - spot.z) < 2.4) m.struckAt = time + 0.16
    say('strike', ...onHero(spot.x, spot.y + 1.2, spot.z))
  }

  // Day and night. A changeover takes ten seconds: the sun or moon sinks
  // behind the land, and the other comes up in its place.
  const orb = { moon: false, toNight: true, from: -99, next: 48 }
  const WHEEL = 6.4 // how long the sun and the moon take to change places
  const turnOver = (time) => {
    if (hosting(time) || time - orb.from < 10) return
    Object.assign(orb, { from: time, toNight: !orb.moon, next: time + 10 + (orb.moon ? 46 : 36) })
    say(orb.toNight ? 'sunset' : 'moonset')
  }

  // The eggs. The sun loses its temper: a long roar, and its lasers go along
  // the valley from one side to the other. The planet shows what it sees.
  let sweep = null
  const stareDuration = 6
  let stareAt = -Infinity
  // A ring of flowers on dry land ahead. Says how many came up.
  const flowerRing = (time) => {
    for (let tries = 0; tries < 10; tries++) {
      const z = view.z + 26 + 16 * random()
      const x = world.river(z) + (random() < 0.5 ? -1 : 1) * (4.5 + 6 * random())
      if (world.ground(x, z) < view.level + 0.2) continue
      const turn = random() * 6.283
      let count = 0
      for (let i = 0; i < 6; i++) {
        const a = turn + (i / 6) * 6.283
        const [fx, fz] = [x + 2.5 * Math.cos(a), z + 2.5 * Math.sin(a)]
        if (world.ground(fx, fz) < view.level + 0.15) continue
        plant(fx, fz, time + 0.11 * i)
        count++
      }
      if (count < 3) continue
      const [sx, sy] = onHero(x, world.ground(x, z), z)
      say('flower', sx, sy - 30)
      burst(sx, sy, 6, 2, 110)
      return count
    }
    return 0
  }

  return {
    // A press conjures something out of wherever it lands: a flower, a fish,
    // a thump that runs through the ground, lightning, a prod in the sky.
    poke(x, y, time) {
      if (byDesk(x,y) && view) scorchDesk(time,0.11)
      if (!view || !last) return null
      if (time - ring.at >= 0.7) ring = { x, y, at: time }
      const card = last.notice
      if (card && x > card.x && x < card.x + card.w && y > card.y && y < card.y + card.h) {
        fire(x, y, time, 1.3) // on NormalScript's notice it is the sun that answers
        return 'notice'
      }
      const spot = world.pick(view, x, y)
      const turn = pokes++
      const pan = Math.max(-1, Math.min(1, (x - view.cx) / 700))
      if (!spot) {
        Object.assign(prod, [x, y, 1])
        burst(x, y, 7, 1, 170)
        if (turn % 3 === 2) strike(x, last.view.height - 40 - 120 * random(), time, y)
        else events.push({ kind: 'taken', x: pan })
        return 'sky'
      }
      const k = onHero(spot.x, spot.y, spot.z)[2]
      const quiet = time - stomps[trodden % 12][2] > 5.6 // no print still to be seen is trodden out
      if (spot.wet) {
        const way = random() < 0.5 ? -1 : 1
        add({ x, y, vx: way * k, vy: -5.3 * k, pull: 11.8 * k, life: 1, fade: 1 / (0.55 * 0.9), kind: 4, seed: (Math.min(97, Math.floor(k)) + (way > 0 ? 0.5 : 0)) / 100 })
        for (let i = 0; i < 3; i++) add({ x: x + (i - 1) * 0.4 * k, y: y - 0.15 * k, vx: (i - 1) * 2.5 * k, vy: -(6 + 3 * random()) * k, pull: 20 * k, life: 1, fade: 1 / (0.55 * 0.9), kind: 6, seed: 0.3 + 0.7 * random() })
        if (quiet) stomps[trodden++ % 12] = [spot.x, spot.z, time, -1]
        events.push({ kind: 'leap', x: pan })
        return 'water'
      }
      if (turn % 4 === 3) {
        strike(x, y, time)
        return 'bolt'
      }
      const room = spot.z - view.z > 17 && blooms.length < 12 && !blooms.some((b) => !b.burnt && Math.hypot(b.x - spot.x, b.z - spot.z) < 2.2)
      if (quiet && (turn % 4 === 1 || !room)) {
        stomps[trodden++ % 12] = [spot.x, spot.z, time, 1.2]
        burst(x, y, 6, 1, 150)
        events.push({ kind: 'step', x: pan })
        return 'thump'
      }
      if (room) {
        plant(spot.x, spot.z, time)
        say('flower', x, y - 30)
        burst(x, y, 6, 2, 110)
        return 'flower'
      }
      burst(x, y, 6, 1, 150)
      events.push({ kind: 'taken', x: pan })
      return 'sparks'
    },
    // Hold the lasers on a point, move them, let go. (For whoever is filming: a visitor's press does not aim them.)
    press(x, y) {
      if(hosting(now)) return false
      Object.assign(beam, { x, y, held: true, burning: null })
    },
    move(x, y) {
      if (beam.held) Object.assign(beam, { x, y })
    },
    release(time) {
      if (beam.held) Object.assign(beam, { held: false, until: time + 0.12 })
    },
    roar(time) {
      if(hosting(time)) return false
      roarUntil = time + 3.6
      say('roar')
    },
    // The sun is pleased to see whoever has just come, and the planet winks at them.
    greet(time) {
      gladAt = time
      winkAt = time + 0.45
      events.push({ kind: 'wink', x: 0 })
      speak(time, 'greet', 1)
    },
    // The sun says line n of SAYINGS, or its next catchphrase. Says whether it could.
    say(time, line) {
      if (saying || mouthBusy(time) || hosting(time)) return false
      return utterance(time, line ?? catchLines[catchCount++ % catchLines.length])
    },
    strike,
    // Swap day for night, or night for day, now. The planet winks.
    turnOver(time) {
      if(hosting(time)) return false
      winkAt = time
      turnOver(time)
    },
    // A key is pressed: the terminal writes one more sign on a line of the visitor's own.
    // A pair of the terminal's boots comes down at these points of the hero.
    // The ground remembers; water is thrown up. Says nothing if this beat
    // of its walk has been trodden already.
    // The terminal jumps. It comes down hard.
    jump(time) {
      if (time - jumpAt < 1.5) return
      jumpAt = time
      slammed = false
      events.push({ kind: 'jump', x: 0.5 })
    },
    tread(beat, points, time, weight = 1) {
      if (beat === lastBeat) return null
      const first = lastBeat === null
      lastBeat = beat
      if (first || !view) return null
      let wet = false
      for (const [sx, sy, boot] of points) {
        const spot = world.pick(view, sx, sy)
        if (!spot) continue
        const size = (weight * boot * Math.max(spot.z - view.z, 1)) / view.focal
        // A print is not trodden out while it can still be seen, unless something heavy lands.
        if (weight <= 1 && time - stomps[trodden % 12][2] < 5.6) continue
        stomps[trodden++ % 12] = [spot.x, spot.z, time, spot.wet ? -size : size]
        if (weight > 1) {
          // Coming down from a jump it throws up dust, and knocks over whoever is near.
          for (let i = 0; i < 2; i++) {
            add({ x: sx + 30 * (i - 0.5), y: sy - 4, vx: 110 * (i - 0.5), vy: -50 - 30 * random(), life: 1, fade: 1 / (0.55 * 0.8), kind: 8, seed: random() })
          }
          for (const m of minis) if (!m.struckAt && !m.gone && Math.hypot(m.x - spot.x, m.z - spot.z) < 7) m.struckAt = time + 0.04 * Math.hypot(m.x - spot.x, m.z - spot.z)
          // What stands close by falls down, and the flowers are flattened.
          for (const site of sites) {
            if (site.built <= 0 || Math.hypot(site.x - spot.x, site.z - spot.z) > 5) continue
            const [x, y] = onHero(site.x, world.ground(site.x, site.z) + 1, site.z)
            if (site.told) say('razed', x, y - 30)
            burst(x, y, 7, 1, 150)
            Object.assign(site, { falling: true, wire: 0, told: false })
          }
          for (const b of blooms) if (!b.burnt && Math.hypot(b.x - spot.x, b.z - spot.z) < 4) b.burnt = time
          shake = 1
        }
        if (!spot.wet) continue
        wet = true
        for (let i = 0; i < 5; i++) {
          const way = (i - 2) * 0.5 + 0.3 * (random() - 0.5)
          add({ x: sx + way * 14, y: sy - 4, vx: way * 150, vy: -230 - 150 * random(), pull: 900, life: 1, fade: 1 / (0.55 * 0.75), kind: 6, seed: 0.1 + 0.8 * random() })
        }
      }
      return { wet }
    },
    // A whale comes up out of the river.
    breach(time) {
      if (!WHALE || whale || !view) return false
      const z = view.z + 15 + 5 * random()
      whale = { at: time, x: world.river(z), z, way: random() < 0.5 ? -1 : 1, level: world.eye - view.level > 0 ? view.level : -0.35 }
      stomps[trodden++ % 12] = [whale.x, z, time, -1.5]
      const [x, y] = onHero(whale.x, whale.level, z)
      for (let i = 0; i < 6; i++) {
        add({ x: x + (i - 2.5) * 12, y: y - 6, vx: (i - 2.5) * 70, vy: -260 - 160 * random(), pull: 900, life: 1, fade: 1 / (0.55 * 0.9), kind: 6, seed: 0.3 + 0.7 * random() })
      }
      return true
    },
    // The planet picks a walker and takes it.
    abduct(time) {
      if (lift || !planet || !view) return false
      const [width] = size
      const near = minis
        .filter((m) => {
          const [x] = onHero(m.x, world.ground(m.x, m.z), m.z)
          return m.dead < 0.05 && !m.gone && m.z - view.z > 15 && m.z - view.z < 50 && x > 40 && x < width - 40
        })
        .sort((a, b) => a.z - b.z)[0]
      if (!near) return false
      lift = { m: near, at: time, x: near.x, z: near.z }
      events.push({ kind: 'lift', x: -0.5 })
      return true
    },
    // A tape splice can be cued manually; automatic bookings use the shared stage.
    boss(time, teaser=false) {
      const span=teaser?0.57:BOSS.lasts
      if(hosting(time) || maw>0.02 || time<roarUntil || beam.power>0.02 || beam.held || time<beam.until || orb.moon || time-orb.from<11 || orb.next-time<Math.max(8,span+0.15) || time<maskAt+maskDuration+0.5 || notice) return false
      bossAt=time; bossSpan=span; bossCue=0; bossImpact=0; bossLaunch=[]; bossGaze=0
      bossSeed=Math.floor(bossRandom()*96)
      if(!teaser){bossSequence++;nextBoss=time+BOSS.again[0]+(BOSS.again[1]-BOSS.again[0])*bossRandom()}
      nextShot=Math.max(nextShot,time+span+0.6)
      nextRoar=Math.max(nextRoar,time+span+1.5)
      nextMask=Math.max(nextMask,time+span+2)
      stage(time,span)
      return true
    },
    // The sun takes its face off, and what is under it, and puts its face back.
    unmask(time) {
      if(hosting(time)) return false
      if (time - maskAt < maskDuration || maw > 0.02 || beam.power > 0.02 || orb.moon || time - orb.from < 12 || orb.next - time < maskDuration + 1) return false
      maskAt = time
      nextMask = time + 75 + random() * 40
      // It does nothing else while its face is off.
      nextShot = Math.max(nextShot, time + maskDuration + 0.5)
      nextRoar = Math.max(nextRoar, time + maskDuration + 1)
      events.push({ kind: 'wink', x: 0 })
      return true
    },
    // The painted sky parts, and there is a galaxy behind it whose stars play; at the
    // height of it everybody sings. Not in the rain, nor near a change of day and night (the next one waits).
    cosmos(time) {
      const wet = clamp01(Math.min((time - storm.from) / 2, (storm.until - time) / 3))
      if (!view || time - cosmosAt < COSMOS.lasts || hosting(time) || notice || diveAt !== null || diveFrom || wet > 0.02
        || time - orb.from < 10.5 || orb.next - time < 10 || (time > cry.from - 0.5 && time < cry.until + 1)
        || beam.power > 0.02 || beam.held || time < beam.until || maw > 0.02 || time < roarUntil) return false
      cosmosAt = time
      chorused = false
      stage(time, COSMOS.lasts) // (asked for by a visitor too, nothing else is to start meanwhile)
      // The sun does not shoot, roar or have people taken while the stars play.
      nextShot = Math.max(nextShot, time + COSMOS.lasts + 0.5)
      nextRoar = Math.max(nextRoar, time + COSMOS.lasts + 3)
      nextLift = Math.max(nextLift, time + COSMOS.lasts + 2)
      nextCosmos = cosmosDue = time + COSMOS.again[0] + (COSMOS.again[1] - COSMOS.again[0]) * cosmosRandom()
      if (storm.from > time && storm.from < time + COSMOS.lasts + 1) storm = { from: time + COSMOS.lasts + 2, until: time + COSMOS.lasts + 16 }
      orb.next = Math.max(orb.next, time + COSMOS.lasts + 1.5) // (the day or the night waits for it, before its evening light begins)
      if (cry.from > time && cry.from < time + COSMOS.lasts + 1) cry = { ...cry, from: time + COSMOS.lasts + 3, until: time + COSMOS.lasts + 3 + cry.until - cry.from }
      score = composeStars(cosmosRandom)
      scoreCue = 0
      lastStar = -1
      const key = size[0] >= 760 ? 'wide' : 'narrow', players = playersAt()
      events.push({ kind: 'stars', x: 0, score: score.map(([at, rank, loud]) => {
        const x = players[STAR_RANKS[key][rank]][0] / size[0]
        return [at, STAR_PITCH[rank], STAR_KIND[rank], loud, Math.max(-0.9, Math.min(0.9, 1.6 * (x - 0.5)))]
      }) })
      return true
    },
    // Everybody sings: the four throats and every creature, on one chord, the next, and home.
    chorus(time) {
      if (!view || time - chorusAt < CHORUS.lasts || hosting(time)) return false
      chorusAt = time
      if (time - cosmosAt > COSMOS.lasts) stage(time, CHORUS.lasts)
      // The sun and the planet have other things to do than shoot and take people.
      nextShot = Math.max(nextShot, time + CHORUS.lasts + 0.5)
      nextRoar = Math.max(nextRoar, time + CHORUS.lasts + 3)
      nextLift = Math.max(nextLift, time + CHORUS.lasts + 2)
      events.push({ kind: 'chorus', x: 0, score: { lasts: CHORUS.lasts, beat: CHORUS.beat, home: CHORUS.home, release: CHORUS.release, chords: CHORUS.chords, tune: CHORUS.tune } })
      return true
    },
    // The whole picture folds into a kaleidoscope, turns, and unfolds.
    fold(time) {
      if (time - foldAt < foldDuration) return false
      foldAt = time
      nextFold = time + 48 + random() * 30
      events.push({ kind: 'cast', x: 0 })
      return true
    },
    // The planet takes the visitor's own pointer, and gives back something else.
    abductPointer(time) {
      if (lift || !planet || !hand.at || hand.state) return false
      lift = { pointer: true, m: { seed: 0.3, gone: 0, x: 0, z: 0 }, at: time, spot: [...hand.at] }
      events.push({ kind: 'lift', x: -0.5 })
      return true
    },
    // NormalScript puts its notice up over the picture.
    comply(time) {
      if(hosting(time)) return false
      if (notice) return false
      notice = { at: time }
      nextNotice = time + NOTICE.again[0] + (NOTICE.again[1] - NOTICE.again[0]) * noticeRandom()
      return true
    },
    // The visitor presses its dark button, and greyness has the whole picture.
    accept(time) {
      if (!notice || notice.fired || notice.burnAt !== undefined || notice.acceptAt !== undefined) return false
      notice.acceptAt = time
      startledAt = time
      return true
    },
    // The eye dives into the terminal's screen; inside, it dives on through
    // the screen of the terminal in there and is out in the picture again.
    dive(time) {
      if (diveAt !== null || !machine) return false
      diveAt = time
      diveBack = Infinity
      events.push({ kind: 'zoom', x: machine && view ? Math.max(-1, Math.min(1, (machine[0] - view.cx) / 700)) : 0.4 })
      return true
    },
    // Out of the terminal, if the eye is in it or on its way in. Says whether it was.
    surface(time) {
      if (diveAt === null) return diveFrom === 1 && this.dive(time)
      if (diveFrom === 0) diveBack = 0
      return true
    },
    // The compliance officers come.
    audit(time) {
      return beginAudit(time)
    },
    // The picture draws back into a browser window, which doubles, and doubles again.
    windows(time) {
      if (time - windowsAt < windowsDuration || time - breakAt < breakDuration) return false
      windowsAt = time
      windowsCue = 0
      nextWindows = time + 80 + 40 * lensRandom() // WINDOWS: then every 80 to 120 s
      return true
    },
    // A perfectly ordinary page of an encyclopedia breaks in over half the picture.
    breakIn(time) {
      if (time - breakAt < breakDuration || time - windowsAt < windowsDuration) return false
      breakAt = time
      breakCue = 0
      breakSeed = Math.floor(lensRandom() * 64)
      nextBreak = time + 100 + 40 * lensRandom() // BREAK-IN: then every 100 to 140 s
      return true
    },
    unfold(time) {
      if (time - unfoldAt < unfoldDuration) return false
      unfoldAt = time
      nextUnfold = time + 35 + random() * 20
      return true
    },
    type() {
      if (!script.at(-1).mine) feed({ seed: random() * 90, length: 0, typed: 0, sign: 0.95, mine: true })
      const line = script.at(-1)
      if (line.length < 7) line.length++
      events.push({ kind: 'key', x: 0.5 })
    },
    erase() {
      const line = script.at(-1)
      if (!line.mine || !line.length) return
      line.length--
      line.typed = Math.min(line.typed, line.length)
    },
    // The line is cast, and something comes of it: each cast something else.
    cast(time) {
      if (!view || time - castAt < 0.6) return
      castAt = time
      const line = script.at(-1)
      spells = (spells + 1 + (line.mine ? line.length : 0)) % 11
      speak(time, 'cast')
      line.mine = false
      events.push({ kind: 'cast', x: 0.5 })
      if (machine) {
        add({ x: machine[0], y: machine[1] - 70, vx: 0, vy: -40, life: 1, fade: 0.6, kind: 3, seed: 0.95 })
        burst(machine[0], machine[1] - 60, 7, 1, 170)
      }
      const [width, height] = size
      const unbuilt = sites.filter((site) => !site.falling && site.built < 1 && site.z - view.z > 20).sort((a, b) => a.z - b.z)[0]
      let spell = spells
      if (spell === 10) { this.unfold(time); return }
      if (spell === 2 && !unbuilt) spell = 0
      if (spell === 5 && raining) spell = 1
      if (spell === 8 && !this.abduct(time)) spell = 0
      if (spell === 9) spell = 0
      if (spell === 0) {
        let told = false
        for (let i = 0; i < 5; i++) {
          const planted = sprout(time + i * 0.12)
          if (!planted) continue
          const [x, y] = onHero(planted.x, world.ground(planted.x, planted.z), planted.z)
          if (!told) say('flower', x, y - 30)
          told = true
        }
      } else if (spell === 1) strike(width * (0.15 + 0.7 * random()), height - 40 - 110 * random(), time)
      else if (spell === 2) unbuilt.speedSpell = true
      else if (spell === 3) {
        rainbowFrom = time
        say('rainbow')
      } else if (spell === 4 && !hosting(time)) {
        roarUntil = time + 3
        say('roar')
      } else if (spell === 5) storm = { from: time, until: time + 11 }
      else if (spell === 6) cry = { from: time, until: time + 8, blood: random() < 0.5 }
      else {
        winkAt = time
        turnOver(time)
      }
    },
    // A word spelt at the terminal (see secrets.WORDS). Each keeps to its own
    // rules, and does nothing when they say no. Says whether it took.
    spell(word, time) {
      if (!view) return false
      if (word === 'fire') {
        for (let tries = 0; tries < 8; tries++) {
          const spot = somewhere()
          if (spot && spot[1] - view.z > 18 && kindle(spot[0], spot[1], time, random() * 6.283)) {
            events.push({ kind: 'burn', x: Math.max(-1, Math.min(1, (onHero(spot[0], world.ground(spot[0], spot[1]), spot[1])[0] - view.cx) / 700)) })
            return true
          }
        }
        return false
      }
      if (word === 'rain') {
        if (raining || (time >= storm.from && time < storm.until)) return false
        storm = { from: time, until: time + 11 }
        return true
      }
      if (word === 'night' || word === 'day') {
        if (hosting(time) || orb.moon === (word === 'night') || time - orb.from < 10) return false
        winkAt = time
        turnOver(time)
        return true
      }
      if (word === 'dax') return this.boss(time)
      if (word === 'snake') {
        if (crossing) return false
        nextSnake = time
        return true
      }
      if (word === 'flower') return flowerRing(time) > 0
      if (word === 'fold') return this.fold(time)
      if (word === 'stars') return this.cosmos(time)
      if (word === 'sing') return this.chorus(time)
      if (word === 'speak') return this.say(time)
      return false
    },
    // Tickled too often, the sun loses its temper. By day, and not while anything else has it.
    tantrum(time) {
      if (!view || hosting(time) || sweep || notice || beam.held || orb.moon || time - orb.from < 10 || orb.next - time < 8 || time - maskAt < maskDuration) return false
      const [width, height] = size
      const way = random() < 0.5 ? -1 : 1
      const [near, far] = [height - 0.42 * world.horizon, height - 0.78 * world.horizon]
      sweep = { at: time, from: [width * (0.5 - 0.44 * way), far], to: [width * (0.5 + 0.44 * way), near], span: 2.8 }
      roarUntil = time + 5.6
      nextRoar = Math.max(nextRoar, time + 14)
      nextShot = Math.max(nextShot, time + 6)
      beam.burning = null
      say('roar')
      return true
    },
    // The planet shows the visitor what it sees.
    stare(time) {
      if (!planet || time - stareAt < stareDuration) return false
      stareAt = time
      winkAt = time
      events.push({ kind: 'lift', x: -0.5 })
      return true
    },
    // A shower of petals and confetti, and a rainbow, for whoever has planted seven flowers.
    shower(time) {
      if (!view) return false
      const [width, height] = size
      for (let i = 0; i < 4; i++) burst(width * (0.2 + 0.2 * i), height * (0.16 + 0.05 * (i % 2)), 5, i % 2 ? 1 : 2, 140)
      gladAt = time
      winkAt = time + 0.3
      if (time - rainbowFrom > 17) {
        rainbowFrom = time
        say('rainbow')
      }
      events.push({ kind: 'flower', x: 0 })
      speak(time, 'flower', 1)
      return true
    },
    // Whether the eye is in the terminal, or on its way in or out.
    get diving() {
      return diveAt !== null || diveFrom !== 0
    },
    tick(time, dt, { width, height, sun, pointer = null, focal = 760, machine: stands = null, song = 0, hurry = 0, planet: eyeball = null }) {
      now = time
      if(sun && offstage(time)){
        if(time>=nextBoss){this.boss(time)}
        else if(time>=nextTease && time<14 && this.boss(time,true)){nextTease=Infinity}
      }
      // The cosmos comes first in its turn, and keeps its slot while the last of a storm clears.
      if (time >= nextCosmos && offstage(time)) {
        if (saying) stageUntil = Math.max(stageUntil, time + 0.5) // (the sun finishes what it is saying first)
        else if (this.cosmos(time)) stage(time, COSMOS.lasts)
        else if (time > storm.from && time < storm.until + 3.2 && storm.until - time < 8) stageUntil = Math.max(stageUntil, time + 0.5)
        else if (beam.power > 0.02 || beam.held || time < beam.until || maw > 0.02 || time < roarUntil) {
          // (the sun is shooting or roaring: it is let finish, and starts nothing new)
          nextShot = Math.max(nextShot, time + 4)
          nextRoar = Math.max(nextRoar, time + 4)
          nextCosmos = time + 0.5
        }
        else if (time - cosmosDue < 15 && !(time > storm.from && time < storm.until)) stageUntil = Math.max(stageUntil, time + 0.5) // (it keeps its slot a while)
        else nextCosmos = time + (time > storm.from && time < storm.until ? storm.until + 4 - time : 3)
      }
      if (time >= nextUnfold && offstage(time) && this.unfold(time)) stage(time, unfoldDuration)
      // The windows and the page that breaks in: never both at once; whichever has to wait tries again shortly.
      if (time >= nextWindows && offstage(time)) {
        if (this.windows(time)) stage(time, windowsDuration)
        else nextWindows = time + 4
      }
      if (time >= nextBreak && offstage(time)) {
        if (this.breakIn(time)) stage(time, breakDuration)
        else nextBreak = time + 4
      }
      // lens[0]: seconds into the windows (0 when there are none); lens[1]: the sun's radius in design units.
      // lens[4]: seconds into the break-in (0 when there is none); lens[6]: 1 on a screen taller than it is wide; lens[7]: which break-in this is.
      const paned = time - windowsAt
      const broken = time - breakAt
      lens[0] = paned > 0 && paned < windowsDuration ? paned : 0
      lens[1] = sun?.[2] ?? 100
      lens[4] = broken > 0 && broken < breakDuration ? broken : 0
      lens[6] = width < height ? 1 : 0
      lens[7] = breakSeed
      for (; lens[0] && windowsCue < windowsCues.length && paned >= windowsCues[windowsCue][0]; windowsCue++) events.push({ kind: windowsCues[windowsCue][1], x: windowsCues[windowsCue][2] })
      for (; lens[4] && breakCue < breakCues.length && broken >= breakCues[breakCue][0]; breakCue++) events.push({ kind: breakCues[breakCue][1], x: (width < height ? 0 : 1) * breakCues[breakCue][2] })
      // Now and then NormalScript sends its compliance officers; not so that
      // the sun would be setting as it opens its mouth for one, and not while
      // the picture is in the middle of something else.
      if (time >= nextAudit) {
        const busy = time < foldAt + foldDuration + 1 || time < unfoldAt + unfoldDuration + 1 || time < maskAt + maskDuration + 1 || notice || diveAt !== null || diveFrom
        if (orb.next - time > 8 && orb.next - time < 13) nextAudit = time + 6
        else if (busy || !offstage(time)) nextAudit = time + 1
        else if (this.audit(time)) stage(time, 16)
      }
      // The dive: how deep the eye is (1 is inside; past that it is on its way
      // out of the far side, and 2 is the picture again), and how fast it is going.
      let deep = diveFrom
      let rush = 0
      if (diveAt !== null) {
        const gone = clamp01((time - diveAt) / diveDuration)
        if (gone >= 1) {
          diveFrom = 1 - diveFrom
          diveAt = null
          deep = diveFrom
          if (diveFrom) diveBack = Math.min(diveBack, time + diveStay)
        } else {
          const [a, b] = [gone ** 2.2, (1 - gone) ** 2.2]
          deep = diveFrom + Math.min(a / (a + b), 0.99999) // never quite the next whole number, which is the far side
          rush = (gone * (1 - gone)) ** 1.2 / (a + b) ** 2
        }
      } else if (diveFrom && time >= diveBack) this.dive(time)
      lens[16] = deep
      lens[23] = rush
      // The notice. It comes up by itself when the sun is there to deal with it
      // and is not in the middle of something.
      if (!notice && time >= nextNotice && time >= NOTICE.notBefore && time > roarUntil + 0.6 && maw < 0.05 && !beam.held
        && time - orb.from > 10.5 && orb.next - time > NOTICE.rise + NOTICE.seep + NOTICE.fire + 1.5 && offstage(time) && this.comply(time)) stage(time, 8)
      let noticeNow = null
      shielded = false
      glare = 0
      lens.fill(0, 8, 16)
      if (notice) {
        const n = notice
        const card = width < 760 ? NOTICE.narrow : NOTICE.wide
        const x = (width - card.w) / 2
        const rest = height - card.gap - card.h
        const since = time - n.at
        // It slides up from under the bottom edge, and lands.
        let y = rest + (height + 30 - rest) * (1 - clamp01(since / NOTICE.rise)) ** 3
        if (!n.landed && since > NOTICE.rise * 0.6) {
          n.landed = true
          events.push({ kind: 'step', x: 0 })
        }
        // Greyness seeps out of it, quickly and then more and more slowly.
        const seeping = Math.max(0, (n.acceptAt ?? time) - n.at - 0.5)
        const spread = clamp01(seeping / NOTICE.seep)
        let reach = NOTICE.reach * spread * (2 - spread) + 5 * Math.max(0, seeping - NOTICE.seep)
        let dome = sun ? sun[2] : 0
        // Meanwhile the sun leaves everything else alone.
        nextShot = Math.max(nextShot, time + 2.5)
        nextRoar = Math.max(nextRoar, time + 4)

        const onCard = beam.x > x && beam.x < x + card.w && beam.y > y - 6 && beam.y < y + card.h
        if (n.acceptAt !== undefined) {
          // Accepted, it goes back down, and greyness takes everything, the sun
          // last of all. Then colour comes back out of the sun.
          const accepted = time - n.acceptAt
          const down = clamp01((accepted - 0.1) / 0.5)
          const flood = clamp01(accepted / NOTICE.flood)
          const back = clamp01((accepted - NOTICE.flood) / NOTICE.back)
          y = rest + (height + 30 - rest) * down * down
          reach += 2 * Math.hypot(width, height) * flood * flood
          dome = dome * (1 - flood * flood * (3 - 2 * flood)) + Math.hypot(width, height) * back * back
          if (back >= 1) notice = null
        } else if (n.burnAt === undefined) {
          // The sun turns its lasers on the middle of its top edge. Lasers held on it sooner do as well.
          if (!n.fired && since >= NOTICE.rise + NOTICE.seep && !beam.held && time >= beam.until && time - orb.from > 10) {
            n.fired = time
            fire(width / 2, rest + 5, time, NOTICE.fire)
          }
          if ((since > NOTICE.rise && beam.power > 0.6 && onCard) || (n.fired && time - n.fired > 0.5)) {
            n.burnAt = time
            n.hit = n.fired ? [width / 2, rest + 5] : [Math.max(x + 12, Math.min(x + card.w - 12, beam.x)), Math.max(rest + 5, Math.min(rest + card.h - 12, beam.y))]
            // Burnt from one end, it takes longer to be gone from the other.
            n.gone = NOTICE.burn + 2.4 * Math.abs((n.hit[0] - x) / card.w - 0.5)
            shake = Math.max(shake, 0.3)
            events.push({ kind: 'steam', x: 0 })
          }
          // Until then the sun likes it less and less.
          glare = clamp01((since - 0.9) / 1.6)
        }
        shielded = n.acceptAt === undefined && onCard && (n.burnAt === undefined || time - n.burnAt < 2.2)
        let burning = 0
        if (n.burnAt !== undefined) {
          burning = Math.max(time - n.burnAt, 1e-4)
          // Sparks fly off it while the lasers are on it.
          if (shielded && beam.power > 0.5 && time >= (n.sparkAt ?? 0)) {
            n.sparkAt = time + 0.09
            const r = noticeRandom()
            add({ x: n.hit[0] + 30 * (r - 0.5), y: n.hit[1] - 6, vx: 460 * (noticeRandom() - 0.5), vy: -190 - 230 * noticeRandom(), life: 1, fade: 0.8 + 0.5 * r, kind: 0, seed: r * 0.98 })
          }
          // The sun is pleased with itself.
          if (!n.glad && burning > 2.3) {
            n.glad = true
            gladAt = time
          }
          if (burning >= n.gone) {
            notice = null
            speak(time, 'burnt', 1 / 2)
          }
        }
        if (notice) {
          lens.set([dome, y, card.w, card.h, reach, burning, n.hit?.[0] ?? width / 2, n.hit?.[1] ?? rest], 8)
          const [bx, by, bw, bh] = card.button
          // Where it is, and whether its dark button can still be pressed.
          noticeNow = { x, y, w: card.w, h: card.h, up: Boolean(n.landed) && !n.fired && n.burnAt === undefined && n.acceptAt === undefined, button: [x + bx, y + by, bw, bh] }
        }
      }
      if (time >= nextFold && offstage(time) && this.fold(time)) stage(time, foldDuration)
      if (time >= nextMask && offstage(time)) {
        if (this.unmask(time)) stage(time, maskDuration)
        else nextMask = time + 3
      }
      {
        const k = (time - foldAt) / foldDuration
        const ease = (x) => x * x * x * (x * (x * 6 - 15) + 10)
        const open = k > 0 && k < 1 ? ease(clamp01(k / 0.22)) * (1 - ease(clamp01((k - 0.78) / 0.22))) : 0
        lens.set([open, 0.4 + 2.2 * ease(clamp01(k)), 6, 0], 24)
      }
      planet = eyeball
      ahead += Math.max(-0.92, hurry) * dt
      size = [width, height]
      machine = stands
      const diagonal = Math.hypot(width, height) + 320
      pan += ((pointer ? clamp01(pointer[0] / width) * 2 - 1 : 0) - pan) * Math.min(1, dt * 1.5)

      // The valley fills while it rains and drains after.
      const rain = clamp01(Math.min((time - storm.from) / 2, (storm.until - time) / 3))
      wet = clamp01(wet + dt * (rain > 0.3 ? 0.09 : -0.028))
      const level = -0.35 + 0.95 * wet * wet * (3 - 2 * wet)
      view = world.view(time + ahead, { cx: sun ? sun[0] : width / 2, height, focal, pan, level })
      if (!sites.length) begin()
      // The cosmos and the chorus, as the picture is to show them.
      const sinceCosmos = time - cosmosAt
      space = 0
      if (sinceCosmos >= 0 && sinceCosmos < COSMOS.lasts) {
        const ease = (x) => x * x * x * (x * (x * 6 - 15) + 10)
        space = ease(clamp01(sinceCosmos / COSMOS.open)) * (1 - ease(clamp01((sinceCosmos - COSMOS.lasts + COSMOS.open) / COSMOS.open)))
        if (!chorused && sinceCosmos >= COSMOS.chorus) chorused = this.chorus(time) || true
        for (; scoreCue < score.length && sinceCosmos >= score[scoreCue][0]; scoreCue++) {
          const i = STAR_RANKS[width >= 760 ? 'wide' : 'narrow'][score[scoreCue][1]]
          starFrom[i] = lastStar < 0 ? i : lastStar
          starSang[i] = time
          starLoud[i] = score[scoreCue][2]
          lastStar = i
        }
      }
      if (space > 0) {
        const key = width >= 760 ? 'wide' : 'narrow', players = playersAt()
        STAR_RANKS[key].forEach((i, rank) => starInk.set([players[i][0], players[i][1], time - starSang[i], starFrom[i] * 4 + STAR_KIND[rank] + 0.9 * starLoud[i]], i * 4))
      }
      const sinceChorus = time - chorusAt
      singing = chorusMouth = chorusBeats = chorusSwell = 0
      if (sinceChorus >= 0 && sinceChorus < CHORUS.lasts) {
        singing = smooth(0, 1, sinceChorus) * (1 - smooth(CHORUS.lasts - 1.8, CHORUS.lasts, sinceChorus))
        chorusBeats = sinceChorus / CHORUS.beat
        const k = chorusBeats % 1
        const held = smooth(CHORUS.home, CHORUS.home + 0.3, sinceChorus) * (1 - smooth(CHORUS.release, CHORUS.release + 1.2, sinceChorus))
        chorusMouth = singing * Math.max(k < 0.1 ? k / 0.1 : Math.exp(-(k - 0.1) * 3), 0.9 * held)
        chorusSwell = smooth(0, CHORUS.home + 0.6, sinceChorus) * (1 - smooth(CHORUS.release, CHORUS.lasts, sinceChorus))
      }

      // Day and night.
      if (time > orb.next) turnOver(time)
      const age = time - orb.from
      const ease = (n) => {
        const k = clamp01(n)
        return k * k * k * (k * (k * 6 - 15) + 10)
      }
      // They change over together, on one wheel (see sunNow in the shader): the
      // one that was up is half way down as the other is half way up.
      const turning = age < WHEEL ? ease(age / WHEEL) : 1
      if (age >= WHEEL / 2 && age < 10 && orb.moon !== orb.toNight) {
        orb.moon = orb.toNight
        say(orb.moon ? 'moonrise' : 'sunrise')
      }
      const sinking = age < WHEEL ? Math.max(0.001, Math.sin(Math.PI * turning)) : 0
      const night = age < WHEEL ? (orb.toNight ? turning : 1 - turning) : orb.moon ? 1 : 0
      const wheel = turning > 0 && turning < 1 ? (orb.toNight ? turning : -turning) : 0
      const drop = 0

      // The sun's temper: after a moment's roaring its lasers go across the valley, and then it is pleased with itself.
      if (sweep) {
        const k = (time - sweep.at - 0.7) / sweep.span
        if (k >= 1 || sinking > 0 || hosting(time)) {
          sweep = null
          gladAt = time + 0.6
          nextShot = Math.max(nextShot, time + 3)
        } else if (k >= 0) {
          const e = k * k * (3 - 2 * k)
          Object.assign(beam, { x: sweep.from[0] + (sweep.to[0] - sweep.from[0]) * e, y: sweep.from[1] + (sweep.to[1] - sweep.from[1]) * e, until: time + 0.15 })
        }
      }
      const firing = (beam.held || time < beam.until) && sinking < 0.06
      beam.power += ((firing ? 1 : 0) - beam.power) * Math.min(1, dt * (firing ? 14 : 9))
      if (beam.power < 0.01 && !firing) beam.power = 0

      // Left alone, the sun picks its own targets.
      if (!firing && time > nextShot && sinking === 0 && !(time>nextBoss-1.8 && time<nextBoss+1)) {
        const old = blooms.filter((b) => !b.burnt && time - b.born > 6 && b.z - view.z > 22)
        if (random() < 0.55 && old.length && random() < blooms.length / 10) {
          const b = old[Math.floor(random() * old.length)]
          const [x, y, k] = onHero(b.x, world.ground(b.x, b.z), b.z)
          fire(x, y - b.size * k * 2.4, time, 0.8)
        } else if (random() < 0.55) {
          fire(width * (0.04 + 0.92 * random()), height - world.horizon + 30 + (world.horizon - 50) * random(), time, 0.8)
        } else {
          fire(width * (0.06 + 0.88 * random()), height * 0.14 + (height - 300 - height * 0.14) * random(), time, 1.1)
        }
        nextShot = time + (time < 26 ? 5 : 2.2) + 2.6 * random() // it is in no hurry at first
      }

      if (time > nextRoar && sinking === 0) {
        roarUntil = time + 3
        nextRoar = time + 24 + 22 * random()
        say('roar')
      }

      // What the lasers are doing to whatever they touch.
      let shot = [0, 0, 0]
      if (beam.power > 0.5 && !shielded) {
        const spot = world.pick(view, beam.x, beam.y)
        const near = (x, y, z, r) => {
          const [sx, sy, k] = onHero(x, y, z)
          return z - view.z > 6 && Math.hypot(sx - beam.x, sy - beam.y) < r * k
        }
        // The ground it crosses is burnt, and water boils off as steam.
        if (spot && !spot.wet && beam.power > 0.5) {
          if (time>=nextCatch && rain<0.42 && !byDesk(beam.x,beam.y)) {
            nextCatch=time+0.23
            if (kindle(spot.x,spot.z,time,0.38+0.60*Math.sin(spot.z*0.09))) {
              burst(beam.x,beam.y,7,0,190)
              events.push({kind:'burn',x:Math.max(-1,Math.min(1,(beam.x-view.cx)/700))})
            }
          }
        } else if (spot && spot.wet && beam.power > 0.5 && time > steamAt) {
          steamAt = time + 0.09
          add({ x: beam.x + 14 * (random() - 0.5), y: beam.y - 4, vx: 30 * (random() - 0.5), vy: -70 - 40 * random(), life: 1, fade: 1 / (0.55 * 0.9), kind: 8, seed: random() })
        }
        if (byDesk(beam.x,beam.y,0.04)) scorchDesk(time,0.29)
        const touched = blooms.find((b) => b !== beam.burning && !b.burnt && time - b.born > 1.2 && near(b.x, world.ground(b.x, b.z) + b.size * 2, b.z, b.size * 2.2))
        const fried = minis.find((m) => !m.struckAt && near(m.x, world.ground(m.x, m.z) + 0.6 * world.mini, m.z, world.mini))
        const razed = sites.find((site) => site.built > 0 && !site.falling && near(site.x, world.ground(site.x, site.z) + 1.95 * site.built, site.z, 1.95))
        if (touched) {
          touched.burnt = time
          say('burn', beam.x, beam.y - 24)
          burst(beam.x, beam.y, 5, 0)
        } else if (fried) {
          fried.struckAt = time
          startledAt = time
          say('fried', beam.x, beam.y - 24)
          burst(beam.x, beam.y, 8, 0, 220)
        } else if (razed) {
          lightHouse(razed,time)
        } else if (spot && !spot.wet && spot.z - view.z > 17) {
          if (!blooms.some((b) => !b.burnt && Math.hypot(b.x - spot.x, b.z - spot.z) < 2.4)) {
            beam.burning = plant(spot.x, spot.z, time) // the lasers that planted it do not burn it
            say('flower', beam.x, beam.y - 30)
            burst(beam.x, beam.y, 6, 2, 110)
          }
        } else if (!spot) {
          shot = [beam.x, beam.y, beam.power]
        }
      }
      advanceBrush(time,dt,rain)
      for (let i = blooms.length - 1; i >= 0; i--) {
        if ((blooms[i].burnt && time - blooms[i].burnt > 1.5) || blooms[i].z - view.z < 15.5) blooms.splice(i, 1)
      }

      if (rain > 0.3 && !raining) say('rain')
      if (raining && rain <= 0.3) say('dry')
      raining = rain > 0.3
      if (time > storm.until) {
        rainbowFrom = storm.until
        say('rainbow')
        const from = time + 40 + 30 * random()
        storm = { from, until: from + 14 }
      }
      if (rain > 0.6 && time > nextBolt) {
        strike(width * (0.06 + 0.88 * random()), height - 30 - (world.horizon - 60) * random(), time)
        nextBolt = time + 3.5 + 3.5 * random()
      }
      const rainbow = clamp01(Math.min((time - rainbowFrom) / 3, (rainbowFrom + 17 - time) / 3))

      const tears = clamp01(Math.min((time - cry.from) / 1.2, (cry.until - time) / 1.5))
      if (tears > 0.3 && !crying) say(cry.blood ? 'blood' : 'tears')
      crying = tears > 0.3
      if (time > cry.until) {
        const from = time + 16 + 18 * random()
        cry = { from, until: from + 9, blood: !cry.blood }
      }
      if (time > nextSprout && (rain > 0.5 || (tears > 0.6 && !cry.blood))) {
        sprout(time)
        nextSprout = time + 0.9 + 0.8 * random()
      }

      // The maw opens and closes on a spring with no bounce, so it starts
      // gently, settles gently, and can turn round part way.
      const stiff = time < roarUntil ? 4.6 : 3.8
      for (let left = dt; left > 0; left -= 1 / 120) {
        const h = Math.min(left, 1 / 120)
        mawSpeed += (stiff * stiff * ((time < roarUntil ? 1 : 0) - maw) - 2 * stiff * mawSpeed) * h
        maw = clamp01(maw + mawSpeed * h)
      }

      // The village. A site left behind is started again far ahead.
      let pulse = null
      sites.forEach((site, i) => {
        if (site.z - view.z < 6) sites[i] = newSite(lastSite + 7 + 4 * random(), 0)
      })
      sites.forEach((site, i) => {
        const next = sites[(i + 1) % 8]
        const joined = site.built >= 1 && next.built >= 1 && !site.falling && !next.falling && next.id === site.id + 1
        site.wire = joined ? Math.min(1, site.wire + dt * 0.45) : 0
        if (site.built >= 1 && !site.falling && !site.told) {
          site.told = true
          site.doneAt = time
          gladAt = time
          const [x, y, k] = onHero(site.x, world.ground(site.x, site.z) + 2, site.z)
          say('built', x, y - 1.6 * k)
          burst(x, y, 12, 1, 60 + 5 * k)
        }
        if (site.doneAt && time - site.doneAt < 2.5) pulse = site
      })

      const chimneys=[], fireWindows=new Float32Array(8)
      for (const [i,site] of sites.entries()) {
        if (site.singe==null) continue
        const age=time-site.singe, y=world.ground(site.x,site.z)
        site.fireWet=clamp01(site.fireWet+dt*(rain>0.28?rain:0))
        const lit=smooth(0,0.50,age)*(1-site.fireWet)*(1-smooth(3.8,6.3,age))
        site.fireDose+=dt*lit
        fireWindows[i]=lit
        if(!site.falling && site.fireDose>2.25) {
          Object.assign(site,{falling:true,wire:0,told:false,stumpUntil:time+6.2})
          const [x,sy]=onHero(site.x,y+1.4,site.z); say('razed',x,sy)
        }
        if(age>9.0) {site.singe=null;continue}
        const built=site.built*smooth(7,15,site.z-view.z), climb=smooth(0,2.4,age)
        const width=(0.28+0.92*climb)*Math.max(0.2,built)
        const smoke=smooth(0.4,1.5,age)*(1-smooth(5.3,9,age))
        chimneys.push({x:site.x,y,z:site.z,radius:1.65,fx:site.x+0.28*built,
          fy:y+(0.55+2.9*climb)*built,fz:site.z-0.65*built,width:width+0.26,
          height:1.1+0.7*built,slope:0,heat:lit*smooth(6,10,site.z-view.z),smoke:smoke*smooth(6,10,site.z-view.z),ash:0,steam:site.fireWet,seed:site.seed})
      }
      for (const site of sites) {
        // A long breath at full height, then the crown folds first and the floor last.
        // Only a completely buried structure gets a new seed. Razing uses this same descent.
        if (site.built >= 1 && !site.falling) {
          site.hold -= dt
          if (site.hold <= 0) Object.assign(site,{falling:true,told:false,wire:0})
        }
        if (site.falling) {
          site.built = Math.max(0,site.built-dt*(site.hold<=0 ? 0.21 : 0.54))
          if (time<site.stumpUntil) site.built=Math.max(0.105,site.built)
          if (!site.built) {
            site.family = (site.family+1+Math.floor(site.seed*3))%4
            site.seed = (site.seed*31.741+0.417)%1
            Object.assign(site,{falling:false,speedSpell:false,hold:6+9*site.seed,regrowAt:time+0.65})
          }
        } else if (time >= site.regrowAt && site.built < 1) {
          // The foundation creeps up on its own, even if all the minis are elsewhere.
          site.built = Math.min(1,site.built+dt*(site.speedSpell ? 0.65 : 0.048+0.022*site.seed))
        }
      }

      const sight = pointer && world.pick(view, pointer[0], pointer[1])
      minis.forEach((m, i) => {
        // Taken by the planet, it is nowhere for a while, and then far ahead.
        if (m.gone) {
          m.z = view.z - 40
          if (time < m.gone) return
          m.gone = 0
        }
        // Left behind by a burst of speed, it turns up again far ahead.
        if (m.z - view.z < 9) Object.assign(m, { z: view.z + 60 + 25 * random(), x: world.river(view.z + 70) + (i % 2 ? 4 : -4), job: -1 })
        const down = m.struckAt > 0 && time > m.struckAt && time - m.struckAt < 3.2
        m.dead += ((down ? 1 : 0) - m.dead) * Math.min(1, dt * (down ? 8 : 2.5))
        if (m.struckAt && time - m.struckAt >= 3.2 && m.dead < 0.03) Object.assign(m, { struckAt: 0, dead: 0 })

        // Where it wants to be: with whatever the pointer is over, or at its site, or strolling.
        let site = m.job >= 0 ? sites[m.job % 8] : null
        if (!site || site.id !== m.job || site.falling || site.regrowAt > time || site.built >= 1 || site.z - view.z < 18) {
          const open = sites.filter((s) => s.built < 1 && !s.falling && time >= s.regrowAt && s.z - view.z > 22)
          const crowd = (s) => minis.filter((other) => other.job === s.id).length
          site = open.sort((a, b) => crowd(a) - crowd(b) || Math.abs(a.z - m.z) - Math.abs(b.z - m.z))[0] ?? null
          m.job = site ? site.id : -1
        }
        let goal
        let face = null
        const around = m.seed * 6.283 + i
        if (sight && i % 2 === 0 && Math.hypot(sight.x - m.x, sight.z - m.z) < 26) {
          goal = [sight.x + 1.7 * Math.cos(around), sight.z + 1.7 * Math.sin(around)]
          face = sight
        } else if (site) {
          goal = [site.x + 1.75 * Math.cos(around), site.z + 1.75 * Math.sin(around)]
          face = site
        } else {
          const z = view.z + 26 + 18 * m.seed
          goal = [world.river(z) + (i % 2 ? 1 : -1) * (2.8 + 3 * m.seed), z]
        }
        if (goal[1] - view.z < 19) goal[1] = view.z + 24 // never left behind
        // They run from the compliance officers and their grey.
        if (audit && audit.rank && !audit.tame) {
          const off = (m.x - world.river(m.z)) * audit.side
          if (off > audit.first - 2.5 && off < audit.first + 4 * audit.pitch + 2.5 && m.z > audit.rank - 5 && m.z < audit.rank + 10) {
            goal = [world.river(m.z) + audit.side * (audit.first + 4 * audit.pitch + 6), Math.max(view.z + 24, m.z + 3)]
            face = null
          }
        }

        let threat=null, distance=5.8
        for (const f of brush) if(f.heat>0.16) {
          const away=Math.hypot(m.x-f.fx,m.z-f.fz)
          if(away<distance){threat=f;distance=away}
        }
        if(threat){
          const k=5/Math.max(0.2,distance)
          goal=[m.x+(m.x-threat.fx)*k,Math.max(view.z+19,m.z+(m.z-threat.fz)*k)]
          face=null
        }
        if (singing > 0.05 && m.dead < 0.08) {
          goal = [m.x, m.z]
          face = { x: view.x, z: view.z }
        }
        // It turns toward where it is going, speeds up and slows down gently, and stops facing its work.
        const to = [goal[0] - m.x, goal[1] - m.z]
        const far = Math.hypot(to[0], to[1])
        const there = far < 0.3
        const aim = there ? (face ? Math.atan2(face.x - m.x, face.z - m.z) : m.heading) : Math.atan2(to[0], to[1])
        let turn = aim - m.heading
        turn -= Math.PI * 2 * Math.round(turn / (Math.PI * 2))
        m.heading += Math.max(-4 * dt, Math.min(4 * dt, turn * Math.min(1, dt * 7)))
        const want = m.dead > 0.08 || there ? 0 : Math.min(3.6, 0.5 + far * 1.3) * Math.max(0, Math.cos(turn))
        m.speed += Math.max(-7 * dt, Math.min(4 * dt, want - m.speed))
        m.x += Math.sin(m.heading) * m.speed * dt
        m.z += Math.cos(m.heading) * m.speed * dt
        m.stride += (clamp01(m.speed / 1.5) - m.stride) * Math.min(1, dt * 8)
        m.phase += (m.speed * dt * 0.62) / (0.8 * world.mini * Math.max(m.stride, 0.3))

        const working = there && face === site && site && m.dead < 0.08
        if (working) site.built = Math.min(1, site.built + dt * 0.095)
        m.dip += ((working ? 0.5 + 0.5 * Math.sin(time * 8 + m.seed * 6) : 0) - m.dip) * Math.min(1, dt * 10)
        if (singing > 0.05) m.dip = Math.max(m.dip, 0.45 * chorusMouth)
      })

      if(machine && brush.length && time-contactAt>1.15) {
        const boot=world.pick(view,machine[0],machine[1]+0.78*machine[2])
        if(boot && brush.some(f=>f.heat>0.24 && Math.hypot(f.fx-boot.x,f.fz-boot.z)<2.6)) scorchDesk(time,0.17)
      }
      damageGoal=Math.max(0,damageGoal-dt*(time-contactAt>2.5?0.052:0))
      damage+=(damageGoal-damage)*(1-Math.exp(-dt*9))
      if(damage<0.0002 && !damageGoal) damage=0
      // The terminal's jump: it crouches, goes up, comes down and settles.
      const sinceJump = time - jumpAt
      const hop = [0, 0] // how far its boots are off the ground, and how far its body sags
      if (sinceJump >= 0 && sinceJump < 0.16) hop[1] = -0.16 * (sinceJump / 0.16)
      else if (sinceJump < 0.9) hop[0] = 4.6 * ((sinceJump - 0.16) / 0.74) * (1 - (sinceJump - 0.16) / 0.74)
      else if (sinceJump < 1.8) hop[1] = -0.2 * Math.exp(-(sinceJump - 0.9) * 7) * Math.cos((sinceJump - 0.9) * 20)
      const slam = !slammed && sinceJump >= 0.9
      if (slam) slammed = true
      shake = Math.max(0, shake - dt * 2.2)

      let whaleNow = [0, 0, 0, 0, 0, 0, 0, 0]
      if (whale) {
        const since = time - whale.at
        const air = 2.7
        const fall = 7.4
        const [x, y, k] = onHero(whale.x + whale.way * 1.1 * since, whale.level + 0.5 * fall * since * (air - since) - 0.4, whale.z)
        const surface = onHero(whale.x, whale.level, whale.z)[1]
        whaleNow = [x, y, Math.atan2(-fall * (air / 2 - since), whale.way * 1.1), 3.8 * k * whale.way, surface + 0.3 * k, 0, 0, 0]
        // At the top of its leap it spouts.
        if (!whale.spouted && since > air * 0.42) {
          whale.spouted = true
          for (let i = 0; i < 5; i++) {
            add({ x: x + whale.way * 0.8 * k, y: y - 1.2 * k, vx: (i - 2) * 45, vy: -230 - 90 * random(), pull: 700, life: 1, fade: 1 / (0.55 * 0.9), kind: 6, seed: 0.2 + 0.5 * random() })
          }
        }
        // If the sun's maw is open while it is in the air, the sun has it.
        if (!whale.eaten && sun && maw > 0.5 && since > 0.45 && since < air - 0.45) Object.assign(whale, { eaten: time, from: whaleNow.slice(0, 4) })
        if (whale.eaten) {
          const gone = clamp01((time - whale.eaten) / 0.6)
          const pull = gone * gone * (3 - 2 * gone)
          const mouth = [sun[0], sun[1] + 0.2 * sun[2]]
          whaleNow = [
            whale.from[0] + (mouth[0] - whale.from[0]) * pull,
            whale.from[1] + (mouth[1] - whale.from[1]) * pull,
            whale.from[2] + 7 * pull * whale.way,
            whale.from[3] * (1 - 0.9 * pull),
            1e6, 0, 0, 0,
          ]
          if (gone >= 1) {
            whale = null
            whaleNow = [0, 0, 0, 0, 0, 0, 0, 0]
            roarUntil = Math.min(roarUntil, time + 0.15) // it shuts its mouth on it
            gladAt = time
            shake = Math.max(shake, 0.6)
            burst(mouth[0], mouth[1], 9, 1, 190)
            say('taken', mouth[0], mouth[1] - 40)
            events.push({ kind: 'gulp', x: 0 })
          }
        }
        if (whale && !whale.told) {
          whale.told = true
          say('breach', x, y - 2.2 * k)
          shake = Math.max(shake, 0.35)
        }
        if (whale && !whale.eaten && !whale.back && since > air - 0.25) {
          whale.back = true
          shake = Math.max(shake, 0.55)
          stomps[trodden++ % 12] = [whale.x + whale.way * 1.1 * air, whale.z, time, -2.1]
          const [sx, sy] = onHero(whale.x + whale.way * 1.1 * air, whale.level, whale.z)
          for (let i = 0; i < 8; i++) {
            add({ x: sx + (i - 3.5) * 14, y: sy - 6, vx: (i - 3.5) * 80, vy: -300 - 200 * random(), pull: 900, life: 1, fade: 1 / (0.55 * 1.1), kind: 6, seed: 0.4 + 0.6 * random() })
          }
          events.push({ kind: 'splash', x: Math.max(-1, Math.min(1, (sx - view.cx) / 700)) })
        }
        if (whale && !whale.eaten && since > air + 0.3) whale = null
      }

      // While the sun roars it draws walkers up out of the valley and down its throat.
      if (sun && view && maw > 0.5 && time < roarUntil - 1.7 && time > nextDrawn && drawn.length < 4) {
        const [width] = size
        const near = minis
          .filter((m) => {
            const [x] = onHero(m.x, world.ground(m.x, m.z), m.z)
            return m.dead < 0.05 && !m.gone && !(lift && lift.m === m) && m.z - view.z > 12 && m.z - view.z < 60 && x > 30 && x < width - 30
          })
          .sort((a, b) => a.z - b.z)[0]
        nextDrawn = time + 0.22 + 0.2 * random()
        if (near) {
          const [x, y, k] = onHero(near.x, world.ground(near.x, near.z), near.z)
          const mote = { x, y: y - 0.6 * k, vx: 0, vy: 0, held: true, life: 0.2, fade: 0, kind: 7, seed: near.seed }
          if (add(mote)) {
            near.gone = time + 6 + 3 * random()
            drawn.push({ mote, at: time, left: [x, y - 0.6 * k], side: random() < 0.5 ? -1 : 1 })
          }
        }
      }
      for (let i = drawn.length - 1; i >= 0; i--) {
        const taken = drawn[i]
        const since = time - taken.at
        // It is plucked up, hangs kicking, then goes round and in, faster and faster.
        const rise = clamp01(since / 0.45)
        const up = rise * rise * (3 - 2 * rise)
        const go = clamp01((since - 0.3) / 1.15)
        const e = go * go * go
        if (go > 0.3 && !taken.cried) {
          taken.cried = true
          events.push({ kind: 'scream', x: Math.max(-1, Math.min(1, (taken.mote.x - view.cx) / 700)) })
        }
        const mouth = [sun[0], sun[1] + 0.2 * sun[2]]
        const dx = taken.left[0] - mouth[0]
        const dy = taken.left[1] - 40 * up - mouth[1]
        const round = taken.side * 2.6 * go * (1 - e)
        const [c, n] = [Math.cos(round), Math.sin(round)]
        Object.assign(taken.mote, { x: mouth[0] + (dx * c - dy * n) * (1 - e), y: mouth[1] + (dx * n + dy * c) * (1 - e), life: Math.max(0.03, 0.2 + 0.6 * up - 0.8 * e * e) })
        if (!motes.includes(taken.mote)) add(taken.mote)
        if (go >= 1) {
          const at = motes.indexOf(taken.mote)
          if (at >= 0) motes.splice(at, 1)
          drawn.splice(i, 1)
          burst(mouth[0], mouth[1], 3, 1, 150)
          remains(mouth[0], mouth[1] + 0.12 * sun[2], 2)
          events.push({ kind: 'gulp', x: 0 })
        }
      }

      // Now and then the planet takes a walker up in its beam.
      if (time > nextLift) {
        nextLift = time + 30 + 22 * random()
        // If the visitor's pointer has sat still a while, it may be that instead.
        if (!(hand.at && time - hand.still > 2.5 && random() < 0.5 && this.abductPointer(time))) this.abduct(time)
      }
      if (!pointer || !hand.at || Math.hypot(pointer[0] - hand.at[0], pointer[1] - hand.at[1]) > 3) hand.still = time
      hand.at = pointer
      if (hand.state === 1 && hand.until && time > hand.until) {
        Object.assign(hand, { state: 2, until: time + 28, form: 1 + Math.floor(random() * 3) })
        if (pointer) burst(pointer[0], pointer[1], 8, 1, 170)
        events.push({ kind: 'taken', x: 0 })
      } else if (hand.state === 2 && time > hand.until) {
        Object.assign(hand, { state: 0, until: 0 })
        if (pointer) burst(pointer[0], pointer[1], 5, 1, 120)
      }
      let lifting = [0, 0, 0, 0]
      if (lift) {
        const since = time - lift.at
        if (!lift.taken && !lift.pointer) Object.assign(lift, { x: lift.m.x, z: lift.m.z })
        if (!lift.taken && lift.pointer && pointer) lift.spot = [...pointer]
        const [x, y, k] = lift.pointer ? [lift.spot[0], lift.spot[1] + 13, 22] : onHero(lift.x, world.ground(lift.x, lift.z), lift.z)
        const mouth = [planet[0] + planet[2] * watch[0], planet[1] + 3 * Math.sin(time * 0.45) - planet[2] * watch[1]]
        if (!lift.taken && since > 0.45) {
          lift.taken = true
          lift.m.gone = time + 4
          lift.mote = { x, y: y - 0.6 * k, vx: 0, vy: 0, held: true, life: 0.25, fade: 0, kind: lift.pointer ? 9 : 7, seed: lift.m.seed }
          if (lift.pointer) Object.assign(hand, { state: 1, until: 0 })
          lift.left = [x, y - 0.6 * k]
          add(lift.mote)
        }
        if (lift.taken && !lift.landed) {
          // It hangs a moment just off the ground, struggling, then goes up all at once.
          const hang = clamp01((since - 0.45) / 0.8)
          const eased = hang * hang * (3 - 2 * hang)
          const go = clamp01((since - 1.25) / 0.95)
          const e = go * go * go
          if (go > 0.05 && !lift.cried && !lift.pointer) {
            lift.cried = true
            events.push({ kind: 'scream', x: Math.max(-1, Math.min(1, (lift.left[0] - view.cx) / 700)) })
          }
          const hx = lift.left[0] + 5 * Math.sin(time * 15) * eased * (1 - go)
          const hy = lift.left[1] - 46 * eased
          Object.assign(lift.mote, { x: hx + (mouth[0] - hx) * e, y: hy + (mouth[1] - hy) * e, life: 0.25 + 0.75 * eased - 0.62 * e })
          if (!motes.includes(lift.mote)) add(lift.mote)
          if (go >= 1) {
            // The planet has it: it swallows, swells, and winks.
            lift.landed = time
            if (lift.pointer) hand.until = time + 1.2
            const at = motes.indexOf(lift.mote)
            if (at >= 0) motes.splice(at, 1)
            winkAt = time + 0.25
            gulpAt = time
            shake = Math.max(shake, 0.3)
            burst(mouth[0], mouth[1], 10, 1, 210)
            say('taken', planet[0] + 1.6 * planet[2], planet[1] + planet[2])
          }
        }
        // The beam comes on with a flicker, and when it is done it is drawn back up into the planet.
        const on = since < 0.07 || (since > 0.14 && since < 0.2) ? 0.7 : since < 0.28 ? 0 : clamp01((since - 0.28) / 0.15)
        const back = lift.landed ? clamp01((time - lift.landed) / 0.4) : 0
        const foot = [x + (mouth[0] - x) * back * back, y - 0.2 * k + (mouth[1] - y + 0.2 * k) * back * back]
        lifting = [foot[0], foot[1], on * (1 - back), since]
        if (back >= 1) lift = null
      }

      // The audit.
      const officers = audit ? inspect(time, dt, sun, sinking) : null
      if (audit?.beam && !lift) lifting = audit.beam

      // Fish leap from the river.
      if (time > nextLeap) {
        nextLeap = time + 2.5 + 5 * random()
        const z = view.z + 17 + 26 * random()
        const [x, y, k] = onHero(world.river(z) + (random() - 0.5) * 1.6, level, z)
        const way = random() < 0.5 ? -1 : 1
        add({ x, y, vx: way * k, vy: -5.3 * k, pull: 11.8 * k, life: 1, fade: 1 / (0.55 * 0.9), kind: 4, seed: (Math.min(97, Math.floor(k)) + (way > 0 ? 0.5 : 0)) / 100 })
        events.push({ kind: 'leap', x: Math.max(-1, Math.min(1, (x - view.cx) / 700)) })
      }

      const sinceBolt = time - bolt.at
      const struck = onHero(bolt.x, world.ground(bolt.x, bolt.z), bolt.z)
      if (sinceBolt >= 0.14 && !bolt.landed) {
        bolt.landed = true
        if(sinceBolt<1){
          kindle(bolt.x,bolt.z,time,0.52,0,true)
          if(byDesk(struck[0],struck[1],0.30)) scorchDesk(time,0.53)
        }
        if (sinceBolt < 1) for (const site of sites) {
          if (site.built > 0 && !site.falling && Math.hypot(site.x-bolt.x,site.z-bolt.z)<3.2) {
            lightHouse(site,time)
          }
        }
        burst(struck[0], struck[1], 9, 0, 200)
      }
      for (let i = motes.length - 1; i >= 0; i--) {
        const mote = motes[i]
        if (mote.wait > 0) {
          mote.wait -= dt
          continue
        }
        if (mote.held) continue
        if (mote.kind === 5) {
          const k = 1 - mote.life
          const e = k * k * (3 - 2 * k)
          mote.x = mote.fx + (mote.tx - mote.fx) * e
          mote.y = mote.fy + (mote.ty - mote.fy) * e - 70 * Math.sin(Math.PI * e)
        }
        if (mote.pull) mote.vy += mote.pull * dt
        if (mote.kind < 3) {
          mote.vy += (mote.kind ? 160 : 420) * dt
          mote.vx *= 1 - Math.min(1, dt * (mote.kind ? 1.8 : 0.6))
          if (mote.kind) mote.vy *= 1 - Math.min(1, dt * 1.8)
        }
        mote.x += mote.vx * dt
        mote.y += mote.vy * dt
        mote.life -= dt * mote.fade * (mote.kind ? 0.55 : 1.3)
        if (mote.life <= 0) motes.splice(i, 1)
      }

      // The face. Angry when it fires or roars, stricken when it weeps, glad
      // when something is built, startled by lightning, drowsy as the moon;
      // and now and then its eyes roll back and light up.
      if (time > trance.until) {
        const from = time + 16 + 20 * random()
        trance = { from, until: from + 5 + 3 * random() }
      }
      const rapt = time > trance.from && time < trance.until && !firing && sinking === 0
      // Its flames whirl while it roars, fires, weeps or is entranced: the two rings
      // opposite ways and at different rates, running down afterwards.
      const wild = Math.max(maw, 0.5 * beam.power, rapt ? 0.45 : 0, time >= unfoldAt && time < unfoldAt + unfoldDuration ? 0.8 : 0, tears > 0.3 ? 0.25 : 0)
      whirling += (wild - whirling) * Math.min(1, dt * (wild > whirling ? 2.2 : 0.7))
      if (whirling < 0.002 && wild === 0) whirling = 0
      whirl[0] = (whirl[0] + dt * 2.3 * whirling * (1 + 0.35 * Math.sin(time * 0.9))) % (Math.PI * 2)
      whirl[1] = (whirl[1] - dt * 1.3 * whirling * (1 + 0.35 * Math.sin(time * 0.6 + 2))) % (Math.PI * 2)
      // The sun speaks. A word on what has just happened: the lasers coming on, the
      // takeover over, the fold, a roar coming (and after one that swallowed someone).
      if (saying && mouthBusy(time) && saying.cut === Infinity) {
        saying.cut = time
        events.push({ kind: 'hush', x: 0 })
      }
      if (saying && (time - saying.at > saying.length || time - saying.cut > 0.15)) saying = null
      if (beam.power > 0.05 && !wasLasing) speak(time, 'beam', 1 / 6)
      wasLasing = beam.power > 0.05
      if (hostedBefore && !hosting(time) && bossSpan > 1) speak(time, voiceRandom() < 0.4 ? 'wild' : 'host', 1)
      hostedBefore = hosting(time)
      if (time >= foldAt + foldDuration && foldSpoken !== foldAt) {
        foldSpoken = foldAt
        speak(time, 'wild', 1 / 2)
      }
      if (roarWarned !== nextRoar && time > nextRoar - 1.7 && sinking === 0) {
        roarWarned = nextRoar
        speak(time, 'come')
      }
      if (events.some((e) => e.kind === 'gulp')) swallowedAt = time
      if (swallowedAt > thankedFor && time > roarUntil && maw < 0.02) {
        thankedFor = swallowedAt
        speak(time, voiceRandom() < 0.35 ? 'wild' : 'thanks', 1 / 2)
      }
      // A catchphrase now and then, when nothing else is on.
      if (time >= nextSaying) {
        if (saying || time - lineAt < 9 || !offstage(time) || hosting(time) || mouthBusy(time) || beam.power > 0.02 || !sun) nextSaying = time + 1
        else {
          const line = catchLines[catchCount++ % catchLines.length]
          if (utterance(time, line)) stage(time, saying.length)
          nextSaying = time + 35 + 20 * voiceRandom()
        }
      }
      // The mouth reads the same timeline as the voice, easing in from the smile and back to it.
      let talking = 0
      if (saying) {
        mouthAt(saying.line, time - saying.at, mouthNow)
        talking = mouthNow[5] * (saying.cut < Infinity ? 1 - smooth(saying.cut, saying.cut + 0.12, time) : 1)
      }
      const into = saying ? time - saying.at : 0
      const blinkAt = saying ? 0.42 * saying.length : 0
      const talk = [mouthNow[0], mouthNow[1], mouthNow[2], mouthNow[3]]
      const talkFace = [mouthNow[4] * talking, saying ? 1 - smooth(0, 0.08, Math.abs(into - blinkAt)) : 0, talking, 0]
      // It leans toward the terminal while it speaks, and nods on the stressed words.
      const nod = sun && stands && talking > 0
        ? [Math.max(-1, Math.min(1, (stands[0] - sun[0]) / (width * 0.5))) * 0.2 * talking, (-0.05 + 0.05 * mouthNow[4]) * talking]
        : [0, 0]

      const glad = time - gladAt < 3
      const startled = (sinceBolt > 0.12 && sinceBolt < 1.5) || time - startledAt < 1.2
      const wants = {
        brow: firing || maw > 0.15 ? 1 : tears > 0.3 ? -1 : startled ? -0.4 : 0,
        lids: rapt || startled ? -0.8 : firing || maw > 0.15 ? -0.5 : tears > 0.3 ? 0.4 : glad ? 0.3 : orb.moon ? 0.42 : 0,
        smile: tears > 0.3 ? -1 : firing ? -0.4 : glad ? 1 : startled ? -0.2 : orb.moon ? 0.15 : 0.3,
        gasp: Math.max(startled ? 1 : rapt ? 0.6 : 0, song), // it sings along
        roll: rapt ? 1 : 0,
        glow: rapt ? 1 : 0,
        dilate: startled || rapt ? 1 : firing ? -0.6 : 0,
      }
      if (singing > 0.05) {
        wants.gasp = Math.max(wants.gasp, chorusMouth)
        wants.smile = Math.max(wants.smile, 0.6 * singing)
        wants.lids = Math.min(wants.lids, 0.25)
      }
      // It does not care for the notice, and shows it.
      if (glare > 0) {
        wants.brow = Math.max(wants.brow, 0.85 * glare)
        wants.lids = Math.max(wants.lids, 0.3 * glare)
        wants.smile = Math.min(wants.smile, 0.3 - 0.8 * glare)
      }
      for (const key of Object.keys(mien)) {
        const stiff = key === 'roll' || key === 'glow' ? 4.5 : 9
        for (let left = dt; left > 0; left -= 1 / 120) {
          const h = Math.min(left, 1 / 120)
          mienSpeed[key] += (stiff * stiff * (wants[key] - mien[key]) - 2 * stiff * mienSpeed[key]) * h
          mien[key] += mienSpeed[key] * h
        }
      }
      hue = (hue + dt * (0.05 + 0.25 * mien.glow)) % 1
      const writing = script.at(-1)
      if (writing.hold > 0) writing.hold -= dt
      else writing.typed = Math.min(writing.length, writing.typed + dt * (writing.mine ? 40 : 9))
      const scroll = 1 - smooth(0, 0.4, time - scrolled)
      wink += ((time - winkAt < 0.45 ? 1 : 0) - wink) * Math.min(1, dt * 14)

      // The mood: the light warms toward sunset and when the maw gapes, and goes rosy for a while after sunrise.
      const evening = orb.moon ? 0 : age >= 10 ? smooth(orb.next - 9, orb.next, time) : orb.toNight ? 1 : 0 // and stays warm until the sun is down
      const morning = !orb.moon && age >= WHEEL / 2 ? 1 - smooth(WHEEL, 20, age) : 0
      const joy = Math.max(0, 1 - (time - gladAt) / 1.6)
      const spell = Math.max(0, 1 - (time - castAt) / 1.2)
      // It goes a sick green while the planet's beam is on, and sea blue while a whale is in the air.
      if (planet) {
        const [cx, y, r] = planet
        const cy = y + 3 * Math.sin(time * 0.45)
        // It notices a quarry before the beam has finished flickering on.
        const age = lifting[3]
        const take = smooth(0, 0.23, age) * (1 - smooth(0.45, 0.63, age) * (1 - lifting[2]))
        watchToward(3, take, 17, dt)
        const bite = watch[3]
        let gx = 0.11 + 0.19 * Math.sin(time * 0.49), gy = 0.06 + 0.085 * Math.sin(time * 0.61 + 1.4)
        let near = 0
        if (pointer) {
          const dx = pointer[0] - cx, dy = cy - pointer[1]
          const g = 0.48 / Math.hypot(1.6 * r, dx, dy)
          gx = g * dx; gy = g * dy
          near = 1 - smooth(0.9 * r, 4.5 * r, Math.hypot(dx, dy))
        }
        if (age > 0) {
          const dx = lifting[0] - cx, dy = cy - lifting[1]
          const g = 0.47 / Math.hypot(r * 0.6, dx, dy)
          gx += (dx * g - gx) * bite; gy += (dy * g - gy) * bite
        }
        watchToward(0, gx, 15, dt); watchToward(1, gy, 15, dt)
        const rest = 0.264 + 0.022 * Math.sin(1.14 * time) + 0.040 * night + 0.036 * near
        const dazzle = smooth(0.05, 0.91, Math.max(beam.power, maw))
        const litPupil = rest + (0.084 - rest) * dazzle
        watchToward(2, litPupil + (0.415 - litPupil) * bite, dazzle > 0.3 ? 16 : 8.5, dt)
      }
      const eerie = lifting[2]
      const sea = whale ? Math.sin(Math.PI * clamp01((time - whale.at) / 2.7)) : 0
      const mood = [
        1 + 0.07 * evening + 0.1 * maw + 0.05 * morning + 0.1 * joy + 0.06 * spell - 0.16 * eerie - 0.1 * sea,
        1 - 0.05 * evening - 0.1 * maw - 0.04 * morning + 0.06 * joy - 0.05 * spell + 0.05 * eerie + 0.02 * sea,
        1 - 0.14 * evening - 0.14 * maw + 0.03 * morning - 0.06 * joy + 0.12 * spell - 0.08 * eerie + 0.1 * sea,
      ]
      for (let i = 0; i < 3; i++) grade[i] += (mood[i] - grade[i]) * Math.min(1, dt * (joy + spell + eerie + sea > 0 ? 9 : 2))
      const done = pulse && onHero(pulse.x, world.ground(pulse.x, pulse.z) + 1.5, pulse.z)
      const spoken = !done && machine && time - castAt < 2.5 ? [machine[0], machine[1] + 30, time - castAt, 20] : null

      prod[2] = Math.max(0, prod[2] - dt * 3.2)
      const bossing=time-bossAt, teaser=bossSpan<1
      let bossNow, bossRig, comets
      if (sun && bossing>=0 && bossing<bossSpan) {
        const slip=teaser?0.23:BOSS.slip
        const here=clamp01(Math.min(bossing,bossSpan-bossing)/slip)
        bossNow=[here,teaser?0:1,1-here,bossSeed]
        const gaze=pointer?Math.max(-1,Math.min(1,(pointer[0]-sun[0])/(width*0.35))):0
        bossGaze+=(gaze-bossGaze)*(1-Math.exp(-dt*5))
        const yaw=-0.61*Math.sin(bossing*1.47)+0.23*bossGaze
        const pitch=0.13*Math.sin(bossing*1.8+0.45)
        const bob=0.09+0.047*Math.sin(bossing*2.8)
        let jaw=0
        if (!teaser) {
          comets=new Float32Array(16)
          for(let i=0;i<4;i++){
            const age=bossing-(0.86+i*2.13), side=i%2===0?-1:1
            jaw=Math.max(jaw,smooth(-0.23,0.06,age)*(1-smooth(0.08,0.48,age)))
            if(age<0 || age>=3.03)continue
            const small=width<height
            const index=(bossSequence===0 ? [0,1,2,3][i] : (bossSeed+i*5)%12)
            const ix=(i%2)*8, span=small?0.49:0.225
            const clampX=(v,pad)=>Math.min(width-pad,Math.max(pad,v))
            const pageWidth=Math.min(width*span,326)
            const landX=width*(side<0?(small?0.18:0.15)+0.075*(i>>1):(small?0.82:0.9)-0.08*(i>>1))
            const landY=height-(small?100:66)-18*(i%3)
            if(age>=2.25){
              const hit=(age-2.25)/0.78
              comets.set([landX,landY,1,index,0,0,0,Math.max(0.0001,hit)],ix)
              if(bossImpact<=i){bossImpact=i+1;events.push({kind:'strike',x:landX/width*2-1})}
              continue
            }
            if(!bossLaunch[i]){
              // Project the top lip with the puppet's current yaw, pitch and bob.
              const pz=0.82*Math.cos(yaw), py=-0.49*Math.cos(pitch)-pz*Math.sin(pitch)
              bossLaunch[i]=[sun[0]+sun[2]*0.82*Math.sin(yaw),sun[1]-sun[2]*(bob+py)]
              events.push({kind:'burn',x:side*0.42})
            }
            const [mx,my]=bossLaunch[i]
            const open=smooth(0,0.44,age), drift=smooth(0.18,1.76,age), fall=smooth(1.65,2.25,age)
            const restX=clampX(sun[0]+side*sun[2]*(small?1.9:2.8),pageWidth*.53+width*.03)
            const restY=sun[1]+sun[2]*(small?2.03:0.29)
            const x=mx+(restX-mx)*open+side*width*0.028*drift
            const y=my+(restY-my)*open+19*drift
            const widthNow=pageWidth*open*(1-fall)*(1+0.025*drift)
            comets.set([x+(landX-x)*fall,y+(landY-y)*fall,widthNow,index,side*(1-0.72*fall),(small?0.67:0.14)+1.15*fall,side*(0.061+0.41*fall),0],ix)
          }
        }
        bossRig=[yaw,pitch,jaw,bossing]
        const cues=teaser?[0,0.38]:[0,0.27,bossSpan-slip,bossSpan-0.23]
        for(;bossCue<cues.length && bossing>=cues[bossCue];bossCue++)events.push({kind:'key',x:0})
      }
      lens.set([ring.x, ring.y, time - ring.at, time - ring.at < 0.7 ? 1 : 0], 28)
      // What the planet sees: it spreads out of the planet for a second and a half, and draws back in over the last two.
      const staring = time - stareAt
      if (planet && staring >= 0 && staring < stareDuration) {
        const ease = (n) => n * n * n * (n * (n * 6 - 15) + 10)
        const k = ease(clamp01(staring / 1.5)) * (1 - ease(clamp01((staring - stareDuration + 2) / 2)))
        lens.set([k, staring, planet[0] < 0 ? width + planet[0] : planet[0], (planet[1] < 0 ? height + planet[1] : planet[1]) + 3 * Math.sin(time * 0.45)], 32)
      } else if (lens[32]) lens.fill(0, 32, 36)
      last = {
        view,
        churn: prod[2] > shot[2] ? [...prod] : shot,
        world: [view.x, view.z, level, focal],
        orb: [orb.moon ? 1 : 0, wheel, night, view.cx],
        drop,
        sites: sites.map((site) => [site.x, site.z, site.built * smooth(7,15,site.z-view.z) + site.wire * smooth(15,16,site.z-view.z), site.family + site.seed*0.99999]),
        critters: minis.map((m) => [[m.x, m.z, m.heading, m.phase], [m.dead, m.seed, m.stride, m.dip]]),
        blooms: blooms
          .map((b) => {
            const [x, y, k] = onHero(b.x, world.ground(b.x, b.z), b.z)
            return [[x, y, b.born, b.burnt], [b.size * k, b.seed], b.z]
          })
          .sort((a, b) => b[2] - a[2]),
        beam: [beam.x, beam.y, beam.power],
        shot,
        maw,
        talk,
        talkFace,
        nod,
        quake: Math.max(maw * maw * 0.8, cry.blood ? tears * 0.12 : 0, shake * shake * 0.9),
        hop,
        slam,
        firing,
        weather: [rain, sinceBolt < 2 ? sinceBolt : 99, struck[0], bolt.seed],
        bolt: [bolt.top, struck[1]],
        sky: [rainbow, cry.blood ? tears : 0],
        tears: [tears, cry.blood ? 1 : 0],
        pulse: done ? [done[0], done[1], time - pulse.doneAt, done[2]] : spoken ?? [0, 0, 99, 0],
        night,
        wet,
        stomps,
        snake: serpent(time, dt, pointer), viperPose, viperRig,
        officers,
        whale: Object.assign(whaleNow, { 5: Math.max(0, hurry), 6: shake * shake }),
        lifting,
        unmask: time > maskAt && time < maskAt + maskDuration ? (time - maskAt) / maskDuration : 0,
        boss: bossNow,
        bossRig, comets,
        cursor: hand.state === 2 ? 1 + hand.form : hand.state,
        lens,
        dive: lens[16] > 1 ? 2 - lens[16] : lens[16],
        unfold: time >= unfoldAt && time < unfoldAt + unfoldDuration ? (time - unfoldAt) / unfoldDuration : 0,
        swell: time - gulpAt < 1.4 ? 0.34 * Math.exp(-(time - gulpAt) * 4.2) * Math.sin((time - gulpAt) * 17) : 0,
        fires: [...brush,...chimneys].sort((a,b)=>b.fz-a.fz), fireWindows,
        fireDesk:[damage,time-contactAt,smooth(2.2,3.3,time-contactAt)*smooth(0.002,0.16,damage)],
        scorches,
        travel: time + ahead,
        grade,
        motes: motes.map((mote) => [mote.x, mote.y, mote.wait > 0 ? 0 : mote.life, mote.kind + mote.seed]),
        moon: orb.moon,
        wink,
        watch,
        script: script.map((line) => [line.seed, line.length, line.typed, line.sign]),
        scriptInfo: [script.length === 5 ? scroll : 0, script.length],
        face: [mien.brow, mien.lids, mien.smile, mien.gasp],
        whirl,
        eyes: [mien.roll, mien.glow, hue, mien.dilate],
        events,
      }
      last.notice = noticeNow
      Object.assign(last, {
        cosmos: [space, Math.max(0, sinceCosmos), 0, singing],
        chorus: [chorusBeats, chorusMouth, chorusSwell, 0],
        stars: starInk,
        swell: last.swell + 0.06 * chorusMouth, // the planet too
      })
      events = []
      return last
    },
    get now() {
      return last
    },
  }
}

// The hero's size in design units for a canvas of this shape. Wide, the
// design is at least layout.width by layout.height; narrow, it is layout.width across.
export function designSize(layout, width, height) {
  const unit = layout.height ? Math.min(width / layout.width, height / layout.height) : width / layout.width
  return [width / unit, height / unit]
}

// How the terminal walks. The land streams toward the eye under it, so it
// backs away up the valley to stay where it is in the picture: its feet plant
// and ride the ground, then swing. Returns the gait's phase, the stride as a
// step in the terminal's own ground plane, and how far the body rides up.
// Where on the hero the pair of boots that has just come down is.
export function footfalls(layout, scene, cam, gait, all = false) {
  const size = scene[2] * layout.machine.size
  const at = [scene[0] + scene[2] * layout.machine.at[0], scene[1] + scene[3] * layout.machine.at[1]]
  return (all ? [0, 1, 4, 5] : Math.floor(gait.phase * 2) % 2 ? [0, 4] : [1, 5]).map((i) => {
    const row = Math.floor(i / 2) - 1
    const foot = [(i % 2 ? -1 : 1) * 1.36 * 0.9 + gait.stride[0] * 0.5, -0.42, row * 0.69 + gait.stride[1] * 0.5]
    const rel = foot.map((n, axis) => n - MACHINE.target[axis])
    const along = (axis) => rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2]
    return [at[0] + size * along(cam.right), at[1] - size * along(cam.up), 0.24 * size]
  })
}

export function gaitAt(layout, scene, cam, view, time) {
  const size = scene[2] * layout.machine.size // design units per unit of the terminal
  const x = scene[0] + scene[2] * layout.machine.at[0]
  const rise = view.height - (scene[1] + scene[3] * layout.machine.at[1]) - 0.87 * size
  const away = (world.eye * view.focal) / Math.max(world.horizon - rise, 60)
  // How fast the ground under it crosses the hero, to the right and downward.
  const flow = [((x - view.cx) * world.speed) / away, (world.eye * view.focal * world.speed) / (away * away)]
  const steady = orbit(layout.machine.yaw, layout.machine.pitch)
  const along = (c) => {
    const flat = Math.hypot(c.back[0], c.back[2])
    const right = flow[0] / size
    const toward = flow[1] / (size * Math.max(c.back[1], 0.15))
    return [c.right[0] * right + (c.back[0] / flat) * toward, c.right[2] * right + (c.back[2] / flat) * toward]
  }
  const pace = Math.hypot(...along(steady))
  const ground = along(cam)
  const speed = Math.hypot(...ground) || 1
  const stride = 0.55
  const phase = (time * pace * 0.62) / stride
  return { phase, stride: [(-ground[0] / speed) * stride, (-ground[1] / speed) * stride], lift: 0.034 * Math.sin(phase * Math.PI * 4) }
}

// The entrance, age seconds in: how far the sun still has to rise and how far
// its light has spread, in design units. design is the hero's [width, height].
export function dawnAt(age, design, sun) {
  if (age > 6.2) return [0, 1e9]
  const up = 1 - Math.pow(1 - Math.max(0, Math.min(1, age / 2.6)), 3)
  const spread = Math.max(0, Math.min(1, (age - 1.5) / 4.5))
  const eased = spread * spread * (3 - 2 * spread)
  return [(1 - up) * (design[1] - 110 - sun[1] + sun[2] * 3.1), sun[2] * 2.7 + eased * (Math.hypot(design[0], design[1]) + 200)]
}

// The sun's middle and face radius in design units, given the .scene box.
export const sunAt = (layout, [x, y, w, h]) => [x + w * layout.sun[0], y + h * layout.sun[1], w * layout.sun[2]]

// Everything on the GPU: the fluid's textures and passes, and the final picture.
// The page and tools/frame.mjs both drive this.
// A little puppet theatre rendered into a transparent plate. Its rings follow the
// photographed skull down to the beard, in the source portrait's pixel coordinates.
// The nose projects out of the front hemisphere; the ears have their own volume.
const bossMesh = () => {
  const rings = [ // y, left/right, depth, fore/aft shift
    [12,266,280,9,-4],[19,244,303,36,-5],[36,216,327,65,-5],
    [57,199,346,84,-5],[82,186,357,95,-4],[103,182,362,102,-2],
    [123,181,364,102,0],[142,183,364,100,0],[160,186,364,94,0],
    [174,189,363,92,0],[192,193,362,88,2],[207,196,358,84,5],
    [207,196,358,84,5],[225,200,354,78,8],[248,206,346,67,10],
    [268,216,334,56,14],[286,235,315,40,18],[299,256,294,20,20],[302,273,282,5,20],
  ]
  const verts = [], N = 22
  const ringPoint = (i,j) => {
    const [y,l,r,depth,z0]=rings[i], a = (j + (i < 12 ? i%2 : (i-1)%2)*0.27) * Math.PI*2/N
    const cs=Math.cos(a), x=(r+l)/2+Math.sin(a)*(r-l)/2
    const bump=(cx,cy,w,h)=>Math.exp(-(((x-cx)/w)**2+((y-cy)/h)**2))
    const relief = 31*bump(278,159,17,17)+16*bump(278,133,13,33)-9*(bump(235,123,20,12)+bump(322,123,20,12))+7*(bump(221,154,23,18)+bump(333,151,22,18))
    const z=z0+depth*cs+(cs>0?relief*cs:0)
    const jaw=i>=12?Math.max(0,Math.min(1,(cs+.1)*2.4)):0
    return [x,y,z,jaw,(r+l)/2+(x-(r+l)/2)*0.972,y,cs]
  }
  const tri=(a,b,c,kind=0)=>{
    let u=(a[4]+b[4]+c[4])/3, v=(a[5]+b[5]+c[5])/3
    for(const q of [a,b,c])verts.push((q[0]-274)/108,(156-q[1])/108,q[2]/108,q[3],(q[4]-158)/232,q[5]/314,(u-158)/232,v/314,kind===1?-10:q[6])
  }
  for(let i=0;i<rings.length-1;i++)for(let j=0;j<N;j++){
    const a=ringPoint(i,j),b=ringPoint(i,j+1),c=ringPoint(i+1,j),d=ringPoint(i+1,j+1)
    const kind=i===11?1:0
    tri(a,b,c,kind);tri(c,b,d,kind)
  }
  for(const i of [0,rings.length-1]){
    const [y,l,r,,z]=rings[i], x=(l+r)/2
    for(let j=0;j<N;j++)tri(ringPoint(i,j),ringPoint(i,j+1),[x,y,z,0,x,y,1])
  }
  for(const dir of [-1,1]) {
    const ear=(i,j)=>{
      const lat=-Math.PI/2+i*Math.PI/6, lon=j*Math.PI/5
      const x=(dir<0?184:362)+13*Math.cos(lat)*Math.sin(lon)+dir*3*Math.sin(lat), y=174-34*Math.sin(lat)
      return [x,y,5+18*Math.cos(lat)*Math.cos(lon),0,x,y,1]
    }
    for(let i=0;i<6;i++) for(let j=0;j<10;j++){
      tri(ear(i,j),ear(i+1,j),ear(i,j+1));tri(ear(i+1,j),ear(i+1,j+1),ear(i,j+1))
    }
  }
  return new Float32Array(verts)
}

export const bossShader = /* wgsl */ `
struct Pose { rig: vec4f }
@group(0) @binding(0) var<uniform> pose: Pose;
@group(0) @binding(1) var portrait: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
struct Facet { @builtin(position) p: vec4f, @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) @interpolate(flat) center: vec2f, @location(3) kind: f32 }
fn rotor(p: vec2f, a: f32) -> vec2f { return vec2f(p.x*cos(a)-p.y*sin(a),p.x*sin(a)+p.y*cos(a)); }
@vertex fn portraitVertex(@location(0) vertex: vec4f, @location(1) tex: vec4f, @location(2) kind: f32) -> Facet {
  var f: Facet;
  let rig=pose.rig;
  let yz=rotor(vertex.yz-vec2f(-0.25,0.04),rig.z*vertex.w*0.49)+vec2f(-0.25,0.04);
  let xz=rotor(vec2f(vertex.x,yz.y),-rig.x);
  let tilted=rotor(vec2f(yz.x,xz.y),rig.y);
  f.pos=vec3f(xz.x,tilted);
  // Subpixel, continuous lo-fi vertex drift, never resnap the entire head.
  let wobble=0.0024*sin(vertex.yx*23.0+rig.w*3.8);
  f.p=vec4f((f.pos.xy+wobble)/1.86,0.5-0.21*f.pos.z,1.0);
  f.uv=tex.xy; f.center=tex.zw; f.kind=kind;
  return f;
}
@fragment fn portraitFragment(f: Facet) -> @location(0) vec4f {
  let normal=normalize(cross(dpdy(f.pos),dpdx(f.pos)));
  let n=select(-normal,normal,normal.z>0.0);
  let light=dot(n,vec3f(-0.57,0.66,0.49));
  let centre=textureSampleLevel(portrait,smp,f.center,0.0).rgb;
  let detail=textureSampleLevel(portrait,smp,f.uv,0.0).rgb;
  // Keep expression and teeth; broad planes pick up the copper/purple inks.
  let features=smoothstep(0.23,0.35,f.uv.y)*(1.0-smoothstep(0.69,0.81,f.uv.y));
  var c=mix(centre,detail,0.20+features*0.64);
  // Carry temple and beard colour around the reverse instead of stretching
  // eyes round the skull or clipping the print at a bright meridian.
  let skin=textureSampleLevel(portrait,smp,vec2f(mix(0.18,0.84,smoothstep(0.27,0.73,f.uv.x)),0.33),0.0).rgb;
  let beard=textureSampleLevel(portrait,smp,vec2f(0.54,0.86),0.0).rgb;
  let side=mix(skin,beard,smoothstep(0.65,0.77,f.uv.y));
  c=mix(side,c,smoothstep(-0.14,0.36,f.kind));
  c=c*(0.74+0.36*light)+vec3f(0.06,0.018,0.08)*(1.0-light);
  c+=vec3f(0.18,0.105,0.02)*smoothstep(0.78,0.96,light)*smoothstep(0.24,0.54,c.r);
  if(f.kind < -2.0){c=mix(vec3f(0.115,0.045,0.103),vec3f(0.34,0.10,0.15),1.0-n.z);}
  return vec4f(c,1.0);
}`

function bossTheatre(device, sampler) {
  const module=device.createShaderModule({code:bossShader}), format='rgba8unorm'
  const pipe=device.createRenderPipeline({layout:'auto', vertex:{module,entryPoint:'portraitVertex',buffers:[{arrayStride:36,attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'},{shaderLocation:2,offset:32,format:'float32'}]}]},fragment:{module,entryPoint:'portraitFragment',targets:[{format}]},depthStencil:{format:'depth16unorm',depthWriteEnabled:true,depthCompare:'less'}})
  const data=bossMesh(), vb=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}), pose=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
  device.queue.writeBuffer(vb,0,data)
  const size=[384,384], texture=device.createTexture({size,format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}), view=texture.createView(), depth=device.createTexture({size,format:'depth16unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT}).createView()
  let bound, group
  return {view, draw(encoder,art,rig){
    if(bound!==art){bound=art; group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:pose}},{binding:1,resource:art.createView()},{binding:2,resource:sampler}]})}
    device.queue.writeBuffer(pose,0,rig)
    const p=encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth,depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'discard'}})
    p.setPipeline(pipe);p.setBindGroup(0,group);p.setVertexBuffer(0,vb);p.draw(data.length/9);p.end()
  }}
}

// options: { rest } is awaited between the big pipelines as they are made (a page lets its frames breathe there);
// { clocked: true } has every frame's GPU time measured where the device can (see timed, below).
export function createLiquid(device, format, options = {}) {
  const stage = GPUShaderStage.FRAGMENT
  const sim = device.createShaderModule({ code: simShader })
  const quietShader=shader.replace('const takeoverLive: bool = true;', 'const takeoverLive: bool = false;')
  const cosmic = (code) => code.replace('const cosmosLive: bool = false;', 'const cosmosLive: bool = true;')
  const simLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: stage, buffer: {} },
      { binding: 1, visibility: stage, texture: {} },
      { binding: 2, visibility: stage, texture: {} },
      { binding: 3, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: stage, sampler: {} },
    ],
  })
  const pictureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 7, visibility: stage, texture: {} },
      { binding: 8, visibility: stage, texture: {} },
      { binding: 9, visibility: stage, texture: {} },
      { binding: 0, visibility: stage, buffer: {} },
      { binding: 1, visibility: stage, texture: {} },
      { binding: 2, visibility: stage, sampler: {} },
      { binding: 3, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: stage, texture: {} },
      { binding: 5, visibility: stage, texture: {} },
      { binding: 6, visibility: stage, texture: {} },
      { binding: 10, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
      { binding: 11, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
      { binding: 12, visibility: stage, texture: { sampleType: 'unfilterable-float' } },
      { binding: 13, visibility: stage, texture: {} },
      { binding: 14, visibility: stage, texture: {} },
      { binding: 15, visibility: stage, texture: {} },
    ],
  })
  const vLayout = device.createBindGroupLayout({entries:[{binding:0,visibility:stage,buffer:{}}]})
  const thingLayout = device.createBindGroupLayout({entries:[{binding:0,visibility:stage,buffer:{}},{binding:2,visibility:stage,sampler:{}},{binding:9,visibility:stage,texture:{}}]})
  const glow = device.createShaderModule({ code: glowShader })
  const glowLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: stage, texture: {} },
      { binding: 1, visibility: stage, sampler: {} },
      { binding: 2, visibility: stage, texture: {} },
      { binding: 3, visibility: stage, buffer: {} },
    ],
  })
  const finishLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: stage, texture: {} },
      { binding: 1, visibility: stage, sampler: {} },
      { binding: 2, visibility: stage, texture: {} },
      { binding: 3, visibility: stage, buffer: {} },
      { binding: 4, visibility: stage, texture: {} },
      { binding: 5, visibility: stage, texture: {} },
      { binding: 6, visibility: stage, texture: {} },
      { binding: 7, visibility: stage, texture: {} },
      { binding: 8, visibility: stage, texture: {} },
      { binding: 9, visibility: stage, texture: {} },
    ],
  })
  const adding = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } }
  // The shaders are big, and making a pipeline of one takes a browser seconds. They are
  // all made off the page's own thread, so nothing freezes while that goes on: first
  // the ones every frame needs (built), then the two that only the snake and the
  // takeover need (whole), which are let in when they are done.
  const pipe = (module, layout, entryPoint, target, blend) =>
    device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint, targets: [{ format: target, blend }] },
    })
  const FLOW = 'rgba16float'
  const DYE = 'rgba32float'
  const passes = {}
  const build = (list) => Promise.all(Object.entries(list).map(async ([name, made]) => (passes[name] = await made)))
  // The terminal's own pass, made from the same module as the picture it goes with.
  const deskPipe = (module) => device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [vLayout] }),
    vertex: { module, entryPoint: 'vertexMain' },
    fragment: { module, entryPoint: 'drawDesk', targets: [{ format: 'rgba32float' }] },
  })
  const walkerPipe = (module) => device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [vLayout] }),
    vertex: { module, entryPoint: 'walkerVertex' },
    fragment: { module, entryPoint: 'drawWalker', targets: [{ format: 'rgba32float' }, { format: 'rg32float' }] },
  })
  const worksPipe = (module) => device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [thingLayout] }),
    vertex: { module, entryPoint: 'walkerVertex' },
    fragment: { module, entryPoint: 'drawWorks', targets: [{ format: 'rgba32float' }, { format: 'rg32float' }] },
  })
  const valleyModule = device.createShaderModule({code:quietShader.replace('const viperActive = true;', 'const viperActive = false;')})
  const built = build({
    moveVelocity: pipe(sim, simLayout, 'moveVelocity', FLOW),
    measure: pipe(sim, simLayout, 'measure', FLOW),
    relax: pipe(sim, simLayout, 'relax', FLOW),
    swirl: pipe(sim, simLayout, 'swirl', FLOW),
    moveDye: pipe(sim, simLayout, 'moveDye', DYE),
    startDye: pipe(sim, simLayout, 'startDye', DYE),
    clearValley: pipe(valleyModule, pictureLayout, 'fragmentMain', FLOW),
    sky: pipe(valleyModule, pictureLayout, 'skyMain', FLOW),
    clouds: device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [pictureLayout] }),
      vertex: { module: valleyModule, entryPoint: 'walkerVertex' },
      fragment: { module: valleyModule, entryPoint: 'cloudMain', targets: [{ format: FLOW }] },
    }),
    sun: pipe(valleyModule, pictureLayout, 'sunMain', FLOW),
    deskQuiet: deskPipe(valleyModule),
    walkerQuiet: walkerPipe(valleyModule),
    worksQuiet: worksPipe(valleyModule),
    bright: pipe(glow, glowLayout, 'bright', FLOW),
    shrink: pipe(glow, glowLayout, 'shrink', FLOW),
    spread: pipe(glow, glowLayout, 'spread', FLOW, adding),
    flares: pipe(glow, glowLayout, 'flares', FLOW),
    paper: pipe(glow, glowLayout, 'paper', 'rgba8unorm'),
    finish: pipe(glow, finishLayout, 'finish', format),
  })
  let vPipe = null
  let snakeIn = false // whether the snake's pipelines are in use yet, and the takeover's
  let bossIn = false
  let cosmosIn = false
  // One at a time, in the order the show wants them, and each shader handed over only when its turn comes: a
  // browser making four of these at once has little left to draw with, and a small one has not the memory.
  const whole = built.then(async () => {
    const rest = options.rest ?? (() => {})
    await rest()
    await build({ picture: pipe(device.createShaderModule({ code: quietShader }), pictureLayout, 'fragmentMain', FLOW) })
    const picture = device.createShaderModule({ code: shader })
    vPipe = await device.createRenderPipelineAsync({
      layout:device.createPipelineLayout({bindGroupLayouts:[vLayout]}),vertex:{module:picture,entryPoint:'vertexMain'},
      fragment:{module:picture,entryPoint:'drawViper',targets:[{format:'rgba8unorm'},{format:'rgba16float'}]},
    })
    await rest()
    await build({ takeover: pipe(picture, pictureLayout, 'fragmentMain', FLOW), deskTakeover: deskPipe(picture), walkerTakeover: walkerPipe(picture), worksTakeover: worksPipe(picture) })
    // The same pictures with the cosmos in them, used only while it (or the chorus) is on.
    await rest()
    const cosmosModule = device.createShaderModule({ code: cosmic(quietShader.replace('const viperActive = true;', 'const viperActive = false;')) })
    await build({ cosmos: pipe(cosmosModule, pictureLayout, 'fragmentMain', FLOW), skyCosmos: pipe(cosmosModule, pictureLayout, 'skyMain', FLOW), deskCosmos: deskPipe(cosmosModule), walkerCosmos: walkerPipe(cosmosModule), worksCosmos: worksPipe(cosmosModule) })
    await rest()
    await build({ cosmosPicture: pipe(device.createShaderModule({ code: cosmic(quietShader) }), pictureLayout, 'fragmentMain', FLOW) })
  })
  whole.catch(() => {})
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const simData = new Float32Array(32)
  const simBuffer = device.createBuffer({ size: simData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const pictureBuffer = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const lensData = new Float32Array(76)
  const lensBuffer = device.createBuffer({ size: lensData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
  const blank = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })

  // How long the GPU took over a frame, where it can say: a stamp before the first pass and one after the last,
  // read back a few frames later and handed to timed(milliseconds, probe).
  const clocked = Boolean(options.clocked) && device.features.has('timestamp-query')
  const stamps = clocked && {
    set: device.createQuerySet({ type: 'timestamp', count: 2 }),
    held: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    dot: device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView(),
    busy: false,
  }
  // The stamps are taken by the frame's own first and last passes (an empty pass put before and after them is not
  // timed with the work between): whichever pass an encoder begins first writes the one, and the pass begun after
  // last() is called writes the other.
  const stamped = (encoder) => {
    const begin = encoder.beginRenderPass.bind(encoder)
    let first = true
    let final = false
    encoder.beginRenderPass = (pass) => {
      const writes = { querySet: stamps.set }
      if (first) writes.beginningOfPassWriteIndex = 0
      if (final) writes.endOfPassWriteIndex = 1
      const mine = first || final
      first = final = false
      return begin(mine ? { ...pass, timestampWrites: writes } : pass)
    }
    return () => (final = true)
  }

  let grid = null
  let title = blank
  let front = blank
  let runes = blank
  const theatre=bossTheatre(device,sampler)
  let art = { notice: blank, page: blank, boss: blank, 'dax-wide':blank, 'dax-narrow':blank, comets:blank, fire:blank }
  // The small plate is shared across both dye bind groups; no allocation per frame.
  const vSurfaces = ['rgba8unorm','rgba16float'].map(format => device.createTexture({size:[1024,448],format,usage}).createView())
  const vGroup = device.createBindGroup({layout:vLayout,entries:[{binding:0,resource:{buffer:pictureBuffer}}]})
  const printViper = (encoder,u) => {
    const x=Math.min(u[3],u[698]), y=Math.min(u[14],u[699]); const k=u[1078]
    if(k<=0 || x<=Math.max(0,u[696]) || y<=Math.max(0,u[697])) return
    const p=encoder.beginRenderPass({colorAttachments:vSurfaces.map(view=>({view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}))})
    p.setScissorRect(0,0,Math.min(1024,Math.ceil((x-u[1076])*k)+1),Math.min(448,Math.ceil((y-u[1077])*k)+1))
    p.setPipeline(vPipe); p.setBindGroup(0,vGroup); p.draw(3); p.end()
  }
  // Keep the big valley shader free of the compositing registers outside the
  // footprint. The scissor rectangles partition the frame; no pixel is drawn twice.
  const paintWithViper = (encoder,group,u,deep=false) => {
    const W=u[0], H=u[1], k=W/u[3]
    const x=Math.max(0,Math.floor(k*u[696])), y=Math.max(0,Math.floor(k*u[697]))
    const x1=Math.min(W,Math.ceil(k*u[698])), y1=Math.min(H,Math.ceil(k*u[699]))
    const p=encoder.beginRenderPass({colorAttachments:[{view:easel.picture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]})
    const rect=(x,y,w,h)=>{if(w>0 && h>0){p.setScissorRect(x,y,w,h);p.draw(3)}}
    p.setBindGroup(0,group); p.setPipeline(deep?passes.cosmos:passes.clearValley)
    rect(0,0,W,y);rect(0,y1,W,H-y1);rect(0,y,x,y1-y);rect(x1,y,W-x1,y1-y)
    p.setPipeline(deep?passes.cosmosPicture:passes.picture); rect(x,y,x1-x,y1-y); p.end()
  }
  // The shader's pose(): six legs' hips, knees and feet into u from index at, for a body shifted by shift and rolled by
  // roll about a line at height pivot.
  const posed = (u, at, phase, stride, hip, reach, floorY, tilt, thigh, shin, lift, curl, shift, roll, pivot) => {
    const cr = Math.cos(roll), sr = Math.sin(roll)
    const outOfBody = ([x, y, z]) => [cr * x - sr * (y - pivot) + shift[0], sr * x + cr * (y - pivot) + pivot + shift[1], z + shift[2]]
    const stepping = Math.min(Math.hypot(...stride) * 4, 1)
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1, row = Math.floor(i / 2) - 1
      const g0 = phase + ((i + Math.floor(i / 2)) % 2 === 0 ? 0.5 : 0), g = g0 - Math.floor(g0)
      const swing = Math.min(Math.max((g - 0.62) / 0.38, 0), 1), glide = swing * swing * (3 - 2 * swing)
      const along = g > 0.62 ? glide - 0.5 : 0.5 - g / 0.62
      const root = outOfBody([side * hip[0], hip[1], row * hip[2]])
      let foot = [side * reach * (1 - 0.1 * Math.abs(row)) + stride[0] * along, 0, row * hip[2] * 2.3 + stride[1] * along]
      foot[1] = floorY + tilt[0] * foot[0] + tilt[1] * foot[2] + lift * stepping * Math.sin(3.14159 * swing)
      const tuck = [root[0] + side * 0.32 * thigh, root[1] + 0.75 * thigh, root[2] + row * 0.1]
      foot = foot.map((n, a) => n + (tuck[a] - n) * curl)
      const span = foot.map((n, a) => n - root[a]), len = Math.hypot(...span), dir = span.map((n) => n / len)
      const d = Math.min(Math.max(len, Math.abs(thigh - shin) + 0.02), thigh + shin - 0.01)
      const a = (thigh * thigh - shin * shin + d * d) / (2 * d)
      const pole = [side * 0.4, 1, 0], onto = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2]
      const off = pole.map((n, k) => n - dir[k] * onto), offLen = Math.hypot(...off), up = off.map((n) => n / offLen)
      const rise = Math.sqrt(Math.max(thigh * thigh - a * a, 0))
      u.set(root, at + 4 * i)
      u.set(root.map((n, k) => n + dir[k] * a + up[k] * rise), at + 4 * (6 + i))
      u.set(root.map((n, k) => n + dir[k] * d), at + 4 * (12 + i))
    }
  }
  // Each little walker's legs for the frame, as mini() posed them: on the slope of the ground (heaved) under it.
  const poseWalkers = (u) => {
    const at = u[2], TAU = 6.283185307, MINI = LAND.mini
    const heave = (x, z) => { // the shader's heaved()
      if (u[595] < 0.5 || Math.hypot(x-u[592], z-u[593]) > u[594]) return 0
      let h = 0
      for (let i = 0; i < 12 && i < u[595]; i++) {
        const o = 544+4*i, age = at-u[o+2], away = Math.hypot(x-u[o], z-u[o+1]), front = age*5.6
        if (Math.abs(away-front) > 5.5 && away > 3.5) continue
        const hard = Math.min(Math.abs(u[o+3])/0.9, 2.4), lasts = hard > 1.25 ? 5.5 : 2.6
        const live = smooth(0, 0.1, age)*(1-smooth(0.65*lasts, lasts, age))
        h += live*hard*(0.5*Math.exp(-age*0.75)*Math.sin((away-front)*2.2)*Math.exp(-(((away-front)/1.9)**2)) - 0.3*Math.exp(-age*3.2)*Math.exp(-away*away/1.4))
      }
      return h
    }
    const ground = (x, z) => world.ground(x, z) + heave(x, z)
    for (let i = 0; i < 8; i++) {
      const [x, z, face, phase] = u.subarray(224 + 4 * i, 228 + 4 * i), [dead, , stride, dip] = u.subarray(256 + 4 * i, 260 + 4 * i)
      const y = ground(x, z) + 2.4 * Math.max(heave(x, z), 0), c = Math.cos(face), s = Math.sin(face), half = 0.5 * MINI
      const tilt = [(ground(x + c * half, z - s * half) - y) / half, (ground(x + s * half, z + c * half) - y) / half]
      const lean = 0.035 * Math.sin(phase * TAU * 2) * stride - 0.14 * dip
      posed(u, 1832 + 72 * i, phase, [0, 0.8 * stride], [0.42, 0.22, 0.26], 0.98, 0, tilt, 0.62, 0.78, 0.3, dead, [0, lean + (-0.12 - lean) * dead, 0], 3 * dead + 0.05 * Math.sin(phase * TAU) * stride, 0.6)
    }
  }
  // The terminal's legs for the frame, as terminal() posed them.
  const poseTerminal = (u) => {
    const phase = u[43]
    posed(u, 1760, phase, [u[328], u[329]], [0.66, 0.09, 0.3], 1.36, -0.42 + u[331], [0, 0], 0.8, 0.96, 0.24, Math.min(Math.max(u[331] * 0.45, 0), 0.4), [0.02 * Math.sin(phase * 6.283185307), u[330], 0], 0, 0)
  }
  // The sun's own picture: a square round it that takes in every point sunMain can find within its reach (13 square
  // face radii, at the most it swells), cut to the sky's rows; while it and the moon change places, all of those rows.
  // The picture is made as big as that and no bigger, and where it lies on the canvas goes in the uniforms (sunStamp).
  let sunPicture = null
  const placeSun = (u) => {
    const W = u[0], H = u[1], k = W / u[3], r = u[22]
    const skyRows = Math.min(H, Math.max(1, Math.ceil((u[14] - u[7]) * k + 0.7) + 2))
    let box = null
    if (r > 0 && u[293] !== 0) box = [0, 0, W, skyRows]
    else if (r > 0) {
      const x = u[20], y = u[21] + u[218], reach = Math.sqrt(13) * r * 1.13 + 2
      const x0 = Math.max(0, Math.floor((x - reach) * k)), y0 = Math.max(0, Math.floor((y - reach) * k))
      const x1 = Math.min(W, Math.ceil((x + reach) * k)), y1 = Math.min(skyRows, Math.ceil((y + reach) * k))
      if (x1 > x0 && y1 > y0) box = [x0, y0, x1 - x0, y1 - y0]
    }
    u.set(box ? [box[0], box[1]] : [0, 0], 2480)
    if (!box) return null
    const [w, h] = [Math.min(W, Math.ceil(box[2] / 64) * 64), Math.min(H, Math.ceil(box[3] / 64) * 64)]
    // (Grown when it must be, and made small again once the wheel has stopped.)
    if (!sunPicture || sunPicture.width < box[2] || sunPicture.height < box[3] || sunPicture.width * sunPicture.height > 1.3 * w * h) {
      sunPicture?.destroy()
      sunPicture = device.createTexture({ size: [w, h], format: 'rgba16float', usage })
      grid.pictureGroups = []
    }
    return box
  }
  // The terminal's own picture: a rectangle round it, grown when it has to be.
  let desk = device.createTexture({ size: [1, 1], format: 'rgba32float', usage })
  const deskRect = (u) => {
    const W=u[0], H=u[1], k=W/u[3], z=u[42]
    if (!(z > 0)) return null
    const wide = u[837] > 0 // (the takeover shifts rows sideways)
    const x = wide ? 0 : Math.max(0, Math.floor((u[40]-2.3*z)*k)-2), x1 = wide ? W : Math.min(W, Math.ceil((u[40]+2.3*z)*k)+2)
    const y = Math.max(0, Math.floor((u[41]-(1.3+u[331])*z)*k)-2), y1 = Math.min(H, Math.ceil((u[41]+1.15*z)*k)+2)
    return x1 > x && y1 > y ? [x, y, x1-x, y1-y] : null
  }
  // The sixteen patches a probe draws of the picture (see draw), as [x, y, width, height] in pixels.
  const probePatches = (W, H) => Array.from({ length: 16 }, (_, i) => [Math.floor(((i % 4) + 0.375) * W / 4), Math.floor(((i >> 2) + 0.375) * H / 4), Math.max(1, Math.floor(W / 16)), Math.max(1, Math.floor(H / 16))])
  // Where a rectangle of the canvas meets a patch, moved by (dx, dy): [x, y, width, height], or null.
  const meet = (r, q, dx, dy) => {
    const x = Math.max(r[0], q[0]), y = Math.max(r[1], q[1]), x1 = Math.min(r[0]+r[2], q[0]+q[2]), y1 = Math.min(r[1]+r[3], q[1]+q[3])
    return x1 > x && y1 > y ? [x+dx, y+dy, x1-x, y1-y] : null
  }
  // patches: only those parts of it (a probe), or all of it.
  const printDesk = (encoder, rect, pipeline, patches = null) => {
    if (!rect) return
    const p=encoder.beginRenderPass({colorAttachments:[{view:desk.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]})
    p.setPipeline(pipeline); p.setBindGroup(0,vGroup)
    for (const q of patches ? patches.map((q) => meet(rect, q, -rect[0], -rect[1])) : [[0, 0, rect[2], rect[3]]]) if (q) { p.setScissorRect(...q); p.draw(3) }
    p.end()
  }
  // The little walkers' atlas: a tile for each walker on the canvas, grown when it has to be.
  let walkerAtlas = ['rgba32float', 'rg32float'].map((format) => device.createTexture({ size: [1, 1], format, usage }))
  // Each walker's rectangle in pixels and its tile, packed in rows: [x0, y0, x1, y1, tileX, tileY], or null.
  const walkerBoxes = (u) => {
    const W=u[0], H=u[1], k=W/u[3], at=u[2]
    const heave = (x, z) => { // the shader's heaved()
      if (u[595] < 0.5 || Math.hypot(x-u[592], z-u[593]) > u[594]) return 0
      let h = 0
      for (let i = 0; i < 12 && i < u[595]; i++) {
        const o = 544+4*i, age = at-u[o+2], away = Math.hypot(x-u[o], z-u[o+1]), front = age*5.6
        if (Math.abs(away-front) > 5.5 && away > 3.5) continue
        const hard = Math.min(Math.abs(u[o+3])/0.9, 2.4), lasts = hard > 1.25 ? 5.5 : 2.6
        const live = smooth(0, 0.1, age)*(1-smooth(0.65*lasts, lasts, age))
        h += live*hard*(0.5*Math.exp(-age*0.75)*Math.sin((away-front)*2.2)*Math.exp(-(((away-front)/1.9)**2)) - 0.3*Math.exp(-age*3.2)*Math.exp(-away*away/1.4))
      }
      return h
    }
    const slip = u[837] > 0 ? 24.5*Math.abs(u[838])+1 : 0 // (the takeover shifts rows sideways)
    const top = Math.max(0, Math.floor((u[14]-u[7]-70)*k)) // (no walker is looked for above the valley)
    const R = Math.sqrt(3.1)*LAND.mini*1.02+0.02
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const x = u[224+4*i], z = u[225+4*i]
      if (!(z-u[289] >= 5)) return null
      const h = heave(x, z)
      const y = world.ground(x, z)+h+2.4*Math.max(h, 0)+0.75*LAND.mini
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (const [dx, dy, dz] of [[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]]) {
        const f = u[291]/(z+dz*R-u[289]), sx = u[295]+(x+dx*R-u[288])*f, sy = u[14]-u[7]-(y+dy*R-LAND.eye)*f
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy)
      }
      const box = [Math.max(0, Math.floor((x0-slip)*k)-2), Math.max(top, Math.floor(y0*k)-2), Math.min(W, Math.ceil((x1+slip)*k)+2), Math.min(H, Math.ceil(y1*k)+2)]
      return box[2] > box[0] && box[3] > box[1] ? box : null
    }).concat([0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const o = VILLAGE_OFFSET+4*i
      if (!(u[298+4*i] > 0)) return null
      const box = [Math.max(0, Math.floor((u[o]-slip)*k)-1), Math.max(0, Math.floor(u[o+1]*k)-1), Math.min(W, Math.ceil((u[o+2]+slip)*k)+1), Math.min(H, Math.ceil(u[o+3]*k)+1)]
      return box[2] > box[0] && box[3] > box[1] ? box : null
    }))
  }
  const packWalkers = (u) => {
    const boxes = walkerBoxes(u)
    const wide = Math.max(1024, ...boxes.map((b) => b ? b[2]-b[0] : 0))
    let x = 0, y = 0, row = 0
    for (const b of boxes) {
      if (!b) continue
      if (x+b[2]-b[0] > wide) { x = 0; y += row; row = 0 }
      b.push(x, y)
      x += b[2]-b[0]; row = Math.max(row, b[3]-b[1])
    }
    u.fill(0, 1664, 1760)
    boxes.forEach((b, i) => { if (b) { if (i < 8) { u.set(b.slice(0, 4), 1664+4*i); u.set([b[4]-b[0], b[5]-b[1]], 1696+4*i) } else u.set([b[4]-b[0], b[5]-b[1]], 1728+4*(i-8)) } })
    const [w, h] = [Math.ceil(wide/64)*64, Math.ceil((y+row)/64)*64]
    if (h > 0 && (walkerAtlas[0].width < w || walkerAtlas[0].height < h)) {
      const size = [Math.max(walkerAtlas[0].width, w), Math.max(walkerAtlas[0].height, h)]
      walkerAtlas.forEach((t) => t.destroy())
      walkerAtlas = ['rgba32float', 'rg32float'].map((format) => device.createTexture({ size, format, usage }))
      grid.pictureGroups = []
    }
    return boxes
  }
  // Each walker over its tile (the parts of it in patches, for a probe).
  const tiles = (p, boxes, from, patches) => boxes.forEach((b, i) => {
    if (!b || i < from || i >= from + 8) return
    const whole = [b[0], b[1], b[2]-b[0], b[3]-b[1]]
    for (const q of patches ? patches.map((q) => meet(whole, q, b[4]-b[0], b[5]-b[1])) : [[b[4], b[5], whole[2], whole[3]]]) if (q) { p.setScissorRect(...q); p.draw(3,1,0,i-from) }
  })
  let thingGroup = null
  const printWalkers = (encoder, boxes, pipeline, worksPipeline, patches = null) => {
    if (!boxes.some((b) => b)) return
    if (thingGroup?.fire !== art.fire) thingGroup = { fire: art.fire, group: device.createBindGroup({layout:thingLayout,entries:[{binding:0,resource:{buffer:pictureBuffer}},{binding:2,resource:sampler},{binding:9,resource:art.fire.createView()}]}) }
    const p=encoder.beginRenderPass({colorAttachments:walkerAtlas.map((t)=>({view:t.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}))})
    p.setPipeline(pipeline); p.setBindGroup(0,vGroup)
    tiles(p, boxes, 0, patches)
    p.setPipeline(worksPipeline); p.setBindGroup(0,thingGroup.group) // (the buildings, after the walkers)
    tiles(p, boxes, 8, patches)
    p.end()
  }
  const pair = (size, textureFormat) => [0, 1].map(() => device.createTexture({ size, format: textureFormat, usage }))
  // The clouds' picture: a tile for each cloud, a rectangle of pixels round it that takes in every point cloudAt can find
  // inside its box, packed in rows; grown when it has to be. Returns each cloud's [x, y, width, height] on the canvas and
  // its tile [x, y], and puts what to add to a pixel of the canvas to find it in its tile in the uniforms.
  let cloudAtlas = device.createTexture({ size: [1, 1], format: 'rgba16float', usage })
  const packClouds = (u) => {
    const W = u[0], H = u[1], k = W / u[3], boxes = []
    for (let c = 0; c < 6; c++) {
      const [x, y, s] = u.subarray(84 + 4 * c, 87 + 4 * c)
      if (!(s > 0)) continue
      const x0 = Math.max(0, Math.floor((x - 144 * s - 2) * k)), y0 = Math.max(0, Math.floor((y - 116 * s - 2) * k))
      const x1 = Math.min(W, Math.ceil((x + 160 * s + 2) * k)), y1 = Math.min(H, Math.ceil((y + 44 * s + 2) * k))
      if (x1 > x0 && y1 > y0) boxes.push({ c, rect: [x0, y0, x1 - x0, y1 - y0] })
    }
    const wide = Math.max(1024, ...boxes.map((b) => b.rect[2]))
    let x = 0, y = 0, row = 0
    for (const b of boxes) {
      if (x + b.rect[2] > wide) { x = 0; y += row; row = 0 }
      b.tile = [x, y]
      x += b.rect[2]; row = Math.max(row, b.rect[3])
    }
    u.fill(0, 2456, 2480)
    for (const b of boxes) u.set([b.tile[0] - b.rect[0], b.tile[1] - b.rect[1]], 2456 + 4 * b.c)
    const [w, h] = [Math.ceil(wide / 64) * 64, Math.ceil((y + row) / 64) * 64]
    if (h > 0 && (cloudAtlas.width < w || cloudAtlas.height < h)) {
      const size = [Math.max(cloudAtlas.width, w), Math.max(cloudAtlas.height, h)]
      cloudAtlas.destroy()
      cloudAtlas = device.createTexture({ size, format: 'rgba16float', usage })
      grid.pictureGroups = []
    }
    return boxes
  }

  // Which of each pair of textures holds the current state: velocity, pressure, dye.
  function simGroup(v, p, d) {
    const key = v * 4 + p * 2 + d
    grid.groups[key] ??= device.createBindGroup({
      layout: simLayout,
      entries: [
        { binding: 0, resource: { buffer: simBuffer } },
        { binding: 1, resource: grid.velocity[v].createView() },
        { binding: 2, resource: grid.pressure[p].createView() },
        { binding: 3, resource: grid.dye[d].createView() },
        { binding: 4, resource: sampler },
      ],
    })
    return grid.groups[key]
  }

  // The picture is painted here first, then its glow is worked out in ever smaller copies.
  let easel = null
  let everDrawn = false
  function stretch([width, height]) {
    if (easel?.width === width && easel?.height === height) return
    for (const texture of easel ? [easel.picture, easel.flare, easel.paper, easel.sky, ...easel.glow] : []) texture?.destroy()
    if (grid) grid.pictureGroups = [] // (they hold the sky's picture, which is made for each size)
    const glows = []
    for (let i = 1; i <= 5; i++) {
      glows.push(device.createTexture({ size: [Math.max(1, Math.ceil(width / 2 ** i)), Math.max(1, Math.ceil(height / 2 ** i))], format: FLOW, usage }))
    }
    const picture = device.createTexture({ size: [width, height], format: FLOW, usage })
    // The lens's own light, a quarter of the size; and the paper, drawn once for each size of picture.
    const flare = device.createTexture({ size: [glows[1].width, glows[1].height], format: FLOW, usage })
    const paper = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage })
    const group = (a, b) =>
      device.createBindGroup({
        layout: glowLayout,
        entries: [
          { binding: 0, resource: a.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: b.createView() },
          { binding: 3, resource: { buffer: lensBuffer } },
        ],
      })
    easel = {
      width,
      height,
      picture,
      glow: glows,
      flare,
      paper,
      sky: null, // as many rows as the sky needs (see draw)
      pressed: 0, // the pixels per design unit the paper was last drawn for
      fromGlow: group(blank, glows[0]),
      fromPicture: group(picture, blank),
      from: glows.map((texture) => group(texture, blank)),
      finish: null,
    }
    hang()
  }
  // The last pass also gets the grey page that lies over the picture.
  function hang() {
    if (!easel) return
    easel.finish = device.createBindGroup({
      layout: finishLayout,
      entries: [
        { binding: 0, resource: easel.picture.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: easel.glow[0].createView() },
        { binding: 3, resource: { buffer: lensBuffer } },
        { binding: 4, resource: front.createView() },
        { binding: 5, resource: runes.createView() },
        { binding: 6, resource: art.notice.createView() },
        { binding: 7, resource: art.page.createView() },
        { binding: 8, resource: easel.flare.createView() },
        { binding: 9, resource: easel.paper.createView() },
      ],
    })
  }

  function run(encoder, pipeline, texture, group, keep = false) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView?.() ?? texture, loadOp: keep ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.draw(3)
    pass.end()
  }

  // Positions arrive in the hero's design units and are scaled into the fluid's
  // own space, which can lag a little behind a hero that is being resized.
  function writeSim({ dt, time, sun, view = [grid.width, grid.height], pointer = [-9999, -9999, 0, 0], shot = [0, 0, 0], blast = [0, 0, 0], quake = 0 }) {
    const { wavelength, rate } = settings.liquid
    const kx = grid.width / view[0]
    const ky = grid.height / view[1]
    simData.set([grid.width, grid.height, dt, time], 0)
    simData.set([sun[0] * kx, sun[1] * ky, wavelength, rate], 4)
    simData.set([pointer[0] * kx, pointer[1] * ky, pointer[2] * kx, pointer[3] * ky], 8)
    simData.set([grid.flow[0], grid.flow[1], grid.dyeSize[0], grid.dyeSize[1]], 12)
    simData.set([sun[2]], 16)
    simData.set([shot[0] * kx, shot[1] * ky, shot[2]], 20)
    simData.set([blast[0] * kx, blast[1] * ky, blast[2]], 24)
    simData.set([quake], 28)
    device.queue.writeBuffer(simBuffer, 0, simData)
  }

  return {
    get dyeSize() {
      return grid?.dyeSize ?? [1, 1]
    },
    get ready() {
      return Boolean(grid)
    },
    built, // settles when a first frame can be drawn
    whole, // and when the snake and the takeover can be
    clocked, // whether frames' GPU times will be handed to timed
    timed: null, // (milliseconds, probe) => …, set by whoever wants them
    burden: 1, // the picture is drawn this many times over a frame: a small GPU, for trying the page's pacing on a big one
    // True when the textures no longer suit a hero of this size.
    stale(width, height) {
      return !grid || Math.abs(grid.width / width - 1) > 0.08 || Math.abs(grid.height / height - 1) > 0.08
    },
    // Fresh textures for a hero width by height design units, with the dye laid out as plain rings.
    reset(width, height, sun) {
      for (const texture of grid ? [...grid.velocity, ...grid.pressure, ...grid.dye] : []) texture.destroy()
      const limit = device.limits.maxTextureDimension2D
      const { cell } = settings.liquid
      const fit = Math.min(1, limit / Math.max(width, height))
      const flow = [Math.max(8, Math.round(width / cell)), Math.max(8, Math.round(height / cell))]
      const dyeSize = [Math.round(width * fit), Math.round(height * fit)]
      grid = {
        width,
        height,
        flow,
        dyeSize,
        velocity: pair(flow, FLOW),
        pressure: pair(flow, FLOW),
        dye: pair(dyeSize, DYE),
        groups: [],
        pictureGroups: [],
        v: 0,
        p: 0,
        d: 0,
      }
      writeSim({ dt: 0, time: 0, sun })
      const encoder = device.createCommandEncoder()
      run(encoder, passes.startDye, grid.dye[0], simGroup(0, 0, 1))
      device.queue.submit([encoder.finish()])
    },
    // The grey page as a picture, or nothing to take it away.
    // Its second picture is the same page with its words in the terminal's script.
    setFront(texture, script) {
      front = texture ?? blank
      runes = script ?? front
      hang()
    },
    // The pictures the lens puts in front of the picture, { notice, page }, and the one the sun's face can turn into, { boss }.
    setArt(pictures) {
      Object.assign(art, pictures)
      if (grid) grid.pictureGroups = []
      hang()
    },
    setTitle(texture) {
      title = texture ?? blank
      if (grid) grid.pictureGroups = []
    },
    // One step of the fluid. sun is [x, y, face radius]; pointer is [x, y, velocity x, velocity y].
    step(state) {
      writeSim(state)
      const encoder = device.createCommandEncoder()
      run(encoder, passes.moveVelocity, grid.velocity[1 - grid.v], simGroup(grid.v, grid.p, grid.d))
      grid.v = 1 - grid.v
      run(encoder, passes.measure, grid.pressure[1 - grid.p], simGroup(grid.v, grid.p, grid.d))
      grid.p = 1 - grid.p
      for (let i = 0; i < settings.liquid.solve; i++) {
        run(encoder, passes.relax, grid.pressure[1 - grid.p], simGroup(grid.v, grid.p, grid.d))
        grid.p = 1 - grid.p
      }
      run(encoder, passes.swirl, grid.velocity[1 - grid.v], simGroup(grid.v, grid.p, grid.d))
      grid.v = 1 - grid.v
      run(encoder, passes.moveDye, grid.dye[1 - grid.d], simGroup(grid.v, grid.p, grid.d))
      grid.d = 1 - grid.d
      device.queue.submit([encoder.finish()])
    },
    // Run the fluid for a while so it is already marbled at `time`. state(time, dt)
    // returns what step() needs beyond dt and time.
    warm(steps, time, state) {
      const dt = 1 / 30
      for (let i = 0; i < steps; i++) {
        const at = time - (steps - i) * dt
        this.step({ dt, time: at, ...state(at, dt) })
      }
    },
    // Paint the hero into view, which is size = [width, height] pixels. uniforms is what packUniforms filled.
    // gate, when there is a grey page over it: { x, y, half, sun } in design units, age, look, pointer, time, press.
    // acts is the show's act.lens: 32 numbers for what it is putting on in front of the lens.
    // probe: only a sixteenth of the picture is drawn, in sixteen patches spread evenly over it, and nothing is
    // shown: what a whole one would cost can be told from it without asking a small GPU for a whole one.
    draw(view, uniforms, size, gate = null, acts = null, probe = false) {
      if (!passes.finish) return
      stretch(size)
      const deskAt = deskRect(uniforms)
      if (deskAt) {
        uniforms.set([deskAt[0], deskAt[1]], 1660)
        if (desk.width < deskAt[2] || desk.height < deskAt[3]) {
          const [w, h] = [Math.max(desk.width, Math.ceil(deskAt[2]/64)*64), Math.max(desk.height, Math.ceil(deskAt[3]/64)*64)]
          desk.destroy()
          desk = device.createTexture({ size: [w, h], format: 'rgba32float', usage })
          grid.pictureGroups = []
        }
      }
      const walkersAt = packWalkers(uniforms)
      const sunBox = placeSun(uniforms)
      const cloudBoxes = packClouds(uniforms)
      poseTerminal(uniforms)
      poseWalkers(uniforms)
      device.queue.writeBuffer(pictureBuffer, 0, uniforms)
      // What the lens needs, read back out of the picture's uniforms: lightning
      // landing and buildings finishing send a shock through it.
      const perUnit = uniforms[0] / uniforms[3]
      const sinceBolt = uniforms[213] - 0.14
      const struck = sinceBolt >= 0 && sinceBolt < 1.4
      const pulsed = uniforms[334] < 1.4
      // Where the feet that have just come down are: the right pair, then the left.
      const beat = uniforms[43] * 2
      const side = Math.floor(beat) % 2 ? 1 : -1
      const reach = uniforms[42] * perUnit
      const foot = [side * 1.22, -0.42, 0]
      const across = (axis) => foot[0] * uniforms[axis] + foot[1] * uniforms[axis + 1] + foot[2] * uniforms[axis + 2]
      lensData.set([uniforms[2], perUnit, uniforms[113], reach * 1.25], 0)
      lensData.set([uniforms[40] * perUnit + reach * across(28), uniforms[41] * perUnit - reach * across(32), beat - Math.floor(beat), Math.min(1, Math.hypot(uniforms[328], uniforms[329]) * 4)], 12)
      lensData.set([uniforms[20] * perUnit, (uniforms[21] + uniforms[218]) * perUnit, struck ? sinceBolt : uniforms[334], struck ? 1 : pulsed ? 0.45 : 0], 4)
      lensData.set(struck ? [uniforms[214] * perUnit, uniforms[221] * perUnit] : [uniforms[332] * perUnit, uniforms[333] * perUnit], 8)
      lensData.set([uniforms[477], (uniforms[14] - uniforms[7]) * perUnit], 10)
      lensData[16] = uniforms[478]
      if (gate) {
        lensData.set([gate.x * perUnit, gate.y * perUnit, gate.age, 1], 20)
        lensData.set([gate.half * perUnit, gate.look ?? 0, (gate.pointer?.[0] ?? gate.x) * perUnit, (gate.pointer?.[1] ?? gate.y) * perUnit], 24)
        lensData.set([gate.time ?? 0, uniforms[22] * perUnit, gate.press ?? 0, gate.near ?? 0], 28)
      } else lensData.fill(0, 20, 32)
      if (acts) {
        lensData.set(acts.subarray(0, 32), 32)
        lensData.set(acts.length > 32 ? acts.subarray(32, 36) : [0, 0, 0, 0], 72) // the planet's view
      }
      else { lensData.fill(0, 32, 64); lensData.fill(0, 72) }
      if (uniforms[HAZE_OFFSET + 4] > 0) {
        const ppm = uniforms[HAZE_OFFSET + 5] * perUnit
        lensData.set([uniforms[HAZE_OFFSET] * perUnit, uniforms[HAZE_OFFSET + 1] * perUnit, uniforms[HAZE_OFFSET + 2] * perUnit, uniforms[HAZE_OFFSET + 3] * perUnit], 64)
        lensData.set([uniforms[HAZE_OFFSET + 4], Math.max(ppm, 1), Math.min(8 * perUnit, Math.max(1.2 * perUnit, 0.06 * ppm)), 0], 68)
      } else lensData.fill(0, 64, 72)
      device.queue.writeBuffer(lensBuffer, 0, lensData)
      // The sky's rows: those the land does not bury, and a few more. Its picture grows when it must.
      const skyRows = Math.min(easel.height, Math.max(1, Math.ceil((uniforms[14] - uniforms[7]) * perUnit + 0.7) + 2))
      if (!easel.sky || easel.sky.height < skyRows) {
        easel.sky?.destroy()
        easel.sky = device.createTexture({ size: [easel.width, Math.min(easel.height, skyRows + 24)], format: FLOW, usage })
        grid.pictureGroups = []
      }
      const pictureGroup = (sky, clouds, sun) => device.createBindGroup({
        layout: pictureLayout,
        entries: [
          { binding: 15, resource: sun.createView() },
          { binding: 13, resource: sky.createView() },
          { binding: 14, resource: clouds.createView() },
          { binding: 0, resource: { buffer: pictureBuffer } },
          { binding: 1, resource: title.createView() },
          { binding: 2, resource: sampler },
          { binding: 3, resource: grid.dye[grid.d].createView() },
          { binding: 5, resource: vSurfaces[0] },
          { binding: 6, resource: vSurfaces[1] },
          { binding: 4, resource: theatre.view },
          { binding: 7, resource: art[title.width===1024?'dax-narrow':'dax-wide'].createView() },
          { binding: 8, resource: art.comets.createView() },
          { binding: 9, resource: art.fire.createView() },
          { binding: 10, resource: desk.createView() },
          { binding: 11, resource: walkerAtlas[0].createView() },
          { binding: 12, resource: walkerAtlas[1].createView() },
        ],
      })
      grid.pictureGroups[grid.d] ??= pictureGroup(easel.sky, cloudAtlas, sunPicture ?? blank)
      grid.pictureGroups[2 + grid.d] ??= pictureGroup(blank, blank, blank) // for the sky's and the clouds' own passes, which cannot read what they draw into
      const drawSun = (patches) => {
        if (!patches.length) return
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: sunPicture.createView(), loadOp: 'load', storeOp: 'store' }] })
        pass.setPipeline(passes.sun)
        pass.setBindGroup(0, grid.pictureGroups[2 + grid.d])
        for (const [x, y, w, h] of patches) { pass.setScissorRect(x, y, w, h); pass.draw(3) }
        pass.end()
      }
      // (Each pixel of the clouds' pass works out every cloud over it, so where two rectangles overlap it is drawn twice, the same.)
      const drawClouds = (patches = null) => {
        if (!cloudBoxes.length) return
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: cloudAtlas.createView(), loadOp: 'load', storeOp: 'store' }] })
        pass.setPipeline(passes.clouds)
        pass.setBindGroup(0, grid.pictureGroups[2 + grid.d])
        for (const { c, rect, tile } of cloudBoxes) {
          for (const q of patches ? patches.map((q) => meet(rect, q, tile[0] - rect[0], tile[1] - rect[1])) : [[...tile, rect[2], rect[3]]]) if (q) { pass.setScissorRect(...q); pass.draw(3, 1, 0, c) }
        }
        pass.end()
      }
      const drawSky = (pipeline, patch) => {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: easel.sky.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, grid.pictureGroups[2 + grid.d])
        patch(pass)
        pass.end()
      }
      const encoder = device.createCommandEncoder()
      const timing = clocked && !stamps.busy && this.timed
      const last = timing ? stamped(encoder) : () => {}
      const close = () => {
        if (timing) {
          encoder.resolveQuerySet(stamps.set, 0, 2, stamps.held, 0)
          encoder.copyBufferToBuffer(stamps.held, 0, stamps.read, 0, 16)
        }
        device.queue.submit([encoder.finish()])
        if (!timing) return
        stamps.busy = true
        stamps.read.mapAsync(GPUMapMode.READ).then(
          () => {
            const [from, to] = new BigInt64Array(stamps.read.getMappedRange())
            const ms = Number(to - from) / 1e6
            stamps.read.unmap()
            stamps.busy = false
            this.timed?.(ms > 0 && ms < 60000 ? ms : null, probe) // (null: this GPU's stamps are not to be believed)
          },
          () => (stamps.busy = false),
        )
      }
      if (probe) {
        const [W, H] = size
        for (let n = 0; n < this.burden; n++) {
          printDesk(encoder, deskAt, passes.deskQuiet, probePatches(W, H))
          printWalkers(encoder, walkersAt, passes.walkerQuiet, passes.worksQuiet, probePatches(W, H))
          drawSky(passes.sky, (pass) => {
            for (const [x, y, w, h] of probePatches(W, H)) if (y < easel.sky.height) { pass.setScissorRect(x, y, w, Math.min(h, easel.sky.height - y)); pass.draw(3) }
          })
          drawClouds(probePatches(W, H))
          if (sunBox) drawSun(probePatches(W, H).map((q) => meet(sunBox, q, -sunBox[0], -sunBox[1])).filter(Boolean))
          if (n === this.burden - 1) last()
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: easel.picture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
          pass.setPipeline(passes.clearValley)
          pass.setBindGroup(0, grid.pictureGroups[grid.d])
          for (let i = 0; i < 16; i++) {
            pass.setScissorRect(Math.floor(((i % 4) + 0.375) * W / 4), Math.floor(((i >> 2) + 0.375) * H / 4), Math.max(1, Math.floor(W / 16)), Math.max(1, Math.floor(H / 16)))
            pass.draw(3)
          }
          pass.end()
        }
        easel.drawn = false
        return close()
      }
      // While the grey page is whole only the last pass has anything to do, once everything has been drawn once.
      if (!(gate && gate.age <= 0 && easel.drawn)) {
        const first = !everDrawn
        everDrawn = true
        easel.drawn = true
        const snake = uniforms[698]>0 && uniforms[699]>0 && uniforms[696]<uniforms[3] && uniforms[697]<uniforms[14]
        const boss = uniforms[836]>0
        // Each is let in on a frame it is not in, so that neither turns up part way through its entrance.
        if (!snakeIn && passes.picture && vPipe && (!snake || first)) snakeIn = true
        if (!bossIn && passes.takeover && passes.deskTakeover && passes.walkerTakeover && passes.worksTakeover && (!boss || first)) bossIn = true
        const cosmic = uniforms[COSMOS_OFFSET] > 0 || uniforms[COSMOS_OFFSET + 3] > 0
        if (!cosmosIn && passes.cosmosPicture && passes.cosmos && passes.deskCosmos && passes.walkerCosmos && passes.worksCosmos && passes.skyCosmos && (!cosmic || first)) cosmosIn = true
        const deep = cosmic && cosmosIn
        const active = snake && snakeIn
        for (let n = 0; n < this.burden; n++) {
        printDesk(encoder, deskAt, boss && bossIn ? passes.deskTakeover : deep ? passes.deskCosmos : passes.deskQuiet)
        printWalkers(encoder, walkersAt, boss && bossIn ? passes.walkerTakeover : deep ? passes.walkerCosmos : passes.walkerQuiet, boss && bossIn ? passes.worksTakeover : deep ? passes.worksCosmos : passes.worksQuiet)
        if (!(boss && bossIn)) {
          drawSky(deep ? passes.skyCosmos : passes.sky, (pass) => { pass.setScissorRect(0, 0, easel.width, skyRows); pass.draw(3) })
          drawClouds()
          if (sunBox) drawSun([[0, 0, sunBox[2], sunBox[3]]])
        }
        if(boss && bossIn){
          theatre.draw(encoder,art.boss,uniforms.subarray(BOSS_RIG,BOSS_RIG+4))
          if(active) printViper(encoder,uniforms)
          run(encoder,passes.takeover,easel.picture,grid.pictureGroups[grid.d])
        } else if(active){printViper(encoder,uniforms); paintWithViper(encoder,grid.pictureGroups[grid.d],uniforms,deep)}
        else run(encoder,deep?passes.cosmos:passes.clearValley,easel.picture,grid.pictureGroups[grid.d])
        }
        run(encoder, passes.bright, easel.glow[0], easel.fromPicture)
        for (let i = 1; i < easel.glow.length; i++) run(encoder, passes.shrink, easel.glow[i], easel.from[i - 1])
        for (let i = easel.glow.length - 1; i > 0; i--) run(encoder, passes.spread, easel.glow[i - 1], easel.from[i], true)
        run(encoder, passes.flares, easel.flare, easel.fromGlow)
      }
      if (easel.pressed !== perUnit) {
        easel.pressed = perUnit
        run(encoder, passes.paper, easel.paper, easel.fromGlow)
      }
      last()
      run(encoder, passes.finish, view, easel.finish)
      close()
    },
  }
}

// The secrets. Words to spell at the terminal, the old code, presses
// counted, and the ones this browser has found.
export const secrets = {
  WORDS: ['fire', 'rain', 'night', 'day', 'dax', 'snake', 'flower', 'fold', 'stars', 'sing', 'sober', 'speak'],
  KONAMI: ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'],
  // What each plays the first time it is found (one of sound.js's events).
  FIRST: { away: 'wink', word: 'rainbow', link: 'zoom', konami: 'breach', tickle: 'slam', stare: 'gulp', flowers: 'built', console: 'key', print: 'comedown' },
  KEY: 'psychoscript.found',
  QUIET: ['Shift', 'CapsLock', 'Control', 'Alt', 'Meta'], // keys that are no part of what is spelt
  // The letters typed so far, with this key: and the word they now end in, if any.
  spelt(typed, key) {
    if (key === 'Backspace') return { typed: typed.slice(0, -1), word: null }
    if (typeof key !== 'string' || secrets.QUIET.includes(key)) return { typed, word: null }
    if (!/^[a-z]$/i.test(key)) return { typed: key.length === 1 || key === 'Enter' ? '' : typed, word: null }
    const next = (typed + key.toLowerCase()).slice(-8)
    const word = secrets.WORDS.find((w) => next.endsWith(w)) ?? null
    return { typed: word ? '' : next, word }
  },
  // The last ten keys, with this one: and whether they were the code.
  konami(keys, key) {
    if (secrets.QUIET.includes(key)) return { keys, done: false }
    const next = [...keys, String(key).toLowerCase()].slice(-10)
    const done = next.length === 10 && next.every((k, i) => k === secrets.KONAMI[i])
    return { keys: done ? [] : next, done }
  },
  // The presses still within the last few seconds, with this one: and whether there are enough.
  presses(times, time, within, need) {
    const next = [...times.filter((t) => time - t < within && t <= time), time]
    const done = next.length >= need
    return { times: done ? [] : next, done }
  },
  // The word a link names after its #, if it is one of them.
  linked(hash) {
    try {
      const word = decodeURIComponent(String(hash ?? '').replace(/^#/, '')).toLowerCase()
      return secrets.WORDS.includes(word) ? word : null
    } catch {
      return null
    }
  },
  storage() {
    try {
      return globalThis.localStorage ?? null
    } catch {
      return null
    }
  },
  // The secrets found in this browser, kept in storage when there is any.
  found(storage) {
    let set = new Set()
    try {
      const kept = JSON.parse(storage?.getItem(secrets.KEY) ?? '[]')
      if (Array.isArray(kept)) set = new Set(kept.filter((n) => typeof n === 'string'))
    } catch {}
    return {
      get size() { return set.size },
      has: (name) => set.has(name),
      add(name) {
        if (set.has(name)) return false
        set.add(name)
        try { storage?.setItem(secrets.KEY, JSON.stringify([...set])) } catch {}
        return true
      },
    }
  },
  SUN: [
    '    \\  |  /',
    "  '. .--. .'",
    ' -- ( ^^ ) --',
    "  .' '--' '.",
    '    /  |  \\',
  ].join('\n'),
  RIDDLE: 'The one above laughs when poked, until it does not. The one with a glass face hears every word you spell it.',
}

// How long, in seconds, the grey page takes to give way once its tab is taken.
export const GATE_END = 4.15

// Paints the grey page's boxes and words on a canvas, each where the browser
// has laid it out, leaving out the tab: near enough the same page, as a
// picture that can be bent.
export function drawPage(g, top, skip, inScript = false) {
  const range = document.createRange()
  let nth = 1
  const clear = (colour) => !colour || colour === 'transparent' || /, 0\)$/.test(colour)
  const walk = (el) => {
    if (el === skip) return
    const style = getComputedStyle(el)
    if (style.display === 'none') return
    const box = el.getBoundingClientRect()
    const radius = parseFloat(style.borderTopLeftRadius) || 0
    if (!clear(style.backgroundColor)) {
      g.fillStyle = style.backgroundColor
      g.beginPath()
      g.roundRect(box.left, box.top, box.width, box.height, radius)
      g.fill()
    }
    const widths = ['Top', 'Right', 'Bottom', 'Left'].map((side) => (style[`border${side}Style`] === 'none' ? 0 : parseFloat(style[`border${side}Width`]) || 0))
    if (widths.every((w) => w > 0 && w === widths[0])) {
      g.strokeStyle = style.borderTopColor
      g.lineWidth = widths[0]
      g.beginPath()
      g.roundRect(box.left + widths[0] / 2, box.top + widths[0] / 2, box.width - widths[0], box.height - widths[0], Math.max(0, radius - widths[0] / 2))
      g.stroke()
    } else {
      if (widths[0]) { g.fillStyle = style.borderTopColor; g.fillRect(box.left, box.top, box.width, widths[0]) }
      if (widths[2]) { g.fillStyle = style.borderBottomColor; g.fillRect(box.left, box.bottom - widths[2], box.width, widths[2]) }
      if (widths[3]) { g.fillStyle = style.borderLeftColor; g.fillRect(box.left, box.top, widths[3], box.height) }
      if (widths[1]) { g.fillStyle = style.borderRightColor; g.fillRect(box.right - widths[1], box.top, widths[1], box.height) }
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 1) walk(node)
      else if (node.nodeType === 3 && node.data.trim()) {
        g.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        g.fillStyle = style.color
        if ('letterSpacing' in g) g.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
        for (const word of node.data.matchAll(/\S+/g)) {
          range.setStart(node, word.index)
          range.setEnd(node, word.index + word[0].length)
          const at = range.getBoundingClientRect()
          const text = style.textTransform === 'uppercase' ? word[0].toUpperCase() : word[0]
          const sized = g.measureText(text)
          const line = at.top + (at.height + sized.fontBoundingBoxAscent - sized.fontBoundingBoxDescent) / 2
          if (!inScript) {
            g.fillText(text, at.left, line)
            continue
          }
          // The same word in glyphs: as wide, as tall, as heavy, and in the same grey.
          const size = parseFloat(style.fontSize)
          const wide = size * 0.5
          const many = Math.max(1, Math.round(at.width / (size * 0.72)))
          const pitch = at.width / many
          g.strokeStyle = style.color
          g.lineWidth = size * (Number(style.fontWeight) >= 600 ? 0.115 : 0.08)
          g.lineCap = g.lineJoin = 'round'
          for (let i = 0; i < many; i++) drawRune(g, at.left + i * pitch + (pitch - wide) / 2, line - size * 0.7, wide, size * 0.7, nth++)
        }
      }
    }
  }
  walk(top)
}

// One glyph of the terminal's script, penned in a box: strokes, bows, dots and
// rings between the points of a grid three across and four down. Half of them
// are the same on both sides.
function drawRune(g, x, y, w, h, seed) {
  let state = (seed * 2654435761) >>> 0
  const luck = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296
  const mirrored = luck() > 0.5
  const count = 3 + Math.floor(luck() * 3)
  g.beginPath()
  for (let i = 0; i < count; i++) {
    const c = Math.floor(luck() * 3)
    const r = Math.floor(luck() * 4)
    const [dc, dr] = [[1, 0], [0, 1], [1, 1], [1, -1]][Math.floor(luck() * 4)]
    const c2 = Math.min(2, Math.max(0, c + dc))
    const r2 = Math.min(3, Math.max(0, r + dr))
    const sort = luck()
    for (const flip of mirrored ? [false, true] : [false]) {
      const across = (col) => x + ((flip ? 2 - col : col) / 2) * w
      const [x1, y1, x2, y2] = [across(c), y + (r / 3) * h, across(c2), y + (r2 / 3) * h]
      const reach = Math.hypot(x2 - x1, y2 - y1) / 2
      if (sort < 0.55 || reach < 0.5) {
        g.moveTo(x1, y1)
        g.lineTo(x2, y2)
      } else if (sort < 0.8) {
        g.moveTo(x1, y1)
        g.arc((x1 + x2) / 2, (y1 + y2) / 2, reach, Math.atan2(y1 - y2, x1 - x2), Math.atan2(y2 - y1, x2 - x1), flip)
      } else if (sort < 0.92) {
        g.moveTo(x1, y1)
        g.lineTo((x1 + x2) / 2, (y1 + y2) / 2)
        g.moveTo(x2, y2)
        g.lineTo(x2 + 0.01, y2)
      } else {
        g.moveTo((x1 + x2) / 2 + w * 0.17, (y1 + y2) / 2)
        g.arc((x1 + x2) / 2, (y1 + y2) / 2, w * 0.17, 0, 6.2832)
      }
    }
  }
  g.stroke()
}

// Play and pause for everything that moves.
function motionControl() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const toggle = document.querySelector('#motion-toggle')
  const frozen = new URLSearchParams(location.search).get('freeze')
  const listeners = []
  // The page arrives as a grey and sensible one, and stays that way until the
  // tab sitting in the middle of it is taken. Escape wears it off again.
  const root = document.documentElement
  const corp = document.querySelector('.corp')
  const tab = corp?.querySelector('.tab')
  const poster = document.querySelector('.poster')
  const icon = document.querySelector('link[rel="icon"]')
  const names = { sober: document.title, awake: 'PSYCHOSCRIPT', icon: icon?.getAttribute('href'), plain: icon?.dataset.plain }
  const trips = []
  let on = frozen === null && !reduced.matches
  let sober = Boolean(tab) && root.dataset.trip === 'off'
  let taken = false
  const motion = {
    get playing() { return on && !sober },
    get sober() { return sober },
    get taken() { return taken },
    get wanted() { return on },
    reduced: () => reduced.matches,
    tab,
    corp,
    startTime: frozen === null ? 0 : Number(frozen) || 0,
    onChange: (fn) => listeners.push(fn),
    onTrip: (fn) => trips.push(fn),
  }
  // It gets out of the page: the name on the browser's own tab turns into
  // the terminal's script and back into the other name, a little sun turns
  // in front of it, and the icon is the tab itself, face and all.
  const SIGNS = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ'
  const SUNS = ['☼', '✺', '❂', '✹']
  const leak = { timer: 0, since: 0, name: document.title, was: document.title, sheet: null }
  const drawIcon = (k) => {
    leak.sheet ??= Object.assign(document.createElement('canvas'), { width: 64, height: 64 })
    const g = leak.sheet.getContext('2d')
    g.clearRect(0, 0, 64, 64)
    g.save()
    g.beginPath()
    g.roundRect(2, 2, 60, 60, 12)
    g.clip()
    g.translate(32, 32)
    for (let ring = 5; ring >= 0; ring--) {
      for (let i = 0; i < 6; i++) {
        g.fillStyle = RAINBOW[(i + ring) % 6]
        g.beginPath()
        g.moveTo(0, 0)
        g.arc(0, 0, 10 + ring * 8, (i / 6) * 6.2832 + k * 0.5 + ring * 0.5, ((i + 1) / 6) * 6.2832 + k * 0.5 + ring * 0.5)
        g.fill()
      }
    }
    g.restore()
    g.translate(32, 32 + 1.5 * Math.sin(k * 1.3))
    g.fillStyle = P.yellow
    g.strokeStyle = INK
    g.lineWidth = 3.5
    g.beginPath()
    g.arc(0, 0, 17, 0, 6.2832)
    g.fill()
    g.stroke()
    g.fillStyle = INK
    const shut = k % 9 < 0.4
    for (const side of [-1, 1]) {
      g.beginPath()
      g.ellipse(side * 6, -4, 2.6, shut ? 0.7 : 4, 0, 0, 6.2832)
      g.fill()
    }
    g.lineWidth = 3
    g.lineCap = 'round'
    g.beginPath()
    g.arc(0, 1, 9, 0.5, 2.64)
    g.stroke()
    g.setTransform(1, 0, 0, 1, 0, 0)
    return leak.sheet.toDataURL('image/png')
  }
  const leakTick = () => {
    leak.since += 0.14
    const k = leak.since
    // The old name gives way to the new a letter at a time, through the script.
    const turned = Math.min(1, k / 1.8)
    const long = Math.round(leak.was.length + (leak.name.length - leak.was.length) * turned)
    let shown = ''
    for (let i = 0; i < long; i++) {
      const settles = (i + 1) / (long + 1)
      shown += turned > settles + 0.25 ? (leak.name[i] ?? '') : turned > settles - 0.3 ? SIGNS[(i * 7 + Math.floor(k * 7)) % SIGNS.length] : (leak.was[i] ?? '')
    }
    document.title = sober ? shown : `${SUNS[Math.floor(k * 2.2) % SUNS.length]} ${shown}`
    if (icon && !sober) icon.setAttribute('href', drawIcon(k))
    if (sober && turned >= 1) {
      clearInterval(leak.timer)
      leak.timer = 0
      document.title = names.sober
    }
  }
  const dress = () => {
    if (corp) corp.inert = !sober
    if (poster) poster.inert = sober
    if (icon && names.plain && sober) icon.setAttribute('href', names.plain)
    clearInterval(leak.timer)
    leak.timer = 0
    const next = sober ? names.sober : names.awake
    if (!taken || reduced.matches || !on) {
      document.title = next
      if (icon && !sober) icon.setAttribute('href', names.icon)
      return
    }
    Object.assign(leak, { was: document.title.replace(/^[☼✺❂✹] /, ''), name: next, since: 0 })
    leak.timer = setInterval(() => !document.hidden && leakTick(), 140)
  }
  const turn = (awake) => {
    if (!tab || sober === !awake) return
    sober = !awake
    taken = true
    const at = tab.getBoundingClientRect()
    root.style.setProperty('--trip-x', `${at.left + at.width / 2}px`)
    root.style.setProperty('--trip-y', `${at.top + at.height / 2}px`)
    root.dataset.trip = awake ? 'on' : 'off'
    dress()
    if (sober) tab.focus({ preventScroll: true })
    trips.forEach((fn) => fn(awake))
    listeners.forEach((fn) => fn())
  }
  dress()
  if (tab) {
    document.addEventListener('pointermove', (event) => {
      if (!sober) return
      const at = tab.getBoundingClientRect()
      const away = Math.hypot(event.clientX - at.left - at.width / 2, event.clientY - at.top - at.height / 2)
      tab.style.setProperty('--close', Math.max(0, Math.min(1, 1 - (away - 60) / 340)).toFixed(3))
    })
  }
  document.addEventListener('visibilitychange', () => {
    if (!tab || sober) return
    if (document.hidden) {
      document.title = names.sober
      if (icon && names.plain) icon.setAttribute('href', names.plain)
    } else if (!leak.timer) {
      document.title = names.awake
      if (icon) icon.setAttribute('href', names.icon)
    }
  })
  motion.comeDown = () => turn(false)
  tab?.addEventListener('click', () => turn(true))
  document.addEventListener('keydown', (event) => event.key === 'Escape' && !sober && turn(false))
  const set = (next) => {
    on = next
    if (taken) dress()
    root.dataset.motion = next ? 'on' : 'off'
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(!next))
    }
    listeners.forEach((fn) => fn())
  }
  reduced.addEventListener('change', () => set(frozen === null && !reduced.matches))
  if (toggle) {
    toggle.hidden = false
    toggle.addEventListener('click', () => set(!on))
  }
  set(on)
  return motion
}

async function start() {
  const motion = motionControl()
  // For whoever looks underneath: a note in the console, and a way to cast from it.
  const found = secrets.found(secrets.storage())
  let discover = (name) => found.add(name)
  let castWord = null
  globalThis.psychoscript = Object.freeze({
    cast: (word) => Boolean(castWord?.(String(word ?? '').toLowerCase())),
    get found() { return found.size },
  })
  console.log(`%c${secrets.SUN}
%c${secrets.RIDDLE}`, 'font: 12px/1.2 monospace; color: #f9bb2d; background: #1d1614; padding: 4px 10px', 'font: italic 12px Georgia, serif; color: #ee5a8f')
  addEventListener('beforeprint', () => discover('print'))
  const hero = document.querySelector('.hero')
  const canvas = hero?.querySelector('canvas.liquid')
  // (If the picture cannot be drawn after all, the page's own tab comes back in place of the photograph of the drawn one.)
  const plain = () => document.documentElement.classList.remove('lensing')
  if (!canvas || !navigator.gpu) return plain()

  const adapter = await navigator.gpu.requestAdapter()
  // (A browser with no GPU to give may offer one made of software: that is no place for this, and gets the still.)
  if (adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter) return plain()
  const device = await adapter?.requestDevice(adapter.features.has('timestamp-query') ? { requiredFeatures: ['timestamp-query'] } : undefined)
  const context = canvas.getContext('webgpu')
  if (!device || !context) return plain()

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  // (A shader the browser will not have is reported by the pipeline that was to be made of it.)
  device.pushErrorScope('validation')
  const liquid = createLiquid(device, format, { clocked: true, rest: () => new Promise((done) => setTimeout(done, 400)) })
  liquid.burden = Math.max(1, Math.min(200, Math.round(Number(new URLSearchParams(location.search).get('burden')) || 1)))
  const failed = await device.popErrorScope()
  if (failed) {
    console.error('liquid pipelines:', failed.message)
    return plain()
  }
  try {
    await liquid.built
  } catch (error) {
    console.error('liquid pipelines:', error.message)
    return plain()
  }
  liquid.whole.catch((error) => console.error('liquid pipelines:', error.message))
  const uniforms = new Float32Array(UNIFORM_FLOATS)

  // The pictures the lens puts in front of the picture, and the boss.
  for (const name of ['notice', 'page', 'boss', 'comets', 'dax-wide', 'dax-narrow', 'fire']) {
    fetch(`art/${name}.${name === 'boss' ? 'jpg' : 'png'}`)
      .then(async (r) => createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then((bitmap) => {
        const texture = device.createTexture({
          size: [bitmap.width, bitmap.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        })
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height])
        liquid.setArt({ [name]: texture })
      })
      .catch((error) => console.error(`liquid ${name}:`, error))
  }

  // The title's distance fields, one per layout, loaded once each.
  const wordmark = hero.querySelector('.wordmark')
  const maps = await fetch('art/title.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const titles = {}
  let title = null
  async function loadTitle(name) {
    if (!maps?.[name] || titles[name]) return
    titles[name] = { map: maps[name], texture: null }
    const bitmap = await createImageBitmap(await (await fetch(maps[name].src)).blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    })
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height])
    titles[name].texture = texture
    useTitle()
  }
  function useTitle() {
    const name = layout === settings.narrow ? 'narrow' : 'wide'
    const ready = titles[name]?.texture
    liquid.setTitle(ready)
    title = ready ? { map: titles[name].map, box: [0, 0, 0, 0] } : null
    hero.classList.toggle('has-live-title', Boolean(ready))
    if (!ready) loadTitle(name).catch((error) => console.error('liquid title:', error))
    placeScene()
    redraw()
  }

  const narrow = matchMedia('(max-width: 900px)')
  let layout = narrow.matches ? settings.narrow : settings.wide
  world.horizon = layout.horizon ?? LAND.horizon
  let clock = motion.startTime
  let visible = true
  let last = 0
  let request = 0
  let alive = true
  const pointer = { x: -9999, y: -9999, tx: -9999, ty: -9999, strength: 0, vx: 0, vy: 0 }

  // The grey page, as a picture the lens can melt, and how far along its tab's taking is.
  const root = document.documentElement
  const gate = { on: false, age: 0, way: 0, look: 0, looking: false, press: 0, time: 0, pointer: null, texture: null, x: 0, y: 0, half: 32, roarAt: null }
  function paintFront() {
    if (!motion.corp || !motion.tab || motion.reduced() || !canvas.width) return
    const box = canvas.getBoundingClientRect()
    if (!box.width) return
    // A canvas that has changed size is empty until it is drawn again, so the page closes its window on it till then.
    if (gate.sized !== `${canvas.width} ${canvas.height}`) {
      root.classList.remove('drawn')
      Object.assign(gate, { open: false, time: 0 })
    }
    gate.sized = `${canvas.width} ${canvas.height}`
    // Twice: as it reads, and with every word of it in the terminal's script.
    const [texture, script] = [false, true].map((inScript) => {
      const sheet = document.createElement('canvas')
      sheet.width = canvas.width
      sheet.height = canvas.height
      const g = sheet.getContext('2d')
      g.scale(sheet.width / box.width, sheet.height / box.height)
      g.translate(-box.left, -box.top)
      drawPage(g, motion.corp, motion.tab, inScript)
      const made = device.createTexture({
        size: [sheet.width, sheet.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      device.queue.copyExternalImageToTexture({ source: sheet }, { texture: made }, [sheet.width, sheet.height])
      return made
    })
    liquid.setFront(texture, script)
    gate.texture?.destroy()
    gate.script?.destroy()
    Object.assign(gate, { texture, script })
    // Where the tab sits, in the hero's units, and in the page's for the window the canvas shows through.
    const at = motion.tab.getBoundingClientRect()
    const k = design[0] / box.width
    Object.assign(gate, { x: (at.left + at.width / 2 - box.left) * k, y: (at.top + at.height / 2 - box.top) * k, half: 40 * k })
    root.style.setProperty('--trip-x', `${at.left + at.width / 2}px`)
    root.style.setProperty('--trip-y', `${at.top + at.height / 2}px`)
    if (!gate.on && motion.sober) gate.on = true
    // The page opens its window on the canvas only when the canvas has the page in it (see draw):
    // the first frame takes a while, and an empty canvas seen through the window is a black hole.
    gate.unseen = true
    schedule()
  }
  if (motion.tab) {
    const watch = (yes) => () => (gate.looking = yes)
    for (const name of ['pointerenter', 'focus']) motion.tab.addEventListener(name, watch(true))
    for (const name of ['pointerleave', 'blur']) motion.tab.addEventListener(name, watch(false))
    motion.tab.addEventListener('pointerdown', () => (gate.press = 1))
    document.documentElement.addEventListener('pointerleave', () => (gate.pointer = null))
    document.addEventListener('pointermove', (event) => {
      if (!gate.on) return
      const box = canvas.getBoundingClientRect()
      const k = design[0] / box.width
      gate.pointer = [(event.clientX - box.left) * k, (event.clientY - box.top) * k]
    })
    motion.onTrip((awake) => {
      if (!gate.texture) return
      gate.on = true
      gate.way = awake ? 1 : -1
      Object.assign(gate, { rate: 1, hold: 0 })
      if (awake) {
        gate.press = 1
        gate.roarAt = clock + 3.5
      } else {
        gate.age = Math.min(gate.age, GATE_END)
        gate.roarAt = null
        sound.event('comedown', { x: 0 })
      }
      root.classList.add('melting')
    })
  }

  const limit = device.limits.maxTextureDimension2D
  function fit(width, height) {
    const w = Math.max(1, Math.min(limit, Math.round(width)))
    const h = Math.max(1, Math.min(limit, Math.round(height)))
    if (canvas.width === w && canvas.height === h) return
    canvas.width = w
    canvas.height = h
  }

  // Rainbow, hills and sun hang where the page puts the .scene box.
  const sceneBox = hero.querySelector('.scene')
  let scene = null
  let design = [layout.width, layout.height]
  function placeScene() {
    const box = canvas.getBoundingClientRect()
    const at = sceneBox?.getBoundingClientRect()
    if (!at || !box.width) return
    design = designSize(layout, box.width, box.height)
    const k = design[0] / box.width
    scene = [(at.left - box.left) * k, (at.top - box.top) * k, at.width * k, at.height * k]
    const mark = wordmark?.getBoundingClientRect()
    if (title && mark) title.box = [(mark.left - box.left) * k, (mark.top - box.top) * k, mark.width * k, mark.height * k]
    // The planet and the sun can be pressed, so each has a button laid over it.
    const [px, py, pr] = layout.planet
    const sun = sunAt(layout, scene)
    const spots = [
      [planetSpot, px < 0 ? design[0] + px : px, py < 0 ? design[1] + py : py, pr * 1.1],
      [sunSpot, sun[0], sun[1], sun[2]],
      [bootSpot, scene[0] + scene[2] * layout.machine.at[0], scene[1] + scene[3] * layout.machine.at[1] + 0.42 * scene[2] * layout.machine.size, 0.4 * scene[2] * layout.machine.size],
    ]
    for (const [spot, x, y, r] of spots) {
      if (!spot) continue
      spot.hidden = false
      Object.assign(spot.style, { left: `${(x - r) / k}px`, top: `${(y - r) / k}px`, width: `${(2 * r) / k}px`, height: `${(2 * r) / k}px` })
    }
    if (prompt) prompt.hidden = false
  }

  // The terminal's glass is a button. Each frame it is pinned to the glass.
  const prompt = sceneBox?.querySelector('.prompt')
  const planetSpot = hero.querySelector('.hot--planet')
  const sunSpot = hero.querySelector('.hot--sun')
  const bootSpot = hero.querySelector('.hot--boots')
  // The notice's dark button is a real button, laid over where it is drawn for
  // as long as it can be pressed. Pressing it is complying: the page comes down.
  const complySpot = hero.querySelector('.comply')
  let complyAt = ''
  const comply = () => {
    if (!motion.playing || !act.notice?.up || !show.accept(clock)) return
    motion.comeDown()
  }
  complySpot?.addEventListener('click', comply)
  function placeComply() {
    if (!complySpot) return
    const at = act.notice?.up ? act.notice.button : null
    const css = at ? canvas.getBoundingClientRect().width / design[0] : 0
    const next = at ? at.map((n) => (n * css).toFixed(1)).join() : ''
    if (next === complyAt) return
    complyAt = next
    complySpot.hidden = !at
    if (at) Object.assign(complySpot.style, { left: `${at[0] * css}px`, top: `${at[1] * css}px`, width: `${at[2] * css}px`, height: `${at[3] * css}px` })
  }
  const sound = createSound()
  if (motion.sober) sound.prepare()
  const soundToggle = document.querySelector('#sound-toggle')
  const lean = [0, 0]
  const light = [-0.49, -0.87]
  const sunLean = [0, 0]
  const show = createShow()
  let act = show.tick(clock, 0, { width: design[0], height: design[1], focal: layout.focal })
  let hurry = 0 // how much faster than usual the picture is flying up the valley
  let pinned = ''
  function pin(cam, bob, shift) {
    if (!prompt || !scene) return
    const css = canvas.getBoundingClientRect().width / design[0]
    const box = [0, 0, scene[2] * css, scene[3] * css]
    const m = glassMatrix(layout, cam, box, prompt.offsetWidth, prompt.offsetHeight, bob * css, shift * css)
    const next = `matrix(${m.map((n) => n.toFixed(4)).join(',')})`
    if (next !== pinned) prompt.style.transform = pinned = next
  }

  // The fluid's textures follow the hero's shape; a new shape starts a new, pre-stirred fluid.
  function prepare() {
    if (!scene || !canvas.width) return false
    if (liquid.stale(design[0], design[1])) {
      const sun = sunAt(layout, scene)
      liquid.reset(design[0], design[1], sun)
      liquid.warm(settings.liquid.warm, clock, () => ({ sun }))
    }
    return true
  }

  // The entrance: dark, then the sun comes up from behind the hills and its
  // light spreads over everything. Returns how far the sun still has to rise
  // and how far its light has got, both in design units.
  let dawnFrom = null
  function dawn() {
    // Arriving by way of the tab there is no sunrise: it is all there at once.
    if (dawnFrom === null && !motion.sober) {
      const rise = motion.playing && !motion.taken
      dawnFrom = rise ? clock : -99
      document.documentElement.dataset.intro = rise ? 'run' : 'skip'
    }
    return dawnAt(clock - (dawnFrom ?? -99), design, sunAt(layout, scene))
  }

  function draw(dt = 0, probing = false) {
    if (!alive || (!gauged && !probing) || !prepare()) return
    if (dt > 0) {
      // The pointer stirs the slice of fluid it is seen through.
      const sun = sunAt(layout, scene)
      const at = intoFluid(layout, sun, [pointer.x, pointer.y], clock)
      const ahead = intoFluid(layout, sun, [pointer.x + pointer.vx * 0.01, pointer.y + pointer.vy * 0.01], clock)
      act = show.tick(clock, dt, {
        width: design[0],
        height: design[1],
        sun,
        pointer: pointer.tx > -9000 ? [pointer.x, pointer.y] : null,
        focal: layout.focal / (1 + 0.035 * Math.max(0, hurry)), // the lens widens with speed
        machine: [scene[0] + scene[2] * layout.machine.at[0], scene[1] + scene[3] * layout.machine.at[1], scene[2] * layout.machine.size],
        song: sound.level(),
        hurry,
        planet: layout.planet,
      })
      hurry *= Math.exp(-dt * 0.9)
      for (const event of act.events) sound.event(event.kind, event)
      const cursor = ['', 'gone', 'flower', 'eye', 'face'][act.cursor ?? 0]
      if ((hero.dataset.cursor ?? '') !== cursor) hero.dataset.cursor = cursor
      sound.frame({ time: clock, night: act.night, rain: act.weather[0], maw: act.maw, beam: act.beam[2], tears: act.tears[0], blood: act.sky[1], water: act.wet, moon: act.moon })
      const churned = act.churn ?? act.shot
      const blast = intoFluid(layout, sun, churned, clock)
      liquid.step({
        dt,
        time: clock,
        sun,
        view: design,
        pointer: [at[0], at[1], (ahead[0] - at[0]) * 100, (ahead[1] - at[1]) * 100],
        shot: act.shot,
        blast: [blast[0], blast[1], churned[2]],
        quake: act.quake,
      })
    }
    const cam = camera(layout, clock, lean)
    const gait = gaitAt(layout, scene, cam, act.view, act.travel)
    // Each time a pair of boots comes down, the ground takes it and it is heard.
    const beat = Math.floor(gait.phase * 2)
    const fell = dt > 0 && act.hop[0] === 0 && show.tread(beat, footfalls(layout, scene, cam, gait), clock)
    if (fell) sound.event(fell.wet ? 'leap' : 'step', { x: beat % 2 ? 0.7 : 0.4 })
    if (act.slam) {
      show.tread('slam', footfalls(layout, scene, cam, gait, true), clock, 1.7)
      sound.event('slam', { x: 0.5 })
    }
    const bob = -(gait.lift + act.hop[0] + act.hop[1]) * scene[2] * layout.machine.size * cam.up[1]
    packUniforms(uniforms, {
      width: canvas.width,
      height: canvas.height,
      time: clock,
      layout,
      design: design[0],
      pointer: [pointer.x, pointer.y, pointer.strength],
      scene,
      cam,
      sunCam: sunCamera(clock, [sunLean[0] + (act.nod?.[0] ?? 0), sunLean[1] + (act.nod?.[1] ?? 0)]),
      bob,
      lean: sunLean,
      title,
      dye: liquid.dyeSize,
      light,
      show: act,
      dawn: dawn(),
      gait,
    })
    if (probing) return liquid.draw(null, uniforms, [canvas.width, canvas.height], null, null, true)
    liquid.draw(context.getCurrentTexture().createView(), uniforms, [canvas.width, canvas.height], gate.on ? gate : null, act.lens)
    waited()
    if (gate.unseen && gate.on) {
      gate.unseen = false
      const mine = (gate.seen = (gate.seen ?? 0) + 1)
      const shown = () =>
        requestAnimationFrame(function open() {
          if (mine !== gate.seen || gate.unseen) return
          // (The canvas fades in when it first has a picture in it; the window waits for that as well.)
          if (Number(getComputedStyle(canvas).opacity) < 1) requestAnimationFrame(open)
          else {
            root.classList.add('drawn')
            gate.open = true
          }
        })
      ;(device.queue.onSubmittedWorkDone?.() ?? Promise.resolve()).then(shown, shown)
    }
    pin(cam, bob, 0)
    placeComply()
    canvas.classList.add('is-live')
    sceneBox?.classList.add('is-3d')
  }

  function frame(now) {
    request = 0
    if (!gauged) return gauge()
    const dt = Math.min(now - last, 100) / 1000
    last = now
    if (gate.on) {
      // The tab's clock starts when the page opens its window on it: until then it sits as it does in the photograph of it.
      if (gate.open || gate.way) gate.time += dt
      gate.look += ((gate.looking && !gate.way ? 1 : 0) - gate.look) * Math.min(1, dt * 12)
      gate.press *= Math.exp(-dt * 9)
      // The tab wakes as the pointer comes near it.
      const away = gate.pointer ? Math.hypot(gate.pointer[0] - gate.x, gate.pointer[1] - gate.y) : Infinity
      const near = gate.looking ? 1 : Math.max(0, Math.min(1, 1 - (away - 1.6 * gate.half) / (10 * gate.half)))
      gate.near = (gate.near ?? 0) + (near * near * (3 - 2 * near) - (gate.near ?? 0)) * Math.min(1, dt * 7)
      if (gate.hold > 0 && (gate.hold -= dt) <= 0) gate.way = 1
      if (gate.way > 0) {
        gate.age += dt * (gate.rate ?? 1)
        if (gate.roarAt !== null && clock >= gate.roarAt) {
          gate.roarAt = null
          show.greet(clock)
        }
        if (gate.age >= GATE_END) {
          Object.assign(gate, { on: false, way: 0, rate: 1 })
          root.classList.remove('melting')
        }
      } else if (gate.way < 0) {
        gate.age -= (dt * GATE_END) / 1.3
        if (gate.age <= 0) {
          Object.assign(gate, { age: 0, way: 0 })
          root.classList.remove('melting')
        }
      }
    }
    // The picture keeps going behind the grey page while it closes over it again.
    const moving = (motion.playing || (gate.on && gate.age > 0 && motion.wanted)) && dt > 0
    if (moving) {
      if (late) {
        late = false
        sharpen()
        placeScene()
      }
      pace(dt)
      clock += dt * settings.speed
      const before = [pointer.x, pointer.y]
      pointer.x += (pointer.tx - pointer.x) * 0.25
      pointer.y += (pointer.ty - pointer.y) * 0.25
      pointer.vx = (pointer.x - before[0]) / dt
      pointer.vy = (pointer.y - before[1]) / dt
      pointer.strength *= 0.965
      // The terminal turns a little toward the pointer.
      const aim = scene && pointer.tx > -9000
        ? [
            Math.max(-1, Math.min(1, (pointer.tx - (scene[0] + scene[2] * layout.machine.at[0])) / (design[0] * 0.6))) * 0.16,
            Math.max(-1, Math.min(1, (scene[1] + scene[3] * layout.machine.at[1] - pointer.ty) / (design[0] * 0.6))) * -0.07,
          ]
        : [0, 0]
      lean[0] += (aim[0] - lean[0]) * 0.05
      lean[1] += (aim[1] - lean[1]) * 0.05
      // The sun looks where it is firing, and otherwise at the pointer.
      const sun = scene && sunAt(layout, scene)
      const watched = act.beam[2] > 0.05 ? act.beam : pointer.tx > -9000 ? [pointer.tx, pointer.ty] : null
      const turn = sun && watched
        ? [Math.max(-1, Math.min(1, (watched[0] - sun[0]) / (design[0] * 0.5))) * 0.3, Math.max(-1, Math.min(1, (sun[1] - watched[1]) / (design[0] * 0.5))) * -0.16]
        : [0, 0]
      sunLean[0] += (turn[0] - sunLean[0]) * 0.12
      sunLean[1] += (turn[1] - sunLean[1]) * 0.12
      // The lettering is lit from wherever the pointer is.
      const mark = title?.box
      const toward = mark && pointer.tx > -9000 ? [pointer.tx - (mark[0] + mark[2] / 2), pointer.ty - (mark[1] + mark[3] / 2)] : [-0.49, -0.87]
      const far = Math.hypot(toward[0], toward[1]) || 1
      light[0] += (toward[0] / far - light[0]) * 0.06
      light[1] += (toward[1] / far - light[1]) * 0.06
    }
    if (due.length && motion.playing) {
      for (const item of due.splice(0)) {
        if (clock >= item.at && (!item.when || item.when())) item.fn()
        else if (clock < item.until) due.push(item)
      }
    }
    draw(moving ? dt * settings.speed : 0)
    schedule()
  }

  function schedule() {
    if (alive && (motion.playing || gate.on) && visible && !request) {
      last = performance.now()
      request = requestAnimationFrame(frame)
    }
  }

  function redraw() {
    if (!request) request = requestAnimationFrame(frame)
  }

  // How much of the screen's sharpness is drawn. It comes down when frames
  // come slowly, so a small GPU draws a softer picture and not a jerky one.
  let quality = 1
  let slow = 0
  let box = null
  // (A browser being driven by a test keeps its sharpness, so that its pictures can be compared; ?pace lets it adapt.)
  const fixed = navigator.webdriver && !/[?&]pace\b/.test(location.search)
  // (?pace also has what the pacing decides written to the console.)
  const tell = /[?&]pace\b/.test(location.search)
    ? (...said) => {
        const line = said.map((x) => (typeof x === 'number' ? Number(x.toFixed(2)) : x)).join(' ')
        console.info('pace:', line)
        canvas.dataset.pace = `${canvas.dataset.pace ?? ''}${line}; ` // (for a browser whose console cannot be read from outside)
      }
    : () => {}
  const BUDGET = 12.5 // the milliseconds of GPU a frame may take: three quarters of a sixtieth of a second, the rest left to the visitor's other windows
  const FLOOR = 0.25 // the least sharpness: softer than this is not the picture any more
  const HOPELESS = 85 // a GPU that takes this long over a frame at the floor is shown the still, not twelve soft frames a second
  // The picture stops, and the stills come back.
  function still() {
    if (!alive) return
    tell('stopped')
    alive = false
    root.classList.remove('drawn', 'gpu', 'melting')
    plain()
    canvas.classList.remove('is-live')
    hero.classList.remove('has-live-title')
    sceneBox?.classList.remove('is-3d')
    for (const spot of [prompt, planetSpot, sunSpot, bootSpot, complySpot]) if (spot) spot.hidden = true
    sound.disable()
    if (soundToggle) soundToggle.hidden = true
  }
  // Before a first whole frame is asked of it, the GPU is timed over a sixteenth of one, three times (the first
  // pays for what a pipeline's first use costs). A GPU that would take seconds over a whole frame, and be taken
  // from the browser for it, is never given one: it starts as soft as it needs to, or is shown the still.
  let gauged = fixed && !/[?&]gauge\b/.test(location.search)
  let gauging = false
  function gauge() {
    if (gauging) return
    const once = () =>
      new Promise((done) => {
        const from = performance.now()
        let stamped
        liquid.timed = (ms, probe) => probe && (stamped = ms)
        draw(0, true)
        // Where the GPU keeps no time of its own (or none to be believed), the wait for it to finish is the
        // measure, less what an empty wait takes. Its stamps, where it has them, come with that or just after.
        const waited = () => {
          const wait = Math.max(0, performance.now() - from - 2)
          const until = performance.now() + (liquid.clocked ? 250 : 0)
          const look = () => (stamped !== undefined || performance.now() >= until ? done({ wait, stamp: stamped ?? null }) : setTimeout(look, 8))
          look()
        }
        ;(device.queue.onSubmittedWorkDone?.() ?? Promise.resolve()).then(waited, waited)
      })
    // (Not before the canvas has its size: a sixteenth of nothing takes no time at all.)
    if (!box || !prepare()) return
    gauging = true
    ;(async () => {
      await once()
      const two = [await once(), await once()]
      // (Not every browser's stamps mean what they should: a sixteenth of this picture in next to no time is not to
      // be believed, and a GPU that says so is not asked again.)
      const stamp = Math.min(...two.map((took) => took.stamp ?? 0))
      believed = stamp > 0.15
      const whole = (believed ? stamp : Math.min(...two.map((took) => took.wait))) * 16
      tell('a whole frame would take', whole, 'ms', believed ? '(stamped)' : '(waited for)')
      if (watching) console.info('pace:', `probe says ${whole.toFixed(1)} ms a whole frame`)
      if (!watching && whole * FLOOR * FLOOR > HOPELESS) return still()
      // (A wait is a rough measure, and only frames' lateness can correct it afterwards, downwards: it is acted on
      // only when it says the GPU is far too small for a whole picture.)
      const allowed = believed ? BUDGET : 16.7
      if (!watching && whole > (believed ? BUDGET * 1.15 : 100)) quality = Math.max(FLOOR, Math.sqrt(allowed / whole))
      liquid.timed = timed
      gauged = true
      // (The grey page keeps all its sharpness: the picture takes what it needs when the tab is taken.)
      if (quality < 1 && motion.sober && !gate.way) late = true
      else if (quality < 1) {
        sharpen()
        placeScene()
      }
      redraw()
    })()
  }
  let late = false
  let believed = false
  // ?gauge: nothing adapts, and what each way of timing a frame says is written to the console once a second:
  // the GPU's own stamps, the wait for its work to be done, and the time between frames.
  const watching = /[?&]gauge\b/.test(location.search) && { stamp: [], wait: [], gap: [], busy: false, at: 0 }
  const middle = (list) => [...list].sort((a, b) => a - b)[list.length >> 1] ?? 0
  function waited() {
    if (!watching || watching.busy) return
    watching.busy = true
    const from = performance.now()
    if (watching.at) watching.gap.push(from - watching.at)
    watching.at = from
    const done = () => {
      watching.busy = false
      watching.wait.push(performance.now() - from)
      if (watching.wait.length < 40) return
      console.info('pace:', `stamp ${middle(watching.stamp).toFixed(1)} wait ${middle(watching.wait).toFixed(1)} gap ${middle(watching.gap).toFixed(1)} ms at ${canvas.width}x${canvas.height}, ${watching.stamp.length} stamps`)
      watching.stamp.length = watching.wait.length = watching.gap.length = 0
    }
    device.queue.onSubmittedWorkDone().then(done, done)
  }
  // Each frame's GPU time, where the GPU keeps it (see pace): the last nine of them, of which the middle one is
  // what a frame is taken to cost.
  const costs = []
  let costAt = -1e9
  function timed(ms, probe) {
    if (watching && ms !== null && !probe) watching.stamp.push(ms)
    // (Only frames in which the picture was drawn count: under the grey page there is next to nothing to time.)
    if (ms === null || probe || !believed || fixed || watching || !alive || !(motion.playing || (gate.on && gate.age > 0))) return
    costs.push(ms)
    if (costs.length > 9) costs.shift()
    costAt = performance.now()
    tried?.since.push(ms)
  }
  function sharpen() {
    if (!box) return
    const ratio = Math.min(devicePixelRatio || 1, settings.maxPixelRatio)
    const css = box.contentBoxSize[0]
    const exact = box.devicePixelContentBoxSize?.[0]
    // A very big screen starts with as many pixels as a 15 inch retina laptop has, and no more.
    const share = (late ? 1 : quality) * Math.min(1, Math.sqrt(settings.maxPixels / (css.inlineSize * css.blockSize * ratio * ratio)))
    // Use the true device-pixel box when the browser reports one that agrees with the ratio.
    if (share === 1 && exact && Math.abs(exact.inlineSize - css.inlineSize * ratio) < 2) fit(exact.inlineSize, exact.blockSize)
    else fit(css.inlineSize * ratio * share, css.blockSize * ratio * share)
  }
  // The picture is drawn softer when frames come late, by as much as will bring a frame back inside its time,
  // and that at once: a GPU kept waiting on frames it cannot draw is taken from the whole browser. What a frame
  // takes is the GPU's own word for it where it gives one, and the time between frames where it does not. Frames
  // have to be late as well as long before anything is given up: another window's work on the same GPU makes
  // them long, and no softness here would make them shorter. Well inside its time for four seconds, the picture
  // is drawn a little sharper again (only the GPU's own time can say that: frames never come early).
  // And softness that buys nothing is taken back: if frames are no shorter for having fewer pixels in them, their
  // time is going on something else (another window, another program), and the picture is left alone for a while.
  let gap = 16.7
  let hold = 0
  let easy = null
  let dire = null
  let tried = null
  let futile = 0
  function pace(dt) {
    if (fixed || watching || dt <= 0 || clock < 0.5) return
    const now = performance.now()
    const took = dt * 1000
    gap += (took - gap) * (took > gap ? 0.35 : 0.1)
    // (A frame that took a twentieth of a second or more counts for four: a picture that slow must come down at once.)
    slow += ((took > 22 ? 1 : 0) - slow) * (took > 50 ? 0.25 : 0.06)
    const stamped = now - costAt < 1000 && costs.length >= 5
    const cost = middle(costs)
    const spent = stamped ? cost : gap
    const allowed = stamped ? BUDGET : 16.7
    // (What the last softening bought is seen before anything else is done.)
    if (tried && tried.since.length < 10 && now < tried.until) return
    if (tried && tried.since.length >= 10) {
      const now0 = middle(tried.since)
      const hoped = tried.cost * tried.share
      const bought = now0 < hoped + 0.5 * (tried.cost - hoped) // at least half of what fewer pixels should have saved
      if (!bought) {
        quality = tried.quality
        hold = now + Math.min(60000, 10000 * 2 ** futile++)
        tell('sharpness back to', quality, 'at', clock, 's: frames no shorter for it,', now0, 'ms of GPU where', hoped, 'were hoped for')
        tried = null
        slow = 0
        costs.length = 0
        sharpen()
        placeScene()
        return
      }
      futile = 0
      tried = null
    }
    tried = null
    if (quality <= FLOOR) {
      if (slow > 0.6 && spent > HOPELESS) {
        dire ??= now
        if (now - dire > 4000) {
          tell('too slow at the floor', spent, 'ms: the still')
          still()
        }
      } else dire = null
      return
    }
    if (now < hold) return
    if (slow > 0.6 && spent > allowed * 1.15) {
      const was = quality
      quality = Math.max(FLOOR, quality * Math.max(0.5, Math.min(0.92, Math.sqrt(allowed / spent))))
      tried = stamped ? { quality: was, cost: spent, share: (quality / was) ** 2, since: [], until: now + 3000 } : null
      costs.length = 0
      gap = 16.7
      slow = 0
      hold = now + 600
      easy = null
    } else if (stamped && quality < 1 && slow < 0.1 && cost < BUDGET * 0.72) {
      easy ??= now
      if (now - easy < 4000) return
      quality = Math.min(1, quality * Math.min(1.3, Math.sqrt((0.9 * BUDGET) / cost)))
      costs.length = 0
      hold = now + 2000
      easy = null
    } else {
      easy = null
      return
    }
    tell('sharpness', quality, 'at', clock, 's: a frame took', spent, stamped ? 'ms of GPU' : 'ms')
    sharpen()
    placeScene()
  }

  const resize = new ResizeObserver((entries) => {
    const entry = entries.find((e) => e.target === canvas)
    if (entry) {
      box = entry
      sharpen()
    }
    placeScene()
    if (motion.sober && !gate.way) paintFront()
    redraw()
  })
  resize.observe(canvas)
  if (sceneBox) resize.observe(sceneBox)
  if (wordmark) resize.observe(wordmark)

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    schedule()
  }).observe(canvas)

  narrow.addEventListener('change', () => {
    layout = narrow.matches ? settings.narrow : settings.wide
    world.horizon = layout.horizon ?? LAND.horizon
    useTitle()
  })
  motion.onChange(schedule)

  // The terminal's monitor is a way in: press it and the eye dives into its
  // screen, and inside, press it again to dive on and out. x and y are a point of the hero.
  const onTerminal = (x, y) => {
    const [gx, gy, unit] = act.lens.subarray(17, 20)
    return unit > 0 && x > gx - 0.5 * unit && x < gx + 0.72 * unit && y > gy - 0.48 * unit && y < gy + 0.46 * unit
  }
  const plunge = () => motion.playing && show.dive(clock)
  let eyed = null

  hero.addEventListener('pointermove', (event) => {
    if (!motion.playing) return
    const box = canvas.getBoundingClientRect()
    const k = design[0] / box.width
    const x = (event.clientX - box.left) * k
    const y = (event.clientY - box.top) * k
    const moved = Math.hypot(x - pointer.tx, y - pointer.ty)
    if (pointer.tx < -9000) {
      pointer.x = x
      pointer.y = y
    }
    pointer.tx = x
    pointer.ty = y
    pointer.strength = Math.min(1, pointer.strength + moved * 0.004)
    show.move(x, y)
    // Over the terminal the crosshair opens into an eye, as it does over the glass.
    // (Not while the planet has the pointer, or has given back something else.)
    const plain = !hero.dataset.cursor
    if (eyed === null && plain) eyed = prompt ? getComputedStyle(prompt).cursor : 'pointer'
    hero.style.cursor = plain && onTerminal(x, y) ? eyed : ''
  })

  // Press anywhere on the picture and something comes of it; drag, and more
  // does. Press the sun itself and it roars. (Nobody aims its lasers but the sun.)
  let dragged = null
  hero.addEventListener('pointerdown', (event) => {
    if (!motion.playing || !scene || event.button > 0 || event.target.closest('a, button')) return
    const box = canvas.getBoundingClientRect()
    const k = design[0] / box.width
    const x = (event.clientX - box.left) * k
    const y = (event.clientY - box.top) * k
    // The notice's dark button, pressed on the picture itself.
    const dark = act.notice?.up && act.notice.button
    if (dark && x >= dark[0] && x <= dark[0] + dark[2] && y >= dark[1] && y <= dark[1] + dark[3]) return comply()
    const sun = sunAt(layout, scene)
    // Press the terminal and the eye dives into its screen; the sun holds its fire.
    if (onTerminal(x, y)) return void plunge()
    // Press a cloud and lightning comes out of it.
    const clouds = [
      ...layout.clouds.map(([cx, cy, size]) => [cx < 0 ? design[0] + cx : cx, cy < 0 ? design[1] + cy : cy, size]),
      ...layout.sceneClouds.map(([cx, cy, size]) => [scene[0] + scene[2] * cx, scene[1] + scene[3] * cy, scene[2] * size]),
    ]
    const cloud = clouds.find(([cx, cy, size]) => size > 0 && Math.abs(x - cx) < 110 * size && y > cy - 95 * size && y < cy + 30 * size)
    if (cloud) show.strike(cloud[0], design[1] - 40 - 120 * Math.random(), clock, cloud[1])
    else if (Math.hypot(x - sun[0], y - sun[1]) < sun[2] * 1.05) {
      show.roar(clock)
      tickled()
    }
    else {
      poked(show.poke(x, y, clock))
      dragged = [x, y, clock]
    }
  })
  hero.addEventListener('pointermove', (event) => {
    if (!dragged || !motion.playing) return
    const box = canvas.getBoundingClientRect()
    const k = design[0] / box.width
    const x = (event.clientX - box.left) * k
    const y = (event.clientY - box.top) * k
    if (Math.hypot(x - dragged[0], y - dragged[1]) < 90 || clock - dragged[2] < 0.14) return
    poked(show.poke(x, y, clock))
    dragged = [x, y, clock]
  })
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) hero.addEventListener(type, () => (dragged = null))

  // Escape comes back out of the terminal before it does anything else.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !alive || !motion.playing || !show.surface(clock)) return
      event.stopImmediatePropagation()
      event.preventDefault()
    },
    true,
  )

  // The wheel, or the up and down arrows, fly up the valley faster or slower.
  const spur = (by) => {
    if (by > 0 && hurry < 1.5) sound.event('zoom', { x: 0 })
    return (hurry = Math.max(-0.92, Math.min(7, hurry + by)))
  }
  hero.addEventListener(
    'wheel',
    (event) => {
      if (!motion.playing || document.documentElement.scrollHeight > innerHeight + 1) return
      spur(event.deltaY * 0.006)
    },
    { passive: true },
  )

  // The secrets. Each is counted once, in this browser, the first time it is
  // found, and heard then. What they do is put on by the show's own means.
  discover = (name) => {
    if (!found.add(name)) return
    sound.event(secrets.FIRST[name.split(':')[0]], { x: 0 })
  }
  const due = [] // what is still to be done, by the picture's clock: when, and if it must wait for something, what
  const later = (seconds, fn, when = null) => due.push({ at: clock + seconds, fn, when, until: clock + seconds + 12 })
  const word = (name) => {
    if (!alive || !motion.playing) return false
    if (name === 'sober') {
      if (!show.surface(clock)) motion.comeDown()
      return true
    }
    const took = show.spell(name, clock)
    if (took) discover(`word:${name}`)
    return took
  }
  // In the terminal, a word brings the eye back out to see what it does.
  const conjure = (name) => {
    if (!secrets.WORDS.includes(name) || !alive || !motion.playing) return false
    if (name === 'sober' || !show.diving) return word(name)
    show.surface(clock)
    later(0, () => word(name), () => !show.diving)
    return true
  }
  castWord = (name) => {
    const took = conjure(name)
    if (took) discover('console')
    return took
  }
  // A link with #fire, #rain, #dax, ... casts it once, a little after the tab is taken.
  let linked = secrets.linked(location.hash)
  const castLink = (seconds) => {
    if (!linked) return
    const name = linked
    linked = null
    later(seconds, () => conjure(name) && discover('link'))
  }
  if (!motion.sober) castLink(2.8) // by way of ?awake: once the sun is up
  motion.onTrip((awake) => awake && castLink(2))
  addEventListener('hashchange', () => {
    linked = secrets.linked(location.hash)
    if (motion.playing) castLink(0.3)
  })
  // Looked back at, the grey page is caught in front of the picture for a
  // moment, and melts away again, quickly.
  document.addEventListener('visibilitychange', () => {
    if (!alive) return
    if (document.hidden) {
      if (motion.sober || !motion.playing || !gate.texture || gate.on) return
      Object.assign(gate, { on: true, age: 0, way: 0, hold: 0, press: 0, look: 0, near: 0, roarAt: null, rate: 1, caught: true })
      draw(0)
    } else if (gate.caught) {
      gate.caught = false
      if (motion.sober || gate.way) return
      Object.assign(gate, { hold: 0.5, rate: GATE_END / 1.2 })
      discover('away')
      schedule()
    }
  })
  // The old code, and the long trip: the picture folds, flies, roars and flowers, for eight seconds or so.
  let keyed = []
  let typed = ''
  let tripAt = -99
  const longTrip = () => {
    if (clock - tripAt < 9) return
    tripAt = clock
    discover('konami')
    show.fold(clock)
    spur(3.5)
    later(1.1, () => show.roar(clock))
    later(2.3, () => show.spell('flower', clock))
    later(3.6, () => spur(2.5))
    later(4.8, () => show.spell('flower', clock))
    later(6.6, () => show.greet(clock))
  }
  document.addEventListener('keydown', (event) => {
    if (!alive || !motion.playing || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
    const code = secrets.konami(keyed, event.key)
    keyed = code.keys
    if (code.done) longTrip()
    const next = secrets.spelt(typed, event.key)
    typed = next.typed
    if (!next.word) return
    // A word that ends in d is not a dive.
    if (next.word.endsWith('d')) event.stopImmediatePropagation()
    conjure(next.word)
  })
  // Tickle the sun seven times in three seconds and it loses its temper.
  let tickles = []
  const tickled = () => {
    const count = secrets.presses(tickles, clock, 3, 7)
    tickles = count.times
    // (After this press's own roar, so that the long one is not cut short by it.)
    if (count.done) later(0, () => show.tantrum(clock) && discover('tickle'))
  }
  sunSpot?.addEventListener('click', () => motion.playing && tickled())
  // Press the planet three times in two seconds and it shows what it sees.
  let stares = []
  planetSpot?.addEventListener('click', () => {
    if (!motion.playing) return
    const count = secrets.presses(stares, clock, 2, 3)
    stares = count.times
    if (count.done && show.stare(clock)) discover('stare')
  })
  // Every seventh flower the visitor plants, a shower of petals.
  let planted = 0
  const poked = (result) => {
    if (result !== 'flower' || ++planted % 7) return
    if (show.shower(clock)) discover('flowers')
  }

  // The planet turns day into night, the sun roars, and the glass is a way
  // into the terminal. Any key writes a sign (but d dives); Enter casts the line.
  planetSpot?.addEventListener('click', () => motion.playing && show.turnOver(clock))
  sunSpot?.addEventListener('click', () => motion.playing && show.roar(clock))
  prompt?.addEventListener('click', plunge)
  bootSpot?.addEventListener('click', () => motion.playing && show.jump(clock))
  document.addEventListener('keydown', (event) => {
    if (!alive || !motion.playing || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
    const onControl = event.target instanceof Element && event.target.closest('button, a')
    if (event.key === 'Enter') {
      if (!onControl) show.cast(clock)
    } else if (event.key === 'Backspace') show.erase()
    else if (event.key === 'ArrowUp') spur(1.2)
    else if (event.key === 'ArrowDown') spur(-1.2)
    else if (event.key === 'd' || event.key === 'D') plunge()
    else if (event.key === ' ') {
      // Space makes the terminal jump.
      if (onControl) return
      show.jump(clock)
      event.preventDefault()
    }
    else if (event.key.length === 1 && !(onControl && event.key === ' ')) {
      show.type()
      if (event.key === ' ') event.preventDefault()
    }
  })

  // The mouth in the corner turns the sound on and off. Away from the page it is quiet.
  if (soundToggle) {
    soundToggle.hidden = false
    const shown = () => soundToggle.setAttribute('aria-pressed', String(sound.enabled))
    soundToggle.addEventListener('click', () => {
      soundToggle.classList.add('was-on')
      if (sound.enabled) sound.disable()
      else sound.enable().then(shown)
      shown()
    })
    // Taking the tab is a press, so the sound may come on with it; it goes when the tab wears off.
    motion.onTrip((awake) => {
      soundToggle.classList.add('was-on')
      if (awake) {
        sound.enable().then(() => {
          shown()
          sound.event('tab', { x: 0 })
        })
      } else sound.disable()
      shown()
    })
    let away = false
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && sound.enabled) {
        away = true
        sound.disable()
      } else if (!document.hidden && away) {
        away = false
        sound.enable().then(shown)
      }
    })
  }

  device.lost.then(still)

  useTitle()
  document.fonts?.ready.then(() => motion.sober && !gate.way && paintFront())
  return true
}

// The page hides its still artwork while WebGPU is starting; if it cannot start, the stills come back.
if (typeof document !== 'undefined') {
  start()
    .catch((error) => console.error('liquid background:', error))
    .then((live) => {
      if (!live) document.documentElement.classList.remove('gpu')
    })
}
