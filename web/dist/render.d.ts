import type { Command, Images } from "./canvas.js";
import type { GpuCanvas } from "./gpu.js";
import type { Frame, Rect, ViewNode, WidgetEvent } from "./protocol.js";
import type { Resolved } from "./theme.js";
/** What rendering needs from its widget. */
export interface RenderContext {
    readonly doc: Document;
    emit(event: WidgetEvent): void;
    readOnly(): boolean;
    theme(): Resolved;
    visible(): boolean;
    fullscreen(): boolean;
    /** The full-screen close button's area in viewport coordinates, or null when not full screen. */
    closeRect(): DOMRect | null;
    images: Images;
    resolveImage(src: string): string | undefined;
    /** Step mode: run the draw step for `frame`. Live mode: undefined (commands arrive through `liveCommands`). */
    draw?(frame: Frame): Promise<{
        commands?: Command[];
        error?: string;
        ms: number;
    }>;
    liveCommands(id: string | null): Command[] | undefined;
    /** A program warning that isn't an error (an unknown node type). */
    warn(message: string): void;
    /** The widget template's code broke a contract here (WGSL that fails validation or over 16 KB, values without wgsl): reported. */
    programError(phase: string, error: {
        message: string;
        line?: number;
        column?: number;
    }): void;
    /** This host failed (valid WGSL it couldn't run, a surface too slow on this device): logged in dev mode only. */
    clientError(message: string, cause?: unknown): void;
    ticker: Ticker;
}
/** One `requestAnimationFrame` loop for every animated surface on the page, running only while one wants frames. */
export declare class Ticker {
    private subs;
    private handle;
    add(f: (now: number) => void): void;
    delete(f: (now: number) => void): void;
    private tick;
}
interface Rec {
    type: string;
    node: ViewNode;
    update(node: ViewNode): void;
    destroy?(): void;
}
/** Whether a `canvas` (2D or GPU) is in `node`'s tree. */
export declare function hasSurface(node: ViewNode | undefined): boolean;
/** Renders `nodes` as `parent`'s children, reusing elements of the same type at the same place. */
export declare function reconcile(ctx: RenderContext, parent: Element, nodes: readonly unknown[]): void;
/** Releases what `el`'s subtree holds (timers, GPU surfaces, frame callbacks). */
export declare function destroy(el: Element): void;
declare function icon(ctx: RenderContext, path: string): SVGSVGElement;
export { icon };
/** A sized drawing surface that follows its width (and in full screen, unless `fill: false`, its share of the free height). */
declare abstract class SurfaceBase {
    protected ctx: RenderContext;
    readonly el: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    node: ViewNode;
    width: number;
    height: number;
    scale: number;
    readonly appeared: number;
    pointer: {
        x: number;
        y: number;
        down: boolean;
    } | null;
    protected moved: PointerEvent | undefined;
    private laid;
    protected observer: ResizeObserver;
    protected destroyed: boolean;
    protected ticking: boolean;
    constructor(ctx: RenderContext, node: ViewNode);
    /** Point in the canvas, logical px. */
    private local;
    /** A `pointer` event for a canvas with `pointer: true` (2D or GPU alike). */
    private send;
    /** Tracks the pointer for frames and uniforms; sends `down` and `up` at once, `move` only while down, at most once a frame. */
    private listen;
    /** Sends the latest `move` of this frame, if any; each surface's tick calls it first. */
    protected flushMove(): void;
    /** The pointer moved, went down or up (`hover`: only moved while up). */
    protected abstract pointerChanged(hover?: boolean): void;
    built(): {
        el: HTMLElement;
        rec: Rec;
    };
    get id(): string | null;
    /** Applies the node's size; returns whether the backing store changed. */
    protected layout(n: ViewNode): boolean;
    /** No width or height yet (laid out away, or changing size): never drawn or rendered then (widgets.md, Canvas). */
    zero: boolean;
    protected measure(): boolean;
    /** The canvas's backing size for its physical size. */
    protected backing(width: number, height: number): readonly [number, number];
    /** Measures now; whether the surface has a size to draw at. */
    sized(): boolean;
    frame(dt: number): Frame;
    /** The full-screen close button's area in this surface's coordinates when it overlaps it, else null. */
    close(): Rect | null;
    protected start(): void;
    protected stop(): void;
    protected abstract tick: (now: number) => void;
    protected abstract resized(): void;
    abstract update(n: ViewNode): void;
    destroy(): void;
    protected showAlt(text: string, error?: boolean): void;
}
/** A `canvas` node: draw commands painted with Canvas2D. */
export declare class CanvasView extends SurfaceBase {
    private commands;
    private inflight;
    private dirty;
    private overruns;
    private frozen;
    private lastFrame;
    private lastDrawT;
    private lastDrawAt;
    private context;
    constructor(ctx: RenderContext, node: ViewNode);
    protected pointerChanged(hover?: boolean): void;
    update(n: ViewNode): void;
    /** New commands from a live program's `draw`. */
    setCommands(commands: Command[]): void;
    invalidate(): void;
    protected resized(): void;
    private fps;
    /** Whether the draw step should run every frame now. */
    private animating;
    protected tick: (now: number) => void;
    /** Visible again: draw and animate as needed. */
    wake(): void;
    repaint(): void;
}
/** A GPU canvas (a `canvas` with `wgsl`): its WGSL on WebGPU; without it, its placeholder. */
export declare class GpuCanvasView extends SurfaceBase {
    private surface;
    private wgsl;
    private failed;
    private slow;
    private stopped;
    private uniforms;
    private values;
    private lastFrame;
    private dirty;
    private poster;
    private builds;
    protected pointerChanged(): void;
    /** Only `values` changed (live programs re-render every frame): new uniforms, no rebuild. */
    update(n: ViewNode): void;
    private build;
    private fail;
    protected resized(): void;
    wake(): void;
    protected tick: (now: number) => void;
    destroy(): void;
}
/**
 * A GPU canvas (`gpu: true`, widgets-gpu.md): the widget's `GpuReplay` configures it and replays the program's WebGPU
 * calls into it; it sizes itself as every canvas does, and shows its placeholder when there is no GPU or it failed.
 */
export declare class WebGpuCanvasView extends SurfaceBase implements GpuCanvas {
    /** The physical size last sent to the program (`{ type: "canvas", key, width, height }`). */
    sent: string;
    private poster;
    constructor(ctx: RenderContext, node: ViewNode);
    update(n: ViewNode): void;
    /** Clamped to the texture limit, its aspect kept (widgets-gpu.md, Canvas size); the box scales it. */
    protected backing(width: number, height: number): readonly [number, number];
    /** What the placeholder shows, while it shows: `null` without a message. */
    private showing;
    /** `poster`, else `alt`, else "GPU canvas not supported"; with a program error's message under it. */
    placeholder(message?: string): void;
    shown(): void;
    wake(): void;
    protected pointerChanged(): void;
    protected resized(): void;
    protected tick: () => void;
}
/** `r` in the coordinates of `origin`'s top-left corner, rounded to logical pixels. */
export declare function rectIn(r: DOMRect, origin: DOMRect): Rect;
/** The surfaces under `root`, in document order. */
export declare function surfaces(root: Element): (CanvasView | GpuCanvasView | WebGpuCanvasView)[];
