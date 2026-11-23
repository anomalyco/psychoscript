const TAU = 2 * Math.PI
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const unit = x => clamp(Number.isFinite(x) ? x : 0, 0, 1)
const mix = (a, b, t) => a + (b - a) * t
const smooth = x => (x = unit(x), x * x * (3 - 2 * x))
const semitone = n => 2 ** (n / 12)

function dice(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

// Flow derivative: exponential opening sinusoid joined to an exponential return.
// Balance the areas so a closed cycle leaves no DC flow behind.
const TABLE = 1024
function foldPulse(tp, te, ta) {
  const w = Math.PI / tp, sin = Math.sin(w * te), cos = Math.cos(w * te)
  const tail = Math.exp(-(1 - te) / ta)
  const returnArea = ta - (1 - te) * tail / (1 - tail)
  let lo = -9, hi = 38
  for (let j = 0; j < 48; j++) {
    const a = (lo + hi) / 2
    const area = -(a * sin - w * cos + w * Math.exp(-a * te)) / ((a * a + w * w) * sin)
    if (area > returnArea) lo = a
    else hi = a
  }
  const out = new Float32Array(TABLE + 1)
  for (let i = 0; i <= TABLE; i++) {
    const t = i / TABLE
    out[i] = t <= te ? -Math.exp(hi * (t - te)) * Math.sin(w * t) / sin
      : -(Math.exp(-(t - te) / ta) - tail) / (1 - tail)
  }
  return out
}
const pulses = [foldPulse(.38, .58, .019), foldPulse(.44, .65, .036), foldPulse(.48, .71, .054)]

// Tongue position, aperture, width, jaw opening and lip opening (oo, oh, ah, ee).
const vowels = [[.61, .83, .15, .88, .52], [.52, 1.04, .16, 1.40, 1.02],
  [.35, .86, .15, 2.42, 2.48], [.75, .58, .17, 1.10, 1.83]]
const entries = [[0, 0, 0, -2], [1, 5, 6, 7, 3], [12, 13, 10, 6, 12], [19, 18, 17, 15, 13]]
const cadences = [[0, 0], [7, 3], [12, 10], [19, 12]]
const partials = [6, 8, 9, 7, 11, 10, 8, 6, 5]

// The stars that play in the cosmos: each note a handful of decaying partials, mixed
// by kind (0 glass, 1 bell, 2 bowed, 3 a soft pluck), as [ratio, level, seconds to
// ring out at 440 Hz] (0: held, for the bowed). A partial is a phasor turned a step
// every sample, so a note costs a few multiplies for each.
const CHIMES = [
  [[1, 1, 2.6], [2.76, .3, .9], [5.4, .11, .38], [8.93, .04, .2]],
  [[1, 1, 3.6], [2, .42, 2.1], [2.4, .26, 1.6], [3, .17, 1], [4.2, .07, .5]],
  [[1, .8, 0], [1.004, .55, 0], [2, .26, 0], [3, .1, 0]],
  [[1, 1, 1.5], [2, .4, .45], [3, .2, .22], [4, .1, .14], [5, .05, .1]],
]
class Chime {
  constructor() {
    this.re = new Float64Array(6); this.im = new Float64Array(6); this.c = new Float64Array(6)
    this.s = new Float64Array(6); this.amp = new Float64Array(6); this.n = this.life = this.env = 0
  }
  strike(rate, f, kind, loud, pan) {
    let n = 0
    for (const [ratio, level, ring] of CHIMES[kind]) {
      const hz = f * ratio
      if (hz > Math.min(9000, rate * .45)) continue
      const w = TAU * hz / rate, r = ring ? Math.exp(-1 / (ring * Math.sqrt(440 / f) * rate)) : 1
      this.c[n] = r * Math.cos(w); this.s[n] = r * Math.sin(w); this.re[n] = 1; this.im[n] = 0; this.amp[n++] = level
    }
    this.n = n; this.kind = kind; this.level = loud; this.env = 0
    this.attack = 1 - Math.exp(-1 / ((kind === 2 ? .32 : .0025) * rate))
    this.held = kind === 2 ? Math.round(.9 * rate) : 0
    this.fall = Math.exp(-1 / (1.3 * rate))
    this.life = Math.round((kind === 1 ? 7 : 5.5) * rate)
    this.left = Math.sqrt(.5 - pan * .5); this.right = Math.sqrt(.5 + pan * .5)
  }
  sample() {
    this.life--
    let out = 0
    for (let j = 0; j < this.n; j++) {
      const a = this.re[j], b = this.im[j]
      this.re[j] = a * this.c[j] - b * this.s[j]; this.im[j] = a * this.s[j] + b * this.c[j]
      out += this.im[j] * this.amp[j]
    }
    if (this.kind !== 2 || this.held-- > 0) this.env += this.attack * (this.level - this.env)
    else this.env *= this.fall
    return out * this.env
  }
}

// Wavetables for the creatures' voices: a soft square (the walkers and the terminal) and a sine.
const SQUARE = Float32Array.from({length: TABLE + 1}, (_, i) => {
  const x = TAU * i / TABLE
  return .8 * (Math.sin(x) + .27 * Math.sin(3 * x) + .1 * Math.sin(5 * x) + .04 * Math.sin(7 * x))
})
const SINE = Float32Array.from({length: TABLE + 1}, (_, i) => Math.sin(TAU * i / TABLE))
const read = (table, phase) => { const p = phase * TABLE, j = p | 0; return table[j] + (p - j) * (table[j + 1] - table[j]) }

// The cosmos and the chorus (show.cosmos and show.chorus in liquid.js write the
// music; this plays it). The stars' notes are struck at the exact sample they are
// due, in the choir's key as it is when each comes, and echo across the sky. In the
// chorus the four throats are drawn onto each chord, and the creatures join in, each
// kind with a small voice of its own: the walkers bleep on the beat, the flowers
// hum, the terminal sings the tune, and the planet booms.
class Cosmos {
  constructor(rate) {
    this.rate = rate; this.clock = this.until = this.due = this.next = 0; this.live = false; this.l = this.r = 0
    this.notes = []; this.chimes = Array.from({length: 12}, () => new Chime()); this.home = 0
    const n = Math.round(rate * .45); this.echo = [new Float32Array(n), new Float32Array(n)]; this.at = 0; this.dull = [0, 0]
    this.song = null; this.starsUntil = 0
    // walkers (3), flowers (2), the terminal, the planet: phase, frequency, how loud now and wanted
    this.voices = Array.from({length: 7}, () => ({phase: 0, f: 100, glide: 100, gain: 0, goal: 0}))
    this.vib = 0
  }

  cue(kind, score, choir) {
    if (!score) return
    const r = this.rate
    if (kind === 'stars' && Array.isArray(score) && score.length) {
      this.notes = score.map(([at, degree, kind, loud, pan]) => ({at: this.clock + Math.round(at * r), degree, kind, loud, pan}))
      this.due = 0
      this.starsUntil = this.notes.at(-1).at
      this.until = Math.max(this.until, this.starsUntil + 8 * r)
      choir.change = Math.max(choir.change, choir.now + (this.starsUntil - this.clock) / r + 2) // the key holds still while they play
    } else if (kind === 'chorus') {
      this.song = {from: this.clock, ...score}
      this.until = Math.max(this.until, this.clock + Math.round((score.lasts + 1) * r))
      choir.change = Math.max(choir.change, choir.now + score.lasts + 2)
    } else return
    this.live = true
  }

  control(choir) {
    this.home = choir.root + choir.s.night * 3.5
    const singers = choir.singers, song = this.song
    const align = this.clock < this.starsUntil + this.rate ? 1 : 0
    for (const singer of singers) { singer.align += (align - singer.align) * .02; singer.choral = 0 }
    for (const v of this.voices) v.goal = 0
    if (!song) return
    const a = (this.clock - song.from) / this.rate
    if (a >= song.lasts) { this.song = null; return }
    const m = smooth(a / 1.2) * smooth((song.lasts - a) / 1.6)
    let chord = song.chords[0][1]
    for (const [at, notes] of song.chords) if (a >= at) chord = notes
    const beats = a / song.beat, k = beats % 1, held = a >= song.home && a < song.release
    const open = k < .1 ? k / .1 : Math.exp(-(k - .1) * 3)
    const swell = smooth(a / (song.home + .6)) * smooth((song.lasts - a) / (song.lasts - song.release))
    singers.forEach((singer, j) => {
      singer.choral = m; singer.choralNote = this.home + chord[j]
      singer.choralEnv = [1.25, 1.05, .9, .8][j] * (.8 + .45 * swell); singer.choralVowel = held ? 2 : 1.4 + .8 * open
    })
    const hz = n => 58.27 * semitone(this.home + n), v = this.voices
    // The walkers: a bleep each beat, a held note on the home chord.
    for (let j = 0; j < 3; j++) { v[j].glide = hz(chord[j + 1] + 24); v[j].goal = m * (held ? .8 : Math.exp(-k * song.beat / .16)) * .2 }
    // The flowers: a hum, swaying.
    for (let j = 0; j < 2; j++) { v[3 + j].glide = hz(chord[j + 2] + 36); v[3 + j].goal = m * (.55 + .45 * Math.sin(Math.PI * beats + j * 1.7)) * .09 }
    // The terminal: the tune.
    let note = song.tune[0][1]
    for (const [beat, n] of song.tune) if (beats >= beat) note = n
    v[5].glide = hz(note); v[5].goal = m * (a < song.release ? .3 : .3 * smooth((song.lasts - a) / 1.2))
    // The planet: a boom every other beat.
    v[6].glide = hz(chord[0] + 12); v[6].goal = m * (.5 + .5 * Math.exp(-(beats % 2) * 1.6)) * .28
  }

  strike(note) {
    const chime = this.chimes[this.next]
    this.next = (this.next + 1) % this.chimes.length
    chime.strike(this.rate, 58.27 * semitone(this.home + note.degree), note.kind, note.loud, note.pan)
  }

  sample() {
    while (this.due < this.notes.length && this.notes[this.due].at <= this.clock) this.strike(this.notes[this.due++])
    let l = 0, r = 0
    for (const chime of this.chimes) {
      if (chime.life <= 0) continue
      const a = chime.sample()
      l += a * chime.left; r += a * chime.right
    }
    // Echoes, each from the other side of the sky, duller each time.
    const e = this.echo, j = this.at, back0 = e[0][j], back1 = e[1][j]
    this.dull[0] += .35 * (back1 - this.dull[0]); this.dull[1] += .35 * (back0 - this.dull[1])
    e[0][j] = l + .42 * this.dull[0]; e[1][j] = r + .42 * this.dull[1]
    if (++this.at >= e[0].length) this.at = 0
    l = .62 * (l + .45 * back0); r = .62 * (r + .45 * back1)
    // The creatures.
    const v = this.voices, rate = this.rate
    this.vib += 5.6 / rate
    for (let i = 0; i < 7; i++) {
      const c = v[i]
      c.gain += (c.goal - c.gain) * .0015
      if (c.gain < 1e-5 && c.goal === 0) continue
      c.f += (c.glide - c.f) * (i === 5 ? .0009 : .004)
      const wobble = i === 5 ? 1 + .006 * Math.sin(TAU * this.vib) : 1 + .002 * (i - 1)
      c.phase += c.f * wobble / rate; c.phase -= c.phase | 0
      const x = i < 3 || i === 5 ? read(SQUARE, c.phase) : read(SINE, c.phase) + (i === 6 ? .3 * read(SINE, (2 * c.phase) % 1) : 0)
      const pan = [-.55, .1, .6, -.8, .8, .45, -.3][i], a = x * c.gain
      l += a * (.7 - .5 * pan); r += a * (.7 + .5 * pan)
    }
    this.l = l; this.r = r
    if (++this.clock >= this.until) this.live = false
  }
}

class Singer {
  constructor(id, rate, seed) {
    this.id = id; this.rate = rate; this.rand = dice(seed)
    this.n = Math.max(12, 2 * Math.round([48, 44, 40, 38][id] * rate / 96000))
    this.r = new Float32Array(this.n); this.l = new Float32Array(this.n)
    this.k = new Float32Array(this.n)
    this.noise = (seed | 0) || 1; this.phase = this.rand(); this.shimmer = 1; this.jitter = 1
    this.pulse = pulses[Math.min(id, 2)]; this.parity = 1
    this.pan = [-.10, -.64, .57, .26][id]
    this.f0 = 58 * semitone(entries[id][0]); this.step = this.f0 / rate
    this.gain = this.volume = this.lipState = this.chest = this.dc = this.dark = 0
    this.vowel = this.rasp = 0
    this.overLo = this.overBand = 0; this.harm = 6; this.hIdx = 0; this.newHarm = 1
    this.hp = 1 - Math.exp(-TAU * 24 / rate); this.lp = 1 - Math.exp(-TAU * 3400 / rate)
    this.slew = 1 - Math.exp(-1 / (.022 * rate))
    this.vib = this.rand() * TAU; this.drift = this.rand() * TAU
    this.age = -[0, 2.7, 6.1, 11.4][id]; this.duration = [14, 8, 9, 6][id]; this.rest = 2
    this.start = entries[id][0]; this.end = cadences[id][0]; this.word = this.rand(); this.durationBias = this.rand()
    this.answerTime = -1; this.answerKind = 0; this.answerPan = 0
    this.choral = this.choralNote = this.choralEnv = this.choralVowel = this.align = 0
  }

  answer(x, flower) {
    this.answerTime = 0; this.answerPan = x * .78; this.answerKind = flower ? 1 : 0
  }

  phrase(s) {
    const i = this.id, r = this.rand
    this.start = entries[i][Math.floor(r() * entries[i].length)]
    this.end = cadences[i][r() < .73 ? 0 : 1]
    this.duration = (i ? 4.1 + r() * 7.7 : 13 + r() * 12) * (1 - s.night * .19)
    this.rest = (i ? 1.7 + r() * (3.6 + s.night * 8) : .7 + r() * 1.5) * (1 - s.rain * .69)
    this.word = r(); this.durationBias = r(); this.age = 0
  }

  shape(v, closure, maw) {
    const a = Math.min(2, Math.floor(v)), t = v - a, p = vowels[a], q = vowels[a + 1]
    const tongue = mix(p[0], q[0], t), aperture = mix(p[1], q[1], t)
    const width = mix(p[2], q[2], t), jaw = mix(p[3], q[3], t)
    const lips = mix(p[4], q[4], t) * (1 - .83 * closure)
    let previous = 0
    for (let j = 0; j < this.n; j++) {
      const u = (j + .5) / this.n
      const bowl = 2.35 + jaw * smooth((u - .44) * 3) - 1.25 * Math.exp(-((u - .10) ** 2) / .004)
      let d = mix(bowl, aperture, Math.exp(-.5 * ((u - tongue) / width) ** 2))
      d = mix(d, lips, smooth((u - .84) / .16))
      d += maw * .18 * smooth((u - .6) * 3)
      const area = d * d
      if (j) this.k[j] = (previous - area) / (previous + area)
      previous = area
    }
    this.lipGain = .35 + .65 * Math.sqrt(lips)
    this.jet = Math.min(this.n - 2, Math.round(tongue * this.n / 2) * 2)
  }

  control(dt, now, s, root) {
    const i = this.id, maw = i === 0 ? s.maw : 0
    this.age += dt
    if (this.age > this.duration + this.rest) this.phrase(s)
    const p = unit(this.age / this.duration)
    const breath = smooth(this.age / (i ? .95 : 1.45)) * smooth((this.duration - this.age) / (i ? 1.6 : 2.1))
    this.vib += dt * TAU * (4.16 + .24 * i + .18 * Math.sin(now * .72 + this.drift))
    const rock = Math.sin(now * .29 + this.drift)
    let note = root + mix(this.start, this.end, smooth((p - .62 - .09 * this.durationBias) / .22))
    note += (i ? 3.5 : 2) * s.night + (i === 2 ? 1.0 : i === 1 ? -.48 : 0) * s.blood
    note += (i ? .016 : .032) * rock
    note -= 6.5 * maw
    let env = Math.max(breath, .94 * maw) * [1.0, .64, .43, .31][i]
    env *= (1 - s.night * (i === 3 ? .04 : .36)) * (1 + s.rain * (i ? .40 : .05))
    let v = i ? mix(.10 + .65 * this.word, 2.2 + .77 * this.word, smooth(p * 1.1))
      : 1.15 + .89 * Math.sin(.23 * now + .4 * rock) + .23 * rock
    v += .13 * Math.sin(9 * p + this.drift) + s.night * .48 + s.tears * .21
    v = mix(v, 2, maw)
    let pan = [-.10, -.64, .57, .26][i], closure = 0
    if (this.word > .44 && breath > 0) closure = smooth(1 - Math.abs(this.age - this.duration * .49) / .21) * (1 - maw)
    if (this.answerTime >= 0) {
      const a = this.answerTime, dur = this.answerKind ? 1.5 : 2.3
      const lift = smooth(a / (dur * .60)), m = smooth(a / .12) * smooth((dur - a) / .40)
      const home = root + s.night * 3.5
      note = mix(note, home + (this.answerKind ? 14 + 5 * lift : 7 + 5 * lift), m)
      env = mix(env, this.answerKind ? .65 : .75, m); v = mix(v, .46 + 2.12 * lift, m)
      pan = mix(pan, this.answerPan, m); this.answerTime = a + dt >= dur ? -1 : a + dt
    }
    note += this.align * (i ? 0 : 1.5 * s.night) // while the stars play the drone keeps to their key, night or day
    if (this.choral > 0) {
      // Everybody singing (see Cosmos): onto the chord, quickly, mouths open.
      const m = this.choral
      note = mix(note, this.choralNote, m); env = mix(env, this.choralEnv, m); v = mix(v, this.choralVowel, m); closure *= 1 - m
      this.f0 += (58.27 * semitone(note) - this.f0) * (1 - Math.exp(-dt / .09)) * m
    }
    this.f0 += (58.27 * semitone(note) - this.f0) * (1 - Math.exp(-dt / (this.answerTime >= 0 ? .10 : .44)))
    this.step = this.f0 * (1 + .0027 * Math.sin(this.vib) * (.4 + breath + s.tears)) / this.rate
    this.vowel += (clamp(v, 0, 3) - this.vowel) * (1 - Math.exp(-dt / .12))
    this.pan += (pan - this.pan) * .15; this.left = Math.sqrt(.5 - this.pan * .5); this.right = Math.sqrt(.5 + this.pan * .5)
    this.shape(this.vowel, closure, maw)
    this.volume = env * (1 - .44 * closure)
    this.asp = .007 + .013 * s.tears + .037 * maw
    this.turb = closure * .045 + .006 * maw
    this.rasp = i ? .012 : .07 + .35 * maw + .07 * s.rain
    this.inhale = .018 * smooth(1 - Math.abs(this.age - this.duration - .36) / .45)
    this.wet = .15 + .085 * s.water
    if (now >= this.newHarm) {
      this.hIdx = (this.hIdx + (this.rand() < .83 ? 1 : 3)) % partials.length
      this.newHarm = now + 1.6 + this.rand() * 3.1
    }
    this.harm += (partials[this.hIdx] - this.harm) * (1 - Math.exp(-dt / .43))
    this.bandF = 2 * Math.sin(Math.PI * Math.min(.24, this.f0 * (this.harm + .06 * rock) / this.rate))
    this.focus = i ? .14 : (1.22 - .77 * maw) * (1 - .22 * s.night)
  }

  sample() {
    let z = this.noise; z ^= z << 13; z ^= z >>> 17; this.noise = z ^ (z << 5)
    const noise = this.noise * 4.656612873077393e-10
    let ph = this.phase + this.step * this.jitter
    if (ph >= 1) {
      ph -= 1; this.jitter = 1 + .004 * noise; this.shimmer = 1 + .022 * noise; this.parity = -this.parity
    }
    this.phase = ph
    const pos = ph * TABLE, j = pos | 0, pulse = this.pulse
    const fold = (pulse[j] + (pos - j) * (pulse[j + 1] - pulse[j])) * this.shimmer * (1 + this.rasp * this.parity)
    this.gain += this.slew * (this.volume - this.gain)
    const air = this.gain * (fold + this.asp * (.3 + .7 * ph) * noise) + this.inhale * noise
    const r = this.r, l = this.l, k = this.k, n = this.n
    // Odd and even junctions scatter on opposite half-ticks. Each section
    // spans c/(2*rate) metres without computing two copies of the same wave.
    for (let j = 1; j < n; j += 2) {
      const a = r[j - 1], b = l[j], d = k[j] * (a - b)
      r[j] = a + d; l[j - 1] = b + d
    }
    const mouth = r[n - 1]; this.lipState += .59 * (mouth - this.lipState)
    l[n - 1] = -.79 * this.lipState
    r[0] = air + (.72 - .17 * ph) * l[0]
    for (let j = 2; j < n; j += 2) {
      const a = r[j - 1], b = l[j], d = k[j] * (a - b)
      r[j] = a + d; l[j - 1] = b + d
    }
    r[this.jet] += this.turb * this.gain * noise
    this.chest += .035 * (air - this.chest)
    const radiation = mouth * this.lipGain + .23 * this.chest
    // Select a partial from the radiated voice, not a second oscillator.
    this.overLo += this.bandF * this.overBand
    this.overBand += this.bandF * (radiation - this.overLo - .11 * this.overBand)
    const focused = radiation + this.focus * .31 * this.overBand
    this.dc += this.hp * (focused - this.dc)
    this.dark += this.lp * (focused - this.dc - this.dark)
    return this.dark
  }
}

// What the sun says, and when. Each line is [when, words, phones]: when is the
// moment the show says it at ('catch' is a catchphrase said by itself), words
// are only for reading here, and the phones are written by hand (below), with
// 1 after a stressed vowel, : after a long one, @n after a vowel to sing it n
// semitones from the speaking note, and , for a breath. The show picks lines
// by when; the film's say=n says line n.
export const SAYINGS = [
  ['greet', 'Salve, munde.', 's A1 l w e: , m U1 n d e:'],
  ['beam', 'Ardeat.', 'A1 r d e A t'],
  ['beam', 'Ignis.', 'I1 N n I s'],
  ['razed', 'Delenda est.', 'd e: l E1 n d A E s t'],
  ['flower', 'Floreat.', 'f l o1: r e A t'],
  ['sunset', 'Nox venit.', 'n O1 k s w E1 n I t'],
  ['sunrise', 'Sol invictus.', 's o1: l I n w I1 k t U s'],
  ['rain', 'Pluit.', 'p l u1 I t'],
  ['come', 'Venite.', 'w E n i1: t E'],
  ['thanks', 'Gratias.', 'g r A1: t I A: s'],
  ['burnt', 'Non serviam.', 'n o1: n s E1 r w I A m'],
  ['host', 'Quid erat illud?', 'k w I d E1 r A t I1 l l U d@5'],
  ['cast', 'Scripta manent.', 's k r I1 p t A m A1 n E n t'],
  ['wild', 'Nothing unusual happens here.', 'n V1 T I N V n j u1 Z u x l h ae1 p x n z h I1 R'],
  ['wild', 'A perfectly normal scripting language.', 'x p 3 f I k t l i n O1 R m x l s k R I1 p t I N l ae1 N g w I d Z'],
  ['catch', 'Modus codicis.', 'm O1 d U s k o1: d I k I s'],
  ['catch', 'Code mode.', 'k ou1 U d , m ou1 U d'],
  ['catch', 'In codice veritas.', 'I n k o1: d I k e: w e1: r I t A: s'],
  ['catch', 'Veni, vidi, scripsi.', 'w e1: n i: , w i1: d i: , s k r i1: p s i:'],
  ['catch', 'Carpe codicem.', 'k A1 r p E k o1: d I k E m'],
  ['catch', 'Omnia in codice.', 'O1 m n I A I n k o1: d I k e:'],
  ['catch', 'Hello, world.', 'h x l o1 U , w 31 l d'],
  ['catch', 'Psychoscript.', 's A1 I k o s k R I p t'],
]

// The articulators, in order: where the tongue's body is along the tract (0 at
// the glottis, 1 at the lips) and how close it comes to the roof, how wide its
// hump is, the jaw, the lips' opening, where the tip or blade makes a
// constriction and how open it leaves it, the velum, voicing, breath at the
// glottis, hiss at the constriction and its colour in kHz, the pitch in
// semitones, loudness, and for the face only: lips rounded, tongue tip shown,
// brows raised, and how far the lips are seen apart.
const ART = ['tongue', 'height', 'width', 'jaw', 'lips', 'place', 'close', 'velum', 'voice', 'asp', 'fric', 'hiss', 'pitch', 'loud', 'round', 'tip', 'brow', 'open']
const A = Object.fromEntries(ART.map((k, i) => [k, i]))
// How long each takes to move from one target to the next, in seconds.
const glide = [.10, .09, .09, .09, .03, .03, .018, .11, .016, .025, .018, .03, .07, .06, .07, .05, .2, .045]
const rest = [.5, 1.2, .16, .9, .9, .8, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0]
const OPEN = 3
// Vowels: tongue, height, width, jaw, lips, round.
const V = (tongue, height, width, jaw, lips, open, round = 0) => ({ tongue, height, width, jaw, lips, open, round, close: OPEN, velum: 0, voice: 1, asp: 0, fric: 0, vowel: 1 })
// How loud each vowel's tract leaves the voice, evened out (open vowels a little louder, close ones softer), in dB.
const EVEN = { i: 0.1, I: 3.8, e: 6.3, E: 3.5, ae: 4, A: 0.6, V: -1.4, x: 3.1, O: -7.6, o: -14.8, U: -13.7, u: -12.1, 3: -2.3, ou: -9.6 }
// Fitted to an adult man's formants (Peterson and Barney; Hillenbrand) by .preview/speak/fit.mjs.
const PHONES = {
  i: V(.649, .433, .176, 2.345, 2.551, .25), I: V(.656, .83, .231, 2.265, 2.873, .35), e: V(.637, .944, .248, 2.345, 3, .42),
  E: V(.692, 1.511, .168, 2.617, 3, .58), ae: V(.694, 2.367, .12, 2.417, 3, .8), A: V(.264, .882, .224, 1.427, 1.747, 1),
  V: V(.347, .937, .259, .5, 1.513, .7), x: V(.486, .749, .242, 2.811, 2.228, .45), O: V(.298, .662, .08, 2.083, 1.428, .75, .6),
  o: V(.434, 1.144, .204, 2.445, .749, .55, .85), U: V(.556, .992, .194, 2.006, .962, .38, .7), u: V(.525, .379, .085, 1.172, 1.215, .3, 1),
  3: { ...V(.378, 1.935, .149, 1.959, 2.151, .35, .5), place: .711, close: .657 },
  // English oʊ as in code starts here (F2 1300) and glides to U (F2 1000), rounding as it goes.
  ou: V(.461, 2.6, .249, 1.605, 1.266, .5, .4),
  // Stops: a closure; voiceless ones are breathed out after it opens.
  p: { lips: 0, open: 0, place: .97, voice: 0, stop: 1 }, b: { lips: 0, open: 0, place: .97, voice: .45, stop: 1 },
  t: { open: .18, place: .86, close: 0, voice: 0, stop: 1, tip: .3 }, d: { open: .18, place: .86, close: 0, voice: .45, stop: 1, tip: .3 },
  k: { place: .63, close: 0, voice: 0, stop: 1 }, g: { place: .63, close: 0, voice: .45, stop: 1 },
  // Nasals let the air out through the nose.
  m: { lips: 0, open: 0, place: .97, velum: .9, voice: 1, close: OPEN, nasal: 1 }, n: { open: .18, place: .86, close: 0, velum: .55, voice: 1, nasal: 1, tip: .3, tongue: .62, height: 1.1 },
  N: { place: .63, close: 0, velum: .55, voice: 1, nasal: 1 },
  // Fricatives: a narrow gap the air hisses through.
  f: { open: .08, lips: .16, place: .97, close: OPEN, fric: 1.6, hiss: 7, voice: 0, fricative: 1 }, v: { open: .08, lips: .16, place: .97, close: OPEN, fric: 1.1, hiss: 7, voice: .45, fricative: 1 },
  T: { open: .22, place: .93, close: .16, fric: .7, hiss: 6.5, voice: 0, tip: 1, fricative: 1 }, D: { open: .22, place: .93, close: .18, fric: .5, hiss: 6.5, voice: .5, tip: 1, fricative: 1 },
  s: { open: .16, place: .89, close: .11, fric: 1.4, hiss: 7, voice: 0, jaw: .9, fricative: 1 }, z: { open: .16, place: .89, close: .12, fric: .9, hiss: 7, voice: .45, jaw: .9, fricative: 1 },
  S: { open: .24, place: .8, close: .2, fric: .9, hiss: 3.3, voice: 0, lips: .9, round: .6, fricative: 1 }, Z: { open: .24, place: .8, close: .2, fric: 1, hiss: 3.3, voice: .45, lips: .9, round: .6, fricative: 1 },
  h: { asp: 1, voice: 0, close: OPEN },
  // The rest: l, Latin's tapped r, English r, w and y.
  l: { open: .25, place: .86, close: .9, tongue: .42, height: 1.2, voice: 1, tip: .7, liquid: 1 },
  r: { open: .25, place: .86, close: 0, voice: 1, tap: 1, tip: .4 },
  R: { loud: .6, open: .25, tongue: .6, height: .8, place: .74, close: .55, lips: .95, round: .5, voice: 1, liquid: 1 },
  w: { loud: .15, open: .12, tongue: .55, height: .8, lips: .45, round: 1, voice: 1, close: OPEN, liquid: 1 },
  j: { open: .22, tongue: .7, height: .45, voice: 1, close: OPEN, liquid: 1, lips: 1.7 },
  ',': { voice: 0, asp: 0, fric: 0, pause: 1 },
}

// Lay a line out in time: for each articulator the spans where some phone holds
// it at a target. Anything a phone leaves alone is carried over from its
// neighbours, so a k before o is already rounded (coarticulation).
const laid = new Map()
function lay(line) {
  if (laid.has(line)) return laid.get(line)
  const tokens = (SAYINGS[line]?.[2] ?? '').split(/\s+/).filter(Boolean)
  const spans = ART.map(() => [])
  const vowels = [], phones = []
  let t = .18
  const hold = (from, to, values) => { for (const k in values) if (k in A) spans[A[k]].push([from, to, values[k]]) }
  tokens.forEach((token, at) => {
    const m = token.match(/^([^1:@]+)(1?)(:?)(?:@(-?\d+))?$/)
    if (!m) throw new Error(`what is ${token}?`)
    const p = PHONES[m[1]]
    if (!p) throw new Error(`no phone ${m[1]}`)
    const stress = m[2] === '1', long = m[3] === ':'
    const next = PHONES[tokens[at + 1]?.replace(/[1:].*$/, '').replace(/@.*/, '')]
    const voiceless = p.stop && !p.voice, from = t
    if (p.vowel) {
      const span = (stress ? .2 : .115) * (long ? 1.45 : 1) * (next?.vowel ? .8 : 1)
      hold(t, t + span, { ...p, loud: (stress ? 1 : .85) * 10 ** (EVEN[m[1]] / 20), brow: stress ? 1 : 0 })
      vowels.push({ from: t, to: t + span, stress, sung: m[4] === undefined ? null : +m[4] })
      t += span
    } else if (p.stop) {
      // Shorter held after another stop, as in pt and kt.
      const after = PHONES[tokens[at - 1]?.replace(/[1:@].*$/, '')]
      const shut = after?.stop ? .04 : .07
      // Shut at the velum too, or a nasal next door leaks in.
      hold(t, t + shut, { velum: 0, ...p, fric: 0, asp: 0 })
      t += shut
      // The release: a burst of noise where it opens, then breath for a voiceless one.
      // Before a stop, nasal or fricative it is hardly let go at all.
      const held = next && (next.stop || next.nasal || next.fricative)
      // From the tongue's back it rings near the next vowel's second formant: low before a rounded one.
      const velar = next?.round ? 1.4 : 2.6
      // Before a breath or at the end it is let go softly.
      const burst = .014, soft = !next || next.pause
      hold(t, t + burst, { fric: (voiceless ? 2.4 : 1) * (held ? .2 : 1) * (at === 0 ? 1.6 : 1) * (soft ? .4 : 1), hiss: p.place > .9 ? 2 : p.place > .7 ? 4.5 : velar, voice: p.voice, asp: 0, place: p.place, velum: 0 })
      t += burst
      // Breath after a voiceless one, before a vowel or through an r, l or w.
      if (voiceless && (next?.vowel || next?.liquid || next?.tap)) { hold(t, t + .045, { asp: .8, voice: 0, fric: 0 }); t += .045 }
    } else if (p.tap) {
      // Latin's r is trilled: the tip strikes twice.
      hold(t, t + .022, p)
      hold(t + .022, t + .05, { close: 1.4, voice: 1 })
      hold(t + .05, t + .072, p)
      t += .072
    } else if (p.pause) {
      hold(t, t + .16, p)
      t += .16
    } else {
      const span = p.fricative ? (p.voice ? .085 : .105) : p.nasal ? .075 : p.liquid ? .065 : .07
      hold(t, t + span, { asp: 0, fric: 0, ...p })
      t += span
    }
    // Consonants take their neighbours' evening out, except nasals, which come out of the nose.
    if (p.nasal) hold(from, t, { loud: .55 })
    phones.push([m[1], from, t])
  })
  // The tune: a little sung, sinking slowly from the speaking note, each stressed
  // vowel lifted and let fall, the last falling a tone below, unless the line says
  // otherwise with @n.
  const end = t
  vowels.forEach((v, i) => {
    const sink = -2 * v.from / end, last = i === vowels.length - 1
    if (v.sung !== null) spans[A.pitch].push([v.from, v.to, v.sung])
    else if (v.stress) spans[A.pitch].push([v.from, v.from + .3 * (v.to - v.from), 4 + sink], [v.to - .01, v.to, last ? -3 : 1.5 + sink])
    else spans[A.pitch].push([v.from, v.to, last ? -3 : sink])
  })
  // Silence before and after.
  const quiet = { voice: 0, asp: 0, fric: 0 }
  hold(0, .15, quiet)
  hold(t + .02, t + .4, { ...quiet, velum: 0, jaw: .9, lips: 1.2, close: OPEN, round: 0, tip: 0, open: 0 })
  for (const list of spans) list.sort((a, b) => a[0] - b[0])
  const out = { spans, phones, length: t + .3 }
  laid.set(line, out)
  return out
}

// How long a line takes to say, in seconds.
export const spoken = (line) => lay(line).length

// Where every articulator is t seconds into a line. The show and the voice
// both read this, so the mouth moves with the sound.
export function utter(line, t, out = new Float32Array(ART.length)) {
  const { spans } = lay(line)
  for (let p = 0; p < ART.length; p++) {
    const list = spans[p]
    let v = rest[p]
    if (list.length) {
      v = list[0][2]
      for (let j = 0; j < list.length - 1; j++) {
        const a = list[j], b = list[j + 1]
        const gap = Math.max(0, b[0] - a[1]) / 2, c = (a[1] + b[0]) / 2
        const h = Math.max(gap, Math.min(glide[p] / 2, gap + (a[1] - a[0]) / 2, gap + (b[1] - b[0]) / 2))
        if (t < c + h) { v = t <= c - h ? a[2] : mix(a[2], b[2], smooth((t - c + h) / (2 * h))); break }
        v = b[2]
      }
    }
    out[p] = v
  }
  return out
}

// What the face shows of it: lips apart, rounded, teeth shown, tongue tip
// shown, brows raised, and how much the talking mouth has taken over from the
// resting one (0 to 1).
export function mouthAt(line, t, out = [0, 0, 0, 0, 0, 0]) {
  const a = utter(line, t)
  const length = spoken(line), open = unit(a[A.open])
  out[0] = open
  out[1] = unit(a[A.round])
  out[2] = smooth(open / .15) * (1 - smooth((open - .2) / .5)) * (1 - .7 * unit(a[A.round]))
  out[3] = unit(a[A.tip]) * (a[A.close] < 1 ? 1 : .4)
  out[4] = unit(a[A.brow])
  out[5] = smooth(t / .12) * smooth((length - t) / .22)
  return out
}

// A fifth throat for speech: a tract like a singer's, with a nose off it at the
// velum, driven through utter() instead of the slow sung vowels.
class Speaker {
  constructor(rate, seed) {
    this.rate = rate; this.rand = dice(seed)
    this.n = Math.max(12, 2 * Math.round(48 * rate / 96000))
    this.m = Math.max(8, 2 * Math.round(30 * rate / 96000))
    this.v = 2 * Math.round(this.n * .23)
    this.r = new Float32Array(this.n); this.l = new Float32Array(this.n); this.k = new Float32Array(this.n)
    this.area = new Float32Array(this.n)
    this.nr = new Float32Array(this.m); this.nl = new Float32Array(this.m); this.nk = new Float32Array(this.m)
    // The nose: narrow where it leaves the throat, wide in the middle, narrow at the nostrils.
    let previous = 0
    for (let j = 0; j < this.m; j++) {
      const u = (j + .5) / this.m
      const d = 1.9 * Math.min(1, .6 + 3 * u, 1.6 * (1 - u) + .25)
      const area = d * d
      if (j) this.nk[j] = (previous - area) / (previous + area)
      if (j === 1) this.noseInner = area
      previous = area
    }
    this.noseArea = this.nk[0] = 0
    this.a = new Float32Array(ART.length); this.line = -1; this.t = 0; this.tick = 0; this.cut = 1
    this.noise = (seed | 0) || 1; this.phase = 0; this.parity = 1; this.pulse = pulses[0]
    this.gain = this.breath = this.hiss = this.lipState = this.noseState = this.dc = this.dark = this.chest = 0
    this.bandLo = this.bandHi = 0; this.f0 = 116
    this.hp = 1 - Math.exp(-TAU * 60 / rate); this.lp = 1 - Math.exp(-TAU * 10000 / rate)
    this.slew = 1 - Math.exp(-1 / (.004 * rate))
    this.jet = this.n - 2; this.on = 0
    this.noseGain = .2; this.src = 0; this.srcPole = 1 - Math.exp(-TAU * 2600 / rate); this.lipReflect = .94; this.glottisReflect = .9; this.volume = this.breath = this.hiss = 0; this.bandF = .5; this.bandQ = .5; this.lipGain = 1
    this.low = this.puff = this.nasal = 0; this.jitter = this.shimmer = 1; this.shelf = 1 - Math.exp(-TAU * 700 / rate); this.bright = 2.5
  }

  say(line) { this.line = line; this.t = 0; this.cut = 1; this.length = spoken(line) }
  // Stop mid-line: the voice fades out quickly and the mouth with it.
  hush() { if (this.line >= 0) this.cut = Math.min(this.cut, .999) }
  get busy() { return this.line >= 0 }

  control(dt, root) {
    if (this.line < 0) return
    this.t += dt
    if (this.cut < 1) this.cut = Math.max(0, this.cut - dt / .12)
    if (this.t > this.length || this.cut <= 0) { this.line = -1; this.on = 0; return }
    const a = utter(this.line, this.t, this.a)
    this.shape(a)
    const fade = smooth(this.cut)
    this.volume = a[A.voice] * a[A.loud] * fade
    this.breath = a[A.asp] * .25 * fade
    this.hiss = a[A.fric] * .07 * fade
    const f = Math.min(.45, a[A.hiss] * 1000 / this.rate)
    this.bandF = 2 * Math.sin(Math.PI * f); this.bandQ = a[A.hiss] < 3 ? .9 : .35
    this.f0 = 58.27 * semitone(root + 12 + a[A.pitch])
    this.on = 1
  }

  // The tract: the singers' bowl, the tongue's hump, the constriction, then the lips.
  shape(a) {
    const place = a[A.place], close = a[A.close], lips = Math.max(0, a[A.lips])
    let previous = 0
    for (let j = 0; j < this.n; j++) {
      const u = (j + .5) / this.n
      const bowl = 2.35 + a[A.jaw] * smooth((u - .44) * 3) - 1.25 * Math.exp(-((u - .10) ** 2) / .004)
      let d = mix(bowl, a[A.height], Math.exp(-.5 * ((u - a[A.tongue]) / a[A.width]) ** 2))
      const c = Math.exp(-.5 * ((u - place) / .032) ** 2)
      d = mix(d, Math.min(d, close), c)
      d = mix(d, lips, smooth((u - .84) / .16))
      const area = Math.max(d * d, 1e-4)
      this.area[j] = area
      if (j) this.k[j] = (previous - area) / (previous + area)
      previous = area
    }
    const velum = Math.max(0, a[A.velum])
    // The velum is the nose's first section: shut, nothing gets past it.
    this.noseArea = Math.max(velum * velum * 4, 1e-4)
    this.nk[1] = (this.noseArea - this.noseInner) / (this.noseArea + this.noseInner)
    // What leaves the lips goes with how far open they are: shut, nothing does.
    this.lipGain = lips * lips / (lips * lips + .12)
    // Just past the constriction, and on an even section: an odd one is written over by the next scattering.
    this.jet = Math.min(this.n - 2, Math.max(2, 2 * Math.round((place * this.n + 3) / 2)))
  }

  sample() {
    if (!this.on && this.gain < 1e-4) return 0
    let z = this.noise; z ^= z << 13; z ^= z >>> 17; this.noise = z ^ (z << 5)
    const noise = this.noise * 4.656612873077393e-10
    let ph = this.phase + this.f0 / this.rate * this.jitter
    if (ph >= 1) { ph -= 1; this.parity = -this.parity; this.jitter = 1 + .012 * noise; this.shimmer = 1 + .07 * noise }
    this.phase = ph
    const pos = ph * TABLE, j0 = pos | 0, pulse = this.pulse
    const fold = (pulse[j0] + (pos - j0) * (pulse[j0 + 1] - pulse[j0])) * (1 + .05 * this.parity) * this.shimmer
    this.gain += this.slew * (this.volume - this.gain)
    // The pulse a little rounded, so the voice falls away above the third formant as a man's does.
    this.src += this.srcPole * (fold - this.src)
    const air = this.gain * (this.src + .02 * (.3 + .7 * ph) * noise) + this.breath * this.puff
    // Hiss, coloured by a band-pass at the constriction.
    this.bandLo += this.bandF * this.bandHi
    this.bandHi += this.bandF * (noise - this.bandLo - this.bandQ * this.bandHi)
    const hiss = this.hiss * this.bandHi
    this.puff += .35 * (noise - this.puff)
    const r = this.r, l = this.l, k = this.k, n = this.n, nr = this.nr, nl = this.nl, nk = this.nk, m = this.m
    for (let j = 1; j < n; j += 2) {
      const a = r[j - 1], b = l[j], d = k[j] * (a - b)
      r[j] = a + d; l[j - 1] = b + d
    }
    for (let j = 1; j < m; j += 2) {
      const a = nr[j - 1], b = nl[j], d = nk[j] * (a - b)
      nr[j] = a + d; nl[j - 1] = b + d
    }
    const mouth = r[n - 1]; this.lipState += .59 * (mouth - this.lipState)
    l[n - 1] = -this.lipReflect * this.lipState
    const nostril = nr[m - 1]; this.noseState += .4 * (nostril - this.noseState)
    nl[m - 1] = -.7 * this.noseState
    r[0] = air + (this.glottisReflect - .17 * ph) * l[0]
    for (let j = 2; j < n; j += 2) {
      const a = r[j - 1], b = l[j]
      if (j === this.v) {
        // Where the nose leaves the throat, three tubes meet.
        const a1 = this.area[j - 1], a2 = this.area[j], a3 = this.noseArea, c = nl[0]
        const p = 2 * (a1 * a + a2 * b + a3 * c) / (a1 + a2 + a3)
        r[j] = p - b; l[j - 1] = p - a; nr[0] = p - c
      } else {
        const d = k[j] * (a - b)
        r[j] = a + d; l[j - 1] = b + d
      }
    }
    for (let j = 2; j < m; j += 2) {
      const a = nr[j - 1], b = nl[j], d = nk[j] * (a - b)
      nr[j] = a + d; nl[j - 1] = b + d
    }
    r[this.jet] += hiss
    this.nasal += .3 * (nostril - this.nasal)
    const said = mouth * this.lipGain + this.noseGain * this.nasal
    // Lift everything above the first formant, as the open air does for a voice.
    this.low += this.shelf * (said - this.low)
    const radiation = said + this.bright * (said - this.low)
    this.dc += this.hp * (radiation - this.dc)
    this.dark += this.lp * (radiation - this.dc - this.dark)
    // Back up to the singers' level, now that the vowels are evened out.
    return this.dark * 3.5
  }
}

const keys = ['night', 'rain', 'maw', 'tears', 'blood', 'water', 'moon']
const limit = x => {
  const a = Math.abs(x)
  return a < .57 ? x : Math.sign(x) * (.57 + .25 * (1 - Math.exp(-4 * (a - .57))))
}

export class Choir {
  constructor(rate = 48000, seed = Math.random() * 4294967295) {
    this.rate = rate; this.now = 0; this.tick = 0; this.period = Math.max(32, Math.round(rate / 120))
    this.rand = dice(seed); this.root = this.goal = 0; this.change = 20 + 18 * this.rand()
    this.s = {}; this.target = {}; for (const k of keys) this.s[k] = this.target[k] = 0
    this.singers = [0, 1, 2, 3].map(i => new Singer(i, rate, this.rand() * 4294967295))
    this.lines = [.0417, .0589, .0733, .0899].map(t => new Float32Array(Math.round(rate * t) | 1))
    this.cursors = new Uint32Array(4); this.wall = new Float64Array(4)
    this.wallPole = 1 - Math.exp(-TAU * 1900 / rate); this.lastAnswer = -2
    this.cosmos = new Cosmos(rate)
    this.speaker = new Speaker(rate, this.rand() * 4294967295); this.talk = 0; this.speech = 0
  }

  state(s) {
    if (!s) return
    for (const k of keys) this.target[k] = k === 'moon' ? +!!s[k] : unit(s[k])
  }

  event(kind, x = 0, score) {
    if (kind === 'stars' || kind === 'chorus') return this.cosmos.cue(kind, score, this)
    // The deep one says a line (x is which), or stops one short.
    if (kind === 'say') { if (SAYINGS[x]) this.speaker.say(x | 0); return }
    if (kind === 'hush') { this.speaker.hush(); return }
    if ((kind === 'built' || kind === 'flower' || kind === 'rainbow') && this.now - this.lastAnswer >= .70) {
      this.lastAnswer = this.now
      this.singers[kind === 'built' ? 2 : 3].answer(clamp(Number.isFinite(x) ? x : 0, -1, 1), kind !== 'built')
    }
  }

  control() {
    const dt = this.period / this.rate; this.now += dt
    for (const k of keys) this.s[k] += (this.target[k] - this.s[k]) * (1 - Math.exp(-dt / (k === 'maw' ? .11 : .68)))
    if (this.now >= this.change) {
      this.goal = [0, -2, 0, 3, -5][Math.floor(this.rand() * 5)]
      this.change = this.now + 22 + this.rand() * 34
    }
    this.root += (this.goal + this.s.moon * 1.5 - this.root) * (1 - Math.exp(-dt / 1.8))
    // While a line is said the others hold back, the deep one most.
    this.talk += ((this.speaker.busy ? 1 : 0) - this.talk) * (1 - Math.exp(-dt / .15))
    if (this.cosmos.live) this.cosmos.control(this)
    for (const singer of this.singers) {
      singer.control(dt, this.now, this.s, this.root)
      singer.volume *= 1 - this.talk * (singer.id ? .35 : .8)
    }
  }

  render(left, right) {
    const singers = this.singers, w = this.wall, d = this.lines, p = this.cursors
    const cosmos = this.cosmos
    for (let i = 0; i < left.length; i++) {
      if (--this.tick <= 0) { this.control(); this.tick = this.period }
      if (--this.speech <= 0) { this.speaker.control(32 / this.rate, this.root); this.speech = 32 }
      const said = this.speaker.sample() * .75
      let l = said * this.singers[0].left, r = said * this.singers[0].right
      for (let j = 0; j < 4; j++) {
        const v = singers[j], a = v.sample()
        l += a * v.left; r += a * v.right
      }
      if (cosmos.live) { cosmos.sample(); l += cosmos.l; r += cosmos.r }
      let sum = 0
      for (let j = 0; j < 4; j++) { w[j] += this.wallPole * (d[j][p[j]] - w[j]); sum += w[j] }
      // Householder reflection: four independent paths return as a diffuse tail.
      for (let j = 0; j < 4; j++) {
        d[j][p[j]] = (j & 1 ? r : l) * (j & 2 ? -.5 : .5) + .72 * (w[j] - .5 * sum)
        if (++p[j] >= d[j].length) p[j] = 0
      }
      const wet = singers[0].wet
      left[i] = limit(.14 * (l + wet * (w[0] + w[1] - w[3])))
      right[i] = limit(.14 * (r + wet * (w[2] + w[3] - w[1])))
    }
  }
}

if (typeof registerProcessor === 'function') {
  class ValleyChoir extends AudioWorkletProcessor {
    constructor() {
      super(); this.choir = new Choir(sampleRate)
      this.port.onmessage = ({ data }) => {
        if (data?.type === 'frame') this.choir.state(data)
        else if (data?.type === 'event') this.choir.event(data.kind, data.x, data.score)
      }
    }
    process(_, outputs) {
      const out = outputs[0]
      if (out?.length >= 2) this.choir.render(out[0], out[1])
      return true
    }
  }
  registerProcessor('valley-choir', ValleyChoir)
}
