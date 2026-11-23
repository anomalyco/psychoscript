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
  JSON, `undefined` as `null`. `RunOptions(timeoutMs?, maxOutputBytes?, maxHeapBytes?)`: active-time limit, result
  size limit and heap cap, all off by default.
- `program.session(fieldsJson) -> RunSession` parses a JSON object once; `session.run(inputJson, options)` runs with
  those fields followed by `inputJson`'s own (a JSON object) as the input. The program sees the same input as
  `run` with the whole object (shared fields first). For a widget, keep a session per widget with its `data`, and send
  only `{ phase, state, event | frame }` per step. That saves sending and parsing `data` on every step: on a Mac JVM
  (Android-style JNA) bench with 25.6 KB of `data`, a trivial step went from ~400 to ~350 µs. Most of what remains is
  the VM turning the input into its own values, which every run pays.
- `PsychoScriptError` (Kotlin `PsychoScriptException`); `reason` is the message, `kind` the language's diagnostic kind,
  `line`/`column` 1-based in the source:
  - `Syntax(kind, reason, line, column)`: `ParseError`, or `UnsupportedSyntax` (which may surface only when a run
    reaches it).
  - `Runtime(kind, reason, line, column)`: `ExecutionFailure` (the reason starts with the thrown error's name, as
    `TypeError: ...`), `InvalidDataValue` (a result that isn't JSON data), or a host kind.
  - `Timeout(reason, timeoutMs)`, `OutputTooLarge(reason, maxOutputBytes)`, `InvalidInput(reason)` (input not JSON,
    `timeoutMs` 0).
  - `MemoryLimitExceeded(reason, maxHeapBytes)`: the run's heap went over `maxHeapBytes`. Sizes follow the language's
    model of what the program can still reach, not the process's memory.
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

### Bytes instead of JSON

A `ValueEncoder` writes what a program hands its host as bytes in its own format. The crate carries them and knows
nothing of the format. `ValueEncoder.widget()` (feature `widget-wire`, on by default) is OpenCode widgets' binary
format (opencode `specs/v2/widgets-binary.md`, crate `widget-wire`) for a native host of widget protocol 2
(`widgets.md`, Native hosts): it builds the view tree (ids, keys, handlers) itself while it encodes, from the view as
the program built it. Runs with an encoder pass program functions to the host as markers (psychoscript
`translate: { functions: "mark" }`). Runs with the widget encoder (steps and live runs) also have psychoscript's typed
arrays (`typedArrays: true`: `ArrayBuffer`, `Float32Array`, `Uint16Array`, `Uint32Array`, `Int32Array`,
`Float64Array`), for a GPU batch's bytes; other runs keep psychoscript's default, without them (only `Uint8Array`).
A snapshot resumes only with the same setting, so restore a widget run with the widget encoder.

- **Checked before running.** `runBytes` and `startLive` with an encoder first let it check the program's first line;
  a refused program doesn't run, and the call fails with `Runtime` of the encoder's kind. The widget encoder runs only
  protocol 2 (`const __widget_protocol = 2`): an older program fails with kind `OlderProtocol` and the message
  `This widget was built with an older widget runtime; ask the agent to post it again` (a program error in the phase
  of the step or run refused: `init`, `event`, `draw`, `main`), a newer one with kind `NewerProtocol` and
  `This widget needs a newer version of this app` (a client error: show it, don't report it).
- `program.runBytes(inputJson, encoder, options = RunOptions())`, also on `RunSession`, defines the host global
  `encoder.emitName()` (`__widget_emit`) beside the input function, and returns the bytes the encoder makes of what
  the program passed to the global and of the run's result, instead of the result's JSON. For widgets: the encoder
  reads the step's `phase` from the input. In `init` and `event` steps the view goes through `__widget_emit`, and
  `{ state, submit?, dismiss?, send? }` is the run's result, so it keeps the JSON path's rules exactly (`toJSON`, an
  `Error`'s fields, a typed array failing the step). In `draw` steps the commands go through `__widget_emit`, read as
  JSON reads them (functions left out), and the run has no result.
  `maxOutputBytes` limits the bytes. Failures (`Runtime`, by kind):
  - `InvalidView`, no line: the view breaks Keys and depth (`A node's key must be a string, a number or a boolean`,
    `The view nests more than 100 levels`), whatever the run did after;
  - `InvalidDraw`, no line: a draw step's commands failing the Draw command checks (`widgets.md`, Canvas), with
    exactly that section's message, e.g. `draw command 2: a text weight must be 400, 500, 600 or 700` (after the
    run; the run's own failure first). Clients get the normalised commands (clamped values, defaults for absent
    fields);
  - `ExecutionFailure` `TypeError: Argument <n> to __widget_emit contains a function, which cannot be passed to the
    host. (line, col)`: a function in the view anywhere but a node's `onPress`, `onChange`, `onPointer`;
  - `InvalidDataValue` `The step gave no view`: an init or event step that never called `__widget_emit`;
  - and the run's own failures, as `run` has them.
- With `startLive(..., encoder:)` (and `LiveRun.restore(..., encoder:)`, with the same encoder), every post reaches
  `handler.onPostsBytes(messages)` as the encoder's bytes, a wake-up's posts in one call, and `onPosts` is never
  called. `__host.post` returns what the encoder says: for a widget `render`, whether the view has handlers (the
  prelude keeps the run going on it), else `undefined`. A post the encoder can't write throws at `__host.post`:
  uncaught, the run ends with `Failed(Runtime)` of the encoder's kind, located at the post. A live draw's commands
  get a draw step's checks and message (kind `InvalidDraw`, the message without an `invalid post:` prefix). A view
  breaking Keys and depth doesn't throw: the run ends at once with `Failed(Runtime(kind: "InvalidView"))`, no line.
  What the encoder keeps (a widget's canvases by key) goes into a snapshot.
- **An encoder may hold posts back** and hand them over later: the crate asks it again when it says (its timer wakes
  the waiting run, whose next poll hands them over), and takes all of them when the run ends, before `onExit`,
  unless `stop()` ended it (then they're dropped). The widget encoder holds back for the **post rate**
  (`widgets-live.md`, Post rate): `render` and `draw` posts take a token from a bucket of 8 refilled at 240 a second;
  without one they wait, a newer render replacing the waiting render and a newer draw the waiting draw of its canvas
  key, and go out in order as tokens come. Every post is checked when it's posted (errors and `post`'s answer don't
  wait). `submit` and `dismiss` hand over what waits first; `frame`, `send`, `capture` and GPU batches go at once;
  a frame request while one is pending (no `frame` delivered since) sends nothing but its GPU batch. Nothing is
  dropped and the rate is never an error. A `draw` post whose `key` isn't a string ends the run with
  `Failed(Runtime(kind: "InvalidDataValue", reason: "A draw post needs a string key"))`, no line.
- A function (marker) in the argument of a host function the encoder doesn't handle, or where the encoder allows none
  (a post's values, draw commands, `fetch`'s request), fails the call with the runtime's `TypeError`
  `Argument <n> to <name> contains a function, which cannot be passed to the host.` at the call, as it does without
  an encoder: a real `TypeError` the program can catch, located at the call when uncaught.
- Widget live draws name their canvas by key (`{ type: "draw", key, commands }`); the encoder sends the canvas's id
  from the last render. An unknown key, or a canvas drawn by its `wgsl`, throws an `Error` at the post that the
  program can catch, as the prelude does.
- The widget encoder's kinds name the spec's phase for the report: `InvalidView` (phase `view`), `InvalidDraw`
  (`draw`), `InvalidGpu` (`gpu`, a batch in a frame request or on its own). Anything else it can't write (an unknown
  post type) is `InvalidDataValue`, an invalid post as today.

## Live runs

`program.startLive(inputJson, handler, options = LiveOptions(), transport = nil, encoder = nil)` runs the program on a thread of
its own until it returns or is stopped. Beside its input function it gets `__host`:

| Function | Kind | |
| --- | --- | --- |
| `__host.post(message)` | sync | `handler.onPosts([json, ...])`, a wake-up's posts in one call (`onPostsBytes` with an encoder) |
| `await __host.receive()` | async | the next message `deliver(json)` queued, in order |
| `await __host.sleep(ms)` | async | resolves after `ms` of running time (clamped to >= 0) |
| `__host.now()` | sync | ms of running time, paused time left out |
| `await __host.fetch(request)` | async | HTTPS through the app's `FetchTransport` (below) |

- `LiveHandler` (callback interface): `onPosts(messagesJson)` gets every post of one wake-up of the program, in
  order, in one call, as soon as the program waits again (or ends). A live frame that draws and then asks for the next
  frame costs one callback, not two. `onPostsBytes(messages)` replaces `onPosts` for a run with an encoder (above);
  implement it as a no-op otherwise. `onWarning(message)` comes in its own call (the crate sends none at present). Both run on the run's thread: hand
  them to the UI thread and return. `onExit(LiveExit)` runs once on the run's thread:
  `Finished(resultJson)`, `Failed(error)` (`SliceBudget`, `Runtime`, ...), or `Stopped`.
- `LiveOptions(sliceBudgetMs = 50, httpsHosts = nil, allowLocalNetwork = false, maxHeapBytes = nil)`. The crate
  limits no post rate: a widget's is its encoder's (above).
  - **Slice budget:** a run computing past the budget without waiting is stopped with `SliceBudget`. Only the VM's
    own execution counts, in its thread's CPU time, so time the OS doesn't schedule the thread (a loaded device, a
    paused emulator) isn't compute: not the time it waits on pending host calls (several at once included), and not time
    inside host code on its thread (`post`, `now`, the input function, polls of host calls, and the handler's
    callbacks, however long the app takes in them). Pausing doesn't change the accounting. A run that reaches a wait
    while paused (its calls are held by the pause) answers the check from there and counts as at rest. A run still
    computing while paused is stopped as it would be otherwise. On resume, the program's next stretch starts a fresh
    budget, so the paused time never counts. Don't "reset" the stretch on pause: a loop that never waits would then
    run unchecked. The language can't
    time-slice a VM, so the crate has psychoscript's suspender stop the run at its next step, which works inside tight
    loops. A timer checks each stretch of compute; past the budget it probes the run by waking its pending host calls,
    which the VM polls as soon as it waits and can't while it computes. An unanswered probe (30 ms grace) means the run
    is still computing.
  - **Heap:** `maxHeapBytes` caps the run's heap: over it the run ends with `Failed(MemoryLimitExceeded)`. The
    contract's default for live widgets is 32 MB (`32 * 1024 * 1024`), but the crate sets no default: pass it.
    A snapshot keeps the cap it ran with.
- `deliver(json)`, `pause()`, `resume()`, `snapshot()`, `stop()`, `isRunning()`;
  `LiveRun.restore(snapshot, handler, inputName = "__input", options = LiveOptions(), transport = nil, encoder = nil)`.
  - `pause()`: no frames, messages or timers reach the program. `sleep` timers freeze with their remaining time,
    `now()` stops, delivered messages and finished fetches are held, and nothing is scheduled. A stretch of compute in
    progress finishes first (within the slice budget). After that it costs no CPU (measured: 0 ms over 2 s).
  - `resume()`: the program's next `receive` is `{ type: "resumed", pausedMs }`, before anything delivered meanwhile.
    A program waiting in `sleep` or `fetch` finishes that first.
  - `snapshot()`: for a run paused a while (over 30 s, or when the OS asks for memory). It saves the paused run's state
    (psychoscript `suspend`), ends its thread and frees its VM, and returns the bytes. `resume()` continues it here;
    `LiveRun.restore` continues it in a later process of the same build, with input, running time and timers. Messages
    delivered but not yet received stay in the old run. It fails with `Snapshot` while a `fetch` is in flight: then
    `stop()` and start again later.
  - `stop()`: doesn't block. A waiting run wakes to an interrupt; a computing one is suspended at its next step.
    Dropping the `LiveRun` stops it.

### fetch

`options.httpsHosts` is the template's `https` capability: exact names, `*.` suffixes (not the bare domain), or `*`,
each optionally with a `:port` (`localhost:4097`) that then must match. Without it, or without a transport, every
fetch rejects with `CapabilityDenied`. The program passes `{ url, method?, headers?, body? | body64? }` and gets
`{ status, url, headers, body | body64 }`: the body is text when it's UTF-8, else base64. Headers come lowercased,
with repeats joined and `set-cookie` dropped. Rejections are errors with `kind` (`CapabilityDenied`, `Network`,
`Timeout`, `TooLarge`, `RateLimited`) and `message`.

The crate enforces:
- `https:` only, and no credentials in the URL.
- The host must be on the list, checked again on every redirect. The crate follows redirects itself, at most 5, and
  turns 303 (and 301/302 after POST) into GET.
- Methods GET, POST, PUT, PATCH, DELETE and HEAD.
- `Cookie`, `Host`, `Content-Length` and hop-by-hop request headers are dropped.
- Request body at most 256 KB, response body at most 2 MB, 15 s per fetch with its redirects included.
- At most 4 fetches in flight and 10 a second per run.
- No loopback, private, link-local, CGNAT, multicast or reserved destination, checked against the address the
  transport connects to:
  - **Resolve once:** the crate resolves the host itself (a literal IP as is) and checks every address. The transport
    gets them in `request.addresses` and must connect to one of them: OkHttp with a `Dns` that returns them (below),
    so DNS rebinding can't redirect the connection.
  - **Check again:** the address the transport reports in `remoteAddress` is checked before the program sees the
    response.
  - **iOS limitation:** URLSession resolves names itself and can't be told which address to use. The Swift sample
    reports the address it connected to (transaction metrics), so a rebound response never reaches the program.
    The request has still been sent by then.

**Dev mode** (`LiveOptions.allowLocalNetwork`, default off; on only in debug builds or by the user's choice, e.g. a
debug-settings toggle) also allows loopback, private (RFC 1918, CGNAT, IPv6 unique local) and link-local
destinations, and plain `http:` to them (never to a public address), still only for declared hosts, e.g.
`["localhost:4097"]`. iOS: plain `http:` also needs `NSAppTransportSecurity` / `NSAllowsLocalNetworking` in the
debug build's Info.plist, and local addresses need `NSLocalNetworkUsageDescription`.

The transport carries one exchange and doesn't follow redirects. It uses an ephemeral session: no cookies, cache,
credential store or client certificates. It calls `completion.succeed(...)` or `completion.fail(...)` once, from any
thread.

```swift
final class URLSessionTransport: NSObject, FetchTransport, URLSessionDataDelegate, @unchecked Sendable {
    private struct Exchange {
        let request: FetchRequest
        let completion: FetchCompletion
        var data = Data()
        var remote: String?
    }
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private var exchanges: [Int: Exchange] = [:]   // by task identifier
    private var tasks: [UInt64: URLSessionTask] = [:]
    private let lock = NSLock()

    func start(request: FetchRequest, completion: FetchCompletion) {
        guard let url = URL(string: request.url) else { return completion.fail(message: "bad URL") }
        var r = URLRequest(url: url, timeoutInterval: Double(request.timeoutMs) / 1000)
        r.httpMethod = request.method
        r.httpBody = request.body
        for h in request.headers { r.setValue(h.value, forHTTPHeaderField: h.name) }
        let task = session.dataTask(with: r)
        lock.withLock {
            exchanges[task.taskIdentifier] = Exchange(request: request, completion: completion)
            tasks[request.id] = task
        }
        task.resume()
    }

    func cancel(id: UInt64) {
        lock.withLock { tasks.removeValue(forKey: id) }?.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let over = lock.withLock { () -> Bool in
            guard var e = exchanges[dataTask.taskIdentifier] else { return false }
            e.data.append(data)
            exchanges[dataTask.taskIdentifier] = e
            return e.data.count > Int(e.request.maxResponseBytes)
        }
        if over { dataTask.cancel() }   // the crate reports TooLarge
    }

    // The address it actually connected to, which the crate checks.
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let remote = metrics.transactionMetrics.last?.remoteAddress
        lock.withLock { exchanges[task.taskIdentifier]?.remote = remote }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let e = lock.withLock({ () -> Exchange? in
            tasks.removeValue(forKey: exchanges[task.taskIdentifier]?.request.id ?? 0)
            return exchanges.removeValue(forKey: task.taskIdentifier)
        }) else { return }
        let over = e.data.count > Int(e.request.maxResponseBytes)
        guard let http = task.response as? HTTPURLResponse, error == nil || over else {
            return e.completion.fail(message: error?.localizedDescription ?? "no response")
        }
        let headers = http.allHeaderFields.map { HttpHeader(name: "\($0.key)", value: "\($0.value)") }
        e.completion.succeed(response: FetchResponse(
            status: UInt16(http.statusCode), headers: headers, body: e.data, remoteAddress: e.remote))
    }

    // The crate checks and follows redirects.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    // Server trust as usual; no client certificates or HTTP auth.
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
            ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
}
```

```kotlin
class OkHttpTransport : FetchTransport {
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)        // the crate checks and follows redirects
        .cookieJar(CookieJar.NO_COOKIES)
        .build()
    private val calls = ConcurrentHashMap<ULong, Call>()

    override fun start(request: FetchRequest, completion: FetchCompletion) {
        val url = request.url.toHttpUrl()
        // Connect only to the addresses the crate resolved and checked (literals: no lookup). Other names (a proxy)
        // resolve as usual.
        val checked = request.addresses.map { InetAddress.getByName(it) }
        val type = request.headers.firstOrNull { it.name == "content-type" }?.value?.toMediaTypeOrNull()
        val body = request.body?.toRequestBody(type)
            ?: if (HttpMethod.requiresRequestBody(request.method)) ByteArray(0).toRequestBody(type) else null
        val builder = Request.Builder().url(url).method(request.method, body)
        request.headers.forEach { builder.addHeader(it.name, it.value) }
        val call = client.newBuilder()
            .dns { host -> if (host == url.host) checked else Dns.SYSTEM.lookup(host) }
            .callTimeout(request.timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .build()
            .newCall(builder.build())
        calls[request.id] = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                calls.remove(request.id); completion.fail(e.message ?: "network error")
            }
            override fun onResponse(call: Call, response: Response) {
                calls.remove(request.id)
                response.use {
                    val max = request.maxResponseBytes.toLong() + 1       // one more: the crate reports TooLarge
                    val source = it.body.source().apply { request(max) }
                    val bytes = source.buffer.readByteArray(minOf(source.buffer.size, max))
                    completion.succeed(FetchResponse(it.code.toUShort(), it.headers.map { (n, v) -> HttpHeader(n, v) }, bytes, null))
                }
            }
        })
    }

    override fun cancel(id: ULong) { calls.remove(id)?.cancel() }
}
```

## Threading and cost

`Program` and `LiveRun` are `Send + Sync`. Each live run has one thread (1 MB of stack reserved, ~136 KB resident
while idle with a small program), one timer thread shared by all, and a short-lived thread per `fetch` and per budget
stop. `run`s may come from any thread, concurrently too: each run gets its own VM over the shared
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

With the binary format (widget protocol 2, a native host): the step program ends in
`return __widget_native_step(__input())` instead of `return __widget_step(__input())`, a live one in
`return await __widget_live(__input(), true)`, and the app decodes the bytes (`widgets-binary.md`) rather than parsing
JSON. Live posts arrive in `onPostsBytes`:

```swift
let wire = ValueEncoder.widget()
let program = try Program(source: served.program + "\nreturn __widget_native_step(__input())")
let liveProgram = try Program(source: served.program + "\nreturn await __widget_live(__input(), true)")
let bytes = try program.runBytes(inputJson: stepInputJson, encoder: wire, options: step)    // 01 'S' ... or 01 'D' ...
let run = try liveProgram.startLive(inputJson: input, handler: handler, options: opts, transport: t, encoder: wire)
```

```kotlin
val wire = ValueEncoder.widget()
val program = Program(served.program + "\nreturn __widget_native_step(__input())")
val liveProgram = Program(served.program + "\nreturn await __widget_live(__input(), true)")
val bytes = program.runBytes(stepInputJson, wire, RunOptions(timeoutMs = 250uL))
val run = liveProgram.startLive(input, handler, opts, transport, wire)          // handler.onPostsBytes(List<ByteArray>)
```

`examples/wire_bench.rs` times both paths on opencode's bench workloads (`tests/fixtures/workloads`).

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
