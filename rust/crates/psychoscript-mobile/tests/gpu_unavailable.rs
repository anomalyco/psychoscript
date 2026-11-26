//! A GPU that turns out to be missing (unavailable is not an error), in a process of its own: the device is the
//! process's. A live run told `available: true` while the device was still being made gets `lost`, its canvases
//! `Unavailable`; a run that starts once it is known gets `available: false`.

#![cfg(feature = "gpu")]

mod gpu_support;

use gpu_support::*;
use psychoscript_mobile::{GpuCanvasState, gpu_fail_devices};
use serde_json::json;

#[test]
fn a_device_that_cant_be_made() {
    gpu_fail_devices(300);
    let p = hand_made("post({ send: gpu })\npost({ send: await next() })\nawait next()");
    let mut r = start(&p, json!({}), Vec::new());
    // Told at once, while the device is being made.
    assert_eq!(
        r.sent(),
        json!({ "available": true, "format": platform_format() })
    );
    // It can't be: its canvases go unavailable, and the program loses its GPU as on a device loss.
    let reason = r.wait(|e| match e {
        Event::Gpu(None, GpuCanvasState::Unavailable { reason }) => Some(reason.clone()),
        _ => None,
    });
    assert_eq!(reason, "no GPU device (as the test asked)");
    assert_eq!(
        r.sent(),
        json!({ "type": "gpu", "lost": "unknown", "message": "no GPU device (as the test asked)" })
    );
    r.run.stop();

    // A run that starts once it is known: `available` false, the canvases unavailable, no loss.
    let mut r = start(&p, json!({}), Vec::new());
    assert_eq!(
        r.sent(),
        json!({ "available": false, "format": platform_format() })
    );
    let reason = r.wait(|e| match e {
        Event::Gpu(None, GpuCanvasState::Unavailable { reason }) => Some(reason.clone()),
        _ => None,
    });
    assert_eq!(reason, "no GPU device (as the test asked)");
    r.settle();
    assert!(
        !(r.seen.iter())
            .any(|e| matches!(e, Event::Posts(p) if p.iter().any(|p| p["send"]["type"] == "gpu"))),
        "{:?}",
        r.seen
    );
    r.run.stop();
}
