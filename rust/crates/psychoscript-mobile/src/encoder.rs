use std::sync::{Arc, Mutex, PoisonError};

use psychoscript::{Data, Failure, HostValue};

use crate::error::PsychoScriptError;

/// Writes values a program hands its host as bytes for the app, instead of JSON: a run's output
/// ([`crate::Program::run_bytes`]) and a live run's posts ([`crate::LiveHandler::on_posts_bytes`]). The crate only
/// carries the bytes; their format is the encoder's. Runs with an encoder pass program functions as markers
/// (`translate: { functions: "mark" }`).
pub trait EncodeValues: Send + Sync {
    /// The host global `run_bytes` defines; the program passes its output to it (`__emit(main())`).
    fn emit_name(&self) -> &str;
    /// A run's output, passed to the emit global. An `Err` is thrown at the call: uncaught, the run fails with
    /// `Runtime` of its kind and message, located at the call.
    fn encode_output(&self, value: &HostValue) -> Result<Vec<u8>, Failure>;
    /// What a live run keeps between its posts.
    fn live(&self) -> Box<dyn EncodePosts>;
}

/// A live run's posts (`__host.post(message)`).
pub trait EncodePosts: Send {
    /// The post's bytes, `None` when `keep` is false (dropped over the post rate), and what `post` returns. An `Err`
    /// is thrown at the post: a [`Failure`] is a program error (uncaught, the run fails with `Runtime` of its kind,
    /// located at the post); any other value is thrown as it is, for the program to catch.
    fn post(
        &mut self,
        message: &HostValue,
        keep: bool,
    ) -> Result<(Option<Vec<u8>>, HostValue), HostValue>;
    /// What a snapshot keeps of it, for [`EncodePosts::load`] in the restored run.
    fn save(&self) -> Data {
        Data::Null
    }
    fn load(&mut self, _saved: &Data) {}
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
    pub(crate) fn throw(&self, thrown: HostValue) -> HostValue {
        let HostValue::Failure(failure) = thrown else {
            return thrown;
        };
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
        widget_wire::encode_output_native(value, widget_wire::is_function_marker)
            .map_err(|e| Failure::new(e.kind, e.message))
    }
    fn live(&self) -> Box<dyn EncodePosts> {
        Box::new(widget_wire::LivePosts::new(widget_wire::is_function_marker))
    }
}

#[cfg(feature = "widget-wire")]
impl EncodePosts for widget_wire::LivePosts {
    fn post(
        &mut self,
        message: &HostValue,
        keep: bool,
    ) -> Result<(Option<Vec<u8>>, HostValue), HostValue> {
        match widget_wire::LivePosts::post(self, message, keep) {
            Ok((bytes, handled)) => {
                Ok((bytes, handled.map_or(HostValue::Undefined, HostValue::Bool)))
            }
            Err(widget_wire::PostError::Invalid(e)) => {
                Err(HostValue::Failure(Failure::new(e.kind, e.message)))
            }
            Err(widget_wire::PostError::Throw(message)) => Err(HostValue::Error(Box::new(
                psychoscript::HostError::new(message),
            ))),
        }
    }
    /// The last render's canvases, `[[key, id, wgsl], ...]`.
    fn save(&self) -> Data {
        Data::Array(
            self.last_render()
                .canvases
                .iter()
                .map(|c| {
                    Data::Array(vec![
                        Data::String(c.key.as_str().into()),
                        Data::String(c.id.as_str().into()),
                        Data::Bool(c.wgsl),
                    ])
                })
                .collect(),
        )
    }
    fn load(&mut self, saved: &Data) {
        let Data::Array(list) = saved else { return };
        let text = |d: &Data| d.as_string().map(|s| s.to_string_lossy().into_owned());
        let canvases = list
            .iter()
            .filter_map(|c| match c {
                Data::Array(f) if f.len() == 3 => Some(widget_wire::Canvas {
                    key: text(&f[0])?,
                    id: text(&f[1])?,
                    wgsl: matches!(f[2], Data::Bool(true)),
                }),
                _ => None,
            })
            .collect();
        self.restore_canvases(canvases);
    }
}

#[cfg(feature = "widget-wire")]
#[uniffi::export]
impl ValueEncoder {
    /// OpenCode widgets' binary format (`widget-wire`, opencode `specs/v2/widgets-binary.md`) for a native host
    /// (`widgets.md`, Native hosts): steps run `<program>\n__widget_emit(__widget_step(__input(), true))` with
    /// `run_bytes`, live runs `<program>\nreturn await __widget_live(__input(), true)`. A value it can't write fails with `Runtime`
    /// of kind `InvalidView`, `InvalidDraw` or `InvalidGpu` (the spec's phase `view`, `draw` or `gpu`), else
    /// `InvalidDataValue`.
    #[uniffi::constructor]
    pub fn widget() -> Arc<ValueEncoder> {
        ValueEncoder::new(Widget)
    }
}
