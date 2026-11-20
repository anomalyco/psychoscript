use std::sync::Arc;

use psychoscript_mobile::{Program, PsychoScriptError, RunOptions};

fn program(source: &str) -> Program {
    Program::new(source.into(), "__input".into()).unwrap()
}

fn run(source: &str, input: &str) -> Result<String, PsychoScriptError> {
    program(source).run(input.into(), RunOptions::default())
}

#[test]
fn runs_with_its_input() {
    assert_eq!(
        run(
            "const x = __input(); return { sum: x.a + x.b, tag: x.tag }",
            r#"{"a":1,"b":2.5,"tag":"t"}"#
        )
        .unwrap(),
        r#"{"sum":3.5,"tag":"t"}"#
    );
    assert_eq!(run("__input() + 1", "41").unwrap(), "42");
    assert_eq!(run("let x = 1", "null").unwrap(), "null");
    assert_eq!(
        run(
            "return [__input(), __input()]",
            r#"{"k":[1,"é",null,true]}"#
        )
        .unwrap(),
        r#"[{"k":[1,"é",null,true]},{"k":[1,"é",null,true]}]"#
    );
    assert_eq!(
        run("return __input()", r#"{"a":1,"b":2,"a":3}"#).unwrap(),
        r#"{"a":3,"b":2}"#
    );
    assert_eq!(
        run("return Object.keys(__input())", r#"{"z":1,"a":2}"#).unwrap(),
        r#"["z","a"]"#
    );
    let named = Program::new("return input().n * 2".into(), "input".into()).unwrap();
    assert_eq!(
        named
            .run(r#"{"n":21}"#.into(), RunOptions::default())
            .unwrap(),
        "42"
    );
}

#[test]
fn runs_again_and_concurrently() {
    let program = Arc::new(program(
        "let n = 0; for (let i = 0; i < 20000; i++) n += i % 7; return [__input(), n]",
    ));
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let program = program.clone();
            std::thread::spawn(move || {
                (0..20)
                    .map(|_| program.run(t.to_string(), RunOptions::default()).unwrap())
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    for (t, thread) in threads.into_iter().enumerate() {
        for out in thread.join().unwrap() {
            assert_eq!(out, format!("[{t},59997]"));
        }
    }
}

#[test]
fn fails_with_a_kind_and_message() {
    match Program::new("return (".into(), "__input".into()) {
        Err(PsychoScriptError::Syntax {
            kind,
            line: Some(1),
            ..
        }) => assert_eq!(kind, "ParseError"),
        other => panic!("{other:?}"),
    }
    match run("const x = __input()\nx.missing.field", "{}") {
        Err(PsychoScriptError::Runtime {
            kind,
            reason: message,
            line,
            ..
        }) => {
            assert_eq!(kind, "ExecutionFailure");
            assert!(message.starts_with("TypeError"), "{message}");
            assert_eq!(line, Some(2));
        }
        other => panic!("{other:?}"),
    }
    match run("throw new RangeError('too far')", "{}") {
        Err(PsychoScriptError::Runtime {
            reason: message, ..
        }) => assert!(
            message.contains("RangeError") && message.contains("too far"),
            "{message}"
        ),
        other => panic!("{other:?}"),
    }
    let spin = program("while (true) {}");
    let timeout = RunOptions {
        timeout_ms: Some(20),
        ..Default::default()
    };
    assert!(matches!(
        spin.run("{}".into(), timeout),
        Err(PsychoScriptError::Timeout { timeout_ms: 20, .. })
    ));
    let zero = RunOptions {
        timeout_ms: Some(0),
        ..Default::default()
    };
    assert!(matches!(
        spin.run("{}".into(), zero),
        Err(PsychoScriptError::InvalidInput { .. })
    ));
    let big = program("return 'x'.repeat(__input())");
    let cap = RunOptions {
        max_output_bytes: Some(100),
        ..Default::default()
    };
    assert_eq!(big.run("98".into(), cap.clone()).unwrap().len(), 100);
    assert!(matches!(
        big.run("99".into(), cap),
        Err(PsychoScriptError::OutputTooLarge {
            max_output_bytes: 100,
            ..
        })
    ));
    assert!(matches!(
        big.run("{".into(), RunOptions::default()),
        Err(PsychoScriptError::InvalidInput { .. })
    ));
}
