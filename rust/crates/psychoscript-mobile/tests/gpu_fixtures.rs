//! psychoscript-gpu's GPU conformance fixtures (`../psychoscript-gpu/tests/fixtures/gpu`, opencode
//! `specs/v2/widgets-gpu.md`, Conformance) as live runs through `LiveGpu`, with the test encoder (`gpu_support`):
//! - a fixture with `batches`: a program posts them, in order, each frame request waiting for its frame;
//! - a `raw-*` one without: its source runs, with a stub `widget` and `ui` (as psychoscript-gpu's `conformance.rs`
//!   runs it) and its `__host.post({ type: "gpu", ops, bytes })` posting the batch;
//! - `error-too-many-draws` (`"batches": "from-source"`, which needs opencode's widget prelude): the batches its
//!   source posts, built as psychoscript-gpu's `the_draw_limit_counts_a_frame_s_batches` builds them.
//!
//! The driver gives the run its canvas sizes (clamped) and, after each frame request, that frame's inputs (canvas
//! messages, device losses through the test hooks, `inFlight` ones at the frame's end), then answers it. Each run
//! must tell the fixture's errors (message and canvases, `on_gpu_canvas`), end as it says, replay every batch of the
//! right shape, and, when valid and drawing, present each canvas. A device loss is the process's: this runs in a
//! process of its own, one fixture at a time.

#![cfg(feature = "gpu")]

mod gpu_support;

use std::time::{Duration, Instant};

use gpu_support::*;
use psychoscript::HostValue;
use psychoscript_mobile::{
    GpuCanvasState, LiveExit, gpu_input_format, gpu_lose_device, gpu_lose_device_at_frame_end,
    gpu_wait_idle,
};
use serde_json::{Value, json};

fn fixtures() -> Vec<Value> {
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../psychoscript-gpu/tests/fixtures/gpu"
    );
    let mut list: Vec<Value> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{dir}: {e}"))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap())
        .collect();
    list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    list
}

/// A `raw-*` fixture's source after [`FIXTURE_START`], its batch posted as the test encoder takes it.
fn raw_program(source: &str) -> psychoscript_mobile::Program {
    program(&format!(
        r#"{FIXTURE_START}const widget = {{ render() {{}}, frame }}
const ui = {{ canvas: () => null, column: () => null }}
await (async (__host) => {{
{source}
await main()
}})({{ post: (m) => post(m.type === "gpu" ? {{ gpu: {{ ops: m.ops, bytes: m.bytes }} }} : m) }})
"#
    ))
}

/// `error-too-many-draws`'s batches as its source posts them: 10,000 draws in the first frame's batch, then a frame of
/// 6,000 before a sleep and 4,001 with its frame request (psychoscript-gpu's `the_draw_limit_counts_a_frame_s_batches`).
fn too_many_draws() -> Vec<Value> {
    let pass = |draws: usize| {
        let mut ops = vec![
            json!(["pass", { "colorAttachments": [{ "view": 4, "resolveTarget": null, "clearValue": [0, 0, 0, 0],
                "loadOp": "clear", "storeOp": "store" }], "depthStencilAttachment": null }]),
            json!(["setPipeline", 3]),
        ];
        ops.extend(std::iter::repeat_n(json!(["draw", 3, 1, 0, 0]), draws));
        ops.extend([json!(["end"]), json!(["submit"])]);
        ops
    };
    let mut first = vec![
        json!(["context", 1, "scene", "rgba8unorm", "opaque"]),
        json!([
            "shader",
            2,
            "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); } @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }"
        ]),
        json!(["renderPipeline", 3, { "layout": "auto",
            "vertex": { "module": 2, "entryPoint": null, "buffers": [] },
            "fragment": { "module": 2, "entryPoint": null, "targets": [{ "format": "rgba8unorm", "blend": null, "writeMask": 15 }] },
            "primitive": { "topology": "triangle-list", "stripIndexFormat": null, "frontFace": "ccw", "cullMode": "none" },
            "depthStencil": null,
            "multisample": { "count": 1, "mask": 4294967295u32, "alphaToCoverageEnabled": false } }]),
        json!(["view", 4, 1, { "dimension": "2d", "baseMipLevel": 0, "mipLevelCount": 1, "baseArrayLayer": 0, "arrayLayerCount": 1 }]),
    ];
    first.extend(pass(10_000));
    [(first, true), (pass(6000), false), (pass(4001), true)]
        .into_iter()
        .map(|(ops, frame)| json!({ "frame": frame, "ops": ops, "bytes": "" }))
        .collect()
}

