//! Native tree building against the conformance fixtures (opencode `packages/widget/test/fixtures/wire`, widget
//! protocol 2, commit 523750c6a): each fixture's `built` view (the view as emitted, functions as `"$function"`)
//! walked as it is encoded gives exactly the bytes of its `view`, its `handlers` and its `canvases`, or its `error`.
//! (`psychoscript-mobile`'s `wire` tests run the same fixtures through the VM.)

use std::collections::{BTreeMap, BTreeSet};

use psychoscript::{Data, HostValue};
use serde_json::{Value, json};
use widget_wire::{
    CallError, DEEP, KEY, LivePosts, NativeStep, Post, decode_output, decode_post, encode_output,
    encode_post,
};

fn fixtures() -> Vec<(String, Value)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/wire");
    let mut list: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .map(|p| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            (p.file_stem().unwrap().to_string_lossy().into_owned(), v)
        })
        .collect();
    list.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(list.len(), 53);
    list
}

/// A fixture's `built`, as the host gets it: `"$function"` a marker, `"$NaN"` and `"$±Infinity"` numbers.
fn built(v: &Value) -> HostValue {
    match v {
        Value::String(s) if s == "$function" => HostValue::FunctionMarker,
        Value::String(s) if s == "$NaN" => HostValue::Number(f64::NAN),
        Value::String(s) if s == "$Infinity" => HostValue::Number(f64::INFINITY),
        Value::String(s) if s == "$-Infinity" => HostValue::Number(f64::NEG_INFINITY),
        Value::Array(a) => HostValue::Array(a.iter().map(|i| Some(built(i))).collect()),
        Value::Object(o) => HostValue::Object(
            o.iter()
                .map(|(k, v)| (k.as_str().into(), built(v)))
                .collect(),
        ),
        v => HostValue::from_json(v),
    }
}

fn host(v: &Value) -> HostValue {
    HostValue::from_json(v)
}

