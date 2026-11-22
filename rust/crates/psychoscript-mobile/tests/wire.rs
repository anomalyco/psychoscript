//! The binary path (`ValueEncoder.widget()`, a native host) against the JSON path, through the crate's API:
//! `run_bytes` and live posts on the bench workloads (`fixtures/workloads`: the widget prelude at opencode
//! 60732569a and the templates of opencode's binary-format bench, with their inputs) and on the native-host
//! conformance fixtures (`widget-wire/tests/fixtures/wire`) decode to what the prelude's own tree reads as; the
//! encoder's failures are program errors.
#![cfg(feature = "widget-wire")]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use psychoscript_mobile::{
    EncodePosts, EncodeStep, EncodeValues, Failure, HostValue, LiveExit, LiveHandler, LiveOptions,
    LiveRun, Program, PsychoScriptError, Reject, RunOptions, ValueEncoder,
};
use serde_json::{Value, json};
use widget_wire::{Arg, DrawOutput, Node, Output, Post, StepOutput, decode_output, decode_post};

const PRELUDE: &str = include_str!("fixtures/workloads/prelude.js");
/// The prelude of 523750c6a, which still built the tree in the script (`__widget_step`, `__widget_live(input)`): the
/// JSON path the binary one is held to (opencode keeps it as `packages/widget/test/fixtures/scripted-prelude.js`).
const SCRIPTED: &str = include_str!("fixtures/workloads/prelude-scripted.js");

/// `source` on the scripted prelude.
fn scripted(source: &str) -> String {
    source.replacen(PRELUDE, SCRIPTED, 1)
}
const STEP: &str = "\nreturn __widget_step(__input())";
const EMIT: &str = "\nreturn __widget_native_step(__input())";
const LIVE: &str = "\nreturn await __widget_live(__input())";
const NATIVE_LIVE: &str = "\nreturn await __widget_live(__input(), true)";

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
                format!("{PRELUDE}\n{program}"),
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

/// A program; one without the prelude declares protocol 2 on a line of its own before its source, as the widget
/// encoder runs only those.
fn program(source: String) -> Arc<Program> {
    let source = match source.starts_with("const __widget_protocol") {
        true => source,
        false => format!("{P2}{source}"),
    };
    Arc::new(Program::new(source, "__input".into()).unwrap())
}

const P2: &str = "const __widget_protocol = 2\n";

