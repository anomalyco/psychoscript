//! Native tree building (`widgets.md`, Native hosts): the view as the program built it (handlers as function markers,
//! `key`s, children as written) walked while it is encoded, into the bytes of exactly the tree the prelude's
//! `__widget_tree` makes, with its handler ids and canvases by key.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;

use psychoscript::HostValue;

use crate::encode::{Streams, field, prop, too_deep, write_node};
use crate::schema::{K_INT, K_STR, MAX_DEPTH, T_UNKNOWN, is_container, type_id};

/// Whether a value is a function marker (psychoscript's `translate: { functions: "mark" }`).
pub type IsMarker = fn(&HostValue) -> bool;

/// What a walk found besides the bytes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Found {
    /// Each id given a handler, with its event (`press`, `change`, `pointer`), in walk order; a later one with the
    /// same id takes its place.
    pub handlers: Vec<(String, &'static str)>,
    /// Each keyed canvas, the first by its key (`String(key)`): its key, id and whether it has `wgsl`.
    pub canvases: Vec<Canvas>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canvas {
    pub key: String,
    pub id: String,
    pub wgsl: bool,
}

struct Control {
    handler: &'static str,
    event: &'static str,
    always: bool,
    canvas: bool,
}

fn control(ty: &str) -> Option<Control> {
    let (handler, event, always, canvas) = match ty {
        "button" => ("onPress", "press", true, false),
        "card" => ("onPress", "press", false, false),
        "checkbox" | "slider" | "select" | "input" => ("onChange", "change", true, false),
        "carousel" => ("onChange", "change", false, false),
        "canvas" => ("onPointer", "pointer", false, true),
        _ => return None,
    };
    Some(Control {
        handler,
        event,
        always,
        canvas,
    })
}

const REMOVED: [&str; 8] = [
    "type",
    "key",
    "id",
    "pointer",
    "onPress",
    "onChange",
    "onPointer",
    "children",
];

/// A node's `key`, when it is neither `undefined` nor `null`.
fn key(v: &HostValue) -> Option<&HostValue> {
    field(v, "key").filter(|k| !matches!(k, HostValue::Null))
}

/// `String(key)`.
fn key_string(k: &HostValue) -> Result<Cow<'_, str>, String> {
    Ok(match k {
        HostValue::String(s) => s.to_string_lossy(),
        HostValue::Number(n) => Cow::Owned(js_number(*n)),
        HostValue::Bool(b) => Cow::Borrowed(if *b { "true" } else { "false" }),
        _ => return Err("a node's key must be a string or a number".into()),
    })
}

/// `":" + encodeURIComponent(String(key))`.
fn segment(k: &HostValue) -> Result<String, String> {
    if let HostValue::String(s) = k
        && s.as_str().is_none()
    {
        return Err("URIError: URI malformed (a node's key has a lone surrogate)".into());
    }
    let text = key_string(k)?;
    let mut out = String::with_capacity(text.len() + 1);
    out.push(':');
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    Ok(out)
}

/// ECMAScript `Number::toString` (radix 10): the shortest digits that round-trip, in its notation.
pub(crate) fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let (k, n) = (digits.len() as i32, exp.parse::<i32>().unwrap_or(0) + 1);
    let mut out = String::with_capacity(k as usize + 8);
    if x < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        (0..n - k).for_each(|_| out.push('0'));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        (0..-n).for_each(|_| out.push('0'));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let _ = write!(out, "e{}{}", if n > 0 { "+" } else { "-" }, (n - 1).abs());
    }
    out
}

/// What JavaScript skips among children: a hole, `undefined`, `null`, `false`, `0`, `-0`, `NaN`, `""`.
fn falsy(item: Option<&HostValue>) -> bool {
    match item {
        None | Some(HostValue::Undefined | HostValue::Null | HostValue::Bool(false)) => true,
        Some(HostValue::Number(n)) => *n == 0.0 || n.is_nan(),
        Some(HostValue::String(s)) => s.as_str() == Some(""),
        _ => false,
    }
}

/// Walks `root` (writing its bytes into `s`, when given) and returns what it found.
pub(crate) fn walk(
    s: Option<&mut Streams>,
    root: &HostValue,
    is_marker: IsMarker,
) -> Result<Found, String> {
    let path = match key(root).filter(|_| matches!(root, HostValue::Object(_))) {
        Some(k) => segment(k)?,
        None => "0".into(),
    };
    let mut walk = Walk {
        is_marker,
        path,
        found: Found::default(),
    };
    walk.node(s, root, 0)?;
    Ok(walk.found)
}

struct Walk {
    is_marker: IsMarker,
    /// The current node's path.
    path: String,
    found: Found,
}

