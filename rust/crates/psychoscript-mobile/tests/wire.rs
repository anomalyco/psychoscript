//! The binary path (`ValueEncoder.widget()`) against the JSON path, through the crate's API: `run_bytes` and live
//! posts on the bench workloads (`fixtures/workloads`: the widget prelude and templates of opencode's binary-format
//! bench, with their inputs) decode to what the JSON reads as; the encoder's failures are program errors.
#![cfg(feature = "widget-wire")]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use psychoscript_mobile::{
    EncodeValues, Failure, HostValue, LiveExit, LiveHandler, LiveOptions, LiveRun, Program,
    PsychoScriptError, RunOptions, ValueEncoder,
};
use serde_json::{Value, json};
use widget_wire::{Arg, DrawOutput, Node, Output, Post, StepOutput, decode_output, decode_post};

const PRELUDE: &str = include_str!("fixtures/workloads/prelude.js");
const STEP: &str = "\nreturn __widget_step(__input())";
const EMIT: &str = "\n__widget_emit(__widget_step(__input()))";
const LIVE: &str = "\nreturn await __widget_live(__input())";

fn fixture(path: &str) -> String {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/workloads/");
    std::fs::read_to_string(format!("{dir}{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn workloads(kind: &str) -> Vec<(String, String)> {
    let w: Value = serde_json::from_str(&fixture("workloads.json")).unwrap();
    w[kind]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            let program = fixture(&format!("templates/{}.js", w["program"].as_str().unwrap()));
            (
                w["name"].as_str().unwrap().to_owned(),
                format!("{PRELUDE}{program}"),
            )
        })
        .collect()
}

/// `a` and `b` alike, numbers within float rounding: the JSON path's numbers can be an ulp off (serde_json parses
/// floats fast, not exactly), and draw coordinates are f32 from either.
#[track_caller]
fn assert_alike(a: &impl std::fmt::Debug, b: &impl std::fmt::Debug, what: &str) {
    fn tokens(s: &str) -> Vec<Result<f64, String>> {
        let b = s.as_bytes();
        let (mut out, mut text, mut i) = (Vec::new(), String::new(), 0);
        while i < b.len() {
            let starts = b[i].is_ascii_digit()
                || (b[i] == b'-' && b.get(i + 1).is_some_and(u8::is_ascii_digit));
            if starts && !text.ends_with(|c: char| c.is_alphanumeric() || c == '_') {
                let end = (i + 1..b.len())
                    .find(|&j| !(b[j].is_ascii_digit() || b".eE+-".contains(&b[j])))
                    .unwrap_or(b.len());
                out.push(Err(std::mem::take(&mut text)));
                out.push(s[i..end].parse::<f64>().map_err(|_| s[i..end].to_owned()));
                i = end;
            } else {
                text.push(b[i] as char);
                i += 1;
            }
        }
        out.push(Err(text));
        out
    }
    let (a, b) = (format!("{a:?}"), format!("{b:?}"));
    let (ta, tb) = (tokens(&a), tokens(&b));
    let alike = ta.len() == tb.len()
        && ta.iter().zip(&tb).all(|(x, y)| match (x, y) {
            (Ok(x), Ok(y)) => x == y || (x - y).abs() <= 1e-6 * x.abs().max(y.abs()),
            _ => x == y,
        });
    assert!(alike, "{what}:\n{a}\n{b}");
}

fn program(source: String) -> Arc<Program> {
    Arc::new(Program::new(source, "__input".into()).unwrap())
}

#[test]
fn step_workloads_decode_as_their_json() {
    let options = RunOptions::default();
    for (name, source) in workloads("step") {
        let input = fixture(&format!("inputs/{name}.json"));
        let json: Value = serde_json::from_str(
            &program(format!("{source}{STEP}"))
                .run(input.clone(), options.clone())
                .unwrap(),
        )
        .unwrap();
        let emit = program(format!("{source}{EMIT}"));
        let bytes = emit
            .run_bytes(input.clone(), ValueEncoder::widget(), options.clone())
            .unwrap();
        match decode_output(&bytes).unwrap() {
            Output::Step(s) => assert_alike(&s, &StepOutput::from_value(&json).unwrap(), &name),
            Output::Draw(d) => {
                assert_alike(&d, &DrawOutput::from_value(&json).unwrap().commands, &name)
            }
        }
        // A session holding `data` writes the same bytes.
        let mut own: Value = serde_json::from_str(&input).unwrap();
        let data = own.as_object_mut().unwrap().shift_remove("data").unwrap();
        let session = emit.session(json!({ "data": data }).to_string()).unwrap();
        let again = session
            .run_bytes(own.to_string(), ValueEncoder::widget(), options.clone())
            .unwrap();
        assert_eq!(again, bytes, "{name}");
    }
}

