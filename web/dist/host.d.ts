import { Images } from "./canvas.js";
import type { ErrorInfo, FromWorker, ToWorker } from "./protocol.js";
import { Ticker } from "./render.js";
import type { Theme } from "./theme.js";
export interface Capabilities {
    https?: {
        hosts: string[];
    };
}
export type WidgetStatus = "open" | "submitted" | "dismissed";
export interface MountOptions {
    /** The served program: prelude + "\n" + widget template source (`Program.program` from `opencode.widget/program`). */
    program: string;
    /** The widget's data (the `widget` tool call's `data`). */
    data: unknown;
    /** `"step"` (default) or `"live"`. */
    mode?: "step" | "live";
    /** The widget template's capabilities (live only); granted as declared, shown as a chip. */
    capabilities?: Capabilities;
    /**
     * Dev mode only (widgets-live.md, "Local network in dev mode"; default false): `fetch` may also reach loopback,
     * private and link-local addresses and local names (`localhost`, `*.local`), over `http:` too and on any declared
     * port, when the widget template declares them (`localhost:4097`, `127.0.0.1`; `*` doesn't count). The page's CSP
     * `connect-src` must allow them as well (e.g. `http://localhost:4097`). Never turn it on for release builds by
     * default.
     */
    allowLocalNetwork?: boolean;
    /** The widget's state on the server: `"submitted"`/`"dismissed"` render read-only with a status line. */
    state?: WidgetStatus;
    /** The submitted value, summarized under a submitted widget. */
    response?: unknown;
    /** The user submitted `value`: post it with `opencode.widget/respond`. The widget turns read-only. */
    onSubmit?(value: unknown): void;
    /** The user dismissed the widget: post `{ dismiss: true }` with `respond`. */
    onDismiss?(): void;
    /** A non-final message for the agent (`opencode.widget/send`); more than 10 a second are dropped here. */
    onSend?(value: unknown, wake: boolean): void;
    /** `"dark"` (default), `"light"`, or tokens. */
    theme?: Theme;
    /**
     * Resolves an image `src` to a URL the page may load: `https:`/`http:`/`data:` pass by default; return the server's
     * file content URL for a path relative to the session's directory, or undefined to show `alt` instead.
     */
    resolveImage?(src: string): string | undefined;
    /**
     * The widget template's source (`Program.source`), so error positions can be made widget-template-relative (the prelude's lines
     * subtracted). Without it the host finds the prelude's end itself, or leaves positions out.
     */
    source?: string;
    /**
     * A **program error** (widgets.md, Failures): the widget template's code threw or broke a contract (parse error, exception,
     * invalid view or draw output, WGSL that fails validation, the 250 ms step, the 50 ms slice, the post or send rate).
     * Called once per distinct error, with positions in the widget template's source; post it with `opencode.widget/report`
     * (`client: "web"`). The widget already shows it.
     */
    onReport?(error: WidgetError): void;
    /**
     * A **client error**: this host failed, not the widget template (worker or WebAssembly crash, valid WGSL the GPU path
     * couldn't run, a shader or draw too slow on this device, Fullscreen API refusals, a failed `onAsk`). Never report
     * these; log them in dev mode only.
     */
    onClientError?(message: string, cause?: unknown): void;
    /** The widget's recorded failure (`State.failure`); update it with `setFailure`. */
    failure?: WidgetFailure;
    /**
     * "Ask agent to fix it" for a failure with `sent: false`: call `opencode.widget/report` with this error and
     * `ask: true`. Without it the button isn't offered (e.g. an artifact with no agent session).
     */
    onAsk?(error: WidgetError): void | Promise<void>;
    /** Program warnings that aren't errors (an unknown node type): for dev logs. */
    onWarning?(message: string): void;
    /** Timings: `compile`, `init` (first view on screen), `step`, `draw`, `gpu` (replaying a GPU batch), in ms. */
    onMetrics?(metric: {
        kind: "compile" | "init" | "step" | "draw" | "gpu";
        ms: number;
    }): void;
    /** Text for the expand button and placeholders, if not English. */
    labels?: Partial<Labels>;
    /**
     * What the widget shows for a program built for an older widget runtime (widgets.md, Protocol) instead of "This widget
     * was built with an older widget runtime; ask the agent to post it again". `onReport` still gets the spec's message.
     */
    olderRuntimeMessage?: string;
}
export interface Labels {
    fullscreen: string;
    exitFullscreen: string;
    submitted: string;
    dismissed: string;
    restart: string;
    retry: string;
    network: string;
    localNetwork: string;
    release: string;
    loading: string;
    /** "Failed on {client}" before the failure's text. */
    failedOn: string;
    ask: string;
    asking: string;
    told: string;
}
/** A program error, as `opencode.widget/report` takes it: positions 1-based, in the widget template's source. */
export interface WidgetError {
    /** `init`, `event` (a handler or hook), `draw`, `main` (live), `shader`, ... */
    phase: string;
    message: string;
    line?: number;
    column?: number;
}
/** `State.failure`: the program error the server recorded, who reported it, and whether the agent was told. */
export interface WidgetFailure extends WidgetError {
    client: string;
    sent: boolean;
}
/** A mounted widget. */
export interface MountedWidget {
    /** The element the widget renders into (a child of the mount point, with an open shadow root). */
    readonly element: HTMLElement;
    setTheme(theme: Theme): void;
    /** The server's state changed (from any client): a final state makes it read-only and stops a live program. */
    setState(state: WidgetStatus, response?: unknown): void;
    /** The server's `State.failure` changed (or went away): shown while the widget is open. */
    setFailure(failure: WidgetFailure | undefined): void;
    /** Starts over: a fresh `init` (step) or a fresh `main` (live). */
    restart(): void;
    /** Stops the program, frees everything, and removes the element. */
    destroy(): void;
}
export interface HostOptions {
    /** URL of `psychoscript_web_bg.wasm` (default: next to this module). */
    wasmUrl?: string | URL;
    /** URL of `worker.js` (default: next to this module); a module worker. */
    workerUrl?: string | URL;
    /** Live programs' slice budget, ms (default 50). */
    sliceBudgetMs?: number;
}
interface Program {
    pid: number;
    refs: number;
    compiled: Promise<{
        error?: ErrorInfo;
        ms: number;
    }>;
}
declare class WorkerHandle {
    private host;
    readonly worker: Worker;
    readonly ready: Promise<void>;
    private programs;
    private unused;
    private compiled;
    readonly widgets: Map<number, Widget>;
    private requests;
    dead: boolean;
    constructor(host: WidgetHost, module: Promise<WebAssembly.Module>);
    send(m: ToWorker): void;
    request(m: ToWorker & {
        req: number;
    }): Promise<FromWorker>;
    /** Compiles `text` (once per worker) for `live` or step runs. */
    acquire(text: string, live: boolean): Program;
    /** Keeps up to 8 programs nobody uses compiled, for widgets that come back (scrolling). */
    release(text: string, live: boolean): void;
    private crash;
    terminate(): void;
}
/** Loads the WebAssembly once and runs every widget of a page: step widgets share one worker, each live widget has its own. */
export declare class WidgetHost {
    readonly options: HostOptions;
    private ids;
    private module;
    private stepWorker;
    private liveWorkers;
    readonly ticker: Ticker;
    readonly images: Images;
    private observer;
    private observed;
    private widgets;
    private resolvers;
    constructor(options?: HostOptions);
    nextId(): number;
    /** Loads and compiles the WebAssembly and starts (and warms) the step worker now rather than at the first mount. */
    preload(): Promise<void>;
    languageModule(): Promise<WebAssembly.Module>;
    steps(): WorkerHandle;
    live(): WorkerHandle;
    ended(worker: WorkerHandle): void;
    /** Each running worker's WebAssembly memory (the interpreter's heap and code data), compiled programs and widgets. */
    stats(): Promise<{
        kind: "step" | "live";
        wasmBytes: number;
        programs: number;
        widgets: number;
    }[]>;
    /** A worker died: its widgets start again, but the one whose program crashed it shows the error. */
    lost(worker: WorkerHandle, message: string, culprit?: number): void;
    mount(el: HTMLElement, options: MountOptions): MountedWidget;
    observe(el: Element, w: Widget): void;
    forget(w: Widget): void;
    /** Stops every widget and worker. */
    destroy(): void;
}
declare class Widget implements MountedWidget {
    private host;
    private options;
    readonly element: HTMLElement;
    readonly wid: number;
    private shadow;
    private root;
    private viewEl;
    private errorEl;
    private statusEl;
    private failureEl;
    private failure;
    private asking;
    /** The program error shown on the widget now (error card or inline), if any. */
    private shown;
    private reported;
    private offset;
    private expand;
    private theme;
    private status;
    private response;
    private worker;
    private program;
    private view;
    private started;
    private visible;
    private inView;
    private destroyed;
    private paused;
    private ctx;
    private draws;
    private live;
    private sends;
    private mountedAt;
    private firstView;
    private warned;
    private isFullscreen;
    private onFullscreen;
    private input;
    private hint;
    /** A live program called `widget.capturePointer()` (and not `releasePointer()` since). */
    private livePointer;
    constructor(host: WidgetHost, mountPoint: HTMLElement, options: MountOptions);
    private mode;
    private label;
    private warn;
    private metric;
    intersecting(on: boolean): void;
    visibility(): void;
    private start;
    private stopWorker;
    restart(): void;
    crashed(message: string, culprit: boolean): void;
    receive(m: FromWorker): void;
    private stepped;
    private posted;
    private exited;
    private loading;
    private render;
    /**
     * The focus hint: a keyboard icon plus "Esc" (a cursor icon while the pointer is captured). Touch devices show it only
     * once a hardware keyboard typed, and then the icon alone.
     */
    private updateHint;
    private updateExpand;
    private inlineError;
    private button;
    /** The first step failed (or the program didn't compile): an error card instead of a view, with "Try again" (`retry`). */
    private fatal;
    /** Classifies a failure: the widget template's (reported) or this host's (logged). */
    private problem;
    /** A program error: once per distinct error, to the embedder's report hook. */
    private report;
    private clientError;
    /** Lines in the program before the widget template's first line, or null when unknown. */
    private prelude;
    /** `e` with its position in the widget template's source: dropped when it falls in the prelude or past the widget template. */
    private relative;
    setFailure(failure: WidgetFailure | undefined): void;
    /** "Failed on <client>: <phase>: <message> (line N, col M)", then "Ask agent to fix it" or "The agent was told". */
    private renderFailure;
    private ask;
    private renderStatus;
    private emit;
    private draw;
    private send;
    private finish;
    setState(state: WidgetStatus, response?: unknown): void;
    private refreshControls;
    setTheme(theme: Theme): void;
    private livePause;
    private gpu;
    private gpuUnavailable;
    private gpuKeys;
    /** The GPU canvas with this key in the last rendered view. */
    private gpuCanvas;
    /** A batch as posted, for the checks and the replay. */
    private gpuBatch;
    /**
     * Before a frame, the first one too: `{ type: "canvas", key, width, height }` (physical pixels clamped to the texture
     * limit: the canvas's backing size) for each GPU canvas whose size changed.
     */
    private gpuSizes;
    private liveTick;
    private toggleFullscreen;
    private closeFullscreen;
    /** The close button's area in the root node's coordinates, or null when not full screen. */
    private closeInRoot;
    /** Tells the program it's full screen (or not) and where the close button is; again when that area moves. */
    private announceFullscreen;
    private fullscreenChanged;
    private announced;
    private leavingHistory;
    /** The root's size while full screen: a new size moves the close button's area in root coordinates. */
    private rootSize;
    private onPopState;
    destroy(): void;
}
export {};
