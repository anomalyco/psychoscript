//! Typed arrays and `ArrayBuffer`: their semantics (also in the conformance cases), the heap cap, and the host's
//! zero-copy access to their bytes (`HostValue::TypedArray`).

use std::sync::{Arc, Mutex};

use psychoscript::{
    DiagnosticKind, HostFunction, HostValue, Limits, Runtime, TypedArray, TypedKind,
};
use serde_json::json;

fn value(rt: &Runtime, code: &str) -> psychoscript::Json {
    match rt.execute(code).result {
        Ok(v) => v.to_json(),
        Err(d) => panic!("{code}: {}", d.message_lossy()),
    }
}

#[test]
fn elements_round_and_wrap_and_views_share_their_buffer() {
    let rt = Runtime::make().typed_arrays(true);
    assert_eq!(
        value(
            &rt,
            "const f = new Float32Array(2); f[0] = 1.1; f[1] = 16777217; \
             const u = new Uint16Array([-1, 65537]); const i = new Int32Array([2 ** 31]); \
             return [f[0], f[1], u[0], u[1], i[0], new Uint32Array([-1])[0]]"
        ),
        json!([
            1.100000023841858,
            16777216,
            65535,
            1,
            -2147483648,
            4294967295u32
        ])
    );
    assert_eq!(
        value(
            &rt,
            "const b = new ArrayBuffer(8); const f = new Float32Array(b); const u = new Uint8Array(b, 4); \
             f[1] = 1; const s = f.subarray(1); s[0] = 2; \
             return [Array.from(u), f[1], s.buffer === b, f.buffer === b, f[2], f[-1], f.length, s.byteOffset]"
        ),
        json!([[0, 0, 0, 64], 2, true, true, null, null, 2, 4])
    );
}

#[test]
fn storage_counts_against_the_heap_cap_once_per_buffer() {
    let capped = |bytes| {
        Runtime::make().typed_arrays(true).limits(Limits {
            max_heap_bytes: Some(bytes),
            ..Limits::default()
        })
    };
    // 64 for the Float32Array, 4000 for its buffer, and 64 for the view that shares it.
    let code = "Math.kept = new Float32Array(1000); Math.view = Math.kept.subarray(10); return 1";
    assert!(capped(4128).execute(code).result.is_ok());
    let error = capped(4127).execute(code).result.unwrap_err();
    assert_eq!(error.kind, DiagnosticKind::MemoryLimitExceeded);
    // A growing set of buffers stops the run; buffers that become garbage don't count.
    let grow = "const kept = []; while (true) kept.push(new Float64Array(1000))";
    assert_eq!(
        capped(1_000_000).execute(grow).result.unwrap_err().kind,
        DiagnosticKind::MemoryLimitExceeded
    );
    let churn = "let s = 0; for (let i = 0; i < 2000; i++) { const f = new Float64Array(1000); f[0] = i; s += f[0] } return s";
    assert_eq!(value(&capped(1_000_000), churn), json!(1999000));
}

type Kept = Arc<Mutex<Vec<TypedArray>>>;

