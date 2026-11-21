import type { Command, Images } from "./canvas.js";
import type { Frame, ViewNode, WidgetEvent } from "./protocol.js";
import type { ShaderError } from "./shader.js";
import type { Resolved } from "./theme.js";
/** What rendering needs from its widget. */
export interface RenderContext {
    readonly doc: Document;
    emit(event: WidgetEvent): void;
    readOnly(): boolean;
    theme(): Resolved;
    visible(): boolean;
    fullscreen(): boolean;
    images: Images;
    resolveImage(src: string): string | undefined;
    /** Step mode: run the draw step for `frame`. Live mode: undefined (commands arrive through `liveCommands`). */
    draw?(frame: Frame): Promise<{
        commands?: Command[];
        error?: string;
        ms: number;
    }>;
    liveCommands(id: string | null): Command[] | undefined;
    translate(wgsl: string): Promise<{
        code: string;
        block: string;
    } | ShaderError>;
    /** A program warning that isn't an error (an unknown node type). */
    warn(message: string): void;
    /** The template's code broke a contract here (WGSL that fails validation, a shader over 16 KB): reported. */
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
/** Whether a `canvas` or `shader` node is in `node`'s tree. */
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
    /** A `pointer` event for a surface with an `id` (canvas and shader alike). */
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
    protected measure(): boolean;
    frame(dt: number): Frame;
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
/** A `shader` node: WGSL on WebGPU, or WebGL2 through naga. */
export declare class ShaderView extends SurfaceBase {
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
/** The surfaces under `root`, in document order. */
export declare function surfaces(root: Element): (CanvasView | ShaderView)[];
