# psychoscript-web

The web host for OpenCode widgets (`specs/v2/widgets.md`, `widgets-live.md`, `widgets-fullscreen.md` in opencode): the
Rust PsychoScript compiled to WebAssembly, run in Web Workers, rendered with plain DOM (no framework), Canvas2D for
`canvas`, and WebGPU (WebGL2 fallback) for `shader`. The web counterpart of Rune desktop and the mobile apps.

## Consume it

`web/dist/` is committed and self-contained: no Rust toolchain or build step needed to use it.

```
dist/index.js                         the page side (ESM, 61 KB min, 20 KB gzip) + index.d.ts and friends
dist/worker.js                        the worker (module worker, 18 KB; includes the wasm-bindgen glue)
dist/psychoscript_web_bg.wasm         the language (Program, LiveRun)
dist/psychoscript_web_shader_bg.wasm  naga WGSL -> GLSL ES 3.00, fetched only when a shader needs WebGL2
```

Pick one:

- **Vendor** (simplest): copy `web/dist/` into the app (e.g. `src/vendor/psychoscript-web/`) and
  `import { mount } from "./vendor/psychoscript-web/index.js"`. Keep the four files side by side.
- **Local dependency**: the package is the `web/` subdirectory, so point at a checkout of the branch
  (`"psychoscript-web": "file:../psychoscript/web"`) and `import { mount } from "psychoscript-web"`. bun and npm can't
  take a subdirectory of a git URL; pnpm can (`"github:anomalyco/psychoscript#web&path:/web"`).

Assets: `index.js` finds `worker.js` and the `.wasm` files with `new URL("./…", import.meta.url)`. Vite and other
bundlers that understand `new Worker(new URL(…, import.meta.url))` and `new URL(asset, import.meta.url)` emit them as
assets with no configuration. Otherwise serve the four files from one directory, or tell the host where they are:

```ts
import { configure } from "psychoscript-web"
configure({ workerUrl: "/assets/pw/worker.js", wasmUrl: "/assets/pw/psychoscript_web_bg.wasm", shaderWasmUrl: "/assets/pw/psychoscript_web_shader_bg.wasm" })
```

Serve `.wasm` as `application/wasm` (else it falls back to a slower non-streaming compile) and compressed (brotli or
gzip; see Size). The files never change for a given commit, so they can be cached immutably under a hashed path.

## Mount

```ts
import { mount } from "psychoscript-web"

const widget = mount(element, {
  program,            // Program.program from opencode.widget/program: prelude + "\n" + source
  data,               // the widget tool call's data
  mode: "step",       // or "live" (Program.mode)
  capabilities,       // Program.capabilities (live): { https: { hosts } }, granted as declared, shown as a chip
  state: "open",      // the server State.status: "submitted" | "dismissed" render read-only with a status line
  response,           // optional: State.response, summarized after "Submitted"
  onSubmit: (value) => rpc.respond({ sessionID, messageID, callID, response: { value } }),
  onDismiss: () => rpc.respond({ sessionID, messageID, callID, response: { dismiss: true } }),
  onSend: (value, wake) => rpc.send({ sessionID, messageID, callID, value, wake }),
  theme: "dark",      // "dark" | "light" | tokens (below)
  resolveImage: (src) => /^(https?|data):/.test(src) ? src : fileContentUrl(session, src),   // optional
  onWarning: (message) => console.warn("widget", message),                                    // optional
})

widget.setState("submitted", response) // the `changed` event said so (from any client): read-only, live program stops
widget.setTheme("light")
widget.restart()                       // fresh init / fresh main
widget.destroy()                       // stops the program, frees the worker side, removes the element
```

`mount` appends one element (`div.psychoscript-widget`, open shadow root) to `element` and uses the page's shared
`WidgetHost`. For several independent hosts: `new WidgetHost(options).mount(...)`; `host.destroy()` stops everything.
`host().preload()` starts fetching and compiling the WebAssembly early (e.g. when a session with widgets opens).

Behavior, per the contract:

- Step widgets share one worker; `init` runs when the widget first comes within 200 px of the viewport (a loading
  shimmer before). Each step runs off the page's thread; a failing step keeps the previous view and shows the error
  inline; a failing first step shows an error card with "Try again".
