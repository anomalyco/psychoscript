//! A live widget's frame message without JSON, for Android, where every UniFFI call goes through JNA (a handle
//! clone, a string lowered into a Rust buffer, a call status, each a JNA call: 0.3 ms a frame on a Pixel's little
//! cores). `LiveFrames` (Kotlin, written by `build-android.sh`) holds a reference of its own to the run, taken once,
//! and delivers each frame through one JNI call with its fields as numbers: the same message
//! `{ type: "frame", frame: { t, dt, width, height, scale, pointer, dark, fullscreen, close } }` an app's JSON makes
//! (`widgets-live.md`), queued as [`crate::LiveRun::deliver`] queues it.

use psychoscript::{HostString, HostValue};

/// A frame's fields, as the app's frame message gives them.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Frame {
    pub t: f64,
    pub dt: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    /// `{ x, y, down }`.
    pub pointer: Option<(f64, f64, bool)>,
    pub dark: bool,
    pub fullscreen: bool,
    /// `{ x, y, width, height }`.
    pub close: Option<(f64, f64, f64, f64)>,
}

/// The message `Input::parse` makes of the app's JSON for `frame`, its fields in the same order.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn message(f: &Frame) -> HostValue {
    let n = HostValue::Number;
    let field = |k: &str, v: HostValue| (HostString::from(k), v);
    let pointer = match f.pointer {
        Some((x, y, down)) => HostValue::Object(vec![
            field("x", n(x)),
            field("y", n(y)),
            field("down", HostValue::Bool(down)),
        ]),
        None => HostValue::Null,
    };
    let close = match f.close {
        Some((x, y, w, h)) => HostValue::Object(vec![
            field("x", n(x)),
            field("y", n(y)),
            field("width", n(w)),
            field("height", n(h)),
        ]),
        None => HostValue::Null,
    };
    HostValue::Object(vec![
        field("type", HostValue::String("frame".into())),
        field(
            "frame",
            HostValue::Object(vec![
                field("t", n(f.t)),
                field("dt", n(f.dt)),
                field("width", n(f.width)),
                field("height", n(f.height)),
                field("scale", n(f.scale)),
                field("pointer", pointer),
                field("dark", HostValue::Bool(f.dark)),
                field("fullscreen", HostValue::Bool(f.fullscreen)),
                field("close", close),
            ]),
        ),
    ])
}

#[cfg(target_os = "android")]
mod jni {
    use std::ffi::c_void;
    use std::sync::Arc;

    use super::Frame;
    use crate::LiveRun;

    /// `LiveFrames.adopt(handle)`: takes over a UniFFI handle of a [`LiveRun`] (a clone the caller made, as UniFFI
    /// hands a method its object), so the frames hold the run until [`free`]. 0 for no handle.
    ///
    /// # Safety
    ///
    /// `handle` is a clone of a `LiveRun`'s UniFFI handle, given up by the caller.
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_anomalyco_psychoscript_LiveFrames_adopt(
        _env: *mut c_void,
        _class: *mut c_void,
        handle: i64,
    ) -> i64 {
        // SAFETY: a handle UniFFI made for a `LiveRun` and cloned for this call, which this takes over.
        let Some(handle) = (unsafe { uniffi::Handle::from_raw(handle as u64) }) else {
            return 0;
        };
        match <Arc<LiveRun> as uniffi::Lift<crate::UniFfiTag>>::try_lift(handle) {
            Ok(run) => Arc::into_raw(run) as i64,
            Err(_) => 0,
        }
    }

