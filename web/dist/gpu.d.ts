/** A batch as the worker hands it over: the ops, and the bytes they name by `[byteOffset, byteLength]`. */
export interface Batch {
    ops: unknown[][];
    bytes: Uint8Array<ArrayBuffer>;
}
/** What the replay needs of a GPU canvas on the page. */
export interface GpuCanvas {
    readonly canvas: HTMLCanvasElement;
    /** Measures it now: whether it has a size to draw at. */
    sized(): boolean;
    /** Shows the placeholder: `poster`, else `alt`, else "GPU canvas not supported"; with a program error's message. */
    placeholder(message?: string): void;
    /** Back from the placeholder: the canvas draws again. */
    shown(): void;
}
export interface GpuHost {
    /** The GPU canvas with this key in the last rendered view. */
    canvas(key: string): GpuCanvas | undefined;
    /** The keys of the GPU canvases in the last rendered view. */
    keys(): ReadonlySet<string>;
    /** A program error (phase `gpu`), reported once by the host. */
    programError(message: string): void;
    clientError(message: string, cause?: unknown): void;
    /** The device was lost: `{ type: "gpu", lost: reason, message }` to the program. */
    lost(reason: string, message: string): void;
    /** No WebGPU, or no device: every GPU canvas shows its placeholder (a client error, logged). */
    unavailable(): void;
    /** How long a batch's replay took on this thread, in ms (the GPU's work runs after). */
    metric(ms: number): void;
}
export declare class GpuReplay {
    private readonly host;
    private device;
    private starting;
    /** Checked batches waiting for the device, in order. */
    private waiting;
    private unavailable;
    private objects;
    private closed;
    private encoder;
    private pass;
    private readonly checks;
    /** The stopped canvases' errors by key, and the error that stopped every one: a canvas rendered anew stays stopped. */
    private readonly stopped;
    private all;
    /** The canvases the device's loss stopped, by key, until the program configures them on a new device. */
    private readonly lostKeys;
    constructor(host: GpuHost);
    /** Checks `batch` now, in order, and replays what passes after the batches before it. */
    batch(batch: unknown): void;
    /** A program error: reported once; its canvases (or every one) stop and show their placeholder with it. */
    private fail;
    private start;
    private adopt;
    private replay;
    private get;
    /** The context's canvas, configured: it may have been rendered anew since. Throws SKIP for a stopped canvas. */
    private context;
    /** A texture by handle: a context's stands for its canvas's current texture. */
    private texture;
    private view;
    private encode;
    private op;
    /** A frame request, with a batch (checked first) or without: the per-frame counts start again. */
    frame(): void;
    /** The error a stopped canvas shows, or undefined while it draws. */
    private stoppedBy;
    /** What a GPU canvas shows instead of drawing: an error's message, `null` (lost, the placeholder alone), or undefined. */
    placeholderFor(key: string): string | null | undefined;
    /** The widget stopped: its device and everything on it go. */
    destroy(): void;
}
