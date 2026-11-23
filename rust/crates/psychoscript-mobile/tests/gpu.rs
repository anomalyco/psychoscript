//! GPU canvases end to end (`widgets-gpu.md`): live widget programs replay their batches on this machine's device
//! (Metal on macOS, Vulkan elsewhere: lavapipe on a machine without a GPU, the Android emulator's), headless and into
//! real surfaces (a `CAMetalLayer` on macOS, an `AImageReader`'s window on Android, whose presented pixels are read
//! back). A device loss is `gpu_loss.rs`'s, in a process of its own.

#![cfg(feature = "widget-gpu")]

mod gpu_support;

#[cfg(any(target_os = "macos", target_os = "android"))]
use std::time::{Duration, Instant};

use gpu_support::*;
#[cfg(any(target_os = "macos", target_os = "android"))]
use psychoscript_mobile::LiveRun;
use psychoscript_mobile::{GpuCanvasState, GpuErrorKind, Program, gpu_device};
use serde_json::json;
use widget_wire::Post;

#[test]
fn the_live_input_tells_the_program_its_gpu() {
    let p = Program::new(
        "const __widget_protocol = 2\nconst { gpu } = __input()\n__host.post({ type: \"send\", value: gpu })\nawait __host.receive()".into(),
        "__input".into(),
    )
    .unwrap();
    let mut r = start(&p, json!(null));
    let gpu = r.wait(|e| match e {
        Event::Posts(p) => p.iter().find_map(|p| match p {
            Post::Send { value, .. } => Some(value.clone()),
            _ => None,
        }),
        _ => None,
    });
    let format = if cfg!(any(target_os = "macos", target_os = "ios")) {
        "bgra8unorm"
    } else {
        "rgba8unorm"
    };
    assert_eq!(gpu, json!({ "available": true, "format": format }));
    // Made off the run's thread: the input didn't wait for it.
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let d = loop {
        if let Some(d) = gpu_device() {
            break d;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    eprintln!(
        "device: {} ({}), made in {:.1} ms",
        d.adapter, d.backend, d.made_ms
    );
    r.run.stop();
}

#[test]
fn the_cube_draws_headless() {
    let mut r = start(&live_program(&cube_source()), json!({}));
    // As an app would on attaching a surface: the canvas's size first.
    r.run
        .deliver(
            json!({ "type": "canvas", "key": "cube", "width": 600, "height": 480 }).to_string(),
        )
        .unwrap();
    r.frames(4);
    r.frame_request();
    r.live("cube");
    let (w, h, p) = r.run.gpu_pixels("cube").expect("an image");
    assert_eq!((w, h), (600, 480));
    assert_cube(w, h, &p);
    assert_eq!(
        r.gpu_events(),
        [(Some("cube".into()), GpuCanvasState::Live)]
    );
    // No batch reached the app.
    let posts: Vec<&Post> = r
        .seen
        .iter()
        .filter_map(|e| match e {
            Event::Posts(p) => Some(p),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(
        posts
            .iter()
            .all(|p| !matches!(p, Post::Gpu(_) | Post::FrameGpu(_)))
    );
    let s = r.run.gpu_stats().unwrap();
    eprintln!(
        "cube: {} batches, replay {:.0} µs a batch (max {:.0})",
        s.batches,
        s.replay_us / s.batches as f64,
        s.replay_max_us
    );
    r.run.stop();
}

#[test]
fn a_batch_of_the_wrong_shape_stops_the_canvases_and_the_run_goes_on() {
    let source = r#"
async function main() {
  widget.render(ui.canvas({ key: "c", gpu: true, height: 10 }))
  __host.post({ type: "frame", gpu: { ops: [], bytes: [1, 2] } })
  await widget.frame()
  __host.post({ type: "submit", value: "on" })
}"#;
    let mut r = start(&live_program(source), json!({}));
    let stopped = r.wait(|e| match e {
        Event::Gpu(k, s @ GpuCanvasState::Stopped { .. }) => Some((k.clone(), s.clone())),
        _ => None,
    });
    assert_eq!(
        stopped,
        (
            None,
            GpuCanvasState::Stopped {
                kind: GpuErrorKind::Program,
                message: "a batch's bytes must be an ArrayBuffer".into(),
                report: true
            }
        )
    );
    r.run.deliver(frame(0)).unwrap();
    r.wait(|e| match e {
        Event::Posts(p) if p.iter().any(|p| matches!(p, Post::Submit(v) if v == "on")) => Some(()),
        _ => None,
    });
}

#[test]
fn frames_replay_on_the_device() {
    let mut r = start(&live_program(RED), json!({}));
    r.run
        .deliver(json!({ "type": "canvas", "key": "c", "width": 64, "height": 32 }).to_string())
        .unwrap();
    r.frames(3);
    r.frame_request();
    r.live("c");
    let (w, h, p) = r.run.gpu_pixels("c").unwrap();
    assert_eq!((w, h), (64, 32));
    assert!(p.chunks(4).all(|px| px == [255, 0, 0, 255]));
    r.run.stop();
}

/// A real surface for `w` × `h`: a `CAMetalLayer` on macOS, an `AImageReader`'s window on Android.
#[cfg(any(target_os = "macos", target_os = "android"))]
mod real {
    use std::ffi::c_void;
    use std::sync::Arc;

    use psychoscript_mobile::GpuSurface;

    #[cfg(target_os = "macos")]
    pub struct Surface {
        pub surface: Arc<GpuSurface>,
    }

    #[cfg(target_os = "macos")]
    pub fn surface(_w: u32, _h: u32) -> Surface {
        use std::ffi::c_char;
        #[link(name = "QuartzCore", kind = "framework")]
        unsafe extern "C" {}
        #[link(name = "objc")]
        unsafe extern "C" {
            fn objc_getClass(name: *const c_char) -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *const c_void;
            fn objc_msgSend();
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFRelease(cf: *const c_void);
        }
        // SAFETY: `[CAMetalLayer new]`, a +1 reference the surface retains again.
        unsafe {
            let send: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let layer = send(
                objc_getClass(c"CAMetalLayer".as_ptr()),
                sel_registerName(c"new".as_ptr()),
            );
            let surface = GpuSurface::metal_layer(layer as u64).unwrap();
            CFRelease(layer);
            Surface { surface }
        }
    }

    #[cfg(target_os = "macos")]
    impl Surface {
        /// A presented image can't be read back from a `CAMetalLayer`.
        pub fn pixels(&self) -> Option<(u32, u32, Vec<u8>)> {
            None
        }
    }

    #[cfg(target_os = "android")]
    pub struct Surface {
        pub surface: Arc<GpuSurface>,
        reader: *mut c_void,
    }

    #[cfg(target_os = "android")]
    #[link(name = "mediandk")]
    unsafe extern "C" {
        fn AImageReader_newWithUsage(
            width: i32,
            height: i32,
            format: i32,
            usage: u64,
            max_images: i32,
            reader: *mut *mut c_void,
        ) -> i32;
        fn AImageReader_getWindow(reader: *mut c_void, window: *mut *mut c_void) -> i32;
        fn AImageReader_acquireLatestImage(reader: *mut c_void, image: *mut *mut c_void) -> i32;
        fn AImageReader_delete(reader: *mut c_void);
        fn AImage_getPlaneData(
            image: *mut c_void,
            plane: i32,
            data: *mut *mut u8,
            len: *mut i32,
        ) -> i32;
        fn AImage_getPlaneRowStride(image: *mut c_void, plane: i32, stride: *mut i32) -> i32;
        fn AImage_getWidth(image: *mut c_void, width: *mut i32) -> i32;
        fn AImage_getHeight(image: *mut c_void, height: *mut i32) -> i32;
        fn AImage_delete(image: *mut c_void);
    }

    #[cfg(target_os = "android")]
    #[link(name = "android")]
    unsafe extern "C" {
        fn ANativeWindow_acquire(window: *mut c_void);
    }

    #[cfg(target_os = "android")]
    pub fn surface(w: u32, h: u32) -> Surface {
        // RGBA_8888, read by the CPU.
        const RGBA: i32 = 1;
        const CPU_READ_OFTEN: u64 = 3;
        // SAFETY: the NDK's calls with valid out pointers; the window gets a reference of the surface's own.
        unsafe {
            let mut reader = std::ptr::null_mut();
            assert_eq!(
                AImageReader_newWithUsage(w as i32, h as i32, RGBA, CPU_READ_OFTEN, 4, &mut reader),
                0
            );
            let mut window = std::ptr::null_mut();
            assert_eq!(AImageReader_getWindow(reader, &mut window), 0);
            ANativeWindow_acquire(window);
            let surface = GpuSurface::android_window(window as u64).unwrap();
            Surface { surface, reader }
        }
    }

    #[cfg(target_os = "android")]
    impl Surface {
        /// The image last presented into the window, as RGBA8.
        pub fn pixels(&self) -> Option<(u32, u32, Vec<u8>)> {
            // SAFETY: as above.
            unsafe {
                let mut image = std::ptr::null_mut();
                for _ in 0..200 {
                    if AImageReader_acquireLatestImage(self.reader, &mut image) == 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                if image.is_null() {
                    return None;
                }
                let (mut w, mut h, mut stride, mut len) = (0, 0, 0, 0);
                let mut data = std::ptr::null_mut();
                AImage_getWidth(image, &mut w);
                AImage_getHeight(image, &mut h);
                AImage_getPlaneRowStride(image, 0, &mut stride);
                AImage_getPlaneData(image, 0, &mut data, &mut len);
                let bytes = std::slice::from_raw_parts(data, len as usize);
                let mut out = Vec::with_capacity((w * h * 4) as usize);
                for y in 0..h as usize {
                    out.extend_from_slice(&bytes[y * stride as usize..][..w as usize * 4]);
                }
                AImage_delete(image);
                Some((w as u32, h as u32, out))
            }
        }
    }

    #[cfg(target_os = "android")]
    impl Drop for Surface {
        fn drop(&mut self) {
            // SAFETY: made in `surface`; the window it gave has a reference of its own until the surface drops.
            unsafe { AImageReader_delete(self.reader) };
        }
    }
}

/// Waits until the run has presented at least `n` images and then nothing more for 200 ms (the newest one is shown:
/// presents beyond the surface's rate are skipped).
#[cfg(any(target_os = "macos", target_os = "android"))]
fn presents(run: &LiveRun, n: u64) {
    let until = Instant::now() + Duration::from_secs(10);
    let mut last = (0, Instant::now());
    loop {
        let now = run.gpu_stats().unwrap().presents;
        if now != last.0 {
            last = (now, Instant::now());
        } else if now >= n && last.1.elapsed() > Duration::from_millis(200) {
            return;
        }
        assert!(Instant::now() < until, "{:?}", run.gpu_stats());
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(any(target_os = "macos", target_os = "android"))]
#[test]
fn the_cube_presents_into_a_real_surface() {
    let surface = real::surface(600, 480);
    let mut r = start(&live_program(&cube_source()), json!({}));
    // Attaching gives the program the canvas's size.
    r.run
        .attach_surface("cube".into(), surface.surface.clone(), 600, 480);
    // As a display link would: a frame each 1/120 s.
    for i in 0..30 {
        r.frame_request();
        std::thread::sleep(Duration::from_millis(8));
        r.run.deliver(frame(i)).unwrap();
    }
    presents(&r.run, 1);
    let (w, h, p) = r.run.gpu_pixels("cube").unwrap();
    assert_eq!((w, h), (600, 480));
    assert_cube(w, h, &p);
    if let Some((w, h, p)) = surface.pixels() {
        assert_eq!((w, h), (600, 480));
        assert_cube(w, h, &p);
        eprintln!("the presented image is the cube");
    }
    let s = r.run.gpu_stats().unwrap();
    eprintln!(
        "cube into a surface: {} batches, replay {:.0} µs a frame after the first (that one {:.0}, its pipelines); {} presents, {:.0} µs each (max {:.0})",
        s.batches,
        (s.replay_us - s.replay_max_us) / (s.batches - 1) as f64,
        s.replay_max_us,
        s.presents,
        s.present_us / s.presents as f64,
        s.present_max_us
    );
    // Detached, it is never presented to again: the run goes on.
    r.run.detach_surface("cube".into());
    let before = r.run.gpu_stats().unwrap().presents;
    r.frames(5);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(r.run.gpu_stats().unwrap().presents, before);
    drop(surface);
    r.frames(2);
    r.run.stop();
}

#[cfg(any(target_os = "macos", target_os = "android"))]
#[test]
fn a_canvas_clamped_to_4096_is_scaled_to_its_surface() {
    let (sw, sh) = (4200, 64);
    let surface = real::surface(sw, sh);
    let mut r = start(&live_program(RED), json!({}));
    r.run
        .attach_surface("c".into(), surface.surface.clone(), sw, sh);
    r.frames(4);
    presents(&r.run, 2);
    let (w, h, _) = r.run.gpu_pixels("c").unwrap();
    assert_eq!((w, h), widget_gpu::clamp_size(sw, sh));
    if let Some((w, h, p)) = surface.pixels() {
        assert_eq!((w, h), (sw, sh));
        assert!(p.chunks(4).all(|px| px == [255, 0, 0, 255]));
    }
    r.run.stop();
}

#[cfg(any(target_os = "macos", target_os = "android"))]
#[test]
fn a_shader_canvas_draws_into_a_real_surface() {
    use psychoscript_mobile::{GpuFailure, ShaderCanvas};
    let surface = real::surface(128, 64);
    let wgsl = "fn shade(frag: vec2f) -> vec4f { return vec4f(0.0, frag.x / widget.resolution.x, widget.values[0].x, 1.0); }";
    let started = Instant::now();
    let canvas = ShaderCanvas::new(wgsl.into(), surface.surface.clone(), 128, 64).unwrap();
    let made = started.elapsed();
    let mut values = vec![0.0; 16];
    values[0] = 1.0;
    let mut frames = Vec::new();
    for i in 0..10 {
        let started = Instant::now();
        canvas
            .render(i as f32 / 60.0, 2.0, vec![0.0; 4], values.clone())
            .unwrap();
        frames.push(started.elapsed().as_secs_f64() * 1e6);
    }
    let first = frames.remove(0);
    frames.sort_by(f64::total_cmp);
    eprintln!(
        "shader canvas: made in {:.1} ms, first frame {first:.0} µs, then {:.0} µs a frame (median; a present waits for the surface's next texture)",
        made.as_secs_f64() * 1e3,
        frames[frames.len() / 2]
    );
    if let Some((w, h, p)) = surface.pixels() {
        assert_eq!((w, h), (128, 64));
        let at = |x: usize| &p[x * 4..x * 4 + 4];
        assert_eq!(at(0)[2], 255);
        assert!(
            at(127)[1] > 250 && at(0)[1] < 5,
            "{:?} {:?}",
            at(0),
            at(127)
        );
    }
    // A WGSL error is the program's, its line the template's.
    let bad = ShaderCanvas::new(
        "fn shade(frag: vec2f) -> vec4f {\n  return nope;\n}".into(),
        surface.surface.clone(),
        8,
        8,
    );
    let Err(GpuFailure::Program { message }) = bad else {
        panic!("{bad:?}")
    };
    assert!(message.contains("line 2"), "{message}");
}
