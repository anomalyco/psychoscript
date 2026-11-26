//! Object, Function, Error, Boolean, Symbol, JSON, console and the global functions.

use super::{arg, fuel, this_obj};
use crate::convert;
use crate::object::*;
use crate::ops::Hint;
use crate::value::{Id, Value, parse_float_prefix, to_int32};
use crate::vm::{Res, Vm};

pub fn setup(vm: &mut Vm) {
    let op = vm.realm.object_proto;
    let object = vm.ctor("Object", 1, object_ctor, op, Value::Undef);
    vm.methods(
        object,
        &[
            ("keys", 1, object_keys),
            ("values", 1, object_values),
            ("entries", 1, object_entries),
            ("hasOwn", 2, object_has_own),
            ("is", 2, object_is),
            ("assign", 2, object_assign),
            ("freeze", 1, object_freeze),
            ("seal", 1, object_seal),
            ("preventExtensions", 1, object_prevent_extensions),
            ("isFrozen", 1, object_is_frozen),
            ("isSealed", 1, object_is_sealed),
            ("isExtensible", 1, object_is_extensible),
            ("getPrototypeOf", 1, object_get_prototype_of),
            ("create", 2, object_create),
            ("defineProperty", 3, object_define_property),
            ("defineProperties", 2, object_define_properties),
            (
                "getOwnPropertyDescriptor",
                2,
                object_get_own_property_descriptor,
            ),
            (
                "getOwnPropertyDescriptors",
                1,
                object_get_own_property_descriptors,
            ),
            ("getOwnPropertyNames", 1, object_get_own_property_names),
        ],
    );
    vm.methods(
        op,
        &[
            ("hasOwnProperty", 1, proto_has_own_property),
            ("isPrototypeOf", 1, proto_is_prototype_of),
            ("propertyIsEnumerable", 1, proto_property_is_enumerable),
            ("toString", 0, proto_to_string),
            ("toLocaleString", 0, proto_to_locale_string),
            ("valueOf", 0, proto_value_of),
        ],
    );

    let fp = vm.realm.function_proto;
    vm.methods(
        fp,
        &[
            ("call", 1, function_call),
            ("apply", 2, function_apply),
            ("bind", 1, function_bind),
        ],
    );
    // AddRestrictedFunctionProperties: functions have no `caller` or `arguments` of their own. Each half is a native
    // of its own, which built-ins read without running program code.
    for (key, get, set) in [
        ("caller", "get caller", "set caller"),
        ("arguments", "get arguments", "set arguments"),
    ] {
        let g = vm.native_fn(get, 0, restricted, Value::Undef);
        let s = vm.native_fn(set, 1, restricted, Value::Undef);
        let pair = vm.new_pair(g, s);
        let k = vm.atoms.intern_static(key);
        vm.heap[fp as usize].props.push_new(k, pair, ACCESSOR);
    }
    // So a write to a function's `caller` or `arguments` finds the accessor (see `Vm::inherited_accessor`).
    vm.heap[fp as usize].flags |= ACCESSORS;
    vm.ctor("Function", 1, function_ctor, fp, Value::Undef);

    let errors = [
        ("Error", vm.realm.error_proto),
        ("TypeError", vm.realm.type_error_proto),
        ("RangeError", vm.realm.range_error_proto),
        ("SyntaxError", vm.realm.syntax_error_proto),
        ("ReferenceError", vm.realm.reference_error_proto),
        ("AggregateError", vm.realm.aggregate_error_proto),
    ];
    let (nk, mk) = (vm.names.name, vm.names.message);
    let mut error_ctor_id = 0;
    for (name, proto) in errors {
        let f: crate::vm::NativeFn = if name == "AggregateError" {
            aggregate_error_ctor
        } else {
            error_ctor
        };
        // `name` and `message` come before `constructor`, as the reference defines them.
        let (n, m) = (vm.static_str(name), vm.static_str(""));
        vm.define_hidden(proto, nk, n);
        vm.define_hidden(proto, mk, m);
        let c = vm.ctor(name, 1, f, proto, Value::Obj(proto));
        if name == "Error" {
            error_ctor_id = c;
            vm.method(c, "isError", 1, error_is_error);
        } else {
            vm.heap[c as usize].proto = Some(error_ctor_id);
        }
    }
    for name in ["EvalError", "URIError"] {
        let ep = vm.realm.error_proto;
        let proto = vm.plain(ep);
        let (n, m) = (vm.static_str(name), vm.static_str(""));
        vm.define_hidden(proto, nk, n);
        vm.define_hidden(proto, mk, m);
        let c = vm.ctor(name, 1, error_ctor, proto, Value::Obj(proto));
        vm.heap[c as usize].proto = Some(error_ctor_id);
        if name == "URIError" {
            vm.realm.std.uri_error = proto;
        }
    }
    let ep = vm.realm.error_proto;
    vm.method(ep, "toString", 0, error_to_string);

    let bp = vm.realm.boolean_proto;
    vm.ctor("Boolean", 1, boolean_ctor, bp, Value::Undef);
    vm.methods(
        bp,
        &[
            ("toString", 0, boolean_to_string),
            ("valueOf", 0, boolean_value_of),
        ],
    );

    let sp = vm.realm.symbol_proto;
    // `Symbol` is neither a callback nor a constructor: `new Symbol()` asks for a call instead, as the reference does.
    let symbol = vm
        .native_fn("Symbol", 0, symbol_ctor, Value::Undef)
        .as_obj()
        .unwrap_or(0);
    let (pk, ck) = (vm.names.prototype, vm.names.constructor);
    vm.heap[symbol as usize]
        .props
        .insert(pk, Value::Obj(sp), FIXED);
    vm.define_hidden(sp, ck, Value::Obj(symbol));
    vm.global("Symbol", Value::Obj(symbol));
    vm.heap[symbol as usize].flags |= NOT_CALLBACK;
    vm.constant(symbol, "asyncIterator", Value::Sym(SYM_ASYNC_ITERATOR));
    vm.constant(symbol, "iterator", Value::Sym(SYM_ITERATOR));
    vm.methods(sp, &[("toString", 0, symbol_to_string)]);
    // The rest of `Symbol` and `Symbol.prototype` comes with its lazy group (`setup_symbols`).

    let json = vm.new_object();
    vm.realm.std.json = json;
    vm.methods(
        json,
        &[("parse", 2, json_parse), ("stringify", 3, json_stringify)],
    );
    vm.global("JSON", Value::Obj(json));

    let console = vm.new_object();
    vm.methods(
        console,
        &[
            ("log", 0, console_log),
            ("info", 0, console_log),
            ("debug", 0, console_debug),
            ("warn", 0, console_warn),
            ("error", 0, console_error),
            ("dir", 0, console_dir),
            ("table", 0, console_table),
        ],
    );
    vm.global("console", Value::Obj(console));

    let parse_int = vm.native_fn("parseInt", 2, global_parse_int, Value::Undef);
    let parse_float = vm.native_fn("parseFloat", 1, global_parse_float, Value::Undef);
    vm.global("parseInt", parse_int);
    vm.global("parseFloat", parse_float);
    let is_nan = vm.native_fn("isNaN", 1, global_is_nan, Value::Undef);
    let is_finite = vm.native_fn("isFinite", 1, global_is_finite, Value::Undef);
    vm.global("isNaN", is_nan);
    vm.global("isFinite", is_finite);
}

// ---------- Object ----------

fn object_ctor(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    match arg(args, 0) {
        Value::Undef | Value::Null => Ok(Value::Obj(vm.new_object())),
        Value::Obj(id) if !vm.is_namespace(id) => Ok(Value::Obj(id)),
        // The reference names the host's typeof, which is "object" for a namespace.
        v => {
            let t = match v {
                Value::Obj(_) => "object",
                v => vm.type_of(&v),
            };
            Err(vm.type_error(&format!(
                "Object({t}) wrapper objects are not supported; use the primitive value directly."
            )))
        }
    }
}

fn entries_of(vm: &mut Vm, label: &str, v: &Value) -> Result<Vec<(Value, Value)>, Value> {
    vm.enumerable_source(label, v)?;
    Ok(match v {
        // Each getter runs in key order, and a key's enumerability is checked when it is reached (the reference's
        // `objectEntries`).
        Value::Obj(id) if vm.heap[*id as usize].flags & ACCESSORS != 0 => {
            let id = *id;
            vm.copy_data_calling(0, id, &[], true)?
                .into_iter()
                .map(|(k, v)| (Value::Str(vm.atoms.atom_str(k)), v))
                .collect()
        }
        Value::Obj(id) => {
            let id = *id;
            vm.own_entries(id)
                .into_iter()
                .map(|(k, v)| (Value::Str(vm.atoms.atom_str(k)), v))
                .collect()
        }
        Value::Str(s) => {
            let units = vm.atoms.sref(*s).utf16();
            units
                .iter()
                .enumerate()
                .map(|(i, c)| (vm.string_val(i.to_string()), vm.char_str(*c)))
                .collect()
        }
        _ => Vec::new(),
    })
}

/// `Object.values` or `Object.entries` of an object with program accessors: each getter runs in key order from a frame,
/// and a key's enumerability is checked when it is reached (the reference's `objectEntries`). `None` for any other.
fn entries_by_frame(vm: &mut Vm, label: &str, v: &Value, mode: usize) -> Option<Res> {
    let Value::Obj(id) = *v else { return None };
    if vm.heap[id as usize].flags & ACCESSORS == 0 {
        return None;
    }
    if let Err(e) = vm.enumerable_source(label, v) {
        return Some(Err(e));
    }
    let out = vm.new_array(Vec::new());
    Some(vm.copy_by_frame(mode, out, vec![*v], &[]))
}