/// A runtime whose `upload(...views)` sums the bytes of each view it borrows and keeps the handles, `scale(view, k)`
/// multiplies each element in place, `later(view)` is async and keeps its handle, `mesh()` returns a Float32Array of
/// bytes the host made and keeps a handle on it, `echo(view)` returns the handle it got, and `stale()` returns the
/// handle kept first.
fn gpu() -> (Runtime, Kept) {
    let kept: Kept = Arc::default();
    let k = kept.clone();
    let rt = Runtime::make().typed_arrays(true).globals(move |_| {
        let (upload, later, mesh, stale) = (k.clone(), k.clone(), k.clone(), k.clone());
        [
            (
                "upload",
                HostFunction::new(move |args, _| {
                    let mut sum = 0u64;
                    for a in &args {
                        let HostValue::TypedArray(t) = a else {
                            panic!("expected a typed array, got {a:?}")
                        };
                        upload.lock().unwrap().push(t.clone());
                        sum += t.with_bytes(|b| b.iter().map(|x| *x as u64).sum::<u64>());
                    }
                    HostValue::Number(sum as f64)
                }),
            ),
            (
                "scale",
                HostFunction::new(|args, _| {
                    let HostValue::TypedArray(t) = &args[0] else {
                        panic!("expected a typed array")
                    };
                    let k = args[1].as_f64().unwrap_or(1.0);
                    let kind = t.kind();
                    t.with_bytes_mut(|b| {
                        for c in b.chunks_exact_mut(kind.size()) {
                            let v = kind.read(c);
                            kind.write(v * k, c);
                        }
                    });
                    HostValue::Undefined
                }),
            ),
            (
                "later",
                HostFunction::new_async(move |args, _| {
                    let HostValue::TypedArray(t) = args[0].clone() else {
                        panic!("expected a typed array")
                    };
                    later.lock().unwrap().push(t.clone());
                    async move {
                        t.with_bytes_mut(|b| b.fill(0));
                        Ok(HostValue::Number(t.byte_len() as f64))
                    }
                }),
            ),
            (
                "mesh",
                HostFunction::new(move |_, _| {
                    let t = TypedArray::from_f32(&[1.0, 2.0, 3.0]);
                    mesh.lock().unwrap().push(t.clone());
                    HostValue::TypedArray(t)
                }),
            ),
            ("echo", HostFunction::new(|args, _| args[0].clone())),
            (
                "stale",
                HostFunction::new(move |_, _| {
                    HostValue::TypedArray(stale.lock().unwrap()[0].clone())
                }),
            ),
        ]
    });
    (rt, kept)
}

#[test]
fn a_synchronous_host_function_borrows_the_bytes_for_the_call() {
    let (rt, kept) = gpu();
    let v = value(
        &rt,
        "const f = new Float32Array([1, 2, 3, 4]); const sum = upload(f.subarray(1, 3)); \
         scale(f, 10); return [sum, Array.from(f)]",
    );
    // The bytes of 2 and 3 as float32: 0,0,0,64 and 0,0,64,64.
    assert_eq!(v, json!([64 + 128, [10, 20, 30, 40]]));
    let kept = kept.lock().unwrap();
    let view = &kept[0];
    assert_eq!(
        (view.kind(), view.len(), view.byte_len()),
        (TypedKind::F32, 2, 8)
    );
    // Once the call returned, the bytes are the program's again: the handle is empty.
    assert!(view.to_vec().is_empty());
}

#[test]
fn views_of_one_buffer_in_one_call_borrow_it_together() {
    let (rt, kept) = gpu();
    // The ArrayBuffer and two views of it, in the same call: each sees the bytes.
    let v = value(
        &rt,
        "const b = new ArrayBuffer(8); const f = new Float32Array(b); f[0] = 2; f[1] = 2; \
         return upload(b, new Int32Array(b, 4), f)",
    );
    // 2 as float32 is 0,0,0,64: 128 for the buffer, 64 for the Int32Array of its second half, 128 for the Float32Array.
    assert_eq!(v, json!(128 + 64 + 128));
    let kinds: Vec<TypedKind> = kept.lock().unwrap().iter().map(TypedArray::kind).collect();
    assert_eq!(
        kinds,
        vec![TypedKind::ArrayBuffer, TypedKind::I32, TypedKind::F32]
    );
}

#[test]
fn an_async_host_function_gets_a_copy() {
    let (rt, kept) = gpu();
    let v = value(
        &rt,
        "const f = new Float32Array([1, 2]); const n = await later(f); return [n, Array.from(f)]",
    );
    // Its write went to its copy, which it keeps.
    assert_eq!(v, json!([8, [1, 2]]));
    assert_eq!(kept.lock().unwrap()[0].values(), vec![0.0, 0.0]);
}

