/** A user event (widgets.md, Events; widgets-fullscreen.md; widgets-input.md). */
export interface WidgetEvent {
    id: string;
    type: "press" | "change" | "pointer" | "fullscreen" | "key" | "focus" | "capture";
    value?: unknown;
    /** `fullscreen` events: the close button's area in the root node's coordinates, `null` when leaving. */
    close?: Rect | null;
}
/** A rectangle in logical pixels. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** What a canvas draw step or a live `widget.frame()` knows of its frame. */
export interface Frame {
    id: string | null;
    t: number;
    dt: number;
    width: number;
    height: number;
    scale: number;
    pointer: {
        x: number;
        y: number;
        down: boolean;
    } | null;
    dark: boolean;
    fullscreen: boolean;
    /** The full-screen close button's area in this canvas's coordinates when it overlaps the canvas, else `null`. */
    close: Rect | null;
}
/** A view node: `{ type, ...props }`. */
export interface ViewNode {
    type: string;
    [prop: string]: unknown;
}
export interface StepOutput {
    state?: unknown;
    view: ViewNode;
    submit?: unknown;
    dismiss?: true;
    send?: {
        value: unknown;
        wake: boolean;
    };
}
/** A failure: the language's (`type`, `kind`, `line`, `column`) or the host's. */
export interface ErrorInfo {
    type: string;
    /** For `type: "shader"`: the widget template's WGSL is at fault (a program error), not this host. */
    program?: boolean;
    kind?: string;
    message: string;
    line?: number;
    column?: number;
}
export type LiveExit = {
    type: "finished";
    result: unknown;
} | {
    type: "failed";
    error: ErrorInfo;
} | {
    type: "stopped";
};
export type ToWorker = {
    t: "init";
    module: WebAssembly.Module;
} | {
    t: "shader";
    module: WebAssembly.Module;
} | {
    t: "compile";
    pid: number;
    program: string;
    live: boolean;
} | {
    t: "release";
    pid: number;
} | {
    t: "open";
    wid: number;
    pid: number;
    data: string;
} | {
    t: "event";
    wid: number;
    event: WidgetEvent;
} | {
    t: "draw";
    wid: number;
    req: number;
    frame: Frame;
} | {
    t: "close";
    wid: number;
} | {
    t: "live";
    wid: number;
    pid: number;
    data: string;
    hosts?: string[];
    localNetwork?: boolean;
    sliceBudgetMs?: number;
} | {
    t: "deliver";
    wid: number;
    message: unknown;
} | {
    t: "pause";
    wid: number;
} | {
    t: "resume";
    wid: number;
} | {
    t: "stop";
    wid: number;
} | {
    t: "translate";
    req: number;
    wgsl: string;
} | {
    t: "stats";
    req: number;
};
export type FromWorker = {
    t: "ready";
} | {
    t: "compiled";
    pid: number;
    error?: ErrorInfo;
    ms: number;
} | {
    t: "step";
    wid: number;
    phase: "init" | "event";
    output?: StepOutput;
    error?: ErrorInfo;
    ms: number;
} | {
    t: "drawn";
    wid: number;
    req: number;
    commands?: unknown[][];
    error?: ErrorInfo;
    ms: number;
} | {
    t: "posts";
    wid: number;
    messages: unknown[];
}
/** `phase`: a program error the run survives (the post rate, an oversized draw), else a plain warning. */
 | {
    t: "warning";
    wid: number;
    message: string;
    phase?: string;
} | {
    t: "exit";
    wid: number;
    exit: LiveExit;
} | {
    t: "translated";
    req: number;
    code?: string;
    block?: string;
    error?: ErrorInfo;
} | {
    t: "crash";
    message: string;
    wid?: number;
} | {
    t: "stats";
    req: number;
    wasmBytes: number;
    programs: number;
    widgets: number;
};
/** The contract's budgets. */
export declare const STEP_TIMEOUT_MS = 250;
export declare const DRAW_BUDGET_MS = 8;
/** A draw step is cut off here; past `DRAW_BUDGET_MS` it already counts as an overrun. */
export declare const DRAW_TIMEOUT_MS = 100;
export declare const MAX_COMMANDS = 2000;
export declare const OVERRUNS_TO_FREEZE = 3;
export declare const SLICE_BUDGET_MS = 50;
export declare const MAX_FPS = 60;
export declare const SHADER_FRAME_BUDGET_MS = 50;
export declare const MAX_SHADER_BYTES: number;
export declare const MAX_SHADER_VALUES = 16;
