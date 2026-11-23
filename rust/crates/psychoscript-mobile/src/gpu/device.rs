//! The app's one GPU device, shared by every widget run and [`super::ShaderCanvas`]: Metal on iOS and macOS, Vulkan
//! on Android (Android 15 or newer, API 35 and up: `widgets-gpu.md` names 15 and 16) and Linux. Made when first needed, on a
//! thread of its own ([`prepare`]), and made again after a loss.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
#[cfg(feature = "test-hooks")]
use std::time::Instant;

/// A device and what it was made with.
pub(crate) struct Dev {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// The canvases' format (`gpu.format`).
    pub format: wgpu::TextureFormat,
    /// Counts devices made: a newer one replaced a lost one.
    pub generation: u64,
    /// How long making it took.
    #[cfg(feature = "test-hooks")]
    pub made_ms: f64,
}

/// Told of a device loss, on the thread that saw it.
pub(crate) trait Loss: Send + Sync {
    /// The device was lost (`reason` WebGPU's: `unknown` or `destroyed`); a new one is being made.
    fn lost(&self, reason: &str, message: &str);
    /// A device is ready, the first or one after a loss (or none could be made: [`current`] says).
    fn replaced(&self);
    /// About once a display frame, on a thread that never submits: looks for GPU hangs.
    fn tick(&self);
}

enum State {
    Idle,
    Making,
    Ready(Arc<Dev>),
    Unavailable(String),
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
    instance: OnceLock<Option<wgpu::Instance>>,
    generation: Mutex<u64>,
    listeners: Mutex<Vec<Weak<dyn Loss>>>,
}

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Shared {
        state: Mutex::new(State::Idle),
        ready: Condvar::new(),
        instance: OnceLock::new(),
        generation: Mutex::new(0),
        listeners: Mutex::new(Vec::new()),
    })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Starts making the device on a thread of its own, unless it is made or being made.
pub(crate) fn prepare() {
    let s = shared();
    let mut state = lock(&s.state);
    if matches!(*state, State::Idle) {
        *state = State::Making;
        drop(state);
        spawn_make();
    }
}

fn spawn_make() {
    let spawned = std::thread::Builder::new()
        .name("psychoscript-gpu-device".into())
        .spawn(make_and_publish);
    if spawned.is_err() {
        make_and_publish();
    }
}

fn make_and_publish() {
    let s = shared();
    let made = make();
    let mut state = lock(&s.state);
    *state = match made {
        Ok(dev) => State::Ready(Arc::new(dev)),
        Err(why) => State::Unavailable(why),
    };
    drop(state);
    s.ready.notify_all();
    for l in listeners() {
        l.replaced();
    }
}

/// The device if it is made, why there is none, or `None` while it is being made.
pub(crate) fn ready() -> Option<Result<Arc<Dev>, String>> {
    match &*lock(&shared().state) {
        State::Ready(dev) => Some(Ok(dev.clone())),
        State::Unavailable(why) => Some(Err(why.clone())),
        State::Idle | State::Making => None,
    }
}

/// The canvas format this platform's device has (`gpu.format`), known before it is made; or why there is no GPU.
pub(crate) fn format() -> Result<&'static str, String> {
    Ok(match backends()? {
        wgpu::Backends::METAL => "bgra8unorm",
        _ => "rgba8unorm",
    })
}

/// The device, made now if it isn't (waiting for one being made), or why there is none.
pub(crate) fn get() -> Result<Arc<Dev>, String> {
    prepare();
    let s = shared();
    let mut state = lock(&s.state);
    loop {
        match &*state {
            State::Ready(dev) => return Ok(dev.clone()),
            State::Unavailable(why) => return Err(why.clone()),
            State::Idle | State::Making => {
                state = s.ready.wait(state).unwrap_or_else(PoisonError::into_inner)
            }
        }
    }
}

/// The device if one is ready, without waiting.
pub(crate) fn current() -> Option<Arc<Dev>> {
    match &*lock(&shared().state) {
        State::Ready(dev) => Some(dev.clone()),
        _ => None,
    }
}

