//! Uint8Array, TextEncoder, TextDecoder, atob and btoa.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::{arg, describe_value, fuel, incompatible};
use crate::native::{FOR_OF_SLOTS, Flow, ForOf, Frame, Input, Step};
use crate::object::*;
use crate::ops::{MAX_ARRAY_LEN, MAX_STRING_LEN};
use crate::value::{Id, Slot, Value};
use crate::vm::{Res, Vm};

/// What a typed array holds, or `Buffer` for an `ArrayBuffer`, which has no elements of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Elem {
    U8,
    U16,
    U32,
    I32,
    F32,
    F64,
    ArrayBuffer,
}

impl Elem {
    /// The typed arrays, in the order their globals are set up.
    pub const TYPED: [Elem; 6] = [
        Elem::U8,
        Elem::U16,
        Elem::U32,
        Elem::I32,
        Elem::F32,
        Elem::F64,
    ];

    pub fn size(self) -> usize {
        match self {
            Elem::U8 | Elem::ArrayBuffer => 1,
            Elem::U16 => 2,
            Elem::U32 | Elem::I32 | Elem::F32 => 4,
            Elem::F64 => 8,
        }
    }

    /// The constructor's name.
    pub fn name(self) -> &'static str {
        match self {
            Elem::U8 => "Uint8Array",
            Elem::U16 => "Uint16Array",
            Elem::U32 => "Uint32Array",
            Elem::I32 => "Int32Array",
            Elem::F32 => "Float32Array",
            Elem::F64 => "Float64Array",
            Elem::ArrayBuffer => "ArrayBuffer",
        }
    }

    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(c: u64) -> Option<Elem> {
        [
            Elem::U8,
            Elem::U16,
            Elem::U32,
            Elem::I32,
            Elem::F32,
            Elem::F64,
            Elem::ArrayBuffer,
        ]
        .get(c as usize)
        .copied()
    }

    /// The element little-endian at the start of `b`.
    #[inline]
    pub fn read(self, b: &[u8]) -> f64 {
        match self {
            Elem::U8 | Elem::ArrayBuffer => b[0] as f64,
            Elem::U16 => u16::from_le_bytes([b[0], b[1]]) as f64,
            Elem::U32 => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
            Elem::I32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
            Elem::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
            Elem::F64 => f64::from_le_bytes(b[..8].try_into().unwrap_or([0; 8])),
        }
    }

    /// Writes `n` little-endian at the start of `out`, converted as a JS typed array does: float32 rounding, integer
    /// wrapping. A NaN is the canonical quiet NaN.
    #[inline]
    pub fn write(self, n: f64, out: &mut [u8]) {
        match self {
            Elem::U8 | Elem::ArrayBuffer => out[0] = to_u8(n),
            Elem::U16 => out[..2].copy_from_slice(&(to_u32(n) as u16).to_le_bytes()),
            Elem::U32 => out[..4].copy_from_slice(&to_u32(n).to_le_bytes()),
            Elem::I32 => out[..4].copy_from_slice(&(to_u32(n) as i32).to_le_bytes()),
            Elem::F32 => {
                let f = if n.is_nan() { f32::NAN } else { n as f32 };
                out[..4].copy_from_slice(&f.to_le_bytes())
            }
            Elem::F64 => {
                let f = if n.is_nan() { f64::NAN } else { n };
                out[..8].copy_from_slice(&f.to_le_bytes())
            }
        }
    }

    /// `values` as this kind's bytes.
    pub fn encode(self, values: &[f64]) -> Vec<u8> {
        let size = self.size();
        let mut out = vec![0; values.len() * size];
        for (i, v) in values.iter().enumerate() {
            self.write(*v, &mut out[i * size..]);
        }
        out
    }
}

/// ToUint32: modulo 2^32, with NaN and infinities as 0. ToUint16 and ToInt32 are its low bits.
pub fn to_u32(n: f64) -> u32 {
    if !n.is_finite() {
        return 0;
    }
    n.trunc().rem_euclid(4294967296.0) as u32
}

/// A typed array: a view of `len` elements at byte `start` in a buffer that its views and its `ArrayBuffer` share.
/// An `ArrayBuffer` (`elem` `Buffer`) is the whole buffer, `len` bytes from 0.
pub struct Bytes {
    pub buf: Arc<Mutex<Vec<u8>>>,
    pub start: usize,
    pub len: usize,
    /// A Node Buffer: text conversions default to UTF-8.
    pub buffer: bool,
    pub elem: Elem,
    /// The `ArrayBuffer` object of the buffer, made the first time a program needs it (`buffer`, a view of it), so
    /// every view of one buffer gives the same one.
    pub owner: Option<Id>,
}

impl Bytes {
    pub fn new(data: Vec<u8>, buffer: bool) -> Bytes {
        Bytes::typed(data, Elem::U8, buffer)
    }

    /// A typed array (or an `ArrayBuffer`) of `elem` over `data`, all of it.
    pub fn typed(data: Vec<u8>, elem: Elem, buffer: bool) -> Bytes {
        let len = data.len() / elem.size();
        Bytes {
            buf: Arc::new(Mutex::new(data)),
            start: 0,
            len,
            buffer,
            elem,
            owner: None,
        }
    }

    /// The shared buffer. Only the run that owns it touches it, so the lock is never contended.
    pub fn bytes(&self) -> MutexGuard<'_, Vec<u8>> {
        self.buf.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The view's length in bytes.
    pub fn byte_len(&self) -> usize {
        self.len * self.elem.size()
    }

    /// The view's bytes, copied.
    pub fn to_vec(&self) -> Vec<u8> {
        let b = self.bytes();
        b[self.start..self.start + self.byte_len()].to_vec()
    }

    /// The byte at `i` of a Uint8Array.
    pub fn get(&self, i: usize) -> Option<u8> {
        if i < self.len {
            self.bytes().get(self.start + i).copied()
        } else {
            None
        }
    }

    /// Writes the byte at `i` of a Uint8Array.
    pub fn put(&self, i: usize, v: u8) {
        if i < self.len
            && let Some(slot) = self.bytes().get_mut(self.start + i)
        {
            *slot = v;
        }
    }

    /// The element at `i`, as a number.
    #[inline]
    pub fn num(&self, i: usize) -> Option<f64> {
        if i >= self.len {
            return None;
        }
        let size = self.elem.size();
        let at = self.start + i * size;
        self.bytes().get(at..at + size).map(|b| self.elem.read(b))
    }

    /// Writes the element at `i`, converted; an index out of range writes nothing.
    #[inline]
    pub fn set_num(&self, i: usize, n: f64) {
        if i >= self.len {
            return;
        }
        let size = self.elem.size();
        let at = self.start + i * size;
        if let Some(b) = self.bytes().get_mut(at..at + size) {
            self.elem.write(n, b);
        }
    }

    /// Every element, as numbers.
    pub fn nums(&self) -> Vec<f64> {
        let size = self.elem.size();
        let b = self.bytes();
        b[self.start..self.start + self.byte_len()]
            .chunks_exact(size)
            .map(|c| self.elem.read(c))
            .collect()
    }

    /// A view of elements `start..end` on the same bytes.
    pub fn view(&self, start: usize, end: usize, buffer: bool) -> Bytes {
        let end = end.max(start).min(self.len);
        let start = start.min(end);
        Bytes {
            buf: self.buf.clone(),
            start: self.start + start * self.elem.size(),
            len: end - start,
            buffer,
            elem: self.elem,
            owner: self.owner,
        }
    }
}

/// ToUint8: modulo 256, with NaN and infinities as 0.
pub fn to_u8(n: f64) -> u8 {
    if !n.is_finite() {
        return 0;
    }
    n.trunc().rem_euclid(256.0) as u8
}

