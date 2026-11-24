//! `ArrayBuffer` and the typed arrays besides Uint8Array (`bytes.rs`): Uint16Array, Uint32Array, Int32Array,
//! Float32Array and Float64Array. Every typed array is a `Kind::Bytes` view of elements on one contiguous byte buffer,
//! a `Kind::Storage` heap object which its `ArrayBuffer` and its other views reference by id; elements are read and
//! written little-endian, with float32 rounding and integer wrapping as in JS.

use super::bytes::{Bytes, Elem, Sink, as_typed, bytes_ref, collect, join_nums, rel_index};
use super::{arg, incompatible};
use crate::object::*;
use crate::ops::{MAX_ARRAY_LEN, MAX_STRING_LEN};
use crate::value::{Id, Value};
use crate::vm::{Res, Vm};

/// The most bytes an `ArrayBuffer` may hold: as many as the longest Float64Array.
pub const MAX_BUFFER_BYTES: usize = MAX_ARRAY_LEN * 8;

pub fn setup(vm: &mut Vm) {
    let op = vm.realm.object_proto;
    let ab = vm.plain(op);
    vm.realm.std.array_buffer = ab;
    let ctor = vm.ctor("ArrayBuffer", 1, buffer_ctor, ab, Value::Undef);
    vm.method(ctor, "isView", 1, buffer_is_view);
    super::accessors(vm, ab, &["byteLength"]);
    vm.method(ab, "slice", 2, buffer_slice);

    for (i, elem) in Elem::TYPED[1..].iter().enumerate() {
        let proto = vm.plain(op);
        vm.realm.std.typed[i] = proto;
        let data = Value::Num(elem.code() as f64);
        let ctor = vm.ctor(elem.name(), 3, typed_ctor, proto, data);
        let size = Value::Num(elem.size() as f64);
        for (name, len, f) in [("from", 1, typed_from as NativeFn), ("of", 0, typed_of)] {
            let v = vm.native_fn(name, len, f, data);
            let k = vm.atoms.intern_static(name);
            vm.define_hidden(ctor, k, v);
        }
        vm.constant(ctor, "BYTES_PER_ELEMENT", size);
        vm.constant(proto, "BYTES_PER_ELEMENT", size);
        super::accessors(vm, proto, &["length", "byteLength", "byteOffset", "buffer"]);
        let methods: [(&'static str, u8, NativeFn); 14] = [
            ("at", 1, t_at),
            ("slice", 2, t_slice),
            ("subarray", 2, t_subarray),
            ("set", 1, t_set),
            ("fill", 1, t_fill),
            ("reverse", 0, t_reverse),
            ("indexOf", 1, t_index_of),
            ("lastIndexOf", 1, t_last_index_of),
            ("includes", 1, t_includes),
            ("join", 1, t_join),
            ("toString", 0, t_to_string),
            ("keys", 0, t_keys),
            ("values", 0, t_values),
            ("entries", 0, t_entries),
        ];
        for (name, len, f) in methods {
            let v = vm.native_fn(name, len, f, data);
            let k = vm.atoms.intern_static(name);
            vm.define_hidden(proto, k, v);
        }
        let vk = vm.atoms.intern_static("values");
        let values = vm.get_obj(proto, vk);
        vm.define_hidden(proto, SYM_ITERATOR, values);
    }
}

type NativeFn = crate::vm::NativeFn;

/// The kind a typed-array built-in belongs to, from its callee data.
fn elem_of(vm: &Vm, callee: Id) -> Elem {
    Elem::from_code(vm.native_data(callee).as_num() as u64).unwrap_or(Elem::U8)
}

fn requires_new(vm: &mut Vm, this: &Value, name: &str) -> Result<(), Value> {
    if matches!(this, Value::Uninit) {
        Ok(())
    } else {
        Err(vm.type_error(&format!("Constructor {name} requires 'new'.")))
    }
}

/// ToIndex for a byte offset or a length: undefined is 0, fractions truncate, and a negative one is `None`.
fn to_index(vm: &mut Vm, v: &Value) -> Result<Option<f64>, Value> {
    if let Value::Undef = v {
        return Ok(Some(0.0));
    }
    let n = super::builtin_integer(vm, v)?;
    Ok((n >= 0.0).then_some(n))
}

fn number_text(n: f64) -> String {
    crate::value::num_to_string(n)
}

// ---------- ArrayBuffer ----------

fn buffer_ctor(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    requires_new(vm, &this, "ArrayBuffer")?;
    match to_index(vm, &arg(args, 0))? {
        Some(n) if n <= MAX_BUFFER_BYTES as f64 => Ok(super::bytes::new_typed(
            vm,
            vec![0; n as usize],
            Elem::ArrayBuffer,
        )),
        _ => Err(vm.range_error("Invalid array buffer length")),
    }
}

fn buffer_is_view(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    Ok(Value::Bool(as_typed(vm, &arg(args, 0)).is_some()))
}

fn this_buffer(vm: &mut Vm, this: &Value, name: &str) -> Result<Id, Value> {
    if let Value::Obj(id) = this
        && let Kind::Bytes(b) = &vm.heap[*id as usize].kind
        && b.elem == Elem::ArrayBuffer
    {
        return Ok(*id);
    }
    Err(incompatible(
        vm,
        &format!("ArrayBuffer.prototype.{name}"),
        this,
    ))
}

fn buffer_slice(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_buffer(vm, &this, "slice")?;
    let len = bytes_ref(vm, id).len;
    let s = rel_index(vm, &arg(args, 0), len, 0)?;
    let e = rel_index(vm, &arg(args, 1), len, len)?.max(s);
    let data = bytes_ref(vm, id).data(vm)[s..e].to_vec();
    Ok(super::bytes::new_typed(vm, data, Elem::ArrayBuffer))
}

/// A view of `elem` on the `ArrayBuffer` `buf`, as `new Float32Array(buffer, byteOffset, length)` makes it.
pub fn from_buffer(vm: &mut Vm, elem: Elem, buf: Id, offset: &Value, length: &Value) -> Res {
    let (name, size) = (elem.name(), elem.size());
    let total = bytes_ref(vm, buf).len;
    let Some(start) = to_index(vm, offset)? else {
        let s = vm.string_of(offset)?;
        let s = vm.text(s).to_owned();
        return Err(vm.range_error(&format!(
            "Start offset {s} is outside the bounds of the buffer"
        )));
    };
    if start % size as f64 != 0.0 {
        return Err(vm.range_error(&format!(
            "start offset of {name} should be a multiple of {size}"
        )));
    }
    let len = if let Value::Undef = length {
        if !total.is_multiple_of(size) {
            return Err(vm.range_error(&format!(
                "byte length of {name} should be a multiple of {size}"
            )));
        }
        if start > total as f64 {
            return Err(vm.range_error(&format!(
                "Start offset {} is outside the bounds of the buffer",
                number_text(start)
            )));
        }
        (total - start as usize) / size
    } else {
        match to_index(vm, length)? {
            Some(n) if start + n * size as f64 <= total as f64 => n as usize,
            _ => {
                let s = vm.string_of(length)?;
                let s = vm.text(s).to_owned();
                return Err(vm.range_error(&format!("Invalid typed array length: {s}")));
            }
        }
    };
    let view = Bytes {
        store: bytes_ref(vm, buf).store,
        start: start as usize,
        len,
        buffer: false,
        elem,
    };
    let proto = vm.realm.std.typed_proto(elem);
    Ok(Value::Obj(
        vm.alloc(Obj::new(Some(proto), Kind::Bytes(Box::new(view)))),
    ))
}

/// The `ArrayBuffer` `v` is, if it is one.
pub fn as_array_buffer(vm: &Vm, v: &Value) -> Option<Id> {
    match v {
        Value::Obj(id) => match &vm.heap[*id as usize].kind {
            Kind::Bytes(b) if b.elem == Elem::ArrayBuffer => Some(*id),
            _ => None,
        },
        _ => None,
    }
}

// ---------- the typed arrays ----------

fn typed_ctor(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let elem = elem_of(vm, callee);
    let name = elem.name();
    requires_new(vm, &this, name)?;
    let source = arg(args, 0);
    if let Some(buf) = as_array_buffer(vm, &source) {
        return from_buffer(vm, elem, buf, &arg(args, 1), &arg(args, 2));
    }
    if vm.type_of(&source) == "object" && !matches!(source, Value::Null) {
        let what = format!("new {name}(...)");
        return collect(vm, &source, &what, None, false, Sink::New(elem), callee);
    }
    let n = super::bytes::typed_length(vm, &source)?;
    Ok(super::bytes::new_typed(vm, vec![0; n * elem.size()], elem))
}

fn typed_from(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    let elem = elem_of(vm, callee);
    let what = format!("{}.from", elem.name());
    let mapper = match arg(args, 1) {
        Value::Undef => None,
        f => Some((super::require_callback(vm, &f, &what)?, arg(args, 2))),
    };
    collect(
        vm,
        &arg(args, 0),
        &what,
        mapper,
        true,
        Sink::New(elem),
        callee,
    )
}

fn typed_of(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    let elem = elem_of(vm, callee);
    let mut data = Vec::with_capacity(args.len());
    for a in args {
        data.push(super::builtin_number(vm, a)?);
    }
    Ok(super::bytes::new_typed(vm, elem.encode(&data), elem))
}

/// The typed array a method was called on, any kind but an `ArrayBuffer`.
fn this_typed(vm: &mut Vm, this: &Value, callee: Id, name: &str) -> Result<Id, Value> {
    if let Value::Obj(id) = this
        && let Kind::Bytes(b) = &vm.heap[*id as usize].kind
        && b.elem != Elem::ArrayBuffer
    {
        return Ok(*id);
    }
    let kind = elem_of(vm, callee).name();
    Err(incompatible(vm, &format!("{kind}.prototype.{name}"), this))
}

fn range(vm: &mut Vm, id: Id, args: &[Value]) -> Result<(usize, usize), Value> {
    let len = bytes_ref(vm, id).len;
    let start = rel_index(vm, &arg(args, 0), len, 0)?;
    let end = rel_index(vm, &arg(args, 1), len, len)?;
    Ok((start, end.max(start)))
}

fn t_at(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "at")?;
    let len = bytes_ref(vm, id).len as f64;
    let mut i = super::builtin_integer(vm, &arg(args, 0))?;
    if i < 0.0 {
        i += len;
    }
    if i < 0.0 || i >= len {
        return Ok(Value::Undef);
    }
    Ok(bytes_ref(vm, id)
        .num(vm, i as usize)
        .map_or(Value::Undef, Value::Num))
}