#[test]
fn step_workloads_decode_as_their_json() {
    let options = RunOptions::default();
    for (name, source) in workloads("step") {
        let input = fixture(&format!("inputs/{name}.json"));
        let json: Value = serde_json::from_str(
            &program(format!("{}{STEP}", scripted(&source)))
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

/// Writes each post both ways, the widget format's bytes (of a built tree, as the prelude posts it without `true`)
/// and its JSON, so one run (live programs read the clock) gives both.
struct Both;

impl EncodeValues for Both {
    fn emit_name(&self) -> &str {
        "__emit"
    }
    fn step(&self, _input: &HostValue) -> Box<dyn EncodeStep> {
        unreachable!()
    }
    fn live(&self) -> Box<dyn EncodePosts> {
        Box::new(Both)
    }
}

impl EncodePosts for Both {
    fn post(
        &mut self,
        message: &HostValue,
        keep: bool,
    ) -> Result<(Option<Vec<u8>>, HostValue), Reject> {
        let bin = widget_wire::encode_post(message)
            .map_err(|e| Reject::Failure(Failure::new(e.kind, e.message)))?;
        let json = message.to_json().unwrap().to_string();
        let both = [&(bin.len() as u32).to_le_bytes()[..], &bin, json.as_bytes()].concat();
        Ok((keep.then_some(both), HostValue::Undefined))
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
        let run = program(format!("{}{LIVE}", scripted(&source)))
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
    assert_eq!((kind.as_str(), line), ("InvalidDraw", Some(3)));
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

fn draw_bytes(source: &str) -> Result<Vec<u8>, PsychoScriptError> {
    program(source.into()).run_bytes(
        r#"{"phase":"draw"}"#.into(),
        ValueEncoder::widget(),
        RunOptions::default(),
    )
}

#[test]
fn draw_steps_emit_their_commands() {
    // Read as JSON reads them: functions left out of objects (a paint's) and `null` in arrays, `undefined` props left
    // out; the run's result is ignored.
    let bytes = draw_bytes(
        "__widget_emit([[\"rect\", 0, 0, 1, 1, { fill: \"accent\", stroke: () => 1, width: undefined }], [\"text\", 0, 0, () => 1]])\nreturn 5",
    )
    .unwrap();
    let Output::Draw(d) = decode_output(&bytes).unwrap() else {
        panic!()
    };
    let json = DrawOutput::from_value(&json!({ "commands": [
        ["rect", 0, 0, 1, 1, { "fill": "accent" }], ["text", 0, 0, null]
    ] }))
    .unwrap();
    assert_eq!(d, json.commands);
    // Checked as a draw output after the run, with no line; the run's own failure first.
    let e = draw_bytes("__widget_emit([[\"blur\"]])").unwrap_err();
    let PsychoScriptError::Runtime {
        kind, reason, line, ..
    } = e
    else {
        panic!("{e:?}")
    };
    assert_eq!((kind.as_str(), line), ("InvalidDraw", None));
    assert!(reason.contains("unknown draw command \"blur\""), "{reason}");
    let e = draw_bytes("__widget_emit([[\"blur\"]])\nthrow new TypeError(\"x\")").unwrap_err();
    assert!(
        matches!(&e, PsychoScriptError::Runtime { kind, .. } if kind == "ExecutionFailure"),
        "{e:?}"
    );
    let e = draw_bytes("return { commands: [] }").unwrap_err();
    assert!(
        matches!(&e, PsychoScriptError::Runtime { kind, .. } if kind == "InvalidDraw"),
        "{e:?}"
    );
}

#[test]
fn run_bytes_failures_are_program_errors() {
    // A step's emitted view with a draw's commands: an unknown node, not a draw.
    let e = run_bytes(
        "__widget_emit([[\"blur\"]])\nreturn 1",
        RunOptions::default(),
    )
    .unwrap_err();
    let PsychoScriptError::Runtime {
        kind, reason, line, ..
    } = e
    else {
        panic!("{e:?}")
    };
    assert_eq!((kind.as_str(), line), ("InvalidDataValue", None));
    assert!(reason.contains("a step must return an object"), "{reason}");

    let e = run_bytes("return { state: 1 }", RunOptions::default()).unwrap_err();
    assert!(
        matches!(&e, PsychoScriptError::Runtime { kind, reason, .. } if kind == "InvalidDataValue" && reason == "The step gave no view"),
        "{e:?}"
    );

    let options = RunOptions {
        max_output_bytes: Some(8),
        ..Default::default()
    };
    let e = run_bytes(
        "__widget_emit({ type: \"text\", text: \"long enough\" })\nreturn { state: 0 }",
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
            "return 1",
            RunOptions {
                timeout_ms: Some(0),
                ..Default::default()
            }
        ),
        Err(PsychoScriptError::InvalidInput { .. })
    ));
}

#[test]
fn programs_of_another_protocol_dont_run() {
    // Nothing runs: the program would post and fail otherwise.
    for (first, kind, reason) in [
        ("", "OlderProtocol", widget_wire::OLDER),
        (
            "const __widget_protocol = 1\n",
            "OlderProtocol",
            widget_wire::OLDER,
        ),
        (
            "const __widget_protocol = 3\n",
            "NewerProtocol",
            widget_wire::NEWER,
        ),
        (
            "const __widget_protocol = 2 \n",
            "OlderProtocol",
            widget_wire::OLDER,
        ),
    ] {
        let source =
            format!("{first}__host.post({{ type: \"explode\" }})\nreturn __widget_native_step(1)");
        let p = Arc::new(Program::new(source, "__input".into()).unwrap());
        let refused = PsychoScriptError::Runtime {
            kind: kind.into(),
            reason: reason.into(),
            line: None,
            column: None,
        };
        let e = p.run_bytes("{}".into(), ValueEncoder::widget(), RunOptions::default());
        assert_eq!(e, Err(refused), "{first:?}");
        let (h, _rx) = handler();
        let e = p.start_live(
            "null".into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        );
        let Some(PsychoScriptError::Runtime {
            kind: k, reason: r, ..
        }) = e.err()
        else {
            panic!("{first:?}")
        };
        assert_eq!((k.as_str(), r.as_str()), (kind, reason), "{first:?}");
    }
    // Without an encoder, as before.
    let p = Arc::new(Program::new("return 1".into(), "__input".into()).unwrap());
    assert_eq!(p.run("{}".into(), RunOptions::default()).unwrap(), "1");
}

#[test]
fn functions_where_none_may_go_fail_the_call_with_the_runtimes_type_error() {
    for (source, label, arg) in [
        (
            "__widget_emit({ type: \"text\", text: \"t\", f: () => 1 })\nreturn {}",
            "__widget_emit",
            1,
        ),
        (
            "__widget_emit(null, () => 1)\nreturn {}",
            "__widget_emit",
            2,
        ),
        ("__input(() => 1)\nreturn {}", "__input", 1),
    ] {
        let e = run_bytes(source, RunOptions::default()).unwrap_err();
        let message = format!(
            "TypeError: Argument {arg} to {label} contains a function, which cannot be passed to the host. (line 2, col 1)"
        );
        assert_eq!(
            e,
            PsychoScriptError::Runtime {
                kind: "ExecutionFailure".into(),
                reason: message,
                line: Some(2),
                column: Some(1),
            },
            "{source}"
        );
    }
    // Live: posts, other host functions.
    for (source, label) in [
        (
            "__host.post({ type: \"submit\", value: [() => 1] })",
            "Argument 1 to __host.post",
        ),
        (
            "__host.post({ type: \"frame\" }, () => 1)",
            "Argument 2 to __host.post",
        ),
        (
            "__host.post({ type: \"draw\", id: \"c\", commands: [[\"save\", () => 1]] })",
            "Argument 1 to __host.post",
        ),
        ("__host.now(() => 1)", "Argument 1 to __host.now"),
        ("await __host.sleep(() => 1)", "Argument 1 to __host.sleep"),
        (
            "await __host.fetch({ url: \"https://a.test\", body: () => 1 })",
            "Argument 1 to __host.fetch",
        ),
    ] {
        let (h, rx) = handler();
        let _run = program(format!("{source}\nawait __host.receive()"))
            .start_live(
                "null".into(),
                h,
                LiveOptions::default(),
                None,
                Some(ValueEncoder::widget()),
            )
            .unwrap();
        let exit = loop {
            if let Event::Exit(e) = next(&rx) {
                break e;
            }
        };
        let LiveExit::Failed {
            error: PsychoScriptError::Runtime { kind, reason, .. },
        } = exit
        else {
            panic!("{source}: {exit:?}")
        };
        assert_eq!(kind, "ExecutionFailure", "{source}");
        assert!(
            reason.starts_with(&format!(
                "TypeError: {label} contains a function, which cannot be passed to the host."
            )),
            "{source}: {reason}"
        );
    }
}

/// The ids in a view, depth first.
fn ids(node: &Node, out: &mut Vec<String>) {
    let own = match node {
        Node::Button { id, .. }
        | Node::Checkbox { id, .. }
        | Node::Slider { id, .. }
        | Node::Select { id, .. }
        | Node::Input { id, .. } => Some(id.clone()),
        Node::Carousel { id, .. } | Node::Card { id, .. } | Node::Canvas { id, .. } => id.clone(),
        _ => None,
    };
    out.extend(own);
    node.children().iter().for_each(|c| ids(c, out));
}

#[test]
fn native_steps_give_the_conformance_fixtures() {
    // `prelude + "\n" + source` on `input`, natively (fixtures from opencode widgets 523750c6a, protocol 2): the view
    // exactly (its bytes), the run's result as JSON values, or the failure exactly.
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../widget-wire/tests/fixtures/wire"
    );
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let f: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let name = f["name"].as_str().unwrap();
        let program = program(format!(
            "{PRELUDE}\n{}{EMIT}",
            f["source"].as_str().unwrap()
        ));
        let out = program.run_bytes(
            f["input"].to_string(),
            ValueEncoder::widget(),
            RunOptions::default(),
        );
        n += 1;
        if let Some(e) = f.get("error") {
            let Err(PsychoScriptError::Runtime {
                kind, reason, line, ..
            }) = &out
            else {
                panic!("{name}: {out:?}")
            };
            assert_eq!(reason, e["message"].as_str().unwrap(), "{name}");
            if e["view"] == true {
                assert_eq!((kind.as_str(), *line), ("InvalidView", None), "{name}");
            } else {
                assert_ne!(kind, "InvalidView", "{name}");
            }
            continue;
        }
        let bytes = out.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let view = widget_wire::encode_post(&HostValue::from_json(
            &json!({ "type": "render", "node": f["view"] }),
        ))
        .unwrap();
        assert!(bytes.ends_with(&view[2..]), "{name}");
        let Output::Step(s) = decode_output(&bytes).unwrap() else {
            panic!("{name}")
        };
        let r = &f["result"];
        assert_eq!(
            s.state,
            r.get("state").cloned().unwrap_or(Value::Null),
            "{name}"
        );
        assert_eq!(s.submit, r.get("submit").cloned(), "{name}");
        assert_eq!(s.dismiss, r.get("dismiss") == Some(&json!(true)), "{name}");
        assert_eq!(
            s.send.map(|m| (m.value, m.wake)),
            r.get("send")
                .map(|m| (m["value"].clone(), m["wake"] != json!(false))),
            "{name}"
        );
    }
    assert_eq!(n, 53);
}

/// Every post of `frames` frames, decoded.
fn drive(
    source: &str,
    input: &str,
    encoder: Option<Arc<ValueEncoder>>,
    frames: usize,
) -> Vec<Post> {
    let (h, rx) = handler();
    let options = LiveOptions {
        slice_budget_ms: 60_000,
        ..LiveOptions::default()
    };
    let run = program(source.to_owned())
        .start_live(input.into(), h, options, None, encoder)
        .unwrap();
    let (mut posts, mut delivered) = (Vec::new(), 0);
    while delivered < frames {
        let batch: Vec<Post> = match next(&rx) {
            Event::Json => panic!("JSON posts"),
            Event::Bytes(list) => list.iter().map(|b| decode_post(b).unwrap()).collect(),
            Event::Exit(e) => panic!("exited: {e:?}"),
        };
        for p in batch {
            if p == Post::Frame {
                delivered += 1;
                run.deliver(frame(delivered)).unwrap();
            }
            posts.push(p);
        }
    }
    run.stop();
    posts
}

#[test]
fn native_live_workloads_post_the_prelude_trees() {
    // Natively against the prelude building the tree itself (both through the binary format): the same posts where
    // the workload doesn't read the clock or draw random numbers, else the same kinds of post and the same ids.
    for (name, source) in workloads("live") {
        let input = fixture(&format!("inputs/{name}.json"));
        let built = drive(
            &format!("{}{LIVE}", scripted(&source)),
            &input,
            Some(ValueEncoder::new(Built)),
            20,
        );
        let native = drive(
            &format!("{source}{NATIVE_LIVE}"),
            &input,
            Some(ValueEncoder::widget()),
            20,
        );
        if matches!(name.as_str(), "live-table-50" | "live-grid-200") {
            assert_eq!(native, built, "{name}");
            continue;
        }
        assert_eq!(native.len(), built.len(), "{name}");
        for (a, b) in native.iter().zip(&built) {
            match (a, b) {
                (Post::Render(a), Post::Render(b)) => {
                    let (mut x, mut y) = (Vec::new(), Vec::new());
                    ids(a, &mut x);
                    ids(b, &mut y);
                    assert_eq!(x, y, "{name}");
                }
                (Post::Draw { id: a, .. }, Post::Draw { id: b, .. }) => assert_eq!(a, b, "{name}"),
                _ => assert_eq!(
                    std::mem::discriminant(a),
                    std::mem::discriminant(b),
                    "{name}"
                ),
            }
        }
    }
}

/// The widget format for a built tree (the prelude without `true`): today's posts, `post` returning `undefined`.
struct Built;

impl EncodeValues for Built {
    fn emit_name(&self) -> &str {
        "__widget_emit"
    }
    fn step(&self, _input: &HostValue) -> Box<dyn EncodeStep> {
        unreachable!()
    }
    fn live(&self) -> Box<dyn EncodePosts> {
        Box::new(Built)
    }
}

impl EncodePosts for Built {
    fn post(
        &mut self,
        message: &HostValue,
        keep: bool,
    ) -> Result<(Option<Vec<u8>>, HostValue), Reject> {
        let bytes = widget_wire::encode_post(message)
            .map_err(|e| Reject::Failure(Failure::new(e.kind, e.message)))?;
        Ok((keep.then_some(bytes), HostValue::Undefined))
    }
}

fn start_native(source: &str, options: LiveOptions) -> (Arc<LiveRun>, Receiver<Event>) {
    let (h, rx) = handler();
    let run = program(source.into())
        .start_live(
            "null".into(),
            h,
            options,
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    (run, rx)
}

fn posts(rx: &Receiver<Event>) -> Vec<Post> {
    match next(rx) {
        Event::Bytes(list) => list.iter().map(|b| decode_post(b).unwrap()).collect(),
        Event::Json => panic!("JSON posts"),
        Event::Exit(e) => panic!("exited: {e:?}"),
    }
}

#[test]
fn a_native_render_returns_whether_it_has_handlers_and_draws_go_by_key() {
    let source = r#"
      const said = []
      said.push(__host.post({ type: "render", node: { type: "column", children: [
        { type: "button", label: "go", onPress: () => 1 },
        { type: "canvas", key: "chart", height: 10 },
        { type: "canvas", key: "gpu", height: 10, wgsl: "fn shade(p: vec2f) -> vec4f { return vec4f(1.0); }" },
      ] } }))
      __host.post({ type: "draw", key: "chart", commands: [["rect", 0, 0, 1, 1, { fill: "accent" }]] })
      for (const key of ["nope", "gpu"]) {
        try { __host.post({ type: "draw", key, commands: [] }) } catch (e) { said.push(e.name + ": " + e.message) }
      }
      said.push(__host.post({ type: "render", node: { type: "text", text: "no handlers" } }))
      said.push(__host.post({ type: "frame" }) === undefined)
      __host.post({ type: "submit", value: said })
      await __host.receive()
    "#;
    let (run, rx) = start_native(source, LiveOptions::default());
    let list = posts(&rx);
    let Post::Render(Node::Column { children, .. }) = &list[0] else {
        panic!("{list:?}")
    };
    assert!(matches!(&children[0], Node::Button { id, .. } if id == "0/0"));
    assert!(
        matches!(&children[1], Node::Canvas { id: Some(id), pointer: false, .. } if id == "0/:chart")
    );
    let Post::Draw { id, commands } = &list[1] else {
        panic!()
    };
    assert_eq!((id.as_str(), commands.len()), ("0/:chart", 1));
    let Post::Submit(said) = list.last().unwrap() else {
        panic!()
    };
    assert_eq!(
        said,
        &json!([
            true,
            "Error: No canvas with key \"nope\" in the rendered view",
            "Error: Canvas \"gpu\" is drawn by its wgsl; it takes no draw commands",
            false,
            true
        ])
    );
    run.stop();
}

#[test]
fn a_native_render_dropped_over_the_post_rate_still_counts() {
    let source = r#"
      __host.post({ type: "render", node: { type: "text", text: "first" } })
      const handled = __host.post({ type: "render", node: { type: "button", label: "b", onPress: () => 1 } })
      await __host.sleep(1100)
      __host.post({ type: "submit", value: handled })
      await __host.receive()
    "#;
    let options = LiveOptions {
        max_posts_per_second: 1,
        ..LiveOptions::default()
    };
    let (run, rx) = start_native(source, options);
    assert!(matches!(posts(&rx)[..], [Post::Render(Node::Text { .. })]));
    assert_eq!(posts(&rx), [Post::Submit(json!(true))]);
    run.stop();
}

#[test]
fn a_native_live_widget_dispatches_events_by_id() {
    // The prelude finds the handler of the id the host gave, and keeps running while the view has one.
    let source = format!(
        "{PRELUDE}\nasync function main() {{\n  let n = 0\n  const view = () => ui.column([ui.text(\"n=\" + n), ui.button(\"add\", {{ key: \"add\", onPress: () => {{ n++; widget.render(view()) }} }})])\n  widget.render(view())\n}}{NATIVE_LIVE}"
    );
    let (h, rx) = handler();
    let run = program(source)
        .start_live(
            r#"{"data":null}"#.into(),
            h,
            LiveOptions::default(),
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    let text = |p: &Post| match p {
        Post::Render(Node::Column { children, .. }) => match (&children[0], &children[1]) {
            (Node::Text { text, .. }, Node::Button { id, .. }) => (text.clone(), id.clone()),
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    };
    assert_eq!(text(&posts(&rx)[0]), ("n=0".into(), "0/:add".into()));
    for n in 1..=2 {
        run.deliver(
            json!({ "type": "event", "event": { "id": "0/:add", "type": "press" } }).to_string(),
        )
        .unwrap();
        assert_eq!(text(&posts(&rx)[0]), (format!("n={n}"), "0/:add".into()));
    }
    run.stop();
}

#[test]
fn a_restored_native_run_keeps_its_canvases_for_draws() {
    let source = r#"
      __host.post({ type: "render", node: { type: "canvas", key: "c", height: 10 } })
      while (true) {
        const m = await __host.receive()
        if (m.type === "draw") __host.post({ type: "draw", key: "c", commands: [["save"]] })
      }
    "#;
    let (run, rx) = start_native(source, LiveOptions::default());
    assert!(matches!(
        posts(&rx)[..],
        [Post::Render(Node::Canvas { .. })]
    ));
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
    restored.deliver(r#"{"type":"draw"}"#.into()).unwrap();
    let list = posts(&rx);
    assert_eq!(list.len(), 1);
    assert!(matches!(&list[0], Post::Draw { id, .. } if id == ":c"));
    restored.stop();
}

/// A step output both ways: the JSON path's result and `run_bytes` (the view emitted, the rest the result).
fn both_ways(state: &str) -> (Value, Value) {
    let json: Value = serde_json::from_str(
        &program(format!(
            "return {{ state: {state}, view: {{ type: \"divider\" }} }}"
        ))
        .run("{}".into(), RunOptions::default())
        .unwrap(),
    )
    .unwrap();
    let bytes = run_bytes(
        &format!("__widget_emit({{ type: \"divider\" }})\nreturn {{ state: {state} }}"),
        RunOptions::default(),
    )
    .unwrap();
    let Output::Step(s) = decode_output(&bytes).unwrap() else {
        panic!()
    };
    (s.state, json["state"].clone())
}

#[test]
fn step_output_values_read_as_their_json_does() {
    for state in [
        "{ at: new Date(0), never: new Date(NaN), list: [new Date(86400000)] }",
        "{ url: new URL('https://example.com/a?b=c'), tags: new Set(['x', 'y']), m: new Map([[1, 2]]) }",
        "{ e: new Error('boom'), f() {}, list: [() => 1, 2] }",
        "{ toJSON: 5, n: 1 }",
    ] {
        let (bin, json) = both_ways(state);
        assert_eq!(bin, json, "{state}");
    }
}

/// The rest of a step's output is the run's result: `toJSON`, an `Error`'s own fields, a typed array failing the step,
/// all as the JSON path has them.
#[test]
fn step_output_values_with_to_json_read_as_their_json_does() {
    for state in [
        "{ a: { toJSON() { return 'custom' } } }",
        "{ list: [{ toJSON(key) { return 'at ' + key } }] }",
        "{ e: Object.assign(new Error('e'), { code: 7 }) }",
    ] {
        let (bin, json) = both_ways(state);
        assert_eq!(bin, json, "{state}");
    }
    let state = "{ bytes: new Float32Array([1.5]) }";
    let json = program(format!(
        "return {{ state: {state}, view: {{ type: \"divider\" }} }}"
    ))
    .run("{}".into(), RunOptions::default())
    .unwrap_err();
    let bin = run_bytes(
        &format!("__widget_emit({{ type: \"divider\" }})\nreturn {{ state: {state} }}"),
        RunOptions::default(),
    )
    .unwrap_err();
    assert_eq!(bin, json);
}
