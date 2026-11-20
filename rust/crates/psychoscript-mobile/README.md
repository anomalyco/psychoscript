# psychoscript-mobile

PsychoScript for iOS and Android: UniFFI bindings over the `psychoscript` crate, with no JavaScript engine. A host
hands a program JSON and reads JSON back. With the `shader` feature (on by default) it also translates WGSL to MSL and
GLSL ES 3.00 with naga.

| | Swift | Kotlin |
| --- | --- | --- |
| Module / package | `import PsychoScript` | `com.anomalyco.psychoscript` |
| Native library | `PsychoScriptFFI.xcframework` (static) | `libpsychoscript_mobile.so` (JNA) |

## API

```swift
let program = try Program(source: source)                       // inputName: "__input" by default
let out = try program.run(inputJson: #"{"n":21}"#, options: RunOptions(timeoutMs: 250))
```

```kotlin
val program = Program(source)                                   // inputName = "__input" by default
val out = program.run("""{"n":21}""", RunOptions(timeoutMs = 250uL))
```

- `Program(source, inputName = "__input")` compiles once. Fails with `Syntax`.
- `run(inputJson, options = RunOptions())` runs it: `inputName()` is a sync host function returning the input, and the
  result is the program's completion value (a top-level `return`'s, or the last expression statement's) as compact
  JSON, `undefined` as `null`. `RunOptions(timeoutMs?, maxOutputBytes?)`: active-time limit and result size limit,
  both off by default.
- `PsychoScriptError` (Kotlin `PsychoScriptException`); `reason` is the message, `kind` the language's diagnostic kind,
  `line`/`column` 1-based in the source:
  - `Syntax(kind, reason, line, column)`: `ParseError`, or `UnsupportedSyntax` (which may surface only when a run
    reaches it).
  - `Runtime(kind, reason, line, column)`: `ExecutionFailure` (the reason starts with the thrown error's name, as
    `TypeError: ...`), `InvalidDataValue` (a result that isn't JSON data), or a host kind.
  - `Timeout(reason, timeoutMs)`, `OutputTooLarge(reason, maxOutputBytes)`, `InvalidInput(reason)` (input not JSON,
    `timeoutMs` 0).
- `translateWgsl(source, target: msl | glslEs300, stage: vertex | fragment, entry) -> TranslatedShader(code,
  entryName, uniformBlocks: [UniformBlock(group, binding, name, slot)])`, or `ShaderError` (Kotlin `ShaderException`):
  `Parse` / `Validation` (with `line`, `column`), `Unsupported` (no such entry, or a resource other than uniform
  buffers), `Translation`. Validation allows baseline capabilities only, indexing is bounds-checked (`Restrict`) and MSL
  loops are forced bounded, so untrusted shaders can't read out of bounds or hang the GPU in a loop.
  - MSL 2.3: bind uniform `slot` as `[[buffer(slot)]]` (`setFragmentBytes(_, length:, index: slot)`); the function is
    `entryName`.
  - GLSL ES 3.00: the entry is `main`; bind a block with
    `glUniformBlockBinding(prog, glGetUniformBlockIndex(prog, name), slot)`. Clip space stays WGSL's (no y flip, z in
    0...1), and `gl_FragCoord` counts from the bottom left, unlike WGSL's `@builtin(position)`.

Swift errors also get `.reason` on the enum. Kotlin exceptions' `message` lists every field.

## Threading and cost

`Program` is `Send + Sync`. Runs may come from any thread, concurrently too: each run gets its own VM over the shared
compiled program. A run is synchronous, so keep it off the main thread when it can be slow. In Kotlin, `Program` is
`AutoCloseable`: `close()` frees it right away, rather than when the GC cleaner gets to it.

What one `run` copies:

1. The input string, encoded once by UniFFI into a Rust-owned buffer that becomes the Rust `String` without another
   copy.
2. Parsed straight into the language's host value (no `serde_json::Value` in between); the first `__input()` call
   hands it over whole, and later calls parse the kept text again.
3. The VM's own values for it, the run's heap, and a small `Runtime` (a few allocations).
4. The result, as the language crate builds it (VM value, then its JSON data), written once as a JSON string that
   becomes UniFFI's return buffer without a copy, and is decoded once into a Swift/Kotlin string.

Logs (`console.log`) are kept for the run and dropped; the timeout bounds them.

## Building

```sh
rust/crates/psychoscript-mobile/scripts/build-ios.sh <out>        # macOS + Xcode -> <out>/PsychoScript (Swift package)
ANDROID_NDK_HOME=… rust/crates/psychoscript-mobile/scripts/build-android.sh <out>
                                                                  # -> <out>/jniLibs, <out>/kotlin
```

