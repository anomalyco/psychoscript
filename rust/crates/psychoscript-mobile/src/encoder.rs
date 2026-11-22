use std::sync::Arc;

use psychoscript::HostValue;

/// Writes values a program hands its host as bytes for the app, instead of JSON: a run's output
/// ([`crate::Program::run_bytes`]) and a live run's posts ([`crate::LiveHandler::on_posts_bytes`]). The crate only
/// carries the bytes; their format is the encoder's.
pub trait EncodeValues: Send + Sync {
    /// The host global `run_bytes` defines; the program passes its output to it (`__emit(main())`).
    fn emit_name(&self) -> &str;
    /// A run's output, passed to the emit global. An `Err` fails the run with `InvalidDataValue`.
    fn encode_output(&self, value: &HostValue) -> Result<Vec<u8>, String>;
    /// A live run's post (`__host.post(message)`). An `Err` throws `InvalidDataValue` at the post.
    fn encode_post(&self, message: &HostValue) -> Result<Vec<u8>, String>;
}

/// An encoder for [`crate::Program::run_bytes`] and live runs (see [`EncodeValues`]).
#[derive(Clone, uniffi::Object)]
pub struct ValueEncoder(pub(crate) Arc<dyn EncodeValues>);

impl ValueEncoder {
    pub fn new(encoder: impl EncodeValues + 'static) -> Arc<ValueEncoder> {
        Arc::new(ValueEncoder(Arc::new(encoder)))
    }
}

impl std::fmt::Debug for ValueEncoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ValueEncoder({})", self.0.emit_name())
    }
}

#[uniffi::export]
impl ValueEncoder {
    /// The host global `run_bytes` defines for the program's output.
    pub fn emit_name(&self) -> String {
        self.0.emit_name().to_owned()
    }
}

#[cfg(feature = "widget-wire")]
struct Widget;

#[cfg(feature = "widget-wire")]
impl EncodeValues for Widget {
    fn emit_name(&self) -> &str {
        widget_wire::EMIT
    }
    fn encode_output(&self, value: &HostValue) -> Result<Vec<u8>, String> {
        widget_wire::encode_output(value)
    }
    fn encode_post(&self, message: &HostValue) -> Result<Vec<u8>, String> {
        widget_wire::encode_post(message)
    }
}

#[cfg(feature = "widget-wire")]
#[uniffi::export]
impl ValueEncoder {
    /// OpenCode widgets' binary format (`widget-wire`, opencode `specs/v2/widgets-binary.md`): run the program as
    /// `<program>\n__widget_emit(__widget_step(__input()))`.
    #[uniffi::constructor]
    pub fn widget() -> Arc<ValueEncoder> {
        ValueEncoder::new(Widget)
    }
}
