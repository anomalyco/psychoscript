//! A run's JSON input read straight into a [`HostValue`], with no `serde_json::Value` in between.

use std::fmt;

use psychoscript::{HostString, HostValue};
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
