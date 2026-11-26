//! `Runtime::program_lines` (Rust only): an error raised in the host's code around the program, or by a host function
//! it calls, is located at the nearest frame of the program; `Call::location` too. Without it, nothing changes.

use psychoscript::{Diagnostic, HostError, HostFunction, HostValue, Runtime};
use serde_json::json;

/// Lines 1 to 3 are the host's (a prelude), 4 to 7 the program's, 8 the host's entry call.
const PRELUDE: &str = "const pre = { read: (o) => o.x, fail: () => { throw new TypeError(\"bad\") }, call: () => sync(), later: async () => await later() }
const here = () => site()
// the prelude's end
";

fn program(body: &str) -> String {
    format!("{PRELUDE}async function main() {{\n  await null\n  {body}\n}}\nreturn await main()")
}

fn runtime() -> Runtime {
    let located = || HostError::located("Error", "denied");
    Runtime::make()
        .globals(move |_| {
            [
                (
                    "sync",
                    HostValue::from(HostFunction::new(move |_, _| -> psychoscript::HostResult {
                        Err(located())
                    })),
                ),
                (
                    "later",
                    HostValue::from(HostFunction::new_async(move |_, _| async move {
                        let HostValue::Located(mut e) = located() else {
                            unreachable!()
                        };
                        e.fields
                            .push(("kind".into(), HostValue::from("CapabilityDenied")));
                        Err(HostValue::Located(e))
                    })),
                ),
                (
                    "site",
                    HostValue::from(HostFunction::new(|_, call| {
                        let (line, column) = call.location().unwrap_or((0, 0));
                        HostValue::Array(vec![
                            Some(HostValue::from(line as f64)),
                            Some(HostValue::from(column as f64)),
                        ])
                    })),
                ),
            ]
        })
        .program_lines(4, 7)
}

fn error(rt: &Runtime, code: &str) -> Diagnostic {
    match rt.execute(code).result {
        Ok(v) => panic!("expected a failure, got {v}"),
        Err(e) => e,
    }
}

#[test]
fn an_error_raised_in_the_hosts_code_is_at_the_programs_call() {
    let rt = runtime();
    for (body, message) in [
        // The VM's own error, in a prelude function.
        (
            "pre.read(null)",
            "TypeError: Cannot read properties of null (reading 'x'). (line 6, col 3)",
        ),
        // A throw in the prelude.
        ("pre.fail()", "TypeError: bad (line 6, col 3)"),
        // A located error from a synchronous host function the prelude calls.
        ("pre.call()", "Error: denied (line 6, col 3)"),
        // From an asynchronous one: where the call was made.
        ("await pre.later()", "Error: denied (line 6, col 9)"),
    ] {
        let e = error(&rt, &program(body));
        assert_eq!(
            (e.message_lossy(), e.location),
            (
                message.to_owned(),
                Some((6, 3 + 6 * body.starts_with("await") as u32))
            ),
            "{body}"
        );
    }
}

#[test]
fn a_host_call_from_the_hosts_code_is_at_the_programs_call() {
    let rt = runtime();
    let v = rt
        .execute(program("return here()").as_str())
        .result
        .unwrap();
    assert_eq!(v.to_json(), json!([6, 10]));
    // One the program makes itself is where it is.
    let v = rt
        .execute(program("return site()").as_str())
        .result
        .unwrap();
    assert_eq!(v.to_json(), json!([6, 10]));
}

#[test]
fn a_located_host_error_keeps_its_fields() {
    let rt = runtime();
    let v = rt
        .execute(
            program(
                "try { await later() } catch (e) { return [e instanceof Error, e.message, e.kind] }",
            )
            .as_str(),
        )
        .result
        .unwrap();
    assert_eq!(v.to_json(), json!([true, "denied", "CapabilityDenied"]));
}

#[test]
fn without_program_lines_the_hosts_code_is_located_as_before() {
    let rt = Runtime::make();
    // The VM's error where it is raised, in the prelude; a throw of the program's own error, at no line.
    let e = error(&rt, &program("pre.read(null)"));
    assert_eq!(e.location, Some((1, 28)), "{}", e.message_lossy());
    let e = error(&rt, &program("pre.fail()"));
    assert_eq!(
        (e.message_lossy(), e.location),
        ("TypeError: bad".into(), None)
    );
}