fn t_slice(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "slice")?;
    let (s, e) = range(vm, id, args)?;
    let b = bytes_ref(vm, id);
    let (data, elem) = (b.view(s, e, false).to_vec(vm), b.elem);
    Ok(super::bytes::new_typed(vm, data, elem))
}

fn t_subarray(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "subarray")?;
    let (s, e) = range(vm, id, args)?;
    let b = bytes_ref(vm, id);
    let view = b.view(s, e, false);
    let proto = vm.realm.std.typed_proto(view.elem);
    Ok(Value::Obj(
        vm.alloc(Obj::new(Some(proto), Kind::Bytes(Box::new(view)))),
    ))
}

fn t_set(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "set")?;
    if !matches!(arg(args, 1), Value::Undef) {
        super::builtin_number(vm, &arg(args, 1))?;
    }
    let what = format!("{}.set", bytes_ref(vm, id).elem.name());
    let into = Sink::Set {
        target: id,
        offset: arg(args, 1),
    };
    collect(vm, &arg(args, 0), &what, None, true, into, callee)
}

fn t_fill(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "fill")?;
    let v = super::builtin_number(vm, &arg(args, 0))?;
    let len = bytes_ref(vm, id).len;
    let s = rel_index(vm, &arg(args, 1), len, 0)?;
    let e = rel_index(vm, &arg(args, 2), len, len)?;
    let b = bytes_ref(vm, id);
    let size = b.elem.size();
    let mut one = [0u8; 8];
    b.elem.write(v, &mut one);
    let bytes = b.data_mut(vm);
    for i in s..e.max(s) {
        bytes[i * size..(i + 1) * size].copy_from_slice(&one[..size]);
    }
    Ok(this)
}