fn object_keys(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let v = arg(args, 0);
    // A namespace lists its names.
    if let Value::Obj(id) = v
        && (vm.is_namespace(id) || !vm.is_promise(id))
    {
        let keys = match vm.is_namespace(id) {
            true => vm.namespace_names(id)?,
            false => vm.own_keys(id),
        };
        let items = keys
            .into_iter()
            .map(|k| Value::Str(vm.atoms.atom_str(k)))
            .collect();
        return Ok(vm.new_array(items));
    }
    let items = entries_of(vm, "Object.keys(...)", &v)?
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    Ok(vm.new_array(items))
}

fn object_values(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if let Some(r) = entries_by_frame(
        vm,
        "Object.values(...)",
        &arg(args, 0),
        crate::accessors::COPY_VALUES,
    ) {
        return r;
    }
    let items = entries_of(vm, "Object.values(...)", &arg(args, 0))?
        .into_iter()
        .map(|(_, v)| v)
        .collect();
    Ok(vm.new_array(items))
}

fn object_entries(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if let Some(r) = entries_by_frame(
        vm,
        "Object.entries(...)",
        &arg(args, 0),
        crate::accessors::COPY_ENTRIES,
    ) {
        return r;
    }
    let pairs = entries_of(vm, "Object.entries(...)", &arg(args, 0))?;
    let items = pairs
        .into_iter()
        .map(|(k, v)| vm.new_array(vec![k, v]))
        .collect();
    Ok(vm.new_array(items))
}

fn object_assign(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let target = arg(args, 0);
    let t = match target {
        Value::Obj(t) if !vm.is_namespace(t) => t,
        _ => {
            let d = super::describe_value(vm, &target);
            return Err(vm.type_error(&format!(
                "Object.assign expects a data object or array target, received {d}."
            )));
        }
    };
    for src in args.iter().skip(1) {
        if !src.is_nullish() {
            vm.enumerable_source("Object.assign(...)", src)?;
        }
    }
    // Program getters on a source or setters on the target's chain: Get then Set, key by key (the reference's
    // `objectAssign`).
    let calling = vm.accessors_on_chain(t)
        || args
            .iter()
            .skip(1)
            .any(|s| matches!(s, Value::Obj(id) if vm.heap[*id as usize].flags & ACCESSORS != 0));
    if calling {
        let sources = args.iter().skip(1).copied().collect();
        return vm.copy_by_frame(crate::accessors::COPY_ASSIGN, target, sources, &[]);
    }
    let before = vm.heap[t as usize].props.len();
    let copied = assign_sources(vm, t, args);
    vm.charge_props(t, before);
    copied?;
    Ok(target)
}

/// `Object.assign`'s copy from each source into `t`, when no program getter or setter runs.
fn assign_sources(vm: &mut Vm, t: Id, args: &[Value]) -> Result<(), Value> {
    for src in args.iter().skip(1) {
        if src.is_nullish() {
            continue;
        }
        if let Value::Obj(s) = src {
            let mut entries = vm.own_entries(*s);
            entries.extend(vm.own_symbol_entries(*s));
            // The reference sets the fields as they are, on a promise too.
            let promise = vm.is_promise(t);
            for (k, v) in entries {
                vm.reject_circular(t, &v, "Object.assign result")?;
                if promise {
                    vm.define(t, k, v);
                } else {
                    vm.set_obj(t, k, v)?;
                }
            }
        } else {
            vm.copy_props(t, src, &[])?;
        }
    }
    Ok(())
}

pub(crate) fn object_from_entries(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    // The reference's for...of over the entries: each entry is read as it comes, and a bad one closes the iterator.
    // Its fuel is the prelude's `Object$fromEntries` (see `fuel.rs`).
    fuel::method(vm);
    let source = arg(args, 0);
    if !vm.is_iterable(&source) {
        return Err(vm.not_iterable(&source, crate::bytecode::ITER_FOR_OF));
    }
    let id = vm.new_object();
    crate::native::enter_for_of_sub(
        vm,
        crate::native::NativeOp::Callbacks,
        SUB_FROM_ENTRIES,
        callee,
        Value::Undef,
        source,
        &[
            Value::Obj(id),
            Value::Undef,
            Value::Undef,
            Value::Num(0.0),
            Value::Undef,
        ],
    )
}

/// `Object.fromEntries` over its entries: its own slots are the object it fills and the value of an entry whose key
/// is converted by a call.
struct FromEntries;

impl crate::native::ForOf for FromEntries {
    fn item(vm: &mut Vm, fr: crate::native::Frame, x: Value) -> Result<crate::native::Flow, Value> {
        // One entry: `$IsObject`, `String` of its key, `$Define`.
        fuel::native(vm);
        if !matches!(x, Value::Obj(id) if !vm.is_namespace(id)) {
            return Err(vm.type_error("Object.fromEntries expects [key, value] entry objects."));
        }
        // `String(entry[0])`, then `entry[1]`, as the prelude's `$Define(result, String(entry[0]), entry[1])`.
        match crate::native::entry_get(vm, fr, x, ENTRY_AT, 0)? {
            Ok(k) => entry_key(vm, fr, k),
            Err(flow) => Ok(flow),
        }
    }

    fn returned(
        vm: &mut Vm,
        fr: crate::native::Frame,
        r: crate::value::Slot,
    ) -> Result<crate::native::Flow, Value> {
        match crate::native::entry_getter(vm, fr, ENTRY_AT) {
            Some(0) => entry_key(vm, fr, r.get()),
            Some(_) => {
                let k = fr.get(vm, crate::native::FOR_OF_SLOTS + 1);
                define_entry(vm, fr, &k, r.get())?;
                Ok(crate::native::Flow::Next)
            }
            // The key's conversion returned.
            None => entry_value(vm, fr, r.get()),
        }
    }

    fn finish(vm: &mut Vm, fr: crate::native::Frame) -> Res {
        vm.bytecode_builtin();
        Ok(fr.get(vm, crate::native::FOR_OF_SLOTS))
    }
}

/// Where `Object.fromEntries` keeps an entry while a getter of it runs (see `native::read_entry`).
const ENTRY_AT: usize = crate::native::FOR_OF_SLOTS + 2;

/// An entry's key, read: converted (from the frame when that calls the program), then its value read.
fn entry_key(
    vm: &mut Vm,
    fr: crate::native::Frame,
    k: Value,
) -> Result<crate::native::Flow, Value> {
    if vm.converts_by_call(&k, Hint::String) {
        let step = super::convert_catching(vm, fr, k, Hint::String)?;
        return Ok(crate::native::Flow::Call(step));
    }
    entry_value(vm, fr, k)
}

/// An entry's value, read once its key is, then defined under the key.
fn entry_value(
    vm: &mut Vm,
    fr: crate::native::Frame,
    k: Value,
) -> Result<crate::native::Flow, Value> {
    let x = crate::native::kept_entry(vm, fr, ENTRY_AT);
    match crate::native::entry_get(vm, fr, x, ENTRY_AT, 1)? {
        Ok(v) => {
            define_entry(vm, fr, &k, v)?;
            Ok(crate::native::Flow::Next)
        }
        Err(flow) => {
            fr.set(vm, crate::native::FOR_OF_SLOTS + 1, k);
            Ok(flow)
        }
    }
}

/// An entry's key made a property key, then its value defined.
fn define_entry(vm: &mut Vm, fr: crate::native::Frame, k: &Value, v: Value) -> Result<(), Value> {
    let id = fr
        .get(vm, crate::native::FOR_OF_SLOTS)
        .as_obj()
        .unwrap_or(0);
    let a = vm.key_of(k)?;
    fuel::native(vm);
    vm.define(id, a, v);
    fuel::native(vm);
    Ok(())
}

fn object_has_own(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let o = arg(args, 0);
    vm.enumerable_source("Object.hasOwn(...)", &o)?;
    // ToPropertyKey, which may call the program.
    fuel::with_primitives(vm, &[Hint::String], [arg(args, 1)], false, |vm, [key]| {
        let k = vm.key_of(&key)?;
        Ok(Value::Bool(match o {
            Value::Obj(id) => vm.has_own(id, k),
            // A string reads as the array of its characters.
            Value::Str(s) => {
                k == vm.names.length
                    || vm
                        .atoms
                        .index(k)
                        .is_some_and(|i| (i as usize) < vm.atoms.sref(s).len16())
            }
            _ => false,
        }))
    })
}

fn set_flags(vm: &mut Vm, args: &[Value], flags: u8) -> Res {
    let v = arg(args, 0);
    if let Value::Obj(id) = v {
        vm.heap[id as usize].flags |= flags;
    }
    Ok(v)
}

fn has_flags(vm: &mut Vm, args: &[Value], flags: u8, primitive: bool) -> Res {
    Ok(Value::Bool(match arg(args, 0) {
        // A namespace is no object: as a primitive, it is frozen and sealed.
        Value::Obj(id) if !vm.is_namespace(id) => {
            let o = &vm.heap[id as usize];
            if o.flags & flags == flags {
                true
            } else if flags == NON_EXTENSIBLE || o.flags & NON_EXTENSIBLE == 0 {
                false
            } else {
                // Not extensible, and every own property as `freeze` or `seal` would leave it.
                let frozen = flags == FROZEN;
                let keys = vm.own_property_keys(id);
                keys.into_iter().all(|k| {
                    vm.own_slot(id, k).is_some_and(|s| {
                        !s.configurable
                            && !(frozen
                                && s.writable
                                && matches!(s.value, crate::accessors::SlotValue::Data(_)))
                    })
                })
            }
        }
        _ => primitive,
    }))
}

