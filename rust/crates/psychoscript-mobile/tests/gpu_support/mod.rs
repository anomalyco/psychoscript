//! What the GPU tests share: live widget programs with opencode's preludes (`fixtures/gpu`, at widgets 8d5400dd4),
//! and a handler that keeps what the run tells the app.

#![allow(dead_code)]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psychoscript_mobile::{
    GpuCanvasState, LiveExit, LiveHandler, LiveOptions, LiveRun, Program, ValueEncoder,
};
use serde_json::{Value, json};
use widget_wire::{Post, decode_post};

const PRELUDE: &str = include_str!("../fixtures/gpu/prelude.js");
const LIVE: &str = include_str!("../fixtures/gpu/prelude-live.js");
pub const CUBE: &str = include_str!("../../../widget-gpu/tests/fixtures/gpu/cube.json");

/// A live widget template's program (`widgets.md`, Prelude and step ABI).
pub fn live_program(source: &str) -> Arc<Program> {
    let program =
        format!("{PRELUDE}\n{LIVE}\n{source}\nreturn await __widget_live(__input(), true)");
    Arc::new(Program::new(program, "__input".into()).unwrap())
}

#[derive(Debug)]
pub enum Event {
    Posts(Vec<Post>),
    Gpu(Option<String>, GpuCanvasState),
    Exit(LiveExit),
}

pub struct Handler(Mutex<Sender<Event>>);

impl LiveHandler for Handler {
    fn on_posts(&self, _messages_json: Vec<String>) {}
    fn on_posts_bytes(&self, messages: Vec<Vec<u8>>) {
        let posts = messages.iter().map(|m| decode_post(m).unwrap()).collect();
        let _ = self.0.lock().unwrap().send(Event::Posts(posts));
    }
    fn on_warning(&self, _message: String) {}
    fn on_exit(&self, exit: LiveExit) {
        let _ = self.0.lock().unwrap().send(Event::Exit(exit));
    }
    fn on_gpu_canvas(&self, key: Option<String>, state: GpuCanvasState) {
        let _ = self.0.lock().unwrap().send(Event::Gpu(key, state));
    }
}

pub struct Run {
    pub run: Arc<LiveRun>,
    pub rx: Receiver<Event>,
    /// What came besides what a test waited for.
    pub seen: Vec<Event>,
}

pub fn start(program: &Program, data: Value) -> Run {
    let (tx, rx) = channel();
    let options = LiveOptions {
        slice_budget_ms: 60_000,
        ..Default::default()
    };
    let run = program
        .start_live(
            json!({ "data": data }).to_string(),
            Box::new(Handler(Mutex::new(tx))),
            options,
            None,
            Some(ValueEncoder::widget()),
        )
        .unwrap();
    Run {
        run,
        rx,
        seen: Vec::new(),
    }
}

pub fn frame(i: usize) -> String {
    json!({ "type": "frame", "frame": { "t": i as f64 / 60.0, "dt": 1.0 / 60.0, "width": 300, "height": 200,
        "scale": 2, "pointer": null, "dark": false } })
    .to_string()
}

impl Run {
    /// Waits for an event `want` picks (one that came already first), keeping the others.
    pub fn wait<T>(&mut self, mut want: impl FnMut(&Event) -> Option<T>) -> T {
        if let Some((i, t)) = self
            .seen
            .iter()
            .enumerate()
            .find_map(|(i, e)| want(e).map(|t| (i, t)))
        {
            self.seen.remove(i);
            return t;
        }
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let left = until.saturating_duration_since(Instant::now());
            let Ok(e) = self.rx.recv_timeout(left) else {
                panic!("no event in time, after {:?}", self.seen);
            };
            if let Some(t) = want(&e) {
                return t;
            }
            if let Event::Exit(exit) = &e {
                panic!("the run ended: {exit:?} after {:?}", self.seen);
            }
            self.seen.push(e);
        }
    }

    pub fn frame_request(&mut self) {
        self.wait(|e| match e {
            Event::Posts(p) if p.contains(&Post::Frame) => Some(()),
            _ => None,
        })
    }

    /// Answers `n` frame requests.
    pub fn frames(&mut self, n: usize) {
        for i in 0..n {
            self.frame_request();
            self.run.deliver(frame(i)).unwrap();
        }
    }

    /// Waits until the canvas `key` has an image (the device may still be being made as the run starts).
    pub fn live(&mut self, key: &str) {
        self.wait(|e| match e {
            Event::Gpu(Some(k), GpuCanvasState::Live) if k == key => Some(()),
            _ => None,
        });
        self.seen
            .push(Event::Gpu(Some(key.into()), GpuCanvasState::Live));
    }

    pub fn gpu_events(&self) -> Vec<(Option<String>, GpuCanvasState)> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                Event::Gpu(k, s) => Some((k.clone(), s.clone())),
                _ => None,
            })
            .collect()
    }
}

pub fn cube_source() -> String {
    let f: Value = serde_json::from_str(CUBE).unwrap();
    f["source"].as_str().unwrap().to_owned()
}

/// The cube's image: the clear color in the corners, the lit blue in the middle (as widget-gpu's own test has it).
pub fn assert_cube(w: u32, h: u32, p: &[u8]) {
    let at =
        |x: u32, y: u32| -> [u8; 4] { p[((y * w + x) * 4) as usize..][..4].try_into().unwrap() };
    assert_eq!(at(2, 2), [13, 13, 20, 255]);
    assert_eq!(at(w - 3, h - 3), [13, 13, 20, 255]);
    let [r, g, b, a] = at(w / 2, h / 2);
    assert_eq!(a, 255);
    assert!(b > 60 && b > g && g > r, "{:?}", at(w / 2, h / 2));
    let lit = (w / 2 - 30..w / 2 + 30)
        .filter(|&x| at(x, h / 2)[2] > 40)
        .count();
    assert_eq!(lit, 60);
}

/// Red into canvas `c`, every frame; on a device loss it tells the app (`send`) and starts again on a new device.
pub const RED: &str = r#"
async function main() {
  widget.render(ui.canvas({ key: "c", gpu: true, height: 10 }))
  for (;;) {
    const device = await widget.gpu.requestDevice()
    let lost = false
    device.lost.then((info) => { lost = true; __host.post({ type: "send", value: info }) })
    const context = widget.gpu.getContext("c")
    context.configure({ device, format: widget.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" })
    while (!lost) {
      await widget.frame()
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store", clearValue: [1, 0, 0, 1] }] })
      pass.end()
      device.queue.submit([encoder.finish()])
    }
  }
}"#;