/// Tells `listener` of device losses while it lives.
pub(crate) fn subscribe(listener: Weak<dyn Loss>) {
    let mut list = lock(&shared().listeners);
    list.retain(|l| l.strong_count() > 0);
    list.push(listener);
    if list.len() == 1 {
        // A thread ticks the listeners while there are any.
        let _ = std::thread::Builder::new()
            .name("psychoscript-gpu-hangs".into())
            .spawn(|| {
                loop {
                    std::thread::sleep(Duration::from_millis(16));
                    let mut list = lock(&shared().listeners);
                    list.retain(|l| l.strong_count() > 0);
                    if list.is_empty() {
                        return;
                    }
                    drop(list);
                    for l in listeners() {
                        l.tick();
                    }
                }
            });
    }
}

fn listeners() -> Vec<Arc<dyn Loss>> {
    lock(&shared().listeners)
        .iter()
        .filter_map(Weak::upgrade)
        .collect()
}

/// Held around every submission to the shared device and every surface configuration: wgpu configures a surface
/// only when the device is idle, which another thread's submission would break. Never held while waiting for a
/// surface's texture.
pub(crate) fn submits() -> MutexGuard<'static, ()> {
    static SUBMITS: Mutex<()> = Mutex::new(());
    lock(&SUBMITS)
}

/// Polls a future wgpu resolves without an event loop.
pub(crate) fn block<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            return v;
        }
        std::thread::yield_now();
    }
}

#[cfg(target_os = "android")]
fn android_api() -> Option<u32> {
    unsafe extern "C" {
        fn __system_property_get(
            name: *const std::ffi::c_char,
            value: *mut std::ffi::c_char,
        ) -> i32;
    }
    let mut value = [0 as std::ffi::c_char; 92];
    // SAFETY: a NUL-terminated name and a buffer of PROP_VALUE_MAX (92) bytes.
    let n = unsafe { __system_property_get(c"ro.build.version.sdk".as_ptr(), value.as_mut_ptr()) };
    let bytes: Vec<u8> = value[..n.max(0) as usize]
        .iter()
        .map(|c| c.to_ne_bytes()[0])
        .collect();
    std::str::from_utf8(&bytes).ok()?.trim().parse().ok()
}

fn backends() -> Result<wgpu::Backends, String> {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    return Ok(wgpu::Backends::METAL);
    #[cfg(target_os = "android")]
    return match android_api() {
        // No upper bound: a newer Android keeps Vulkan (Android 17, API 37, on every Pixel since 6).
        Some(35..) => Ok(wgpu::Backends::VULKAN),
        Some(api) => Err(format!(
            "GPU canvases need Android 15 or newer (API 35), not API {api}"
        )),
        None => Err("the Android version is unknown".into()),
    };
    #[cfg(target_os = "linux")]
    return Ok(wgpu::Backends::VULKAN);
    #[allow(unreachable_code)]
    Err("no GPU backend on this platform".into())
}

/// The process's one instance: surfaces made from it stay valid across devices.
pub(crate) fn instance() -> Result<wgpu::Instance, String> {
    let backends = backends()?;
    shared()
        .instance
        .get_or_init(|| {
            Some(wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends,
                flags: wgpu::InstanceFlags::from_build_config(),
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            }))
        })
        .clone()
        .ok_or_else(|| "no GPU instance".to_owned())
}

/// For tests: devices fail to be made, after this long (`gpu_fail_devices`).
#[cfg(feature = "test-hooks")]
pub(crate) static FAIL: Mutex<Option<std::time::Duration>> = Mutex::new(None);