fn t_reverse(vm: &mut Vm, this: Value, _args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "reverse")?;
    let b = bytes_ref(vm, id);
    let size = b.elem.size();
    let bytes = b.data_mut(vm);
    let reversed: Vec<u8> = bytes.chunks_exact(size).rev().flatten().copied().collect();
    bytes.copy_from_slice(&reversed);
    Ok(this)
}

/// A search value: only a number can equal an element.
fn search(v: &Value) -> Option<f64> {
    match v {
        Value::Num(n) => Some(*n),
        _ => None,
    }
}

fn t_index_of(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "indexOf")?;
    let len = bytes_ref(vm, id).len;
    let from = rel_index(vm, &arg(args, 1), len, 0)?;
    let Some(x) = search(&arg(args, 0)) else {
        return Ok(Value::Num(-1.0));
    };
    let data = bytes_ref(vm, id).nums(vm);
    Ok(Value::Num(
        (from..len)
            .find(|i| data[*i] == x)
            .map_or(-1.0, |i| i as f64),
    ))
}

fn t_last_index_of(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "lastIndexOf")?;
    let len = bytes_ref(vm, id).len as f64;
    let from = if args.len() < 2 {
        len - 1.0
    } else {
        let n = super::builtin_integer(vm, &args[1])?;
        if n < 0.0 { len + n } else { n.min(len - 1.0) }
    };
    let Some(x) = search(&arg(args, 0)) else {
        return Ok(Value::Num(-1.0));
    };
    if from < 0.0 {
        return Ok(Value::Num(-1.0));
    }
    let data = bytes_ref(vm, id).nums(vm);
    Ok(Value::Num(
        (0..=from as usize)
            .rev()
            .find(|i| data[*i] == x)
            .map_or(-1.0, |i| i as f64),
    ))
}

