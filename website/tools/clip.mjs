// Renders a clip of the hero, with its sound, to an MP4 without a browser:
// `deno run -A --unstable-webgpu clip.mjs wide 12 22 out.mp4 [scale] [script]`.
// The show runs from the start so everything is where it would be on the page;
// frames are kept from the first time to the second. script is what a visitor
// does, as 'time:what' separated by commas: roar, cast, turn, type, jump,
// breach (a whale), abduct (the planet takes a walker), hurry=n (fly n times
// faster), press=x;y;seconds (hold the lasers on a point of the hero) and
// move=x;y (drag them there), say (the sun says its next catchphrase) and
// say=n (it says line n of SAYINGS in voice.worklet.js), cosmos (the sky parts on
// a galaxy whose stars play) and chorus (everything sings).
// LIQUID=path renders a work-in-progress copy of the page's code. DAWN=1
// plays the sunrise the page opens with.
// FRONT=grey.png lays the grey page (a screenshot of it without its tab) over
// the picture, with TAB=x;y;half saying where the tab sits and how big it is
// in the hero's units; then the script can also say take (the tab), sober
// (Escape), point=x;y;seconds (move the pointer there) and hide (the pointer).
const base = Deno.env.get('LIQUID') ?? '../site/liquid.js'
const { settings, packUniforms, camera, sunCamera, sunAt, intoFluid, dawnAt, gaitAt, footfalls, createLiquid, createShow, world, UNIFORM_FLOATS } = await import(base)
const { Choir } = await import('../site/voice.worklet.js')

const [which = 'wide', from = '0', to = '10', out = 'clip.mp4', ratio = '1', script = ''] = Deno.args
const layout = settings[which]
world.horizon = layout.horizon ?? world.horizon
const view = {
  wide: { height: 900, scene: [720, 320, 734, 580], title: [259, 43, 922, 427] },
  narrow: { height: 1300, scene: [-85, 741, 708, 558], title: [30, 90, 540, 563] },
}[which]
const map = JSON.parse(await Deno.readTextFile(new URL('../site/art/title.json', import.meta.url)))[which]
const even = (n) => Math.round(n / 2) * 2
const width = even(layout.width * Number(ratio))
const height = even(view.height * Number(ratio))
const fps = 30
const rate = 48000
const start = Number(from)
const end = Number(to)

const todo = script
  .split(',')
  .filter(Boolean)
  .map((item) => {
    const [time, what] = item.split(':')
    const [name, args = ''] = what.split('=')
    return { time: Number(time), name, args: args.split(';').map(Number), given: args !== '', done: false }
  })

const adapter = await navigator.gpu.requestAdapter()
const device = await adapter.requestDevice()
device.addEventListener('uncapturederror', (e) => console.error(e.error.message))
const format = 'rgba8unorm'
const liquid = createLiquid(device, format)
await liquid.whole // every pipeline is made off the thread (older copies have none to wait for)
const sun = sunAt(layout, view.scene)
liquid.reset(layout.width, view.height, sun)
liquid.warm(settings.liquid.warm, 0, () => ({ sun }))