#[test]
fn a_returned_typed_array_is_the_program_s() {
    let (rt, kept) = gpu();
    // Bytes the host made become the program's: the host's handle is empty after the call.
    let v = value(
        &rt,
        "const m = mesh(); m[1] = 7; return [m.constructor.name, Array.from(m), m.byteLength, m.buffer.byteLength]",
    );
    assert_eq!(v, json!(["Float32Array", [1, 7, 3], 12, 12]));
    assert!(kept.lock().unwrap()[0].to_vec().is_empty());
    // A handle the call got is the program's buffer again.
    let v = value(
        &rt,
        "const f = new Float32Array([1, 2, 3]); const r = echo(f.subarray(1)); r[0] = 9; \
         return [r === f, r.buffer === f.buffer, Array.from(f), r.length]",
    );
    assert_eq!(v, json!([false, true, [1, 9, 3], 2]));
    // One kept past its call has no bytes left to give.
    let o = rt.execute("stale()");
    let error = o.result.unwrap_err();
    assert!(
        error.message_lossy().contains("whose bytes are gone"),
        "{}",
        error.message_lossy()
    );
    assert!(TypedArray::new(TypedKind::U16, vec![1, 0, 2]).is_none());
}

#[test]
fn a_uint8array_crosses_as_a_copy() {
    let seen: Arc<Mutex<Option<HostValue>>> = Arc::default();
    let s = seen.clone();
    let rt = Runtime::make().typed_arrays(true).globals(move |_| {
        let s = s.clone();
        [(
            "take",
            HostFunction::new(move |args, _| {
                *s.lock().unwrap() = args.into_iter().next();
                HostValue::Undefined
            }),
        )]
    });
    value(&rt, "take(new Uint8Array([1, 2])); return 1");
    assert!(matches!(&*seen.lock().unwrap(), Some(HostValue::Bytes(b)) if b == &[1, 2]));
}

#[test]
fn without_typed_arrays_programs_and_host_functions_behave_as_before_they_were_added() {
    let rt = Runtime::make().globals(|_| {
        [
            (
                "wide",
                HostFunction::new(|_, _| {
                    HostValue::TypedArray(TypedArray::new(TypedKind::U16, vec![7, 0]).unwrap())
                }),
            ),
            (
                "nested",
                HostFunction::new(|_, _| {
                    let i = TypedArray::new(TypedKind::I32, vec![0; 4]).unwrap();
                    HostValue::object([("list", HostValue::array([HostValue::TypedArray(i)]))])
                }),
            ),
            (
                "buf",
                HostFunction::new(|_, _| {
                    HostValue::TypedArray(
                        TypedArray::new(TypedKind::ArrayBuffer, vec![5, 6]).unwrap(),
                    )
                }),
            ),
        ]
    });
    let names = [
        "ArrayBuffer",
        "Uint16Array",
        "Uint32Array",
        "Int32Array",
        "Float32Array",
        "Float64Array",
    ];
    let types = names.map(|n| format!("typeof {n}")).join(", ");
    assert_eq!(
        value(&rt, &format!("return [{types}, typeof Uint8Array]")),
        json!([
            "undefined",
            "undefined",
            "undefined",
            "undefined",
            "undefined",
            "undefined",
            "function"
        ])
    );
    for (code, column) in [("new Float32Array(1)", 5), ("Float32Array = 1", 1)] {
        let e = rt.execute(code).result.unwrap_err();
        assert_eq!(
            e.message_lossy(),
            format!("ReferenceError: Unknown identifier 'Float32Array'. (line 1, col {column})")
        );
    }
    assert!(
        names
            .iter()
            .all(|n| !psychoscript::global_names().contains(n))
    );
    let e = rt.execute("const w = wide()").result.unwrap_err();
    assert_eq!(
        (e.kind.name(), e.message_lossy(), e.location),
        (
            DiagnosticKind::ExecutionFailure.name(),
            "TypeError: wide produced a Uint16Array, which the program cannot hold. (line 1, col 11)".into(),
            Some((1, 11))
        )
    );
    assert_eq!(
        value(&rt, "try { nested() } catch (e) { return e.message }"),
        json!("nested.list[0] produced an Int32Array, which the program cannot hold.")
    );
    assert_eq!(
        value(
            &rt,
            "const b = buf(); return [b instanceof Uint8Array, Array.from(b)]"
        ),
        json!([true, [5, 6]])
    );
    assert_eq!(
        value(
            &rt,
            "const u = new Uint8Array(2); u[-1] = 5; u[1.5] = 6; \
             return [u.byteLength, u.byteOffset, u.buffer, Object.keys(u), u[-1], 'byteLength' in u]"
        ),
        json!([2, 0, null, ["0", "1", "-1", "1.5"], 5, true])
    );
}
