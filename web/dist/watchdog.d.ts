/** The run a submit is for (the same object each time): its work finished, or was unfinished at a loss (once a loss). */
export interface Run {
    finished(): void;
    strike(): void;
}
/** What the watchdog needs of a queue. */
export interface WorkQueue {
    onSubmittedWorkDone(): Promise<undefined>;
}
export declare class Watchdog {
    private readonly queue;
    private readonly now;
    private readonly submits;
    private timer;
    private gone;
    constructor(queue: WorkQueue, now?: () => number);
    /**
     * Work was just submitted for `run`: `hang` runs if it hangs; `run` hears when it finishes on this device, or that it
     * was unfinished when the device was lost. Resolves (or rejects) when the work is done.
     */
    submitted(hang: () => void, run: Run): Promise<undefined>;
    /** The device was lost: each run with work unfinished is told, once; then none is left. */
    lost(): void;
    /** No more timing (the device or the widget is gone). */
    stop(): void;
    private settle;
    private arm;
    private blame;
}
/**
 * A run's strikes at device losses (widgets-gpu.md, Strikes). A loss with the run's work in flight is a strike only if
 * its work finished on a device since its last strike (or its start): losses in a row with none finished between are
 * one reset, one strike.
 */
export declare class Strikes {
    private readonly now;
    private last;
    private finished;
    constructor(now?: () => number);
    /** The run's GPU work finished on a device. */
    done(): void;
    /** A loss with the run's work in flight: true when it is a strike, the second within `STRIKE_MS` (the run stops). */
    strike(): boolean;
}
