//! GPU canvases (opencode `specs/v2/widgets-gpu.md`), with feature `widget-gpu`: a widget run's GPU batches are
//! replayed here on wgpu (`widget-gpu`), and each canvas is presented into a surface the app attaches
//! ([`crate::LiveRun::attach_surface`]); [`ShaderCanvas`] runs the `wgsl` shorthand the same way. The app only places
//! the surfaces and shows placeholders ([`GpuCanvasState`]).

#[cfg(feature = "widget-gpu")]
pub(crate) mod device;
#[cfg(feature = "widget-gpu")]
mod present;
#[cfg(feature = "widget-gpu")]
pub(crate) mod run;
mod shader;
mod surface;

pub use shader::ShaderCanvas;

/// The GPU device widget runs share, once made (Rust only, for diagnostics): its adapter's name, its backend, and
/// how long making it took.
#[derive(Clone, Debug, PartialEq)]
pub struct GpuDeviceInfo {
    pub adapter: String,
    pub backend: String,
    pub made_ms: f64,
}

/// A run's GPU work so far (Rust only, for diagnostics and benchmarks): batches replayed and canvases presented, with
/// their time in µs.
#[doc(hidden)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GpuStats {
    pub batches: u64,
    pub replay_us: f64,
    pub replay_max_us: f64,
    pub presents: u64,
    pub present_us: f64,
    pub present_max_us: f64,
}

#[cfg(feature = "widget-gpu")]
impl GpuStats {
    pub(crate) fn replayed(&mut self, us: f64) {
        self.batches += 1;
        self.replay_us += us;
        self.replay_max_us = self.replay_max_us.max(us);
    }
    pub(crate) fn presented(&mut self, us: f64) {
        self.presents += 1;
        self.present_us += us;
        self.present_max_us = self.present_max_us.max(us);
    }
}

/// Destroys the device widget runs share, as a driver reset would lose it (Rust only, for tests): every run is
/// told, and a new one is made.
#[doc(hidden)]
pub fn gpu_lose_device() {
    #[cfg(feature = "widget-gpu")]
    if let Some(d) = device::current() {
        d.device.destroy();
        // wgpu tells of a destroyed device once its queue is empty, at a poll; a driver's loss as it finds it.
        let _ = d.device.poll(wgpu::PollType::wait_indefinitely());
    }
}

/// The device if one is made (see [`GpuDeviceInfo`]); `None` before, or without one.
pub fn gpu_device() -> Option<GpuDeviceInfo> {
    #[cfg(feature = "widget-gpu")]
    return device::current().map(|d| {
        let info = d.adapter.get_info();
        GpuDeviceInfo {
            adapter: info.name,
            backend: format!("{:?}", info.backend),
            made_ms: d.made_ms,
        }
    });
    #[cfg(not(feature = "widget-gpu"))]
    None
}
pub use surface::GpuSurface;
/// Whose a GPU error is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GpuErrorKind {
    /// The program's (`report` it, phase `gpu`).
    Program,
    /// The client's (no GPU, a driver failure, out of GPU memory): log it.
    Client,
}

/// What a GPU canvas shows, from [`crate::LiveHandler::on_gpu_canvas`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GpuCanvasState {
    /// It has an image: show its surface, without the placeholder.
    Live,
    /// There is no GPU here: every GPU canvas of the run shows its placeholder (`poster`, else `alt`, else "GPU
    /// canvas not supported"). A client error; the widget keeps working.
    Unavailable,
    /// An error stopped it for the rest of the run: its placeholder with `message`. With `report`, report it once
    /// (a program error, phase `gpu`); a client error is logged.
    Stopped {
        kind: GpuErrorKind,
        message: String,
        report: bool,
    },
    /// The device was lost: the placeholder until the program draws it again (`Live`).
    Lost,
}

/// A GPU failure of [`GpuSurface`] or [`ShaderCanvas`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Error)]
pub enum GpuFailure {
    /// The widget template's (a WGSL error, phase `gpu`): report it.
    Program { message: String },
    /// The client's (no GPU, not a surface): show the placeholder, log it.
    Client { message: String },
}

impl std::fmt::Display for GpuFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GpuFailure::Program { message } | GpuFailure::Client { message } => {
                f.write_str(message)
            }
        }
    }
}

impl std::error::Error for GpuFailure {}

impl GpuFailure {
    pub(crate) fn client(message: impl Into<String>) -> GpuFailure {
        GpuFailure::Client {
            message: message.into(),
        }
    }
}

#[cfg(feature = "widget-gpu")]
impl From<widget_gpu::GpuError> for GpuFailure {
    fn from(e: widget_gpu::GpuError) -> Self {
        match e.kind {
            widget_gpu::ErrorKind::Program => GpuFailure::Program { message: e.message },
            widget_gpu::ErrorKind::Client => GpuFailure::Client { message: e.message },
        }
    }
}
