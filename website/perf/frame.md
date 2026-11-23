# What a frame costs

GPU time for one frame of the picture at 2880x1800 (the wide layout at twice its size), six seconds into the show, measured with `tools/perf/ab.mjs`. Each change was measured against the copy just before it in the same run, and checked with `tools/perf/same.sh`.

| | Desktop GPU | Laptop GPU |
| --- | --- | --- |
| Before this pass | 17.5 ms | |
| Now | 14.0 ms | 31.4 ms |

The page never asks for more than about 6.2 million pixels, and when frames run long it draws fewer pixels until they do not. A frame that takes a twentieth of a second or more brings the size down at once.

## What was kept

| Change | Saved (desktop, wide) | Pixels that differ |
| --- | --- | --- |
| The lens's flares are drawn at a quarter size, and the paper grain once per size, not every frame | 1.1 ms | 42 at most |
| Nothing of the sky, stars or sun is drawn below the land's far edge | 0.7 ms | 0 |
| The terminal is worked out first, and nothing is drawn behind its solid part | 0.2 ms (1.5 ms on a phone layout) | 0 |
| Nothing is drawn under the solid part of the lettering | 0.4 to 0.8 ms | 0 |
| A cloud's puffs are placed once a pixel, not at every step of the march through it | 0.85 ms | 0 |
| Fire is drawn from a flipbook of simulated flame, not from layers of noise | 0.2 ms with a big fire burning | (a new look) |
| The terminal, the walkers and the buildings are drawn in passes of their own, which the picture reads at the same pixel: their code no longer sits in the picture's main function, where it cost every pixel 3 to 4 ms just by being there | 4.8 to 5.8 ms (laptop, wide); 2.2 to 2.8 ms narrow | 42 at most, explained (one sign's stroke, one leg's edge) |
| The sky (and the galaxy), the clouds and the sun each drawn in a pass of their own over only the rows or rectangle they can cover | 3 to 3.6 ms wide, 1.8 ms narrow, up to 4.3 ms in the galaxy (laptop) | 0 |
| Eighteen colour and shape tables made constants: as `var` arrays every pixel filled its own copy before anything else ran | 0.5 to 0.8 ms wide (3.4 ms before the passes above took some of them out), 3.6 ms in the takeover | 0 |
| The joints of the terminal's and every little walker's legs posed once a frame, in the uniforms, not at every pixel of their passes; the footfalls' heave numbers worked out once a frame; the land's march and its bisection one loop; the land colour's slope one loop of four grounds; the lettering's candy colour and glint skipped where a letter's fill is exactly 0; the clouds drawn into one packed tile each and the sun into a texture only as big as its square | 2.1 to 2.6 ms wide, 3.2 to 3.3 ms narrow (laptop, see below) | under one pixel (0.04 at most) |

### The fourth round (Nov 18)

Nine changes, kept together: `legsU`, `walkerLegs`, `titleCandy`, `titleStack`, `heaveCpu`, `marchOne`, `colorOne`, `cloudAtlas` and `sunBox` (the picture's uniforms grow from 1760 to 2484 floats). Measured with `tools/perf/ab.mjs` on the laptop GPU (M2 Max) at 2880x1800 wide and 1200x2600 narrow, 11 rounds, against the copy before them in the same run:

| Moment | Before | After | Saved |
| --- | ---: | ---: | ---: |
| wide, 6 s | 22.64 ms | 20.01 ms | 2.63 ms |
| wide, 30 s | 24.36 ms | 22.30 ms | 2.06 ms |
| wide, 47 s | 23.84 ms | 21.26 ms | 2.57 ms |
| narrow, 6 s | 20.27 ms | 16.94 ms | 3.32 ms |
| narrow, 30 s | 20.82 ms | 17.66 ms | 3.16 ms |

By timestamp queries at 6 s the whole frame is 2.88 ms shorter wide (the terminal's pass 1.25, the walkers' 0.48, the picture 1.14) and 3.37 ms narrow (the picture 1.92). The cloud tiles and the sun's box are for memory, about 43 MiB less at 2880x1800 (the sun's share until the day-night wheel turns); they cost the picture 0.1 to 0.3 ms alone, which does not show beside the rest.

