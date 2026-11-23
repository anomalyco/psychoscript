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
    /** A strike (widgets-gpu.md, Strikes): the run's work was unfinished at a device loss. The same function each time. */
    strike(): void;
    /** Runs `f` once in the next display frame, before the canvases present. */
    nextFrame(f: () => void): void;
}
export declare class GpuReplay {
    private readonly host;
    private device;
    private starting;
    /** Checked batches waiting for the device, in order, and the frame ends between them (`null`). */
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
    /** The canvases drawn mid-frame, by key, and those whose context has COPY_DST for it (once one is, it stays). */
    private readonly kept;
    private readonly copyDst;
    /** Whether the batch replaying is a frame request's (it ends the frame), and a present is waiting for a frame. */
    private boundary;
    private presenting;
    /** Whether the batch replaying submitted work (a GPU hang is timed from it), and the device's queue's watchdog. */
    private submitted;
    private watchdog;
    constructor(host: GpuHost);
    /** Checks `batch` now, in order, and replays what passes after the batches before it. `boundary`: the batch of a
     * frame request (not one repeated while a frame is pending), which `frame()` follows. */
    batch(batch: unknown, boundary: boolean): void;
    /** A program error: reported once; its canvases (or every one) stop and show their placeholder with it. */
    private fail;
    /**
     * A GPU hang (widgets-gpu.md, the device's watchdog): a batch's submitted work hung stops the canvases it renders
     * into, else every one, as an error would (later batches for them ignored, never restarted by a new device), with a
     * client error.
     */
    private hang;
    /** Stops `error`'s canvases (or every one): each shows its placeholder with the message. */
    private stop;
    private start;
    private adopt;
    private replay;
    private get;
    /** The context's canvas, configured: it may have been rendered anew since. Throws SKIP for a stopped canvas. */
    private context;
    /** A texture by handle, for a copy or a write: never a canvas's (the host checks refuse it). */
    private texture;
    /** A view by handle: a canvas's stands for its current texture, or its kept one while it has one. */
    private view;
    /** The context a view handle is of, if it is a canvas's. */
    private canvasOf;
    /** A canvas drawn mid-frame: its texture is kept for the rest of the frame, the frame's first pass clearing it. */
    private keep;
    /** The kept textures drawn since their last copy, copied to their canvases' current textures. */
    private present;
    private schedulePresent;
    /** The frame's end: the canvases drawn into kept textures are presented, and the next frame starts direct. */
    private endFrame;
    private encode;
    private op;
    /** A frame request, with a batch (checked first) or without: the per-frame counts start again. */
    frame(): void;
    /** The run's second strike (widgets-gpu.md, Strikes): every GPU canvas stops for the rest of the run. */
    stopAll(): void;
    /** The error a stopped canvas shows, or undefined while it draws. */
    private stoppedBy;
    /** What a GPU canvas shows instead of drawing: an error's message, `null` (lost, the placeholder alone), or undefined. */
    placeholderFor(key: string): string | null | undefined;
    /** The widget stopped: its device and everything on it go. */
    destroy(): void;
}