/// A new typed array (or `ArrayBuffer`) of `elem` over `data`.
pub fn new_typed(vm: &mut Vm, data: Vec<u8>, elem: Elem) -> Value {
    super::ensure(vm, super::LAZY_BYTES);
    if let Some(m) = vm.heap_meter.as_deref_mut() {
        m.debt += data.len() as u64;
    }
    let proto = vm.realm.std.typed_proto(elem);
    Value::Obj(vm.alloc(Obj::new(
        Some(proto),
        Kind::Bytes(Box::new(Bytes::typed(data, elem, false))),
    )))
}

pub fn new_bytes(vm: &mut Vm, data: Vec<u8>, buffer: bool) -> Value {
    super::ensure(vm, super::LAZY_BYTES);
    let proto = if buffer {
        vm.realm.std.buffer
    } else {
        vm.realm.std.uint8
    };
    Value::Obj(vm.alloc(Obj::new(
        Some(proto),
        Kind::Bytes(Box::new(Bytes::new(data, buffer))),
    )))
}

pub fn view_value(vm: &mut Vm, b: Bytes) -> Value {
    let proto = if b.buffer {
        vm.realm.std.buffer
    } else {
        vm.realm.std.uint8
    };
    Value::Obj(vm.alloc(Obj::new(Some(proto), Kind::Bytes(Box::new(b)))))
}

/// A Uint8Array (or Buffer): the bytes the byte built-ins take.
pub fn as_bytes<'a>(vm: &'a Vm, v: &Value) -> Option<&'a Bytes> {
    match v {
        Value::Obj(id) => match &vm.heap[*id as usize].kind {
            Kind::Bytes(b) if b.elem == Elem::U8 => Some(b),
            _ => None,
        },
        _ => None,
    }
}

/// Any typed array, not an `ArrayBuffer`.
pub fn as_typed<'a>(vm: &'a Vm, v: &Value) -> Option<&'a Bytes> {
    match v {
        Value::Obj(id) => match &vm.heap[*id as usize].kind {
            Kind::Bytes(b) if b.elem != Elem::ArrayBuffer => Some(b),
            _ => None,
        },
        _ => None,
    }
}

pub fn bytes_of(vm: &Vm, v: &Value) -> Option<Vec<u8>> {
    as_bytes(vm, v).map(Bytes::to_vec)
}

fn this_bytes(vm: &mut Vm, this: &Value, name: &str) -> Result<Id, Value> {
    if let Value::Obj(id) = this
        && let Kind::Bytes(b) = &vm.heap[*id as usize].kind
        && b.elem == Elem::U8
    {
        return Ok(*id);
    }
    Err(incompatible(
        vm,
        &format!("Uint8Array.prototype.{name}"),
        this,
    ))
}

pub fn bytes_ref(vm: &Vm, id: Id) -> &Bytes {
    match &vm.heap[id as usize].kind {
        Kind::Bytes(b) => b,
        _ => unreachable!("checked by this_bytes"),
    }
}

fn len_of(vm: &Vm, id: Id) -> usize {
    bytes_ref(vm, id).len
}

// ---------- accessors ----------

pub fn get_prop(vm: &mut Vm, id: Id, key: Atom) -> Option<Value> {
    let b = bytes_ref(vm, id);
    if b.elem == Elem::ArrayBuffer {
        return (key == vm.names.byte_length).then_some(Value::Num(b.len as f64));
    }
    if let Some(i) = vm.atoms.index(key) {
        return Some(match b.num(i as usize) {
            Some(v) => Value::Num(v),
            None => Value::Undef,
        });
    }
    if key == vm.names.length {
        return Some(Value::Num(b.len as f64));
    }
    if key == vm.names.byte_length {
        return Some(Value::Num(b.byte_len() as f64));
    }
    if key == vm.names.byte_offset {
        return Some(Value::Num(b.start as f64));
    }
    if key == vm.names.buffer {
        return Some(Value::Obj(array_buffer_of(vm, id)));
    }
    None
}

/// The `ArrayBuffer` object of a typed array's buffer, made the first time it is needed.
pub fn array_buffer_of(vm: &mut Vm, id: Id) -> Id {
    let b = bytes_ref(vm, id);
    if let Some(owner) = b.owner {
        return owner;
    }
    let buf = b.buf.clone();
    let len = buf.lock().unwrap_or_else(PoisonError::into_inner).len();
    let proto = vm.realm.std.array_buffer;
    let owner = vm.alloc(Obj::new(
        Some(proto),
        Kind::Bytes(Box::new(Bytes {
            buf,
            start: 0,
            len,
            buffer: false,
            elem: Elem::ArrayBuffer,
            owner: None,
        })),
    ));
    if let Kind::Bytes(b) = &mut vm.heap[id as usize].kind {
        b.owner = Some(owner);
    }
    owner
}

pub fn set_prop(vm: &mut Vm, id: Id, key: Atom, val: Value) -> Option<Result<(), Value>> {
    let elem = bytes_ref(vm, id).elem;
    if elem == Elem::ArrayBuffer {
        return (key == vm.names.byte_length).then(|| Err(vm.only_getter(&Value::Obj(id), key)));
    }
    if let Some(i) = vm.atoms.index(key) {
        return Some(
            super::builtin_number(vm, &val).map(|n| bytes_ref(vm, id).set_num(i as usize, n)),
        );
    }
    let names = &vm.names;
    if [
        names.length,
        names.byte_length,
        names.byte_offset,
        names.buffer,
    ]
    .contains(&key)
    {
        return Some(Err(vm.only_getter(&Value::Obj(id), key)));
    }
    // A typed array has no element at another numeric key (-1, 1.5, 2 ** 32): writing one does nothing.
    let text = vm.atoms.text(key);
    if text == "-0"
        || text
            .parse::<f64>()
            .is_ok_and(|n| crate::value::num_to_string(n) == text)
    {
        return Some(Ok(()));
    }
    None
}

pub fn has_own(vm: &Vm, id: Id, key: Atom) -> bool {
    let b = bytes_ref(vm, id);
    b.elem != Elem::ArrayBuffer && vm.atoms.index(key).is_some_and(|i| (i as usize) < b.len)
}

pub fn index_len(vm: &Vm, id: Id) -> usize {
    let b = bytes_ref(vm, id);
    if b.elem == Elem::ArrayBuffer {
        0
    } else {
        b.len
    }
}

/// A typed array's elements as JS prints them, joined by `sep`.
pub fn join_nums(b: &Bytes, sep: &str) -> String {
    if b.elem == Elem::U8 {
        return join_bytes(&b.to_vec(), sep);
    }
    let parts: Vec<String> = b
        .nums()
        .into_iter()
        .map(crate::value::num_to_string)
        .collect();
    parts.join(sep)
}

/// The message for a typed array or `ArrayBuffer` at the result boundary.
pub fn boundary_message(elem: Elem) -> String {
    match elem {
        Elem::U8 => "A Uint8Array cannot cross to the host; pass text instead, e.g. `new TextDecoder().decode(bytes)` or `bytes.toBase64()`.".to_owned(),
        Elem::ArrayBuffer => "An ArrayBuffer cannot cross to the host as data; pass a typed array of it to a host function, or its values, e.g. `Array.from(new Uint8Array(buffer))`.".to_owned(),
        e => format!("A {} cannot cross to the host as data; pass it to a host function, or its values, e.g. `Array.from(values)`.", e.name()),
    }
}

