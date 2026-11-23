//! The `wgsl` shorthand (`widgets.md`, GPU canvases; `widgets-gpu.md`): a canvas's fragment shader, drawn on the
//! app's device by `widget_gpu::Shorthand` and presented into the app's surface, in step and live widgets alike.

use std::sync::{Arc, Mutex, PoisonError};

use super::{GpuFailure, GpuSurface};

/// A `canvas({ wgsl, values })`: make one per canvas and call [`ShaderCanvas::render`] on the app's display link at
/// the canvas's `fps` (pausing as the widget does when it isn't visible). Rendering and presenting happen on the
/// calling thread.
#[derive(uniffi::Object)]
pub struct ShaderCanvas {
    #[cfg_attr(not(feature = "widget-gpu"), allow(dead_code))]
    inner: Mutex<imp::Inner>,
}

impl std::fmt::Debug for ShaderCanvas {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ShaderCanvas")
    }
}

#[uniffi::export]
impl ShaderCanvas {
    /// Compiles the widget template's `wgsl` for `surface`, `width` × `height` physical pixels. Fails with
    /// `Program` for a WGSL error (its line and column the template's; report it, phase `gpu`) and `Client` without
    /// a GPU; either way the canvas shows its placeholder (`poster`, else `alt`, else the error).
    #[uniffi::constructor]
    pub fn new(
        wgsl: String,
        surface: Arc<GpuSurface>,
        width: u32,
        height: u32,
    ) -> Result<Arc<ShaderCanvas>, GpuFailure> {
        Ok(Arc::new(ShaderCanvas {
            inner: Mutex::new(imp::Inner::new(&wgsl, surface, width, height)?),
        }))
    }

    /// The canvas's new size in physical pixels.
    pub fn resize(&self, width: u32, height: u32) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .resize(width, height);
    }

    /// Draws and presents a frame: `time` in seconds since the canvas appeared, `scale` the display scale,
    /// `pointer` `[x, y, down, 0]` in physical pixels, `values` the node's (up to 16). An error stops the canvas for
    /// good: it is returned once (show the placeholder with it; report a `Program` one), later calls do nothing.
    pub fn render(
        &self,
        time: f32,
        scale: f32,
        pointer: Vec<f32>,
        values: Vec<f32>,
    ) -> Result<(), GpuFailure> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .render(time, scale, &pointer, &values)
    }
}

#[cfg(feature = "widget-gpu")]
mod imp {
    use std::sync::Arc;

    use widget_gpu::{Shorthand, Uniforms, clamp_size};

    use super::super::device::{self, Dev};
    use super::super::present::{Attached, Blit, Frame};
    use super::super::{GpuFailure, GpuSurface};

    pub(super) struct Inner {
        dev: Arc<Dev>,
        shorthand: Shorthand,
        attached: Attached,
        blit: Blit,
        size: (u32, u32),
        /// An error stopped it.
        stopped: bool,
    }

    impl Inner {
        pub(super) fn new(
            wgsl: &str,
            surface: Arc<GpuSurface>,
            width: u32,
            height: u32,
        ) -> Result<Inner, GpuFailure> {
            let dev = device::get().map_err(GpuFailure::client)?;
            let submits = device::submits();
            let shorthand = Shorthand::new(dev.device.clone(), dev.queue.clone(), dev.format, wgsl);
            drop(submits);
            let shorthand = shorthand?;
            Ok(Inner {
                dev,
                shorthand,
                attached: Attached::new(surface, width, height),
                blit: Blit::default(),
                size: (width.max(1), height.max(1)),
                stopped: false,
            })
        }

        pub(super) fn resize(&mut self, width: u32, height: u32) {
            self.size = (width.max(1), height.max(1));
            self.attached.resize(width, height);
        }

        pub(super) fn render(
            &mut self,
            time: f32,
            scale: f32,
            pointer: &[f32],
            values: &[f32],
        ) -> Result<(), GpuFailure> {
            if self.stopped {
                return Ok(());
            }
            // After a device loss, the same shader on the new device; no frames until there is one.
            let Some(dev) = device::current() else {
                return Ok(());
            };
            if dev.generation != self.dev.generation {
                self.dev = dev.clone();
                let submits = device::submits();
                let reset = self.shorthand.reset(dev.device.clone(), dev.queue.clone());
                drop(submits);
                self.stop_on(reset)?;
            }
            let mut u = Uniforms {
                time,
                scale,
                ..Default::default()
            };
            for (to, from) in u.pointer.iter_mut().zip(pointer) {
                *to = *from;
            }
            for (to, from) in u.values.iter_mut().zip(values) {
                *to = *from;
            }
            let (w, h) = clamp_size(self.size.0, self.size.1);
            let submits = device::submits();
            let drawn = self.shorthand.render(w, h, &u);
            drop(submits);
            self.stop_on(drawn)?;
            let Some(c) = self.shorthand.canvas() else {
                return Ok(());
            };
            let frame = Frame {
                texture: c.texture.clone(),
                alpha: c.alpha,
                dev: self.dev.clone(),
            };
            self.attached
                .present(&frame, &mut self.blit)
                .map(|_| ())
                .map_err(GpuFailure::client)
        }

        fn stop_on(&mut self, r: Result<(), widget_gpu::GpuError>) -> Result<(), GpuFailure> {
            r.map_err(|e| {
                self.stopped = true;
                e.into()
            })
        }
    }
}

#[cfg(not(feature = "widget-gpu"))]
mod imp {
    use std::sync::Arc;

    use super::super::{GpuFailure, GpuSurface};

    pub(super) struct Inner;

    const OFF: &str = "this build has no GPU canvases";

    impl Inner {
        pub(super) fn new(
            _: &str,
            _: Arc<GpuSurface>,
            _: u32,
            _: u32,
        ) -> Result<Inner, GpuFailure> {
            Err(GpuFailure::client(OFF))
        }
        pub(super) fn resize(&mut self, _: u32, _: u32) {}
        pub(super) fn render(
            &mut self,
            _: f32,
            _: f32,
            _: &[f32],
            _: &[f32],
        ) -> Result<(), GpuFailure> {
            Err(GpuFailure::client(OFF))
        }
    }
}
