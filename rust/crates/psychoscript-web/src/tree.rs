//! Building the view tree clients get, natively (widgets.md, "Native hosts"): from a view as the program built it
//! (handler props as function markers, `key`s, `children` as written) straight to the wire JSON, while writing it. It
//! makes exactly what the prelude's `__widget_tree` makes: props in order without `key`, `id`, `pointer`, `onPress`,
//! `onChange`, `onPointer` and `children`; then `id` (the node's path) on controls, `pointer: true` on a canvas with a
//! handler, and `children` last, flattened. It also tells which ids have handlers and the canvas ids by key.
//!
//! The walk is generic over the value it reads ([`View`]): the run's result ([`Data`]), a post's argument
//! ([`HostValue`]), or JSON in tests. Numbers and strings are written as `JSON.stringify` writes them.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;

use psychoscript::{Data, HostString, HostValue};

/// What a value is, as far as the walk cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `undefined`, or a hole: falsy, left out of an object, `null` in an array.
    Undefined,
    /// A program function (the function marker): truthy, left out of an object, `null` in an array; as a handler
    /// prop it makes the node's id a handler's.
    Function,
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}

/// A string as the walk reads it: UTF-8, or UTF-16 code units when it has an unpaired surrogate.
pub enum Text<'a> {
    Str(&'a str),
    Units(Cow<'a, [u16]>),
}

/// A value the walk can read.
pub trait View: Sized {
    fn kind(&self) -> Kind;
    fn boolean(&self) -> bool;
    fn number(&self) -> f64;
    fn text(&self) -> Text<'_>;
    /// An array's items in order; `None` for a hole.
    fn items(&self) -> impl Iterator<Item = Option<&Self>>;
    /// An object's props in order.
    fn props(&self) -> impl Iterator<Item = (Text<'_>, &Self)>;
    /// An object's prop by name.
    fn get(&self, name: &str) -> Option<&Self>;
}

/// The controls (widgets.md, Events): handler prop, event, whether it always has an id, whether a `key` gives one.
fn control(kind: &str) -> Option<(&'static str, &'static str, bool, bool)> {
    Some(match kind {
        "button" => ("onPress", "press", true, false),
        "card" => ("onPress", "press", false, false),
        "checkbox" => ("onChange", "change", true, false),
        "slider" => ("onChange", "change", true, false),
        "select" => ("onChange", "change", true, false),
        "input" => ("onChange", "change", true, false),
        "carousel" => ("onChange", "change", false, false),
        "canvas" => ("onPointer", "pointer", false, true),
        _ => return None,
    })
}

const REMOVED: [&str; 7] = [
    "key",
    "id",
    "pointer",
    "onPress",
    "onChange",
    "onPointer",
    "children",
];

/// What the walk learned of a view besides its JSON.
#[derive(Debug, Default)]
pub struct Tree {
    /// Some id has a handler.
    pub has_handlers: bool,
    /// The ids with handlers and their events, in the order met (a later node with the same id overrides), when asked
    /// for ([`Walk::handlers`]).
    pub handlers: Option<Vec<(String, &'static str)>>,
    /// The first canvas with each `String(key)`: its id and whether it has `wgsl`.
    pub canvases: HashMap<String, (String, bool)>,
}

/// A key `encodeURIComponent` can't encode: a lone surrogate, which the prelude would throw on as a `URIError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkError(pub String);

/// One walk of one view.
pub struct Walk {
    tree: Tree,
    path: String,
}

impl Walk {
    pub fn new() -> Self {
        Walk {
            tree: Tree::default(),
            path: String::with_capacity(64),
        }
    }

    /// Also collect every handler id with its event (for tests; a host only needs [`Tree::has_handlers`]).
    pub fn handlers(mut self) -> Self {
        self.tree.handlers = Some(Vec::new());
        self
    }

    /// Writes the wire JSON of view `root` to `out`, and returns what it learned.
    pub fn run<V: View>(mut self, root: &V, out: &mut String) -> Result<Tree, WalkError> {
        self.path.clear();
        if root.kind() == Kind::Object
            && let Some(key) = root.get("key").filter(|k| keyed(*k))
        {
            segment(key, &mut self.path)?;
        } else {
            self.path.push('0');
        }
        if root.kind() == Kind::Undefined || root.kind() == Kind::Function {
            out.push_str("null");
        } else {
            self.node(root, out)?;
        }
        Ok(self.tree)
    }

    /// A value at `self.path`: an object as a node, anything else as it is.
    fn node<V: View>(&mut self, v: &V, out: &mut String) -> Result<(), WalkError> {
        if v.kind() != Kind::Object {
            write_json(v, out);
            return Ok(());
        }
        out.push('{');
        let mut first = true;
        let mut kind = None;
        let mut children = None;
        for (text, prop) in v.props() {
            let name = match &text {
                Text::Str(s) => Some(*s),
                Text::Units(_) => None,
            };
            match name {
                Some("type") if prop.kind() == Kind::String => {
                    if let Text::Str(s) = prop.text() {
                        kind = control(s).map(|c| (s == "canvas", c));
                    }
                }
                Some("children") => {
                    children = Some(prop);
                    continue;
                }
                Some(n) if REMOVED.contains(&n) => continue,
                _ => {}
            }
            if matches!(prop.kind(), Kind::Undefined | Kind::Function) {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            write_text(&text, out);
            out.push(':');
            write_json(prop, out);
        }
        if let Some((canvas, (handler, event, always, by_key))) = kind {
            let handled = v.get(handler).is_some_and(|h| h.kind() == Kind::Function);
            let key = if by_key {
                v.get("key").filter(|k| keyed(*k))
            } else {
                None
            };
            if handled || always || key.is_some() {
                if !first {
                    out.push(',');
                }
                first = false;
                // A path is ASCII without quotes or backslashes: `0`, `/`, digits, `.`, `~` and encoded keys.
                out.push_str("\"id\":\"");
                out.push_str(&self.path);
                out.push('"');
                if handled {
                    self.tree.has_handlers = true;
                    if let Some(list) = &mut self.tree.handlers {
                        list.push((self.path.clone(), event));
                    }
                    if canvas {
                        out.push_str(",\"pointer\":true");
                    }
                }
                if let Some(key) = key {
                    let name = string_of(key);
                    if !self.tree.canvases.contains_key(&name) {
                        let wgsl = v.get("wgsl").is_some_and(|w| w.kind() == Kind::String);
                        self.tree.canvases.insert(name, (self.path.clone(), wgsl));
                    }
                }
            }
        }
        if let Some(list) = children.filter(|c| c.kind() != Kind::Undefined) {
            if !first {
                out.push(',');
            }
            out.push_str("\"children\":[");
            let mut seen: HashMap<String, u32> = HashMap::new();
            let mut any = false;
            if list.kind() == Kind::Array {
                self.flatten(list, "", out, &mut seen, &mut any)?;
            } else {
                self.child(list, "0", out, &mut seen, &mut any)?;
            }
            out.push(']');
        }
        out.push('}');
        Ok(())
    }

    /// An array of children at `prefix` (`""`, `"2."`, `"2.1."`).
    fn flatten<V: View>(
        &mut self,
        list: &V,
        prefix: &str,
        out: &mut String,
        seen: &mut HashMap<String, u32>,
        any: &mut bool,
    ) -> Result<(), WalkError> {
        let mut index = String::new();
        for (i, item) in list.items().enumerate() {
            let Some(item) = item else { continue };
            index.clear();
            index.push_str(prefix);
            let _ = write!(index, "{i}");
            if item.kind() == Kind::Array {
                let mut deeper = index.clone();
                deeper.push('.');
                self.flatten(item, &deeper, out, seen, any)?;
            } else {
                self.child(item, &index, out, seen, any)?;
            }
        }
        Ok(())
    }

    /// One child, not an array, at `index` among its parent's.
    fn child<V: View>(
        &mut self,
        item: &V,
        index: &str,
        out: &mut String,
        seen: &mut HashMap<String, u32>,
        any: &mut bool,
    ) -> Result<(), WalkError> {
        if falsy(item) {
            return Ok(());
        }
        if *any {
            out.push(',');
        }
        *any = true;
        if item.kind() != Kind::Object {
            // A string, a number, `true`, or a marker (`null`, as in an array).
            write_json(item, out);
            return Ok(());
        }
        let len = self.path.len();
        self.path.push('/');
        match item.get("key").filter(|k| keyed(*k)) {
            Some(key) => {
                let at = self.path.len();
                segment(key, &mut self.path)?;
                let n = seen.entry(self.path[at..].to_owned()).or_insert(0);
                *n += 1;
                if *n > 1 {
                    let _ = write!(self.path, "~{n}");
                }
            }
            None => self.path.push_str(index),
        }
        let done = self.node(item, out);
        self.path.truncate(len);
        done
    }
}

impl Default for Walk {
    fn default() -> Self {
        Self::new()
    }
}

/// A `key` that names a node: neither `undefined` nor `null`.
fn keyed<V: View>(key: &V) -> bool {
    !matches!(key.kind(), Kind::Undefined | Kind::Null)
}

/// JavaScript's truthiness, for children.
fn falsy<V: View>(v: &V) -> bool {
    match v.kind() {
        Kind::Undefined | Kind::Null => true,
        Kind::Bool => !v.boolean(),
        Kind::Number => {
            let n = v.number();
            n == 0.0 || n.is_nan()
        }
        Kind::String => match v.text() {
            Text::Str(s) => s.is_empty(),
            Text::Units(u) => u.is_empty(),
        },
        Kind::Function | Kind::Array | Kind::Object => false,
    }
}

/// `":" + encodeURIComponent(String(key))`, appended to `out`.
fn segment<V: View>(key: &V, out: &mut String) -> Result<(), WalkError> {
    out.push(':');
    match key.kind() {
        Kind::String => match key.text() {
            Text::Str(s) => encode(s, out),
            Text::Units(_) => return Err(WalkError("URIError: URI malformed".into())),
        },
        _ => encode(&string_of(key), out),
    }
    Ok(())
}

/// `String(v)` for a key, lossy for a lone surrogate (which `segment` refuses first).
fn string_of<V: View>(v: &V) -> String {
    match v.kind() {
        Kind::String => match v.text() {
            Text::Str(s) => s.to_owned(),
            Text::Units(u) => String::from_utf16_lossy(&u),
        },
        Kind::Number => number(v.number()),
        Kind::Bool => (if v.boolean() { "true" } else { "false" }).to_owned(),
        Kind::Null => "null".to_owned(),
        Kind::Undefined => "undefined".to_owned(),
        Kind::Object => "[object Object]".to_owned(),
        Kind::Array => v
            .items()
            .map(|i| match i.map(|i| (i.kind(), i)) {
                None | Some((Kind::Undefined | Kind::Null, _)) => String::new(),
                Some((_, i)) => string_of(i),
            })
            .collect::<Vec<_>>()
            .join(","),
        // A function's source text isn't known here; a function as a key is never meant.
        Kind::Function => "function".to_owned(),
    }
}

/// ECMAScript `Number::toString`.
fn number(n: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(n).to_owned()
}

/// `encodeURIComponent` of well-formed text: UTF-8 bytes percent-encoded, uppercase, except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
fn encode(s: &str, out: &mut String) {
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
}

/// A value as `JSON.stringify` writes it (functions and `undefined` left out of objects, `null` in arrays).
fn write_json<V: View>(v: &V, out: &mut String) {
    match v.kind() {
        Kind::Undefined | Kind::Function | Kind::Null => out.push_str("null"),
        Kind::Bool => out.push_str(if v.boolean() { "true" } else { "false" }),
        Kind::Number => {
            let n = v.number();
            if n.is_finite() {
                out.push_str(ryu_js::Buffer::new().format_finite(n));
            } else {
                out.push_str("null");
            }
        }
        Kind::String => write_text(&v.text(), out),
        Kind::Array => {
            out.push('[');
            for (i, item) in v.items().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                match item {
                    Some(item) => write_json(item, out),
                    None => out.push_str("null"),
                }
            }
            out.push(']');
        }
        Kind::Object => {
            out.push('{');
            let mut first = true;
            for (name, prop) in v.props() {
                if matches!(prop.kind(), Kind::Undefined | Kind::Function) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_text(&name, out);
                out.push(':');
                write_json(prop, out);
            }
            out.push('}');
        }
    }
}

fn write_text(t: &Text<'_>, out: &mut String) {
    match t {
        Text::Str(s) => write_str(s, out),
        Text::Units(u) => write_units(u, out),
    }
}

/// A string as `JSON.stringify` quotes it.
fn write_str(s: &str, out: &mut String) {
    out.push('"');
    let mut start = 0;
    for (i, b) in s.bytes().enumerate() {
        let escape = match b {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            0x08 => "\\b",
            0x0c => "\\f",
            0..=0x1f => "",
            _ => continue,
        };
        out.push_str(&s[start..i]);
        if escape.is_empty() {
            let _ = write!(out, "\\u{b:04x}");
        } else {
            out.push_str(escape);
        }
        start = i + 1;
    }
    out.push_str(&s[start..]);
    out.push('"');
}

/// UTF-16 text with unpaired surrogates, as `JSON.stringify` quotes it (`\udxxx` for each lone one).
fn write_units(units: &[u16], out: &mut String) {
    out.push('"');
    for unit in char::decode_utf16(units.iter().copied()) {
        match unit {
            Ok(c) => {
                let mut buf = [0u8; 4];
                let s: &str = c.encode_utf8(&mut buf);
                let mut quoted = String::new();
                write_str(s, &mut quoted);
                out.push_str(&quoted[1..quoted.len() - 1]);
            }
            Err(e) => {
                let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

fn host_text(s: &HostString) -> Text<'_> {
    match s.as_str() {
        Some(s) => Text::Str(s),
        None => Text::Units(s.to_utf16()),
    }
}

impl View for Data {
    fn kind(&self) -> Kind {
        match self {
            Data::Null => Kind::Null,
            Data::Bool(_) => Kind::Bool,
            Data::Number(_) => Kind::Number,
            Data::String(_) => Kind::String,
            Data::Array(_) => Kind::Array,
            Data::Object(_) => Kind::Object,
            Data::FunctionMarker => Kind::Function,
        }
    }
    fn boolean(&self) -> bool {
        matches!(self, Data::Bool(true))
    }
    fn number(&self) -> f64 {
        match self {
            Data::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        }
    }
    fn text(&self) -> Text<'_> {
        match self {
            Data::String(s) => host_text(s),
            _ => Text::Str(""),
        }
    }
    fn items(&self) -> impl Iterator<Item = Option<&Self>> {
        let items: &[Data] = match self {
            Data::Array(items) => items,
            _ => &[],
        };
        items.iter().map(Some)
    }
    fn props(&self) -> impl Iterator<Item = (Text<'_>, &Self)> {
        let props: &[(HostString, Data)] = match self {
            Data::Object(props) => props,
            _ => &[],
        };
        props.iter().map(|(k, v)| (host_text(k), v))
    }
    fn get(&self, name: &str) -> Option<&Self> {
        match self {
            Data::Object(props) => props.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v),
            _ => None,
        }
    }
}

impl View for HostValue {
    fn kind(&self) -> Kind {
        match self {
            HostValue::Null => Kind::Null,
            HostValue::Bool(_) => Kind::Bool,
            HostValue::Number(_) => Kind::Number,
            HostValue::String(_) => Kind::String,
            HostValue::Array(_) => Kind::Array,
            HostValue::Object(_) => Kind::Object,
            HostValue::Function(_) | HostValue::FunctionMarker => Kind::Function,
            _ => Kind::Undefined,
        }
    }
    fn boolean(&self) -> bool {
        matches!(self, HostValue::Bool(true))
    }
    fn number(&self) -> f64 {
        match self {
            HostValue::Number(n) => *n,
            _ => f64::NAN,
        }
    }
    fn text(&self) -> Text<'_> {
        match self {
            HostValue::String(s) => host_text(s),
            _ => Text::Str(""),
        }
    }
    fn items(&self) -> impl Iterator<Item = Option<&Self>> {
        let items: &[Option<HostValue>] = match self {
            HostValue::Array(items) => items,
            _ => &[],
        };
        items.iter().map(Option::as_ref)
    }
    fn props(&self) -> impl Iterator<Item = (Text<'_>, &Self)> {
        let props: &[(HostString, HostValue)] = match self {
            HostValue::Object(props) => props,
            _ => &[],
        };
        props.iter().map(|(k, v)| (host_text(k), v))
    }
    fn get(&self, name: &str) -> Option<&Self> {
        match self {
            HostValue::Object(props) => props.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v),
            _ => None,
        }
    }
}