const mapRaw = `${out}.map.rgba`
await new Deno.Command('magick', { args: [new URL(`../site/${map.src}`, import.meta.url).pathname, '-depth', '8', `rgba:${mapRaw}`] }).output()
const mapTexture = device.createTexture({ size: [map.width, map.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
device.queue.writeTexture({ texture: mapTexture }, await Deno.readFile(mapRaw), { bytesPerRow: map.width * 4 }, [map.width, map.height])
await Deno.remove(mapRaw)
liquid.setTitle(mapTexture)

// The pictures the lens puts in front of the picture.
for (const name of ['notice', 'page', 'boss', 'comets', `dax-${which}`, 'fire']) {
  const path = new URL(`../site/art/${name}.${name === 'boss' ? 'jpg' : 'png'}`, import.meta.url).pathname
  const [wide, tall] = new TextDecoder().decode((await new Deno.Command('magick', { args: ['identify', '-format', '%w %h', path] }).output()).stdout).split(' ').map(Number)
  const raw = `${out}.${name}.rgba`
  await new Deno.Command('magick', { args: [path, '-depth', '8', `rgba:${raw}`] }).output()
  const made = device.createTexture({ size: [wide, tall], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: made }, await Deno.readFile(raw), { bytesPerRow: wide * 4 }, [wide, tall])
  await Deno.remove(raw)
  liquid.setArt({ [name]: made })
}

const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
const stride = Math.ceil((width * 4) / 256) * 256
const pixels = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
const uniforms = new Float32Array(UNIFORM_FLOATS)
const raw = new Uint8Array(width * height * 4)

const silent = `${out}.silent.mp4`
const ffmpeg = new Deno.Command('ffmpeg', {
  args: ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', silent],
  stdin: 'piped',
}).spawn()
const film = ffmpeg.stdin.getWriter()

// The sound, made alongside the picture: the choir follows the show, and
// everything that happens is noted with its time for the effects.
const samples = Math.ceil((end - start) * rate)
const left = new Float32Array(samples + 256)
const right = new Float32Array(samples + 256)
const choir = new Choir(rate, 17117)
const heard = []
const levels = []
let sung = 0
let song = 0
let hurry = 0

// The grey page over the picture, its tab, and the pointer that takes it.
const frontPath = Deno.env.get('FRONT')
const END = 4.15
const [tabX, tabY, tabHalf] = (Deno.env.get('TAB') ?? `${layout.width / 2};${view.height / 2};32`).split(';').map(Number)
const gate = frontPath ? { x: tabX, y: tabY, half: tabHalf, sun: 0, age: 0, look: 0, press: 0, time: 0, pointer: [-999, -999], way: 0 } : null
let hover = null // where a pointer is resting on the hero
const arrow = { x: -999, y: -999, from: [-999, -999], to: [-999, -999], at: 0, takes: 0, shown: false }
let loud = gate ? 0 : 1
const loudness = []
if (gate) {
  // FRONT_SCRIPT is the same page with its words in the terminal's script.
  const textures = []
  for (const path of [frontPath, Deno.env.get('FRONT_SCRIPT') ?? frontPath]) {
    const rawFront = `${out}.front.rgba`
    await new Deno.Command('magick', { args: [path, '-background', 'white', '-alpha', 'remove', '-alpha', 'on', '-resize', `${width}x${height}!`, '-depth', '8', `rgba:${rawFront}`] }).output()
    const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    device.queue.writeTexture({ texture }, await Deno.readFile(rawFront), { bytesPerRow: width * 4 }, [width, height])
    await Deno.remove(rawFront)
    textures.push(texture)
  }
  liquid.setFront(...textures)
}
// A pointer drawn onto a finished frame: the usual black arrow edged in white.
const arrowShape = [[0, 0], [0, 16.5], [3.9, 12.8], [6.6, 19], [9.1, 17.9], [6.5, 11.9], [11.7, 11.9]]
function drawArrow(pixels, ax, ay) {
  const k = (width / layout.width) * 1.6
  const inside = (x, y) => {
    let hit = false
    for (let i = 0, j = arrowShape.length - 1; i < arrowShape.length; j = i++) {
      const [xi, yi] = arrowShape[i]
      const [xj, yj] = arrowShape[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }
  const edge = (x, y) => {
    let best = 99
    for (let i = 0, j = arrowShape.length - 1; i < arrowShape.length; j = i++) {
      const [x1, y1] = arrowShape[j]
      const [x2, y2] = arrowShape[i]
      const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)))
      best = Math.min(best, Math.hypot(x - x1 - t * (x2 - x1), y - y1 - t * (y2 - y1)))
    }
    return best
  }
  const x0 = Math.floor(ax * (width / layout.width))
  const y0 = Math.floor(ay * (width / layout.width))
  for (let py = y0 - 4; py < y0 + 22 * k; py++) {
    for (let px = x0 - 4; px < x0 + 15 * k; px++) {
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      let white = 0
      let black = 0
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const x = (px + (sx + 0.5) / 3 - x0) / k
          const y = (py + (sy + 0.5) / 3 - y0) / k
          const within = inside(x, y)
          const d = edge(x, y)
          if (within && d > 0.75) black++
          else if (d < 0.95) white++
        }
      }
      const at = (py * width + px) * 4
      const cover = (white + black) / 9
      if (!cover) continue
      const tone = (255 * white + 20 * black) / (white + black)
      for (let c = 0; c < 3; c++) pixels[at + c] = pixels[at + c] * (1 - cover) + tone * cover
    }
  }
}