enum Event {
    /// JSON posts: never with an encoder.
    Json,
    Bytes(Vec<Vec<u8>>),
    Exit(LiveExit),
}

struct Handler(Mutex<Sender<Event>>);

impl LiveHandler for Handler {
    fn on_posts(&self, _messages_json: Vec<String>) {
        let _ = self.0.lock().unwrap().send(Event::Json);
    }
    fn on_posts_bytes(&self, messages: Vec<Vec<u8>>) {
        let _ = self.0.lock().unwrap().send(Event::Bytes(messages));
    }
    fn on_warning(&self, _message: String) {}
    fn on_exit(&self, exit: LiveExit) {
        let _ = self.0.lock().unwrap().send(Event::Exit(exit));
    }
}

fn handler() -> (Box<dyn LiveHandler>, Receiver<Event>) {
    let (tx, rx) = channel();
    (Box::new(Handler(Mutex::new(tx))), rx)
}

fn next(rx: &Receiver<Event>) -> Event {
    rx.recv_timeout(Duration::from_secs(10)).expect("an event")
}

/// A live post's JSON read as Rune reads it.
fn post_from_json(v: &Value) -> Post {
    match v["type"].as_str().unwrap() {
        "render" => Post::Render(Node::from_value(&v["node"]).unwrap()),
        "draw" => Post::Draw {
            id: v["id"].as_str().unwrap().to_owned(),
            commands: DrawOutput::from_value(&json!({ "commands": v["commands"] }))
                .unwrap()
                .commands,
        },
        "frame" => Post::Frame,
        "submit" => Post::Submit(v["value"].clone()),
        "dismiss" => Post::Dismiss,
        "send" => Post::Send {
            value: v["value"].clone(),
            wake: v["wake"] != json!(false),
        },
        "capture" => Post::Capture(v["value"] == json!(true)),
        t => panic!("{t}"),
    }
}

/// Writes each post both ways, the widget format's bytes and its JSON, so one run (live programs read the clock)
/// gives both.
struct Both;

impl EncodeValues for Both {
    fn emit_name(&self) -> &str {
        "__emit"
    }
    fn encode_output(&self, _value: &HostValue) -> Result<Vec<u8>, Failure> {
        unreachable!()
    }
    fn encode_post(&self, message: &HostValue) -> Result<Vec<u8>, Failure> {
        let bin = widget_wire::encode_post(message).map_err(|e| Failure::new(e.kind, e.message))?;
        let json = message.to_json().unwrap().to_string();
        Ok([&(bin.len() as u32).to_le_bytes()[..], &bin, json.as_bytes()].concat())
    }
}

/// The frame a client delivers.
fn frame(i: usize) -> String {
    let t = i as f64 / 60.0;
    format!(
        r#"{{"type":"frame","frame":{{"t":{t},"dt":0.016666666666666666,"width":600,"height":320,"scale":2,"pointer":null,"dark":false}}}}"#
    )
}

#[test]
fn live_workloads_post_what_their_json_posts() {
    for (name, source) in workloads("live") {
        let input = fixture(&format!("inputs/{name}.json"));
        let (h, rx) = handler();
        // Debug builds of the heavier workloads, beside other tests, can compute past the 50 ms slice.
        let options = LiveOptions {
            slice_budget_ms: 60_000,
            ..LiveOptions::default()
        };
        let run = program(format!("{source}{LIVE}"))
            .start_live(input, h, options, None, Some(ValueEncoder::new(Both)))
            .unwrap();
        let (mut frames, mut posts) = (0, 0);
        while frames < 20 {
            let Event::Bytes(list) = next(&rx) else {
                panic!("{name}: bytes only")
            };
            for b in list {
                let n = u32::from_le_bytes(b[..4].try_into().unwrap()) as usize;
                let bin = decode_post(&b[4..4 + n]).unwrap();
                let json = post_from_json(&serde_json::from_slice(&b[4 + n..]).unwrap());
                assert_alike(&bin, &json, &name);
                if bin == Post::Frame {
                    frames += 1;
                    if run.deliver(frame(frames)).is_err() {
                        let Event::Exit(exit) = next(&rx) else {
                            panic!("{name}")
                        };
                        panic!("{name} ended: {exit:?}");
                    }
                }
                posts += 1;
            }
        }
        assert!(posts > 20, "{name}");
        run.stop();
    }
}

