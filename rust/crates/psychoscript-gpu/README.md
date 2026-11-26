# psychoscript-gpu

GPU canvases for PsychoScript programs. A program records a subset of WebGPU as batches of ops and bytes; a host
checks each batch and replays it on a `wgpu` device and queue it gives, into canvas textures it composites. No
platform code: a desktop host shares its own device, psychoscript-mobile makes one (Metal, Vulkan) and presents into
the app's surfaces. Compute is left out for now.

This is the contract between a program that records batches and a host that replays them. One recording API is
opencode's widget prelude, `widget.gpu` (opencode `specs/v2/widgets-gpu.md`: the API, frames, and the messages that
carry batches and canvas sizes). Canvases are named by keys, which are the host's (opencode: a `gpu: true` canvas's
`key`).

## Transport

A batch is `{ ops: Op[], bytes: ArrayBuffer }`; how it reaches the host is the recording API's. `ops` are JSON arrays,
and every host reads them as JSON reads them: an `undefined` list item is `null`, and an `undefined` object member is
absent (so `[undefined]` as color attachments is `[null]`, and `{ buffer: undefined, sampler: 2 }` is a sampler).
Nothing else changes: numbers are read as they are, so `NaN` and infinities fail the check that reads them rather than
becoming `null`. `bytes` is one `ArrayBuffer` the recorder assembles from the batch's write data (the raw bytes of the
typed arrays passed, in call order), never a JSON array of numbers; the host reads it through psychoscript's host bytes
API as a borrowed slice, without copying. Ops reference it as `[byteOffset, byteLength]`. Handles are integers the
recorder assigns per run, from 1, never reused; a descriptor names resources by handle.

```ts
type Op =
  | ["context", handle, key, format, alphaMode]             // getContext + configure; handle is its current texture
  | ["buffer", handle, size, usage]
  | ["texture", handle, width, height, depthOrArrayLayers, format, usage, mipLevelCount, sampleCount]
  | ["view", handle, texture, descriptor]                    // texture.createView (dimension: "2d" | "2d-array" | "cube")
  | ["sampler", handle, descriptor]
  | ["shader", handle, code]
  | ["bindGroupLayout", handle, descriptor]
  | ["pipelineLayout", handle, bindGroupLayouts: handle[]]
  | ["renderPipeline", handle, descriptor]                   // layout: handle | "auto"
  | ["autoLayout", handle, pipeline, index]                  // pipeline.getBindGroupLayout(index)
  | ["bindGroup", handle, descriptor]
  | ["destroy", handle]
  | ["writeBuffer", buffer, offset, byteOffset, byteLength]
  | ["writeTexture", texture, mipLevel, [x, y, layer], byteOffset, byteLength, bytesPerRow, rowsPerImage,
      [width, height, layers]]
  | ["copyBufferToBuffer", source, sourceOffset, destination, destinationOffset, size]
  | ["copyBufferToTexture", buffer, offset, bytesPerRow, rowsPerImage, texture, mipLevel, [x, y, layer],
      [width, height, layers]]
  | ["copyTextureToTexture", source, sourceMip, [x, y, layer], destination, destinationMip, [x, y, layer],
      [width, height, layers]]
  | ["pass", descriptor]                                     // beginRenderPass; the commands up to "end" are its own
  | ["setPipeline", pipeline]
  | ["setBindGroup", index, bindGroup, dynamicOffsets]
  | ["setVertexBuffer", slot, buffer, offset, size]          // size -1: to the end
  | ["setIndexBuffer", buffer, "uint16" | "uint32", offset, size]
  | ["setViewport", x, y, width, height, minDepth, maxDepth]
  | ["setScissorRect", x, y, width, height]
  | ["draw", vertexCount, instanceCount, firstVertex, firstInstance]
  | ["drawIndexed", indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
  | ["end"]
  | ["submit"]                                               // the command buffers' commands just before it, in order
```

A `context` op comes from `configure`: configuring again posts it again with the same handle (a reconfiguration), and
configuring with a new device gives a new handle. A context's handle stands for that canvas's current texture at
replay time, so views of it are created once. An `error` op is a WebGPU validation error the recorder found itself,
which the ops can't show: `the command encoder is finished` (a command after `finish()`), `a render pass is open on this
command encoder` (a command, a pass or `finish()` while a pass is open), `the render pass has ended` (a pass command
after `end()`), `a command buffer can be submitted once`, `a texture's dimension must be "2d"`. An encoder records
nothing after its first error. Handles count from 1 and only grow; a call on a lost device spends a handle and records
nothing.

