const names = ['beam', 'impact', 'strike', 'rain', 'roar', 'flower', 'burn', 'fried', 'built', 'horizon', 'sun-tour', 'sun-excuse', 'sun-resume',
  'fx/tab', 'fx/melt', 'fx/comedown', 'fx/ufo', 'fx/pop', 'fx/whale', 'fx/breach', 'fx/splash', 'fx/stomp', 'fx/stomp2',
  'fx/slam', 'fx/boing', 'fx/gulp', 'fx/sizzle', 'fx/spell', 'fx/wink', 'fx/zoom']
const priorityNames = ['fx/tab', 'fx/melt', 'sun-tour', 'fx/wink', 'fx/comedown', 'sun-excuse', 'sun-resume']
const restNames = names.filter(name => !priorityNames.includes(name))
// The recordings are fetched and pre-decoded ahead of the first press, priority ones first, so that taking the tab sounds at once.
const fetched = new Map()
const decoded = new Map()
const screamWaves = new Map()
let decoder = null
const getDecoder = () => {
  if (decoder !== null) return decoder
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext
  try { decoder = Offline ? new Offline(2, 1, 48000) : false } catch { decoder = false }
  return decoder
}
const fetchSample = name => {
  if (!fetched.has(name)) {
    fetched.set(name, fetch(new URL(`./audio/${name}.mp3`, import.meta.url)).then(res => {
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
      return res.arrayBuffer()
    }))
  }
  return fetched.get(name)
}
const MASTER_GAIN = 0.8
const panValue = x => Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0
const unit = x => Math.max(0, panValue(x))
const fields = ['night', 'rain', 'maw', 'beam', 'tears', 'blood', 'water']
const cooldown = { flower: .29, built: .45, burn: .27, fried: .22, razed: .54, strike: .22,
  roar: 1.1, rain: .18, dry: .18, rainbow: 2, sunset: 2, moonrise: 2, moonset: 2, sunrise: 2, tears: .5, blood: .5, key: .03, cast: .3, step: .12, leap: .2, lift: 2, taken: .5, breach: 1, splash: 1, slam: .5, jump: .5, gulp: .5, scream: .12, tab: 1, comedown: 1, zoom: 1.5, wink: .5, steam: .8, tour: 0 }

// A very small scream: somebody tiny on the way into a mouth. Made here, sample by
// sample, so the film renderer can mix exactly the same one.
export function tinyScream(rate) {
  const wave = new Float32Array(Math.round(0.44 * rate))
  let phase = 0, breath = 0, state = 12345
  for (let i = 0; i < wave.length; i++) {
    const t = i / rate
    // Up to the top of its voice at once, then falling away as it goes in, shaking more and more.
    const pitch = (860 + 560 * Math.min(1, t / 0.05)) * Math.exp(-1.9 * Math.max(0, t - 0.07)) * (1 + (0.012 + 0.11 * t) * Math.sin(2 * Math.PI * 27 * t))
    phase += pitch / rate
    let v = 0
    for (let h = 1; h <= 7; h++) {
      // Two bumps in the throat, as for "aah", pushed up for someone this small.
      const f = pitch * h
      const throat = Math.exp(-(((f - 1500) / 620) ** 2)) + 0.6 * Math.exp(-(((f - 3600) / 800) ** 2)) + 0.12
      v += (throat / h ** 0.35) * Math.sin(2 * Math.PI * phase * h)
    }
    state = (state * 1664525 + 1013904223) >>> 0
    breath += (state / 4294967296 - 0.5 - breath) * 0.5
    const rise = Math.min(1, t / 0.012), fall = t > 0.3 ? Math.exp(-(t - 0.3) / 0.035) : 1
    wave[i] = (0.3 * v + 0.5 * breath) * rise * fall * (0.8 + 0.2 * Math.exp(-t * 9))
  }
  return wave
}

function outputCurve() {
  return Float32Array.from({length: 2049}, (_, i) => {
    const x = i / 1024 - 1, a = Math.abs(x)
    return a <= .64 ? x : Math.sign(x) * (.64 + .20 * (1 - Math.exp(-5 * (a - .64))))
  })
}