/// Gives the run a fixture's input: a canvas size clamped, a device loss of the host's own (the run has told the
/// program of it, then the app, before the driver goes on), any other message as it is.
fn input(r: &mut Run, i: &Value, losses: &mut usize) {
    match i["type"].as_str() {
        Some("canvas") => {
            let size = |k: &str| i[k].as_u64().unwrap() as u32;
            let (w, h) = psychoscript_gpu::clamp_size(size("width"), size("height"));
            r.run
                .deliver(canvas(i["key"].as_str().unwrap(), w, h))
                .unwrap();
        }
        // `inFlight`: lost at the last frame's end, its work in flight (the driver asked for it then); else with the
        // work all seen finished first, unless `finished` is false. The program has the loss when the app is told (a
        // canvas `Lost`, or every canvas stopped by a second strike).
        Some("gpu") if i.get("lost").is_some() => {
            if i["inFlight"] != true {
                if i["finished"] != false {
                    gpu_wait_idle();
                }
                gpu_lose_device();
            }
            *losses += 1;
            let told = |seen: &[Event]| {
                (seen.iter())
                    .filter(|e| {
                        matches!(
                            e,
                            Event::Gpu(
                                _,
                                GpuCanvasState::Lost { .. } | GpuCanvasState::Stopped { .. }
                            )
                        )
                    })
                    .count()
            };
            let until = Instant::now() + WAIT;
            while told(&r.seen) < *losses {
                let left = until.saturating_duration_since(Instant::now());
                match r.rx.recv_timeout(left) {
                    Ok(e) => r.seen.push(e),
                    Err(_) => panic!("loss {losses} was never told, after {:?}", r.seen),
                }
            }
        }
        _ => r.run.deliver(i.to_string()).unwrap(),
    }
}

/// The GPU errors a run told, as the fixtures write them: each once, for every canvas (`None`), or for each canvas it
/// stops, the first one to report.
fn errors_of(seen: &[Event]) -> Vec<Value> {
    let mut errors: Vec<Value> = Vec::new();
    for e in seen {
        let Event::Gpu(
            key,
            GpuCanvasState::Stopped {
                message, report, ..
            },
        ) = e
        else {
            continue;
        };
        match key {
            None => errors.push(json!({ "message": message, "canvases": "all" })),
            Some(k) if *report || errors.is_empty() => {
                errors.push(json!({ "message": message, "canvases": [k] }))
            }
            Some(k) => errors.last_mut().unwrap()["canvases"]
                .as_array_mut()
                .unwrap()
                .push(json!(k)),
        }
    }
    errors
}

struct Outcome {
    errors: Vec<Value>,
    end: String,
    /// The program's `gpu` input.
    gpu: Value,
    /// Batches replayed, and how many of the right shape were posted.
    replayed: u64,
    valid: u64,
    /// The canvases that went live.
    live: Vec<String>,
    events: String,
}

