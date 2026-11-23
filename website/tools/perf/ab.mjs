// ab.mjs <layout> <time> <scale> <a.js> <b.js> ...: GPU ms a frame for each copy of liquid.js,
// timed in interleaved rounds on one device so that whatever else the GPU is doing falls on all alike.
// Prints the median of the rounds for each, and the difference from the first.
const [which = 'wide', time = '6', ratio = '2', ...files] = Deno.args
const rounds = Number(Deno.env.get('ROUNDS') ?? 9)
const frames = Number(Deno.env.get('FRAMES') ?? 12)
const adapter = await navigator.gpu.requestAdapter()
const device = await adapter.requestDevice()
device.addEventListener('uncapturederror', (e) => console.error(e.error.message.slice(0, 600)))
const format = 'rgba8unorm'
const view = {
  wide: { height: 900, scene: [720, 320, 734, 580], title: [259, 43, 922, 427] },
  narrow: { height: 1300, scene: [-85, 741, 708, 558], title: [30, 90, 540, 563] },
}[which]
const map = JSON.parse(await Deno.readTextFile(new URL('../../site/art/title.json', import.meta.url)))[which]
const mapRaw = await Deno.makeTempFile()
await new Deno.Command('magick', { args: [new URL(`../../site/${map.src}`, import.meta.url).pathname, '-depth', '8', `rgba:${mapRaw}`] }).output()
const mapBytes = await Deno.readFile(mapRaw)
await Deno.remove(mapRaw)
const made = []
for (const file of files) {
  const m = await import(new URL(file, `file://${Deno.cwd()}/`).href)
  const layout = m.settings[which]
  m.world.horizon = layout.horizon ?? m.world.horizon
  const width = Math.round(layout.width * Number(ratio))
  const height = Math.round(view.height * Number(ratio))
  const liquid = m.createLiquid(device, format)
  await liquid.whole // every pipeline is made off the thread (older copies have none to wait for)
  const sun = m.sunAt(layout, view.scene)
  liquid.reset(layout.width, view.height, sun)
  const show = m.createShow()
  let act
  liquid.warm(Number(Deno.env.get('STEPS') ?? 60), Number(time), (at, dt) => {
    act = show.tick(at, dt, { width: layout.width, height: view.height, sun, focal: layout.focal, planet: layout.planet })
    const cam = m.camera(layout, at)
    const gait = m.gaitAt(layout, view.scene, cam, act.view, act.travel)
    show.tread(Math.floor(gait.phase * 2), m.footfalls(layout, view.scene, cam, gait), at)
    const churned = act.churn ?? act.shot
    const blast = m.intoFluid(layout, sun, churned, at)
    return { sun, shot: act.shot, blast: [blast[0], blast[1], churned[2]], quake: act.quake }
  })
  const mapTexture = device.createTexture({ size: [map.width, map.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  device.queue.writeTexture({ texture: mapTexture }, mapBytes, { bytesPerRow: map.width * 4 }, [map.width, map.height])
  liquid.setTitle(mapTexture)
  const cam = m.camera(layout, Number(time))
  const uniforms = m.packUniforms(new Float32Array(m.UNIFORM_FLOATS), {
    width, height, time: Number(time), layout, pointer: [-9999, -9999, 0], scene: view.scene, cam, sunCam: m.sunCamera(Number(time)),
    title: { box: view.title, map }, dye: liquid.dyeSize, show: act, dawn: m.dawnAt(99, [layout.width, view.height], sun),
    gait: m.gaitAt(layout, view.scene, cam, act.view, act.travel),
  })
  const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const draw = () => liquid.draw(texture.createView(), uniforms, [width, height], null, act.lens)
  draw()
  await device.queue.onSubmittedWorkDone()
  made.push({ file, draw, times: [], size: `${width}x${height}` })
}
for (let r = 0; r <= rounds; r++) {
  for (const one of made) {
    await device.queue.onSubmittedWorkDone()
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) one.draw()
    await device.queue.onSubmittedWorkDone()
    if (r > 0) one.times.push((performance.now() - t0) / frames)
  }
}
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const base = median(made[0].times)
for (const one of made) {
  const m = median(one.times)
  const name = one.file.split('/').pop().replace(/\.js$/, '')
  console.log(`METRIC ${name} ms=${m.toFixed(2)} delta=${(m - base).toFixed(2)} min=${Math.min(...one.times).toFixed(2)} max=${Math.max(...one.times).toFixed(2)} ${one.size}`)
}
