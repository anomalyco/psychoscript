use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psychoscript_mobile::{
    FetchCompletion, FetchRequest, FetchResponse, FetchTransport, HttpHeader, LiveExit,
    LiveHandler, LiveOptions, LiveRun, Program, PsychoScriptError, is_public_address,
};

const LOOP: &str = r#"
const input = __input()
__host.post({ type: "hello", n: input.n })
let frames = 0
while (true) {
  const m = await __host.receive()
  if (m.type === "frame") { frames++; __host.post({ type: "draw", frames, at: m.at }) }
  if (m.type === "sleep") { const t = __host.now(); await __host.sleep(m.ms); __host.post({ type: "slept", took: __host.now() - t }) }
  if (m.type === "spin") { while (true) {} }
  if (m.type === "flood") { for (let i = 0; i < 300; i++) __host.post({ i }) ; __host.post({ type: "flooded" }) }
  if (m.type === "throw") throw new TypeError("bad frame")
  if (m.type === "resumed") __host.post({ type: "resumed", pausedMs: m.pausedMs })
  if (m.type === "fetch") {
    try { __host.post({ type: "fetched", response: await __host.fetch(m.request) }) }
    catch (e) { __host.post({ type: "rejected", kind: e.kind, message: e.message }) }
  }
  if (m.type === "fetch5") {
    const all = await Promise.allSettled([1, 2, 3, 4, 5].map(() => __host.fetch(m.request)))
    __host.post({ type: "settled", kinds: all.map(r => r.status === "fulfilled" ? "ok" : r.reason.kind) })
  }
  if (m.type === "done") return { frames }
}
"#;

#[derive(Debug)]
enum Event {
    Post(serde_json::Value),
    Warning(String),
    Exit(LiveExit),
}

struct Handler(Mutex<Sender<Event>>);

impl LiveHandler for Handler {
    fn on_post(&self, message_json: String) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .send(Event::Post(serde_json::from_str(&message_json).unwrap()));
    }
    fn on_warning(&self, message: String) {
        let _ = self.0.lock().unwrap().send(Event::Warning(message));
    }
    fn on_exit(&self, exit: LiveExit) {
        let _ = self.0.lock().unwrap().send(Event::Exit(exit));
    }
}

fn handler() -> (Box<dyn LiveHandler>, Receiver<Event>) {
    let (tx, rx) = channel();
    (Box::new(Handler(Mutex::new(tx))), rx)
}

fn next(rx: &Receiver<Event>) -> Event {
    rx.recv_timeout(Duration::from_secs(5)).expect("an event")
}

fn post(rx: &Receiver<Event>) -> serde_json::Value {
    match next(rx) {
        Event::Post(v) => v,
        other => panic!("expected a post, got {other:?}"),
    }
}