pub fn inspect(vm: &Vm, id: Id) -> String {
    let b = bytes_ref(vm, id);
    if b.elem == Elem::ArrayBuffer {
        return format!("ArrayBuffer {{ byteLength: {} }}", b.len);
    }
    if b.elem != Elem::U8 {
        return format!("{}({}) [{}]", b.elem.name(), b.len, join_nums(b, ","));
    }
    let data = b.to_vec();
    if b.buffer {
        let shown: Vec<String> = data.iter().take(50).map(|x| format!("{x:02x}")).collect();
        let more = if data.len() > 50 {
            format!(" ... {} more bytes", data.len() - 50)
        } else {
            String::new()
        };
        let shown = shown.join(" ");
        return format!(
            "<Buffer{}{more}>",
            if shown.is_empty() {
                String::new()
            } else {
                format!(" {shown}")
            }
        );
    }
    let list: Vec<String> = data.iter().map(u8::to_string).collect();
    format!("Uint8Array({}) [{}]", data.len(), list.join(","))
}

/// JSON form: index keys in `JSON.stringify`, and refused at the host boundary.
pub fn json_value(vm: &mut Vm, id: Id, boundary: bool) -> Res {
    if boundary {
        let p = vm.realm.type_error_proto;
        let message = boundary_message(bytes_ref(vm, id).elem);
        return Err(vm.failure(p, &message, crate::DiagnosticKind::InvalidDataValue));
    }
    let b = bytes_ref(vm, id);
    let data = if b.elem == Elem::ArrayBuffer {
        Vec::new()
    } else {
        b.nums()
    };
    let o = vm.new_object();
    for (i, b) in data.iter().enumerate() {
        let k = vm.atoms.intern(&i.to_string());
        vm.define(o, k, Value::Num(*b));
    }
    Ok(Value::Obj(o))
}

