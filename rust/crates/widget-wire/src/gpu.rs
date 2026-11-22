//! Section `G`: a GPU batch (`widgets-gpu.md`, Transport), `{ ops, bytes }`. The ops are written as a small
//! tag-length-value tree; `bytes` (an `ArrayBuffer` or typed array) are borrowed from the program in place
//! (`TypedArray::with_bytes`) and copied once, into the message.

use psychoscript::HostValue;
use serde_json::Value;

use crate::decode::{Cursor, Malformed};
use crate::encode::{put_str, varint};
use crate::json;
use crate::schema::{MAX_ARG_DEPTH, MAX_GPU_BYTES, MAX_GPU_OPS};

/// An op's argument: what JSON has.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Arg>),
    Obj(Vec<(String, Arg)>),
}

impl Arg {
    /// The argument as its JSON reads (`from_json` of the post's JSON text).
    pub fn from_json(v: &Value) -> Arg {
        match v {
            Value::Null => Arg::Null,
            Value::Bool(b) => Arg::Bool(*b),
            Value::Number(n) => Arg::Num(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => Arg::Str(s.clone()),
            Value::Array(a) => Arg::List(a.iter().map(Arg::from_json).collect()),
            Value::Object(o) => Arg::Obj(
                o.iter()
                    .map(|(k, v)| (k.clone(), Arg::from_json(v)))
                    .collect(),
            ),
        }
    }
}

/// A batch ready to replay: ops in order, and the write data they reference by `[byteOffset, byteLength]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Batch {
    pub ops: Vec<Arg>,
    pub bytes: Vec<u8>,
}

fn too_deep() -> String {
    format!("a GPU op nests deeper than {MAX_ARG_DEPTH} levels")
}

/// An argument as `JSON.stringify` would give it: `undefined` and functions left out of objects and `null` in lists,
/// non-finite numbers `null`.
fn put_arg(out: &mut Vec<u8>, a: &HostValue, depth: usize) -> Result<(), String> {
    if depth > MAX_ARG_DEPTH {
        return Err(too_deep());
    }
    match a {
        HostValue::Bool(b) => out.push(if *b { 2 } else { 1 }),
        HostValue::Number(n) if n.is_finite() => {
            out.push(3);
            out.extend_from_slice(&n.to_le_bytes());
        }
        HostValue::String(s) => {
            out.push(4);
            put_str(out, &s.to_string_lossy());
        }
        HostValue::Array(items) => {
            out.push(5);
            varint(out, items.len() as u64);
            for i in items {
                match i {
                    Some(i) if !json::skipped(i) => put_arg(out, i, depth + 1)?,
                    _ => out.push(0),
                }
            }
        }
        HostValue::Object(fields) => {
            out.push(6);
            let kept = || fields.iter().filter(|(_, v)| !json::skipped(v));
            varint(out, kept().count() as u64);
            for (k, v) in kept() {
                put_str(out, &k.to_string_lossy());
                put_arg(out, v, depth + 1)?;
            }
        }
        HostValue::Null | HostValue::Undefined | HostValue::Number(_) => out.push(0),
        other => put_json(out, &other.to_json().unwrap_or(Value::Null), depth)?,
    }
    Ok(())
}