fn object_freeze(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    set_flags(vm, args, FROZEN | SEALED | NON_EXTENSIBLE)
}
fn object_is_frozen(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    has_flags(vm, args, FROZEN, true)
}
fn object_seal(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    set_flags(vm, args, SEALED | NON_EXTENSIBLE)
}
fn object_is_sealed(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    has_flags(vm, args, SEALED, true)
}
fn object_prevent_extensions(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    set_flags(vm, args, NON_EXTENSIBLE)
}
fn object_is_extensible(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    Ok(Value::Bool(match arg(args, 0) {
        Value::Obj(id) if !vm.is_namespace(id) => vm.heap[id as usize].flags & NON_EXTENSIBLE == 0,
        _ => false,
    }))
}

fn object_create(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let proto = match arg(args, 0) {
        Value::Obj(p) if !vm.is_namespace(p) => Some(p),
        Value::Null => None,
        _ => return Err(vm.type_error("Object prototype may only be an Object or null.")),
    };
    if matches!(arg(args, 1), Value::Undef) {
        return Ok(Value::Obj(vm.alloc(Obj::new(proto, Kind::Ordinary))));
    }
    let props = arg(args, 1);
    vm.reading(|vm| {
        let id = vm.alloc(Obj::new(proto, Kind::Ordinary));
        define_properties(vm, id, &props)
    })
}

/// The target `Object.defineProperty` and `defineProperties` define on.
fn require_target(vm: &mut Vm, v: &Value, name: &str) -> Result<Id, Value> {
    match v {
        Value::Obj(id) if !vm.is_namespace(*id) => Ok(*id),
        _ => Err(vm.type_error(&format!("Object.{name} called on non-object"))),
    }
}

/// ObjectDefineProperties, under `with_reads`: every descriptor is read (getters included) before the first one is
/// defined.
fn define_properties(vm: &mut Vm, id: Id, props: &Value) -> Res {
    let descriptors = match props {
        Value::Undef | Value::Null => {
            let t = if let Value::Null = props {
                "null"
            } else {
                "undefined"
            };
            return Err(vm.type_error(&format!("Cannot convert {t} to object")));
        }
        Value::Obj(p) if !vm.is_namespace(*p) => {
            let p = *p;
            let keys = vm.own_property_keys(p);
            let mut out = Vec::new();
            for key in keys {
                if !vm.own_slot(p, key).is_some_and(|s| s.enumerable) {
                    continue;
                }
                let d = vm.get_obj(p, key);
                let d = if let Value::Uninit = d {
                    super::accessor_read(vm, p, key)?
                } else {
                    d
                };
                out.push((key, vm.property_descriptor(&d)?));
            }
            out
        }
        Value::Str(s) => {
            // ToObject: a string's indexes are its only own enumerable properties.
            let s = *s;
            let n = vm.atoms.sref(s).len16();
            let mut out = Vec::new();
            for i in 0..n {
                let c = match vm.atoms.sref(s).code_unit(i) {
                    Some(c) => vm.char_str(c),
                    None => Value::Undef,
                };
                let key = vm.atoms.intern(&i.to_string());
                out.push((key, vm.property_descriptor(&c)?));
            }
            out
        }
        _ => Vec::new(),
    };
    if vm.reads_pending() {
        return Ok(Value::Obj(id));
    }
    for (key, desc) in descriptors {
        vm.define_or_throw(id, key, &desc)?;
    }
    Ok(Value::Obj(id))
}

fn object_define_property(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let id = require_target(vm, &arg(args, 0), "defineProperty")?;
    let key = vm.key_of(&arg(args, 1))?;
    let d = arg(args, 2);
    vm.reading(|vm| {
        let desc = vm.property_descriptor(&d)?;
        if vm.reads_pending() {
            return Ok(Value::Obj(id));
        }
        vm.define_or_throw(id, key, &desc)?;
        Ok(Value::Obj(id))
    })
}

fn object_define_properties(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let id = require_target(vm, &arg(args, 0), "defineProperties")?;
    let props = arg(args, 1);
    vm.reading(|vm| define_properties(vm, id, &props))
}

/// RequireObjectCoercible for the descriptor readers.
fn require_coercible(vm: &mut Vm, v: &Value, name: &str) -> Result<(), Value> {
    match v {
        Value::Undef | Value::Null | Value::Uninit => {
            let t = if let Value::Null = v {
                "null"
            } else {
                "undefined"
            };
            Err(vm.type_error(&format!("Object.{name} cannot convert {t} to an object.")))
        }
        Value::Obj(id) if vm.is_namespace(*id) => {
            let root = vm.namespace_root(*id);
            Err(vm.type_error(&format!(
                "Object.{name} cannot read {root}: it is a namespace of host functions, not an object."
            )))
        }
        _ => Ok(()),
    }
}

/// The own properties a primitive has after ToObject, which only a string's are: its indexes and `length`.
fn primitive_slot(vm: &mut Vm, v: &Value, key: Atom) -> Option<crate::accessors::OwnSlot> {
    use crate::accessors::{OwnSlot, SlotValue};
    let Value::Str(s) = v else { return None };
    let s = *s;
    let n = vm.atoms.sref(s).len16();
    if key == vm.names.length {
        return Some(OwnSlot {
            value: SlotValue::Data(Value::Num(n as f64)),
            writable: false,
            enumerable: false,
            configurable: false,
        });
    }
    let i = vm.atoms.index(key)? as usize;
    if i >= n {
        return None;
    }
    let c = match vm.atoms.sref(s).code_unit(i) {
        Some(c) => vm.char_str(c),
        None => Value::Undef,
    };
    Some(OwnSlot {
        value: SlotValue::Data(c),
        writable: false,
        enumerable: true,
        configurable: false,
    })
}

fn primitive_keys(vm: &mut Vm, v: &Value) -> Vec<Atom> {
    let Value::Str(s) = v else { return Vec::new() };
    let n = vm.atoms.sref(*s).len16();
    let mut out: Vec<Atom> = (0..n).map(|i| vm.atoms.intern(&i.to_string())).collect();
    out.push(vm.names.length);
    out
}

fn object_get_own_property_descriptor(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let v = arg(args, 0);
    require_coercible(vm, &v, "getOwnPropertyDescriptor")?;
    let key = vm.key_of(&arg(args, 1))?;
    let slot = match v {
        Value::Obj(id) => vm.own_slot(id, key),
        _ => primitive_slot(vm, &v, key),
    };
    Ok(vm.descriptor_object(slot))
}

fn object_get_own_property_descriptors(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let v = arg(args, 0);
    require_coercible(vm, &v, "getOwnPropertyDescriptors")?;
    let result = vm.new_object();
    let keys = match v {
        Value::Obj(id) => vm.own_property_keys(id),
        _ => primitive_keys(vm, &v),
    };
    for key in keys {
        let slot = match v {
            Value::Obj(id) => vm.own_slot(id, key),
            _ => primitive_slot(vm, &v, key),
        };
        let d = vm.descriptor_object(slot);
        vm.define(result, key, d);
    }
    Ok(Value::Obj(result))
}

fn object_get_own_property_names(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let v = arg(args, 0);
    if let Value::Obj(id) = v
        && vm.is_namespace(id)
    {
        let names: Vec<Value> = vm
            .namespace_names(id)?
            .into_iter()
            .map(|k| vm.atom_val(k))
            .collect();
        return Ok(vm.new_array(names));
    }
    require_coercible(vm, &v, "getOwnPropertyNames")?;
    let keys = match v {
        Value::Obj(id) => vm.own_property_keys(id),
        _ => primitive_keys(vm, &v),
    };
    let names: Vec<Value> = keys
        .into_iter()
        .filter(|k| *k > SYM_LAST)
        .map(|k| vm.atom_val(k))
        .collect();
    Ok(vm.new_array(names))
}

fn object_get_own_property_symbols(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let v = arg(args, 0);
    require_coercible(vm, &v, "getOwnPropertySymbols")?;
    let symbols: Vec<Value> = match v {
        Value::Obj(id) => vm
            .own_property_keys(id)
            .into_iter()
            .filter(|k| *k <= SYM_LAST)
            .map(Value::Sym)
            .collect(),
        _ => Vec::new(),
    };
    Ok(vm.new_array(symbols))
}

fn object_get_prototype_of(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    Ok(match arg(args, 0) {
        Value::Obj(id) if !vm.is_namespace(id) => vm.heap[id as usize]
            .proto
            .map(Value::Obj)
            .unwrap_or(Value::Null),
        Value::Str(_) => Value::Obj(vm.realm.string_proto),
        Value::Num(_) => Value::Obj(vm.realm.number_proto),
        Value::Bool(_) => Value::Obj(vm.realm.boolean_proto),
        Value::Big(_) => Value::Obj(vm.bigint_proto()),
        Value::Sym(_) => Value::Obj(vm.realm.symbol_proto),
        v => {
            let d = super::describe_value(vm, &v);
            return Err(vm.type_error(&format!(
                "Object.getPrototypeOf cannot convert {d} to an object."
            )));
        }
    })
}

fn object_is(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let (a, b) = (arg(args, 0), arg(args, 1));
    Ok(Value::Bool(match (&a, &b) {
        (Value::Num(x), Value::Num(y)) => {
            (x.is_nan() && y.is_nan()) || (x == y && x.is_sign_negative() == y.is_sign_negative())
        }
        _ => vm.strict_eq(&a, &b),
    }))
}

/// The receiver of the `Object.prototype` methods that need an object: like the reference, primitives (which JS
/// would box) and namespace references are rejected.
fn object_receiver(vm: &mut Vm, this: &Value, method: &str) -> Result<Id, Value> {
    if let Value::Obj(id) = this
        && !matches!(vm.heap[*id as usize].kind, Kind::Namespace(_))
    {
        return Ok(*id);
    }
    Err(super::incompatible(
        vm,
        &format!("Object.prototype.{method}"),
        this,
    ))
}