// ---------- base64 and hex ----------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64_encode(data: &[u8], url: bool, pad: bool) -> String {
    let table = if url { B64URL } else { B64 };
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (chunk.get(1).copied().unwrap_or(0) as u32) << 8
            | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(table[(n >> 18) as usize & 63] as char);
        out.push(table[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(table[(n >> 6) as usize & 63] as char);
        } else if pad {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(table[n as usize & 63] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

fn b64_value(c: char, url: Option<bool>) -> Option<u32> {
    Some(match c {
        'A'..='Z' => c as u32 - 'A' as u32,
        'a'..='z' => c as u32 - 'a' as u32 + 26,
        '0'..='9' => c as u32 - '0' as u32 + 52,
        '+' if url != Some(true) => 62,
        '/' if url != Some(true) => 63,
        '-' if url != Some(false) => 62,
        '_' if url != Some(false) => 63,
        _ => return None,
    })
}

/// Forgiving-base64 decode (WHATWG), as `atob` and `Uint8Array.fromBase64` read it.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut s: Vec<char> = text
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\u{c}' | '\r'))
        .collect();
    if s.len().is_multiple_of(4) && s.last() == Some(&'=') {
        s.pop();
        if s.last() == Some(&'=') {
            s.pop();
        }
    }
    if s.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s {
        let v = b64_value(c, Some(false))?;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Lenient decode for Node's base64 and base64url: either alphabet, stopping at the first invalid character.
pub fn base64_decode_node(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in text.chars() {
        if c == '=' {
            break;
        }
        let Some(v) = b64_value(c, None) else {
            if c.is_whitespace() {
                continue;
            }
            break;
        };
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

pub fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let b = text.as_bytes();
    b.chunks(2)
        .map(|p| {
            let hi = (p[0] as char).to_digit(16)?;
            let lo = (p[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

// ---------- Uint8Array ----------

pub fn setup(vm: &mut Vm) {
    let op = vm.realm.object_proto;
    let proto = vm.plain(op);
    vm.realm.std.uint8 = proto;
    let ctor = vm.ctor("Uint8Array", 3, uint8_ctor, proto, Value::Undef);
    vm.methods(
        ctor,
        &[
            ("from", 1, uint8_from),
            ("of", 0, uint8_of),
            ("fromBase64", 1, uint8_from_base64),
            ("fromHex", 1, uint8_from_hex),
        ],
    );
    vm.constant(ctor, "BYTES_PER_ELEMENT", Value::Num(1.0));
    vm.constant(proto, "BYTES_PER_ELEMENT", Value::Num(1.0));
    super::accessors(vm, proto, &["length", "byteLength", "byteOffset", "buffer"]);
    vm.methods(
        proto,
        &[
            ("at", 1, u_at),
            ("slice", 2, u_slice),
            ("subarray", 2, u_subarray),
            ("set", 1, u_set),
            ("fill", 1, u_fill),
            ("reverse", 0, u_reverse),
            ("sort", 1, u_sort),
            ("indexOf", 1, u_index_of),
            ("lastIndexOf", 1, u_last_index_of),
            ("includes", 1, u_includes),
            ("join", 1, u_join),
            ("toString", 0, u_to_string),
            ("toBase64", 0, u_to_base64),
            ("toHex", 0, u_to_hex),
            ("keys", 0, u_keys),
            ("values", 0, u_values),
            ("entries", 0, u_entries),
            ("map", 1, u_map),
            ("filter", 1, u_filter),
            ("forEach", 1, u_for_each),
            ("some", 1, u_some),
            ("every", 1, u_every),
            ("find", 1, u_find),
            ("findIndex", 1, u_find_index),
            ("findLast", 1, u_find_last),
            ("findLastIndex", 1, u_find_last_index),
            ("reduce", 1, u_reduce),
            ("reduceRight", 1, u_reduce_right),
        ],
    );
    let vk = vm.atoms.intern_static("values");
    let values = vm.get_obj(proto, vk);
    vm.define_hidden(proto, SYM_ITERATOR, values);

    let ep = vm.plain(op);
    vm.realm.std.text_encoder = ep;
    let utf8 = vm.static_str("utf-8");
    let ek = vm.atoms.intern_static("encoding");
    vm.define_hidden(ep, ek, utf8);
    vm.method(ep, "encode", 0, encoder_encode);
    vm.ctor("TextEncoder", 0, encoder_ctor, ep, Value::Undef);

    let dp = vm.plain(op);
    vm.realm.std.text_decoder = dp;
    super::accessors(vm, dp, &["encoding", "fatal", "ignoreBOM"]);
    vm.method(dp, "decode", 0, decoder_decode);
    vm.ctor("TextDecoder", 0, decoder_ctor, dp, Value::Undef);

    let atob = vm.native_fn("atob", 1, global_atob, Value::Undef);
    vm.global("atob", atob);
    let btoa = vm.native_fn("btoa", 1, global_btoa, Value::Undef);
    vm.global("btoa", btoa);
}

fn requires_new(vm: &mut Vm, this: &Value, name: &str) -> Result<(), Value> {
    if matches!(this, Value::Uninit) {
        Ok(())
    } else {
        Err(vm.type_error(&format!("Constructor {name} requires 'new'.")))
    }
}

fn is_iterable(vm: &mut Vm, v: &Value) -> bool {
    match v {
        Value::Obj(id) => {
            matches!(
                vm.heap[*id as usize].kind,
                Kind::Array(_) | Kind::Map(_) | Kind::Set(_) | Kind::Generator(_)
            ) || vm.has_program_getter(*id, SYM_ITERATOR)
                || !matches!(vm.get_obj(*id, SYM_ITERATOR), Value::Undef | Value::Null)
        }
        Value::Str(_) => true,
        _ => false,
    }
}

/// What a built-in does with the bytes it collected: `new Uint8Array(...)` and `Uint8Array.from` make a Uint8Array of
/// them, `set` writes them into `target` at `offset`.
#[derive(Clone, Copy)]
pub(super) enum Sink {
    New(Elem),
    Set { target: Id, offset: Value },
}

/// The values a Uint8Array, array or iterable describes, each mapped (with the original values) then converted, handed
/// to `into`. An iterable is read and mapped by a native frame (`Collect`).
pub(super) fn collect(
    vm: &mut Vm,
    source: &Value,
    name: &str,
    mapper: Option<(Value, Value)>,
    native: bool,
    into: Sink,
    callee: Id,
) -> Res {
    if let (Some(b), None) = (as_typed(vm, source), &mapper) {
        let values = b.nums();
        return collected(vm, &values, into);
    }
    // The reference's `collectBytes`, after the native's own call when a native hands on to it (see `fuel.rs`).
    if native {
        fuel::handoff(vm);
    } else {
        fuel::method(vm);
    }
    fuel::native(vm);
    if !is_iterable(vm, source) {
        let d = describe_value(vm, source);
        fuel::native(vm);
        return Err(vm.type_error(&format!(
            "{name} expects a Uint8Array, an array, or an iterable of numbers, received {d}."
        )));
    }
    if mapper.is_none() && steps_natively(vm, source) {
        let values = fuel::for_of(vm, source)?;
        return convert(vm, &values, into);
    }
    let (f, this_arg) = mapper.unwrap_or_default();
    let (target, offset) = match into {
        Sink::New(elem) => (Value::Undef, Value::Num(elem.code() as f64)),
        Sink::Set { target, offset } => (Value::Obj(target), offset),
    };
    let values = vm.new_array(Vec::new());
    crate::native::enter_for_of_sub(
        vm,
        crate::native::NativeOp::Arrays,
        COLLECT,
        callee,
        Value::Undef,
        *source,
        &[f, this_arg, values, target, offset, Value::Num(0.0)],
    )
}

/// Whether iterating `v` runs no program code: its iterator is the VM's own over its items (see `Vm::walks`), which
/// reads them without calling anything.
fn steps_natively(vm: &Vm, v: &Value) -> bool {
    match v {
        Value::Str(_) => true,
        Value::Obj(id) => matches!(
            vm.heap[*id as usize].kind,
            Kind::Array(_) | Kind::Map(_) | Kind::Set(_)
        ),
        _ => false,
    }
}

/// The end of the reference's `collectBytes`: each collected value converted to a number.
fn convert(vm: &mut Vm, values: &[Value], into: Sink) -> Res {
    fuel::native(vm);
    vm.bytecode_builtin();
    let mut data = Vec::with_capacity(values.len());
    for v in values {
        data.push(super::builtin_number(vm, v)?);
    }
    collected(vm, &data, into)
}

/// Hands collected values to what the built-in does with them, converted to the typed array's elements.
fn collected(vm: &mut Vm, data: &[f64], into: Sink) -> Res {
    let (target, offset) = match into {
        Sink::New(elem) => return Ok(new_typed(vm, elem.encode(data), elem)),
        Sink::Set { target, offset } => (target, offset),
    };
    let offset = match offset {
        Value::Undef => 0.0,
        v => super::builtin_integer(vm, &v)?,
    };
    let b = bytes_ref(vm, target);
    if offset < 0.0 || data.len() as f64 + offset > b.len as f64 {
        let name = b.elem.name();
        return Err(vm.range_error(&format!(
            "{name}.set: the source does not fit at that offset."
        )));
    }
    let (size, elem, start) = (
        b.elem.size(),
        b.elem,
        b.start + offset as usize * b.elem.size(),
    );
    let mut bytes = b.bytes();
    for (i, v) in data.iter().enumerate() {
        elem.write(*v, &mut bytes[start + i * size..]);
    }
    Ok(Value::Undef)
}

// The native frames of this family, by sub-op (see `family_step`).
const COLLECT: u16 = 0;
const WALK: u16 = 1;
const REDUCE: u16 = 2;

// The slots of a `Collect` frame, after the loop's: the mapper and its receiver, the values read (an array), where
// they go (`set`'s target or undefined, and its offset), and the index the mapper is at.
const COL_MAPPER: usize = FOR_OF_SLOTS;
const COL_THIS: usize = FOR_OF_SLOTS + 1;
const COL_VALUES: usize = FOR_OF_SLOTS + 2;
const COL_TARGET: usize = FOR_OF_SLOTS + 3;
const COL_OFFSET: usize = FOR_OF_SLOTS + 4;
const COL_K: usize = FOR_OF_SLOTS + 5;

/// The reference's `collectBytes` over an iterable: every value is read first, then each is mapped, with a back-edge
/// after each call.
struct Collect;

impl ForOf for Collect {
    fn item(vm: &mut Vm, fr: Frame, x: Value) -> Result<Flow, Value> {
        if let Some(Kind::Array(values)) = fr
            .slot(vm, COL_VALUES)
            .obj()
            .map(|o| &mut vm.heap[o as usize].kind)
        {
            values.push(x);
        }
        Ok(Flow::Next)
    }

    fn finish(vm: &mut Vm, fr: Frame) -> Res {
        let values = values_of(vm, fr.slot(vm, COL_VALUES)).to_vec();
        let into = match fr.get(vm, COL_TARGET) {
            Value::Obj(target) => Sink::Set {
                target,
                offset: fr.get(vm, COL_OFFSET),
            },
            _ => Sink::New(
                Elem::from_code(fr.get(vm, COL_OFFSET).as_num() as u64).unwrap_or(Elem::U8),
            ),
        };
        convert(vm, &values, into)
    }

    fn done(vm: &mut Vm, fr: Frame) -> Result<Step, Value> {
        if fr.slot(vm, COL_MAPPER) == Slot::UNDEF {
            return Ok(Step::Done(Self::finish(vm, fr)?));
        }
        collect_map(vm, fr, 0)
    }

    fn after(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
        let k = fr.index(vm, COL_K);
        match input {
            Input::Returned(r) => {
                if let Some(Kind::Array(values)) = fr
                    .slot(vm, COL_VALUES)
                    .obj()
                    .map(|o| &mut vm.heap[o as usize].kind)
                    && let Some(v) = values.get_mut(k)
                {
                    *v = r.get();
                }
                fuel::step(vm);
                collect_map(vm, fr, k + 1)
            }
            Input::Threw(e) => Err(e),
            Input::Start | Input::Finished(_) => collect_map(vm, fr, k),
        }
    }
}

/// Calls the mapper on the value at `k`, or finishes once every value is mapped.
fn collect_map(vm: &mut Vm, fr: Frame, k: usize) -> Result<Step, Value> {
    let Some(v) = values_of(vm, fr.slot(vm, COL_VALUES)).get(k).copied() else {
        return Ok(Step::Done(Collect::finish(vm, fr)?));
    };
    fr.set_index(vm, COL_K, k);
    let (f, this_arg) = (fr.slot(vm, COL_MAPPER), fr.slot(vm, COL_THIS));
    fr.call_slots(vm, f, this_arg, [Slot::pack(v), Slot::index(k)])
}

fn values_of(vm: &Vm, s: Slot) -> &[Value] {
    match s.obj().map(|o| &vm.heap[o as usize].kind) {
        Some(Kind::Array(values)) => values,
        _ => &[],
    }
}

fn uint8_ctor(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    requires_new(vm, &this, "Uint8Array")?;
    let source = arg(args, 0);
    if let Some(buf) = super::typed::as_array_buffer(vm, &source) {
        return super::typed::from_buffer(vm, Elem::U8, buf, &arg(args, 1), &arg(args, 2));
    }
    if let Value::Obj(_) = source {
        return collect(
            vm,
            &source,
            "new Uint8Array(...)",
            None,
            false,
            Sink::New(Elem::U8),
            callee,
        );
    }
    let n = match source {
        Value::Undef => 0.0,
        v => super::builtin_number(vm, &v)?,
    };
    if n.fract() != 0.0 || !n.is_finite() || n < 0.0 {
        let s = vm.string_of(&source)?;
        let s = vm.text(s).to_owned();
        return Err(vm.range_error(&format!("Invalid typed array length: {s}")));
    }
    if n > MAX_ARRAY_LEN as f64 {
        return Err(vm.range_error("Invalid array length"));
    }
    Ok(new_bytes(vm, vec![0; n as usize], false))
}

fn optional_callback(vm: &mut Vm, f: &Value, name: &str) -> Result<Option<Value>, Value> {
    if let Value::Undef = f {
        return Ok(None);
    }
    super::require_callback(vm, f, name).map(Some)
}

fn uint8_from(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    let mapper = optional_callback(vm, &arg(args, 1), "Uint8Array.from")?;
    collect(
        vm,
        &arg(args, 0),
        "Uint8Array.from",
        mapper.map(|f| (f, arg(args, 2))),
        true,
        Sink::New(Elem::U8),
        callee,
    )
}

fn uint8_of(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let mut data = Vec::with_capacity(args.len());
    for a in args {
        data.push(to_u8(super::builtin_number(vm, a)?));
    }
    Ok(new_bytes(vm, data, false))
}

fn uint8_from_base64(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    const NAME: &str = "Uint8Array.fromBase64";
    let Value::Str(s) = arg(args, 0) else {
        return Err(vm.type_error("Uint8Array.fromBase64 expects a string."));
    };
    // The options are read through their getters, ahead (`Vm::reading`).
    let (url, last) = vm.reading(|vm| {
        let options = base64_options(vm, &arg(args, 1), NAME)?;
        let url = base64_option(vm, options, "alphabet", &["base64", "base64url"], NAME)? == 1;
        let last = base64_option(
            vm,
            options,
            "lastChunkHandling",
            &["loose", "strict", "stop-before-partial"],
            NAME,
        )?;
        Ok((url, last))
    })?;
    match from_base64(vm.text(s), url, last) {
        Some(d) => Ok(new_bytes(vm, d, false)),
        None => Err(vm.syntax_error("Uint8Array.fromBase64: the string is not valid base64.")),
    }
}

/// The options object of the base64 methods: undefined or an object.
fn base64_options(vm: &mut Vm, v: &Value, name: &str) -> Result<Option<Id>, Value> {
    match v {
        Value::Undef => Ok(None),
        Value::Obj(id) if !vm.is_namespace(*id) => Ok(Some(*id)),
        _ => Err(vm.type_error(&format!("{name} requires that options be an object."))),
    }
}

/// A string option of the base64 methods: the index of the one of `allowed` it is, 0 when undefined.
fn base64_option(
    vm: &mut Vm,
    options: Option<Id>,
    key: &'static str,
    allowed: &[&str],
    name: &str,
) -> Result<usize, Value> {
    let Some(id) = options else { return Ok(0) };
    let k = vm.atoms.intern_static(key);
    let v = vm.get_obj(id, k);
    if let Value::Undef = v {
        return Ok(0);
    }
    if let Value::Str(s) = v
        && let Some(i) = allowed.iter().position(|a| *a == vm.text(s))
    {
        return Ok(i);
    }
    let list: Vec<String> = allowed.iter().map(|a| format!("\"{a}\"")).collect();
    Err(vm.type_error(&format!(
        "{name} requires that {key} be {}.",
        list.join(" or ")
    )))
}

/// FromBase64 of the base64 proposal: `url` picks the alphabet, `last` the last chunk's handling (0 loose, 1 strict,
/// 2 stop-before-partial). `None` for a SyntaxError.
fn from_base64(text: &str, url: bool, last: usize) -> Option<Vec<u8>> {
    let units: Vec<char> = text.chars().collect();
    let ws = |c: char| matches!(c, '\t' | '\n' | '\u{c}' | '\r' | ' ');
    let skip = |mut i: usize| {
        while i < units.len() && ws(units[i]) {
            i += 1;
        }
        i
    };
    let mut out = Vec::new();
    let mut chunk: Vec<u32> = Vec::with_capacity(4);
    let mut i = 0;
    loop {
        i = skip(i);
        if i == units.len() {
            if !chunk.is_empty() {
                match last {
                    2 => return Some(out),
                    0 if chunk.len() > 1 => decode_chunk(&chunk, false, &mut out)?,
                    _ => return None,
                }
            }
            return Some(out);
        }
        let c = units[i];
        i += 1;
        if c == '=' {
            if chunk.len() < 2 {
                return None;
            }
            i = skip(i);
            if chunk.len() == 2 {
                if i == units.len() {
                    return (last == 2).then_some(out);
                }
                if units[i] == '=' {
                    i = skip(i + 1);
                }
            }
            if i < units.len() {
                return None;
            }
            decode_chunk(&chunk, last == 1, &mut out)?;
            return Some(out);
        }
        let c = match (url, c) {
            (true, '+' | '/') | (false, '-' | '_') => return None,
            (true, '-') => '+',
            (true, '_') => '/',
            (_, c) => c,
        };
        chunk.push(b64_value(c, Some(false))?);
        if chunk.len() == 4 {
            decode_chunk(&chunk, false, &mut out)?;
            chunk.clear();
        }
    }
}

/// DecodeBase64Chunk: 2, 3 or 4 sextets; `strict` refuses non-zero bits past the last byte.
fn decode_chunk(chunk: &[u32], strict: bool, out: &mut Vec<u8>) -> Option<()> {
    let n = chunk
        .iter()
        .chain(std::iter::repeat(&0))
        .take(4)
        .fold(0u32, |acc, s| acc << 6 | s);
    let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
    let keep = chunk.len() - 1;
    if strict && bytes[keep..].iter().any(|b| *b != 0) {
        return None;
    }
    out.extend_from_slice(&bytes[..keep]);
    Some(())
}

fn uint8_from_hex(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let Value::Str(s) = arg(args, 0) else {
        return Err(vm.type_error("Uint8Array.fromHex expects a string."));
    };
    match hex_decode(vm.text(s)) {
        Some(d) => Ok(new_bytes(vm, d, false)),
        None => Err(vm.syntax_error("Uint8Array.fromHex: the string is not valid hex.")),
    }
}

/// A relative index (negative counts from the end), clamped to `0..=len`; `undefined` is `default`.
pub fn rel_index(vm: &mut Vm, v: &Value, len: usize, default: usize) -> Result<usize, Value> {
    if let Value::Undef = v {
        return Ok(default);
    }
    let n = super::builtin_integer(vm, v)?;
    Ok(if n < 0.0 {
        (len as f64 + n).max(0.0) as usize
    } else {
        n.min(len as f64) as usize
    })
}

fn u_at(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "at")?;
    let len = len_of(vm, id) as f64;
    let mut i = super::builtin_integer(vm, &arg(args, 0))?;
    if i < 0.0 {
        i += len;
    }
    if i < 0.0 || i >= len {
        return Ok(Value::Undef);
    }
    Ok(match bytes_ref(vm, id).get(i as usize) {
        Some(b) => Value::Num(b as f64),
        None => Value::Undef,
    })
}

fn range(vm: &mut Vm, id: Id, args: &[Value]) -> Result<(usize, usize), Value> {
    let len = len_of(vm, id);
    let start = rel_index(vm, &arg(args, 0), len, 0)?;
    let end = rel_index(vm, &arg(args, 1), len, len)?;
    Ok((start, end.max(start)))
}

fn u_slice(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "slice")?;
    let (s, e) = range(vm, id, args)?;
    // New bytes of the receiver's kind: a Buffer's are a Buffer.
    let b = bytes_ref(vm, id);
    let (data, buffer) = (b.view(s, e, false).to_vec(), b.buffer);
    Ok(new_bytes(vm, data, buffer))
}

fn u_subarray(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "subarray")?;
    let (s, e) = range(vm, id, args)?;
    if !bytes_ref(vm, id).buffer {
        array_buffer_of(vm, id);
    }
    let b = bytes_ref(vm, id);
    let v = b.view(s, e, b.buffer);
    Ok(view_value(vm, v))
}

fn u_set(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_bytes(vm, &this, "set")?;
    // The reference reads the offset as a number (which calls nothing) before the source, so its failure comes first.
    if !matches!(arg(args, 1), Value::Undef) {
        super::builtin_number(vm, &arg(args, 1))?;
    }
    let into = Sink::Set {
        target: id,
        offset: arg(args, 1),
    };
    collect(
        vm,
        &arg(args, 0),
        "Uint8Array.set",
        None,
        true,
        into,
        callee,
    )
}

fn u_fill(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "fill")?;
    let v = to_u8(super::builtin_number(vm, &arg(args, 0))?);
    let len = len_of(vm, id);
    let s = rel_index(vm, &arg(args, 1), len, 0)?;
    let e = rel_index(vm, &arg(args, 2), len, len)?;
    let b = bytes_ref(vm, id);
    for i in s..e {
        b.put(i, v);
    }
    Ok(this)
}

fn u_reverse(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "reverse")?;
    let b = bytes_ref(vm, id);
    let mut data = b.to_vec();
    data.reverse();
    for (i, v) in data.into_iter().enumerate() {
        b.put(i, v);
    }
    Ok(this)
}

fn u_sort(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_bytes(vm, &this, "sort")?;
    let cmp = arg(args, 0);
    super::array::sort_comparator(vm, &cmp, "Uint8Array.sort")?;
    let mut data = bytes_ref(vm, id).to_vec();
    if !matches!(cmp, Value::Undef) {
        let list: Vec<Value> = data.iter().map(|b| Value::Num(*b as f64)).collect();
        return super::array::sort_with(vm, callee, this, list, cmp, 0, super::array::SORT_BYTES);
    }
    data.sort_unstable();
    let b = bytes_ref(vm, id);
    for (i, v) in data.into_iter().enumerate() {
        b.put(i, v);
    }
    Ok(this)
}

/// Writes a sort's result into the bytes `id`.
pub(super) fn put_sorted(vm: &mut Vm, id: Id, sorted: &[Value]) {
    let b = bytes_ref(vm, id);
    for (i, v) in sorted.iter().enumerate() {
        b.put(i, to_u8(v.as_num()));
    }
}

/// A search value: only numbers can equal a byte.
fn search_value(v: &Value) -> f64 {
    match v {
        Value::Num(n) => *n,
        _ => f64::NAN,
    }
}

fn u_index_of(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "indexOf")?;
    let x = search_value(&arg(args, 0));
    let len = len_of(vm, id);
    let from = rel_index(vm, &arg(args, 1), len, 0)?;
    let data = bytes_ref(vm, id).to_vec();
    Ok(Value::Num(
        (from..len)
            .find(|i| data[*i] as f64 == x)
            .map(|i| i as f64)
            .unwrap_or(-1.0),
    ))
}

fn u_last_index_of(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "lastIndexOf")?;
    let x = search_value(&arg(args, 0));
    let len = len_of(vm, id) as f64;
    let from = if args.len() < 2 {
        len - 1.0
    } else {
        let n = super::builtin_integer(vm, &args[1])?;
        if n < 0.0 { len + n } else { n.min(len - 1.0) }
    };
    let data = bytes_ref(vm, id).to_vec();
    if from < 0.0 {
        return Ok(Value::Num(-1.0));
    }
    Ok(Value::Num(
        (0..=from as usize)
            .rev()
            .find(|i| data[*i] as f64 == x)
            .map(|i| i as f64)
            .unwrap_or(-1.0),
    ))
}

fn u_includes(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "includes")?;
    let x = search_value(&arg(args, 0));
    let len = len_of(vm, id);
    let from = rel_index(vm, &arg(args, 1), len, 0)?;
    let data = bytes_ref(vm, id).to_vec();
    Ok(Value::Bool((from..len).any(|i| data[i] as f64 == x)))
}

pub fn join_bytes(data: &[u8], sep: &str) -> String {
    let parts: Vec<String> = data.iter().map(u8::to_string).collect();
    parts.join(sep)
}

fn u_join(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "join")?;
    let sep = match arg(args, 0) {
        Value::Undef => ",".to_owned(),
        v => {
            let s = vm.string_of(&v)?;
            vm.text(s).to_owned()
        }
    };
    let out = join_bytes(&bytes_ref(vm, id).to_vec(), &sep);
    if out.len() > MAX_STRING_LEN {
        return Err(vm.range_error("Invalid string length"));
    }
    Ok(vm.string_val(out))
}

fn u_to_string(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "toString")?;
    let out = join_bytes(&bytes_ref(vm, id).to_vec(), ",");
    Ok(vm.string_val(out))
}