function readSample(ctx, name) {
  const host = ctx || getDecoder()
  if (!host) return fetchSample(name).then(() => null)
  const key = `${host.sampleRate || 48000}:${name}`
  if (!decoded.has(key)) {
    const job = fetchSample(name).then(bytes => host.decodeAudioData(bytes.slice(0))).catch(err => {
      decoded.delete(key)
      throw err
    })
    decoded.set(key, job)
  }
  return decoded.get(key)
}

function screamFor(rate) {
  let wave = screamWaves.get(rate)
  if (!wave) {
    wave = tinyScream(rate)
    screamWaves.set(rate, wave)
  }
  return wave
}

function makeLoop(ctx, buffer, dest) {
  const src = ctx.createBufferSource(), gain = ctx.createGain()
  const n = Math.min(Math.round(buffer.sampleRate * .052), buffer.length >> 3)
  // Crossfade the ends once per decoded buffer, then re-enter just past the splice.
  if (!buffer._spliced) {
    buffer._spliced = true
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c)
      for (let j = 0; j < n; j++) {
        const k = (j + 1) / n, tail = ch.length - n + j
        ch[tail] = ch[tail] * Math.cos(k * Math.PI / 2) + ch[j] * Math.sin(k * Math.PI / 2)
      }
    }
  }
  src.buffer = buffer; src.loop = true; src.loopStart = n / buffer.sampleRate
  gain.gain.value = 0; src.connect(gain).connect(dest); src.start()
  return { gain: gain.gain, target: 0 }
}

function loopLevel(loop, value, time, lag) {
  if (!loop || Math.abs(loop.target - value) < .001 && (value !== 0 || loop.target === 0)) return
  loop.target = value; loop.gain.setTargetAtTime(value, time, lag)
}

class Mix {
  constructor(ctx) {
    this.ctx = ctx; this.bus = ctx.createWaveShaper(); this.bus.curve = outputCurve()
    this.master = ctx.createGain(); this.master.gain.value = 0
    this.bus.connect(this.master).connect(ctx.destination)
    this.from = this.to = this.begin = this.end = 0
    this.samples = Object.create(null); this.loops = {}; this.active = new Set()
    this.last = Object.create(null); this.sent = -1; this.armed = false; this.beamX = 0
  }