fn is_namespace_ref(vm: &Vm, v: &Value) -> bool {
    matches!(v, Value::Obj(id) if matches!(vm.heap[*id as usize].kind, Kind::Namespace(_)))
}

/// The key of `hasOwnProperty` and `propertyIsEnumerable` (ToPropertyKey, which may call the program), then their
/// receiver, which a primitive is as its boxed object.
fn own_check(
    vm: &mut Vm,
    this: Value,
    args: &[Value],
    method: &str,
    body: impl FnOnce(&mut Vm, Atom) -> bool,
) -> Res {
    fuel::with_primitives(vm, &[Hint::String], [arg(args, 0)], false, |vm, [key]| {
        let k = vm.key_of(&key)?;
        require_coercible(vm, &this, method)?;
        Ok(Value::Bool(body(vm, k)))
    })
}

fn proto_has_own_property(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    own_check(
        vm,
        this,
        args,
        "prototype.hasOwnProperty",
        |vm, k| match this {
            Value::Obj(id) => vm.has_own(id, k),
            _ => primitive_slot(vm, &this, k).is_some(),
        },
    )
}

pub fn tag_of(vm: &Vm, v: &Value) -> &'static str {
    match v {
        Value::Undef | Value::Uninit => "Undefined",
        Value::Null => "Null",
        Value::Num(_) => "Number",
        Value::Str(_) => "String",
        Value::Bool(_) => "Boolean",
        Value::Sym(_) => "Symbol",
        Value::Big(_) => "BigInt",
        Value::Obj(id) => match &vm.heap[*id as usize].kind {
            Kind::Array(_) => "Array",
            Kind::Arguments(_) => "Arguments",
            Kind::Closure(_) | Kind::Native { .. } | Kind::Bound(_) => "Function",
            Kind::Error(_) => "Error",
            Kind::Promise(_) => "Promise",
            Kind::Map(_) => "Map",
            Kind::Set(_) => "Set",
            Kind::Generator(_) | Kind::IterHelper(_) => "Generator",
            Kind::ArrayIter { .. } => "Array Iterator",
            Kind::MapIter { target, .. } => match vm.heap[*target as usize].kind {
                Kind::Set(_) => "Set Iterator",
                _ => "Map Iterator",
            },
            Kind::StrIter { .. } => "String Iterator",
            Kind::RegExp(_) => "RegExp",
            Kind::Date(_) => "Date",
            Kind::Bytes(b) => b.elem.name(),
            Kind::WeakMap(_) => "WeakMap",
            Kind::Url(_) => "URL",
            Kind::SearchParams(_) => "URLSearchParams",
            Kind::Headers(_) => "Headers",
            Kind::WeakSet(_) => "WeakSet",
            Kind::ExoticIter { target, .. } => match vm.heap[*target as usize].kind {
                Kind::Bytes(_) => "Array Iterator",
                Kind::SearchParams(_) => "URLSearchParams Iterator",
                Kind::Headers(_) => "Headers Iterator",
                _ => "Iterator",
            },
            _ => "Object",
        },
    }
}

/// The tag `Object.prototype.toString` reports for a value (the reference's `classTag`): the `Symbol.toStringTag` JS
/// puts on `Math`, `JSON`, `crypto` and the TextEncoder and TextDecoder prototypes, which objects inheriting from them
/// report too, then a generator or async function's, then its kind's.
pub fn class_tag(vm: &Vm, v: &Value) -> &'static str {
    let Value::Obj(id) = *v else {
        return tag_of(vm, v);
    };
    let s = &vm.realm.std;
    let loaded = |bit: u16| s.loaded & bit != 0;
    let tags = [
        (Some(s.math), "Math"),
        (Some(s.json), "JSON"),
        (loaded(64).then_some(s.crypto), "Crypto"),
        (
            loaded(super::LAZY_BYTES).then_some(s.text_encoder),
            "TextEncoder",
        ),
        (
            loaded(super::LAZY_BYTES).then_some(s.text_decoder),
            "TextDecoder",
        ),
    ];
    let mut cur = Some(id);
    while let Some(c) = cur {
        if let Some((_, tag)) = tags.iter().find(|(t, _)| *t == Some(c)) {
            return tag;
        }
        cur = vm.heap[c as usize].proto;
    }
    match &vm.heap[id as usize].kind {
        Kind::Error(_) => "Error",
        Kind::Native { .. } if super::array::is_from_async(vm, id) => "AsyncFunction",
        Kind::Closure(c) => match (c.proto.is_generator, c.proto.is_async) {
            (true, true) => "AsyncGeneratorFunction",
            (true, false) => "GeneratorFunction",
            (false, true) => "AsyncFunction",
            (false, false) => "Function",
        },
        _ => tag_of(vm, v),
    }
}

fn proto_to_string(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    // A string `Symbol.toStringTag`, own or inherited, names the value; the program's getters are read ahead.
    let readable = match this {
        Value::Obj(id) => !vm.is_namespace(id),
        Value::Undef | Value::Null | Value::Uninit => false,
        _ => true,
    };
    let tag = match (readable, this) {
        // A plain read, which a promise's missing key passes as for any object.
        (true, Value::Obj(id)) => vm.reading(|vm| Ok(vm.get_obj(id, SYM_TO_STRING_TAG)))?,
        (true, _) => vm.reading(|vm| vm.get(&this, SYM_TO_STRING_TAG))?,
        (false, _) => Value::Undef,
    };
    if vm.reads_pending() {
        return Ok(Value::Undef);
    }
    let t = match tag {
        Value::Str(s) => format!("[object {}]", vm.text(s)),
        _ => format!("[object {}]", class_tag(vm, &this)),
    };
    Ok(vm.static_str(&t))
}

fn proto_to_locale_string(vm: &mut Vm, this: Value, _args: &[Value], callee: Id) -> Res {
    if this.is_nullish() || is_namespace_ref(vm, &this) {
        return Err(vm.type_error("Object.prototype.toLocaleString called on null or undefined."));
    }
    let k = vm.names.to_string;
    let f = vm.get(&this, k)?;
    // The reference hands on to `toString` as `call` does (`invokeMethod`).
    invoke(vm, callee, f, this, &[])
}

fn proto_value_of(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    if this.is_nullish() {
        return Err(vm.type_error("Object.prototype.valueOf called on null or undefined."));
    }
    Ok(this)
}

fn proto_is_prototype_of(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let p = object_receiver(vm, &this, "isPrototypeOf")?;
    let Value::Obj(mut cur) = arg(args, 0) else {
        return Ok(Value::Bool(false));
    };
    while let Some(next) = vm.heap[cur as usize].proto {
        if next == p {
            return Ok(Value::Bool(true));
        }
        cur = next;
    }
    Ok(Value::Bool(false))
}

fn proto_property_is_enumerable(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    own_check(vm, this, args, "prototype.propertyIsEnumerable", |vm, k| {
        let Value::Obj(id) = this else {
            return primitive_slot(vm, &this, k).is_some_and(|s| s.enumerable);
        };
        let o = &vm.heap[id as usize];
        // A sparse array's far elements are properties, read below.
        if let Kind::Array(items) = &o.kind
            && let Some(i) = vm.atoms.index(k)
            && items
                .get(i as usize)
                .is_some_and(|v| !matches!(v, Value::Uninit))
        {
            return true;
        }
        o.props
            .find(k)
            .is_some_and(|i| o.props.items[i].flags & ENUMERABLE != 0)
    })
}

// ---------- Function ----------

fn function_ctor(vm: &mut Vm, _this: Value, _args: &[Value], _: Id) -> Res {
    Err(vm.type_error("The Function constructor is not supported; write the function inline."))
}

/// The receiver of `Function.prototype.call`, `apply` or `bind`, which must be callable.
fn function_receiver(vm: &mut Vm, this: &Value, method: &str) -> Result<(), Value> {
    if vm.is_callable(this) && !matches!(this, Value::Obj(id) if vm.is_namespace(*id)) {
        return Ok(());
    }
    let d = vm.describe_data(this);
    Err(vm.type_error(&format!(
        "Function.prototype.{method} called on incompatible receiver {d}."
    )))
}

fn function_call(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    function_receiver(vm, &this, "call")?;
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    invoke(vm, callee, this, arg(args, 0), rest)
}

/// Calls `f` as the reference's `call` and `apply` do: they cost a native call before they hand on to `f`, which
/// costs what a call of it from bytecode costs (see `fuel.rs`). The call is made from a native frame.
pub(crate) fn invoke(vm: &mut Vm, callee: Id, f: Value, this: Value, args: &[Value]) -> Res {
    super::fuel::native(vm);
    let mut slots = vec![f, this, Value::Num(args.len() as f64)];
    slots.extend_from_slice(args);
    vm.enter_native(
        crate::native::NativeOp::Invoke,
        callee,
        Value::Undef,
        &slots,
    )
}

/// The step of `call` and `apply`'s frame: its slots are the function, the receiver, the argument count and the
/// arguments.
pub(crate) fn invoke_step(
    vm: &mut Vm,
    fr: crate::native::Frame,
    input: crate::native::Input,
) -> Result<crate::native::Step, Value> {
    use crate::native::{Input, Step};
    match input {
        Input::Start => {
            let (f, this, argc) = (fr.slot(vm, 0), fr.slot(vm, 1), fr.index(vm, 2));
            let at = fr.base() + 3;
            let args: Vec<_> = vm.stack[at..at + argc].to_vec();
            vm.stack.extend_from_slice(&[f, this]);
            vm.stack.extend_from_slice(&args);
            vm.native_call(argc)
        }
        Input::Returned(r) => {
            vm.bytecode_builtin();
            Ok(Step::Done(r.get()))
        }
        Input::Threw(e) => Err(e),
        Input::Finished(_) => Ok(Step::Done(Value::Undef)),
    }
}