fn u_to_base64(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    const NAME: &str = "Uint8Array.prototype.toBase64";
    let id = this_bytes(vm, &this, "toBase64")?;
    let (url, pad) = vm.reading(|vm| {
        let options = base64_options(vm, &arg(args, 0), NAME)?;
        let url = base64_option(vm, options, "alphabet", &["base64", "base64url"], NAME)? == 1;
        let omit = match options {
            Some(o) => {
                let k = vm.atoms.intern_static("omitPadding");
                let v = vm.get_obj(o, k);
                vm.truthy(&v)
            }
            None => false,
        };
        Ok((url, !omit))
    })?;
    let out = base64_encode(&bytes_ref(vm, id).to_vec(), url, pad);
    Ok(vm.string_val(out))
}

fn u_to_hex(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    let id = this_bytes(vm, &this, "toHex")?;
    let out = hex_encode(&bytes_ref(vm, id).to_vec());
    Ok(vm.string_val(out))
}

fn u_iter(vm: &mut Vm, this: &Value, name: &str, kind: IterKind) -> Res {
    let id = this_bytes(vm, this, name)?;
    Ok(super::iterator::exotic_iter(vm, id, kind))
}

fn u_keys(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    u_iter(vm, &this, "keys", IterKind::Keys)
}

fn u_values(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    u_iter(vm, &this, "values", IterKind::Values)
}

