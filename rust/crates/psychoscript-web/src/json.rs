//! JSON text to and from [`HostValue`]s, with no `serde_json::Value` in between: a run's input, delivered messages,
//! and posted ones.

use std::fmt;

use psychoscript::{HostError, HostString, HostValue};
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// JSON text read as a host value: numbers as `f64`, objects keeping their keys' order.
pub(crate) struct Input(pub(crate) HostValue);

impl Input {
    pub(crate) fn parse(text: &str) -> Result<HostValue, serde_json::Error> {
        serde_json::from_str::<Input>(text).map(|i| i.0)
    }
}

impl<'de> Deserialize<'de> for Input {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Input, D::Error> {
        d.deserialize_any(Json).map(Input)
    }
}

struct Json;

impl<'de> Visitor<'de> for Json {
    type Value = HostValue;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON")
    }

    fn visit_unit<E>(self) -> Result<HostValue, E> {
        Ok(HostValue::Null)
    }

    fn visit_bool<E>(self, b: bool) -> Result<HostValue, E> {
        Ok(HostValue::Bool(b))
    }

    fn visit_i64<E>(self, n: i64) -> Result<HostValue, E> {
        Ok(HostValue::Number(n as f64))
    }

    fn visit_u64<E>(self, n: u64) -> Result<HostValue, E> {
        Ok(HostValue::Number(n as f64))
    }

    fn visit_f64<E>(self, n: f64) -> Result<HostValue, E> {
        Ok(HostValue::Number(n))
    }

    fn visit_str<E>(self, s: &str) -> Result<HostValue, E> {
        Ok(HostValue::String(s.into()))
    }

    fn visit_string<E>(self, s: String) -> Result<HostValue, E> {
        Ok(HostValue::String(s.into()))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<HostValue, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(Input(item)) = seq.next_element()? {
            items.push(Some(item));
        }
        Ok(HostValue::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<HostValue, A::Error> {
        let mut fields: Vec<(HostString, HostValue)> =
            Vec::with_capacity(map.size_hint().unwrap_or(0));
        // A repeated key stays repeated: the run sets it again, so its last value wins at its first
        // place, as with `JSON.parse`.
        while let Some((key, Input(value))) = map.next_entry::<String, Input>()? {
            fields.push((key.into(), value));
        }
        Ok(HostValue::Object(fields))
    }
}

/// A host call's argument as `JSON.stringify` writes it (`undefined` is left out of objects, `null` in arrays and at
/// the top; non-finite numbers are `null`), or `None` when it holds a function, which a host call's argument may not.
pub(crate) fn write_checked(value: &HostValue) -> Option<String> {
    let mut out = String::new();
    write_into(value, &mut out, true).then_some(out)
}

/// A host value as JSON reads it, functions left out as `undefined` is (a native draw step's emitted commands).
pub(crate) fn write(value: &HostValue) -> String {
    let mut out = String::new();
    write_into(value, &mut out, false);
    out
}

fn is_function(v: &HostValue) -> bool {
    matches!(v, HostValue::Function(_) | HostValue::FunctionMarker)
}

/// What a host call throws for a function in its argument `n` (from 1), as the runtime does without `"mark"`
/// (widgets.md, "Native hosts"): its `TypeError`, located at the call, with the function's name as the program called
/// it.
pub(crate) fn carried(n: usize, name: &str) -> HostValue {
    HostError::located(
        "TypeError",
        format!("Argument {n} to {name} contains a function, which cannot be passed to the host."),
    )
}

/// Fails with [`carried`] for the first of `args`, from index `from`, that is or holds a function.
pub(crate) fn unmarked(args: &[HostValue], name: &str, from: usize) -> Result<(), HostValue> {
    match args.iter().skip(from).position(has_function) {
        Some(i) => Err(carried(from + i + 1, name)),
        None => Ok(()),
    }
}

fn has_function(v: &HostValue) -> bool {
    match v {
        HostValue::Function(_) | HostValue::FunctionMarker => true,
        HostValue::Array(items) => items.iter().flatten().any(has_function),
        HostValue::Object(fields) => fields.iter().any(|(_, v)| has_function(v)),
        HostValue::Map(entries) => entries
            .iter()
            .any(|(k, v)| has_function(k) || has_function(v)),
        HostValue::Set(items) => items.iter().any(has_function),
        _ => false,
    }
}

/// Writes `value`; with `strict`, false when it holds a function, else functions go as `undefined` does.
fn write_into(value: &HostValue, out: &mut String, strict: bool) -> bool {
    match value {
        HostValue::Null => out.push_str("null"),
        HostValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        HostValue::Number(n) => number(*n, out),
        HostValue::String(s) => string(&s.to_string_lossy(), out),
        HostValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                match item {
                    Some(item) if strict && is_function(item) => return false,
                    Some(item) if !skipped(item) && !is_function(item) => {
                        if !write_into(item, out, strict) {
                            return false;
                        }
                    }
                    _ => out.push_str("null"),
                }
            }
            out.push(']');
        }
        HostValue::Object(fields) => {
            out.push('{');
            let mut first = true;
            for (k, v) in fields.iter() {
                if is_function(v) && strict {
                    return false;
                }
                if skipped(v) || is_function(v) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                string(&k.to_string_lossy(), out);
                out.push(':');
                if !write_into(v, out, strict) {
                    return false;
                }
            }
            out.push('}');
        }
        HostValue::Function(_) | HostValue::FunctionMarker if strict => return false,
        HostValue::Map(_) | HostValue::Set(_) if strict && has_function(value) => return false,
        other => match other.to_json() {
            Some(json) => out.push_str(&json.to_string()),
            None => out.push_str("null"),
        },
    }
    true
}

/// What `JSON.stringify` leaves out of an object, functions aside.
fn skipped(v: &HostValue) -> bool {
    matches!(
        v,
        HostValue::Undefined
            | HostValue::Durable(_)
            | HostValue::Namespace(_)
            | HostValue::Interrupt
    )
}

fn number(n: f64, out: &mut String) {
    use std::fmt::Write as _;
    if !n.is_finite() {
        out.push_str("null");
    } else if n.fract() == 0.0 && n.abs() < 9.0e15 {
        let _ = write!(out, "{}", n as i64);
    } else {
        out.push_str(
            &serde_json::Number::from_f64(n).map_or_else(|| "null".to_owned(), |n| n.to_string()),
        );
    }
}

fn string(s: &str, out: &mut String) {
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned()));
}
