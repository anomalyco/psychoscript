//! The GPU hang rules (`widgets-gpu.md`, GPU hang) without a real hang, in a process of its own: the GPU is made to
//! tell every submission aborted (`gpu_fake_aborts`). Work aborted after 30 ms or more hung: its canvases stop with a
//! client error, told once; under 30 ms it only waited behind another's hang. (Real hangs are `gpu_heavy`'s, run on
//! demand: they make the OS recover the GPU.)

#![cfg(feature = "widget-gpu")]

mod gpu_support;

use std::time::{Duration, Instant};

use gpu_support::*;
use psychoscript_mobile::{GpuCanvasState, GpuErrorKind, gpu_fake_aborts};
use serde_json::json;

fn hang_stops(r: &mut Run) -> Option<GpuCanvasState> {
    let until = Instant::now() + Duration::from_millis(500);
    for i in 0.. {
        while let Ok(e) = r.rx.try_recv() {
            r.seen.push(e);
        }
        if let Some((_, s)) =
            (r.gpu_events().into_iter()).find(|(_, s)| matches!(s, GpuCanvasState::Stopped { .. }))
        {
            return Some(s);
        }
        if Instant::now() > until {
            return None;
        }
        r.run.deliver(frame(i)).unwrap();
        std::thread::sleep(Duration::from_millis(16));
    }
    None
}

#[test]
fn work_aborted_after_30_ms_is_a_hang() {
    // Under 30 ms: work that only waited behind a hang. It draws on.
    gpu_fake_aborts(Some(10));
    let mut r = start(&live_program(RED), json!({}));
    r.run
        .deliver(json!({ "type": "canvas", "key": "c", "width": 16, "height": 16 }).to_string())
        .unwrap();
    r.frames(2);
    r.live("c");
    assert_eq!(hang_stops(&mut r), None);
    r.run.stop();

    // 30 ms or more: it hung, and its canvas stops for the rest of the run, a client error, not reported.
    gpu_fake_aborts(Some(40));
    let mut r = start(&live_program(RED), json!({}));
    r.run
        .deliver(json!({ "type": "canvas", "key": "c", "width": 16, "height": 16 }).to_string())
        .unwrap();
    r.frames(2);
    let stopped = hang_stops(&mut r).expect("no hang told");
    assert_eq!(
        stopped,
        GpuCanvasState::Stopped {
            kind: GpuErrorKind::Client,
            message: widget_gpu::HANG_MESSAGE.into(),
            report: false
        }
    );
    // Told once.
    let _ = hang_stops(&mut r);
    let stops =
        (r.gpu_events().into_iter()).filter(|(_, s)| matches!(s, GpuCanvasState::Stopped { .. }));
    assert_eq!(stops.count(), 1, "{:?}", r.gpu_events());
    r.run.stop();

    // A `wgsl` canvas: `render` returns it once.
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
    {
        use psychoscript_mobile::{GpuFailure, ShaderCanvas};
        let surface = real::surface(64, 64);
        let canvas = ShaderCanvas::new(
            "fn shade(frag: vec2f) -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }".into(),
            surface.surface.clone(),
            64,
            64,
        );
        let until = Instant::now() + Duration::from_secs(30);
        let why = loop {
            match canvas.render(0.0, 1.0, vec![], vec![]) {
                Ok(()) => {}
                Err(GpuFailure::Client { reason }) => break reason,
                Err(e) => panic!("{e:?}"),
            }
            assert!(Instant::now() < until, "no hang told");
            std::thread::sleep(Duration::from_millis(16));
        };
        assert_eq!(why, widget_gpu::HANG_MESSAGE);
        assert_eq!(canvas.render(0.0, 1.0, vec![], vec![]), Ok(()));
    }
    gpu_fake_aborts(None);
}