fn u_entries(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    u_iter(vm, &this, "entries", IterKind::Entries)
}

/// One step of a live iterator over bytes.
pub fn iter_step(vm: &mut Vm, target: Id, pos: usize, kind: IterKind) -> Option<Value> {
    let b = bytes_ref(vm, target).num(pos)?;
    Some(match kind {
        IterKind::Keys => Value::Num(pos as f64),
        IterKind::Values => Value::Num(b),
        IterKind::Entries => vm.new_array(vec![Value::Num(pos as f64), Value::Num(b)]),
    })
}

fn byte_at(vm: &Vm, id: Id, i: usize) -> Value {
    match bytes_ref(vm, id).get(i) {
        Some(b) => Value::Num(b as f64),
        None => Value::Undef,
    }
}

// The callback methods run as native frames (see `native.rs`): each checks its receiver and callback as the reference's
// `Uint8Array$prototype$...` and its shared item loop do (see `fuel.rs`), then its frame calls the callback once per
// index of the length fixed at the start, reading each byte live. The slots of a `walk` frame:
const WALK_F: usize = 0;
const WALK_THIS: usize = 1;
const WALK_N: usize = 2;
const WALK_K: usize = 3;
const WALK_MODE: usize = 4;
/// `map`'s and `filter`'s bytes, as an array of numbers.
const WALK_OUT: usize = 5;
/// The byte and index of the call that is running.
const WALK_V: usize = 6;
const WALK_I: usize = 7;
/// What converting one of `map`'s results last threw, thrown once the walk ends; uninitialized while none did.
const WALK_ERR: usize = 8;

const FOR_EACH: usize = 0;
const MAP: usize = 1;
const FILTER: usize = 2;
const SOME: usize = 3;
const EVERY: usize = 4;
const FIND: usize = 5;
const FIND_INDEX: usize = 6;
/// The methods from here on walk from the end.
const FIND_LAST: usize = 7;
const FIND_LAST_INDEX: usize = 8;