Descriptors are WebGPU's, with handles in place of objects and every default filled in by the recorder, so each op has
exactly these shapes (`h` a handle; absent optional members are `null`):

- `view`: `{ dimension, baseMipLevel, mipLevelCount, baseArrayLayer, arrayLayerCount }` (dimension `"2d-array"` for a
  texture of more than one layer, else `"2d"`; counts to the texture's end, 1 layer for `"2d"`, 6 for `"cube"`).
- `sampler`: `{ addressModeU, addressModeV, addressModeW, magFilter, minFilter, mipmapFilter, lodMinClamp, lodMaxClamp,
  compare, maxAnisotropy }` (`"clamp-to-edge"`, `"nearest"`, 0, 32, `null`, 1).
- `bindGroupLayout`: `{ entries: [{ binding, visibility, buffer, sampler, texture }] }`, one of the last three set:
  `buffer: { type ("uniform"), hasDynamicOffset (false), minBindingSize (0) }`, `sampler: { type ("filtering") }`,
  `texture: { sampleType ("float"), viewDimension ("2d"), multisampled (false) }`.
- `pipelineLayout`: a list of bind group layout handles.
- `bindGroup`: `{ layout: h, entries: [{ binding, resource }] }`, `resource` one of `{ buffer: h, offset (0), size
  (-1: to the end) }` (a buffer alone is the whole buffer), `{ sampler: h }`, `{ view: h }`.
- `renderPipeline`: `{ layout: h | "auto", vertex: { module: h, entryPoint, buffers: [null | { arrayStride, stepMode
  ("vertex"), attributes: [{ format, offset, shaderLocation }] }] }, fragment: null | { module: h, entryPoint, targets:
  [null | { format, blend: null | { color, alpha }, writeMask (15) }] }, primitive: { topology ("triangle-list"),
  stripIndexFormat, frontFace ("ccw"), cullMode ("none") }, depthStencil: null | { format, depthWriteEnabled (false),
  depthCompare ("always") }, multisample: { count (1), mask (4294967295), alphaToCoverageEnabled (false) } }`, a blend
  component `{ operation ("add"), srcFactor ("one"), dstFactor ("zero") }`, `entryPoint` `null` for the module's only
  one.
- `pass`: `{ colorAttachments: [null | { view: h, resolveTarget, clearValue: [r, g, b, a] ([0, 0, 0, 0]; `{ r, g, b, a
  }` becomes a list), loadOp, storeOp }], depthStencilAttachment: null | { view: h, depthClearValue, depthLoadOp,
  depthStoreOp, depthReadOnly (false) } }`.
- `writeBuffer`'s data offset and size count elements of a typed array, bytes of an `ArrayBuffer`; `writeTexture`
  takes its data from the layout's `offset` to the end. Both copy the bytes when called. Origins default to
  `[0, 0, 0]`, extents' height and layers to 1, `rowsPerImage` to `null`, `mipLevel` to 0; `setVertexBuffer` and
  `setIndexBuffer` offset 0 and size -1; `draw` and `drawIndexed` instance count 1, the rest 0; `setBindGroup`'s
  dynamic offsets `[]`.

The host tells the program each canvas's size, by key, before the program's next frame, whenever it changes (opencode:
a `canvas` message), and gives the replay the same size (`Gpu::resize`). A `context` op names one of these canvases.

**Canvas size.** A GPU canvas's backing size, its texture's, is its size in physical pixels clamped to the texture
limit (4096, Limits) with its aspect ratio kept: when the larger side is over 4096, it becomes 4096 and the other
⌊side × 4096 / larger side⌋ (integer division), at least 1. The host tells the program the clamped size, so a texture
of the canvas's size always fits: a 5K full-screen canvas, 5120 × 2880, is 4096 × 2304 and never errors. The host
scales the texture to the canvas's box. `clamp_size` is the rule here; opencode's `canvasSize`
(`packages/widget/src/gpu.ts`) is the rule in TypeScript.

**A canvas's contents in a frame.** A canvas is cleared to transparent once per frame, at the frame boundary (each
frame request, `Gpu::end_frame`), not once per batch. Batches posted within a frame see what earlier passes in that
frame drew. A frame with no pass into a canvas leaves the last presented image showing. So the frame's first pass into
a canvas sees transparent, `loadOp: "load"` included, as on the web (`getCurrentTexture`); a host that keeps a canvas's
texture between frames clears it before the frame's first pass into it.

## Limits

A program over a limit has a program error; the host stops that canvas (Errors and device loss).

