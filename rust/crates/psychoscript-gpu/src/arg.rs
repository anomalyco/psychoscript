//! The batch format (`README.md`, Transport): a batch's ops as JSON reads them, and its bytes.

use serde_json::Value;

/// An op, or an op's argument: what JSON has.
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
