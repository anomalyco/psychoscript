//! The vendored wgpu-hal's Metal fix (`rust/vendor/wgpu-hal.patch`, gfx-rs/wgpu#10875), on demand (`--ignored`,
//! macOS): any command buffer of a submission that fails loses the device. Here the internal one that waits for an
//! event nothing signals, which Metal times out after about 5 s (no shader runs, so the GPU isn't recovered), while
//! the submission's own work completes. On a device of its own.

#![cfg(all(feature = "gpu", target_os = "macos"))]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn block<F: std::future::Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    loop {
        let waker = std::task::Waker::noop();
        if let std::task::Poll::Ready(v) =
            f.as_mut().poll(&mut std::task::Context::from_waker(waker))
        {
            return v;
        }
        std::thread::yield_now();
    }
}

#[test]
#[ignore]
fn a_failed_command_buffer_loses_the_device() {
    use objc2_metal::MTLDevice;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::METAL,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = block(instance.request_adapter(&Default::default())).unwrap();
    let (device, queue) = block(adapter.request_device(&Default::default())).unwrap();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let into = heard.clone();
    device.set_device_lost_callback(move |_, message| into.lock().unwrap().push(message));
    // SAFETY: the hal device and queue are only read, to make an event and stage a wait on it.
    let event = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }
        .and_then(|d| d.raw_device().newSharedEvent())
        .expect("a Metal shared event");
    // Kept alive here: the wait's command buffer doesn't retain it.
    unsafe { queue.as_hal::<wgpu::hal::api::Metal>() }
        .expect("a Metal queue")
        .add_wait_event(event.clone(), 1);
    queue.submit([device.create_command_encoder(&Default::default()).finish()]);
    let until = Instant::now() + Duration::from_secs(20);
    while heard.lock().unwrap().is_empty() && Instant::now() < until {
        // wgpu 30 panics in `Device::poll` once the hal reports the device lost (gfx-rs/wgpu#10031).
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            device.poll(wgpu::PollType::Poll)
        }));
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        heard.lock().unwrap().len(),
        1,
        "the failed wait loses the device"
    );
    drop(event);
}
