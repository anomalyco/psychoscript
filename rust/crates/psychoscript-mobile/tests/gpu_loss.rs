//! A device loss (`LiveGpu`, psychoscript-gpu's `README.md`, Device loss), in a process of its own: the device is the
//! process's. The program is told at once (`{ type: "gpu", lost }`), the app (`Lost`) after it, what the program posts
//! until the new device is ready waits and replays on it, and its canvases draw again; a canvas an error stopped
//! stays stopped.

#![cfg(feature = "gpu")]

mod gpu_support;

use gpu_support::*;
use psychoscript_mobile::{GpuCanvasState, gpu_device, gpu_lose_device};
use serde_json::json;

/// One test at a time: the device is the process's, so a test's loss is every running test's, and each counts what
/// its own runs are told.
fn alone() -> std::sync::MutexGuard<'static, ()> {
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    ONE.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[test]
fn a_lost_device_is_told_to_the_program_and_replaced() {
    let _alone = alone();
    let mut r = start(&hand_made(RED), json!({}), Vec::new());
    r.run.deliver(canvas("c", 16, 16)).unwrap();
    r.frames(3);
    r.live("c");
    gpu_lose_device();
    let reason = r.wait(|e| match e {
        Event::Gpu(Some(k), GpuCanvasState::Lost { reason }) if k == "c" => Some(reason.clone()),
        _ => None,
    });
    assert!(
        reason.starts_with("the GPU device was lost (destroyed)"),
        "{reason}"
    );
    // The program had the message first; it sends it on and starts again on new handles.
    let lost = r.sent();
    assert_eq!(lost["type"], "gpu");
    assert_eq!(lost["lost"], "destroyed");
    // Frames go on while the new device is made (what the program posts meanwhile waits), until it draws again.
    let lives = |r: &Run| {
        (r.gpu_events().iter())
            .filter(|(k, s)| k.as_deref() == Some("c") && matches!(s, GpuCanvasState::Live { .. }))
            .count()
    };
    for i in 3.. {
        r.frame_request();
        if lives(&r) == 2 {
            break;
        }
        assert!(i < 2000, "{:?}", r.gpu_events());
        r.run.deliver(frame(i)).unwrap();
    }
    eprintln!("a new device in {:.1} ms", gpu_device().unwrap().made_ms);
    let (w, h, p) = r.run.gpu_pixels("c").expect("drawn again");
    assert_eq!((w, h), (16, 16));
    assert!(p.chunks(4).all(|px| px == [255, 0, 0, 255]));
    // Drawn again: live again, and no error stopped a canvas.
    r.settle();
    let events = r.gpu_events();
    assert_eq!(lives(&r), 2, "{events:?}");
    assert!(
        !(events.iter()).any(|(_, s)| matches!(s, GpuCanvasState::Stopped { .. })),
        "{events:?}"
    );
    r.run.stop();
}

/// A canvas an error stopped keeps its placeholder through a loss: only the others are told `Lost`.
#[test]
fn a_canvas_an_error_stopped_stays_stopped_through_a_loss() {
    let _alone = alone();
    let mut r = start(&hand_made(TWO), json!({}), Vec::new());
    for k in ["a", "b"] {
        r.run.deliver(canvas(k, 8, 8)).unwrap();
    }
    r.frames(3);
    r.frame_request();
    r.wait(|e| {
        matches!(e, Event::Gpu(Some(k), GpuCanvasState::Stopped { .. }) if k == "b").then_some(())
    });
    r.live("a");
    gpu_lose_device();
    r.wait(|e| {
        matches!(e, Event::Gpu(Some(k), GpuCanvasState::Lost { .. }) if k == "a").then_some(())
    });
    // The program's `send` of the loss comes after every state the host told for it.
    assert_eq!(r.sent()["type"], "gpu");
    let lost: Vec<_> = (r.gpu_events().into_iter())
        .filter(|(_, s)| matches!(s, GpuCanvasState::Lost { .. }))
        .collect();
    assert!(lost.is_empty(), "{lost:?}");
    r.run.stop();
}