fn make() -> Result<Dev, String> {
    #[cfg(feature = "test-hooks")]
    if let Some(after) = *lock(&FAIL) {
        std::thread::sleep(after);
        return Err("no GPU device (as the test asked)".into());
    }
    #[cfg(feature = "test-hooks")]
    let started = Instant::now();
    let instance = instance()?;
    let adapter = block(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|e| format!("no GPU adapter: {e}"))?;
    let info = adapter.get_info();
    if info.backend == wgpu::Backend::Vulkan {
        match vulkan_version(&adapter) {
            Some(version) if version >= (1, 1) => {}
            Some((major, minor)) => {
                return Err(format!(
                    "the GPU ({}) has Vulkan {major}.{minor}; GPU canvases need 1.1 or newer",
                    describe(&info)
                ));
            }
            None => {
                return Err(format!(
                    "the GPU ({}) has no Vulkan version",
                    describe(&info)
                ));
            }
        }
    }
    // The program's limits (`widget_gpu::device_limits`), but the adapter's texture size: the host checks hold
    // programs to 4096, and a surface (a 5K screen) may be larger.
    let required_limits = wgpu::Limits {
        max_texture_dimension_2d: (adapter.limits().max_texture_dimension_2d)
            .max(widget_gpu::device_limits().max_texture_dimension_2d),
        ..widget_gpu::device_limits()
    };
    let required_limits = simulator_limits(required_limits, &adapter);
    if let Some(low) = under(&required_limits, &adapter.limits()) {
        return Err(format!(
            "the GPU ({}) is under the spec's limits: {low}",
            describe(&info)
        ));
    }
    let (device, queue) = block(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("widgets"),
        required_limits,
        ..Default::default()
    }))
    .map_err(|e| format!("no GPU device on {}: {e}", describe(&info)))?;
    // An error outside the replay's and the presenter's error scopes is never the app's crash.
    device.on_uncaptured_error(std::sync::Arc::new(|_: wgpu::Error| {}));
    let generation = {
        let mut g = lock(&shared().generation);
        *g += 1;
        *g
    };
    device.set_device_lost_callback(move |reason, message| lost(generation, reason, message));
    Ok(Dev {
        format: widget_gpu::preferred_format(info.backend),
        instance,
        adapter,
        device,
        queue,
        generation,
        #[cfg(feature = "test-hooks")]
        made_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// The iOS Simulator's GPU is under some of the spec's limits (`max_inter_stage_shader_variables` 15): there, the
/// adapter's where they fall short (a program over them gets wgpu's validation error), told once. Real devices get
/// the spec's (decided as the crate is built).
#[cfg(all(target_os = "ios", target_abi = "sim"))]
fn simulator_limits(spec: wgpu::Limits, adapter: &wgpu::Adapter) -> wgpu::Limits {
    let has = adapter.limits();
    let mut low = Vec::new();
    spec.check_limits_with_fail_fn(&has, false, |name, wanted, allowed| {
        low.push(format!("{name} {allowed} (the spec's {wanted})"))
    });
    if !low.is_empty() {
        static TOLD: std::sync::Once = std::sync::Once::new();
        TOLD.call_once(|| {
            eprintln!(
                "psychoscript-mobile: the iOS Simulator's GPU is under the GPU canvas limits, which are lowered to it here \
                 only: {}",
                low.join(", ")
            )
        });
    }
    spec.or_worse_values_from(&has)
}

#[cfg(not(all(target_os = "ios", target_abi = "sim")))]
fn simulator_limits(spec: wgpu::Limits, _adapter: &wgpu::Adapter) -> wgpu::Limits {
    spec
}

/// The adapter's name and driver, for a reason there is no device.
fn describe(info: &wgpu::AdapterInfo) -> String {
    let driver = [info.driver.trim(), info.driver_info.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    match driver.is_empty() {
        true => format!("{}, {:?}", info.name, info.backend),
        false => format!("{}, {:?}, driver {driver}", info.name, info.backend),
    }
}

/// Each limit of `has` under `required`, by WebGPU's name, with both values: `maxStorageBuffersPerShaderStage 4
/// (needs 8)`; `None` when none is.
fn under(required: &wgpu::Limits, has: &wgpu::Limits) -> Option<String> {
    let mut low = Vec::new();
    required.check_limits_with_fail_fn(has, false, |name, wanted, allowed| {
        let bound = match name.starts_with("min_") {
            true => " or less",
            false => "",
        };
        low.push(format!(
            "{} {allowed} (needs {wanted}{bound})",
            webgpu_name(name)
        ));
    });
    (!low.is_empty()).then(|| low.join(", "))
}

/// `max_texture_dimension_2d` as WebGPU writes it: `maxTextureDimension2D`.
fn webgpu_name(name: &str) -> String {
    let mut out = String::new();
    for (i, part) in name.split('_').enumerate() {
        let mut chars = part.chars();
        match (i, chars.next()) {
            (0, Some(c)) => out.push(c),
            (_, Some(c)) => out.extend(c.to_uppercase()),
            (_, None) => {}
        }
        out.push_str(&match part.starts_with(|c: char| c.is_ascii_digit()) {
            true => chars.as_str().to_uppercase(),
            false => chars.as_str().to_owned(),
        });
    }
    out
}

/// The adapter's Vulkan version, `(major, minor)`.
#[cfg(any(target_os = "android", target_os = "linux"))]
fn vulkan_version(adapter: &wgpu::Adapter) -> Option<(u32, u32)> {
    // SAFETY: only reads the physical device's properties.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Vulkan>() }?;
    let version = hal.physical_device_capabilities().properties().api_version;
    Some((version >> 22, (version >> 12) & 0x3ff))
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
fn vulkan_version(_adapter: &wgpu::Adapter) -> Option<(u32, u32)> {
    None
}

/// The device of `generation` was lost: tell the runs, make a new one, then tell them it is ready.
fn lost(generation: u64, reason: wgpu::DeviceLostReason, message: String) {
    let s = shared();
    {
        let mut state = lock(&s.state);
        match &*state {
            State::Ready(dev) if dev.generation == generation => *state = State::Making,
            // A device replaced already, or dropped as the process ends.
            _ => return,
        }
    }
    let reason = match reason {
        wgpu::DeviceLostReason::Destroyed => "destroyed",
        _ => "unknown",
    };
    for l in listeners() {
        l.lost(reason, &message);
    }
    spawn_make();
}

/// Polls `device` (`wait`: until its queue is empty); false when it is lost. wgpu panics in `Device::poll` on a lost
/// device (`Error in Device::poll: ...`): that panic is the loss, not the app's crash. Any other panic goes on.
pub(crate) fn poll(device: &wgpu::Device, wait: bool) -> bool {
    let kind = match wait {
        true => wgpu::PollType::wait_indefinitely(),
        false => wgpu::PollType::Poll,
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| device.poll(kind))) {
        Ok(_) => true,
        Err(panic) => {
            let message = (panic.downcast_ref::<String>().map(String::as_str))
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .unwrap_or("");
            if message.starts_with("Error in Device::poll") {
                return false;
            }
            std::panic::resume_unwind(panic)
        }
    }
}

/// Each watched submit's GPU time in ms, when recorded (Rust only, for tests: [`super::gpu_submit_times`]).
#[cfg(feature = "test-hooks")]
pub(crate) static TIMES: Mutex<Option<Vec<f64>>> = Mutex::new(None);

/// The end on the GPU of what was submitted so far ([`watch`]).
pub(crate) struct Watch {
    done: AtomicBool,
}

impl Watch {
    /// Whether the GPU is done with it, looked at now (`dev` its device).
    pub(crate) fn done(&self, dev: &Dev) -> bool {
        // A lost device finishes nothing more: done (the loss is told).
        !poll(&dev.device, false) || self.done.load(Ordering::Acquire)
    }
}

/// Watches what was submitted to `dev` so far.
pub(crate) fn watch(dev: &Dev) -> Arc<Watch> {
    let watch = Arc::new(Watch {
        done: AtomicBool::new(false),
    });
    let w = watch.clone();
    #[cfg(feature = "test-hooks")]
    let at = Instant::now();
    dev.queue.on_submitted_work_done(move || {
        #[cfg(feature = "test-hooks")]
        if let Some(times) = lock(&TIMES).as_mut() {
            times.push(at.elapsed().as_secs_f64() * 1e3);
        }
        w.done.store(true, Ordering::Release);
    });
    watch
}

/// Waits (on a run's thread) until the GPU is done with `watch`, `dev` is lost or `stop` says.
pub(crate) fn settle(dev: &Dev, watch: &Watch, stop: impl Fn() -> bool) {
    while !watch.done(dev) && current().is_some_and(|d| d.generation == dev.generation) && !stop() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reason_names_each_limit_under_the_spec_with_both_values() {
        let spec = widget_gpu::device_limits();
        assert_eq!(under(&spec, &spec), None);
        let has = wgpu::Limits {
            max_storage_buffers_per_shader_stage: 4,
            max_texture_dimension_2d: 2048,
            min_uniform_buffer_offset_alignment: 512,
            max_compute_workgroup_storage_size: 32768,
            ..spec.clone()
        };
        assert_eq!(
            under(&spec, &has).as_deref(),
            Some(
                "maxTextureDimension2D 2048 (needs 4096), maxStorageBuffersPerShaderStage 4 (needs 8), \
                 minUniformBufferOffsetAlignment 512 (needs 256 or less)"
            )
        );
    }
}