fn ids(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

#[test]
fn steps_encode_the_fixtures() {
    let mut checked = 0;
    for (name, f) in fixtures() {
        let Some(view) = f.get("built") else { continue };
        let mut step = NativeStep::default();
        let emitted = step.emit(&[built(view)]);
        match f.get("error") {
            Some(e) if e["view"] == true => {
                assert_eq!(emitted, Ok(()), "{name}");
                assert_eq!(step.failure(), e["message"].as_str(), "{name}");
            }
            Some(e)
                if e["message"]
                    .as_str()
                    .unwrap()
                    .contains("contains a function") =>
            {
                assert_eq!(emitted, Err(CallError::Function { arg: 1 }), "{name}");
            }
            // A failure of the run's result (`typed-array-in-state`): the view is fine.
            Some(_) => assert_eq!((emitted, step.failure()), (Ok(()), None), "{name}"),
            None => {
                assert_eq!((emitted, step.failure()), (Ok(()), None), "{name}");
                // The view's bytes exactly; the JSON (written by psychoscript) as the same values.
                let result = Data::from_json(&f["result"]);
                let bytes = step.finish(&result).unwrap();
                let view =
                    encode_post(&host(&json!({ "type": "render", "node": f["view"] }))).unwrap();
                assert!(bytes.ends_with(&view[2..]), "{name}");
                let mut whole = f["result"].clone();
                whole["view"] = f["view"].clone();
                assert_eq!(
                    decode_output(&bytes).unwrap(),
                    decode_output(&encode_output(&host(&whole)).unwrap()).unwrap(),
                    "{name}"
                );
            }
        }
        checked += 1;
    }
    assert_eq!(checked, 51);
}

#[test]
fn renders_find_the_fixtures_handlers_and_canvases() {
    for (name, f) in fixtures() {
        let (Some(view), None) = (f.get("built"), f.get("error")) else {
            continue;
        };
        let mut posts = LivePosts::new();
        let render = HostValue::Object(vec![
            ("type".into(), "render".into()),
            ("node".into(), built(view)),
        ]);
        let (bytes, handled) = posts.post(&render, true).unwrap();
        let expected = encode_post(&host(&json!({ "type": "render", "node": f["view"] }))).unwrap();
        assert_eq!(bytes.unwrap(), expected, "{name}");
        let handlers = ids(&f["handlers"]);
        assert_eq!(handled, Some(!handlers.is_empty()), "{name}");
        let found: BTreeMap<String, String> = posts
            .last_render()
            .handlers
            .iter()
            .map(|(id, event)| (id.clone(), event.to_string()))
            .collect();
        let expected: BTreeMap<String, String> = f["handlers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(found, expected, "{name}");
        let canvases: BTreeMap<String, String> = posts
            .last_render()
            .canvases
            .iter()
            .map(|c| (c.key.clone(), c.id.clone()))
            .collect();
        let expected: BTreeMap<String, String> = f["canvases"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(canvases, expected, "{name}");

        // Dropped over the rate, a render is still walked.
        let mut dropped = LivePosts::new();
        assert_eq!(dropped.post(&render, false).unwrap(), (None, handled));
        assert_eq!(dropped.last_render(), posts.last_render());
    }
}

/// A column nesting `levels` levels: columns, each the only child of the one above, `arrays` of them as arrays.
fn deep(levels: usize, arrays: bool) -> HostValue {
    let mut v = HostValue::from_json(&json!({ "type": "button", "label": "b", "onPress": null }));
    if let HostValue::Object(f) = &mut v {
        f[2].1 = HostValue::FunctionMarker;
    }
    for _ in 1..levels {
        v = if arrays {
            HostValue::Array(vec![Some(v)])
        } else {
            HostValue::Object(vec![
                ("type".into(), "column".into()),
                ("children".into(), HostValue::Array(vec![Some(v)])),
            ])
        };
    }
    if arrays {
        HostValue::Object(vec![
            ("type".into(), "column".into()),
            ("children".into(), v),
        ])
    } else {
        v
    }
}

#[test]
fn views_nest_at_most_100_levels() {
    for (levels, arrays, fails) in [
        (100, false, false),
        (101, false, true),
        (100, true, false),
        (101, true, true),
    ] {
        let mut step = NativeStep::default();
        step.emit(&[deep(levels, arrays)]).unwrap();
        assert_eq!(step.failure(), fails.then_some(DEEP), "{levels} {arrays}");
        let mut posts = LivePosts::new();
        let render = HostValue::Object(vec![
            ("type".into(), "render".into()),
            ("node".into(), deep(levels, arrays)),
        ]);
        let r = posts.post(&render, true);
        if fails {
            assert_eq!(r, Err(CallError::View(DEEP.into())));
        } else {
            assert_eq!(r.unwrap().1, Some(true));
        }
    }
    // A string below level 100 doesn't count; the check comes before the key's.
    let s = |levels| {
        let mut v = HostValue::from_json(&json!(["text"]));
        let mut key =
            HostValue::from_json(&json!({ "type": "column", "key": [1], "children": [] }));
        for _ in 1..levels {
            v = HostValue::Object(vec![
                ("type".into(), "column".into()),
                ("children".into(), v),
            ]);
            key = HostValue::Object(vec![
                ("type".into(), "column".into()),
                ("children".into(), HostValue::Array(vec![Some(key)])),
            ]);
        }
        (v, key)
    };
    let (text, key) = s(101);
    let mut step = NativeStep::default();
    step.emit(&[text]).unwrap();
    assert_eq!(step.failure(), None);
    step.emit(&[key]).unwrap();
    assert_eq!(step.failure(), Some(DEEP));
    let (_, key) = s(100);
    step.emit(&[key]).unwrap();
    assert_eq!(step.failure(), Some(KEY));
}

#[test]
fn the_prelude_can_say_the_view_fails() {
    let mut step = NativeStep::default();
    step.emit(&[HostValue::Null, DEEP.into()]).unwrap();
    assert_eq!(step.failure(), Some(DEEP));
    assert_eq!(
        step.emit(&[HostValue::Null, HostValue::FunctionMarker]),
        Err(CallError::Function { arg: 2 })
    );
    let mut posts = LivePosts::new();
    let failed = HostValue::Object(vec![
        ("type".into(), "render".into()),
        ("node".into(), HostValue::Null),
        ("failure".into(), DEEP.into()),
    ]);
    assert_eq!(posts.post(&failed, true), Err(CallError::View(DEEP.into())));
}

#[test]
fn functions_fail_posts_where_none_may_go() {
    let mut posts = LivePosts::new();
    let with = |json: Value, path: &[&str]| {
        let mut v = host(&json);
        let mut at = &mut v;
        for k in path {
            let HostValue::Object(f) = at else { panic!() };
            at = &mut f.iter_mut().find(|(n, _)| n == *k).unwrap().1;
        }
        *at = HostValue::FunctionMarker;
        v
    };
    for (m, path) in [
        (
            json!({ "type": "submit", "value": { "a": 0 } }),
            &["value", "a"][..],
        ),
        (json!({ "type": "send", "value": 0 }), &["value"][..]),
        (
            json!({ "type": "frame", "gpu": { "ops": [], "x": 0 } }),
            &["gpu", "x"][..],
        ),
        (
            json!({ "type": "render", "node": { "type": "text", "text": "t" }, "extra": 0 }),
            &["extra"][..],
        ),
        (
            json!({ "type": "render", "node": { "type": "text", "text": "t", "extra": { "deep": 0 } } }),
            &["node", "extra", "deep"][..],
        ),
        (
            json!({ "type": "render", "node": { "type": "button", "label": "b", "id": 0 } }),
            &["node", "id"][..],
        ),
    ] {
        assert_eq!(
            posts.post(&with(m.clone(), path), true),
            Err(CallError::Function { arg: 1 }),
            "{m}"
        );
    }
    // Handler props of any node may hold one; a marker key is a key of another type.
    let ok = with(
        json!({ "type": "render", "node": { "type": "text", "text": "t", "onChange": 0 } }),
        &["node", "onChange"],
    );
    assert_eq!(posts.post(&ok, true).unwrap().1, Some(false));
    let key = with(
        json!({ "type": "render", "node": { "type": "text", "text": "t", "key": 0 } }),
        &["node", "key"],
    );
    assert_eq!(posts.post(&key, true), Err(CallError::View(KEY.into())));
}

#[test]
fn draws_name_their_canvas_by_key() {
    let mut posts = LivePosts::new();
    let node = json!({ "type": "column", "children": [
        { "type": "canvas", "key": "chart", "height": 10 },
        { "type": "canvas", "key": 7, "height": 10 },
        { "type": "canvas", "key": "shader", "height": 10, "wgsl": "fn shade(p: vec2f) -> vec4f { return vec4f(1.0); }" },
        { "type": "canvas", "key": "chart", "height": 10 },
    ] });
    let (_, handled) = posts
        .post(&host(&json!({ "type": "render", "node": node })), true)
        .unwrap();
    assert_eq!(handled, Some(false));
    let commands = json!([["rect", 0, 0, 1, 1, { "fill": "accent" }]]);
    for (key, id) in [
        (json!("chart"), "0/:chart"),
        (json!("7"), "0/:7"),
        (json!(7), "0/:7"),
    ] {
        let (bytes, ret) = posts
            .post(
                &host(&json!({ "type": "draw", "key": key, "commands": commands })),
                true,
            )
            .unwrap();
        let expected = encode_post(&host(
            &json!({ "type": "draw", "id": id, "commands": commands }),
        ))
        .unwrap();
        assert_eq!((bytes.unwrap(), ret), (expected, None));
    }
    assert_eq!(
        posts.post(
            &host(&json!({ "type": "draw", "key": "nope", "commands": [] })),
            true
        ),
        Err(CallError::Throw(
            "No canvas with key \"nope\" in the rendered view".into()
        ))
    );
    assert_eq!(
        posts.post(
            &host(&json!({ "type": "draw", "key": "shader", "commands": [] })),
            false
        ),
        Err(CallError::Throw(
            "Canvas \"shader\" is drawn by its wgsl; it takes no draw commands".into()
        ))
    );
    let Err(CallError::Invalid(e)) = posts.post(
        &host(&json!({ "type": "draw", "key": "chart", "commands": [["blur"]] })),
        true,
    ) else {
        panic!()
    };
    assert_eq!(e.kind, "InvalidDraw");
    assert_eq!(
        posts
            .post(
                &host(&json!({ "type": "draw", "key": "chart", "commands": [] })),
                false
            )
            .unwrap(),
        (None, None)
    );
    let (bytes, ret) = posts
        .post(&host(&json!({ "type": "frame" })), true)
        .unwrap();
    assert_eq!(
        (decode_post(&bytes.unwrap()).unwrap(), ret),
        (Post::Frame, None)
    );
    posts
        .post(
            &host(&json!({ "type": "render", "node": { "type": "text", "text": "t" } })),
            true,
        )
        .unwrap();
    assert!(matches!(
        posts.post(
            &host(&json!({ "type": "draw", "key": "chart", "commands": [] })),
            true
        ),
        Err(CallError::Throw(_))
    ));
}

#[test]
fn keys_are_written_as_javascript_writes_them() {
    let keys = [
        HostValue::Number(1.5),
        HostValue::Number(-12.25),
        HostValue::Number(1e21),
        HostValue::Number(1e-7),
        HostValue::Number(0.30000000000000004),
        HostValue::Number(123456789012345680000.0),
        HostValue::Number(-0.0),
        HostValue::Number(1e-6),
        HostValue::Number(5e-324),
        HostValue::Number(1.7976931348623157e308),
        HostValue::Number(1e20),
        HostValue::Number(f64::NAN),
        HostValue::Number(f64::INFINITY),
        HostValue::Number(f64::NEG_INFINITY),
        HostValue::Bool(true),
        HostValue::Bool(false),
        "a b/é~*'()!".into(),
        "k~2".into(),
    ];
    let expected = [
        ":1.5",
        ":-12.25",
        ":1e%2B21",
        ":1e-7",
        ":0.30000000000000004",
        ":123456789012345680000",
        ":0",
        ":0.000001",
        ":5e-324",
        ":1.7976931348623157e%2B308",
        ":100000000000000000000",
        ":NaN",
        ":Infinity",
        ":-Infinity",
        ":true",
        ":false",
        ":a%20b%2F%C3%A9~*'()!",
        ":k~2",
    ];
    let children = keys
        .into_iter()
        .map(|k| {
            Some(HostValue::Object(vec![
                ("type".into(), "button".into()),
                ("key".into(), k),
                ("label".into(), "b".into()),
            ]))
        })
        .collect();
    let node = HostValue::Object(vec![
        ("type".into(), "row".into()),
        ("children".into(), HostValue::Array(children)),
    ]);
    let render = HostValue::Object(vec![
        ("type".into(), "render".into()),
        ("node".into(), node),
    ]);
    let (bytes, _) = LivePosts::new().post(&render, true).unwrap();
    let Post::Render(widget_wire::Node::Row { children, .. }) =
        decode_post(&bytes.unwrap()).unwrap()
    else {
        panic!()
    };
    let ids: Vec<String> = children
        .iter()
        .map(|c| match c {
            widget_wire::Node::Button { id, .. } => id.clone(),
            _ => panic!(),
        })
        .collect();
    let expected: Vec<String> = expected.iter().map(|s| format!("0/{s}")).collect();
    assert_eq!(ids, expected);
}
