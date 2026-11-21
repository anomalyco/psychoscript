/** What clients prepend to a template's WGSL. */
export declare const HEADER = "struct Widget { resolution: vec2f, time: f32, scale: f32, pointer: vec4f, values: array<vec4f, 4> }\n@group(0) @binding(0) var<uniform> widget: Widget;\n";
/** The uniform block: resolution, time, scale, pointer, values (std140 and WGSL agree: 96 bytes). */
export declare const UNIFORM_FLOATS = 24;
/** `program`: the template's WGSL is at fault (it fails validation), a program error; else this host's (a client error). */
export interface ShaderError {
    message: string;
    line?: number;
    column?: number;
    program?: boolean;
}
/** One shader on one canvas. */
export interface Surface {
    readonly backend: "webgpu" | "webgl2";
    /** Draws a frame with `uniforms`; resolves with how long the GPU took when the backend can tell, else undefined. */
    render(uniforms: Float32Array): Promise<number | undefined> | undefined;
    destroy(): void;
}
interface Gpu {
    /** Held: Chromium drops the instance (and fails every call) once its adapter is collected. */
    adapter: GPUAdapter;
    device: GPUDevice;
    format: GPUTextureFormat;
    pipelines: Map<string, Promise<GPURenderPipeline | ShaderError>>;
    layout: GPUBindGroupLayout;
}
/** Use WebGL2 even where WebGPU works (tests, or a host that wants it). */
export declare function preferWebGL(on: boolean): void;
export declare function webgpu(): Promise<Gpu | undefined>;
/** Makes a surface for `wgsl` on `canvas`: WebGPU, else WebGL2 with `translate` (naga in the worker). */
export declare function surface(canvas: HTMLCanvasElement, wgsl: string, translate: (wgsl: string) => Promise<{
    code: string;
    block: string;
} | ShaderError>): Promise<Surface | ShaderError>;
export {};
