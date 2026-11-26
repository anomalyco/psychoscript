//! A native surface the app owns: a `CAMetalLayer` (iOS, macOS) or an `ANativeWindow` (Android), held for as long
//! as the [`GpuSurface`] lives.

use std::ffi::c_void;
use std::sync::Arc;

use super::GpuFailure;

#[derive(Debug)]
enum Native {
    /// A `CAMetalLayer`, retained.
    #[cfg_attr(not(any(target_os = "ios", target_os = "macos")), allow(dead_code))]
    Layer(*mut c_void),
    /// An `ANativeWindow`, one reference acquired.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Window(*mut c_void),
}

/// Where a GPU canvas is presented: from `GpuSurface.metalLayer(pointer:)` (Swift: `GpuSurface.metal(layer)`) or,
/// on Android, `PsychoScriptGpu.surface(surface)`. It holds the layer or window until it is dropped; attach it to a
/// run's canvas with [`crate::LiveRun::attach_surface`] or give it to a [`super::ShaderCanvas`].
#[derive(Debug, uniffi::Object)]
pub struct GpuSurface {
    native: Native,
}

// SAFETY: a retained `CAMetalLayer` and an acquired `ANativeWindow` may be used and released from any thread; wgpu
// configures and presents them off the main thread.
unsafe impl Send for GpuSurface {}
unsafe impl Sync for GpuSurface {}

#[cfg(any(target_os = "ios", target_os = "macos"))]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

#[cfg(target_os = "android")]
#[link(name = "android")]
unsafe extern "C" {
    fn ANativeWindow_fromSurface(env: *mut c_void, surface: *mut c_void) -> *mut c_void;
    fn ANativeWindow_release(window: *mut c_void);
}

#[uniffi::export]
impl GpuSurface {
    /// A `CAMetalLayer`, by its pointer (Swift: `UInt64(UInt(bitPattern: Unmanaged.passUnretained(layer)
    /// .toOpaque()))`), retained until the surface is dropped. Fails off Apple platforms.
    #[uniffi::constructor]
    pub fn metal_layer(pointer: u64) -> Result<Arc<GpuSurface>, GpuFailure> {
        let layer = pointer as usize as *mut c_void;
        if layer.is_null() {
            return Err(GpuFailure::client("no CAMetalLayer"));
        }
        #[cfg(any(target_os = "ios", target_os = "macos"))]
        {
            // SAFETY: the app passes a live `CAMetalLayer`, an Objective-C object CoreFoundation retains.
            unsafe { CFRetain(layer) };
            Ok(Arc::new(GpuSurface {
                native: Native::Layer(layer),
            }))
        }
        #[cfg(not(any(target_os = "ios", target_os = "macos")))]
        Err(GpuFailure::client(
            "a CAMetalLayer exists only on Apple platforms",
        ))
    }

    /// An `ANativeWindow` with one reference the surface takes over (`PsychoScriptGpu.surface(surface)` makes it
    /// from a `Surface`), released when the surface is dropped. Fails off Android.
    #[uniffi::constructor]
    pub fn android_window(pointer: u64) -> Result<Arc<GpuSurface>, GpuFailure> {
        let window = pointer as usize as *mut c_void;
        if window.is_null() {
            return Err(GpuFailure::client("no ANativeWindow"));
        }
        #[cfg(target_os = "android")]
        {
            Ok(Arc::new(GpuSurface {
                native: Native::Window(window),
            }))
        }
        #[cfg(not(target_os = "android"))]
        Err(GpuFailure::client(
            "an ANativeWindow exists only on Android",
        ))
    }
}

impl GpuSurface {
    /// What wgpu makes a surface from. The surface must not outlive `self`.
    #[cfg(feature = "gpu")]
    pub(crate) fn target(&self) -> wgpu::SurfaceTargetUnsafe {
        match self.native {
            #[cfg(any(target_os = "ios", target_os = "macos"))]
            Native::Layer(layer) => wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer),
            #[cfg(not(any(target_os = "ios", target_os = "macos")))]
            Native::Layer(_) => unreachable!("a CAMetalLayer exists only on Apple platforms"),
            Native::Window(window) => {
                use wgpu::rwh::{
                    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
                };
                let window = std::ptr::NonNull::new(window).expect("a window");
                wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: Some(
                        RawDisplayHandle::Android(AndroidDisplayHandle::new()),
                    ),
                    raw_window_handle: RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(
                        window,
                    )),
                }
            }
        }
    }

    /// The `CAMetalLayer`, for its settings wgpu leaves.
    #[cfg_attr(
        not(all(feature = "gpu", any(target_os = "ios", target_os = "macos"))),
        allow(dead_code)
    )]
    pub(crate) fn layer(&self) -> Option<*mut c_void> {
        match self.native {
            Native::Layer(layer) => Some(layer),
            Native::Window(_) => None,
        }
    }
}

impl Drop for GpuSurface {
    fn drop(&mut self) {
        match self.native {
            #[cfg(any(target_os = "ios", target_os = "macos"))]
            // SAFETY: retained in `metal_layer`.
            Native::Layer(layer) => unsafe { CFRelease(layer) },
            #[cfg(target_os = "android")]
            // SAFETY: the reference `ANativeWindow_fromSurface` acquired.
            Native::Window(window) => unsafe { ANativeWindow_release(window) },
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
}

/// `PsychoScriptGpu.nativeWindow(surface)` (Kotlin, `PsychoScriptGpu.kt`): an `ANativeWindow` with one reference, or 0.
///
/// # Safety
///
/// Called by the JVM with its `JNIEnv` and a `android.view.Surface` reference.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_com_anomalyco_psychoscript_PsychoScriptGpu_nativeWindow(
    env: *mut c_void,
    _this: *mut c_void,
    surface: *mut c_void,
) -> i64 {
    if surface.is_null() {
        return 0;
    }
    // SAFETY: the JVM's arguments, as the NDK takes them.
    unsafe { ANativeWindow_fromSurface(env, surface) as i64 }
}