- Device limits: WebGPU's default limits, except `maxTextureDimension2D` 4096 (what Vulkan guarantees on Android;
  canvases are clamped to it, Canvas size) and `maxBufferSize` 64 MB (`device_limits`); a recording API reports them
  in `device.limits`.
- Resources: at most 256 MB of buffers and textures per run (sizes as allocated: width × height × bytes per texel ×
  samples, mip levels included), and 4,096 live handles.
- Per batch: at most 4 MB of `bytes` and 20,000 ops; per frame (between two frame requests), at most 16 render passes
  and 10,000 draws. The counts start again at each frame request, with a batch or without one.
- Shaders: 256 KB of WGSL per module.

## Host checks

Before it replays a batch (or instead, without a GPU), every host checks it without a GPU, with exactly these rules and
messages, so all hosts fail the same programs the same way (`src/check.rs`; opencode's `packages/widget/src/gpu.ts` in
TypeScript). They read `ops` as Transport says (`undefined` as JSON reads it). The first failure is the batch's program
error (phase `gpu`), and the rest of the batch isn't replayed. When it fails at op `i`, ops 0 to `i` − 1 take effect, as
separate WebGPU calls would (the resources they create, their writes, the submits they make), and an encoder or pass
still open at op `i` is dropped without being submitted; the host checks' handle state does the same, so a later batch
may use a handle those ops made. Errors from replaying (WebGPU validation) follow, in the GPU implementation's wording
(Errors and device loss).

- **The batch:** an object (`a batch must be an object`) with `ops` a list (`a batch's ops must be a list`) of at most
  20,000 (`the number of ops in a batch is over the limit of 20000`) and `bytes` an `ArrayBuffer` (`a batch's bytes
  must be an ArrayBuffer`) of at most 4 MB (`the size of a batch's bytes is over the limit of 4194304`). A native host
  may make the first three as it converts the posted value to its own types, before the op checks and any replay;
  that is allowed, with these messages (`Gpu::shape_error`).
- **Each op** fails as `gpu op <i>: <reason>` (`<i>` from 0), checked in order: a list that starts with a string (`an op
  is a list that starts with its name`), a name in the `Op` type or `error` (`unknown op "<name>"`), exactly its
  arguments (`"<name>" takes <k> arguments`); an `error` op fails with its message; `pass` not inside a pass (`"pass"
  inside a render pass`), `setPipeline` … `drawIndexed` and `end` only inside one (`"<name>" outside a render pass`),
  every other op only outside (`"<name>" inside a render pass`). At the batch's end no pass is open (`a render pass is
  still open at the end of the batch`, no op index).
- **Arguments,** first to last, then descriptor members in the order of the shapes above, each named by its path
  (`"<name>" argument <i>`, then `.member` and `[index]`, as in `"renderPipeline" argument 2.vertex.buffers[0].arrayStride`):
  `<path> must be a whole number` (an integer ≥ 0: sizes, offsets, counts, indices, handles), `<path> must be a whole
  number or -1` (sizes that may be -1), `<path> must be an integer` (`drawIndexed`'s base vertex), `<path> must be a
  finite number` (clear values, viewports, lod clamps, depth clear values), `<path> must be true or false`, `<path>
  must be a string`, `<path> must be a list` or `must be a list of <n>` (origins and extents 3, clear values 4), `<path>
  must be an object`, `<path> must be one of <a>, <b>, …` (the subset's values, in the order `src/check.rs` and
  opencode's `packages/widget/src/gpu.ts` list them), `<path> must combine <A>, <B>, …` (flags outside the subset's:
  buffer usage `COPY_SRC, COPY_DST, INDEX, VERTEX, UNIFORM, STORAGE`, texture usage `COPY_SRC, COPY_DST,
  TEXTURE_BINDING, RENDER_ATTACHMENT`, visibility `VERTEX, FRAGMENT`), `<path> needs exactly one of buffer, sampler and
  texture`, `<path> must be a buffer binding, a sampler or a view`.
- **Handles:** a new one is greater than every handle before (`handle <h> was already used`; a `context` op may repeat
  its own handle with the same key); one an op names exists (`no handle <h>`), is of the kind the op takes (`handle <h>
  is a <kind>, not a <kind>`, or `… not a buffer or texture` for `destroy`; kinds `context`, `buffer`, `texture`, `view`,
  `sampler`, `shader`, `bindGroupLayout`, `pipelineLayout`, `renderPipeline`, `bindGroup`; a view's texture may be a
  context) and isn't destroyed (`handle <h> was destroyed`; destroying a texture destroys its views). A `context` op's
  key is a canvas the host gave (`Gpu::resize`) and didn't remove since (`Gpu::remove`) (`no GPU canvas with key
  "<key>"`).
- **Canvas textures** are only rendered into. A texture argument of `writeTexture`, `copyBufferToTexture` or
  `copyTextureToTexture` that is a context's handle fails `<path> uses canvas "<key>"'s texture, which can only be
  rendered into` (checked in place of its kind, so this and not `handle <h> is a context, not a texture`); so does a
  bind group entry's `resource.view` whose texture is a context's, once the view itself passed. `<key>` is the
  context's canvas key, as in `"copyTextureToTexture" argument 1 uses canvas "scene"'s texture, which can only be
  rendered into`.
- **Bytes:** `writeBuffer` and `writeTexture` read inside the batch's bytes (`bytes [<start>, <end>) are outside the
  batch's <n> bytes`).