#[test]
fn posts_read_values_of_other_kinds_as_their_json_does() {
    // Values JSON writes as something else (a Date as its ISO string, a URL as its href, a Set as an array) decode as
    // the JSON path gives them.
    let source = r#"
      __host.post({ type: "render", node: { type: "column", children: new Set([
        { type: "text", text: new Date(0), tone: "muted" },
        { type: "image", src: new URL("https://example.com/a.png"), alt: new Date(86400000) },
        { type: "select", id: "s", options: new Set([{ value: "a", label: new Date(0) }]), value: new Set(["a"]) },
      ]) } })
      __host.post({ type: "draw", id: new URL("https://example.com/c"), commands: new Set([
        ["text", 0, 10, new Date(0), { color: "accent" }],
        ["image", new URL("https://example.com/i.png"), 0, 0, 4, 4],
      ]) })
      __host.post({ type: "submit", value: { at: new Date(0), tags: new Set(["x"]), m: new Map([[1, 2]]) } })
      await __host.receive()
    "#;
    let (h, rx) = handler();
    let run = program(source.into())
        .start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::new(Both)),
        )
        .unwrap();
    let Event::Bytes(list) = next(&rx) else {
        panic!("bytes")
    };
    assert_eq!(list.len(), 3);
    for b in list {
        let n = u32::from_le_bytes(b[..4].try_into().unwrap()) as usize;
        let bin = decode_post(&b[4..4 + n]).unwrap();
        let json = post_from_json(&serde_json::from_slice(&b[4 + n..]).unwrap());
        assert_eq!(bin, json);
    }
    run.stop();
}

#[test]
fn a_gpu_batch_carries_the_programs_typed_array_bytes() {
    let source = r#"
      const v = new Float32Array([1.5, -2, 0.25])
      __host.post({ type: "frame", gpu: { ops: [["writeBuffer", 4, 0, 0, v.byteLength], ["submit"]], bytes: v } })
      __host.post({ type: "gpu", ops: [], bytes: v.buffer })
      await __host.receive()
    "#;
    let (h, rx) = handler();
    let run = program(source.into())
        .start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    let Event::Bytes(list) = next(&rx) else {
        panic!("bytes")
    };
    let floats: Vec<u8> = [1.5f32, -2.0, 0.25]
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();
    let Post::FrameGpu(batch) = decode_post(&list[0]).unwrap() else {
        panic!()
    };
    assert_eq!(batch.bytes, floats);
    assert_eq!(batch.ops[1], Arg::List(vec![Arg::Str("submit".into())]));
    let Post::Gpu(batch) = decode_post(&list[1]).unwrap() else {
        panic!()
    };
    assert_eq!(batch.bytes, floats);
    run.stop();
}

#[test]
fn an_invalid_post_ends_the_live_run_as_a_program_error() {
    let source = "__host.post({ type: \"frame\" })\n__host.post({ type: \"draw\", id: \"c\", commands: [[\"rect\", 0, 0, 1, NaN, {}]] })\nawait __host.receive()";
    let (h, rx) = handler();
    let _run = program(source.into())
        .start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    // The posts before it still reach the app.
    let Event::Bytes(list) = next(&rx) else {
        panic!("bytes")
    };
    assert_eq!(decode_post(&list[0]).unwrap(), Post::Frame);
    let Event::Exit(LiveExit::Failed {
        error: PsychoScriptError::Runtime {
            kind, reason, line, ..
        },
    }) = next(&rx)
    else {
        panic!("a program error")
    };
    // The kind names the spec's phase (`draw`).
    assert_eq!((kind.as_str(), line), ("InvalidDraw", Some(2)));
    assert!(reason.contains("invalid post: draw command 0"), "{reason}");

    let (h, rx) = handler();
    let _run = program("__host.post({ type: \"explode\" })".into())
        .start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    let Event::Exit(LiveExit::Failed {
        error: PsychoScriptError::Runtime { kind, reason, .. },
    }) = next(&rx)
    else {
        panic!("a program error")
    };
    assert_eq!(kind, "InvalidDataValue");
    assert!(reason.contains("unknown post type \"explode\""), "{reason}");

    let (h, rx) = handler();
    let _run = program("__host.post({ type: \"frame\", gpu: { ops: [], bytes: [1, 2] } })".into())
        .start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    let Event::Exit(LiveExit::Failed {
        error: PsychoScriptError::Runtime { kind, .. },
    }) = next(&rx)
    else {
        panic!("a program error")
    };
    assert_eq!(kind, "InvalidGpu");
}