fn walk(vm: &mut Vm, this: Value, args: &[Value], callee: Id, mode: usize, name: &str) -> Res {
    fuel::method(vm);
    let id = this_bytes(vm, &this, name)?;
    fuel::receiver_then_loop(vm);
    let f = super::require_callback(vm, &arg(args, 0), &format!("Uint8Array.{name}"))?;
    fuel::native(vm);
    let out = match mode {
        MAP | FILTER => vm.new_array(Vec::new()),
        _ => Value::Undef,
    };
    let len = len_of(vm, id);
    vm.enter_native_sub(
        crate::native::NativeOp::Arrays,
        WALK,
        callee,
        this,
        &[
            f,
            arg(args, 1),
            Value::Num(len as f64),
            Value::Num(0.0),
            Value::Num(mode as f64),
            out,
            Value::Undef,
            Value::Num(0.0),
            Value::Uninit,
        ],
    )
}

/// The step of a `walk` frame.
fn walk_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    let mode = fr.index(vm, WALK_MODE);
    let mut k = fr.index(vm, WALK_K);
    match input {
        Input::Start | Input::Finished(_) => {}
        Input::Returned(r) => {
            if let Some(done) = walk_visit(vm, fr, mode, r.get()) {
                vm.bytecode_builtin();
                return Ok(Step::Done(done));
            }
            fuel::step(vm);
            k += 1;
        }
        Input::Threw(e) => return Err(e),
    }
    let this = fr.this_slot(vm);
    let (Some(id), n) = (this.obj(), fr.index(vm, WALK_N)) else {
        return Ok(Step::Done(Value::Undef));
    };
    if k >= n {
        return walk_end(vm, fr, mode);
    }
    let i = if mode >= FIND_LAST { n - 1 - k } else { k };
    let v = Slot::pack(byte_at(vm, id, i));
    fr.set_index(vm, WALK_K, k);
    fr.set_slot(vm, WALK_V, v);
    fr.set_index(vm, WALK_I, i);
    let (f, this_arg) = (fr.slot(vm, WALK_F), fr.slot(vm, WALK_THIS));
    fr.call_slots(vm, f, this_arg, [v, Slot::index(i), this])
}

/// What the callback's result `r` does: the method's result when it stops the walk.
fn walk_visit(vm: &mut Vm, fr: Frame, mode: usize, r: Value) -> Option<Value> {
    match mode {
        MAP => {
            match super::builtin_number(vm, &r) {
                Ok(n) => push_out(vm, fr, Value::Num(to_u8(n) as f64)),
                Err(e) => fr.set(vm, WALK_ERR, e),
            }
            None
        }
        FILTER => {
            let item = fr.get(vm, WALK_V);
            if vm.truthy(&r)
                && let Value::Num(n) = item
            {
                push_out(vm, fr, Value::Num(n as u8 as f64));
            }
            None
        }
        SOME => vm.truthy(&r).then_some(Value::Bool(true)),
        EVERY => (!vm.truthy(&r)).then_some(Value::Bool(false)),
        FIND | FIND_LAST => vm.truthy(&r).then(|| fr.get(vm, WALK_V)),
        FIND_INDEX | FIND_LAST_INDEX => vm
            .truthy(&r)
            .then(|| Value::Num(fr.index(vm, WALK_I) as f64)),
        _ => None,
    }
}

fn push_out(vm: &mut Vm, fr: Frame, v: Value) {
    if let Some(Kind::Array(out)) = fr
        .slot(vm, WALK_OUT)
        .obj()
        .map(|o| &mut vm.heap[o as usize].kind)
    {
        out.push(v);
    }
}

/// The result of a `walk` frame that visited every index.
fn walk_end(vm: &mut Vm, fr: Frame, mode: usize) -> Result<Step, Value> {
    let e = fr.get(vm, WALK_ERR);
    if mode == MAP && !matches!(e, Value::Uninit) {
        return Err(e);
    }
    if let MAP | FILTER = mode {
        fuel::native(vm);
    }
    vm.bytecode_builtin();
    Ok(Step::Done(match mode {
        MAP | FILTER => {
            let data = values_of(vm, fr.slot(vm, WALK_OUT))
                .iter()
                .map(|v| v.as_num() as u8)
                .collect();
            // Of the receiver's kind: a Buffer's map makes a Buffer.
            let buffer = fr
                .this_slot(vm)
                .obj()
                .is_some_and(|id| bytes_ref(vm, id).buffer);
            new_bytes(vm, data, buffer)
        }
        SOME => Value::Bool(false),
        EVERY => Value::Bool(true),
        FIND_INDEX | FIND_LAST_INDEX => Value::Num(-1.0),
        _ => Value::Undef,
    }))
}

fn u_for_each(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, FOR_EACH, "forEach")
}

fn u_map(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, MAP, "map")
}

fn u_filter(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, FILTER, "filter")
}

fn u_find(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, FIND, "find")
}

fn u_find_index(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, FIND_INDEX, "findIndex")
}

fn u_find_last(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, FIND_LAST, "findLast")
}

fn u_find_last_index(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, FIND_LAST_INDEX, "findLastIndex")
}

fn u_some(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, SOME, "some")
}

fn u_every(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    walk(vm, this, args, callee, EVERY, "every")
}

// The slots of a `reduce` frame: the callback, the length fixed at the start, the next position, whether it walks
// from the end, and the accumulator.
const RED_F: usize = 0;
const RED_N: usize = 1;
const RED_K: usize = 2;
const RED_REVERSE: usize = 3;
const RED_ACC: usize = 4;

fn reduce(vm: &mut Vm, this: Value, args: &[Value], callee: Id, right: bool) -> Res {
    let name = if right { "reduceRight" } else { "reduce" };
    fuel::method(vm);
    let id = this_bytes(vm, &this, name)?;
    fuel::receiver_then_loop(vm);
    let f = super::require_callback(vm, &arg(args, 0), &format!("Uint8Array.{name}"))?;
    fuel::native(vm);
    let len = len_of(vm, id);
    let (acc, k) = match args.get(1) {
        Some(acc) => (*acc, 0),
        None if len == 0 => {
            return Err(vm.type_error(&format!(
                "Uint8Array.{name} of an empty array with no initial value."
            )));
        }
        None => (byte_at(vm, id, if right { len - 1 } else { 0 }), 1),
    };
    vm.enter_native_sub(
        crate::native::NativeOp::Arrays,
        REDUCE,
        callee,
        this,
        &[
            f,
            Value::Num(len as f64),
            Value::Num(k as f64),
            Value::Bool(right),
            acc,
        ],
    )
}

/// The step of a `reduce` frame.
fn reduce_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    match input {
        Input::Start | Input::Finished(_) => {}
        Input::Returned(r) => {
            fr.set_slot(vm, RED_ACC, r);
            fuel::step(vm);
        }
        Input::Threw(e) => return Err(e),
    }
    let this = fr.this_slot(vm);
    let (Some(id), n, k) = (this.obj(), fr.index(vm, RED_N), fr.index(vm, RED_K)) else {
        return Ok(Step::Done(Value::Undef));
    };
    if k >= n {
        vm.bytecode_builtin();
        return Ok(Step::Done(fr.get(vm, RED_ACC)));
    }
    let i = if matches!(fr.get(vm, RED_REVERSE), Value::Bool(true)) {
        n - 1 - k
    } else {
        k
    };
    fr.set_index(vm, RED_K, k + 1);
    let (f, acc) = (fr.slot(vm, RED_F), fr.slot(vm, RED_ACC));
    let v = Slot::pack(byte_at(vm, id, i));
    fr.call_slots(vm, f, Slot::UNDEF, [acc, v, Slot::index(i), this])
}

fn u_reduce(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    reduce(vm, this, args, callee, false)
}

fn u_reduce_right(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    reduce(vm, this, args, callee, true)
}