- **Limits** (`<what> is over the limit of <n>`): a buffer's size (`"buffer" argument 2`, 67108864), a texture's width
  and height (`"texture" argument 2` and `3`, 4096) and layers (`"texture" argument 4`, 256), a shader's UTF-8 bytes
  (`"shader" argument 2`, 262144), a color target's `writeMask` (its path, 15), `the number of live handles` (4096:
  handles made, less destroyed buffers and textures and their views; a lost device's handles are gone), `the size of
  buffers and textures` (268435456: buffers' sizes, and textures' bytes per texel × width × height × layers × samples
  summed over mip levels, a texel 4 bytes but 1 for `r8unorm` and 8 for `rgba16float`; canvas textures don't count),
  `the number of render passes in a frame` (16) and `the number of draws in a frame` (10000), counted over a frame's
  batches up to and including the one its frame request carries; the counts start again after every frame request,
  one without a batch included (`Gpu::end_frame`).

## Errors and device loss

- **Program errors** (`ErrorKind::Program`, phase `gpu`): a WGSL module that fails validation, any WebGPU validation
  error in a replayed op (wgpu's and the browser's validation implement WebGPU's rules), an `error` op, and what the
  host checks (Host checks). The first uncaptured GPU error is enough (no error scopes). The program keeps running. A
  validation error's message is the GPU implementation's own wording (wgpu's or the browser's), so only the host
  checks' messages are the same on every host.
- **Client errors** (`ErrorKind::Client`, not reported; logged): no GPU, device creation failure, a driver crash or
  reset, running out of GPU memory under the limits. The canvas shows its placeholder.
- **Which canvases stop.** The device is the run's, shared by its GPU canvases. An error in a batch stops the canvases
  that batch renders into (a pass of the batch has a view of a canvas's texture as a color attachment's `view` or
  `resolveTarget`, the view made in that batch or before); if the batch renders into none (a bad pipeline, a write),
  every GPU canvas of the run stops (`Stops`). A stopped canvas shows its placeholder with the error, its error is
  reported once, and the host ignores later batches for it (after an error that stopped every canvas, all later
  batches). An error that stops only canvases already stopped isn't reported again.
- **Stopped stays stopped.** A canvas an error stopped stays stopped, its placeholder showing its error, for the rest
  of the run: also when it leaves and comes back under the same key, and after a device loss. A program error is a bug
  in the program, and a new device doesn't fix it.
- **GPU hang.** A batch whose GPU work is still unfinished 250 ms after its submit stops every canvas it draws into (a
  pass's color attachment `view` or `resolveTarget`; drawing into none, every GPU canvas of the run, as Which canvases
  stop says) for the rest of the run, as an error would: a client error with exactly this message, `the GPU work hung;
  the canvas is stopped` (`HANG_MESSAGE`), and the placeholder shows. It catches GPUs without a watchdog. (On a host
  whose runs share one device and queue, as psychoscript-mobile's do, only the hung submit's run stops; work queued
  behind it isn't blamed.)
- **Strikes.** At a device loss, a run that had GPU work submitted and not yet seen finished gets a strike, if its GPU
  work has finished on a device at least once since its previous strike (or since the run started): losses in a row
  with no finished work in between belong to the same reset and count once (a reset in progress may discard a new
  device's first work and lose it again). A run with two strikes 30 s apart or less is stopped: every GPU canvas of the
  run stops for the rest of the run with the same message, and no new device restarts them. A run's first strike
  changes nothing visible: the loss restarts it as usual. (A GPU reset can't be attributed reliably on every platform,
  so a run present at two resets is treated as their cause, as browsers do.)
- **Device loss.** The host tells the program (opencode: a `gpu` message with the reason), and every handle is gone.
  The new device restarts only the canvases the loss stopped, once the program renders into them again, never a
  canvas an error or a GPU hang stopped.
- **A batch from before the program learned of the loss** names handles from before it: the host drops it quietly
  (not replayed, not reported, no canvas stops). Exactly: a batch whose first failure (Host checks) is `no handle <h>`
  with `h` from 1 to the greatest handle the host had made when it last lost the device. Before any loss no handle
  is, and handle 0 never is: those stay program errors.
- **A run restored from a snapshot** is a device loss. A host that snapshots runs keeps with the snapshot the greatest
  handle the program had made (`Gpu::last_handle`), and the canvases errors stopped, with their errors
  (`Gpu::saved_stops`). On restoring, it tells the program of the loss before the program runs on. Handles up to the
  kept one count as from before the loss (a batch naming one is dropped quietly, above; `Gpu::restored`), and the
  stopped canvases stay stopped (Stopped stays stopped), their errors not reported again (`Gpu::restore_stops`).

## Use

One `Gpu` per program run, made with the host's device, queue and canvas format (`Gpu::new`; `preferred_format`
for a backend's surfaces). It fails, a client error, when the device's limits are under `device_limits`; a host that
makes its own device requests those. The host:

- calls `Gpu::resize` for each canvas the program may draw, by key, when it tells the program that canvas's size
  (the size from `clamp_size`), and `Gpu::remove` for one that went away;
- calls `Gpu::apply` with each batch's ops (`Arg`, `Arg::from_json` for a post's JSON) and bytes, and
  `Gpu::end_frame` at each frame request, after the batch it carries;
- calls `Gpu::shape_error` instead for a posted batch its conversion rejects (not an object, ops not a list, bytes
  not an `ArrayBuffer`);
- shows `Gpu::canvas`'s texture for each GPU canvas, presenting again when its `version` moves;
- on an `Err`, shows the placeholder with the error on the canvases it stops (`GpuError::canvases`) and reports it
  (phase `PHASE`) when it is the program's (`ErrorKind::Program`), else logs it. `Gpu::error` gives a canvas's;
- calls `Gpu::poll` each display frame, to stop the canvases of GPU work that hangs (GPU hang);
- on a device loss, calls `Gpu::lost` at once, then with a new device `Gpu::reset`, and tells the program.

Each canvas is a texture the crate owns at the canvas's size, which the host composites. Replay never waits on a
surface. `poll(device)` polls a device without waiting, false when it is lost, for GPU work a host replays on the same
device itself.

On Metal, a host needs wgpu-hal with gfx-rs/wgpu#10875 (any command buffer that fails loses the device, as in Dawn;
stock wgpu-hal counts failed work finished and tells nothing), or the GPU hang and Strikes rules can't see Apple's own
GPU timeouts. Until a wgpu release has it, the host patches `wgpu-hal` in its own workspace (a `[patch]` doesn't reach a
crate's dependents): `[patch.crates-io] wgpu-hal = { git = "https://github.com/anomalyco/psychoscript", rev = "<rev>" }`
for this repository's `rust/vendor/wgpu-hal` (wgpu-hal 30.0.2 plus the fix), as opencode's `packages/widgets-rs` does;
Rune desktop patches it to Rune's own wgpu-hal, which has the same fix.

## Tests

Run from `rust/`:

```sh
cargo test -p psychoscript-gpu --features metal   # on a Mac
cargo test -p psychoscript-gpu                    # Vulkan: lavapipe on a machine without a GPU, or a real one
```

- `tests/conformance.rs` replays the 53 conformance fixtures in `tests/fixtures/gpu`, copies of opencode's
  `packages/widget/test/fixtures/gpu` (`specs/v2/widgets-gpu.md`, Conformance), on a real device: the host checks'
  errors must be the fixture's, exactly, and the valid fixtures must render without any error. A `raw-*` fixture's
  batch is in its source, run in the VM with a stub `widget` to post it.
- `tests/replay.rs` checks by their pixels what the fixtures don't cover (multisampling, copies, cube and array views,
  wgpu's own validation, device loss, resizing).
- Tests that hang the GPU on purpose run only on a software adapter (lavapipe, llvmpipe), and are skipped with a note
  elsewhere: on a real GPU they trip the watchdog, and macOS's may blame and lose other apps' work. Only with the GPU
  owner's OK, `PSYCHOSCRIPT_GPU_REAL_HANGS=1` runs them on any adapter.