const show = createShow()
const machine = [view.scene[0] + view.scene[2] * layout.machine.at[0], view.scene[1] + view.scene[3] * layout.machine.at[1], view.scene[2] * layout.machine.size]
const dt = 1 / fps
const total = Math.round(end * fps)
const began = performance.now()
for (let n = 1; n <= total; n++) {
  const time = n * dt
  for (const item of todo) {
    if (item.done || time < item.time) continue
    item.done = true
    if (item.name === 'roar') show.roar(time)
    else if (item.name === 'greet') show.greet(time)
    else if (item.name === 'poke') show.poke(item.args[0], item.args[1], time)
    else if (item.name === 'cast') show.cast(time)
    else if (item.name === 'turn') show.turnOver(time)
    else if (item.name === 'type') show.type()
    else if (item.name === 'say') show.say(time, item.given ? item.args[0] : undefined)
    else if (item.name === 'hurry') {
      hurry = item.args[0]
      if (hurry > 1) heard.push({ at: time - start, kind: 'zoom', x: 0 })
    }
    else if (item.name === 'abduct') show.abduct(time)
    else if (item.name === 'breach') show.breach(time)
    else if (item.name === 'jump') show.jump(time)
    else if (item.name === 'unfold') show.unfold(time)
    else if (item.name === 'windows') show.windows(time)
    else if (item.name === 'break') show.breakIn(time)
    else if (item.name === 'audit') show.audit(time)
    else if (item.name === 'dive') show.dive(time)
    else if (item.name === 'surface') show.surface(time)
    else if (item.name === 'unmask') show.unmask(time)
    else if (item.name === 'boss') show.boss(time)
    else if (item.name === 'notice') show.comply(time)
    else if (item.name === 'accept') show.accept(time)
    else if (item.name === 'steal') show.abductPointer(time)
    else if (item.name === 'hover') hover = [item.args[0], item.args[1]]
    else if (item.name === 'fold') show.fold(time)
    else if (item.name === 'cosmos') show.cosmos(time)
    else if (item.name === 'chorus') show.chorus(time)
    else if (item.name === 'stare') show.stare(time)
    else if (item.name === 'tantrum') show.tantrum(time)
    else if (item.name.startsWith('spell-')) show.spell(item.name.slice(6), time)
    else if (item.name === 'take' && gate) {
      Object.assign(gate, { way: 1, press: 1 })
      heard.push({ at: time - start, kind: 'tab', x: 0 })
      todo.push({ time: time + 3.5, name: 'greet', args: [], done: false })
    } else if (item.name === 'sober' && gate) {
      gate.way = -1
      heard.push({ at: time - start, kind: 'comedown', x: 0 })
    } else if (item.name === 'point') Object.assign(arrow, { from: arrow.shown ? [arrow.x, arrow.y] : [item.args[0], item.args[1]], to: [item.args[0], item.args[1]], at: time, takes: item.args[2] || 0.001, shown: true })
    else if (item.name === 'hide') arrow.shown = false
    else if (item.name === 'move') show.move(item.args[0], item.args[1])
    else if (item.name === 'press') {
      show.press(item.args[0], item.args[1])
      todo.push({ time: time + (item.args[2] || 1), name: 'release', args: [], done: false })
    } else if (item.name === 'release') show.release(time)
  }
  const act = show.tick(time, dt, { width: layout.width, height: view.height, sun, pointer: hover, focal: layout.focal / (1 + 0.035 * Math.max(0, hurry)), machine, song, hurry, planet: layout.planet })
  hurry *= Math.exp(-dt * 0.9)
  const churned = act.churn ?? act.shot
  const blast = intoFluid(layout, sun, churned, time)
  liquid.step({ dt, time, sun, view: [layout.width, view.height], shot: act.shot, blast: [blast[0], blast[1], churned[2]], quake: act.quake })
  if (time <= start) continue

  for (const event of act.events) {
    heard.push({ at: time - start, kind: event.kind, x: event.x })
    if (event.kind === 'built' || event.kind === 'flower' || event.kind === 'rainbow' || event.kind === 'cast') choir.event(event.kind === 'cast' ? 'built' : event.kind, event.x)
    if (event.kind === 'stars' || event.kind === 'chorus') choir.event(event.kind, event.x, event.score)
    if (event.kind === 'say' || event.kind === 'hush') choir.event(event.kind, event.line ?? 0)
  }
  const state = { night: act.night, rain: act.weather[0], maw: act.maw, beam: act.beam[2], tears: act.tears[0], blood: act.sky[1], water: act.wet, moon: act.moon }
  levels.push(state)
  choir.state(state)
  const until = Math.min(samples, Math.round((time - start) * rate))
  let energy = 0
  let count = 0
  while (sung < until) {
    choir.render(left.subarray(sung, sung + 128), right.subarray(sung, sung + 128))
    for (let i = sung; i < sung + 128; i++) energy += left[i] * left[i]
    count += 128
    sung += 128
  }
  if (count) song = Math.min(1, Math.sqrt(energy / count) * 5)

  const cam = camera(layout, time)
  const gait = gaitAt(layout, view.scene, cam, act.view, act.travel)
  const beat = Math.floor(gait.phase * 2)
  const fell = act.hop[0] === 0 && show.tread(beat, footfalls(layout, view.scene, cam, gait), time)
  if (fell) heard.push({ at: time - start, kind: fell.wet ? 'leap' : 'step', x: beat % 2 ? 0.7 : 0.4 })
  if (act.slam) {
    show.tread('slam', footfalls(layout, view.scene, cam, gait, true), time, 1.7)
    heard.push({ at: time - start, kind: 'slam', x: 0.5 })
  }
  packUniforms(uniforms, {
    width,
    height,
    time,
    layout,
    pointer: [-9999, -9999, 0],
    scene: view.scene,
    cam,
    sunCam: sunCamera(time, act.nod),
    title: { box: view.title, map },
    dye: liquid.dyeSize,
    show: act,
    dawn: dawnAt(Deno.env.get('DAWN') ? time : 99, [layout.width, view.height], sun),
    gait,
  })
  let over = null
  if (gate) {
    const going = Math.min(1, (time - arrow.at) / arrow.takes)
    const eased = going * going * (3 - 2 * going)
    arrow.x = arrow.from[0] + (arrow.to[0] - arrow.from[0]) * eased
    arrow.y = arrow.from[1] + (arrow.to[1] - arrow.from[1]) * eased
    const on = arrow.shown && Math.hypot(arrow.x - gate.x, arrow.y - gate.y) < gate.half * 1.5
    gate.look += ((on && !gate.way ? 1 : 0) - gate.look) * 0.2
    gate.press *= 0.8
    const away = arrow.shown ? Math.hypot(arrow.x - gate.x, arrow.y - gate.y) : Infinity
    const near = on ? 1 : Math.max(0, Math.min(1, 1 - (away - 1.6 * gate.half) / (10 * gate.half)))
    gate.near = (gate.near ?? 0) + (near * near * (3 - 2 * near) - (gate.near ?? 0)) * 0.2
    if (gate.way > 0) gate.age += dt
    else if (gate.way < 0) {
      gate.age = Math.min(gate.age, END) - (dt * END) / 1.3
      if (gate.age <= 0) Object.assign(gate, { age: 0, way: 0 })
    }
    gate.time = time - start
    gate.pointer = [arrow.x, arrow.y]
    if (gate.age < END) over = gate
    loud += ((gate.way > 0 ? 1 : 0) - loud) * (gate.way > 0 ? 0.04 : 0.12)
  }
  loudness.push(loud)
  liquid.draw(texture.createView(), uniforms, [width, height], over, act.lens)
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer: pixels, bytesPerRow: stride }, [width, height])
  device.queue.submit([encoder.finish()])
  await pixels.mapAsync(GPUMapMode.READ)
  const data = new Uint8Array(pixels.getMappedRange())
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, y * stride + width * 4), y * width * 4)
  pixels.unmap()
  if (gate && arrow.shown && (gate.age <= 0.3 || gate.way < 0)) drawArrow(raw, arrow.x, arrow.y)
  await film.write(raw)
}
await film.close()
await ffmpeg.status
console.log(`frames done in ${((performance.now() - began) / 1000).toFixed(1)} s`)

