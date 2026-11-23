import type { HostOptions, MountOptions, MountedWidget } from "./host.js";
import { WidgetHost } from "./host.js";
export { WidgetHost };
export type { Capabilities, HostOptions, Labels, MountOptions, MountedWidget, WidgetStatus } from "./host.js";
export type { Theme, ThemeTokens } from "./theme.js";
export { DARK, LIGHT } from "./theme.js";
export type { Frame, ViewNode, WidgetEvent } from "./protocol.js";
/** Configures the page's shared host (asset URLs); call before the first `mount`. */
export declare function configure(options: HostOptions): WidgetHost;
/** The page's shared host. */
export declare function host(): WidgetHost;
/** Mounts a widget into `el` (appends a child element with a shadow root) with the page's shared host. */
export declare function mount(el: HTMLElement, options: MountOptions): MountedWidget;