  async load() {
    const ctx = this.ctx
    const readyVoices = ctx.audioWorklet.addModule(new URL('./voice.worklet.js', import.meta.url)).then(() => {
      this.voice = new AudioWorkletNode(ctx, 'valley-choir', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    })
    const loadOne = async name => {
      try {
        const key = name.replace('fx/', '')
        const buf = await readSample(ctx, name)
        if (buf) {
          this.samples[key] = buf
          if ((key === 'beam' || key === 'rain') && !this.loops[key]) this.loops[key] = makeLoop(ctx, buf, this.bus)
        }
      } catch (e) { console.warn('Valley sound:', name, e) }
    }
    await Promise.all([readyVoices, ...priorityNames.map(loadOne)])
    if (!this.samples.scream) {
      const wave = screamFor(ctx.sampleRate)
      this.samples.scream = ctx.createBuffer(1, wave.length, ctx.sampleRate)
      this.samples.scream.getChannelData(0).set(wave)
    }
    this.choirGain = ctx.createGain()
    this.choirGain.gain.value = 1
    this.voice.connect(this.choirGain).connect(this.bus)
    // A meter on the choir, so the picture can sing along.
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 256
    this.wave = new Float32Array(256); this.voice.connect(this.meter)
    this.restReady = Promise.all(restNames.map(loadOne))
  }

  fade(to, seconds) {
    const t = this.ctx.currentTime, span = this.end - this.begin
    const u = span > 0 ? unit((t - this.begin) / span) : 1
    const from = this.from + (this.to - this.from) * u
    const g = this.master.gain; g.cancelScheduledValues(t); g.setValueAtTime(from, t)
    g.linearRampToValueAtTime(to, t + seconds)
    this.from = from; this.to = to; this.begin = t; this.end = t + seconds
  }

  release() {
    const t = this.ctx.currentTime
    this.fade(0, .48); this.armed = false; this.sent = -1
    this.stopTour(0.48)
    for (const loop of Object.values(this.loops)) loopLevel(loop, 0, t, .045)
    for (const src of this.active) src.stop(t + .48)
    this.last = Object.create(null)
  }

  // The sun's tour (audio/sun-tour.mp3): it stops, and the choir comes back up.
  stopTour(fade = 0.25) {
    if (!this.tour) return
    const { src, gain } = this.tour
    this.tour = null
    const t = this.ctx.currentTime
    try {
      gain.gain.cancelScheduledValues(t)
      gain.gain.setTargetAtTime(0, t, Math.max(0.02, fade * 0.3))
      src.stop(t + fade + 0.05)
    } catch {}
    this.unduck(t, 0.35)
  }

  unduck(t, lag) {
    if (!this.choirGain) return
    this.choirGain.gain.cancelScheduledValues(t)
    this.choirGain.gain.setTargetAtTime(1, t, lag)
  }

  // The sun gives its tour, or a part of it: from detail.offset seconds into the recording (0), for detail.duration
  // seconds (all the rest of it), beginning detail.delay seconds from now (at once). The choir goes under it: well
  // under while it is explaining, up a little, with everything else, once it has lost its head (detail.swell
  // seconds into the recording, if this part gets that far), and back up when it is done. detail.id is whatever
  // the asker wants to know this telling by (see tourTime). detail.clip is one of the other things it was recorded
  // saying in the middle of it ('sun-excuse', 'sun-resume'), given the same way in the tour's place.
  playTour(x = 0, detail = null) {
    const ctx = this.ctx, buf = this.samples[typeof detail?.clip === 'string' ? detail.clip : 'sun-tour']
    if (!buf) return
    this.stopTour(0.1)
    const offset = Math.max(0, Math.min(buf.duration, detail?.offset > 0 ? detail.offset : 0))
    const lasts = Math.max(0, Math.min(buf.duration - offset, detail?.duration > 0 ? detail.duration : Infinity))
    if (!(lasts > 0)) return
    const t = ctx.currentTime + (detail?.delay > 0 ? detail.delay : 0)
    const src = ctx.createBufferSource(), gain = ctx.createGain(), pan = ctx.createStereoPanner()
    src.buffer = buf
    pan.pan.value = x
    // (It comes in over detail.rise seconds: quickly, where a word begins at once.)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(1.05, t + (detail?.rise > 0 ? detail.rise : 0.06))
    // (A part that stops short of the end is faded out, not cut off: over detail.fade seconds.)
    if (offset + lasts < buf.duration - 0.01) {
      gain.gain.setValueAtTime(1.05, t + Math.max(0.06, lasts - (detail?.fade > 0 ? detail.fade : 0.09)))
      gain.gain.linearRampToValueAtTime(0, t + lasts)
    }
    src.connect(gain).connect(pan).connect(this.bus)
    if (this.choirGain) {
      const g = this.choirGain.gain, swell = detail?.swell > 0 ? detail.swell : Infinity
      g.cancelScheduledValues(ctx.currentTime)
      g.setTargetAtTime(0.22, Math.max(ctx.currentTime, t - 0.4), 0.22)
      if (swell > offset && swell < offset + lasts) g.setTargetAtTime(0.36, t + swell - offset, 0.7)
      g.setTargetAtTime(1, t + lasts + 0.25, 0.6)
    }
    this.tour = { src, gain, at: t, offset, id: detail?.id }
    this.active.add(src)
    src.onended = () => {
      this.active.delete(src)
      if (this.tour?.src === src) this.tour = null
      src.disconnect(); gain.disconnect(); pan.disconnect()
    }
    src.start(t, offset, lasts)
  }

  attach(src, gain, x, when) {
    const ctx = this.ctx, pan = ctx.createStereoPanner()
    pan.pan.value = x; src.connect(gain).connect(pan).connect(this.bus)
    this.active.add(src)
    src.onended = () => { this.active.delete(src); src.disconnect(); gain.disconnect(); pan.disconnect() }
    src.start(when)
  }

  hit(name, x, level, rate = 1) {
    const ctx = this.ctx, buf = this.samples[name]
    if (!buf || this.active.size >= 14) return
    if (this.tour) level *= .5 // (the sun is giving its tour: nothing is to be heard over it)
    const t = ctx.currentTime, src = ctx.createBufferSource(), g = ctx.createGain()
    src.buffer = buf; src.playbackRate.value = rate
    const end = t + buf.duration / rate
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + .003)
    g.gain.setValueAtTime(level, end - .024); g.gain.linearRampToValueAtTime(0, end)
    this.attach(src, g, x, t)
  }