fn function_apply(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    function_receiver(vm, &this, "apply")?;
    let list = match arg(args, 1) {
        Value::Undef | Value::Null => Vec::new(),
        Value::Obj(id) if !vm.is_namespace(id) => {
            vm.reading(|vm| array_like(vm, &Value::Obj(id)))?
        }
        _ => {
            return Err(
                vm.type_error("Function.prototype.apply expects an array-like argument list.")
            );
        }
    };
    invoke(vm, callee, this, arg(args, 0), &list)
}

pub fn array_like(vm: &mut Vm, v: &Value) -> Result<Vec<Value>, Value> {
    let Value::Obj(id) = v else {
        return Ok(Vec::new());
    };
    if let Kind::Array(_) = &vm.heap[*id as usize].kind {
        vm.densify(*id)?;
        if let Kind::Array(items) = &vm.heap[*id as usize].kind {
            return Ok(crate::ops::without_holes(items));
        }
    }
    let lk = vm.names.length;
    let len = vm.get_obj(*id, lk);
    let n = crate::value::to_integer(vm.number_of(&len)?)
        .clamp(0.0, crate::ops::MAX_ARRAY_LEN as f64) as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(vm.get_elem(v, &Value::Num(i as f64))?);
    }
    Ok(out)
}

fn function_bind(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    function_receiver(vm, &this, "bind")?;
    let rest: Vec<Value> = args.iter().skip(1).cloned().collect();
    // Like the reference: `bound <name>`, and the target's length less the bound arguments, at least 0.
    let (lk, nk) = (vm.names.length, vm.names.name);
    // The target's `length` and `name` through their getters, read ahead (`Vm::with_reads`).
    let (len, nm) = vm.reading(|vm| Ok((vm.get(&this, lk)?, vm.get(&this, nk)?)))?;
    let length = match len {
        Value::Num(n) if n == f64::INFINITY => n,
        Value::Num(n) if n.is_finite() => (n.trunc() - rest.len() as f64).max(0.0),
        _ => 0.0,
    };
    let name = match nm {
        Value::Str(s) => format!("bound {}", vm.text(s)),
        _ => "bound ".to_owned(),
    };
    let fp = vm.realm.function_proto;
    let id = vm.alloc(Obj::new(
        Some(fp),
        Kind::Bound(Box::new((this, arg(args, 0), rest))),
    ));
    let name = vm.string_val(name);
    vm.heap[id as usize].props.insert(lk, Value::Num(length), 0);
    vm.heap[id as usize].props.insert(nk, name, 0);
    Ok(Value::Obj(id))
}

// ---------- Error ----------

fn make_error_from(vm: &mut Vm, proto: Id, message: &Value, options: &Value) -> Res {
    let id = vm.alloc(Obj::new(Some(proto), Kind::Error(None)));
    if !matches!(message, Value::Undef) {
        let m = vm.string_of(message)?;
        let mk = vm.names.message;
        vm.define_hidden(id, mk, Value::Str(m));
    }
    let trace = vm.stack_trace();
    vm.add_stack(id, trace);
    if let Value::Obj(o) = *options {
        let ck = vm.names.cause;
        // A program getter for `cause` is read ahead (`Vm::with_reads`).
        let cause = vm.reading(|vm| {
            Ok(if vm.has_key(o, ck) {
                Some(vm.get_obj(o, ck))
            } else {
                None
            })
        })?;
        if let Some(c) = cause {
            vm.define_hidden(id, ck, c);
        }
    }
    Ok(Value::Obj(id))
}

/// The prototype a constructed error gets: its type's, or for `super(...)` in a class its new target's own
/// `prototype` (the reference's `prototypeFrom`).
fn error_proto(vm: &mut Vm, callee: Id, fallback: Id) -> Id {
    let proto = vm.native_data(callee).as_obj().unwrap_or(fallback);
    let Some(nt) = vm.new_target.take() else {
        return proto;
    };
    match vm.heap[nt as usize].props.prop(vm.names.prototype) {
        Some(p) if p.flags & ACCESSOR == 0 => p.value().as_obj().unwrap_or(proto),
        _ => proto,
    }
}

/// Whether `id` is an error type's constructor, which a class may extend.
pub(crate) fn is_error_ctor(vm: &Vm, id: Id) -> bool {
    matches!(&vm.heap[id as usize].kind, Kind::Native { f, .. }
        if std::ptr::fn_addr_eq(*f, error_ctor as crate::vm::NativeFn)
            || std::ptr::fn_addr_eq(*f, aggregate_error_ctor as crate::vm::NativeFn))
}

fn error_ctor(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    let proto = error_proto(vm, callee, vm.realm.error_proto);
    let mut c = fuel::Conversions::default();
    let message = error_message(vm, &mut c, arg(args, 0))?;
    let r = make_error_from(vm, proto, &message, &arg(args, 1));
    c.finish(vm, r)
}

/// An error constructor's message, when there is one, is its list of conversions, made a string.
fn error_message(vm: &mut Vm, c: &mut fuel::Conversions, message: Value) -> Res {
    let mut m = [message];
    if !matches!(message, Value::Undef) {
        c.convert(vm, &[Hint::String], &mut m, true)?;
    }
    Ok(m[0])
}

fn aggregate_error_ctor(vm: &mut Vm, this: Value, args: &[Value], callee: Id) -> Res {
    let proto = error_proto(vm, callee, vm.realm.aggregate_error_proto);
    let mut c = fuel::Conversions::default();
    let message = error_message(vm, &mut c, arg(args, 1))?;
    let e = make_error_from(vm, proto, &message, &arg(args, 2))?;
    // The errors are read in the reference's prelude (`aggregateError`), after the call itself when it is not `new`.
    let called = !matches!(this, Value::Uninit);
    if called {
        c.handoff(vm);
    } else {
        fuel::method(vm);
    }
    let source = arg(args, 0);
    if !vm.is_iterable(&source) {
        return Err(vm.not_iterable(&source, crate::bytecode::ITER_FOR_OF));
    }
    let errors = vm.new_array(Vec::new());
    let own = [e, errors, Value::Bool(called)];
    crate::native::enter_for_of_sub(
        vm,
        crate::native::NativeOp::Callbacks,
        SUB_AGGREGATE,
        callee,
        Value::Undef,
        source,
        &own,
    )
}

/// `AggregateError` reading its errors: its own slots are the error, the errors read so far (an internal array) and
/// whether it was called without `new`.
struct Aggregate;

impl crate::native::ForOf for Aggregate {
    fn item(vm: &mut Vm, fr: crate::native::Frame, x: Value) -> Result<crate::native::Flow, Value> {
        let errors = fr.get(vm, crate::native::FOR_OF_SLOTS + 1).as_obj();
        if let Some(errors) = errors
            && let Kind::Array(items) = &mut vm.heap[errors as usize].kind
        {
            items.push(x);
        }
        Ok(crate::native::Flow::Next)
    }

    fn finish(vm: &mut Vm, fr: crate::native::Frame) -> Res {
        let base = crate::native::FOR_OF_SLOTS;
        let (e, errors) = (fr.get(vm, base), fr.get(vm, base + 1));
        fuel::native(vm);
        if let Value::Obj(id) = e {
            let ek = vm.names.errors;
            vm.define_hidden(id, ek, errors);
        }
        if vm.truthy(&fr.get(vm, base + 2)) {
            vm.bytecode_builtin();
        }
        Ok(e)
    }
}

fn error_is_error(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    Ok(Value::Bool(
        matches!(arg(args, 0), Value::Obj(id) if matches!(vm.heap[id as usize].kind, Kind::Error(_))),
    ))
}

fn error_to_string(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    let id = this_obj(vm, &this, "Error.prototype.toString")?;
    // `name` and `message` through their getters, read ahead (`Vm::with_reads`).
    let (nk, mk) = (vm.names.name, vm.names.message);
    let (name, message) = vm.reading(|vm| Ok((vm.get_obj(id, nk), vm.get_obj(id, mk))))?;
    let name = match name {
        Value::Undef => "Error".to_owned(),
        v => vm.quiet_string(&v),
    };
    let message = match message {
        Value::Undef => String::new(),
        v => vm.quiet_string(&v),
    };
    let s = if message.is_empty() {
        name
    } else if name.is_empty() {
        message
    } else {
        format!("{name}: {message}")
    };
    Ok(vm.string_val(s))
}

// ---------- Boolean and Symbol ----------

fn boolean_ctor(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    if let Value::Uninit = this {
        return Err(vm.type_error(
            "new Boolean(...) is not supported; call Boolean(...) without new instead.",
        ));
    }
    Ok(Value::Bool(vm.truthy(&arg(args, 0))))
}

fn this_bool(vm: &mut Vm, this: &Value) -> Result<bool, Value> {
    match this {
        Value::Bool(b) => Ok(*b),
        _ => Err(vm.type_error("Boolean.prototype method called on an incompatible receiver")),
    }
}

fn boolean_to_string(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    let b = this_bool(vm, &this)?;
    Ok(vm.static_str(if b { "true" } else { "false" }))
}

fn boolean_value_of(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    Ok(Value::Bool(this_bool(vm, &this)?))
}

fn symbol_ctor(vm: &mut Vm, _this: Value, _args: &[Value], _: Id) -> Res {
    Err(vm.type_error(
        "Symbol is not callable; only Symbol.asyncIterator, Symbol.iterator, Symbol.toPrimitive and Symbol.toStringTag are available.",
    ))
}

