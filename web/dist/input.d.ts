import type { WidgetEvent } from "./protocol.js";
import type { Ticker } from "./render.js";
/** What the input layer needs from its widget. */
export interface InputHost {
    readonly element: HTMLElement;
    readonly shadow: ShadowRoot;
    readonly ticker: Ticker;
    /** Open (interactive), not submitted or dismissed. */
    open(): boolean;
    emit(event: WidgetEvent): void;
    /** The program wants the pointer: root `capture: "pointer"` or a live `capturePointer()`. */
    wantsPointer(): boolean;
    /** The pointer was released by Esc or the browser: a live `capturePointer()` must ask again. */
    pointerReleased(): void;
    /** The `id` for captured pointer events: the first canvas or shader with one. */
    pointerId(): string;
    /** Focus or capture changed: show or hide the ring and the "Esc to release" hint. */
    changed(focused: boolean, captured: boolean): void;
}
export declare class Input {
    private h;
    private focused;
    private locked;
    private held;
    private dx;
    private dy;
    /** A release we asked for (the program let go): focus stays. */
    private letGo;
    private readonly doc;
    constructor(h: InputHost);
    /** The widget's state or view changed: focusable while open; let the pointer go when no longer wanted. */
    refresh(): void;
    /** Esc, leaving full screen, the window losing focus: give back the pointer and the keyboard at once. */
    release(): void;
    destroy(): void;
    private onFocusIn;
    private onFocusOut;
    private blurred;
    private onWindowBlur;
    private onKey;
    private onPointerDown;
    private onLockChange;
    private stopMoves;
    private onMove;
    private flush;
    private onButton;
}
