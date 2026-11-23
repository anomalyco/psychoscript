//! The GPU conformance fixtures (opencode `packages/widget/test/fixtures/gpu`, `specs/v2/widgets-gpu.md`,
//! Conformance), copied in `tests/fixtures/gpu`: every fixture's batches replayed on a real device, in order, with
//! its canvas sizes and canvas inputs. The host checks' errors must be the fixture's, exactly; the valid fixtures
//! must render without any error (wgpu's validation included), and the example templates must draw what they draw.
//! A `raw-*` fixture's batch is in its source: the source runs in the VM with a stub `widget` to post it.

mod common;

use std::sync::{Arc, Mutex};

use psychoscript::{HostFunction, HostValue, Runtime};
use serde_json::{Value, json};
use widget_gpu::{Arg, Gpu, GpuError, Stops, clamp_size};

struct Posted {
    frame: bool,
    ops: Vec<Arg>,
    bytes: Vec<u8>,
}

fn base64(s: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let digits: Vec<u8> = s.bytes().filter(|&c| c != b'=').map(value).collect();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, d)| n | (*d as u32) << (18 - 6 * i));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn ops(v: &Value) -> Vec<Arg> {
    v.as_array().unwrap().iter().map(Arg::from_json).collect()
}

/// A raw fixture's own batches: its source run with a `widget` that records what `__host.post` gets.
fn raw(source: &str) -> Vec<Posted> {
    let out: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = out.clone();
    // As a widget run has it (psychoscript-mobile): typed arrays on, for a batch's `ArrayBuffer`.
    let runtime = Runtime::make().typed_arrays(true).globals(move |_| {
        let sink = sink.clone();
        [(
            "__record",
            HostFunction::new(move |args: Vec<HostValue>, _| {
                if let Some(HostValue::String(s)) = args.first() {
                    sink.lock().unwrap().push(s.to_string_lossy().into_owned());
                }
                HostValue::Undefined
            }),
        )]
    });
    let program = format!(
        "const __host = {{ post: (m) => __record(JSON.stringify({{ ops: m.ops, bytes: m.bytes.byteLength }})) }}
const widget = {{ render() {{}}, frame: async () => {{}} }}
const ui = {{ canvas: () => null }}
{source}
main()
return null"
    );
    runtime
        .execute(program.as_str())
        .result
        .unwrap_or_else(|d| panic!("raw source: {}", d.message_lossy()));
    let posts = std::mem::take(&mut *out.lock().unwrap());
    posts
        .iter()
        .map(|p| {
            let v: Value = serde_json::from_str(p).unwrap();
            Posted {
                frame: false,
                ops: ops(&v["ops"]),
                bytes: vec![0; v["bytes"].as_u64().unwrap() as usize],
            }
        })
        .collect()
}

fn fixtures() -> Vec<(String, Value)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gpu");
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            (v["name"].as_str().unwrap().to_owned(), v)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn error_json(e: &GpuError) -> Value {
    json!({
        "message": e.message,
        "canvases": match &e.canvases {
            Stops::All => json!("all"),
            Stops::Canvases(keys) => json!(keys),
        },
    })
}

/// Frame requests that carried no batch, which a fixture's `batches` don't record: (fixture, the index of the batch
/// they came before). `frame-counts-reset-at-a-bare-frame`'s program posts its first 10 passes before a sleep, then
/// asks for a frame with nothing pending, then posts 10 more with the next.
const BARE_FRAMES: &[(&str, usize)] = &[("frame-counts-reset-at-a-bare-frame", 2)];

