//! PsychoScript for iOS and Android: UniFFI bindings (Swift module `PsychoScript`, Kotlin package
//! `com.anomalyco.psychoscript`) over the `psychoscript` crate, with no JavaScript engine.
//!
//! The surface is the crate's essentials for a host that hands a program JSON and reads JSON back:
//! [`Program`] compiles a source once; [`Program::run`] runs it with its JSON input behind one sync
//! host function (`__input()` unless named otherwise) under [`RunOptions`]' limits, and returns
//! the program's completion value as JSON, or a [`PsychoScriptError`]. [`Program::start_live`] runs it as a
//! [`LiveRun`] instead: long-running, on a thread of its own, talking to the host through `__host`. With a
//! [`ValueEncoder`] (a host's own format, [`EncodeValues`]), [`Program::run_bytes`] and live posts hand the app the
//! encoder's bytes instead of JSON.
//!
//! With feature `gpu` (on by default), live runs whose encoder gives them a GPU ([`gpu::LiveGpu`]) replay their GPU
//! canvases themselves (`psychoscript-gpu`): the app attaches a [`GpuSurface`] per canvas
//! ([`LiveRun::attach_surface`]). A host building on this crate (a library of its own that links it, adding its
//! UniFFI exports) reaches the device and the presenter through [`gpu`].
//!
//! `README.md` covers packaging, threading and what a run copies.

mod cpu;
mod encoder;
mod error;
mod fetch;
mod frames;
pub mod gpu;
mod hint;
mod json;
mod live;
mod program;
mod timer;

pub use encoder::{EncodePosts, EncodeStep, EncodeValues, Reject, ValueEncoder};
pub use error::PsychoScriptError;
pub use fetch::{
    FetchCompletion, FetchRequest, FetchResponse, FetchTransport, HttpHeader, is_public_address,
};
pub use gpu::{GpuCanvasState, GpuErrorKind, GpuFailure, GpuSurface};
/// Rust only, for tests (feature `test-hooks`, never in a release build).
#[cfg(feature = "test-hooks")]
pub use gpu::{
    GpuDeviceInfo, GpuStats, gpu_device, gpu_fail_devices, gpu_input_format, gpu_lose_device,
    gpu_lose_device_at_frame_end, gpu_submit_times, gpu_wait_idle,
};
pub use live::{LiveContext, LiveExit, LiveHandler, LiveOptions, LiveRun, LiveSurfaces};
pub use program::{Program, ProgramLines, RunOptions, RunSession};
pub use psychoscript::{Failure, HostValue};

uniffi::setup_scaffolding!("psychoscript_mobile");
