//! PsychoScript for iOS and Android: UniFFI bindings (Swift module `PsychoScript`, Kotlin package
//! `com.anomalyco.psychoscript`) over the `psychoscript` crate, with no JavaScript engine.
//!
//! The surface is the crate's essentials for a host that hands a program JSON and reads JSON back:
//! [`Program`] compiles a source once; [`Program::run`] runs it with its JSON input behind one sync
//! host function (`__input()` unless named otherwise) under [`RunOptions`]' limits, and returns
//! the program's completion value as JSON, or a [`PsychoScriptError`]. [`Program::start_live`] runs it as a
//! [`LiveRun`] instead: long-running, on a thread of its own, talking to the host through `__host`. With a
//! [`ValueEncoder`] ([`ValueEncoder::widget`] with feature `widget-wire`, on by default), [`Program::run_bytes`] and
//! live posts hand the app the encoder's bytes instead of JSON.
//!
//! With feature `shader` (on by default), [`translate_wgsl`] translates a WGSL entry point with naga
//! to MSL (Metal) or GLSL ES 3.00 (OpenGL ES 3).
//!
//! `README.md` covers packaging, threading and what a run copies.

mod encoder;
mod error;
mod fetch;
mod json;
mod live;
mod program;
#[cfg(feature = "shader")]
mod shader;
mod timer;

pub use encoder::{EncodeValues, ValueEncoder};
pub use error::PsychoScriptError;
pub use fetch::{
    FetchCompletion, FetchRequest, FetchResponse, FetchTransport, HttpHeader, is_public_address,
};
pub use live::{LiveExit, LiveHandler, LiveOptions, LiveRun};
pub use program::{Program, RunOptions, RunSession};
pub use psychoscript::HostValue;
#[cfg(feature = "shader")]
pub use shader::{
    ShaderError, ShaderStage, ShaderTarget, TranslatedShader, UniformBlock, translate_wgsl,
};

uniffi::setup_scaffolding!("psychoscript_mobile");