Both need the toolchain in `rust/rust-toolchain.toml` with the targets they name (`rustup target add …`), and
`cargo install cargo-ndk` for Android. They write `<out>/REVISION` (the commit) and copy this README.
`FEATURES=--no-default-features` builds without `translateWgsl` (about 1 MB less code). The ICU data the language
crate compiles in for `Intl`-style date formatting and collation (most of the ~5 MB of read-only data) can't be left
out from this crate: that would need a feature in `psychoscript` itself.

### In an app: pin a rev, build into a gitignored directory

```sh
# scripts/psychoscript.sh in the app; .psychoscript/ and Vendor/PsychoScript/ in .gitignore
REV=<commit on anomalyco/psychoscript mobile>
[ -d .psychoscript ] || git clone https://github.com/anomalyco/psychoscript .psychoscript
git -C .psychoscript fetch origin "$REV" && git -C .psychoscript checkout --detach "$REV"
.psychoscript/rust/crates/psychoscript-mobile/scripts/build-ios.sh Vendor/PsychoScript         # iOS
# Android: ANDROID_NDK_HOME=… .psychoscript/rust/crates/psychoscript-mobile/scripts/build-android.sh vendor/psychoscript
```

- iOS: add the local package `Vendor/PsychoScript/PsychoScript` (Xcode › Add Package Dependencies › Add Local…, or
  `.package(path: "Vendor/PsychoScript/PsychoScript")`) and its product `PsychoScript` to the app target.
- Android: `android { sourceSets["main"].jniLibs.srcDir("…/vendor/psychoscript/jniLibs") }`, add
  `…/vendor/psychoscript/kotlin` as a Kotlin source dir (`sourceSets["main"].kotlin.srcDir(...)`), and
  `implementation("net.java.dev.jna:jna:5.17.0@aar")`. With R8: keep `com.sun.jna.**` and
  `com.anomalyco.psychoscript.**`, and `-dontwarn java.awt.**`.

## OpenCode widgets on this API

The widget glue lives in the apps; with this API it's a few lines. A widget template's served `program` is
`prelude + "\n" + source`, and the step ABI is one entry call:

```swift
let program = try Program(source: served.program + "\nreturn __widget_step(__input())")
let step = RunOptions(timeoutMs: 250), draw = RunOptions(timeoutMs: 8)
let out = try program.run(inputJson: #"{"phase":"init","data":\#(dataJson)}"#, options: step)   // {state, view, ...}
let frame = try program.run(inputJson: drawInputJson, options: draw)                               // {commands}
```

```kotlin
val program = Program(served.program + "\nreturn __widget_step(__input())")
val out = program.run("""{"phase":"init","data":$dataJson}""", RunOptions(timeoutMs = 250uL))
val frame = program.run(drawInputJson, RunOptions(timeoutMs = 8uL))   // a Timeout here counts as a draw overrun
```

A `shader` node: wrap its `wgsl` in the spec's header and entry point, translate `widget_main`, and draw a full-screen
triangle. GLES flips `frag.y` in the entry point so templates see a top-left origin everywhere (`resolution` is in
physical pixels):

```swift
let header = """
struct Widget { resolution: vec2f, time: f32, scale: f32, pointer: vec4f, values: array<vec4f, 4> }
@group(0) @binding(0) var<uniform> widget: Widget;

"""
let entry = "\n@fragment fn widget_main(@builtin(position) p: vec4f) -> @location(0) vec4f { return shade(p.xy); }\n"
let vertex = """
@vertex fn widget_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}
"""
let fragment = try translateWgsl(source: header + node.wgsl + entry, target: .msl, stage: .fragment, entry: "widget_main")
let vs = try translateWgsl(source: vertex, target: .msl, stage: .vertex, entry: "widget_vertex")
// MTLLibrary(source: fragment.code).makeFunction(name: fragment.entryName); setFragmentBytes(&uniforms, length: 96, index: 0)
```

```kotlin
val entryGl = "\n@fragment fn widget_main(@builtin(position) p: vec4f) -> @location(0) vec4f " +
    "{ return shade(vec2f(p.x, widget.resolution.y - p.y)); }\n"
val fs = translateWgsl(header + node.wgsl + entryGl, ShaderTarget.GLSL_ES300, ShaderStage.FRAGMENT, "widget_main")
val vs = translateWgsl(vertex, ShaderTarget.GLSL_ES300, ShaderStage.VERTEX, "widget_vertex")
// after linking: fs.uniformBlocks.forEach { glUniformBlockBinding(prog, glGetUniformBlockIndex(prog, it.name), it.slot.toInt()) }
```

The 16 KB source cap, the draw command cap, output parsing and the 50 ms shader frame budget are the app's, per the
spec.
