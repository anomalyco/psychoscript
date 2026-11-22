//! OpenCode widgets' binary wire format, version 1 (opencode `specs/v2/widgets-binary.md`): what a mobile host
//! writes instead of JSON for step outputs and live posts, and reads back.
//!
//! - [`encode_output`] and [`encode_post`] write a message straight from the VM's value (the [`HostValue`] a host
//!   function receives), applying the client rules the format bakes in (draw commands validated and colors resolved,
//!   children flattened, props of the wrong shape left out). An [`EncodeError`] is an invalid output or post: a
//!   program error, its kind naming the phase (`InvalidView`, `InvalidDraw`, `InvalidGpu`).
//! - [`decode_output`] and [`decode_post`] read it back into Rune's types ([`Node`], [`Command`], [`StepOutput`]),
//!   every read bounds-checked. The same types read the JSON form ([`StepOutput::from_value`],
//!   [`DrawOutput::from_value`], [`Node::from_value`]), so both paths can be compared.
//!
//! psychoscript-mobile (feature `widget-wire`) links it as its widget encoder; the crate itself knows nothing of
//! psychoscript-mobile.

mod decode;
pub mod draw;
mod encode;
mod gpu;
mod json;
mod native;
pub mod node;
mod schema;
pub mod step;

pub use decode::{DecodeError, Output, Post, decode_output, decode_post};
pub use draw::{Command, DrawOutput};
pub use encode::{
    EncodeError, INVALID_DATA, INVALID_DRAW, INVALID_GPU, INVALID_VIEW, LivePosts, PostError,
    encode_output, encode_output_native, encode_post,
};
pub use gpu::{Arg, Batch};
pub use native::{Canvas, Found, IsMarker};
pub use node::Node;
pub use psychoscript::HostValue;
pub use schema::{MAX_ARG_DEPTH, MAX_DEPTH, MAX_GPU_BYTES, MAX_GPU_OPS};
pub use step::StepOutput;

/// The format's version: every message's first byte.
pub const VERSION: u8 = 1;

/// The host global a widget program hands its step output to: hosts run
/// `<program>\n__widget_emit(__widget_step(__input()))`.
pub const EMIT: &str = "__widget_emit";
