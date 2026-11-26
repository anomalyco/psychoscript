//! A live run's GPU (`LiveGpu`) end to end, through a test encoder (`gpu_support`): plain programs post GPU batches
//! that replay on this machine's shared device (Metal on macOS, Vulkan elsewhere), headless and into real surfaces
//! (a `CAMetalLayer` on macOS, an `AImageReader`'s window on Android, whose presented pixels are read back). A device
//! loss is `gpu_loss.rs`'s, a device that can't be made `gpu_unavailable.rs`'s, each in a process of its own.

#![cfg(feature = "gpu")]

mod gpu_support;

use std::time::{Duration, Instant};

use gpu_support::*;
use psychoscript_mobile::{
    GpuCanvasState, GpuErrorKind, LiveExit, LiveOptions, ProgramLines, gpu_device,
};
use serde_json::{Value, json};

#[test]
fn the_live_input_tells_the_program_its_gpu() {
    let mut r = start(
        &hand_made("post({ send: gpu })\nawait next()"),
        json!({}),
        Vec::new(),
    );
    assert_eq!(
        r.sent(),
        json!({ "available": true, "format": platform_format() })
    );
    // Made off the run's thread: the input didn't wait for it.
    let until = Instant::now() + WAIT;
    let d = loop {
        if let Some(d) = gpu_device() {
            break d;
        }
        assert!(Instant::now() < until, "no device in time");
        std::thread::sleep(Duration::from_millis(1));
    };
    eprintln!(
        "device: {} ({}), made in {:.1} ms",
        d.adapter, d.backend, d.made_ms
    );
    r.run.stop();
}