- Live widgets get a worker each (isolation: one can't stall another), start when first visible, pause when out of
  view or the tab is hidden (timers freeze, `now()` stops, events/fetch results held), and receive
  `{ type: "resumed", pausedMs }` when back. A program computing more than 50 ms without awaiting is stopped and
  shows the error with "Restart". Submit/dismiss stops the program; the last view stays read-only.
- `onSubmit`/`onDismiss` fire once; the widget turns read-only right away. `onSend` is throttled to 10 a second.
- `canvas`: Canvas2D, drawn on `requestAnimationFrame` only while `fps > 0` (or `duration` not reached) and
  visible; draw steps run in the worker, at most one in flight; 8 ms / 2,000 commands budget, three overruns in a row
  stop the animation and keep the last frame. A resize repaints the last commands at once, then draws again.
- `shader`: WGSL straight to WebGPU; without it WebGL2 with naga's GLSL ES 3.00 (the naga module loads only then).
  New `values` (a live program re-rendering every frame) update the uniforms only: same element, same pipeline.
  Over 50 ms of GPU time a frame three frames in a row stops it (measured on WebGPU only). A failing shader shows
  `poster` or `alt` with the error.
- `canvas` and `shader` with an `id` send `pointer` events (`down`, `move` only while down and at most once a frame,
  `up`) to `update` or `widget.event()`.
- Full screen (widgets-fullscreen.md): an expand button in the top-right corner (on hover/focus; always on touch)
  when the root node has `fullscreen: true`, or it isn't `false` and the widget is live or its view has a `canvas` or
  `shader`. It uses the Fullscreen API on the widget's element (Esc exits); the program gets
  `{ id: "", type: "fullscreen", value }`, `Frame.fullscreen` is set, `fill: true` surfaces take the free height.

### Theme

`theme` is `"dark"`, `"light"` or tokens: `{ text, muted, accent, bg, surface, border, success, warning, error,
accentText?, font?, mono?, radius?, dark? }` (missing ones come from the dark or light preset). They become CSS
variables on the widget element (`--pw-text`, `--pw-accent`, …, `--pw-font`, `--pw-radius`) and the colors draw
commands name. The widget paints no background of its own (except in full screen): it sits on the page's surface.

## Content-Security-Policy

What the page needs (the demo server, `scripts/serve.ts`, sends exactly this and everything works under it):

```
script-src 'self' 'wasm-unsafe-eval'     # WebAssembly.compile in the page and the worker
worker-src 'self'                        # module worker from the same origin (or where worker.js is served)
connect-src 'self' https:                # fetching the .wasm (self), and live widgets' fetch capability
img-src 'self' data: https:              # image nodes and draw images (plus your file-content endpoint)
style-src 'self'                         # no inline styles: constructable stylesheets and CSSOM only
```

`connect-src` for widget fetch: live widgets fetch from the worker, so the page's policy applies. `https:` allows
every host a template may declare; a narrower list blocks undeclared and declared hosts alike (the widget sees a
`Network` error). The `.wasm` and worker must be same-origin with the page (or the CDN must be in `script-src`,
`worker-src` and `connect-src`; module workers can't be cross-origin, so serve `worker.js` from the page's origin).

## Live `fetch` in a browser

Rules are enforced in Rust (`rust/crates/psychoscript-web/src/fetch.rs`): `https:` only, host on the declared list
(exact, `*.suffix`, `*`), no URL credentials, no `localhost`/`.local`/single-label names or private, loopback,
link-local literal addresses, GET/POST/PUT/PATCH/DELETE/HEAD, no cookie headers either way, request body ≤ 256 KB,
response ≤ 2 MB, 15 s, at most 4 in flight and 10 a second. The worker carries it with
`fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", mode: "cors" })`.

Browser limits: the target must allow CORS (else `Network`); the browser follows redirects itself (the final URL is
checked against the same rules before the program sees anything, intermediate hops are not visible); names aren't
resolved here, so a public name that points at a private address is only stopped by the browser's Private Network
Access checks.

## Size and speed

| File | Raw | gzip | brotli |
| --- | --- | --- | --- |
| `psychoscript_web_bg.wasm` | 9.54 MB | 3.19 MB | 2.21 MB |
| `psychoscript_web_shader_bg.wasm` (WebGL2 only) | 1.19 MB | 0.44 MB | 0.34 MB |
| `index.js` + `worker.js` | 79 KB | 26 KB | |

5.7 MB of the language module is data, mostly ICU4X locale data for `toLocale*String`/`Intl.DateTimeFormat`/
`localeCompare`; trimming it is possible without code changes but changes behavior (see
`rust/crates/psychoscript-web/README.md`).

Chromium 158 on this VM (no GPU, SwiftShader), from `scripts/check.ts`:

| | ms |
| --- | --- |
| First view on a fresh page (fetch + compile the module, start and warm the worker, compile, `init`, paint) | ~180–250 |
| First view of another widget once the worker runs | median 17, p95 ~80 |
| Compiling a template program | median 2–3, p95 6 |
| A step (`init`/`update`) | median 0.8–1, p95 5–11 |
| A draw step | median 0.5–0.6, p95 2–3 |

The first program a fresh WebAssembly instance runs costs 30–100 ms more (the engine compiles the interpreter's
functions lazily); the worker runs a small warm-up program at start for that, and workers share the compiled code.
`host().preload()` starts it all early.

Memory: each worker holds its own linear memory: ~7 MB for a live widget's worker (5.7 MB of it the module's data),
~10.5 MB for the shared step worker with 28 step widgets and 23 programs; the page side's JS heap ~18–20 MB for the
whole demo (27 widgets). A live widget's worker is terminated when it stops.

## Build

```sh
cd web
bun install
bash scripts/build-wasm.sh   # cargo (wasm32-unknown-unknown) + wasm-bindgen 0.2.130 + wasm-opt -> web/wasm/
bun scripts/build.ts         # -> web/dist/ (index.js, worker.js, .wasm, .d.ts)
bun scripts/fixtures.ts      # demo/fixtures.js from an opencode checkout's packages/widget
bun scripts/serve.ts         # http://localhost:4173/demo/ (with the CSP above)
```

Checks in a real browser, with the demo server running: `SHOTS=<dir> xvfb-run -a bun scripts/check.ts` (Chromium from
Playwright's cache, WebGPU through SwiftShader's Vulkan; headless screenshots leave WebGPU canvases blank, so it runs
headful under Xvfb). It renders every fixture in both themes and checks canvases drew, presses controls and checks the
submits (confirm, suggestions with carousel, form), chart pointer and tap, backdrop on WebGPU and WebGL2, shader
pointer events and values-only updates, the minigame, pause/`resumed` out of view, full screen with `fill`, the slice
budget and Restart, and the fetch rules; then prints timings and memory.

The demo (`demo/`) mounts every built-in (`suggestions`, `form`, `confirm`, `chart`, `backdrop`, `minigame` and the
17 diagram templates, data from opencode's `packages/widget/test/fixtures/diagrams.ts`) plus demo templates for fetch,
a running clock (pause), a runaway loop, a live shader and full screen. `?only=<name>`, `?theme=light`, `?gl=1`
(WebGL2 even with WebGPU).
