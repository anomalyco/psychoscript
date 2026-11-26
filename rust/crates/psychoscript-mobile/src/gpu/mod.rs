//! GPU canvases, with feature `gpu`: a live run's GPU batches (`psychoscript-gpu`) are replayed here on wgpu, on the
//! app's one device ([`device`]), and each canvas is presented into a surface the app attaches
//! ([`crate::LiveRun::attach_surface`], [`present`]). The app only places the surfaces and shows placeholders
//! ([`GpuCanvasState`]). An encoder's live posts give the run its GPU ([`LiveGpu`], from
//! [`crate::EncodePosts::surfaces`]); a host may build its own GPU canvases on the same device and presenter.

#[cfg(feature = "gpu")]
pub mod device;
#[cfg(feature = "gpu")]
pub mod present;
#[cfg(feature = "gpu")]
mod run;
mod surface;

#[cfg(feature = "gpu")]
pub use run::LiveGpu;

#[cfg(feature = "test-hooks")]
/// The GPU device runs share, once made (Rust only, for tests): its adapter's name, its backend, and how long
/// making it took.
#[derive(Clone, Debug, PartialEq)]
pub struct GpuDeviceInfo {
    pub adapter: String,
    pub backend: String,
    pub made_ms: f64,
}

#[cfg(feature = "test-hooks")]
/// A run's GPU work so far (Rust only, for tests and benchmarks): batches replayed and canvases presented, with their
/// time in µs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GpuStats {
    pub batches: u64,
    pub replay_us: f64,
    pub replay_max_us: f64,
    pub presents: u64,
    pub present_us: f64,
    pub present_max_us: f64,
}

#[cfg(all(feature = "gpu", feature = "test-hooks"))]
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

/// Destroys the device runs share, as a driver reset would lose it (Rust only, for tests): every run is
/// told, and a new one is made. A device still being made (after a loss, on a phone in hundreds of ms) is waited for,
/// then lost.
#[cfg(feature = "test-hooks")]
pub fn gpu_lose_device() {
    #[cfg(feature = "gpu")]
    if let Ok(d) = device::get() {
        // No replay between the destroy and the poll that tells of it: `destroy` invalidates every resource at
        // once, which a driver's loss doesn't (wgpu reports replay on a lost device as no error).
        let submits = device::submits();
        d.device.destroy();
        // wgpu tells of a destroyed device at a poll that finds its queue empty (a wait for the last submission
        // may not); a driver's loss as it finds it.
        device::poll(&d.device, true);
        for _ in 0..100 {
            if !device::poll(&d.device, false) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        drop(submits);
    }
}

/// Waits until the GPU is done with everything submitted to the shared device, once it is made (Rust only, for
/// tests).
#[cfg(feature = "test-hooks")]
pub fn gpu_wait_idle() {
    #[cfg(feature = "gpu")]
    if let Ok(d) = device::get() {
        device::poll(&d.device, true);
    }
}

/// The GPU time (from submit to completion, as the host sees it: what the hang rule measures) of each submit since the
/// last call, in ms; the first call starts recording (Rust only, for tests).
#[cfg(feature = "test-hooks")]
pub fn gpu_submit_times() -> Vec<f64> {
    #[cfg(feature = "gpu")]
    return std::mem::take(
        device::TIMES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert_with(Vec::new),
    );
    #[cfg(not(feature = "gpu"))]
    Vec::new()
}

/// Has the run that next ends a frame lose the device right then, with that frame's last batch in flight (submitted,
/// not seen finished), and with `finished` some of its work seen finished before (`Gpu::work_finished`): the GPU
/// fixtures' `inFlight` losses, a strike when `finished` (Rust only, for tests).
#[cfg(feature = "test-hooks")]
pub fn gpu_lose_device_at_frame_end(finished: bool) {
    LOSE_AT_FRAME_END.store(1 + u8::from(finished), std::sync::atomic::Ordering::SeqCst);
}

/// 0 none, 1 without work seen finished, 2 with.
#[cfg(feature = "test-hooks")]
pub(crate) static LOSE_AT_FRAME_END: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(0);

/// Has every device made from now on fail, `after_ms` into making it (Rust only, for tests of a GPU that turns out
/// to be missing).
#[cfg(feature = "test-hooks")]
pub fn gpu_fail_devices(after_ms: u64) {
    #[cfg(feature = "gpu")]
    {
        *device::FAIL
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(std::time::Duration::from_millis(after_ms));
    }
    #[cfg(not(feature = "gpu"))]
    let _ = after_ms;
}

/// Has [`LiveGpu::input`]'s `format` say `format` (Rust only, for conformance fixtures: a program may configure
/// either canvas format).
#[cfg(feature = "test-hooks")]
pub fn gpu_input_format(format: &str) {
    *FORMAT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(format.to_owned());
}

#[cfg(feature = "test-hooks")]
static FORMAT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(feature = "test-hooks")]
/// The device if one is made (see [`GpuDeviceInfo`]); `None` before, or without one (Rust only, for tests).
pub fn gpu_device() -> Option<GpuDeviceInfo> {
    #[cfg(feature = "gpu")]
    return device::current().map(|d| {
        let info = d.adapter.get_info();
        GpuDeviceInfo {
            adapter: info.name,
            backend: format!("{:?}", info.backend),
            made_ms: d.made_ms,
        }
    });
    #[cfg(not(feature = "gpu"))]
    None
}
pub use surface::GpuSurface;
/// Whose a GPU error is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GpuErrorKind {
    /// The program's: report it (as an error of its GPU work).
    Program,
    /// The client's (no GPU, a driver failure, out of GPU memory): log it.
    Client,
}