    /// `LiveFrames.deliver(...)`: queues the frame for the run, as `LiveRun.deliver(json)` would; 0, or 1 once the run
    /// ended (`InvalidState`).
    ///
    /// # Safety
    ///
    /// `run` is what [`Java_com_anomalyco_psychoscript_LiveFrames_adopt`] returned, not freed yet.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_anomalyco_psychoscript_LiveFrames_send(
        _env: *mut c_void,
        _class: *mut c_void,
        run: i64,
        t: f64,
        dt: f64,
        width: f64,
        height: f64,
        scale: f64,
        pointer: u8,
        pointer_x: f64,
        pointer_y: f64,
        pointer_down: u8,
        dark: u8,
        fullscreen: u8,
        close: u8,
        close_x: f64,
        close_y: f64,
        close_width: f64,
        close_height: f64,
    ) -> i32 {
        // SAFETY: the run `adopt` holds a reference to, borrowed for this call.
        let run = unsafe { &*(run as *const LiveRun) };
        let frame = Frame {
            t,
            dt,
            width,
            height,
            scale,
            pointer: (pointer != 0).then_some((pointer_x, pointer_y, pointer_down != 0)),
            dark: dark != 0,
            fullscreen: fullscreen != 0,
            close: (close != 0).then_some((close_x, close_y, close_width, close_height)),
        };
        match run.deliver_value(super::message(&frame)) {
            Ok(()) => 0,
            Err(_) => 1,
        }
    }

    /// `LiveFrames.close()`: lets go of the run [`Java_com_anomalyco_psychoscript_LiveFrames_adopt`] held.
    ///
    /// # Safety
    ///
    /// `run` is what `adopt` returned, freed once.
    #[unsafe(no_mangle)]
    pub unsafe extern "system" fn Java_com_anomalyco_psychoscript_LiveFrames_free(
        _env: *mut c_void,
        _class: *mut c_void,
        run: i64,
    ) {
        if run != 0 {
            // SAFETY: the reference `adopt` took, given back once.
            drop(unsafe { Arc::from_raw(run as *const LiveRun) });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::Input;

    /// The message is the one the app's JSON makes: every field, in order, with a pointer and the close area, and
    /// without (`HostValue`'s debug form shows each number exactly).
    #[test]
    fn a_frame_is_the_message_its_json_makes() {
        let full = Frame {
            t: 12.345678901,
            dt: 0.016667,
            width: 347.5,
            height: 460.0,
            scale: 2.625,
            pointer: Some((10.25, 200.0, true)),
            dark: true,
            fullscreen: false,
            close: Some((300.0, 8.5, 44.0, 44.0)),
        };
        let json = r#"{"type":"frame","frame":{"t":12.345678901,"dt":0.016667,"width":347.5,"height":460.0,"scale":2.625,"pointer":{"x":10.25,"y":200.0,"down":true},"dark":true,"fullscreen":false,"close":{"x":300.0,"y":8.5,"width":44.0,"height":44.0}}}"#;
        let same = |v: HostValue, json: &str| {
            assert_eq!(
                format!("{v:?}"),
                format!("{:?}", Input::parse(json).unwrap())
            )
        };
        same(message(&full), json);
        let bare = Frame {
            t: 0.0,
            dt: 0.0,
            width: 912.0,
            height: 1208.0,
            scale: 2.625,
            ..Frame::default()
        };
        let json = r#"{"type":"frame","frame":{"t":0.0,"dt":0.0,"width":912.0,"height":1208.0,"scale":2.625,"pointer":null,"dark":false,"fullscreen":false,"close":null}}"#;
        same(message(&bare), json);
    }

    struct Posts(std::sync::Mutex<std::sync::mpsc::Sender<String>>);

    impl crate::LiveHandler for Posts {
        fn on_posts(&self, messages_json: Vec<String>) {
            let tx = self.0.lock().unwrap();
            for m in messages_json {
                let _ = tx.send(m);
            }
        }
        fn on_posts_bytes(&self, _messages: Vec<Vec<u8>>) {}
        fn on_warning(&self, _message: String) {}
        fn on_exit(&self, _exit: crate::LiveExit) {}
        fn on_gpu_canvas(&self, _key: Option<String>, _state: crate::GpuCanvasState) {}
    }

    /// A frame delivered without JSON reaches the program as its JSON would, in order with the messages delivered as
    /// JSON around it.
    #[test]
    fn a_frame_is_queued_in_order_with_json_messages() {
        let program = crate::Program::new(
            "for (;;) __host.post(await __host.receive())".into(),
            "__input".into(),
        )
        .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let run = program
            .start_live(
                "null".into(),
                Box::new(Posts(std::sync::Mutex::new(tx))),
                crate::LiveOptions::default(),
                None,
                None,
            )
            .unwrap();
        let frame = Frame {
            t: 1.5,
            dt: 0.016667,
            width: 347.5,
            height: 460.0,
            scale: 2.625,
            pointer: Some((10.25, 200.0, true)),
            dark: true,
            fullscreen: false,
            close: None,
        };
        let json = r#"{"type":"frame","frame":{"t":1.5,"dt":0.016667,"width":347.5,"height":460,"scale":2.625,"pointer":{"x":10.25,"y":200,"down":true},"dark":true,"fullscreen":false,"close":null}}"#;
        run.deliver(r#"{"type":"event","n":1}"#.into()).unwrap();
        run.deliver_value(message(&frame)).unwrap();
        run.deliver(r#"{"type":"event","n":2}"#.into()).unwrap();
        run.deliver(json.into()).unwrap();
        let next = || rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(next(), r#"{"type":"event","n":1}"#);
        let by_value = next();
        assert_eq!(next(), r#"{"type":"event","n":2}"#);
        assert_eq!(by_value, next());
        // Once the run ended, as `deliver`: `InvalidState`.
        run.stop();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while run.deliver_value(message(&frame)).is_ok() {
            assert!(std::time::Instant::now() < until, "the run never ended");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(matches!(
            (run.deliver_value(message(&frame)), run.deliver(json.into())),
            (
                Err(crate::PsychoScriptError::InvalidState { .. }),
                Err(crate::PsychoScriptError::InvalidState { .. })
            )
        ));
    }
}
