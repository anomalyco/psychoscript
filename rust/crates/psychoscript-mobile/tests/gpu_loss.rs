//! A device loss (`widgets-gpu.md`, Errors and device loss), in a process of its own: the device is the process's.
//! The program is told at once, what it posts until the new device is ready waits and replays on it, and its
//! canvases draw again.

#![cfg(feature = "widget-gpu")]

mod gpu_support;

use gpu_support::*;
use psychoscript_mobile::{GpuCanvasState, gpu_device, gpu_lose_device};
use serde_json::json;
use widget_wire::Post;

#[test]
fn a_lost_device_is_told_to_the_program_and_replaced() {
    let mut r = start(&live_program(RED), json!({}));
    r.run
        .deliver(json!({ "type": "canvas", "key": "c", "width": 16, "height": 16 }).to_string())
        .unwrap();
    r.frames(3);
    r.live("c");
    gpu_lose_device();
    r.wait(|e| matches!(e, Event::Gpu(None, GpuCanvasState::Lost)).then_some(()));
    // The prelude resolves `device.lost`; the program says so and asks for a new device.
    let lost = r.wait(|e| match e {
        Event::Posts(p) => p.iter().find_map(|p| match p {
            Post::Send { value, .. } => Some(value.clone()),
            _ => None,
        }),
        _ => None,
    });
    assert_eq!(lost["reason"], "destroyed");
    // Frames go on while the new device is made (what the program posts meanwhile waits), until it draws again.
    let lives = |r: &Run| {
        r.gpu_events()
            .iter()
            .filter(|(k, s)| k.as_deref() == Some("c") && *s == GpuCanvasState::Live)
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
    let events = r.gpu_events();
    assert_eq!(
        events
            .iter()
            .filter(|(k, s)| k.as_deref() == Some("c") && *s == GpuCanvasState::Live)
            .count(),
        2,
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|(_, s)| matches!(s, GpuCanvasState::Stopped { .. })),
        "{events:?}"
    );
    r.run.stop();
}