/// What a GPU canvas shows, from [`crate::LiveHandler::on_gpu_canvas`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GpuCanvasState {
    /// It has an image: show its surface, without the placeholder. `opaque`: the program configured its context
    /// with `alphaMode: "opaque"` (the default), so its pixels have no transparency (Android: `TextureView.setOpaque`);
    /// else `"premultiplied"`. Told when the canvas goes live, and again only if a reconfigure changes it.
    Live { opaque: bool },
    /// There is no GPU here: every GPU canvas of the run shows its placeholder. A client error; the program keeps
    /// running. `reason` says why (the Android version, no
    /// Vulkan adapter, the GPU's Vulkan version or limits under the spec's, each with its value, or wgpu's error
    /// making the device), for the app to show or ignore.
    Unavailable { reason: String },
    /// An error stopped it for the rest of the run: its placeholder with `message`. With `report`, report it once
    /// (a program error); a client error is logged.
    Stopped {
        kind: GpuErrorKind,
        message: String,
        report: bool,
    },
    /// The device was lost: the placeholder until the program draws it again (`Live`). `reason` is wgpu's, worked
    /// out once at the loss (`the GPU device was lost (unknown): ...`), for the app to show or ignore.
    Lost { reason: String },
}

/// A GPU failure of a [`GpuSurface`], or of GPU work a host draws into one.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Error)]
pub enum GpuFailure {
    /// The program's (a WGSL error): report it. (`reason`, not `message`: a Kotlin exception has a `message` of its
    /// own.)
    Program { reason: String },
    /// The client's (no GPU, not a surface): show the placeholder, log it.
    Client { reason: String },
}

impl std::fmt::Display for GpuFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GpuFailure::Program { reason } | GpuFailure::Client { reason } => f.write_str(reason),
        }
    }
}

impl std::error::Error for GpuFailure {}

impl GpuFailure {
    /// A client failure for `reason`.
    pub fn client(reason: impl Into<String>) -> GpuFailure {
        GpuFailure::Client {
            reason: reason.into(),
        }
    }
}

#[cfg(feature = "gpu")]
impl From<psychoscript_gpu::GpuError> for GpuFailure {
    fn from(e: psychoscript_gpu::GpuError) -> Self {
        match e.kind {
            psychoscript_gpu::ErrorKind::Program => GpuFailure::Program { reason: e.message },
            psychoscript_gpu::ErrorKind::Client => GpuFailure::Client { reason: e.message },
        }
    }
}