fn start_run(options: LiveOptions) -> (Arc<LiveRun>, Receiver<Event>) {
    let program = Program::new(LOOP.into(), "__input".into()).unwrap();
    let (h, rx) = handler();
    let run = program
        .start_live(r#"{"n":7}"#.into(), h, options, None)
        .unwrap();
    assert_eq!(post(&rx), serde_json::json!({ "type": "hello", "n": 7 }));
    (run, rx)
}

#[test]
fn frames_then_finish() {
    let (run, rx) = start_run(LiveOptions::default());
    for i in 1..=3 {
        run.deliver(format!(r#"{{"type":"frame","at":{i}}}"#))
            .unwrap();
        assert_eq!(
            post(&rx),
            serde_json::json!({ "type": "draw", "frames": i, "at": i })
        );
    }
    run.deliver(r#"{"type":"done"}"#.into()).unwrap();
    match next(&rx) {
        Event::Exit(LiveExit::Finished { result_json }) => {
            assert_eq!(result_json, r#"{"frames":3}"#)
        }
        other => panic!("{other:?}"),
    }
    assert!(!run.is_running());
    assert!(matches!(
        run.deliver("{}".into()),
        Err(PsychoScriptError::InvalidState { .. })
    ));
    assert!(matches!(
        run.deliver("{".into()),
        Err(PsychoScriptError::InvalidInput { .. })
    ));
}

#[test]
fn sleeps() {
    let (run, rx) = start_run(LiveOptions::default());
    let start = Instant::now();
    run.deliver(r#"{"type":"sleep","ms":40}"#.into()).unwrap();
    let slept = post(&rx);
    assert!(start.elapsed() >= Duration::from_millis(40));
    assert!(slept["took"].as_f64().unwrap() >= 40.0, "{slept}");
    run.stop();
}

#[test]
fn errors_and_budgets() {
    let (run, rx) = start_run(LiveOptions {
        slice_budget_ms: 30,
        ..Default::default()
    });
    let start = Instant::now();
    run.deliver(r#"{"type":"spin"}"#.into()).unwrap();
    match next(&rx) {
        Event::Exit(LiveExit::Failed {
            error: PsychoScriptError::SliceBudget { budget_ms: 30, .. },
        }) => {}
        other => panic!("{other:?}"),
    }
    assert!(start.elapsed() < Duration::from_secs(2));

    let (run, rx) = start_run(LiveOptions::default());
    run.deliver(r#"{"type":"throw"}"#.into()).unwrap();
    match next(&rx) {
        Event::Exit(LiveExit::Failed {
            error: PsychoScriptError::Runtime { reason, .. },
        }) => assert!(reason.contains("bad frame")),
        other => panic!("{other:?}"),
    }
    drop(run);

    let (run, rx) = start_run(LiveOptions::default());
    run.deliver(r#"{"type":"flood"}"#.into()).unwrap();
    let mut posts = 0;
    let mut warnings = 0;
    // 240 a second ("hello" was the first), one warning, the rest dropped.
    while let Ok(event) = rx.recv_timeout(Duration::from_millis(300)) {
        match event {
            Event::Post(_) => posts += 1,
            Event::Warning(w) => {
                assert!(w.contains("240"), "{w}");
                warnings += 1;
            }
            Event::Exit(e) => panic!("{e:?}"),
        }
    }
    assert_eq!((posts, warnings), (239, 1));
    run.stop();
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Stopped)));
}

#[test]
fn stops() {
    // Waiting.
    let (run, rx) = start_run(LiveOptions::default());
    run.stop();
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Stopped)));
    // Computing, with a budget too large to end it first.
    let (run, rx) = start_run(LiveOptions {
        slice_budget_ms: 60_000,
        ..Default::default()
    });
    run.deliver(r#"{"type":"spin"}"#.into()).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    run.stop();
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Stopped)));
    // Dropped.
    let (run, rx) = start_run(LiveOptions::default());
    drop(run);
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Stopped)));
}