/// The symbol a `Symbol.prototype` method is called on.
pub(crate) fn this_symbol(vm: &mut Vm, this: &Value, name: &str) -> Result<Atom, Value> {
    match this {
        Value::Sym(s) => Ok(*s),
        _ => Err(vm.type_error(&format!(
            "Symbol.prototype.{name} requires that 'this' be a Symbol."
        ))),
    }
}

fn symbol_to_string(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    let s = this_symbol(vm, &this, "toString")?;
    Ok(vm.atom_val(s))
}

fn symbol_value_of(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    Ok(Value::Sym(this_symbol(vm, &this, "valueOf")?))
}

fn symbol_to_primitive(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    Ok(Value::Sym(this_symbol(vm, &this, "[Symbol.toPrimitive]")?))
}

/// A symbol's `description`: `Symbol.iterator` for `Symbol(Symbol.iterator)`.
pub(crate) fn symbol_description(vm: &mut Vm, s: Atom) -> Value {
    let text = crate::ops::symbol_text(s);
    vm.static_str(&text["Symbol(".len()..text.len() - 1])
}

/// The members `Symbol`, `Symbol.prototype` and `Object` gained with the well-known symbols, after the others: made
/// when a program names `Symbol` or `Object`, the only ways it can reach a symbol (see `LAZY`).
pub(crate) fn setup_symbols(vm: &mut Vm) {
    let sp = vm.realm.symbol_proto;
    let ck = vm.names.constructor;
    if let Value::Obj(symbol) = vm.get_obj(sp, ck) {
        vm.constant(symbol, "toPrimitive", Value::Sym(SYM_TO_PRIMITIVE));
        vm.constant(symbol, "toStringTag", Value::Sym(SYM_TO_STRING_TAG));
    }
    vm.method(sp, "valueOf", 0, symbol_value_of);
    super::accessors(vm, sp, &["description"]);
    // Read-only, configurable: the reference's `readonly`.
    let to_primitive = vm.native_fn("[Symbol.toPrimitive]", 1, symbol_to_primitive, Value::Undef);
    vm.heap[sp as usize]
        .props
        .insert(SYM_TO_PRIMITIVE, to_primitive, 0);
    let tag = vm.static_str("Symbol");
    vm.heap[sp as usize].props.insert(SYM_TO_STRING_TAG, tag, 0);
    // `Object.getOwnPropertySymbols` in its place, before `getOwnPropertyNames`, as the reference orders them.
    let op = vm.realm.object_proto;
    if let Value::Obj(object) = vm.get_obj(op, ck) {
        let f = vm.native_fn(
            "getOwnPropertySymbols",
            1,
            object_get_own_property_symbols,
            Value::Undef,
        );
        let (key, before) = (
            vm.atoms.intern_static("getOwnPropertySymbols"),
            vm.atoms.intern_static("getOwnPropertyNames"),
        );
        vm.heap[object as usize]
            .props
            .insert_before(before, key, f, HIDDEN);
    }
}

/// The console methods added after the first seven, made when a program names `console` (see `LAZY`).
pub(crate) fn setup_console(vm: &mut Vm) {
    let ck = vm.atoms.intern_static("console");
    let Some(Value::Obj(console)) = vm.global_map.get(&ck).copied() else {
        return;
    };
    vm.methods(
        console,
        &[
            ("assert", 0, console_assert),
            ("count", 0, console_count),
            ("countReset", 0, console_count_reset),
            ("group", 0, console_group),
            ("groupCollapsed", 0, console_group),
            ("groupEnd", 0, console_group_end),
            ("trace", 0, console_trace),
            ("time", 0, console_time),
            ("timeLog", 0, console_time_log),
            ("timeEnd", 0, console_time_end),
        ],
    );
}

// ---------- JSON ----------

fn json_parse(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    let mut c = fuel::Conversions::default();
    let r = parse(vm, &mut c, args, callee);
    c.finish(vm, r)
}

/// `JSON.parse` after its text, a list of conversions of its own.
fn parse(vm: &mut Vm, c: &mut fuel::Conversions, args: &[Value], callee: Id) -> Res {
    // A plain object or an array is a value that was parsed already: it is returned unchanged, rather than its text
    // parsed ("[object Object]", or the array's elements joined).
    if let Value::Obj(id) = arg(args, 0)
        && matches!(vm.heap[id as usize].kind, Kind::Array(_) | Kind::Ordinary)
    {
        return Ok(Value::Obj(id));
    }
    let mut text = [arg(args, 0)];
    c.convert(vm, &[Hint::String], &mut text, false)?;
    let text = vm.string_of(&text[0])?;
    let text = vm.text(text).to_owned();
    let reviver = arg(args, 1);
    if vm.type_of(&reviver) != "function" {
        return convert::parse(vm, &text);
    }
    let (v, snapshot) = convert::parse_revivable(vm, &text)?;
    let reviver = super::require_callback(vm, &reviver, "JSON.parse")?;
    let holder = vm.new_object();
    let empty = vm.atoms.intern_static("");
    vm.define(holder, empty, v);
    // The reference revives in its prelude (`revive`), after `JSON.parse`'s own call.
    c.call(vm);
    let key = vm.static_str("");
    let op = crate::native::NativeOp::Revive;
    vm.enter_native(op, callee, Value::Undef, &[reviver, Value::Num(0.0)])?;
    push_level(vm, Value::Obj(holder), key, snapshot);
    Ok(Value::Undef)
}

// The slots of a reviving frame: the reviver and how many levels deep it is; then, per level, the holder, the key, the
// value, the value's keys (an internal array, or undefined for a primitive), the next of them to revive, and the
// value's snapshot (see `convert::parse_revivable`), once an object's visited its children's snapshots.
const REV_F: usize = 0;
const REV_DEPTH: usize = 1;
const REV_LEVELS: usize = 2;
const LEVEL: usize = 6;
const L_HOLDER: usize = 0;
const L_KEY: usize = 1;
const L_VAL: usize = 2;
const L_KEYS: usize = 3;
const L_I: usize = 4;
const L_SNAP: usize = 5;

/// Pushes a level to revive `key` of `holder`, on top of the frame's slots.
fn push_level(vm: &mut Vm, holder: Value, key: Value, snapshot: Value) {
    vm.stack.extend(
        [
            holder,
            key,
            Value::Undef,
            Value::Undef,
            Value::Num(0.0),
            snapshot,
        ]
        .map(crate::value::Slot::pack),
    );
}

/// The two items of a snapshot (an internal array).
fn snapshot_items(vm: &Vm, snapshot: &Value) -> Option<(Value, Value)> {
    match &vm.heap[snapshot.as_obj()? as usize].kind {
        Kind::Array(items) if items.len() == 2 => Some((items[0], items[1])),
        _ => None,
    }
}

/// The step of a reviving frame: the prelude's `revive`, entered once per value; an object's `$IsObject` and
/// `$Keys`, a back-edge per key, then the reviver, children first, with a context giving the source text of a
/// primitive the revivers left as parsed.
pub(crate) fn revive_step(
    vm: &mut Vm,
    fr: crate::native::Frame,
    input: crate::native::Input,
) -> Result<crate::native::Step, Value> {
    use crate::native::{Input, Step};
    let mut depth = fr.index(vm, REV_DEPTH);
    let at = |depth: usize, k: usize| REV_LEVELS + depth * LEVEL + k;
    // Whether the level on top is visited already, its keys walked from `L_I`.
    let mut visited = false;
    match input {
        Input::Start => {}
        Input::Returned(nv) => {
            let nv = nv.get();
            if depth == 0 {
                vm.bytecode_builtin();
                return Ok(Step::Done(nv));
            }
            vm.stack.truncate(fr.base() + at(depth, 0));
            depth -= 1;
            fr.set_index(vm, REV_DEPTH, depth);
            let val = fr.get(vm, at(depth, L_VAL));
            let keys = fr.get(vm, at(depth, L_KEYS)).as_obj().unwrap_or(0);
            let i = fr.index(vm, at(depth, L_I));
            let k = match &vm.heap[keys as usize].kind {
                Kind::Array(items) => items.get(i).copied().unwrap_or_default(),
                _ => Value::Undef,
            };
            let k = vm.key_of(&k)?;
            if let Value::Undef = nv {
                vm.delete(&val, k)?;
            } else if let Value::Obj(id) = val {
                vm.set_obj(id, k, nv)?;
            }
            fuel::step(vm);
            fr.set_index(vm, at(depth, L_I), i + 1);
            visited = true;
        }
        Input::Threw(e) => return Err(e),
        Input::Finished(_) => {}
    }
    loop {
        let (holder, key) = (
            fr.get(vm, at(depth, L_HOLDER)),
            fr.get(vm, at(depth, L_KEY)),
        );
        if !visited {
            fuel::method(vm);
            let k = vm.key_of(&key)?;
            let val = vm.get(&holder, k)?;
            fuel::native(vm);
            fr.set(vm, at(depth, L_VAL), val);
            if let Value::Obj(id) = val {
                // The children's snapshots, while the value is the one parsed.
                let children = match snapshot_items(vm, &fr.get(vm, at(depth, L_SNAP))) {
                    Some((Value::Obj(parsed), children)) if parsed == id => children,
                    _ => Value::Undef,
                };
                fr.set(vm, at(depth, L_SNAP), children);
                let keys: Vec<Value> = vm
                    .own_keys(id)
                    .into_iter()
                    .map(|a| vm.atom_val(a))
                    .collect();
                fuel::native(vm);
                let keys = vm.new_array(keys);
                fr.set(vm, at(depth, L_KEYS), keys);
            }
        }
        let val = fr.get(vm, at(depth, L_VAL));
        let next_key = match fr
            .get(vm, at(depth, L_KEYS))
            .as_obj()
            .map(|k| &vm.heap[k as usize].kind)
        {
            Some(Kind::Array(items)) => items.get(fr.index(vm, at(depth, L_I))).copied(),
            _ => None,
        };
        let snapshot = fr.get(vm, at(depth, L_SNAP));
        if let Some(k) = next_key {
            let child = match snapshot {
                Value::Obj(children) => {
                    let a = vm.key_of(&k)?;
                    vm.heap[children as usize].props.get(a).unwrap_or_default()
                }
                _ => Value::Undef,
            };
            push_level(vm, val, k, child);
            depth += 1;
            fr.set_index(vm, REV_DEPTH, depth);
            visited = false;
            continue;
        }
        let context = vm.new_object();
        if !matches!(val, Value::Obj(_)) && !matches!(snapshot, Value::Undef) {
            // `$IsObject` of the snapshot's first item.
            fuel::native(vm);
            if let Some((source, parsed)) = snapshot_items(vm, &snapshot)
                && !matches!(source, Value::Obj(_))
                && vm.same_value(&val, &parsed)
            {
                let sk = vm.atoms.intern_static("source");
                vm.define(context, sk, source);
            }
        }
        let f = fr.slot(vm, REV_F);
        let (holder, key, val, context) = (
            crate::value::Slot::pack(holder),
            crate::value::Slot::pack(key),
            crate::value::Slot::pack(val),
            crate::value::Slot::pack(Value::Obj(context)),
        );
        return fr.call_slots(vm, f, holder, [key, val, context]);
    }
}

