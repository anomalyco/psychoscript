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
    warn(message: string): void;
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
/** A sized drawing surface that follows its width (and in full screen with `fill`, the free height). */
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
    protected observer: ResizeObserver;
    protected destroyed: boolean;
    protected ticking: boolean;
    constructor(ctx: RenderContext, node: ViewNode);
    built(): {
        el: HTMLElement;
        rec: Rec;
    };
    get id(): string | null;
    /** Applies the node's size; returns whether the backing store changed. */
    protected layout(n: ViewNode): void;
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
    private moved;
    private context;
    constructor(ctx: RenderContext, node: ViewNode);
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
    constructor(ctx: RenderContext, node: ViewNode);
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
