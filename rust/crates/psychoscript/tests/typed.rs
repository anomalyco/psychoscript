//! Typed arrays and `ArrayBuffer`: their semantics (the programs of `tests/cases/typed-array-*.js` and the typed-array
//! bench programs), the heap cap, and the host's zero-copy access to their bytes (`HostValue::TypedArray`).

use std::sync::{Arc, Mutex};

use psychoscript::{
    Data, DiagnosticKind, DurableFunction, HostFunction, HostValue, Limits, Runtime, TypedArray,
    TypedKind,
};
use serde_json::json;

#[path = "../../../conformance/reference.rs"]
mod reference;
mod support;

fn value(rt: &Runtime, code: &str) -> psychoscript::Json {
    match rt.execute(code).result {
        Ok(v) => v.to_json(),
        Err(d) => panic!("{code}: {}", d.message_lossy()),
    }
}

/// The programs `tests/cases/typed-array-*.js` and `bench/typed/*.js`, with typed arrays and the `tools` namespace of
/// `conformance/reference.rs` (`tools.upload` sums the bytes it borrows), some under a heap cap: what each returns or
/// how it fails, and what it logs.
#[test]
fn programs() {
    let runtime = |cap: Option<u64>| {
        Runtime::make()
            .globals(|_| [("tools", HostValue::from(reference::tools()))])
            .limits(Limits {
                max_heap_bytes: cap,
                ..Limits::default()
            })
    };
    macro_rules! case {
        ($path:literal, $cap:expr, $expected:expr, $logs:expr) => {
            support::check(&runtime($cap), $path, include_str!($path), $expected, $logs)
        };
    }
    case!(
        "cases/typed-array-construct.js",
        None,
        Ok(json!([
            [
                ["Uint8Array", 1, 1, 3, 3],
                ["Uint16Array", 2, 2, 6, 3],
                ["Uint32Array", 4, 4, 12, 3],
                ["Int32Array", 4, 4, 12, 3],
                ["Float32Array", 4, 4, 12, 3],
                ["Float64Array", 8, 8, 24, 3]
            ],
            [1, 2, 3],
            [4, 5],
            [4, 0, 16],
            [3, 4, 6],
            [1, 8],
            [10.333333015441895, 11.666666984558105, 13],
            [1, 2, 1],
            [0, 0, 0],
            [16, 1, 2, 0]
        ])),
        &[]
    );
    case!(
        "cases/typed-array-convert.js",
        None,
        Ok(json!([
            [
                "1.100000023841858",
                "16777216",
                "Infinity",
                "-0.10000000149011612",
                "0",
                "2.5"
            ],
            [3, 65535, 1, 0, 0, 65535],
            [4294967295u32, 5, 3, 4294967293u32, 0],
            [-2147483648, 2147483647, -3, -1, 12],
            ["0.1", "0.3333333333333333", "0", "Infinity"],
            [44, 255, 1, 255],
            [1.100000023841858, 2.200000047683716],
            true
        ])),
        &[]
    );
    case!(
        "cases/typed-array-errors.js",
        None,
        Ok(json!([
            [
                "RangeError: start offset of Float32Array should be a multiple of 4",
                "RangeError: byte length of Float32Array should be a multiple of 4",
                "RangeError: Start offset 20 is outside the bounds of the buffer",
                "RangeError: Start offset -4 is outside the bounds of the buffer",
                "RangeError: Invalid typed array length: 10",
                "RangeError: Invalid typed array length: -1",
                "RangeError: Invalid typed array length: -1",
                "ok",
                "ok",
                "TypeError: Constructor Float32Array requires 'new'.",
                "TypeError: Constructor ArrayBuffer requires 'new'.",
                "RangeError: Float32Array.set: the source does not fit at that offset.",
                "RangeError: Float32Array.set: the source does not fit at that offset.",
                "RangeError: Invalid array buffer length",
                "TypeError: Float32Array.prototype.at called on incompatible receiver an array.",
                "TypeError: Float32Array.prototype.at called on incompatible receiver an ArrayBuffer.",
                "TypeError: ArrayBuffer.prototype.slice called on incompatible receiver a Float32Array.",
                "TypeError: Uint8Array.prototype.toHex called on incompatible receiver a Float32Array.",
                "TypeError: Cannot set property 'length' of a Float32Array which has only a getter.",
                "TypeError: Cannot set property 'buffer' of a Float32Array which has only a getter.",
                "TypeError: fa.map is not a function.",
                "TypeError: fa.forEach is not a function.",
                "TypeError: TextDecoder.decode expects a Uint8Array, received a Float32Array.",
                "TypeError: Float32Array.from expects a function callback.",
                "ok",
                "TypeError: Cannot delete property '0'.",
                "TypeError: Accessor properties are not supported on array elements; store the value or use a plain object."
            ],
            null,
            4
        ])),
        &[]
    );
    case!(
        "cases/typed-array-from-like.js",
        None,
        Ok(json!([
            [1.5, null],
            [4],
            [0, 0],
            [],
            [
                "TypeError",
                "Uint32Array.from expects a Uint8Array, an array, an iterable, or an array-like of numbers, received null."
            ],
            [],
            ["RangeError", "Invalid typed array length: -1"],
            [16, 4, 2]
        ])),
        &[]
    );
    // 64 bytes for the Float32Array, 4000 for its buffer, and 64 for the subarray, which shares the buffer.
    case!(
        "cases/typed-array-heap-over.js",
        Some(4_127),
        Err(DiagnosticKind::MemoryLimitExceeded),
        &[]
    );
    case!(
        "cases/typed-array-heap-under.js",
        Some(4_128),
        Ok(json!(1000)),
        &[]
    );
    case!(
        "cases/typed-array-index.js",
        None,
        Ok(json!([
            [1.5, 2.25, 1, null, null, null, 1.5, 1, null, 7, 0, null],
            204.75,
            2,
            ["0", "1", "2"],
            3
        ])),
        &[]
    );
    let shared = "constructor,BYTES_PER_ELEMENT,length,byteLength,byteOffset,buffer,at,slice,subarray,set,fill,reverse,indexOf,lastIndexOf,includes,join,toString,keys,values,entries";
    let statics = "length,name,prototype,from,of,BYTES_PER_ELEMENT";
    case!(
        "cases/typed-array-keys.js",
        None,
        Ok(json!({
            "ArrayBuffer": "length,name,prototype,isView",
            "ArrayBuffer.prototype": "constructor,byteLength,slice",
            "Uint8Array": "length,name,prototype,from,of,fromBase64,fromHex,BYTES_PER_ELEMENT",
            "Uint8Array.prototype": "constructor,BYTES_PER_ELEMENT,length,byteLength,byteOffset,buffer,at,slice,subarray,set,fill,reverse,sort,toSorted,toReversed,with,copyWithin,indexOf,lastIndexOf,includes,join,toString,toBase64,toHex,setFromBase64,setFromHex,keys,values,entries,map,filter,forEach,some,every,find,findIndex,findLast,findLastIndex,reduce,reduceRight",
            "Uint16Array": statics,
            "Uint16Array.prototype": shared,
            "Uint32Array": statics,
            "Uint32Array.prototype": shared,
            "Int32Array": statics,
            "Int32Array.prototype": shared,
            "Float32Array": statics,
            "Float32Array.prototype": shared,
            "Float64Array": statics,
            "Float64Array.prototype": shared
        })),
        &[]
    );
    case!(
        "cases/typed-array-methods.js",
        None,
        Ok(json!([
            [4, 0.10000000149011612, 7, 8],
            [4, 0.5, 0.5, 8],
            1,
            2,
            1,
            true,
            -1,
            false,
            8,
            null,
            null,
            null,
            0.5,
            4,
            4,
            ["0", "1", "2", "3"],
            false,
            true,
            "4|0.5|0.5|8",
            "4,0.5,0.5,8",
            "1,-2",
            "4,0.5,0.5,8",
            [0, 1, 2, 3],
            [[0, 4], [1, 0.5], [2, 0.5], [3, 8]],
            [4, 0.5, 0.5, 8],
            [3, 2, 1],
            [9, 9],
            true,
            -1,
            6,
            11,
            9,
            [2, 4],
            "{\"0\":1.5,\"1\":2}",
            "{\"b\":{}}",
            "[object Float32Array]",
            "[object ArrayBuffer]",
            "object",
            false,
            true,
            true,
            false,
            true,
            "Float32Array",
            true
        ])),
        &[
            "Float32Array(2) [1.5,-2] Uint16Array(2) [0,0] ArrayBuffer { byteLength: 3 }",
            "[object ArrayBuffer]"
        ]
    );
    // A typed array cannot be a program's result: it asks for its values instead.
    case!(
        "cases/typed-array-result.js",
        None,
        Err(DiagnosticKind::InvalidDataValue),
        &[]
    );
    case!(
        "cases/typed-array-views.js",
        None,
        Ok(json!([
            [0, 0, 128, 63],
            true,
            true,
            2,
            2,
            4,
            true,
            8,
            2,
            false,
            0,
            8,
            7,
            true,
            16,
            257,
            2147483649u32,
            "0,0,0,64",
            false,
            4,
            0,
            true,
            false,
            false,
            false
        ])),
        &[]
    );
    case!(
        "../../../bench/typed/bench-host-bytes.js",
        None,
        Ok(json!(989211)),
        &[]
    );
    case!(
        "../../../bench/typed/bench-typed-fill.js",
        None,
        Ok(json!(25004250000u64)),
        &[]
    );
    case!(
        "../../../bench/typed/bench-typed-matrix.js",
        None,
        Ok(json!(-2500)),
        &[]
    );
    case!(
        "../../../bench/typed/bench-vertex-transform.js",
        None,
        Ok(json!(81.15693980455399)),
        &[]
    );
}