  drop(x, bloody) {
    if (this.active.size >= 13) return
    const ctx = this.ctx, t = ctx.currentTime, f = (bloody ? 260 : 640) * (.97 + Math.random() * .09)
    for (let k = 0; k < 2; k++) {
      const onset = t + .17 * k, osc = ctx.createOscillator(), g = ctx.createGain(), base = f * (1 + .42 * k)
      osc.frequency.setValueAtTime(base, onset); osc.frequency.exponentialRampToValueAtTime(base * .66, onset + .13)
      g.gain.setValueAtTime(0, onset); g.gain.linearRampToValueAtTime(k ? .022 : .053, onset + .004)
      g.gain.exponentialRampToValueAtTime(.0001, onset + .24)
      this.attach(osc, g, x, onset); osc.stop(onset + .25)
    }
  }

  level() {
    if (!this.meter) return 0
    this.meter.getFloatTimeDomainData(this.wave)
    let sum = 0
    for (const v of this.wave) sum += v * v
    return Math.min(1, Math.sqrt(sum / 256) * 5)
  }

  // A key on the terminal: a short note from the song's scale.
  blip(x) {
    if (this.active.size >= 13) return
    const ctx = this.ctx, t = ctx.currentTime, osc = ctx.createOscillator(), g = ctx.createGain()
    const f = 233.08 * 2 ** ([0, 3, 5, 7, 10, 12, 15][Math.floor(Math.random() * 7)] / 12)
    osc.type = 'triangle'; osc.frequency.setValueAtTime(f * 2, t); osc.frequency.exponentialRampToValueAtTime(f, t + .03)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.06, t + .004); g.gain.exponentialRampToValueAtTime(.0001, t + .16)
    this.attach(osc, g, x, t); osc.stop(t + .17)
  }

  // The planet's beam: a whistle that climbs.
  whistle(x) {
    if (this.active.size >= 13) return
    const ctx = this.ctx, t = ctx.currentTime, osc = ctx.createOscillator(), g = ctx.createGain(), wob = ctx.createOscillator(), depth = ctx.createGain()
    osc.frequency.setValueAtTime(260, t); osc.frequency.exponentialRampToValueAtTime(1500, t + 2.3)
    wob.frequency.value = 11; depth.gain.value = 28; wob.connect(depth).connect(osc.frequency); wob.start(t); wob.stop(t + 2.5)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.045, t + .25); g.gain.setValueAtTime(.045, t + 2.05)
    g.gain.exponentialRampToValueAtTime(.0001, t + 2.45)
    this.attach(osc, g, x, t); osc.stop(t + 2.5)
  }

  // It leaves the ground.
  spring(x) {
    if (this.active.size >= 13) return
    const ctx = this.ctx, t = ctx.currentTime + .14, osc = ctx.createOscillator(), g = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(150, t); osc.frequency.exponentialRampToValueAtTime(620, t + .22)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.07, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .3)
    this.attach(osc, g, x, t); osc.stop(t + .32)
  }

  // A boot comes down.
  thump(x) {
    if (this.active.size >= 13) return
    const ctx = this.ctx, t = ctx.currentTime, osc = ctx.createOscillator(), g = ctx.createGain()
    osc.frequency.setValueAtTime(96, t); osc.frequency.exponentialRampToValueAtTime(46, t + .09)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.1, t + .006); g.gain.exponentialRampToValueAtTime(.0001, t + .21)
    this.attach(osc, g, x, t); osc.stop(t + .22)
  }

  frame(s, force = false) {
    const t = this.ctx.currentTime, beam = unit(s?.beam)
    loopLevel(this.loops.beam, (this.tour ? .3 : .76) * beam ** .80, t, beam ? .035 : .055)
    if (beam > .40) this.armed = true
    if (this.armed && beam < .09) {
      if (t - (this.last.impact ?? -2) > .22) {
        this.hit('impact', this.beamX, .48, .95 + .1 * Math.random()); this.last.impact = t
      }
      this.armed = false; this.beamX = 0
    }
    if (!force && t - this.sent < .04) return
    this.sent = t
    const data = { type: 'frame', moon: !!s?.moon }
    for (const key of fields) data[key] = unit(s?.[key])
    loopLevel(this.loops.rain, data.rain * (.77 + .23 * data.water), t, data.rain ? .42 : .56)
    this.voice.port.postMessage(data)
  }

  event(kind, x, detail) {
    // The cosmos and the chorus bring their music with them; the choir plays it.
    if (kind === 'stars' || kind === 'chorus') return void (detail?.score && this.voice.port.postMessage({type: 'event', kind, x, score: detail.score}))
    const ctx = this.ctx, t = ctx.currentTime
    if (!Object.hasOwn(cooldown, kind) || t - (this.last[kind] ?? -60) < cooldown[kind]) return
    this.last[kind] = t
    const detune = .93 + .14 * Math.random()
    if (kind === 'built' || kind === 'flower' || kind === 'rainbow') this.voice.port.postMessage({type: 'event', kind, x})
    switch (kind) {
      case 'key': this.blip(x); break
      case 'step': this.hit(Math.random() < .5 ? 'stomp' : 'stomp2', x, .3, detune); break
      case 'leap': this.drop(x, false); this.hit('stomp2', x, .16, detune * 1.3); break
      case 'lift': this.hit('ufo', x, .3); break
      case 'breach': this.hit('breach', x, .62); this.hit('whale', x, .5, detune); break
      case 'slam': this.hit('slam', x, .6); break
      case 'jump': this.hit('boing', x, .5, detune); break
      case 'gulp': this.hit('gulp', x, .85); break
      case 'scream': {
        if (!this.samples.scream) {
          const wave = screamFor(ctx.sampleRate)
          this.samples.scream = ctx.createBuffer(1, wave.length, ctx.sampleRate)
          this.samples.scream.getChannelData(0).set(wave)
        }
        this.hit('scream', x, .2, detune * (.92 + .3 * Math.random()))
        break
      }
      case 'splash': this.hit('splash', x, .62); break
      case 'taken': this.hit('pop', x, .7); break
      case 'wink': this.hit('wink', x, .5); break
      case 'steam': this.hit('sizzle', x, .4, detune); break
      case 'zoom': this.hit('zoom', x, .5, detune); break
      case 'tab': this.hit('tab', 0, .9); this.hit('melt', 0, .42); break
      case 'comedown': this.hit('comedown', 0, .7); break
      case 'cast': this.hit('spell', x, .62, detune); this.hit('built', x, .3, 1.7); this.voice.port.postMessage({type: 'event', kind: 'built', x}); break
      case 'flower': this.hit('flower', x, 1.08, detune); break
      case 'built': this.hit('built', x, .99, detune); break
      case 'burn': this.hit('burn', x, .37, detune); break
      case 'fried': this.beamX = x; this.hit('fried', x, .82, detune); break
      case 'razed': this.beamX = x; this.hit('burn', x, .51, detune * .65); this.hit('impact', x, .32, .72); this.last.impact = t; break
      case 'strike': this.hit('strike', x, .40, detune * .94); break
      case 'roar': this.hit('roar', x, .36, detune * .88); break
      case 'rain': loopLevel(this.loops.rain, .68, t, .32); break
      case 'dry': loopLevel(this.loops.rain, 0, t, .49); break
      case 'tears': case 'blood': this.drop(x, kind === 'blood'); break
      case 'tour': this.playTour(x, detail); break
      case 'rainbow': this.hit('horizon', x, .16, 1.47); break
      default: {
        // Adjacent horizon cues belong to one change of light.
        if (t - (this.last.horizon ?? -60) < 1.2) break
        this.last.horizon = t
        const speed = {sunset: .74, moonrise: 1.16, moonset: .89, sunrise: 1.30}[kind]
        this.hit('horizon', x, .31, speed)
      }
    }
  }
}

