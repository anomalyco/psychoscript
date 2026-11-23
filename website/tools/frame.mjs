// Renders one frame of the liquid background to a PNG without a browser, using
// Deno's WebGPU: `deno run -A --unstable-webgpu frame.mjs wide 6 out.png [scale] [steps]`.
// steps is how long the fluid is stirred first (30 steps a second). fire is
// 'x,y': the sun holds its lasers there for the last second. age is seconds
// into the sunrise entrance.
// LIQUID=path renders a work-in-progress copy of the page's code.
const { settings, packUniforms, camera, sunCamera, sunAt, intoFluid, dawnAt, gaitAt, footfalls, createLiquid, createShow, world, UNIFORM_FLOATS } = await import(Deno.env.get('LIQUID') ?? '../site/liquid.js')

const [which = 'wide', time = '6', out = 'frame.png', ratio = '1', steps = String(settings.liquid.warm), fire = '', age = '99'] = Deno.args
const layout = settings[which]
world.horizon = layout.horizon ?? world.horizon
// The .scene box as the page lays it out, in design units.
const view = {
  wide: { height: 900, scene: [720, 320, 734, 580], title: [259, 43, 922, 427] },
  narrow: { height: 1300, scene: [-85, 741, 708, 558], title: [30, 90, 540, 563] },
}[which]
const map = JSON.parse(await Deno.readTextFile(new URL('../site/art/title.json', import.meta.url)))[which]
const width = Math.round(layout.width * Number(ratio))
const height = Math.round(view.height * Number(ratio))

const adapter = await navigator.gpu.requestAdapter()
const device = await adapter.requestDevice()
device.addEventListener('uncapturederror', (e) => console.error(e.error.message))
const format = 'rgba8unorm'
const liquid = createLiquid(device, format)
await liquid.whole // every pipeline is made off the thread (older copies have none to wait for)
const sun = sunAt(layout, view.scene)
liquid.reset(layout.width, view.height, sun)
const show = createShow()
let act
liquid.warm(Number(steps), Number(time), (at, dt) => {
  if (fire && at > Number(time) - 1) show.press(...fire.split(',').map(Number))
  act = show.tick(at, dt, { width: layout.width, height: view.height, sun, focal: layout.focal, planet: layout.planet })
  const cam = camera(layout, at)
  const gait = gaitAt(layout, view.scene, cam, act.view, act.travel)
  show.tread(Math.floor(gait.phase * 2), footfalls(layout, view.scene, cam, gait), at)
  const blast = intoFluid(layout, sun, act.shot, at)
  return { sun, shot: act.shot, blast: [blast[0], blast[1], act.shot[2]], quake: act.quake }
})
const mapRaw = `${out}.map.rgba`
await new Deno.Command('magick', { args: [new URL(`../site/${map.src}`, import.meta.url).pathname, '-depth', '8', `rgba:${mapRaw}`] }).output()
const mapTexture = device.createTexture({ size: [map.width, map.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
device.queue.writeTexture({ texture: mapTexture }, await Deno.readFile(mapRaw), { bytesPerRow: map.width * 4 }, [map.width, map.height])
await Deno.remove(mapRaw)
liquid.setTitle(mapTexture)
const cam = camera(layout, Number(time))
const uniforms = packUniforms(new Float32Array(UNIFORM_FLOATS), {
  width,
  height,
  time: Number(time),
  layout,
  pointer: Deno.env.get('POINTER')?.split(',').map(Number) ?? [-9999, -9999, 0],
  scene: view.scene,
  cam,
  sunCam: sunCamera(Number(time)),
  title: { box: view.title, map },
  dye: liquid.dyeSize,
  show: act,
  dawn: dawnAt(Number(age), [layout.width, view.height], sun),
  gait: gaitAt(layout, view.scene, cam, act.view, act.travel),
})
const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
liquid.draw(texture.createView(), uniforms, [width, height])
if (Deno.env.get('BENCH')) {
  // How long the GPU takes over a frame at this size.
  await device.queue.onSubmittedWorkDone()
  const t0 = performance.now()
  for (let i = 0; i < 40; i++) liquid.draw(texture.createView(), uniforms, [width, height])
  await device.queue.onSubmittedWorkDone()
  console.log(`${width}x${height}: ${((performance.now() - t0) / 40).toFixed(1)} ms a frame`)
}
const stride = Math.ceil((width * 4) / 256) * 256
const pixels = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
const encoder = device.createCommandEncoder()
encoder.copyTextureToBuffer({ texture }, { buffer: pixels, bytesPerRow: stride }, [width, height])
device.queue.submit([encoder.finish()])
await pixels.mapAsync(GPUMapMode.READ)
const data = new Uint8Array(pixels.getMappedRange())
const raw = new Uint8Array(width * height * 4)
for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, y * stride + width * 4), y * width * 4)
const rawPath = `${out}.rgba`
await Deno.writeFile(rawPath, raw)
const { code } = await new Deno.Command('magick', { args: ['-size', `${width}x${height}`, '-depth', '8', `rgba:${rawPath}`, out] }).output()
await Deno.remove(rawPath)
console.log(code === 0 ? `wrote ${out} ${width}x${height}` : 'magick failed')