#[test]
fn programs_in_the_round_trip_mode() {
    support::in_round_trip_mode("programs");
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
    let rt = Runtime::make().globals(move |_| {
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
fn every_runtime_has_them_and_host_functions_return_them_as_views() {
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
        json!(vec!["function"; 7])
    );
    assert!(
        names
            .iter()
            .all(|n| psychoscript::global_names().contains(n))
    );
    // A built-in global, which a program cannot assign to.
    let e = rt.execute("Float32Array = 1").result.unwrap_err();
    assert_eq!(
        e.message_lossy(),
        "TypeError: Cannot assign to constant 'Float32Array'. (line 1, col 1)"
    );
    assert_eq!(
        value(
            &rt,
            "const w = wide(); return [w.constructor.name, Array.from(w), nested().list[0] instanceof Int32Array]"
        ),
        json!(["Uint16Array", [7], true])
    );
    assert_eq!(
        value(
            &rt,
            "const b = buf(); return [b instanceof ArrayBuffer, b.byteLength, Array.from(new Uint8Array(b))]"
        ),
        json!([true, 2, [5, 6]])
    );
    // A Uint8Array is a typed array too: a view of an ArrayBuffer, with no element at a key such as -1 or 1.5.
    assert_eq!(
        value(
            &rt,
            "const u = new Uint8Array(2); u[-1] = 5; u[1.5] = 6; \
             return [u.byteLength, u.byteOffset, u.buffer instanceof ArrayBuffer, u.buffer.byteLength, Object.keys(u), u[-1], 'byteLength' in u]"
        ),
        json!([2, 0, true, 2, ["0", "1"], null, true])
    );
}

#[test]
fn async_and_durable_host_functions_get_copies() {
    let kept: Kept = Arc::default();
    let (a, d) = (kept.clone(), kept.clone());
    let rt = Runtime::make().globals(move |_| {
        let (a, d) = (a.clone(), d.clone());
        // Each keeps its handle and writes 7 into the first element.
        let take = move |kept: &Kept, arg: &HostValue| {
            let HostValue::TypedArray(t) = arg.clone() else {
                panic!("expected a typed array")
            };
            kept.lock().unwrap().push(t.clone());
            t
        };
        vec![
            (
                "send".to_owned(),
                HostValue::from(HostFunction::new_async(move |args, _| {
                    let t = take(&a, &args[0]);
                    async move {
                        t.with_bytes_mut(|b| TypedKind::F32.write(7.0, &mut b[..4]));
                        Ok(HostValue::Undefined)
                    }
                })),
            ),
            (
                "job".to_owned(),
                HostValue::from(DurableFunction::new(
                    move |args, _| {
                        let t = take(&d, &args[0]);
                        t.with_bytes_mut(|b| TypedKind::I32.write(7.0, &mut b[..4]));
                        async { Ok(Data::Null) }
                    },
                    |_, _| async { Ok(HostValue::Undefined) },
                    |_, _| async {},
                )),
            ),
        ]
    });
    let v = value(
        &rt,
        "const f = new Float32Array([1, 2]); const g = new Int32Array([3, 4]); \
         const p = send(f); const q = job(g); f[1] = 9; g[1] = 9; await p; await q; \
         return [Array.from(f), Array.from(g)]",
    );
    // The host's writes went to its copies, and the program's writes after the calls didn't reach them.
    assert_eq!(v, json!([[1, 9], [3, 9]]));
    let kept = kept.lock().unwrap();
    assert_eq!(kept[0].values(), vec![7.0, 2.0]);
    assert_eq!(kept[1].values(), vec![7.0, 4.0]);
}
