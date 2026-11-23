/** A program error from a batch (phase `gpu`): the canvases it stops, by key, or every canvas of the device. */
export interface GpuError {
    readonly message: string;
    readonly canvases: ReadonlyArray<string> | "all";
}
/** A batch's check: its error, if any, with the op it stopped at; and the canvases it renders into, by key. */
export interface Checked {
    readonly error?: GpuError;
    /** The ops before this one passed and may replay; none without it. */
    readonly at?: number;
    readonly keys: ReadonlyArray<string>;
    /** Every canvas stopped already, or the batch's, or it is from before a device loss: don't replay it. */
    readonly skip: boolean;
}
/** The client error a GPU hang stops canvases with (widgets-gpu.md, Errors and device loss). */
export declare const GPU_HANG = "the GPU work hung; the canvas is stopped";
/** Two strikes this close stop a run: device losses while it had GPU work in flight. */
export declare const STRIKE_MS = 30000;
export declare const GPU_LIMITS: {
    ops: number;
    bytes: number;
    passes: number;
    draws: number;
    handles: number;
    resources: number;
    shader: number;
    buffer: number;
    dimension: number;
    layers: number;
};
/**
 * A GPU canvas's backing size for its physical size (widgets-gpu.md, Canvas size): within the texture dimension limit,
 * its aspect ratio kept; over it, the larger side is the limit and the other ⌊side × limit / larger⌋, at least 1.
 */
export declare const canvasSize: (width: number, height: number) => readonly [number, number];
/**
 * The checks of a widget's batches, in order. `canvases` gives the keys of the GPU canvases in the last rendered view.
 * A batch gives its first error, or none, and the rest of it goes unchecked. The error stops the canvases the batch
 * renders into (a pass's color attachment or its resolve target is a view of their texture), or every GPU canvas of the
 * widget when it renders into none; then later batches go unchecked. An error stopping only canvases already stopped
 * isn't given again. A batch whose first error names a handle from before a device loss is dropped without one.
 */
export declare function gpuChecks(canvases: () => ReadonlySet<string>): {
    /** Checks a batch. */
    batch: (value: unknown) => Checked;
    /** A frame request, with or without a batch: it ends the frame the per-frame limits count. */
    frame: () => void;
    /** An error the replay found in a batch that renders into `keys`. */
    scoped: (message: string, keys: ReadonlyArray<string>) => GpuError | undefined;
    /** A GPU hang stops every GPU canvas; later batches go unchecked. Given unless every canvas was stopped already. */
    hung: () => GpuError | undefined;
    /** The device is lost: every handle is gone; new ones keep counting up. */
    lost: () => void;
};
