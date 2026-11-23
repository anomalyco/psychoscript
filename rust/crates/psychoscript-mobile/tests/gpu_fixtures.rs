//! The GPU conformance fixtures (opencode `packages/widget/test/fixtures/gpu`, widgets 6fefac75b; `fixtures/gpu/
//! fixtures`) as live runs: each program with the preludes, its posts through the real `__host.post` and the widget
//! encoder, its batches replayed on this machine's device. Each must give the fixture's GPU program errors (message
//! and canvases) and end as it says. The driver is the spec's (`widgets-gpu.md`, Conformance); a device loss among
//! the inputs is the host's own (`gpu_lose_device`), so this runs in a process of its own. `GPU_FIXTURES` names
//! another directory of them (on a device the tests are copied to).

#![cfg(feature = "widget-gpu")]

mod gpu_support;

use std::time::Duration;

use gpu_support::*;
use psychoscript_mobile::{GpuCanvasState, LiveExit, gpu_lose_device};
use serde_json::{Value, json};
use widget_wire::Post;

fn fixtures() -> Vec<Value> {
    let dir = std::env::var("GPU_FIXTURES").unwrap_or_else(|_| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gpu/fixtures").into()
    });
    let mut list: Vec<Value> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{dir}: {e}"))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap())
        .collect();
    list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    list
}

/// What the host gives the program for an input: a canvas size clamped, a device loss of its own.
fn input(r: &Run, i: &Value) {
    match i["type"].as_str() {
        Some("canvas") => {
            let size = |k: &str| i[k].as_u64().unwrap() as u32;
            let (w, h) = widget_gpu::clamp_size(size("width"), size("height"));
            let m = json!({ "type": "canvas", "key": i["key"], "width": w, "height": h });
            r.run.deliver(m.to_string()).unwrap();
        }
        Some("gpu") if i.get("lost").is_some() => gpu_lose_device(),
        _ => r.run.deliver(i.to_string()).unwrap(),
    }
}

/// Runs a fixture: its GPU errors (as the fixture writes them) and how it ended.
fn drive(f: &Value) -> (Vec<Value>, String, String) {
    let mut r = start(
        &live_program(f["source"].as_str().unwrap()),
        f["data"].clone(),
    );
    for c in f["canvases"].as_array().unwrap() {
        input(
            &r,
            &json!({ "type": "canvas", "key": c["key"], "width": c["width"], "height": c["height"] }),
        );
    }
    let inputs = f["inputs"].as_array().cloned().unwrap_or_default();
    let now = |frame: usize, after: bool| {
        inputs
            .iter()
            .filter(move |i| i["frame"] == frame && (i["after"] == true) == after)
            .map(|i| i["input"].clone())
            .collect::<Vec<_>>()
    };
    let mut end = None;
    let mut frame = 0;
    while end.is_none() {
        // A frame request, the run's end, or nothing for a while: it settled (it stays open, `stop`).
        let next = loop {
            if let Some(i) = r.seen.iter().position(|e| {
                matches!(e, Event::Posts(p) if p.contains(&Post::Frame))
                    || matches!(e, Event::Exit(_))
            }) {
                break Some(r.seen.remove(i));
            }
            match r.rx.recv_timeout(Duration::from_secs(1)) {
                Ok(e) => r.seen.push(e),
                Err(_) => break None,
            }
        };
        match next {
            Some(Event::Exit(LiveExit::Finished { .. })) => end = Some("return".to_owned()),
            Some(Event::Exit(LiveExit::Failed { error })) => {
                end = Some(format!("error: {error:?}"))
            }
            Some(Event::Exit(LiveExit::Stopped)) => end = Some("stopped".to_owned()),
            Some(_) if frame < 10 => {
                for i in now(frame, false) {
                    input(&r, &i);
                }
                r.run.deliver(gpu_support::frame(frame)).unwrap();
                for i in now(frame, true) {
                    input(&r, &i);
                }
                frame += 1;
            }
            _ => {
                r.run.stop();
                end = Some("stop".to_owned());
            }
        }
    }
    // Each error once: for every canvas (`None`), or for each canvas it stops, the first one to report.
    let mut errors: Vec<Value> = Vec::new();
    for e in &r.seen {
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
    let events = format!("{:?}", r.seen);
    (errors, end.unwrap(), events)
}

#[test]
fn every_gpu_fixture_as_a_live_run() {
    let mut failures = Vec::new();
    let mut ran = 0;
    for f in fixtures() {
        let name = f["name"].as_str().unwrap();
        let started = std::time::Instant::now();
        let (errors, end, events) = drive(&f);
        let took = started.elapsed();
        ran += 1;
        if errors.as_slice() != f["errors"].as_array().unwrap().as_slice() || end != f["end"] {
            failures.push(format!(
                "{name} ({took:?}):\n  got      {errors:?}, {end}\n  expected {:?}, {}\n  events {}",
                f["errors"],
                f["end"],
                events.chars().take(600).collect::<String>()
            ));
        } else {
            eprintln!("{name}: ok ({} errors, {end})", errors.len());
        }
    }
    assert_eq!(ran, 45);
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
