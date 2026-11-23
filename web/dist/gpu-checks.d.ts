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
    /** Every canvas stopped already, or the batch's: don't replay it. */
    readonly skip: boolean;
}
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
 * The checks of a widget's batches, in order. `canvases` gives the keys of the GPU canvases in the last rendered view.
 * A batch gives its first error, or none, and the rest of it goes unchecked. The error stops the canvases the batch
 * renders into (a pass's color attachment is a view of their texture), or every GPU canvas of the widget when it renders
 * into none; then later batches go unchecked. An error stopping only canvases already stopped isn't given again.
 */
export declare function gpuChecks(canvases: () => ReadonlySet<string>): {
    /** Checks a batch; `frame`: it came with a frame request, which ends the frame its limits count. */
    batch: (value: unknown, frame: boolean) => Checked;
    /** An error the replay found in a batch that renders into `keys`. */
    scoped: (message: string, keys: ReadonlyArray<string>) => GpuError | undefined;
    /** The device is lost: every handle is gone. */
    lost: () => void;
};
