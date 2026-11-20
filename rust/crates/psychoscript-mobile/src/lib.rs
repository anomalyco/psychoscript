//! PsychoScript for iOS and Android: UniFFI bindings (Swift module `PsychoScript`, Kotlin package
//! `com.anomalyco.psychoscript`) over the `psychoscript` crate, with no JavaScript engine.
//!
//! The surface is the crate's essentials for a host that hands a program JSON and reads JSON back:
//! [`Program`] compiles a source once; [`Program::run`] runs it with its JSON input behind one sync
//! host function (`__input()` unless named otherwise) under [`RunOptions`]' limits, and returns
//! the program's completion value as JSON, or a [`PsychoScriptError`].
//!
//! With feature `shader` (on by default), [`translate_wgsl`] translates a WGSL entry point with naga
//! to MSL (Metal) or GLSL ES 3.00 (OpenGL ES 3).
//!
//! `README.md` covers packaging, threading and what a run copies.

mod error;
mod input;
mod program;
#[cfg(feature = "shader")]
mod shader;

pub use error::PsychoScriptError;
pub use program::{Program, RunOptions};
#[cfg(feature = "shader")]
pub use shader::{
    ShaderError, ShaderStage, ShaderTarget, TranslatedShader, UniformBlock, translate_wgsl,
};

uniffi::setup_scaffolding!("psychoscript_mobile");
