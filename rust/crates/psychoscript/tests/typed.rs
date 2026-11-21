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
    let rt = Runtime::make();
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
        Runtime::make().limits(Limits {
            max_heap_bytes: Some(bytes),
            ..Limits::default()
        })
    };
    // 64 for the Float32Array, 4000 for its buffer, 64 for its ArrayBuffer and 64 for the view that shares it.
    let code = "Math.kept = new Float32Array(1000); Math.view = Math.kept.subarray(10); return 1";
    assert!(capped(4192).execute(code).result.is_ok());
    let error = capped(4191).execute(code).result.unwrap_err();
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

/// A runtime whose `upload(view)` sums the bytes it borrows in place and keeps the handle, `scale(view, k)` multiplies
/// each element in place, `mesh()` returns a Float32Array over bytes the host keeps, and `poke(x)` writes `x` into the
/// first element of the last kept handle.
fn gpu() -> (Runtime, Arc<Mutex<Vec<TypedArray>>>) {
    let kept: Arc<Mutex<Vec<TypedArray>>> = Arc::default();
    let k = kept.clone();
    let rt = Runtime::make().globals(move |_| {
        let (upload, mesh, poke) = (k.clone(), k.clone(), k.clone());
        [
            (
                "upload",
                HostFunction::new(move |args, _| match &args[0] {
                    HostValue::TypedArray(t) => {
                        upload.lock().unwrap().push(t.clone());
                        let sum: u64 = t.with_bytes(|b| b.iter().map(|x| *x as u64).sum());
                        HostValue::Number(sum as f64)
                    }
                    other => panic!("expected a typed array, got {other:?}"),
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
                "mesh",
                HostFunction::new(move |_, _| {
                    let t = TypedArray::from_f32(&[1.0, 2.0, 3.0]);
                    mesh.lock().unwrap().push(t.clone());
                    HostValue::TypedArray(t)
                }),
            ),
            (
                "poke",
                HostFunction::new(move |args, _| {
                    let x = args[0].as_f64().unwrap_or(0.0) as f32;
                    if let Some(t) = poke.lock().unwrap().last() {
                        t.with_bytes_mut(|b| b[..4].copy_from_slice(&x.to_le_bytes()));
                    }
                    HostValue::Undefined
                }),
            ),
        ]
    });
    (rt, kept)
}

#[test]
fn a_host_function_reads_and_writes_a_typed_array_in_place() {
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
    // The handle still views the program's bytes, as scaled after the call.
    assert_eq!(view.values(), vec![20.0, 30.0]);
}

#[test]
fn an_array_buffer_and_every_typed_array_but_uint8array_cross_without_a_copy() {
    let (rt, kept) = gpu();
    value(
        &rt,
        "const b = new ArrayBuffer(4); upload(b); upload(new Int32Array(b)); upload(new Float64Array(1)); return 1",
    );
    let kinds: Vec<TypedKind> = kept.lock().unwrap().iter().map(TypedArray::kind).collect();
    assert_eq!(
        kinds,
        vec![TypedKind::ArrayBuffer, TypedKind::I32, TypedKind::F64]
    );
    // A Uint8Array is a copy, as before.
    let seen: Arc<Mutex<Option<HostValue>>> = Arc::default();
    let s = seen.clone();
    let rt = Runtime::make().globals(move |_| {
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
fn a_typed_array_a_host_function_returns_is_a_view_of_the_host_bytes() {
    let (rt, _) = gpu();
    // The host writes through the handle it kept: the program sees it, and the reverse.
    let v = value(
        &rt,
        "const m = mesh(); const before = m[0]; poke(42); m[1] = 7; \
         return [m.constructor.name, before, m[0], m.length, m.byteLength, upload(m.subarray(1, 2))]",
    );
    // 7 as float32 is 0,0,224,64.
    assert_eq!(v, json!(["Float32Array", 1, 42, 3, 12, 224 + 64]));
    let t = TypedArray::new(TypedKind::U16, vec![1, 0, 2]);
    assert!(t.is_none(), "three bytes are not whole Uint16 elements");
}
