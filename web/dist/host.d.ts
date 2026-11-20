import { Images } from "./canvas.js";
import type { ErrorInfo, FromWorker, ToWorker } from "./protocol.js";
import { ShaderView, Ticker } from "./render.js";
import type { ShaderError } from "./shader.js";
import type { Theme } from "./theme.js";
export interface Capabilities {
    https?: {
        hosts: string[];
    };
}
export type WidgetStatus = "open" | "submitted" | "dismissed";
export interface MountOptions {
    /** The served program: prelude + "\n" + template source (`Program.program` from `opencode.widget/program`). */
    program: string;
    /** The widget's data (the `widget` tool call's `data`). */
    data: unknown;
    /** `"step"` (default) or `"live"`. */
    mode?: "step" | "live";
    /** The template's capabilities (live only); granted as declared, shown as a chip. */
    capabilities?: Capabilities;
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
    /** A program error, a budget overrun, an unknown node: for logs. */
    onWarning?(message: string): void;
    /** Timings: `compile`, `init` (first view on screen), `step`, `draw`, in ms. */
    onMetrics?(metric: {
        kind: "compile" | "init" | "step" | "draw";
        ms: number;
    }): void;
    /** Text for the expand button and placeholders, if not English. */
    labels?: Partial<Labels>;
}
export interface Labels {
    fullscreen: string;
    exitFullscreen: string;
    submitted: string;
    dismissed: string;
    restart: string;
    retry: string;
    network: string;
    loading: string;
}
/** A mounted widget. */
export interface MountedWidget {
    /** The element the widget renders into (a child of the mount point, with an open shadow root). */
    readonly element: HTMLElement;
    setTheme(theme: Theme): void;
    /** The server's state changed (from any client): a final state makes it read-only and stops a live program. */
    setState(state: WidgetStatus, response?: unknown): void;
    /** Starts over: a fresh `init` (step) or a fresh `main` (live). */
    restart(): void;
    /** Stops the program, frees everything, and removes the element. */
    destroy(): void;
}
export interface HostOptions {
    /** URL of `psychoscript_web_bg.wasm` (default: next to this module). */
    wasmUrl?: string | URL;
    /** URL of `psychoscript_web_shader_bg.wasm`, loaded only for WebGL2 shaders (default: next to this module). */
    shaderWasmUrl?: string | URL;
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
    private shaderSent;
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
    translate(wgsl: string): Promise<{
        code: string;
        block: string;
    } | ShaderError>;
    private crash;
    terminate(): void;
}
/** Loads the WebAssembly once and runs every widget of a page: step widgets share one worker, each live widget has its own. */
export declare class WidgetHost {
    readonly options: HostOptions;
    private ids;
    private module;
    private shader;
    private stepWorker;
    readonly ticker: Ticker;
    readonly images: Images;
    private observer;
    private observed;
    private widgets;
    private resolvers;
    private translations;
    constructor(options?: HostOptions);
    nextId(): number;
    /** Loads and compiles the WebAssembly and starts (and warms) the step worker now rather than at the first mount. */
    preload(): Promise<void>;
    languageModule(): Promise<WebAssembly.Module>;
    shaderModule(): Promise<WebAssembly.Module>;
    steps(): WorkerHandle;
    live(): WorkerHandle;
    translate(wgsl: string): Promise<{
        code: string;
        block: string;
    } | ShaderError>;
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
    private updateExpand;
    private inlineError;
    private button;
    /** The first step failed (or the program didn't compile): an error card instead of a view. */
    private fatal;
    private renderStatus;
    private emit;
    private draw;
    private send;
    private finish;
    setState(state: WidgetStatus, response?: unknown): void;
    private refreshControls;
    setTheme(theme: Theme): void;
    private livePause;
    private liveTick;
    private toggleFullscreen;
    private fullscreenChanged;
    destroy(): void;
}
export { ShaderView };