/// A node's children: a list, or one value that isn't.
#[derive(Clone, Copy)]
enum Items<'a> {
    Many(&'a [Option<HostValue>]),
    One(&'a HostValue),
}

impl<'a> Items<'a> {
    /// Each item with its index (a hole as `None`).
    fn iter(self) -> impl Iterator<Item = (usize, Option<&'a HostValue>)> {
        let (many, one) = match self {
            Items::Many(items) => (items, None),
            Items::One(v) => (&[][..], Some(v)),
        };
        many.iter()
            .map(Option::as_ref)
            .chain(one.map(Some))
            .enumerate()
    }
}

impl Walk {
    fn node(&mut self, s: Option<&mut Streams>, v: &HostValue, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(too_deep());
        }
        let HostValue::Object(fields) = v else {
            // Not an object, or an array: as it is (a marker as `null`).
            if let Some(s) = s {
                let v = if (self.is_marker)(v) {
                    &HostValue::Null
                } else {
                    v
                };
                write_node(s, v, depth)?;
            }
            return Ok(());
        };
        let name = match field(v, "type") {
            Some(HostValue::String(t)) => t.to_string_lossy(),
            _ => Cow::Borrowed(""),
        };
        let t = type_id(&name);
        let mut s = s;
        if let Some(s) = s.as_deref_mut() {
            s.int(t);
            if t == T_UNKNOWN {
                s.int(0);
                s.str(&name);
            }
        }
        // A type the encoder doesn't know writes no props or children, but its subtree still counts.
        let mut props = match s {
            Some(s) if t != T_UNKNOWN => Some(s),
            _ => None,
        };
        if let Some(st) = props.as_deref_mut() {
            for (k, pv) in fields {
                let Some(k) = k.as_str() else { continue };
                if !REMOVED.contains(&k) && !(self.is_marker)(pv) {
                    prop(st, k, pv);
                }
            }
        }
        if let Some(c) = control(&name) {
            let handled = field(v, c.handler).is_some_and(self.is_marker);
            let keyed = if c.canvas { key(v) } else { None };
            if handled || c.always || keyed.is_some() {
                if let Some(st) = props.as_deref_mut() {
                    st.tag(10, K_STR);
                    st.str(&self.path);
                    if c.canvas && handled {
                        st.tag(35, K_INT);
                        st.int(1);
                    }
                }
                if handled {
                    self.found.handlers.push((self.path.clone(), c.event));
                }
                if let Some(k) = keyed {
                    let k = key_string(k)?;
                    if !self.found.canvases.iter().any(|c| c.key == k) {
                        self.found.canvases.push(Canvas {
                            key: k.into_owned(),
                            id: self.path.clone(),
                            wgsl: matches!(field(v, "wgsl"), Some(HostValue::String(_))),
                        });
                    }
                }
            }
        }
        let st = props.map(|st| {
            st.int(0);
            st
        });
        let st = st.filter(|_| is_container(t));
        let items = match field(v, "children") {
            None => {
                if let Some(st) = st {
                    st.int(0);
                }
                return Ok(());
            }
            Some(HostValue::Array(items)) => Items::Many(items),
            Some(one) => Items::One(one),
        };
        let st = match st {
            Some(st) => {
                st.int(self.count(items, depth)?);
                Some(st)
            }
            None => None,
        };
        let mut prefix = String::new();
        let mut seen = HashMap::new();
        self.items(st, items, &mut prefix, &mut seen, depth)
    }

    /// How many children go out: what isn't skipped, a marker (`null`, which clients drop) aside.
    fn count(&self, items: Items, depth: usize) -> Result<u32, String> {
        if depth > MAX_DEPTH {
            return Err(too_deep());
        }
        let mut n = 0;
        for (_, item) in items.iter() {
            match item {
                _ if falsy(item) => {}
                Some(HostValue::Array(nested)) => {
                    n += self.count(Items::Many(nested), depth + 1)?
                }
                Some(v) if (self.is_marker)(v) => {}
                _ => n += 1,
            }
        }
        Ok(n)
    }

    fn items(
        &mut self,
        mut s: Option<&mut Streams>,
        items: Items,
        prefix: &mut String,
        seen: &mut HashMap<String, u32>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(too_deep());
        }
        for (i, item) in items.iter() {
            match item {
                _ if falsy(item) => {}
                Some(HostValue::Array(nested)) => {
                    let len = prefix.len();
                    let _ = write!(prefix, "{i}.");
                    self.items(
                        s.as_deref_mut(),
                        Items::Many(nested),
                        prefix,
                        seen,
                        depth + 1,
                    )?;
                    prefix.truncate(len);
                }
                Some(child @ HostValue::Object(_)) => {
                    let len = self.path.len();
                    self.path.push('/');
                    match key(child) {
                        Some(k) => {
                            let seg = segment(k)?;
                            let n = seen.entry(seg.clone()).or_insert(0);
                            *n += 1;
                            self.path.push_str(&seg);
                            if *n > 1 {
                                let _ = write!(self.path, "~{n}");
                            }
                        }
                        None => {
                            self.path.push_str(prefix);
                            let _ = write!(self.path, "{i}");
                        }
                    }
                    self.node(s.as_deref_mut(), child, depth + 1)?;
                    self.path.truncate(len);
                }
                Some(v) if (self.is_marker)(v) => {}
                Some(v) => {
                    if let Some(s) = s.as_deref_mut() {
                        write_node(s, v, depth + 1)?;
                    }
                }
                None => {}
            }
        }
        Ok(())
    }
}
