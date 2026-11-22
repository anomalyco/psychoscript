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
    /** The key the program configured it by, for its size messages. */
    key: string | undefined;
    /** Shows the placeholder: `poster`, else `alt`, else "GPU canvas not supported"; with a program error's message. */
    placeholder(message?: string): void;
    /** Back from the placeholder: the canvas draws again. */
    shown(): void;
}
export interface GpuHost {
    /** The GPU canvas with this key in the last rendered view. */
    canvas(key: string): GpuCanvas | undefined;
    /** A program error (phase `gpu`), reported once by the host. */
    programError(message: string): void;
    clientError(message: string, cause?: unknown): void;
    /** The device was lost: `{ type: "gpu", lost: reason }` to the program. */
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
    /** Batches waiting for the device, in order. */
    private waiting;
    private unavailable;
    private objects;
    private live;
    private memory;
    private passes;
    private draws;
    /** Every canvas stopped by a program error: later batches are ignored. */
    private stopped;
    private closed;
    private encoder;
    private pass;
    /** The contexts the batch being replayed drew into, for its errors. */
    private touched;
    constructor(host: GpuHost);
    /** Replays `batch` in order after the ones before it. */
    batch(batch: Batch): void;
    /** A frame went to the program: the per-frame limits start again (between two `widget.frame()`). */
    frame(): void;
    /** Every configured canvas: the placeholder shows while the device is missing or lost. */
    private contexts;
    private start;
    private adopt;
    private replay;
    /** A program error: reported once, and the canvases it concerns (or every one) stop, with the error shown. */
    private programError;
    private stop;
    /** A new handle's slot: a positive integer the prelude hasn't used. */
    private slot;
    private get;
    /** The context's canvas, configured: it may have been rendered anew since. */
    private context;
    /** A texture by handle: a context's stands for its canvas's current texture. */
    private texture;
    private view;
    private encode;
    private inPass;
    private allocate;
    private op;
    /** The widget stopped: its device and everything on it go. */
    destroy(): void;
}
