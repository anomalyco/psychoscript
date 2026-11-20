import type { Resolved } from "./theme.js";
export type Command = unknown[];
/** Images `image` commands name, loaded once per source and shared by every canvas of a page. */
export declare class Images {
    private readonly resolve;
    private cache;
    private waiting;
    constructor(resolve: (src: string) => string | undefined);
    /** The loaded image, or undefined while loading (then `onload` runs once it is) or when it can't load. */
    get(src: string, onload: () => void): HTMLImageElement | undefined;
}
/**
 * Paints `commands` on `ctx` over a cleared `width` x `height` (logical px) at `scale` device pixels per logical one.
 * Images not loaded yet are skipped; `repaint` runs when one arrives.
 */
export declare function paint(ctx: CanvasRenderingContext2D, commands: readonly Command[], width: number, height: number, scale: number, theme: Resolved, images: Images, repaint: () => void): void;