fn t_includes(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "includes")?;
    let len = bytes_ref(vm, id).len;
    let from = rel_index(vm, &arg(args, 1), len, 0)?;
    let Some(x) = search(&arg(args, 0)) else {
        return Ok(Value::Bool(false));
    };
    let data = bytes_ref(vm, id).nums(vm);
    Ok(Value::Bool(
        data[from.min(len)..]
            .iter()
            .any(|v| *v == x || (v.is_nan() && x.is_nan())),
    ))
}

fn t_join(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "join")?;
    let sep = match arg(args, 0) {
        Value::Undef => ",".to_owned(),
        v => {
            let s = vm.string_of(&v)?;
            vm.text(s).to_owned()
        }
    };
    let out = join_nums(vm, &bytes_ref(vm, id), &sep);
    if out.len() > MAX_STRING_LEN {
        return Err(vm.range_error("Invalid string length"));
    }
    Ok(vm.string_val(out))
}

fn t_to_string(vm: &mut Vm, this: Value, _args: &[Value], callee: Id) -> Res {
    let id = this_typed(vm, &this, callee, "toString")?;
    let out = join_nums(vm, &bytes_ref(vm, id), ",");
    Ok(vm.string_val(out))
}

fn t_iter(vm: &mut Vm, this: &Value, callee: Id, name: &str, kind: IterKind) -> Res {
    let id = this_typed(vm, this, callee, name)?;
    Ok(super::iterator::exotic_iter(vm, id, kind))
}

fn t_keys(vm: &mut Vm, this: Value, _args: &[Value], callee: Id) -> Res {
    t_iter(vm, &this, callee, "keys", IterKind::Keys)
}

fn t_values(vm: &mut Vm, this: Value, _args: &[Value], callee: Id) -> Res {
    t_iter(vm, &this, callee, "values", IterKind::Values)
}

fn t_entries(vm: &mut Vm, this: Value, _args: &[Value], callee: Id) -> Res {
    t_iter(vm, &this, callee, "entries", IterKind::Entries)
}

/// A typed array (or `ArrayBuffer`) over the bytes a host function returned, without copying them: the program's own
/// buffer again for a handle the call got, or the host's bytes, which become the program's.
pub fn from_host(vm: &mut Vm, t: &crate::TypedArray, label: &str) -> Res {
    super::ensure(vm, super::LAZY_BYTES);
    let known = vm.lends.iter().find(|(_, h)| h.same(&t.buf));
    let store = match known {
        Some((store, _)) => *store,
        None => {
            let data = std::mem::take(&mut *t.buf.lock());
            let store = super::bytes::new_storage(vm, data);
            vm.lends.push((store, t.buf.clone()));
            store
        }
    };
    let view = Bytes {
        store,
        start: t.start,
        len: t.len,
        buffer: false,
        elem: t.kind,
    };
    if view.start + view.byte_len() > super::bytes::storage(vm, store).len() {
        return Err(vm.type_error(&format!(
            "{label} returned a {} whose bytes are gone: a typed array a host function gets is only valid during that call.",
            t.kind.name()
        )));
    }
    let proto = vm.realm.std.typed_proto(t.kind);
    let id = vm.alloc(Obj::new(Some(proto), Kind::Bytes(Box::new(view))));
    if t.kind == Elem::ArrayBuffer && vm.heap[store as usize].proto.is_none() {
        vm.heap[store as usize].proto = Some(id);
    }
    Ok(Value::Obj(id))
}