/// Replays a fixture as its driver runs it: the canvas sizes (clamped) first, then the batches in order. After a
/// frame request (a batch that rode one, or a bare one), that frame's inputs (`canvas` messages, device losses), then
/// its inputs marked `after`.
fn replay(device: &wgpu::Device, queue: &wgpu::Queue, f: &Value) -> (Gpu, Vec<Value>) {
    let name = f["name"].as_str().unwrap();
    let mut gpu = Gpu::new(
        device.clone(),
        queue.clone(),
        wgpu::TextureFormat::Rgba8Unorm,
    )
    .unwrap();
    assert_eq!(gpu.preferred_format(), f["gpu"]["format"].as_str().unwrap());
    let resize = |gpu: &mut Gpu, c: &Value| {
        let size = |k: &str| c[k].as_u64().unwrap() as u32;
        let (w, h) = clamp_size(size("width"), size("height"));
        gpu.resize(c["key"].as_str().unwrap(), w, h);
    };
    for c in f["canvases"].as_array().unwrap() {
        resize(&mut gpu, c);
    }
    let batches: Vec<Posted> = match f.get("batches") {
        Some(b) => b
            .as_array()
            .unwrap()
            .iter()
            .map(|b| Posted {
                frame: b["frame"].as_bool().unwrap(),
                ops: ops(&b["ops"]),
                bytes: base64(b["bytes"].as_str().unwrap()),
            })
            .collect(),
        None => raw(f["source"].as_str().unwrap()),
    };
    let inputs = f
        .get("inputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut frame = 0;
    let mut frame_request = |gpu: &mut Gpu| {
        gpu.end_frame();
        for after in [false, true] {
            let now = inputs.iter().filter(|i| {
                i["frame"] == frame && i.get("after").is_some_and(|a| a == true) == after
            });
            for i in now {
                let i = &i["input"];
                match i["type"].as_str() {
                    Some("canvas") => resize(gpu, i),
                    Some("gpu") if i.get("lost").is_some() => {
                        gpu.reset(device.clone(), queue.clone()).unwrap()
                    }
                    _ => {}
                }
            }
        }
        frame += 1;
    };
    let mut errors = Vec::new();
    for (at, b) in batches.iter().enumerate() {
        if BARE_FRAMES.contains(&(name, at)) {
            frame_request(&mut gpu);
        }
        if let Err(e) = gpu.apply(&b.ops, &b.bytes) {
            errors.push(error_json(&e));
        }
        if b.frame {
            frame_request(&mut gpu);
        }
    }
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    (gpu, errors)
}

#[test]
fn every_fixture() {
    let (device, queue) = common::device();
    let mut failures = Vec::new();
    for (name, f) in fixtures() {
        let (gpu, errors) = replay(&device, &queue, &f);
        let expected = f["errors"].as_array().unwrap();
        if &errors != expected {
            failures.push(format!(
                "{name}:\n  got      {errors:?}\n  expected {expected:?}"
            ));
        } else {
            eprintln!("{name}: ok ({} errors)", errors.len());
        }
        // A valid program that renders presents each of its canvases.
        let renders = f["batches"].as_array().is_some_and(|b| {
            b.iter()
                .any(|b| b["ops"].as_array().unwrap().iter().any(|o| o[0] == "pass"))
        });
        if expected.is_empty() && renders {
            for c in f["canvases"].as_array().unwrap() {
                let key = c["key"].as_str().unwrap();
                if gpu.canvas(key).is_none_or(|c| c.version == 0) {
                    failures.push(format!("{name}: canvas {key} was never presented"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

fn pixels(name: &str, key: &str) -> (u32, u32, Vec<[u8; 4]>) {
    let (device, queue) = common::device();
    let (_, f) = fixtures().into_iter().find(|(n, _)| n == name).unwrap();
    let (gpu, errors) = replay(&device, &queue, &f);
    assert!(errors.is_empty(), "{errors:?}");
    let c = gpu.canvas(key).expect("drawn");
    let (w, h) = (c.texture.width(), c.texture.height());
    (w, h, common::read(&device, &queue, c.texture))
}

#[test]
fn the_cube_draws_a_lit_cube() {
    let (w, h, p) = pixels("cube", "cube");
    assert_eq!((w, h), (600, 480));
    let at = |x: u32, y: u32| p[(y * w + x) as usize];
    // The clear color in the corners, the cube's blue (0.3, 0.6, 1.0, lit) in the middle.
    assert_eq!(at(2, 2), [13, 13, 20, 255]);
    assert_eq!(at(w - 3, h - 3), [13, 13, 20, 255]);
    let [r, g, b, a] = at(w / 2, h / 2);
    assert_eq!(a, 255);
    assert!(b > 60 && b > g && g > r, "{:?}", at(w / 2, h / 2));
    // The lit color's ratio, within rounding.
    assert!((g as f32 / b as f32 - 0.6).abs() < 0.03 && (r as f32 / b as f32 - 0.3).abs() < 0.03);
    // The cube is solid: no background through its middle.
    let lit = (w / 2 - 30..w / 2 + 30)
        .filter(|&x| at(x, h / 2)[2] > 40)
        .count();
    assert_eq!(lit, 60);
}

#[test]
fn the_textured_quad_samples_its_checkerboard() {
    let (w, h, p) = pixels("textured-quad", "quad");
    assert_eq!((w, h), (400, 400));
    let at = |x: u32, y: u32| p[(y * w + x) as usize];
    // Outside the quad (80% of the canvas): the clear color.
    assert_eq!(at(10, 10), [0, 0, 0, 255]);
    // Inside a white square, and in a tinted one (x near texel 12, y near 4: r ≈ 46, g 64, b ≈ 16).
    assert_eq!(at(50, 50), [255, 255, 255, 255]);
    let [r, g, b, _] = at(70, 50);
    assert!(
        (40..=56).contains(&r) && g == 64 && (8..=24).contains(&b),
        "{:?}",
        at(70, 50)
    );
}

#[test]
fn post_processing_shows_the_offscreen_triangle() {
    let (w, h, p) = pixels("post-process", "post");
    // The canvas, and the offscreen target with it, followed the resize to 640 × 440.
    assert_eq!((w, h), (640, 440));
    let at = |x: u32, y: u32| p[(y * w + x) as usize];
    // A corner: the offscreen clear color (0.1, 0.1, 0.12) under the vignette (0.25 there).
    let [r, g, b, a] = at(0, 0);
    assert!(
        r <= 8 && g <= 8 && b <= 9 && b >= r && a == 255,
        "{:?}",
        at(0, 0)
    );
    // The middle: inside the triangle, its colors blended, with no vignette.
    let [r, g, b, _] = at(w / 2, h / 2);
    assert!(r > 60 && g > 60 && b > 60, "{:?}", at(w / 2, h / 2));
}

#[test]
fn canvases_are_clamped_to_4096() {
    let (device, queue) = common::device();
    let (_, f) = fixtures()
        .into_iter()
        .find(|(n, _)| n == "canvas-clamped-to-4096")
        .unwrap();
    // The program made its depth textures at the clamped sizes it was told: 5120 × 2880 and then 9000 × 1000.
    let sizes: Vec<_> = f["batches"].as_array().unwrap()[1..]
        .iter()
        .map(|b| {
            (
                b["ops"][0][2].as_u64().unwrap(),
                b["ops"][0][3].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(sizes, [(4096, 2304), (4096, 455)]);
    let (_, errors) = replay(&device, &queue, &f);
    assert!(errors.is_empty(), "{errors:?}");
}

#[test]
fn a_lost_device_drops_the_batches_from_before_it() {
    let (device, queue) = common::device();
    let (_, f) = fixtures()
        .into_iter()
        .find(|(n, _)| n == "lost-device-drops-earlier-batches")
        .unwrap();
    let (gpu, errors) = replay(&device, &queue, &f);
    assert!(errors.is_empty(), "{errors:?}");
    // Drawn once before the loss; the batch on the old view dropped; drawn twice on the new device.
    let c = gpu.canvas("scene").unwrap();
    assert_eq!(c.version, 3);
    assert!(gpu.error("scene").is_none());
}
