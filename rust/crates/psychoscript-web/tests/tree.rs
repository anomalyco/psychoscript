//! The native tree walk against the conformance fixtures (opencode `packages/widget/test/fixtures/wire`, at widgets
//! 60732569a): each fixture's `built` (the view as the program built it, every function as `"$function"`) must walk to
//! exactly `<name>.wire` (`JSON.stringify(view)`), with the same handlers and canvases. The view is given as the
//! `HostValue` a post carries, with a host function for each `"$function"`.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use psychoscript::{HostFunction, HostValue};
use psychoscript_web::tree::Walk;
use serde_json::Value;

fn host(v: &Value) -> HostValue {
    match v {
        Value::Null => HostValue::Null,
        Value::Bool(b) => HostValue::Bool(*b),
        Value::Number(n) => HostValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) if s == "$function" => {
            HostValue::Function(HostFunction::new(|_, _| HostValue::Undefined))
        }
        Value::String(s) => HostValue::String(s.as_str().into()),
        Value::Array(items) => HostValue::Array(items.iter().map(|i| Some(host(i))).collect()),
        Value::Object(props) => HostValue::Object(
            props
                .iter()
                .map(|(k, v)| (k.as_str().into(), host(v)))
                .collect(),
        ),
    }
}

struct Fixture {
    name: String,
    built: HostValue,
    wire: String,
    handlers: BTreeMap<String, String>,
    canvases: BTreeMap<String, String>,
}

fn fixtures() -> Vec<Fixture> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wire");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("the fixtures") {
        let path = entry.expect("an entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("JSON");
        let map = |v: &Value| -> BTreeMap<String, String> {
            v.as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                .collect()
        };
        out.push(Fixture {
            name: fixture["name"].as_str().unwrap_or_default().to_owned(),
            built: host(&fixture["built"]),
            wire: std::fs::read_to_string(path.with_extension("wire")).expect("the .wire file"),
            handlers: map(&fixture["handlers"]),
            canvases: map(&fixture["canvases"]),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[test]
fn every_fixture_walks_to_its_wire_view_byte_for_byte() {
    let all = fixtures();
    assert_eq!(all.len(), 37);
    for f in &all {
        let mut out = String::new();
        let tree = Walk::new()
            .handlers()
            .run(&f.built, &mut out)
            .expect(&f.name);
        assert_eq!(out, f.wire, "{}: the view", f.name);
        // A later node with the same id takes it, as in the prelude's table.
        let handlers: BTreeMap<String, String> = tree
            .handlers
            .unwrap_or_default()
            .into_iter()
            .map(|(id, event)| (id, event.to_owned()))
            .collect();
        assert_eq!(handlers, f.handlers, "{}: the handlers", f.name);
        assert_eq!(
            tree.has_handlers,
            !f.handlers.is_empty(),
            "{}: has_handlers",
            f.name
        );
        let canvases: BTreeMap<String, String> = tree
            .canvases
            .into_iter()
            .map(|(k, (id, _))| (k, id))
            .collect();
        assert_eq!(canvases, f.canvases, "{}: the canvases", f.name);
    }
}

#[test]
fn a_key_with_a_lone_surrogate_is_a_program_error() {
    let lone = psychoscript::HostString::from_utf16(&[0xd800]);
    let view = HostValue::object([
        ("type", HostValue::String("column".into())),
        (
            "children",
            HostValue::Array(vec![Some(HostValue::object([
                ("type", HostValue::String("text".into())),
                ("key", HostValue::String(lone)),
            ]))]),
        ),
    ]);
    assert!(Walk::new().run(&view, &mut String::new()).is_err());
}

/// The walk's cost on the biggest fixtures:
/// `cargo test --release -p psychoscript-web --test tree -- --ignored --nocapture`.
#[test]
#[ignore = "timings: run in release with --ignored"]
fn timings() {
    for name in ["grid-200", "builtin-suggestions"] {
        let all = fixtures();
        let f = all.iter().find(|f| f.name == name).expect(name);
        let mut out = String::with_capacity(f.wire.len());
        let runs = 400;
        let mut best = f64::MAX;
        for _ in 0..runs {
            out.clear();
            let t = Instant::now();
            Walk::new().run(&f.built, &mut out).expect("walks");
            best = best.min(t.elapsed().as_secs_f64() * 1e6);
        }
        println!("{name}: {best:.1} µs (min of {runs}), {} bytes", out.len());
    }
}

/// A whole step on the biggest fixtures, the prelude building the tree (`run`) against a native run whose view this
/// crate walks (`run_step`). Until PsychoScript passes functions as markers, the native view has lost its handler
/// props, so this times the work but doesn't compare the views.
#[test]
#[ignore = "timings: run in release with --ignored"]
fn step_timings() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wire");
    let prelude = std::fs::read_to_string(dir.join("prelude.js")).expect("the prelude");
    for name in ["grid-200", "builtin-suggestions"] {
        let fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(format!("{name}.json"))).expect("read"),
        )
        .expect("JSON");
        let source = format!(
            "{prelude}\n{}",
            fixture["source"].as_str().unwrap_or_default()
        );
        let input = fixture["input"].to_string();
        let prelude_walk = psychoscript_web::Program::new(
            &format!("{source}\nreturn __widget_step(__input())"),
            None,
        )
        .unwrap();
        let native = psychoscript_web::Program::new(
            &format!("{source}\nreturn __widget_step(__input(), true)"),
            None,
        )
        .unwrap();
        let (mut a, mut b) = (f64::MAX, f64::MAX);
        for _ in 0..200 {
            let t = Instant::now();
            prelude_walk.run(&input, None, None).expect("runs");
            a = a.min(t.elapsed().as_secs_f64() * 1e6);
            let t = Instant::now();
            native.run_step(&input, None, None).expect("runs");
            b = b.min(t.elapsed().as_secs_f64() * 1e6);
        }
        println!(
            "{name}: step with the prelude's tree {a:.0} µs, native step + walk {b:.0} µs (min of 200)"
        );
    }
}
