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
    /** Work was just submitted: `hang` runs if it hangs. Resolves (or rejects) when the work is done. */
    submitted(hang: () => void): Promise<undefined>;
    /** The device was lost: the oldest unfinished submit hangs if it had been running `GPU_HANG_MS`; then none is left. */
    lost(): void;
    /** No more timing (the device or the widget is gone). */
    stop(): void;
    private settle;
    private arm;
    private blame;
}