#[test]
fn a_restored_run_posts_bytes_with_its_encoder() {
    let source = "while (true) { const m = await __host.receive(); __host.post({ type: \"submit\", value: m }) }";
    let (h, rx) = handler();
    let run = program(source.into())
        .start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    run.pause().unwrap();
    let snapshot = run.snapshot().unwrap();
    run.stop();
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Stopped)));
    let (h, rx) = handler();
    let restored = LiveRun::restore(
        snapshot,
        h,
        "__input".into(),
        LiveOptions::default(),
        None,
        Some(ValueEncoder::widget()),
    )
    .unwrap();
    let Event::Bytes(list) = next(&rx) else {
        panic!("bytes")
    };
    let Post::Submit(v) = decode_post(&list[0]).unwrap() else {
        panic!()
    };
    assert_eq!(v["type"], "resumed");
    restored.stop();
}

fn run_bytes(source: &str, options: RunOptions) -> Result<Vec<u8>, PsychoScriptError> {
    program(source.into()).run_bytes("{}".into(), ValueEncoder::widget(), options)
}

#[test]
fn run_bytes_failures_are_program_errors() {
    let e = run_bytes(
        "const x = 1\n__widget_emit({ commands: [[\"blur\"]] })",
        RunOptions::default(),
    )
    .unwrap_err();
    let PsychoScriptError::Runtime {
        kind, reason, line, ..
    } = e
    else {
        panic!("{e:?}")
    };
    assert_eq!((kind.as_str(), line), ("InvalidDraw", Some(2)));
    assert!(reason.contains("unknown draw command \"blur\""), "{reason}");

    let e = run_bytes("1 + 1", RunOptions::default()).unwrap_err();
    assert!(
        matches!(&e, PsychoScriptError::Runtime { kind, reason, .. } if kind == "InvalidDataValue" && reason.contains("didn't call __widget_emit")),
        "{e:?}"
    );

    let options = RunOptions {
        max_output_bytes: Some(8),
        ..Default::default()
    };
    let e = run_bytes(
        "__widget_emit({ state: 0, view: { type: \"text\", text: \"long enough\" } })",
        options,
    )
    .unwrap_err();
    assert!(
        matches!(
            e,
            PsychoScriptError::OutputTooLarge {
                max_output_bytes: 8,
                ..
            }
        ),
        "{e:?}"
    );

    assert!(matches!(
        run_bytes(
            "__widget_emit(1)",
            RunOptions {
                timeout_ms: Some(0),
                ..Default::default()
            }
        ),
        Err(PsychoScriptError::InvalidInput { .. })
    ));
}

#[test]
fn run_bytes_leaves_functions_out_as_json_does() {
    let source =
        "const out = { state: { n: 1, f() {}, list: [() => 2, 3] }, view: { type: \"divider\" } }";
    let json = program(format!("{source}\nreturn out"))
        .run("{}".into(), RunOptions::default())
        .unwrap();
    let bytes = run_bytes(
        &format!("{source}\n__widget_emit(out)"),
        RunOptions::default(),
    )
    .unwrap();
    let Output::Step(s) = decode_output(&bytes).unwrap() else {
        panic!()
    };
    assert_eq!(
        s.state,
        serde_json::from_str::<Value>(&json).unwrap()["state"]
    );
    assert_eq!(s.state, json!({ "n": 1, "list": [null, 3] }));
    // The last call wins; `emit_name` names the global.
    let bytes = run_bytes(
        "__widget_emit({ commands: [] })\n__widget_emit({ commands: [[\"save\"]] })",
        RunOptions::default(),
    )
    .unwrap();
    assert!(matches!(decode_output(&bytes).unwrap(), Output::Draw(d) if d.len() == 1));
    assert_eq!(ValueEncoder::widget().emit_name(), "__widget_emit");
}