fn drive(f: &Value) -> Outcome {
    let name = f["name"].as_str().unwrap();
    gpu_input_format(f["gpu"]["format"].as_str().unwrap());
    let losses_in =
        (f["inputs"].as_array().into_iter().flatten()).any(|i| i["input"]["lost"].is_string());
    assert!(
        !losses_in || f["canvases"].as_array().unwrap().len() == 1,
        "{name}: a loss tells each canvas; the driver counts one a loss"
    );
    let keys: Vec<&Value> = (f["canvases"].as_array().unwrap().iter())
        .map(|c| &c["key"])
        .collect();
    let batches = match &f["batches"] {
        Value::Array(b) => Some(b.clone()),
        Value::String(s) if s == "from-source" && name == "error-too-many-draws" => {
            Some(too_many_draws())
        }
        Value::Null => None,
        other => panic!("{name}: `batches` is {other}"),
    };
    let input_json = json!({ "keys": keys, "end": f["end"] });
    let (mut r, valid, requests) = match &batches {
        Some(b) => {
            let (list, valid) = recorded(b);
            let requests = b.iter().filter(|b| b["frame"] == true).count();
            let extra = vec![("batches".to_owned(), list)];
            (
                start(&fixture_program(), input_json, extra),
                valid,
                requests,
            )
        }
        // Each raw source posts one batch of the right shape and waits for a frame.
        None => {
            let p = raw_program(f["source"].as_str().unwrap());
            (
                start(&p, input_json, Vec::<(String, HostValue)>::new()),
                1,
                1,
            )
        }
    };
    let gpu = r.sent();
    for c in f["canvases"].as_array().unwrap() {
        let mut c = c.clone();
        c["type"] = json!("canvas");
        input(&mut r, &c, &mut 0);
    }
    let inputs = f["inputs"].as_array().cloned().unwrap_or_default();
    let now = |frame: usize, after: bool| -> Vec<Value> {
        (inputs.iter())
            .filter(|i| i["frame"] == frame && (i["after"] == true) == after)
            .map(|i| i["input"].clone())
            .collect()
    };
    let mut losses = 0;
    let mut frame = 0;
    let end = loop {
        if f["end"] == "stop" && frame >= requests {
            // Every batch replayed (those held for a new device too), then what that told.
            let until = Instant::now() + WAIT;
            while r.run.gpu_stats().unwrap().batches < valid && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(2));
            }
            r.settle();
            r.run.stop();
            match r.exit() {
                LiveExit::Stopped => break "stop".to_owned(),
                other => break format!("{other:?}"),
            }
        }
        match r.post_or_exit(|p| p["frame"] == true) {
            Err(LiveExit::Finished { .. }) => break "return".to_owned(),
            Err(other) => break format!("{other:?}"),
            Ok(_) => {
                for i in now(frame, false) {
                    input(&mut r, &i, &mut losses);
                }
                // The next frame's `inFlight` loss comes at the end of the frame this answers.
                if let Some(i) = (now(frame + 1, false).iter())
                    .find(|i| i["lost"].is_string() && i["inFlight"] == true)
                {
                    gpu_lose_device_at_frame_end(i["finished"] != false);
                }
                r.run.deliver(gpu_support::frame(frame)).unwrap();
                for i in now(frame, true) {
                    input(&mut r, &i, &mut losses);
                }
                frame += 1;
            }
        }
    };
    let live = (r.gpu_events().into_iter())
        .filter_map(|(k, s)| matches!(s, GpuCanvasState::Live { .. }).then_some(k?))
        .collect();
    Outcome {
        errors: errors_of(&r.seen),
        end,
        gpu,
        replayed: r.run.gpu_stats().unwrap().batches,
        valid,
        live,
        events: format!("{:?}", r.seen),
    }
}

#[test]
fn every_gpu_fixture_as_a_live_run() {
    let mut failures = Vec::new();
    let mut ran = 0;
    for f in fixtures() {
        let name = f["name"].as_str().unwrap();
        let started = Instant::now();
        let o = drive(&f);
        let took = started.elapsed();
        ran += 1;
        let mut wrong = Vec::new();
        if o.errors.as_slice() != f["errors"].as_array().unwrap().as_slice() {
            wrong.push(format!("errors {:?}, expected {:?}", o.errors, f["errors"]));
        }
        if o.end != f["end"] {
            wrong.push(format!("end {}, expected {}", o.end, f["end"]));
        }
        if o.gpu != f["gpu"] {
            wrong.push(format!("gpu input {}, expected {}", o.gpu, f["gpu"]));
        }
        if o.replayed != o.valid {
            wrong.push(format!("{} batches replayed of {}", o.replayed, o.valid));
        }
        // A valid program that draws presents each of its canvases.
        let draws = f["batches"].as_array().is_some_and(|b| {
            (b.iter()).any(|b| {
                (b["ops"].as_array()).is_some_and(|ops| ops.iter().any(|o| o[0] == "pass"))
            })
        });
        if f["errors"] == json!([]) && draws {
            for c in f["canvases"].as_array().unwrap() {
                let key = c["key"].as_str().unwrap();
                if !o.live.iter().any(|k| k == key) {
                    wrong.push(format!("canvas {key} never went live"));
                }
            }
        }
        if wrong.is_empty() {
            eprintln!(
                "{name}: ok ({} errors, {}, {} batches, {took:?})",
                o.errors.len(),
                o.end,
                o.replayed
            );
        } else {
            failures.push(format!(
                "{name} ({took:?}):\n  {}\n  events {}",
                wrong.join("\n  "),
                o.events.chars().take(800).collect::<String>()
            ));
        }
    }
    assert_eq!(ran, 53);
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