Checked against the copy before at 17 moments (wide 6, 30, 47 and 80 s, the abduction, the audit, a press, the spell rain, the boss, the cosmos and the snake; narrow 6 and 30 s and a jump) at 1x with a 1.5% fuzz: 0 pixels differ in 16, 0.04 of a pixel at the audit's 12 s, the same in a second run. Then naga on the picture, glow, quiet, valley and cosmos shaders, `tintish.py`, `tools/check.mjs` and `tools/spectacle.mjs` with the sound on (no problems), `perf/startup.mjs` wide and narrow beside the deployed copy (no device lost, no poster, the same frames), and Safari 27 (live in both layouts at 60 frames a second, no compiler messages). Deployed as https://27911592.psychoscript.pages.dev.

One gate turned out hollow: the validator's snake check looked for `const viperActive: bool = false;`, which the shader never says, so it re-checked the plain shader while reporting the variant, and every round before this one validated the snake variant in name only. This round the variants were built the way `createLiquid` builds them and confirmed to differ, and `validate.sh` now flips the real declaration (`const viperActive = true;`) and fails loudly whenever a pattern is not found.

## Keeping a small GPU out of trouble

People said the page crashed their browsers. A browser takes the GPU away from a page (and on some machines takes the whole browser down) when a frame keeps it busy for seconds, and an ill-matched GPU asked for this picture at full size could be kept that busy. The page now never asks blind:

- Before anything is shown it draws a sixteenth of the picture, in sixteen patches spread over it, and times that with the GPU's own timestamps (or the wait for the GPU to finish, where it has none). A GPU that would take more than about 85 ms over a frame even at a quarter of the sharpness is never given one: it gets the still poster. A slower one starts as soft as it needs to be.
- After that, each frame's GPU time is stamped and kept inside 12.5 ms by drawing softer, at once, by as much as is needed; four seconds well inside, it is drawn sharper again. If drawing softer buys nothing (another window is using the GPU), the softness is taken back.
- A GPU that cannot keep up even at the floor for four seconds gets the still poster.
- The big pipelines are made one at a time, with a pause between, instead of five at once.
- `?pace` writes what it decides to the console; `?burden=<n>` draws the picture n times a frame, to try all this on a fast GPU; `tools/perf/startup.mjs` loads the page in a fresh browser and reports pipelines, memory, frames and the pacing.

## Starting up

Making a render pipeline from shaders this size takes a browser seconds, and used to freeze the tab while it did. All pipelines are now made with `createRenderPipelineAsync`: the ones every frame needs first, then the snake's and the takeover's, which are let in on a frame they are not in.

## Where the rest goes

A profile by timestamp queries on every pass (`.preview`, Nov 18): the picture pass is nearly the whole frame; the fluid simulation is 0.15 ms, the glow and flares 0.24 ms, the last pass 1.3 ms. Filling the screen with a flat colour costs 0.03 ms: it is all arithmetic. Code that never runs still costs every pixel, by the size of the function it sits in, which is why moving things into passes of their own pays.

The table below is from before that work.

Taking one thing out at a time, on the laptop GPU (31.4 ms):

| Part | Costs |
| --- | --- |
| The terminal | 6.4 ms (its legs 3.0, its shading 2.7, of which the normal is 1.1) |
| The little walkers | 3.5 ms (the march 2.4) |
| The sky | 3.1 ms |
| Clouds | 2.8 ms |
| The sun | 2.4 ms |
| The land | 1.8 ms (its colour 1.5) |
| Flowers | 0.2 ms |
| The lettering | nothing to speak of |

Next to try: take the terminal's normal from the body alone where a ray hit the body, bound each boot before measuring its three shapes, and tighten the sphere each walker is marched in.

## Tried and dropped

- A second, lean picture pipeline with twelve rare effects compiled out, used when none is on: 0.55 to 0.95 ms, not kept, because a sixth big pipeline costs a small GPU memory and a first visit another second of compiling.

- The land in a pass of its own: no gain; its march is plain arithmetic, and the village needs the land's code anyway.
- Sorting out, per ray, which footfalls can reach it: their ripples reach nearly every ray.
- The sky's pass skipping pixels under the lettering, the sun and solid clouds: within the noise.

- A noise fire with taller flames, halo and smoke columns: 2.85 ms with a big fire, and it still did not look like fire.
- Halving the terminal's march steps: saves nothing, few rays use them.