fn json_stringify(vm: &mut Vm, _this: Value, args: &[Value], callee: Id) -> Res {
    let replacer = arg(args, 1);
    let mut opts = convert::Stringify {
        indent: String::new(),
        replacer_fn: None,
        allow: None,
    };
    if vm.type_of(&replacer) == "function" {
        opts.replacer_fn = Some(super::require_callback(vm, &replacer, "JSON.stringify")?);
    } else if let Value::Obj(id) = replacer
        && matches!(vm.heap[id as usize].kind, Kind::Array(_))
        && vm.densify(id).is_ok()
        && let Kind::Array(items) = &vm.heap[id as usize].kind
    {
        let items = items.clone();
        let mut allow = Vec::new();
        for i in items {
            if matches!(i, Value::Str(_) | Value::Num(_)) {
                let a = vm.key_of(&i)?;
                if !allow.contains(&a) {
                    allow.push(a);
                }
            }
        }
        opts.allow = Some(allow);
    }
    match arg(args, 2) {
        Value::Num(n) => opts.indent = " ".repeat(n.clamp(0.0, 10.0) as usize),
        Value::Str(s) => opts.indent = vm.atoms.sref(s).slice16(0, 10),
        _ => {}
    }
    let v = arg(args, 0);
    match convert::stringify(vm, &v, &opts)? {
        Some(Some(s)) => Ok(vm.string_val(s)),
        Some(None) => Ok(Value::Undef),
        None => convert::enter_stringify(vm, callee, v, opts),
    }
}

// ---------- console ----------

/// What `console.count`, `group` and `time` remember between calls. Saved with the run.
#[derive(Clone, Default)]
pub struct ConsoleState {
    pub counts: Vec<(String, f64)>,
    /// The epoch milliseconds each `time` label started at, so the time elapsed survives a save and restore.
    pub timers: Vec<(String, f64)>,
    pub indent: String,
}

fn console_state(vm: &mut Vm) -> &mut ConsoleState {
    vm.console.get_or_insert_default()
}

/// Logs `prefix` and `message`, each of the message's lines indented by the groups open.
fn push_log(vm: &mut Vm, prefix: &str, message: &str) -> Res {
    let indent = vm.console.as_ref().map_or("", |c| c.indent.as_str());
    let mut line = String::from(prefix);
    if indent.is_empty() {
        line.push_str(message);
    } else {
        // As `message.replace(/^/gm, indent)`: at the start and after each line terminator.
        line.push_str(indent);
        for c in message.chars() {
            line.push(c);
            if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                line.push_str(indent);
            }
        }
    }
    vm.logs.push(line);
    Ok(Value::Undef)
}

fn format_args(vm: &mut Vm, args: &[Value]) -> String {
    let parts: Vec<String> = args.iter().map(|a| convert::format_value(vm, a)).collect();
    parts.join(" ")
}

fn log_line(vm: &mut Vm, prefix: &str, args: &[Value]) -> Res {
    let message = format_args(vm, args);
    push_log(vm, prefix, &message)
}

/// A count's or timer's label: `default` when omitted.
fn console_label(vm: &mut Vm, args: &[Value]) -> Result<String, Value> {
    match arg(args, 0) {
        Value::Undef => Ok("default".to_owned()),
        v => super::builtin_string(vm, &v),
    }
}

fn console_assert(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if vm.truthy(&arg(args, 0)) {
        return Ok(Value::Undef);
    }
    let rest = args.get(1..).unwrap_or_default();
    if rest.is_empty() {
        return push_log(vm, "[error] ", "Assertion failed");
    }
    let separator = if matches!(rest[0], Value::Str(_)) {
        ": "
    } else {
        " "
    };
    let message = format!("Assertion failed{separator}{}", format_args(vm, rest));
    push_log(vm, "[error] ", &message)
}

fn console_count(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let name = console_label(vm, args)?;
    let counts = &mut console_state(vm).counts;
    let count = match counts.iter_mut().find(|(k, _)| *k == name) {
        Some((_, n)) => {
            *n += 1.0;
            *n
        }
        None => {
            counts.push((name.clone(), 1.0));
            1.0
        }
    };
    push_log(
        vm,
        "",
        &format!("{name}: {}", crate::value::num_to_string(count)),
    )
}

fn console_count_reset(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let name = console_label(vm, args)?;
    match console_state(vm)
        .counts
        .iter_mut()
        .find(|(k, _)| *k == name)
    {
        Some((_, n)) => *n = 0.0,
        None => return push_log(vm, "[warn] ", &format!("Count for '{name}' does not exist")),
    }
    Ok(Value::Undef)
}

fn console_group(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if !args.is_empty() {
        log_line(vm, "", args)?;
    }
    console_state(vm).indent.push_str("  ");
    Ok(Value::Undef)
}

fn console_group_end(vm: &mut Vm, _this: Value, _args: &[Value], _: Id) -> Res {
    let indent = &mut console_state(vm).indent;
    *indent = indent.chars().skip(2).collect();
    Ok(Value::Undef)
}

fn console_trace(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if args.is_empty() {
        return push_log(vm, "[error] ", "Trace");
    }
    let message = format!("Trace: {}", format_args(vm, args));
    push_log(vm, "[error] ", &message)
}

fn console_time(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let name = console_label(vm, args)?;
    let now = super::date::now();
    let timers = &mut console_state(vm).timers;
    if timers.iter().any(|(k, _)| *k == name) {
        let message = format!("Label '{name}' already exists for console.time()");
        return push_log(vm, "[warn] ", &message);
    }
    timers.push((name, now));
    Ok(Value::Undef)
}

/// The time since the label's `time`, as Node shows it, or a warning logged when it has none.
fn console_elapsed(vm: &mut Vm, name: &str, method: &str) -> Result<Option<String>, Value> {
    let start = console_state(vm)
        .timers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, t)| *t);
    let Some(start) = start else {
        push_log(
            vm,
            "[warn] ",
            &format!("No such label '{name}' for console.{method}()"),
        )?;
        return Ok(None);
    };
    let ms = super::date::now() - start;
    Ok(Some(if ms < 1000.0 {
        format!("{}ms", crate::value::num_to_fixed(ms, 3))
    } else {
        format!("{}s", crate::value::num_to_fixed(ms / 1000.0, 3))
    }))
}

fn console_time_log(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let name = console_label(vm, args)?;
    let Some(time) = console_elapsed(vm, &name, "timeLog")? else {
        return Ok(Value::Undef);
    };
    let mut message = format!("{name}: {time}");
    for a in args.iter().skip(1) {
        message.push(' ');
        message.push_str(&convert::format_value(vm, a));
    }
    push_log(vm, "", &message)
}

fn console_time_end(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let name = console_label(vm, args)?;
    let Some(time) = console_elapsed(vm, &name, "timeEnd")? else {
        return Ok(Value::Undef);
    };
    console_state(vm).timers.retain(|(k, _)| *k != name);
    push_log(vm, "", &format!("{name}: {time}"))
}

fn console_log(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    log_line(vm, "", args)
}
fn console_debug(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    log_line(vm, "[debug] ", args)
}
fn console_warn(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    log_line(vm, "[warn] ", args)
}
fn console_error(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    log_line(vm, "[error] ", args)
}
fn console_dir(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    if args.is_empty() {
        return push_log(vm, "", "undefined");
    }
    log_line(vm, "", &args[..1])
}

/// Whether a value is opaque, a reference rather than data: a function, promise, iterator or namespace path (the
/// reference's `isOpaque`).
fn is_opaque(vm: &Vm, v: &Value) -> bool {
    let Value::Obj(id) = v else { return false };
    !matches!(
        vm.heap[*id as usize].kind,
        Kind::Ordinary
            | Kind::Error(_)
            | Kind::Arguments(_)
            | Kind::Array(_)
            | Kind::Map(_)
            | Kind::Set(_)
            | Kind::WeakMap(_)
            | Kind::WeakSet(_)
            | Kind::Date(_)
            | Kind::RegExp(_)
            | Kind::Bytes(_)
            | Kind::Url(_)
            | Kind::SearchParams(_)
            | Kind::Headers(_)
            | Kind::TextDecoder(_)
    )
}