export function createSound() {
  let mix, loading, ready = false, wanted = false, timer, version = 0, latest, priorityReady = null
  return {
    get enabled() { return wanted },
    get priorityReady() { return priorityReady ?? Promise.resolve() },
    // Fetch and pre-decode the recordings ahead of the first press, priority clips first.
    prepare() {
      if (priorityReady) return priorityReady
      const dec = getDecoder()
      const boot = ['fx/tab', 'fx/melt', 'sun-tour']
      priorityReady = Promise.all(boot.map(name => (dec ? readSample(dec, name) : fetchSample(name)).catch(() => {}))).then(() => {
        for (const name of priorityNames) if (!boot.includes(name)) (dec ? readSample(dec, name) : fetchSample(name)).catch(() => {})
        for (const name of restNames) (dec ? readSample(dec, name) : fetchSample(name)).catch(() => {})
      })
      ;(globalThis.requestIdleCallback ?? (fn => setTimeout(fn, 60)))(() => screamFor(dec?.sampleRate || 48000))
      return priorityReady
    },
    // Unlock the AudioContext synchronously inside an early gesture while the page is still arming.
    unlock() {
      try {
        if (!mix || mix.ctx.state === 'closed') {
          const Context = globalThis.AudioContext || globalThis.webkitAudioContext
          if (!Context) return
          mix = new Mix(new Context({latencyHint: 'interactive'})); loading = null; ready = false
        }
        clearTimeout(timer)
        mix.ctx.resume().catch(() => {})
        loading ??= mix.load()
      } catch {}
    },
    async enable() {
      if (wanted && ready && mix?.ctx.state === 'running') return
      const token = ++version
      wanted = true; clearTimeout(timer)
      try {
        if (!mix || mix.ctx.state === 'closed') {
          const Context = globalThis.AudioContext || globalThis.webkitAudioContext
          if (!Context) { wanted = false; return }
          mix = new Mix(new Context({latencyHint: 'interactive'})); loading = null; ready = false
        }
        // Unlock in the gesture stack, before fetching or awaiting anything.
        const ctx = mix.ctx, unlocked = ctx.resume()
        loading ??= mix.load()
        await Promise.all([unlocked, loading])
        if (!wanted || token !== version) return
        ready = true; mix.frame(latest, true); mix.fade(MASTER_GAIN, 2)
      } catch (e) {
        if (token !== version) return
        console.warn('Valley sound unavailable:', e)
        wanted = ready = false; loading = null
        const ctx = mix?.ctx; mix = null
        if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {})
      }
    },
    disable() {
      if (!wanted) return
      wanted = false; latest = null; const token = ++version
      try {
        if (!mix) return
        mix.release()
        timer = setTimeout(() => {
          if (token === version && !wanted) mix.ctx.suspend().catch(() => {})
        }, 510)
      } catch { /* already closed */ }
    },
    // Whether it can be heard yet: wanted, and everything loaded.
    get ready() { return wanted && ready },
    // How far into the recording of its tour the sun is being heard to be, in seconds, wherever in it this telling
    // began (less what the way out to the speakers takes; being recorded, by way of stream(), nothing: the
    // recording hears it at once). Before a telling that is still to begin, less than where it begins. null when
    // it is not giving it, or, asked about one telling (the id it was begun with), when it is giving another.
    tourTime(id) {
      if (!wanted || !ready || !mix?.tour || (id !== undefined && mix.tour.id !== id)) return null
      const ctx = mix.ctx
      return mix.tour.offset + ctx.currentTime - mix.tour.at - (mix.tap ? 0 : Math.min(.25, ctx.outputLatency || 0))
    },
    pitchTime(id) { return this.tourTime(id) },
    // (The same of whichever of its other recordings it is giving in the tour's place: seconds into that one.)
    clipTime(id) { return this.tourTime(id) },
    event(kind, detail) {
      if (!wanted || !ready) return
      try {
        // The sun speaks: the choir's fifth throat says line detail.line, or stops.
        if (kind === 'say' || kind === 'hush') {
          if (kind === 'hush') mix.stopTour(0.25)
          mix.voice.port.postMessage({ type: 'event', kind, x: detail?.line ?? 0 })
        }
        else mix.event(kind, panValue(detail?.x), detail)
      } catch { /* interrupted audio session */ }
    },
    // Tap the live mixed output as a MediaStream when recording a clip.
    stream() {
      if (!mix) return null
      if (!mix.tap) {
        mix.tap = mix.ctx.createMediaStreamDestination()
        mix.master.connect(mix.tap)
      }
      return mix.tap.stream
    },
    // How loud the choir is right now, 0 to 1.
    level() {
      if (!wanted || !ready) return 0
      try { return mix.level() } catch { return 0 }
    },
    frame(state) {
      if (!wanted) return
      latest = state
      if (ready) { try { mix.frame(state) } catch { /* interrupted audio session */ } }
    },
  }
}
