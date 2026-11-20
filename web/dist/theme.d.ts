/** The theme colors draw commands name and the renderer styles with (`--pw-<token>` CSS variables). */
export interface ThemeTokens {
    text: string;
    muted: string;
    accent: string;
    bg: string;
    surface: string;
    border: string;
    success: string;
    warning: string;
    error: string;
    /** Text on an `accent` fill (primary buttons). Defaults to black or white, whichever contrasts more. */
    accentText?: string;
    /** CSS font-family for text; defaults to the system UI font. */
    font?: string;
    /** CSS font-family for `code` text and `mono` draw text. */
    mono?: string;
    /** Corner radius in px for cards, inputs and buttons. */
    radius?: number;
    /** Whether this is a dark theme (`Frame.dark`); defaults to whether `bg` is dark. */
    dark?: boolean;
}
/** `"dark"`, `"light"`, or tokens (missing ones come from the dark or light preset, by `dark` or `bg`). */
export type Theme = "dark" | "light" | (Partial<ThemeTokens> & {
    base?: "dark" | "light";
});
export declare const DARK: ThemeTokens;
export declare const LIGHT: ThemeTokens;
export declare const TOKENS: readonly ["text", "muted", "accent", "bg", "surface", "border", "success", "warning", "error"];
export type Token = (typeof TOKENS)[number];
/** The resolved theme: every token, and whether it's dark. */
export interface Resolved extends ThemeTokens {
    accentText: string;
    font: string;
    mono: string;
    radius: number;
    dark: boolean;
}
export declare function resolve(theme: Theme | undefined): Resolved;
/** Relative luminance of a `#rgb`/`#rrggbb` color, 0..1; 0.5 for anything else. */
export declare function luminance(color: string): number;
/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` to [r, g, b, a] (a 0..1). */
export declare function parseHex(color: string): [number, number, number, number] | undefined;
/** Sets `--pw-*` on `el`. */
export declare function apply(el: HTMLElement, t: Resolved): void;