fn put_json(out: &mut Vec<u8>, v: &Value, depth: usize) -> Result<(), String> {
    if depth > MAX_ARG_DEPTH {
        return Err(too_deep());
    }
    match v {
        Value::Null => out.push(0),
        Value::Bool(b) => out.push(if *b { 2 } else { 1 }),
        Value::Number(n) => {
            out.push(3);
            out.extend_from_slice(&n.as_f64().unwrap_or(0.0).to_le_bytes());
        }
        Value::String(s) => {
            out.push(4);
            put_str(out, s);
        }
        Value::Array(items) => {
            out.push(5);
            varint(out, items.len() as u64);
            for i in items {
                put_json(out, i, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            out.push(6);
            varint(out, fields.len() as u64);
            for (k, v) in fields {
                put_str(out, k);
                put_json(out, v, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn over_bytes(n: usize) -> String {
    format!("a GPU batch's bytes are {n} bytes, over the limit of {MAX_GPU_BYTES}")
}

/// Section `G` from the VM's batch value (`{ ops, bytes }`).
pub(crate) fn encode(batch: &HostValue, out: &mut Vec<u8>) -> Result<(), String> {
    let Some(HostValue::Array(ops)) = batch.get("ops") else {
        return Err("a GPU batch needs ops".into());
    };
    if ops.len() > MAX_GPU_OPS {
        return Err(format!(
            "a GPU batch has {} ops, over the limit of {MAX_GPU_OPS}",
            ops.len()
        ));
    }
    out.push(b'G');
    let at = out.len();
    out.extend_from_slice(&[0; 4]);
    varint(out, ops.len() as u64);
    for op in ops {
        put_arg(out, op.as_ref().unwrap_or(&HostValue::Null), 1)?;
    }
    let len = u32::try_from(out.len() - at - 4).map_err(|_| "a GPU batch's ops are too large")?;
    out[at..at + 4].copy_from_slice(&len.to_le_bytes());
    let mut put = |b: &[u8]| -> Result<(), String> {
        if b.len() > MAX_GPU_BYTES {
            return Err(over_bytes(b.len()));
        }
        out.extend_from_slice(&(b.len() as u32).to_le_bytes());
        out.extend_from_slice(b);
        Ok(())
    };
    match batch.get("bytes") {
        None | Some(HostValue::Undefined | HostValue::Null) => put(&[]),
        Some(HostValue::TypedArray(t)) => {
            if t.byte_len() > MAX_GPU_BYTES {
                return Err(over_bytes(t.byte_len()));
            }
            t.with_bytes(put)
        }
        Some(HostValue::Bytes(b) | HostValue::Buffer(b)) => put(b),
        Some(_) => Err("a GPU batch's bytes must be an ArrayBuffer or a typed array".into()),
    }
}

fn read_arg(c: &mut Cursor, depth: usize) -> Result<Arg, Malformed> {
    if depth > MAX_ARG_DEPTH {
        return Err(Malformed(too_deep()));
    }
    Ok(match c.u8()? {
        0 => Arg::Null,
        1 => Arg::Bool(false),
        2 => Arg::Bool(true),
        3 => Arg::Num(c.f64()?),
        4 => Arg::Str(c.str()?.to_owned()),
        5 => {
            let n = c.count(1)?;
            let mut l = Vec::with_capacity(n);
            for _ in 0..n {
                l.push(read_arg(c, depth + 1)?);
            }
            Arg::List(l)
        }
        6 => {
            let n = c.count(2)?;
            let mut l = Vec::with_capacity(n);
            for _ in 0..n {
                let k = c.str()?.to_owned();
                l.push((k, read_arg(c, depth + 1)?));
            }
            Arg::Obj(l)
        }
        t => return Err(Malformed(format!("unknown GPU arg tag {t}"))),
    })
}

/// Section `G` at the cursor.
pub(crate) fn decode(c: &mut Cursor) -> Result<Batch, Malformed> {
    c.expect(b'G')?;
    let ops_len = c.u32()? as usize;
    let mut ops_c = Cursor::new(c.take(ops_len)?);
    let n = ops_c.varint()?;
    if n > MAX_GPU_OPS as u64 {
        return Err(Malformed(format!("{n} GPU ops is over the limit")));
    }
    let mut ops = Vec::with_capacity((n as usize).min(ops_len));
    for _ in 0..n {
        ops.push(read_arg(&mut ops_c, 1)?);
    }
    ops_c.end("GPU ops")?;
    let len = c.u32()? as usize;
    if len > MAX_GPU_BYTES {
        return Err(Malformed(over_bytes(len)));
    }
    let bytes = c.take(len)?.to_vec();
    Ok(Batch { ops, bytes })
}
