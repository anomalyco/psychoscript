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
     * Work was just submitted: `hang` runs if it hangs, `struck` if it is unfinished when the device is lost (pass the
     * run's own, the same each time: one strike a run a loss). Resolves (or rejects) when the work is done.
     */
    submitted(hang: () => void, struck: () => void): Promise<undefined>;
    /** The device was lost: each run with work unfinished gets a strike, once; then none is left. */
    lost(): void;
    /** No more timing (the device or the widget is gone). */
    stop(): void;
    private settle;
    private arm;
    private blame;
}
/** A run's strikes at device losses (widgets-gpu.md, Strikes): whether one is the second within `STRIKE_MS`. */
export declare class Strikes {
    private readonly now;
    private last;
    constructor(now?: () => number);
    /** A strike now: true when it is the second within `STRIKE_MS` of the last (the run stops). */
    strike(): boolean;
}
