use std::time::{Duration, Instant};

use psychoscript_web::{LiveExit, LiveOptions, LiveRun, Program, Pump};
use serde_json::{Value, json};

const LOOP: &str = r#"
const input = __input()
__host.post({ type: "hello", n: input.n })
while (true) {
  const m = await __host.receive()
  if (m.type === "sleep") { const t = __host.now(); await __host.sleep(m.ms); __host.post({ type: "slept", took: __host.now() - t }) }
  if (m.type === "flood") { for (let i = 0; i < 300; i++) __host.post({ i }); __host.post({ type: "flooded" }) }
  if (m.type === "throw") throw new TypeError("bad frame")
  if (m.type === "resumed") __host.post({ type: "resumed", pausedMs: m.pausedMs })
  if (m.type === "fetch") {
    try { __host.post({ type: "fetched", response: await __host.fetch(m.request) }) }
    catch (e) { __host.post({ type: "rejected", kind: e.kind, message: e.message }) }
  }
  if (m.type === "done") return { ok: true }
}
"#;

fn start(options: LiveOptions) -> LiveRun {
    Program::new(LOOP, None)
        .unwrap()
        .start_live(r#"{"n":7}"#, options)
        .unwrap()
}

/// Pumps until the run waits with nothing woken, or ends; returns what it posted meanwhile.
fn settle(run: &mut LiveRun) -> Vec<Value> {
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let pump = run.pump(8.0);
        let batch: Vec<Value> = serde_json::from_str(&run.take_outbox()).unwrap();
        out.extend(batch);
        match pump {
            Pump::Ended => return out,
            Pump::Wait(_) if !run.woken() => return out,
            _ if Instant::now() > deadline => panic!("the run didn't settle"),
            _ => std::thread::sleep(Duration::from_micros(200)),
        }
    }
}

fn posts(out: &[Value]) -> Vec<Value> {
    out.iter()
        .filter(|e| e["type"] == "post")
        .map(|e| e["message"].clone())
        .collect()
}

#[test]
fn posts_receives_and_finishes() {
    let mut run = start(LiveOptions::default());
    assert_eq!(
        posts(&settle(&mut run)),
        vec![json!({ "type": "hello", "n": 7 })]
    );
    run.deliver(r#"{"type":"done"}"#).unwrap();
    settle(&mut run);
    assert_eq!(
        run.exit(),
        Some(&LiveExit::Finished {
            result_json: r#"{"ok":true}"#.into()
        })
    );
    assert!(run.deliver("{}").is_err());
}

#[test]
fn sleeps_report_their_timer_and_pause_freezes_them() {
    let mut run = start(LiveOptions::default());
    settle(&mut run);
    run.deliver(r#"{"type":"sleep","ms":40}"#).unwrap();
    assert!(posts(&settle(&mut run)).is_empty());
    let Pump::Wait(Some(left)) = run.pump(8.0) else {
        panic!("expected a timer")
    };
    assert!(left > 0.0 && left <= 40.0, "{left}");
    run.pause().unwrap();
    assert_eq!(run.pump(8.0), Pump::Wait(None));
    std::thread::sleep(Duration::from_millis(60));
    assert!(
        posts(&settle(&mut run)).is_empty(),
        "a paused sleep doesn't end"
    );
    run.resume().unwrap();
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(2);
    while seen.len() < 2 && Instant::now() < deadline {
        seen.extend(posts(&settle(&mut run)));
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(seen[0]["type"], "slept");
    assert!(seen[0]["took"].as_f64().unwrap() < 55.0, "{seen:?}");
    assert_eq!(seen[1]["type"], "resumed");
    assert!(seen[1]["pausedMs"].as_f64().unwrap() >= 55.0);
}

#[test]
fn deliveries_wait_while_paused() {
    let mut run = start(LiveOptions::default());
    settle(&mut run);
    run.pause().unwrap();
    run.deliver(r#"{"type":"throw"}"#).unwrap();
    settle(&mut run);
    assert!(run.exit().is_none());
    run.resume().unwrap();
    settle(&mut run);
    match run.exit() {
        Some(LiveExit::Failed { error }) => {
            assert!(error.reason().contains("bad frame"), "{error}")
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn floods_are_cut_with_one_warning() {
    let mut run = start(LiveOptions {
        max_posts_per_second: 100,
        ..Default::default()
    });
    settle(&mut run);
    run.deliver(r#"{"type":"flood"}"#).unwrap();
    let out = settle(&mut run);
    assert_eq!(posts(&out).len(), 99);
    assert_eq!(out.iter().filter(|e| e["type"] == "warning").count(), 1);
}

#[test]
fn fetches_need_the_capability_and_go_through_the_host() {
    let mut denied = start(LiveOptions::default());
    settle(&mut denied);
    denied
        .deliver(r#"{"type":"fetch","request":{"url":"https://api.example.com/x"}}"#)
        .unwrap();
    assert_eq!(posts(&settle(&mut denied))[0]["kind"], "CapabilityDenied");

    let mut run = start(LiveOptions {
        https_hosts: Some(vec!["api.example.com".into()]),
        ..Default::default()
    });
    settle(&mut run);
    run.deliver(r#"{"type":"fetch","request":{"url":"https://other.example.com/x"}}"#)
        .unwrap();
    assert_eq!(posts(&settle(&mut run))[0]["kind"], "CapabilityDenied");
    run.deliver(
        r#"{"type":"fetch","request":{"url":"https://api.example.com/x","method":"post","headers":{"Cookie":"a","X-Key":"k"},"body":"hi"}}"#,
    )
    .unwrap();
    let out = settle(&mut run);
    let request = out
        .iter()
        .find(|e| e["type"] == "fetch")
        .expect("a fetch for the host");
    assert_eq!(request["method"], "POST");
    assert_eq!(request["headers"], json!([["x-key", "k"]]));
    assert_eq!(request["body"], "hi");
    let id = request["id"].as_u64().unwrap();
    run.fetch_done(
        id,
        r#"{"status":201,"url":"https://api.example.com/x","headers":[["content-type","application/json"]]}"#,
        br#"{"a":1}"#.to_vec(),
    );
    let fetched = posts(&settle(&mut run));
    assert_eq!(fetched[0]["response"]["status"], 201);
    assert_eq!(fetched[0]["response"]["body"], r#"{"a":1}"#);

    run.deliver(r#"{"type":"fetch","request":{"url":"https://api.example.com/slow"}}"#)
        .unwrap();
    let id = settle(&mut run)[0]["id"].as_u64().unwrap();
    run.fetch_failed(id, "Timeout", "no response within 15 s");
    assert_eq!(posts(&settle(&mut run))[0]["kind"], "Timeout");

    run.deliver(r#"{"type":"fetch","request":{"url":"https://api.example.com/never"}}"#)
        .unwrap();
    let id = settle(&mut run)[0]["id"].as_u64().unwrap();
    run.stop();
    assert_eq!(run.exit(), Some(&LiveExit::Stopped));
    let out: Vec<Value> = serde_json::from_str(&run.take_outbox()).unwrap();
    assert_eq!(out, vec![json!({ "type": "cancel", "id": id })]);
}