// ---------- TextEncoder and TextDecoder ----------

pub struct Decoder {
    pub fatal: bool,
    pub ignore_bom: bool,
    pub(crate) queued: Vec<u8>,
    pub(crate) seen: bool,
}

fn encoder_ctor(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    requires_new(vm, &this, "TextEncoder")?;
    let proto = vm.realm.std.text_encoder;
    Ok(Value::Obj(vm.alloc(Obj::new(Some(proto), Kind::Ordinary))))
}

fn encoder_encode(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let s = match arg(args, 0) {
        Value::Undef => String::new(),
        v => {
            let s = vm.string_of(&v)?;
            crate::strings::host_text(vm.text(s)).into_owned()
        }
    };
    Ok(new_bytes(vm, s.into_bytes(), false))
}

const UTF8_LABELS: [&str; 6] = [
    "unicode-1-1-utf-8",
    "unicode11utf8",
    "unicode20utf8",
    "utf-8",
    "utf8",
    "x-unicode20utf8",
];

fn decoder_ctor(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    requires_new(vm, &this, "TextDecoder")?;
    let label = match arg(args, 0) {
        Value::Undef => "utf-8".to_owned(),
        v => {
            let s = vm.string_of(&v)?;
            vm.text(s)
                .trim_matches(|c: char| c.is_ascii_whitespace())
                .to_lowercase()
        }
    };
    if !UTF8_LABELS.contains(&label.as_str()) {
        return Err(vm.range_error(&format!(
            "The \"{label}\" encoding is not supported; only UTF-8 is."
        )));
    }
    let mut flag = |name: &'static str| -> bool {
        match arg(args, 1) {
            Value::Obj(o) => {
                let k = vm.atoms.intern_static(name);
                let v = vm.get_obj(o, k);
                vm.truthy(&v)
            }
            _ => false,
        }
    };
    let fatal = flag("fatal");
    let ignore_bom = flag("ignoreBOM");
    let proto = vm.realm.std.text_decoder;
    let d = Decoder {
        fatal,
        ignore_bom,
        queued: Vec::new(),
        seen: false,
    };
    Ok(Value::Obj(vm.alloc(Obj::new(
        Some(proto),
        Kind::TextDecoder(Box::new(d)),
    ))))
}

pub fn decoder_prop(vm: &mut Vm, id: Id, key: Atom) -> Option<Value> {
    let Kind::TextDecoder(d) = &vm.heap[id as usize].kind else {
        return None;
    };
    let (fatal, ignore) = (d.fatal, d.ignore_bom);
    match vm.atoms.text(key) {
        "encoding" => Some(vm.static_str("utf-8")),
        "fatal" => Some(Value::Bool(fatal)),
        "ignoreBOM" => Some(Value::Bool(ignore)),
        _ => None,
    }
}

/// Where a streamed chunk can be decoded up to: before an incomplete trailing sequence, or after the first error
/// in fatal mode.
fn stream_boundary(bytes: &[u8], fatal: bool) -> (usize, bool) {
    let mut next = if fatal {
        0
    } else {
        bytes.len().saturating_sub(3)
    };
    while next < bytes.len() {
        let start = next;
        let lead = bytes[next];
        next += 1;
        if lead < 0x80 {
            continue;
        }
        if !(0xc2..=0xf4).contains(&lead) {
            if fatal {
                return (next, true);
            }
            continue;
        }
        let width = if lead < 0xe0 {
            2
        } else if lead < 0xf0 {
            3
        } else {
            4
        };
        let mut lower = match lead {
            0xe0 => 0xa0,
            0xf0 => 0x90,
            _ => 0x80,
        };
        let mut upper = match lead {
            0xed => 0x9f,
            0xf4 => 0x8f,
            _ => 0xbf,
        };
        while next < start + width {
            if next == bytes.len() {
                return (start, false);
            }
            let b = bytes[next];
            if b < lower || b > upper {
                if fatal {
                    return (next, true);
                }
                break;
            }
            next += 1;
            lower = 0x80;
            upper = 0xbf;
        }
    }
    (next, false)
}

fn decoder_decode(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = match this {
        Value::Obj(id) if matches!(vm.heap[id as usize].kind, Kind::TextDecoder(_)) => id,
        _ => return Err(incompatible(vm, "TextDecoder.prototype.decode", &this)),
    };
    let input = arg(args, 0);
    let chunk = match input {
        Value::Undef => Vec::new(),
        v => match bytes_of(vm, &v) {
            Some(b) => b,
            None => {
                let d = describe_value(vm, &v);
                return Err(vm.type_error(&format!(
                    "TextDecoder.decode expects a Uint8Array, received {d}."
                )));
            }
        },
    };
    let stream = match arg(args, 1) {
        Value::Undef => false,
        Value::Obj(o) => {
            let k = vm.atoms.intern_static("stream");
            let v = vm.get_obj(o, k);
            vm.truthy(&v)
        }
        Value::Null => false,
        _ => return Err(vm.type_error("TextDecoder.decode expects an options object.")),
    };
    let Kind::TextDecoder(d) = &mut vm.heap[id as usize].kind else {
        return Ok(Value::Undef);
    };
    let mut bytes = std::mem::take(&mut d.queued);
    bytes.extend_from_slice(&chunk);
    let (end, error) = if stream {
        stream_boundary(&bytes, d.fatal)
    } else {
        (bytes.len(), false)
    };
    d.queued = bytes[end.min(bytes.len())..].to_vec();
    let strip = !d.ignore_bom && !d.seen;
    if !stream {
        d.seen = false;
    }
    let fatal = d.fatal;
    if error {
        return Err(vm.type_error("TextDecoder.decode: the input is not valid utf-8."));
    }
    let part = &bytes[..end.min(bytes.len())];
    let text = if fatal {
        match std::str::from_utf8(part) {
            Ok(s) => s.to_owned(),
            Err(_) => {
                return Err(vm.type_error("TextDecoder.decode: the input is not valid utf-8."));
            }
        }
    } else {
        String::from_utf8_lossy(part).into_owned()
    };
    if stream
        && !text.is_empty()
        && let Kind::TextDecoder(d) = &mut vm.heap[id as usize].kind
    {
        d.seen = true;
    }
    let text = match text.strip_prefix('\u{feff}') {
        Some(rest) if strip => rest.to_owned(),
        _ => text,
    };
    Ok(vm.string_val(crate::strings::external_text(text)))
}

// ---------- atob and btoa ----------

fn global_atob(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if args.is_empty() {
        return Err(vm.type_error("atob requires 1 argument (a string)"));
    }
    let s = vm.string_of(&args[0])?;
    match base64_decode(vm.text(s)) {
        Some(d) => {
            let out: String = d.into_iter().map(char::from).collect();
            Ok(vm.string_val(out))
        }
        None => Err(vm.type_error("The string contains invalid characters.")),
    }
}

fn global_btoa(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if args.is_empty() {
        return Err(vm.type_error("btoa requires 1 argument (a string)"));
    }
    let s = vm.string_of(&args[0])?;
    let mut data = Vec::new();
    for c in vm.text(s).chars() {
        if c as u32 > 0xff {
            return Err(vm.type_error("The string contains invalid characters."));
        }
        data.push(c as u8);
    }
    let out = base64_encode(&data, false, true);
    Ok(vm.string_val(out))
}

/// The steps of this family's native frames (`native::NativeOp::Arrays`), by sub-op; see `native.rs`.
pub(crate) fn family_step(vm: &mut Vm, sub: u16, fr: Frame, input: Input) -> Result<Step, Value> {
    match sub {
        COLLECT => crate::native::for_of_step::<Collect>(vm, fr, input),
        WALK => walk_step(vm, fr, input),
        REDUCE => reduce_step(vm, fr, input),
        _ => Ok(Step::Done(Value::Undef)),
    }
}
