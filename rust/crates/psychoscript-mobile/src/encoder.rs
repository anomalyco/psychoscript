use std::sync::{Arc, Mutex, PoisonError};

use psychoscript::{Failure, HostValue};

use crate::error::PsychoScriptError;

/// Writes values a program hands its host as bytes for the app, instead of JSON: a run's output
/// ([`crate::Program::run_bytes`]) and a live run's posts ([`crate::LiveHandler::on_posts_bytes`]). The crate only
/// carries the bytes; their format is the encoder's.
pub trait EncodeValues: Send + Sync {
    /// The host global `run_bytes` defines; the program passes its output to it (`__emit(main())`).
    fn emit_name(&self) -> &str;
    /// A run's output, passed to the emit global. An `Err` is thrown at the call: uncaught, the run fails with
    /// `Runtime` of its kind and message, located at the call.
    fn encode_output(&self, value: &HostValue) -> Result<Vec<u8>, Failure>;
    /// A live run's post (`__host.post(message)`). An `Err` is thrown at the post, as for `encode_output`.
    fn encode_post(&self, message: &HostValue) -> Result<Vec<u8>, Failure>;
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

/// An encoder's failure, thrown at the call as `InvalidDataValue` so the run's error is located there (the language
/// locates only its own kinds), then named by its own kind on that error.
#[derive(Default)]
pub(crate) struct Thrown(Mutex<Option<(String, String)>>);

impl Thrown {
    pub(crate) fn throw(&self, failure: Failure) -> HostValue {
        let message = failure.message.to_string_lossy().into_owned();
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((failure.kind, message.clone()));
        HostValue::Failure(Failure::new("InvalidDataValue", message))
    }

    /// Gives `error` the encoder's kind when it is the failure thrown.
    pub(crate) fn name(&self, error: &mut PsychoScriptError) {
        let thrown = self.0.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let (PsychoScriptError::Runtime { kind, reason, .. }, Some((own, message))) =
            (error, thrown)
            && kind == "InvalidDataValue"
            && reason.contains(&message)
        {
            *kind = own;
        }
    }
}

#[cfg(feature = "widget-wire")]
struct Widget;

#[cfg(feature = "widget-wire")]
impl EncodeValues for Widget {
    fn emit_name(&self) -> &str {
        widget_wire::EMIT
    }
    fn encode_output(&self, value: &HostValue) -> Result<Vec<u8>, Failure> {
        widget_wire::encode_output(value).map_err(|e| Failure::new(e.kind, e.message))
    }
    fn encode_post(&self, message: &HostValue) -> Result<Vec<u8>, Failure> {
        widget_wire::encode_post(message).map_err(|e| Failure::new(e.kind, e.message))
    }
}

#[cfg(feature = "widget-wire")]
#[uniffi::export]
impl ValueEncoder {
    /// OpenCode widgets' binary format (`widget-wire`, opencode `specs/v2/widgets-binary.md`): run the program as
    /// `<program>\n__widget_emit(__widget_step(__input()))`. A value it can't write fails with `Runtime` of kind
    /// `InvalidView`, `InvalidDraw` or `InvalidGpu` (the spec's phase `view`, `draw` or `gpu`), else
    /// `InvalidDataValue`.
    #[uniffi::constructor]
    pub fn widget() -> Arc<ValueEncoder> {
        ValueEncoder::new(Widget)
    }
}
