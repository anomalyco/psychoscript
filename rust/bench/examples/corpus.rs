//! What a typical program costs, by phase: the programs of `bench/corpus`, short snippets of the kind a model writes
//! (a few tool calls and the glue between them), against a host whose tools answer at once with canned data.
//!
//! Usage: `corpus [--runs N] [--only NAME]`. Per program, the median instructions retired by: compiling it (`Runtime::compile`),
//! running it compiled (a fresh runtime's setup, the program, its host calls), and both from source (`execute`).
//! The last program, `return 1`, is the setup alone, which the "program" column takes off the others.

use psychoscript::{HostFunction, HostValue, Namespace, Resolved, Runtime};

#[path = "../src/counters.rs"]
mod counters;

/// Canned text of 16, 24 or 240 lines, each made once: the host's own work is not what this measures, beyond the
/// copy a host makes to hand its text over.
fn text(lines: usize) -> String {
    static TEXTS: [std::sync::OnceLock<String>; 3] = [const { std::sync::OnceLock::new() }; 3];
    let slot = match lines {
        16 => 0,
        24 => 1,
        _ => 2,
    };
    TEXTS[slot]
        .get_or_init(|| {
            (0..[16, 24, 240][slot])
                .map(|i| match i % 4 {
                    0 => format!("fn item_{i}(value: usize) -> usize {{ value + {i} }}\n"),
                    1 => format!("warn line {i} of the log: something happened\n"),
                    2 => format!("    let mut total_{i} = {i} * 2; // version = \"0.{i}.1\"\n"),
                    _ => format!("dep_{i} = \"1.{i}\"\n"),
                })
                .collect()
        })
        .clone()
}

fn str_arg(args: &[HostValue], key: &str) -> String {
    args.first()
        .and_then(|a| a.get(key))
        .and_then(HostValue::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn tools() -> Namespace {
    let shell = HostFunction::new_async(|args, _| async move {
        let command = str_arg(&args, "command");
        let output = if command.contains("--json") {
            let rows: Vec<String> = (0..9)
                .map(|i| {
                    format!(
                        "{{\"slug\":\"case-{i}\",\"median_ms\":{}.25,\"median_instructions\":{}}}",
                        i * 3,
                        1_000_000 * (i + 1)
                    )
                })
                .collect();
            format!("[{}]", rows.join(","))
        } else if command.starts_with("ls") {
            (0..24).map(|i| format!("file_{i}.rs\n")).collect()
        } else {
            text(24)
        };
        Ok(HostValue::object([
            ("output", HostValue::from(output)),
            ("exitCode", HostValue::Number(0.0)),
        ]))
    })
    .length(1);
    let read = HostFunction::new_async(|_, _| async move {
        Ok(HostValue::object([
            ("type", HostValue::from("text")),
            ("content", HostValue::from(text(240))),
        ]))
    })
    .length(1);
    let done = HostFunction::new_async(|_, _| async move { Ok(HostValue::from("ok")) }).length(1);
    let websearch = HostFunction::new_async(|_, _| async move {
        Ok(HostValue::array((0..6).map(|i| {
            HostValue::object([
                ("url", HostValue::from(format!("https://example.com/{i}"))),
                ("title", HostValue::from(format!("Result {i}"))),
                ("content", HostValue::from(text(16))),
            ])
        })))
    })
    .length(1);
    Namespace::new(
        |_| Ok(Vec::new()),
        move |path| -> Resolved {
            match path {
                [f] if f == "shell" => shell.clone().into(),
                [f] if f == "read" => read.clone().into(),
                [f] if f == "websearch" => websearch.clone().into(),
                _ => done.clone().into(),
            }
        },
    )
}

fn median(mut v: Vec<u64>) -> u64 {
    v.sort_unstable();
    v[v.len() / 2]
}

fn main() {
    let mut runs = 201usize;
    let mut only = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--runs" => runs = args.next().and_then(|n| n.parse().ok()).expect("--runs N"),
            "--only" => only = args.next().expect("--only NAME"),
            other => panic!("unknown argument {other}"),
        }
    }
    let runtime = Runtime::make().globals(|_| [("tools", HostValue::from(tools()))]);
    let dir = format!("{}/corpus", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("bench/corpus")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".js") && (n.contains(&only) || n.starts_with("16-")))
        .collect();
    names.sort();
    let measure = |f: &mut dyn FnMut()| {
        f();
        median(
            (0..runs)
                .map(|_| {
                    let before = counters::instructions();
                    f();
                    counters::instructions() - before
                })
                .collect(),
        )
    };
    let mut rows = Vec::new();
    for name in &names {
        let code = std::fs::read_to_string(format!("{dir}/{name}")).expect("a program");
        let outcome = runtime.execute(code.as_str());
        if let Err(d) = &outcome.result {
            panic!("{name} failed: {}", d.message_lossy());
        }
        let compiled = runtime
            .compile(&code)
            .unwrap_or_else(|d| panic!("{name}: {d:?}"));
        let compile = measure(&mut || drop(runtime.compile(&code)));
        let run = measure(&mut || drop(runtime.execute(&compiled)));
        let both = measure(&mut || drop(runtime.execute(code.as_str())));
        rows.push((
            name.trim_end_matches(".js").to_owned(),
            code.len(),
            compile,
            run,
            both,
        ));
    }
    let setup = rows.last().map_or(0, |r| r.3);
    println!(
        "{:<22} {:>6} {:>10} {:>10} {:>10} {:>10}",
        "program", "bytes", "compile", "setup", "program", "total"
    );
    let (mut c, mut s, mut p, mut t) = (0, 0, 0, 0);
    for (name, bytes, compile, run, both) in &rows {
        let program = run.saturating_sub(setup);
        println!("{name:<22} {bytes:>6} {compile:>10} {setup:>10} {program:>10} {both:>10}");
        c += compile;
        s += setup;
        p += program;
        t += both;
    }
    let pct = |x: u64| 100.0 * x as f64 / (c + s + p) as f64;
    println!("{:<22} {:>6} {c:>10} {s:>10} {p:>10} {t:>10}", "sum", "");
    println!(
        "{:<22} {:>6} {:>9.0}% {:>9.0}% {:>9.0}%",
        "share",
        "",
        pct(c),
        pct(s),
        pct(p)
    );
}