#[test]
fn pauses_and_resumes() {
    let (run, rx) = start_run(LiveOptions::default());
    run.deliver(r#"{"type":"frame","at":1}"#.into()).unwrap();
    assert_eq!(post(&rx)["frames"], 1);
    assert!(matches!(
        run.snapshot(),
        Err(PsychoScriptError::InvalidState { .. })
    ));
    run.pause().unwrap();
    assert!(!run.is_running());
    // Held while paused, received after `resumed`.
    run.deliver(r#"{"type":"frame","at":2}"#.into()).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(60)).is_err());
    run.resume().unwrap();
    let resumed = post(&rx);
    assert_eq!(resumed["type"], "resumed");
    assert!(resumed["pausedMs"].as_f64().unwrap() >= 60.0, "{resumed}");
    assert_eq!(post(&rx)["frames"], 2);

    // A sleep paused halfway takes the rest after resuming, and now() doesn't count the pause.
    run.deliver(r#"{"type":"sleep","ms":100}"#.into()).unwrap();
    std::thread::sleep(Duration::from_millis(40));
    run.pause().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let at = Instant::now();
    run.resume().unwrap();
    // The program waits in `sleep`, not `receive`: it gets `resumed` after waking.
    let slept = post(&rx);
    let took = slept["took"].as_f64().unwrap();
    assert!((100.0..160.0).contains(&took), "{slept}");
    assert!(
        at.elapsed() < Duration::from_millis(120),
        "{:?}",
        at.elapsed()
    );
    assert_eq!(post(&rx)["type"], "resumed");

    // Suspended to a snapshot, resumed here, and restored elsewhere.
    run.pause().unwrap();
    let bytes = run.snapshot().unwrap();
    assert!(!run.is_running());
    assert_eq!(run.snapshot().unwrap(), bytes);
    run.resume().unwrap();
    assert_eq!(post(&rx)["type"], "resumed");
    run.deliver(r#"{"type":"frame","at":3}"#.into()).unwrap();
    assert_eq!(post(&rx)["frames"], 3);
    run.stop();
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Stopped)));

    let (h, rx) = handler();
    let restored =
        LiveRun::restore(bytes, h, "__input".into(), LiveOptions::default(), None).unwrap();
    assert_eq!(post(&rx)["type"], "resumed");
    restored
        .deliver(r#"{"type":"frame","at":9}"#.into())
        .unwrap();
    assert_eq!(
        post(&rx),
        serde_json::json!({ "type": "draw", "frames": 3, "at": 9 })
    );
    restored.deliver(r#"{"type":"done"}"#.into()).unwrap();
    assert!(matches!(next(&rx), Event::Exit(LiveExit::Finished { .. })));
    assert!(matches!(
        LiveRun::restore(
            b"nope".to_vec(),
            handler().0,
            "__input".into(),
            LiveOptions::default(),
            None
        ),
        Err(PsychoScriptError::Snapshot { .. })
    ));
}

type Answer = Box<dyn Fn(&FetchRequest) -> Result<FetchResponse, String> + Send + Sync>;

/// A transport answering from a function, after a delay, and recording what it was asked.
struct Fake {
    answer: Answer,
    delay: Duration,
    seen: Mutex<Vec<FetchRequest>>,
}

impl FetchTransport for Fake {
    fn start(&self, request: FetchRequest, completion: Arc<FetchCompletion>) {
        let answer = (self.answer)(&request);
        self.seen.lock().unwrap().push(request);
        let delay = self.delay;
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            match answer {
                Ok(r) => completion.succeed(r),
                Err(m) => completion.fail(m),
            }
        });
    }
    fn cancel(&self, _id: u64) {}
}

fn ok(status: u16, headers: &[(&str, &str)], body: &[u8]) -> FetchResponse {
    FetchResponse {
        status,
        headers: headers
            .iter()
            .map(|(n, v)| HttpHeader {
                name: (*n).into(),
                value: (*v).into(),
            })
            .collect(),
        body: body.to_vec(),
        remote_address: Some("93.184.215.14".into()),
    }
}

fn start_fetching(hosts: Option<&[&str]>, fake: Arc<Fake>) -> (Arc<LiveRun>, Receiver<Event>) {
    let program = Program::new(LOOP.into(), "__input".into()).unwrap();
    let (h, rx) = handler();
    let options = LiveOptions {
        https_hosts: hosts.map(|h| h.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    };
    let run = program
        .start_live(r#"{"n":1}"#.into(), h, options, Some(fake))
        .unwrap();
    post(&rx);
    (run, rx)
}

fn fetch(run: &LiveRun, rx: &Receiver<Event>, request: serde_json::Value) -> serde_json::Value {
    run.deliver(serde_json::json!({ "type": "fetch", "request": request }).to_string())
        .unwrap();
    post(rx)
}

#[test]
fn fetches() {
    let fake = Arc::new(Fake {
        answer: Box::new(|r| {
            Ok(match r.url.as_str() {
                "https://93.184.215.14/hop" => ok(302, &[("Location", "/data")], b""),
                "https://93.184.215.14/inside" => {
                    ok(307, &[("Location", "https://10.0.0.1/")], b"")
                }
                "https://93.184.215.14/away" => ok(301, &[("Location", "https://1.1.1.1/")], b""),
                "https://93.184.215.14/bytes" => ok(200, &[], &[0xff, 0x00, 0x10]),
                "https://93.184.215.14/private" => FetchResponse {
                    remote_address: Some("192.168.1.2".into()),
                    ..ok(200, &[], b"")
                },
                _ => ok(
                    200,
                    &[
                        ("Content-Type", "application/json"),
                        ("Set-Cookie", "a=b"),
                        ("X-A", "1"),
                        ("x-a", "2"),
                    ],
                    br#"{"ok":true}"#,
                ),
            })
        }),
        delay: Duration::from_millis(5),
        seen: Mutex::new(Vec::new()),
    });
    let host = "93.184.215.14";
    let (run, rx) = start_fetching(Some(&[host]), fake.clone());
    let got = fetch(
        &run,
        &rx,
        serde_json::json!({ "url": "https://93.184.215.14/data", "method": "post", "headers": { "Cookie": "x", "X-Key": "k" }, "body": "hi" }),
    );
    assert_eq!(got["response"]["status"], 200, "{got}");
    assert_eq!(got["response"]["body"], r#"{"ok":true}"#);
    assert_eq!(
        got["response"]["headers"],
        serde_json::json!({ "content-type": "application/json", "x-a": "1, 2" })
    );
    let seen = fake.seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        (seen.method.as_str(), seen.body.as_deref()),
        ("POST", Some(&b"hi"[..]))
    );
    assert_eq!(
        seen.headers,
        [HttpHeader {
            name: "x-key".into(),
            value: "k".into()
        }]
    );

    let hop = fetch(
        &run,
        &rx,
        serde_json::json!({ "url": "https://93.184.215.14/hop" }),
    );
    assert_eq!(
        hop["response"]["url"], "https://93.184.215.14/data",
        "{hop}"
    );
    assert_eq!(
        fetch(
            &run,
            &rx,
            serde_json::json!({ "url": "https://93.184.215.14/bytes" })
        )["response"]["body64"],
        "/wAQ"
    );
    let kind = |request: serde_json::Value| {
        fetch(&run, &rx, request)["kind"]
            .as_str()
            .unwrap_or("none")
            .to_owned()
    };
    assert_eq!(
        kind(serde_json::json!({ "url": "https://93.184.215.14/inside" })),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(serde_json::json!({ "url": "https://93.184.215.14/away" })),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(serde_json::json!({ "url": "https://93.184.215.14/private" })),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(serde_json::json!({ "url": "http://93.184.215.14/data" })),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(serde_json::json!({ "url": "https://1.1.1.1/data" })),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(serde_json::json!({ "url": "https://93.184.215.14/data", "method": "TRACE" })),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(
            serde_json::json!({ "url": "https://93.184.215.14/data", "method": "POST", "body": "x".repeat(300_000) })
        ),
        "TooLarge"
    );

    run.stop();

    // Four in flight at most, and ten a second.
    let (run, rx) = start_fetching(Some(&[host]), fake.clone());
    run.deliver(
        serde_json::json!({ "type": "fetch5", "request": { "url": "https://93.184.215.14/data" } })
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        post(&rx)["kinds"],
        serde_json::json!(["ok", "ok", "ok", "ok", "RateLimited"])
    );
    let kind = |request: serde_json::Value| {
        fetch(&run, &rx, request)["kind"]
            .as_str()
            .unwrap_or("none")
            .to_owned()
    };
    for _ in 0..6 {
        assert_eq!(
            kind(serde_json::json!({ "url": "https://93.184.215.14/data" })),
            "none"
        );
    }
    assert_eq!(
        kind(serde_json::json!({ "url": "https://93.184.215.14/data" })),
        "RateLimited"
    );
    run.stop();

    // Held while paused, and no snapshot while in flight.
    let slow = Arc::new(Fake {
        answer: Box::new(|_| Ok(ok(200, &[], b"slow"))),
        delay: Duration::from_millis(60),
        seen: Mutex::new(Vec::new()),
    });
    let (run, rx) = start_fetching(Some(&["*"]), slow);
    run.deliver(
        serde_json::json!({ "type": "fetch", "request": { "url": "https://93.184.215.14/data" } })
            .to_string(),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    run.pause().unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
    let snap = run.snapshot();
    assert!(
        matches!(snap, Err(PsychoScriptError::Snapshot { .. })),
        "{snap:?}"
    );
    run.resume().unwrap();
    assert_eq!(post(&rx)["response"]["body"], "slow");
    assert_eq!(post(&rx)["type"], "resumed");
    assert_eq!(
        fetch(
            &run,
            &rx,
            serde_json::json!({ "url": "https://127.0.0.1/" })
        )["kind"],
        "CapabilityDenied"
    );
    assert_eq!(
        fetch(
            &run,
            &rx,
            serde_json::json!({ "url": "https://localhost/" })
        )["kind"],
        "CapabilityDenied"
    );
    run.stop();

    // No capability.
    let (run, rx) = start_fetching(None, fake);
    assert_eq!(
        fetch(
            &run,
            &rx,
            serde_json::json!({ "url": "https://93.184.215.14/data" })
        )["kind"],
        "CapabilityDenied"
    );
    assert!(
        is_public_address("8.8.8.8".into())
            && !is_public_address("10.1.2.3".into())
            && !is_public_address("::1".into())
    );
    assert!(
        !is_public_address("fe80::1".into())
            && !is_public_address("::ffff:192.168.0.1".into())
            && !is_public_address("100.64.0.1".into())
    );
}

fn start_source(source: &str, options: LiveOptions) -> (Arc<LiveRun>, Receiver<Event>) {
    let program = Program::new(source.into(), "__input".into()).unwrap();
    let (h, rx) = handler();
    (
        program.start_live("null".into(), h, options, None).unwrap(),
        rx,
    )
}

#[test]
fn waiting_on_a_call_already_pending_isnt_computing() {
    // After the race the program waits on the receive it started before: no new host call to poll.
    let source = r#"const r = __host.receive(); await Promise.race([r, __host.sleep(20)]); __host.post("raced"); return await r"#;
    let (run, rx) = start_source(source, LiveOptions::default());
    assert_eq!(post(&rx), "raced");
    std::thread::sleep(Duration::from_millis(300));
    run.deliver(r#"{"x":1}"#.into()).unwrap();
    match next(&rx) {
        Event::Exit(LiveExit::Finished { result_json }) => assert_eq!(result_json, r#"{"x":1}"#),
        other => panic!("{other:?}"),
    }
}

#[test]
fn computing_after_starting_a_call_counts() {
    let (_run, rx) = start_source(
        "__host.sleep(1000); await null; while (true) {}",
        LiveOptions {
            slice_budget_ms: 30,
            ..Default::default()
        },
    );
    let start = Instant::now();
    match next(&rx) {
        Event::Exit(LiveExit::Failed {
            error: PsychoScriptError::SliceBudget { .. },
        }) => {}
        other => panic!("{other:?}"),
    }
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn local_network_in_dev_mode() {
    let local = || {
        Arc::new(Fake {
            answer: Box::new(|r| {
                let remote = if r.url.contains("93.184.215.14") {
                    "93.184.215.14"
                } else {
                    "127.0.0.1"
                };
                Ok(FetchResponse {
                    remote_address: Some(remote.into()),
                    ..ok(200, &[], b"local")
                })
            }),
            delay: Duration::from_millis(1),
            seen: Mutex::new(Vec::new()),
        })
    };
    let kind = |run: &LiveRun, rx: &Receiver<Event>, url: &str| {
        let got = fetch(run, rx, serde_json::json!({ "url": url }));
        got["kind"].as_str().map_or_else(
            || got["response"]["body"].as_str().unwrap_or("?").to_owned(),
            str::to_owned,
        )
    };
    // Off: no local destinations, no http.
    let (run, rx) = start_fetching(Some(&["localhost:4097", "127.0.0.1"]), local());
    assert_eq!(kind(&run, &rx, "https://127.0.0.1/x"), "CapabilityDenied");
    assert_eq!(
        kind(&run, &rx, "https://localhost:4097/x"),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(&run, &rx, "http://localhost:4097/x"),
        "CapabilityDenied"
    );
    run.stop();

    // On: local destinations and http to them, for declared hosts and ports.
    let fake = local();
    let program = Program::new(LOOP.into(), "__input".into()).unwrap();
    let (h, rx) = handler();
    let options = LiveOptions {
        https_hosts: Some(vec![
            "localhost:4097".into(),
            "127.0.0.1".into(),
            "93.184.215.14".into(),
        ]),
        allow_local_network: true,
        ..Default::default()
    };
    let run = program
        .start_live("{}".into(), h, options, Some(fake.clone()))
        .unwrap();
    post(&rx);
    assert_eq!(kind(&run, &rx, "http://localhost:4097/x"), "local");
    let seen = fake.seen.lock().unwrap().last().cloned().unwrap();
    assert!(
        seen.addresses
            .iter()
            .all(|a| a == "127.0.0.1" || a == "::1")
            && !seen.addresses.is_empty(),
        "{:?}",
        seen.addresses
    );
    assert_eq!(kind(&run, &rx, "https://127.0.0.1:8443/x"), "local");
    assert_eq!(
        kind(&run, &rx, "http://localhost:5000/x"),
        "CapabilityDenied"
    );
    assert_eq!(
        kind(&run, &rx, "http://93.184.215.14/x"),
        "CapabilityDenied"
    );
    assert_eq!(kind(&run, &rx, "https://93.184.215.14/x"), "local");
    run.stop();
}

#[test]
fn caps_the_heap() {
    let source = "const a = []; while (true) { a.push(new Array(1000).fill(a.length)); await __host.sleep(0) }";
    let (_run, rx) = start_source(
        source,
        LiveOptions {
            max_heap_bytes: Some(2 << 20),
            ..Default::default()
        },
    );
    match next(&rx) {
        Event::Exit(LiveExit::Failed {
            error: PsychoScriptError::MemoryLimitExceeded { max_heap_bytes, .. },
        }) => {
            assert_eq!(max_heap_bytes, 2 << 20)
        }
        other => panic!("{other:?}"),
    }
}