#[test]
fn the_cube_draws_headless() {
    let mut r = start_cube();
    // As an app would on attaching a surface: the canvas's size first.
    r.run.deliver(canvas("cube", 600, 480)).unwrap();
    r.frames(4);
    r.frame_request();
    r.live("cube");
    let (w, h, p) = r.run.gpu_pixels("cube").expect("an image");
    assert_eq!((w, h), (600, 480));
    assert_cube(w, h, &p);
    assert_eq!(
        r.gpu_events(),
        [(Some("cube".into()), GpuCanvasState::Live { opaque: true })]
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

/// Each batch of the wrong shape, with its message: one whose ops are a list stops the canvases they draw, else every
/// canvas; the run goes on.
#[test]
fn a_batch_of_the_wrong_shape_stops_the_canvases_and_the_run_goes_on() {
    let into_c = r#"{ ops: [["context", 1, "c", gpu.format, "opaque"], view(2, 1), clear(2, [0, 0, 0, 1]), ["end"]],
  bytes: new Uint8Array(8) }"#;
    let cases = [
        ("5", "a batch must be an object", None),
        (
            "{ ops: \"buffer\", bytes: none }",
            "a batch's ops must be a list",
            None,
        ),
        (
            "{ ops: [], bytes: [1, 2] }",
            "a batch's bytes must be an ArrayBuffer",
            None,
        ),
        (into_c, "a batch's bytes must be an ArrayBuffer", Some("c")),
    ];
    for (batch, message, key) in cases {
        let source = format!(
            "post({{ canvases: [\"c\"] }})\npost({{ frame: true, gpu: {batch} }})\nawait next()\npost({{ send: \"on\" }})"
        );
        let mut r = start(&hand_made(&source), json!({}), Vec::new());
        r.run.deliver(canvas("c", 8, 8)).unwrap();
        let stopped = r.wait(|e| match e {
            Event::Gpu(k, s @ GpuCanvasState::Stopped { .. }) => Some((k.clone(), s.clone())),
            _ => None,
        });
        assert_eq!(
            stopped,
            (
                key.map(str::to_owned),
                GpuCanvasState::Stopped {
                    kind: GpuErrorKind::Program,
                    message: message.into(),
                    report: true,
                    line: Some(16),
                    column: Some(1),
                }
            ),
            "{batch}"
        );
        r.run.deliver(frame(0)).unwrap();
        assert_eq!(r.sent(), "on");
        assert!(matches!(r.exit(), LiveExit::Finished { .. }));
    }
}

/// `Live` says whether the canvas is opaque, from its context's `alphaMode`: once as it goes live, again only when a
/// reconfigure changes it, never per frame. (Each reconfigure is in the batch of the frame it draws first.)
#[test]
fn live_says_whether_the_canvas_is_opaque() {
    let source = r#"post({ canvases: ["c"] })
let handle = 1
const draw = async (alpha, frames) => {
  const c = handle
  handle += 2
  const configure = [["context", c, "c", gpu.format, alpha], view(c + 1, c)]
  for (let i = 0; i < frames; i++) {
    const ops = [...(i === 0 ? configure : []), clear(c + 1, [0, 0, 0.5, 0.5]), ["end"], ["submit"]]
    post({ frame: true, gpu: { ops, bytes: none } })
    while ((await next()).type !== "frame") {}
  }
}
await draw("premultiplied", 3)
await draw("premultiplied", 3)
await draw("opaque", 3)
for (;;) await next()
"#;
    let mut r = start(&hand_made(source), json!({}), Vec::new());
    r.run.deliver(canvas("c", 8, 8)).unwrap();
    // Nine frames drawn (what the program posts while the device is made replays once it is there).
    r.frames(9);
    r.wait(|e| matches!(e, Event::Gpu(_, GpuCanvasState::Live { opaque: true })).then_some(()));
    r.seen.push(Event::Gpu(
        Some("c".into()),
        GpuCanvasState::Live { opaque: true },
    ));
    r.settle();
    let lives: Vec<_> = (r.gpu_events().into_iter())
        .filter(|(_, s)| matches!(s, GpuCanvasState::Live { .. }))
        .collect();
    assert_eq!(
        lives,
        [
            (Some("c".into()), GpuCanvasState::Live { opaque: false }),
            (Some("c".into()), GpuCanvasState::Live { opaque: true })
        ]
    );
    r.run.stop();
}

#[test]
fn frames_replay_on_the_device() {
    let mut r = start(&hand_made(RED), json!({}), Vec::new());
    r.run.deliver(canvas("c", 64, 32)).unwrap();
    r.frames(3);
    r.frame_request();
    r.live("c");
    let (w, h, p) = r.run.gpu_pixels("c").unwrap();
    assert_eq!((w, h), (64, 32));
    assert!(p.chunks(4).all(|px| px == [255, 0, 0, 255]));
    r.run.stop();
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
#[test]
fn the_cube_presents_into_a_real_surface() {
    let surface = real::surface(600, 480);
    let mut r = start_cube();
    // Attaching gives the program the canvas's size.
    r.run
        .attach_surface("cube".into(), surface.surface.clone(), 600, 480);
    // As a display link would: a frame each 1/120 s.
    for i in 0..30 {
        r.frame_request();
        std::thread::sleep(Duration::from_millis(8));
        r.run.deliver(frame(i)).unwrap();
    }
    r.presents(1);
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
    r.settle();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(r.run.gpu_stats().unwrap().presents, before);
    drop(surface);
    r.frames(2);
    r.run.stop();
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
#[test]
fn a_canvas_clamped_to_4096_is_scaled_to_its_surface() {
    let (sw, sh) = (4200, 64);
    let surface = real::surface(sw, sh);
    let mut r = start(&hand_made(RED), json!({}), Vec::new());
    r.run
        .attach_surface("c".into(), surface.surface.clone(), sw, sh);
    r.frames(4);
    r.presents(2);
    let (w, h, _) = r.run.gpu_pixels("c").unwrap();
    assert_eq!((w, h), psychoscript_gpu::clamp_size(sw, sh));
    assert_eq!((w, h), (4096, 62));
    if let Some((w, h, p)) = surface.pixels() {
        assert_eq!((w, h), (sw, sh));
        assert!(p.chunks(4).all(|px| px == [255, 0, 0, 255]));
    }
    r.run.stop();
}

#[test]
fn a_snapshot_keeps_the_stops_and_drops_handles_from_before() {
    let mut r = start(&hand_made(TWO), json!({}), Vec::new());
    for k in ["a", "b"] {
        r.run.deliver(canvas(k, 8, 8)).unwrap();
    }
    r.frames(3);
    r.frame_request();
    r.wait(|e| {
        matches!(e, Event::Gpu(Some(k), GpuCanvasState::Stopped { kind: GpuErrorKind::Program, message, report: true, .. })
            if k == "b" && message == "gpu op 1: no handle 999")
        .then_some(())
    });
    r.live("a");
    r.run.pause().unwrap();
    let snapshot = r.run.snapshot().unwrap();
    r.run.stop();

    // Restored: the program loses its device (it sends the message on), `b` is told stopped again (not to report),
    // the batch naming a handle from before is dropped, and `a` draws again on new handles.
    let mut r = restore(snapshot);
    let stopped = GpuCanvasState::Stopped {
        kind: GpuErrorKind::Program,
        message: "gpu op 1: no handle 999".into(),
        report: false,
        line: None,
        column: None,
    };
    r.wait(|e| matches!(e, Event::Gpu(Some(k), s) if k == "b" && *s == stopped).then_some(()));
    assert_eq!(r.sent(), json!({ "type": "gpu", "lost": "unknown" }));
    for k in ["a", "b"] {
        r.run.deliver(canvas(k, 8, 8)).unwrap();
    }
    for i in 0..4 {
        r.run.deliver(frame(i)).unwrap();
    }
    r.live("a");
    let (_, _, p) = r.run.gpu_pixels("a").unwrap();
    assert!(p.chunks(4).all(|px| px == [255, 0, 0, 255]));
    // Nothing else: `b` stays stopped, no error is reported.
    r.settle();
    let events = r.gpu_events();
    assert!(
        events.iter().all(|(k, s)| match s {
            GpuCanvasState::Live { .. } => k.as_deref() == Some("a"),
            GpuCanvasState::Stopped { report, .. } => !report,
            _ => false,
        }),
        "{events:?}"
    );
    r.run.stop();
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
#[test]
fn a_surface_not_laid_out_gives_the_program_no_size() {
    let source = "for (;;) {\n  const m = await __host.receive()\n  if (m.type === \"canvas\" || m.type === \"ping\") __host.post({ send: m })\n}";
    let mut r = start(&program(source), json!({}), Vec::new());
    let surface = real::surface(8, 8);
    // The sizes the program got: everything delivered before a `ping` it echoes after them.
    let sizes = |r: &mut Run| -> Vec<Value> {
        r.run
            .deliver(json!({ "type": "ping" }).to_string())
            .unwrap();
        let last = r.wait(|e| match e {
            Event::Posts(p) => p
                .iter()
                .any(|p| p["send"]["type"] == "ping")
                .then(|| p.clone()),
            _ => None,
        });
        r.seen.push(Event::Posts(last));
        (r.seen.drain(..))
            .filter_map(|e| match e {
                Event::Posts(p) => Some(p),
                _ => None,
            })
            .flatten()
            .filter_map(|p| (p["send"]["type"] == "canvas").then(|| p["send"].clone()))
            .collect()
    };
    r.run
        .attach_surface("c".into(), surface.surface.clone(), 0, 0);
    assert_eq!(sizes(&mut r), Vec::<Value>::new());
    r.run
        .attach_surface("c".into(), surface.surface.clone(), 8, 0);
    assert_eq!(sizes(&mut r), Vec::<Value>::new());
    r.run
        .attach_surface("c".into(), surface.surface.clone(), 8, 6);
    assert_eq!(
        sizes(&mut r),
        [json!({ "type": "canvas", "key": "c", "width": 8, "height": 6 })]
    );
    // Not laid out again, then the same size: nothing new.
    r.run
        .attach_surface("c".into(), surface.surface.clone(), 0, 0);
    r.run
        .attach_surface("c".into(), surface.surface.clone(), 8, 6);
    assert_eq!(sizes(&mut r), Vec::<Value>::new());
    // A size over 4096 a side is clamped, its aspect kept.
    r.run
        .attach_surface("c".into(), surface.surface.clone(), 8192, 100);
    assert_eq!(
        sizes(&mut r),
        [json!({ "type": "canvas", "key": "c", "width": 4096, "height": 50 })]
    );
    r.run.stop();
}

/// With `program_lines`, a batch's error is at the program's line that posted it, not at the host's code that posts.
#[test]
fn a_batch_error_is_at_the_programs_post() {
    // Lines 1 to 15 are the host's (`COMMON`, and `frame` posting), 16 to 18 the program's.
    let source = "const frame = (gpu) => post({ frame: true, gpu })\npost({ canvases: [\"c\"] })\n  frame(\"x\")\nawait next()";
    let options = LiveOptions {
        slice_budget_ms: 60_000,
        program_lines: Some(ProgramLines {
            first: 16,
            last: 18,
        }),
        ..Default::default()
    };
    let mut r = start_with(&hand_made(source), json!({}), Vec::new(), options);
    r.run.deliver(canvas("c", 8, 8)).unwrap();
    let stopped = r.wait(|e| match e {
        Event::Gpu(_, s @ GpuCanvasState::Stopped { .. }) => Some(s.clone()),
        _ => None,
    });
    assert_eq!(
        stopped,
        GpuCanvasState::Stopped {
            kind: GpuErrorKind::Program,
            message: "a batch must be an object".into(),
            report: true,
            line: Some(17),
            column: Some(3),
        }
    );
    r.run.stop();
}