/// A row's cells: an object's own entries (or the chosen columns), or the value itself under `Value`.
fn table_values(vm: &mut Vm, v: &Value, columns: &Option<Vec<String>>) -> Vec<(String, Value)> {
    if let Value::Obj(id) = v
        && !matches!(vm.heap[*id as usize].kind, Kind::Array(_))
    {
        return match columns {
            Some(cols) => cols
                .iter()
                .map(|c| {
                    let k = vm.atoms.intern(c);
                    let v = match vm.shown_property(*id, k) {
                        Ok(v) => v,
                        Err(label) => vm.str_val(label),
                    };
                    (c.clone(), v)
                })
                .collect(),
            None => vm
                .shown_entries(*id)
                .into_iter()
                .map(|(k, v)| {
                    let v = match v {
                        Ok(v) => v,
                        Err(label) => vm.str_val(label),
                    };
                    (vm.atoms.text(k).to_owned(), v)
                })
                .collect(),
        };
    }
    vec![("Value".to_owned(), *v)]
}

/// Orders record keys as a JavaScript object would: array indexes ascending, then the rest as first seen.
fn record_keys(keys: Vec<String>) -> Vec<String> {
    let mut ints: Vec<(u32, String)> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for k in keys {
        if ints.iter().any(|(_, x)| x == &k) || rest.contains(&k) {
            continue;
        }
        match crate::value::index_of_key(&k) {
            Some(i) => ints.push((i, k)),
            None => rest.push(k),
        }
    }
    ints.sort_by_key(|(i, _)| *i);
    ints.into_iter().map(|(_, k)| k).chain(rest).collect()
}

fn console_table(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let data = arg(args, 0);
    if let Value::Undef = data {
        return push_log(vm, "", "undefined");
    }
    // An opaque value prints as `console.log` shows it; one inside the data is a cell.
    if is_opaque(vm, &data) {
        return log_line(vm, "", &[data]);
    }
    for v in [data, arg(args, 1)] {
        if let Value::Obj(id) = v
            && matches!(vm.heap[id as usize].kind, Kind::Array(_))
        {
            vm.densify(id)?;
        }
    }
    let columns = match arg(args, 1) {
        Value::Obj(id) => match &vm.heap[id as usize].kind {
            Kind::Array(items) => {
                let items = items.clone();
                let mut cols = Vec::with_capacity(items.len());
                for i in items {
                    cols.push(super::builtin_string(vm, &i)?);
                }
                Some(cols)
            }
            _ => None,
        },
        _ => None,
    };
    let rows: Vec<(String, Vec<(String, Value)>)> = match data {
        Value::Obj(id) => match &vm.heap[id as usize].kind {
            Kind::Array(items) => {
                let items = items.clone();
                items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| (i.to_string(), table_values(vm, item, &columns)))
                    .collect()
            }
            _ => {
                let entries: Vec<(Atom, Value)> = vm
                    .shown_entries(id)
                    .into_iter()
                    .map(|(k, v)| match v {
                        Ok(v) => (k, v),
                        Err(label) => (k, vm.str_val(label)),
                    })
                    .collect();
                entries
                    .into_iter()
                    .map(|(k, item)| {
                        let k = vm.atoms.text(k).to_owned();
                        (k, table_values(vm, &item, &columns))
                    })
                    .collect()
            }
        },
        v => vec![("0".to_owned(), vec![("Value".to_owned(), v)])],
    };
    // Each row's cells read like an object record: later duplicates win, indexes sort first.
    let rows: Vec<(String, Vec<(String, Value)>)> = rows
        .into_iter()
        .map(|(index, cells)| {
            let keys = record_keys(cells.iter().map(|(k, _)| k.clone()).collect());
            let cells = keys
                .into_iter()
                .map(|k| {
                    let v = cells.iter().rev().find(|(c, _)| c == &k).map(|(_, v)| *v);
                    (k, v.unwrap_or_default())
                })
                .collect();
            (index, cells)
        })
        .collect();
    let keys = match &columns {
        Some(c) => c.clone(),
        None => {
            let mut keys: Vec<String> = Vec::new();
            for (_, cells) in &rows {
                for (k, _) in cells {
                    if !keys.contains(k) {
                        keys.push(k.clone());
                    }
                }
            }
            keys
        }
    };
    let mut lines = vec![
        std::iter::once("(index)".to_owned())
            .chain(keys.iter().cloned())
            .collect::<Vec<_>>()
            .join("\t"),
    ];
    for (index, cells) in &rows {
        let mut line = vec![index.clone()];
        for k in &keys {
            let cell = match cells.iter().find(|(c, _)| c == k) {
                None | Some((_, Value::Undef)) => String::new(),
                Some((_, Value::Str(s))) => vm.text(*s).to_owned(),
                Some((_, v)) => convert::format_value(vm, v),
            };
            line.push(cell);
        }
        lines.push(line.join("\t"));
    }
    push_log(vm, "", &lines.join("\n"))?;
    Ok(Value::Undef)
}

// ---------- global functions ----------

pub fn global_parse_int(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    let listed = [arg(args, 0), arg(args, 1)];
    fuel::with_primitives(vm, &[Hint::String, Hint::Number], listed, false, parse_int)
}

fn parse_int(vm: &mut Vm, [text, radix]: [Value; 2]) -> Res {
    let s = vm.string_of(&text)?;
    let mut radix = to_int32(vm.number_of(&radix)?);
    let owned = vm.text(s).to_owned();
    let t = owned.trim_start_matches(crate::value::is_js_whitespace);
    let (neg, mut t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    if radix == 0 {
        radix = 10;
        if t.starts_with("0x") || t.starts_with("0X") {
            radix = 16;
            t = &t[2..];
        }
    } else if radix == 16 && (t.starts_with("0x") || t.starts_with("0X")) {
        t = &t[2..];
    }
    if !(2..=36).contains(&radix) {
        return Ok(Value::Num(f64::NAN));
    }
    let mut v = 0.0f64;
    let mut any = false;
    for c in t.chars() {
        match c.to_digit(radix as u32) {
            Some(d) => {
                v = v * radix as f64 + d as f64;
                any = true;
            }
            None => break,
        }
    }
    if !any {
        return Ok(Value::Num(f64::NAN));
    }
    Ok(Value::Num(if neg { -v } else { v }))
}

pub fn global_parse_float(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    fuel::with_primitives(vm, &[Hint::String], [arg(args, 0)], false, |vm, [v]| {
        let s = vm.string_of(&v)?;
        Ok(Value::Num(parse_float_prefix(vm.text(s))))
    })
}

fn global_is_nan(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    fuel::with_primitives(vm, &[Hint::Number], [arg(args, 0)], false, |vm, [v]| {
        Ok(Value::Bool(vm.number_of(&v)?.is_nan()))
    })
}

fn global_is_finite(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    fuel::with_primitives(vm, &[Hint::Number], [arg(args, 0)], false, |vm, [v]| {
        Ok(Value::Bool(vm.number_of(&v)?.is_finite()))
    })
}

// The sub-ops of `NativeOp::Callbacks`; a number keeps its meaning once a snapshot may hold it.
/// `Object.fromEntries`.
pub(crate) const SUB_FROM_ENTRIES: u16 = 0;
/// `AggregateError` reading its errors.
pub(crate) const SUB_AGGREGATE: u16 = 1;
/// `Math.sumPrecise` (`builtins::string::SumPrecise`).
pub(crate) const SUB_SUM_PRECISE: u16 = 2;
/// The pairs of `new URLSearchParams(...)` and `new Headers(...)`, and the parts of one pair (`builtins::web`).
pub(crate) const SUB_PAIRS: u16 = 3;
pub(crate) const SUB_PAIR: u16 = 4;
/// `JSON.stringify`'s internal walk (`convert::stringify_step`).
pub(crate) const SUB_STRINGIFY: u16 = 5;
/// The program result's crossing to the host, which calls a `toJSON` of the program's (`cross::frame_step`).
pub(crate) const SUB_CROSS: u16 = 6;
/// A synchronous host call waiting for promises in its arguments (`cross::wait_step`).
pub(crate) const SUB_HOST_WAIT: u16 = 7;

/// The steps of this family's native frames (`native::NativeOp::Callbacks`), by sub-op; see `native.rs`.
pub(crate) fn family_step(
    vm: &mut Vm,
    sub: u16,
    fr: crate::native::Frame,
    input: crate::native::Input,
) -> Result<crate::native::Step, Value> {
    use crate::native::for_of_step;
    match sub {
        SUB_FROM_ENTRIES => for_of_step::<FromEntries>(vm, fr, input),
        SUB_AGGREGATE => for_of_step::<Aggregate>(vm, fr, input),
        SUB_SUM_PRECISE => for_of_step::<super::string::SumPrecise>(vm, fr, input),
        SUB_PAIRS => for_of_step::<super::web::Pairs>(vm, fr, input),
        SUB_PAIR => for_of_step::<super::web::Pair>(vm, fr, input),
        SUB_STRINGIFY => convert::stringify_step(vm, fr, input),
        SUB_CROSS => crate::cross::frame_step(vm, fr, input),
        SUB_HOST_WAIT => crate::cross::wait_step(vm, fr, input),
        crate::accessors::SUB_GETTER_METHOD => crate::accessors::getter_method_step(vm, fr, input),
        crate::accessors::SUB_SETTER => crate::accessors::setter_step(vm, fr, input),
        crate::accessors::SUB_COPY => crate::accessors::copy_step(vm, fr, input),
        _ => Ok(crate::native::Step::Done(Value::Undef)),
    }
}

/// The halves of `Function.prototype`'s `caller` and `arguments`.
pub(crate) fn restricted(vm: &mut Vm, _this: Value, _args: &[Value], _: Id) -> Res {
    Err(vm.type_error(
        "'caller' and 'arguments' are restricted function properties and cannot be accessed in this context.",
    ))
}
