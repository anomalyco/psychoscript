import { type Run, Watchdog } from "./watchdog.js";
/** What clients prepend to a widget template's WGSL. */
export declare const HEADER = "struct Widget { resolution: vec2f, time: f32, scale: f32, pointer: vec4f, values: array<vec4f, 4> }\n@group(0) @binding(0) var<uniform> widget: Widget;\n";
/** The uniform block: resolution, time, scale, pointer, values (std140 and WGSL agree: 96 bytes). */
export declare const UNIFORM_FLOATS = 24;
/**
 * `program`: the widget template's WGSL is at fault (it fails validation), a program error; else this host's (a client
 * error). `unavailable`: no WebGPU or no device, where the canvas shows its placeholder.
 */
export interface ShaderError {
    message: string;
    line?: number;
    column?: number;
    program?: boolean;
    unavailable?: boolean;
}
/** One shader on one canvas. */
export interface Surface {
    readonly backend: "webgpu";
    /** Whether the last frame is still drawing: no frame is submitted until it is done. */
    readonly drawing: boolean;
    /**
     * Draws a frame with `uniforms`; resolves with how long the GPU took when the backend can tell, else undefined.
     * On the queue the shaders share (widgets-gpu.md, GPU hang): `hang`, the frame hung; `run`, the shader's run, told
     * when the frame finished or was unfinished at a device loss.
     */
    render(uniforms: Float32Array, hang: () => void, run: Run): Promise<number | undefined> | undefined;
    /** Settles when its device is lost: the shader is built again on a new one. */
    readonly lost: Promise<unknown>;
    destroy(): void;
}
interface Gpu {
    /** Held: Chromium drops the instance (and fails every call) once its adapter is collected. */
    adapter: GPUAdapter;
    device: GPUDevice;
    format: GPUTextureFormat;
    pipelines: Map<string, Promise<GPURenderPipeline | ShaderError>>;
    /** Error scopes are the device's, not a pipeline's: builds take turns so one's errors can't land in another's scope. */
    turn: Promise<unknown>;
    layout: GPUBindGroupLayout;
    /** The shaders' queue's: only a hung frame's canvas stops, not the frames queued behind it. */
    watchdog: Watchdog;
}
export declare function webgpu(): Promise<Gpu | undefined>;
/** Makes a surface for `wgsl` on `canvas` on WebGPU; without it, unavailable. */
export declare function surface(canvas: HTMLCanvasElement, wgsl: string): Promise<Surface | ShaderError>;
export {};
