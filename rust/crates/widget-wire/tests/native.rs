//! Native tree building against the conformance fixtures (opencode `packages/widget/test/fixtures/wire`, commit
//! 60732569a): each fixture's `built` view (functions as the string `"$function"`) walked as it is encoded gives the
//! bytes of its `view`, its `handlers` and its `canvases`.

use std::collections::BTreeMap;

use psychoscript::HostValue;
use serde_json::{Value, json};
use widget_wire::{
    LivePosts, PostError, decode_post, encode_output, encode_output_native, encode_post,
};

fn marker(v: &HostValue) -> bool {
    v.as_str() == Some("$function")
}

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
    assert_eq!(list.len(), 37);
    list
}

fn host(v: &Value) -> HostValue {
    HostValue::from_json(v)
}

#[test]
fn steps_encode_the_fixtures_views() {
    for (name, f) in fixtures() {
        let built = host(&json!({ "state": { "n": 1 }, "view": f["built"] }));
        let view = host(&json!({ "state": { "n": 1 }, "view": f["view"] }));
        assert_eq!(
            encode_output_native(&built, marker).unwrap(),
            encode_output(&view).unwrap(),
            "{name}"
        );
    }
}

#[test]
fn renders_find_the_fixtures_handlers_and_canvases() {
    for (name, f) in fixtures() {
        let mut posts = LivePosts::new(marker);
        let render = host(&json!({ "type": "render", "node": f["built"] }));
        let (bytes, handled) = posts.post(&render, true).unwrap();
        let expected = encode_post(&host(&json!({ "type": "render", "node": f["view"] }))).unwrap();
        assert_eq!(bytes.unwrap(), expected, "{name}");
        let handlers: BTreeMap<String, String> = f["handlers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(handled, Some(!handlers.is_empty()), "{name}");
        // A later node with the same id takes its place.
        let found: BTreeMap<String, String> = posts
            .last_render()
            .handlers
            .iter()
            .map(|(id, event)| (id.clone(), event.to_string()))
            .collect();
        assert_eq!(found, handlers, "{name}");
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
        let mut dropped = LivePosts::new(marker);
        assert_eq!(dropped.post(&render, false).unwrap(), (None, handled));
        assert_eq!(dropped.last_render(), posts.last_render());
    }
}

#[test]
fn draws_name_their_canvas_by_key() {
    let mut posts = LivePosts::new(marker);
    let node = json!({ "type": "column", "children": [
        { "type": "canvas", "key": "chart", "height": 10 },
        { "type": "canvas", "key": 7, "height": 10, "onPointer": "$function" },
        { "type": "canvas", "key": "shader", "height": 10, "wgsl": "fn shade(p: vec2f) -> vec4f { return vec4f(1.0); }" },
        { "type": "canvas", "key": "chart", "height": 10 },
    ] });
    let (_, handled) = posts
        .post(&host(&json!({ "type": "render", "node": node })), true)
        .unwrap();
    assert_eq!(handled, Some(true));
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
        Err(PostError::Throw(
            "No canvas with key \"nope\" in the rendered view".into()
        ))
    );
    assert_eq!(
        posts.post(
            &host(&json!({ "type": "draw", "key": "shader", "commands": [] })),
            false
        ),
        Err(PostError::Throw(
            "Canvas \"shader\" is drawn by its wgsl; it takes no draw commands".into()
        ))
    );
    let Err(PostError::Invalid(e)) = posts.post(
        &host(&json!({ "type": "draw", "key": "chart", "commands": [["blur"]] })),
        true,
    ) else {
        panic!()
    };
    assert_eq!(e.kind, "InvalidDraw");
    // Dropped over the rate: no bytes, the key still checked.
    assert_eq!(
        posts
            .post(
                &host(&json!({ "type": "draw", "key": "chart", "commands": [] })),
                false
            )
            .unwrap(),
        (None, None)
    );
    // Other posts are as before.
    let (bytes, ret) = posts
        .post(&host(&json!({ "type": "frame" })), true)
        .unwrap();
    assert_eq!(
        (decode_post(&bytes.unwrap()).unwrap(), ret),
        (widget_wire::Post::Frame, None)
    );
    // A new render replaces the canvases.
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
        Err(PostError::Throw(_))
    ));
}

#[test]
fn keys_are_written_as_javascript_writes_them() {
    let keys = json!([
        1.5,
        -12.25,
        1e21,
        1e-7,
        0.30000000000000004,
        123456789012345680000.0,
        0,
        1e-6,
        1.5e-7,
        5e-324,
        1.7976931348623157e308,
        1e20,
        1.23e-18,
        9007199254740992.0,
        0.5,
        25,
        1.0000000000000002,
        true,
        "a b/é~*'()!",
        "k~2"
    ]);
    let expected = [
        ":1.5",
        ":-12.25",
        ":1e%2B21",
        ":1e-7",
        ":0.30000000000000004",
        ":123456789012345680000",
        ":0",
        ":0.000001",
        ":1.5e-7",
        ":5e-324",
        ":1.7976931348623157e%2B308",
        ":100000000000000000000",
        ":1.23e-18",
        ":9007199254740992",
        ":0.5",
        ":25",
        ":1.0000000000000002",
        ":true",
        ":a%20b%2F%C3%A9~*'()!",
        ":k~2",
    ];
    let children: Vec<Value> = keys
        .as_array()
        .unwrap()
        .iter()
        .map(|k| json!({ "type": "button", "key": k, "label": "b" }))
        .collect();
    let mut posts = LivePosts::new(marker);
    let node = json!({ "type": "row", "children": children });
    let (bytes, _) = posts
        .post(&host(&json!({ "type": "render", "node": node })), true)
        .unwrap();
    let widget_wire::Post::Render(widget_wire::Node::Row { children, .. }) =
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