// The effects: each recording once, as mono samples at the clip's rate.
const audio = new URL('../site/audio/', import.meta.url)
const load = async (name) => {
  const { stdout } = await new Deno.Command('ffmpeg', { args: ['-loglevel', 'error', '-i', new URL(`${name}.mp3`, audio).pathname, '-f', 'f32le', '-ac', '1', '-ar', String(rate), '-'], stdout: 'piped' }).output()
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength >> 2)
}
const sounds = {}
for (const name of ['beam', 'impact', 'strike', 'rain', 'roar', 'flower', 'burn', 'fried', 'built', 'horizon']) sounds[name] = await load(name)
for (const name of ['tab', 'melt', 'comedown', 'ufo', 'pop', 'whale', 'breach', 'splash', 'stomp', 'stomp2', 'slam', 'boing', 'gulp', 'sizzle', 'spell', 'wink', 'zoom']) sounds[name] = await load(`fx/${name}`)
const hit = (name, at, x, level, speed = 1) => {
  const from = Math.round(at * rate)
  const sound = sounds[name]
  const l = Math.cos(((x + 1) * Math.PI) / 4)
  const r = Math.sin(((x + 1) * Math.PI) / 4)
  for (let i = 0; i < sound.length / speed && from + i < samples; i++) {
    const v = sound[Math.floor(i * speed)] * level
    left[from + i] += v * l
    right[from + i] += v * r
  }
}
const blip = (at, x, tone, level, seconds) => {
  const from = Math.round(at * rate)
  for (let i = 0; i < seconds * rate && from + i < samples; i++) {
    const t = i / rate
    const v = Math.sin(2 * Math.PI * tone * (t + 0.02 * Math.exp(-t * 40))) * level * Math.exp(-t / (seconds / 5))
    left[from + i] += v * (1 - x) * 0.5
    right[from + i] += v * (1 + x) * 0.5
  }
}
const { tinyScream } = await import('../site/sound.js')
let lastHorizon = -9
for (const { at, kind, x } of heard) {
  const tune = 0.93 + 0.14 * Math.random()
  if (kind === 'flower') hit('flower', at, x, 1.08, tune)
  else if (kind === 'built') hit('built', at, x, 0.99, tune)
  else if (kind === 'cast') {
    hit('spell', at, x, 0.62, tune)
    hit('built', at, x, 0.3, 1.7)
  }
  else if (kind === 'burn') hit('burn', at, x, 0.37, tune)
  else if (kind === 'fried') hit('fried', at, x, 0.82, tune)
  else if (kind === 'razed') {
    hit('burn', at, x, 0.51, tune * 0.65)
    hit('impact', at, x, 0.32, 0.72)
  } else if (kind === 'strike') hit('strike', at, x, 0.4, tune * 0.94)
  else if (kind === 'roar') hit('roar', at, x, 0.36, tune * 0.88)
  else if (kind === 'key') blip(at, x, 233.08 * 2 ** ([0, 3, 5, 7, 10, 12, 15][Math.floor(Math.random() * 7)] / 12), 0.06, 0.16)
  else if (kind === 'tears' || kind === 'blood') blip(at, x, kind === 'blood' ? 260 : 640, 0.05, 0.24)
  else if (kind === 'scream') {
    const wave = tinyScream(rate), speed = tune * (0.92 + 0.3 * Math.random()), from = Math.round(at * rate)
    for (let i = 0; i < wave.length / speed && from + i < samples; i++) {
      const v = wave[Math.floor(i * speed)] * 0.2
      left[from + i] += v * (1 - x) * 0.5
      right[from + i] += v * (1 + x) * 0.5
    }
  }
  else if (kind === 'leap') {
    blip(at, x, 640, 0.045, 0.2)
    hit('stomp2', at, x, 0.16, tune * 1.3)
  } else if (kind === 'taken') hit('pop', at, x, 0.7)
  else if (kind === 'breach') {
    hit('breach', at, x, 0.62)
    hit('whale', at, x, 0.5, tune)
  } else if (kind === 'slam') hit('slam', at, x, 0.6)
  else if (kind === 'gulp') hit('gulp', at, x, 0.85)
  else if (kind === 'jump') hit('boing', at, x, 0.5, tune)
  else if (kind === 'splash') hit('splash', at, x, 0.62)
  else if (kind === 'lift') hit('ufo', at, x, 0.3)
  else if (kind === 'wink') hit('wink', at, x, 0.5)
  else if (kind === 'steam') hit('sizzle', at, x, 0.4, tune)
  else if (kind === 'zoom') hit('zoom', at, x, 0.5, tune)
  else if (kind === 'step') hit(Math.random() < 0.5 ? 'stomp' : 'stomp2', at, x, 0.3, tune)
  else if (kind === 'rainbow') hit('horizon', at, x, 0.16, 1.47)
  else if (['sunset', 'moonrise', 'moonset', 'sunrise'].includes(kind) && at - lastHorizon > 1.2) {
    lastHorizon = at
    hit('horizon', at, x, 0.31, { sunset: 0.74, moonrise: 1.16, moonset: 0.89, sunrise: 1.3 }[kind])
  }
}
// Rain and the lasers are loops whose loudness follows the show.
let rainNow = 0
let beamNow = 0
let wasFiring = false
for (let i = 0; i < samples; i++) {
  const state = levels[Math.min(levels.length - 1, Math.floor((i / rate) * fps))]
  if (!state) break
  rainNow += (state.rain * (0.77 + 0.23 * state.water) - rainNow) / (0.45 * rate)
  beamNow += (0.76 * state.beam ** 0.8 - beamNow) / (0.04 * rate)
  const wet = sounds.rain[i % sounds.rain.length] * rainNow
  const hot = sounds.beam[i % sounds.beam.length] * beamNow
  left[i] += wet + hot
  right[i] += wet + hot
  if (state.beam > 0.4) wasFiring = true
  else if (wasFiring && state.beam < 0.09) {
    wasFiring = false
    hit('impact', i / rate, 0, 0.48)
  }
}
// Under the grey page the valley is not heard; the tab going, and wearing off, are.
for (let i = 0; i < samples; i++) {
  const heardNow = loudness[Math.min(loudness.length - 1, Math.floor((i / rate) * fps))] ?? 1
  left[i] *= heardNow
  right[i] *= heardNow
}
for (const { at, kind } of heard) {
  if (kind === 'tab') {
    hit('tab', at, 0, 0.9)
    hit('melt', at, 0, 0.42)
  } else if (kind === 'comedown') hit('comedown', at, 0, 0.7)
}
const pcm = new Int16Array(samples * 2)
for (let i = 0; i < samples; i++) {
  const fade = Math.min(1, i / (0.4 * rate), (samples - i) / (0.4 * rate))
  pcm[i * 2] = Math.round(Math.tanh(left[i] * 1.5) * fade * 30000)
  pcm[i * 2 + 1] = Math.round(Math.tanh(right[i] * 1.5) * fade * 30000)
}
const pcmPath = `${out}.pcm`
await Deno.writeFile(pcmPath, new Uint8Array(pcm.buffer))
const mux = await new Deno.Command('ffmpeg', {
  args: ['-y', '-loglevel', 'error', '-i', silent, '-f', 's16le', '-ar', String(rate), '-ac', '2', '-i', pcmPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out],
}).output()
await Deno.remove(pcmPath)
await Deno.remove(silent)
console.log(mux.code === 0 ? `wrote ${out} ${width}x${height} ${end - start}s, heard: ${heard.filter((e) => e.kind !== 'step').map((e) => `${e.at.toFixed(1)} ${e.kind}`).join(', ')}` : new TextDecoder().decode(mux.stderr))
