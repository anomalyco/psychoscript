# psychoscript-site

The PSYCHOSCRIPT programming language landing page. It opens as a grey corporate page for "NormalScript®" with one odd thing on it: a paper tab. Take the tab and the page melts into a full-screen picture, drawn live with WebGPU. There is no build step; `site/` is the whole site.

## How it opens

- **The grey page** is ordinary HTML. The tab is its only button.
- **Taking the tab** melts the page away over about four seconds and starts the show (and the sound, since the press allows it).
- **Escape** wears it off and brings the grey page back. Inside the terminal, the first Escape only climbs back out.
- **`?awake`** skips the grey page. `?freeze=<seconds>` shows one still frame of the show.

## What is in the picture

- **The sky** is a real fluid simulation seen through a kaleidoscope centred on the sun.
- **The land** is an endless ray-marched river valley the picture flies up. Little walking computers build houses and towers there, flowers of six kinds grow, rain floods it, fish jump and lily pads drift.
- **The sun** has a face with moods. It weeps, fires lasers from its eyes, opens into a sandworm's maw, and rolls off round a wheel as the moon rolls on.
- **The terminal** walks on striped hose legs and writes a script nobody can read. Everything that happens gets a line. Its boots leave prints and splash in the flood, and a face comes up on its screen when something startles it.
- **The planet** is an eye. It watches the pointer, and now and then takes a walker up in a beam.
- **The snake** is a 3D rainbow serpent that winds through the valley.
- **Fire** starts where the lasers land, travels across the land, takes buildings with it and damages the terminal. Rain puts it out.
- **The title** is traced from the hand lettering of the original poster (`design/reference.jpg`).
- **The sound** is four simulated throats singing, plus recorded and synthesised effects.
- **The sun speaks**, and the moon at night: a fifth throat that forms words, mostly Latin, about what is happening ("Salve, munde." on arriving, "Delenda est." as a building falls), and now and then a catchphrase about code mode. Its mouth moves from the same timeline as the sound. The lines are `SAYINGS` in `site/voice.worklet.js`: one entry each, the words and their sounds.
- **The galaxy**: about a minute in, and every two or three minutes after, the painted sky burns open on a galaxy. Its stars are a synthesiser, each with its own note in the choir's key, and at its height everything in the valley sings one chord.

The show starts quietly and gets stranger over its first twenty seconds. The big set pieces take turns, so two never play at once: a compliance notice from NormalScript®, an audit, windows breaking into the picture, the picture folding up, a dive into the terminal's screen, the galaxy, and a takeover by a low-poly head.

## What a visitor can do

| Do this | And |
| --- | --- |
| Move the pointer | the sun and the planet watch it, the liquid stirs, walkers come to look |
| Press the ground | something comes up: a flower, a footprint, a bolt, sparks |
| Press the water | a fish jumps |
| Press the sky | sparks, and every third time lightning |
| Press the sun | it roars |
| Press the planet | day turns to night, or back |
| Type, then Enter | the line is cast, and something comes of it |
| Press the terminal's glass, or D | dive into its screen, and out again |
| Space, or press the terminal's boots | it jumps, and comes down hard |
| Scroll, or the up and down arrows | fly faster or slower |
| Move the pointer over the title | it is jelly |
| The two buttons, bottom left | sound on and off; stop and start all motion |

There are also things nobody is told about. The comment at the top of `site/index.html` is the only hint.

Without WebGPU, or with reduced motion, still artwork stands in. On a GPU that cannot keep up, the picture is drawn with fewer pixels before it is allowed to stutter.

## Working on it

```sh
cd tools
bun install
bun dev.mjs 4737        # serves site/ and reloads the page on every save
```

| Tool | What it does |
| --- | --- |
| `tools/frame.mjs` | Renders one frame to a PNG with Deno's WebGPU, no browser |
| `tools/clip.mjs` | Renders a clip with its sound to an MP4, with a script of what a visitor does |
| `tools/check.mjs` | Loads the page in headless Chromium at desktop and phone sizes and reports problems and how long the picture took to come up (`FRONT=1` checks the grey page and the tab too) |
| `tools/perf/ab.mjs` | Times two or more copies of `liquid.js` against each other on the GPU, frame by frame in turn |
| `tools/perf/same.sh` | Draws two copies at the same moments and counts the pixels that differ |
| `tools/perf/tintish.py` | Finds WGSL that naga accepts and Chrome refuses |
| `tools/trace.mjs` | Builds the title's textures from `design/lettering.png` |
| `tools/art.mjs` | Builds the still artwork shown without WebGPU |
| `tools/spectacle.mjs` | Types `speak`, `stars` and `sing` into the picture in headless Chromium with the sound on, and writes shots and any problems |
| `tools/sound-test.mjs` | Renders the choir offline and checks its levels |

Almost everything lives in `site/liquid.js`: the shaders, the show (what happens when), and the page's wiring. `site/sound.js` and `site/voice.worklet.js` are the sound. Where the pictures in `site/art/` came from is in `tools/art/SOURCES.md`.

### Filming it

```sh
cd tools
deno run -A --unstable-webgpu clip.mjs wide 0 30 ../film/out.mp4 1 "8:roar,14:turn"
```

The arguments are the layout (`wide` or `narrow`), the first and last second of the show to keep, the file, a scale (1 is 1440x900), and a script of what a visitor does. The top of `clip.mjs` lists what the script can say.

### Keeping it fast

Change one thing, then measure it against the copy from before:

```sh
cd tools
deno run -A --unstable-webgpu perf/ab.mjs wide 6 2 before.js ../site/liquid.js   # layout, second of the show, scale, copies
perf/same.sh before.js ../site/liquid.js 6 14 30 62                            # 0 differing pixels means nothing was lost
```

What has been tried and what it saved is in `perf/frame.md`.

## Deploying

The site deploys automatically from GitHub Actions (`.github/workflows/deploy.yml`) as a Cloudflare Worker with static assets:

- Pushing to `dev` deploys `psychoscript-dev-site` to <https://dev.psychoscript.com/>.
- Fast-forwarding `production` from `dev` (`git push origin dev:production`) deploys `psychoscript-production-site` to <https://psychoscript.com/>.

```sh
BASE=https://dev.psychoscript.com/ bun check.mjs    # from tools/: check the deployed copy in a browser
```
