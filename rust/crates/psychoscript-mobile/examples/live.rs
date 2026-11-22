//! A live loop through the bindings' Rust surface, and its costs:
//!
//! ```sh
//! cargo run --release -p psychoscript-mobile --example live
//! ```
//!
//! - wake-to-post latency: `deliver` a message to a program waiting in `__host.receive()` until its `__host.post`
//!   reaches the handler;
//! - a 60 fps loop driven by delivered frame messages, the program drawing 50 commands a frame: time per frame and
//!   process CPU;
//! - the memory of an idle live run (waiting in `receive`).

use std::error::Error;
use std::sync::Mutex;
use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

use psychoscript_mobile::{LiveExit, LiveHandler, LiveOptions, Program};

const ECHO: &str = "while (true) __host.post(await __host.receive())";

const FRAMES: &str = r##"
const { dots } = __input()
while (true) {
  const m = await __host.receive()
  if (m.type !== "frame") continue
  const t = m.frame.t, commands = [["rect", 0, 0, m.frame.width, m.frame.height, { fill: "bg" }]]
  for (let i = 0; i < dots; i++) {
    const a = t * 2 + (i * Math.PI * 2) / dots
    commands.push(["circle", 180 + Math.cos(a) * 60, 80 + Math.sin(a) * 40, 4 + (i % 3), { fill: i % 2 ? "accent" : "#ff8800" }])
  }
  __host.post({ type: "draw", id: "c", commands })
  __host.post({ type: "frame" })
}
"##;

/// Sends the time each batch of posts arrives.
struct Timing(Mutex<Sender<Instant>>);

impl LiveHandler for Timing {
    fn on_posts_bytes(&self, _messages: Vec<Vec<u8>>) {}
    fn on_posts(&self, _messages_json: Vec<String>) {
        let _ = self.0.lock().map(|tx| tx.send(Instant::now()));
    }
    fn on_warning(&self, message: String) {
        eprintln!("warning: {message}");
    }
    fn on_exit(&self, exit: LiveExit) {
        if !matches!(exit, LiveExit::Stopped) {
            eprintln!("exit: {exit:?}");
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    // Wake to post.
    let (tx, posts) = channel();
    let options = LiveOptions::default();
    let echo = Program::new(ECHO.into(), "__input".into())?.start_live(
        "null".into(),
        Box::new(Timing(Mutex::new(tx))),
        options,
        None,
        None,
    )?;
    let mut latencies = Vec::new();
    for i in 0..2_000 {
        std::thread::sleep(Duration::from_micros(500));
        let sent = Instant::now();
        echo.deliver(format!(r#"{{"i":{i}}}"#))?;
        latencies.push(
            posts
                .recv_timeout(Duration::from_secs(1))?
                .duration_since(sent),
        );
    }
    echo.stop();
    report(
        "wake to post (deliver -> receive -> post -> on_posts)",
        latencies,
    );

    // 60 fps.
    let (tx, posts) = channel();
    let frames = Program::new(FRAMES.into(), "__input".into())?.start_live(
        r#"{"dots":48}"#.into(),
        Box::new(Timing(Mutex::new(tx))),
        LiveOptions::default(),
        None,
        None,
    )?;
    let cpu0 = cpu_seconds();
    let start = Instant::now();
    let mut per_frame = Vec::new();
    let count = 600;
    for i in 0..count {
        let due = start + Duration::from_secs_f64(i as f64 / 60.0);
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
        let sent = Instant::now();
        frames.deliver(format!(
            r#"{{"type":"frame","frame":{{"id":"c","t":{},"dt":0.0167,"width":360,"height":160,"scale":3,"pointer":null,"dark":true}}}}"#,
            i as f64 / 60.0
        ))?;
        per_frame.push(
            posts
                .recv_timeout(Duration::from_secs(1))?
                .duration_since(sent),
        );
    }
    let wall = start.elapsed().as_secs_f64();
    let cpu = cpu_seconds() - cpu0;
    // Paused: nothing should run.
    frames.pause()?;
    let paused_cpu0 = cpu_seconds();
    std::thread::sleep(Duration::from_secs(2));
    let paused_cpu = cpu_seconds() - paused_cpu0;
    frames.stop();
    report("60 fps frame (deliver -> 50 commands posted)", per_frame);
    println!(
        "60 fps: {:.1}% of one core over {wall:.1} s, {:.2} ms CPU per frame (whole process: this loop and the run)",
        cpu / wall * 100.0,
        cpu * 1000.0 / count as f64
    );
    println!("paused: {:.0} ms of CPU over 2 s", paused_cpu * 1000.0);

    // Idle live runs.
    let program = Program::new(FRAMES.into(), "__input".into())?;
    std::thread::sleep(Duration::from_millis(100));
    let before = rss_kb();
    let mut runs = Vec::new();
    let mut handlers = Vec::new();
    for _ in 0..100 {
        let (tx, rx) = channel();
        handlers.push(rx);
        runs.push(program.start_live(
            r#"{"dots":48}"#.into(),
            Box::new(Timing(Mutex::new(tx))),
            LiveOptions::default(),
            None,
            None,
        )?);
    }
    std::thread::sleep(Duration::from_millis(200));
    let after = rss_kb();
    println!(
        "idle live run: {} KB resident each (100 runs waiting in receive)",
        after.saturating_sub(before) / 100
    );
    Ok(())
}

fn report(what: &str, mut times: Vec<Duration>) {
    times.sort();
    let n = times.len();
    let mean = times.iter().sum::<Duration>() / n as u32;
    println!(
        "{what}: mean {mean:?}, p50 {:?}, p99 {:?}, max {:?} ({n} runs)",
        times[n / 2],
        times[n * 99 / 100],
        times[n - 1]
    );
}

/// The process's CPU time so far: `/proc` on Linux, `ps` elsewhere.
fn cpu_seconds() -> f64 {
    if let Ok(stat) = std::fs::read_to_string("/proc/self/stat") {
        let fields: Vec<&str> = stat
            .rsplit(')')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect();
        let ticks: f64 = fields.get(11..13).map_or(0.0, |f| {
            f.iter().filter_map(|x| x.parse::<f64>().ok()).sum()
        });
        return ticks / 100.0;
    }
    let out = ps("cputime=");
    // [[hh:]mm:]ss.cc
    out.trim().split(':').fold(0.0, |acc, part| {
        acc * 60.0 + part.parse::<f64>().unwrap_or(0.0)
    })
}

fn rss_kb() -> u64 {
    ps("rss=").trim().parse().unwrap_or(0)
}

fn ps(field: &str) -> String {
    std::process::Command::new("ps")
        .args(["-o", field, "-p", &std::process::id().to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}
