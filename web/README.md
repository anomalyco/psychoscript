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
  allowLocalNetwork,  // dev mode only, default false: see "Local network in dev mode" below
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
- `canvas` and `shader` with an `id` (the prelude gives one to nodes with `onPointer` or a `key`) send `pointer`
  events, which the prelude routes to `onPointer`: `down`, `up`, and `move`
  at most once a frame, with `down: true` while a button is held and, on desktop and web, hover moves
  `{ kind: "move", x, y, down: false, width, height }` while the pointer is over the node (touch has no hover).
- Full screen (widgets-fullscreen.md): an expand button in the top-right corner (on hover/focus; always on touch)
  when the root node has `fullscreen: true`, or it isn't `false` and the widget is live or its view has a `canvas` or
  `shader`. It uses the Fullscreen API on the widget's element (Esc exits); the program gets
  `{ id: "", type: "fullscreen", value }` (`onFullscreen` / `widget.on("fullscreen")`) and `Frame.fullscreen` is set.
  The root fills the screen and every `canvas` and `shader` shares the remaining height equally (its `height` is the
  minimum; `fill: false` keeps it at its `height`); taller content scrolls. The only chrome is a small floating close
  button in the top corner (clear of safe areas); the capability chip is hidden.

### Keyboard and pointer capture (widgets-input.md)

- Clicking or tapping inside an open widget, or tabbing to it (the widget's element is focusable), gives it keyboard
  focus: an accent focus ring and a tiny hint, a keyboard icon plus "Esc" (a cursor icon plus "Esc" while the pointer
  is captured; `aria-label` "Esc to release"). Touch devices show no hint until a hardware keyboard types, then the
  icon alone. The program gets `{ id: "", type: "focus", value }`, and
  while focused `{ id: "", type: "key", value: { kind: "down" | "up", key, code, repeat, shift, alt, ctrl, meta } }`
  which the prelude routes to the hooks (`onKey`, `onFocus`, `onCapture`, `onFullscreen` in step mode,
  `widget.on(...)` in live mode). Delivered keys are `preventDefault`ed and stop
  propagating at the widget (no page scrolling, no app shortcuts in the bubble phase).
- Not delivered: Cmd (macOS) / Ctrl (elsewhere) chords, which reach the page; Tab, which moves focus; keys typed into
  text inputs; Enter/Space on buttons and options, and arrows on sliders, options and carousels, which keep working.
  Clicking outside blurs it; held keys get their `up` on blur.
- Pointer capture: root `capture: "pointer"` (step or live) or a live program posting `{ type: "capture", value: true }`
  (what the prelude's `widget.capturePointer()` posts; `releasePointer()` posts `value: false`). Granted on the next
  click inside the widget with the Pointer Lock API (cursor hidden); then `{ id, type: "pointer", value: { kind: "move",
  dx, dy } }` at most once a frame and `{ kind: "down" | "up", button }`, with `id` the first canvas/shader `id` in the
  view (else `""`). The program gets `{ id: "", type: "capture", value: true }` when granted.
- Esc is never delivered. One Esc releases both (the browser itself ends Pointer Lock on Esc; that also drops focus),
  as do leaving full screen, the window losing focus, submit/dismiss and `destroy()`. The program gets
  `{ type: "focus", value: false }` and, if it had the pointer, `{ type: "capture", value: false }`. A live program
  must call `capturePointer()` again after a release; a root `capture: "pointer"` is granted again on the next click.
- The host sends only the wire events (`{ id, type, value }`, widgets.md, Events); ids come from the prelude and the
  host never interprets them, so templates written with handlers (`onPress`, `onChange`, `onPointer`) and hooks need
  nothing from the host.

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
                                         # (+ the local hosts, e.g. http://localhost:4097, with allowLocalNetwork)
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

### Local network in dev mode

`allowLocalNetwork: true` (default false; widgets-live.md, "Local network in dev mode") also lets a widget reach
loopback, private and link-local addresses and local names (`localhost`, `*.localhost`, `*.local`, `*.internal`,
single-label names), over `http:` as well as `https:`, but only hosts the template declares by name or address, never
through `*`. Entries may name a port (`localhost:4097`, `127.0.0.1:5173`, `[::1]:8080`) and then match only it; an
entry without a port matches any. Turn it on only behind a dev setting (e.g. a debug toggle or an
`OPENCODE_WIDGETS_DEV_NETWORK`-style flag), never by default in release builds. The capability chip then says
"local network allowed".

The browser has its own say:

- The page's CSP must allow the destination too, e.g. `connect-src 'self' https: http://localhost:4097
  http://127.0.0.1:4097`; otherwise the request fails with `Network`.
- An `https:` page can't fetch plain `http:` except to `localhost`/`127.0.0.1`/`[::1]` (mixed content); other private
  hosts need `https:` there.
- Chromium asks the user before a public page reaches the local network (Private/Local Network Access), and the
  local server must answer CORS (and Private Network Access preflights) for the page's origin.
- A browser can't pin the address it connects to, so with dev mode off a public name that resolves to a private
  address is only stopped by those browser checks, not here.

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
