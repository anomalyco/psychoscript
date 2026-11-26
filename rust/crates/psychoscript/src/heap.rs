//! `Limits::max_heap_bytes`: how much a run's heap may hold, as the reference measures it (`src/runtime/heap.ts`).
//! The heap is measured, not the process: everything the run can still reach, in a size model both implementations
//! share, so a measurement is the same on every platform and garbage never counts.
//!
//! - An object made by the run: `OBJECT_BYTES`, plus `PROPERTY_BYTES` per own property, plus `ELEMENT_BYTES` per
//!   array element or argument (holes included), `ENTRY_BYTES` per Map, Set, WeakMap or WeakSet entry. A function's
//!   `name` and `length` are part of it, an accessor's own object part of its property, and the program body's
//!   function object, which the reference has none of, counts nothing.
//! - A typed array's storage: one per byte, once for every view and `ArrayBuffer` that shares it.
//! - What the fresh runtime made (built-ins, host globals, and the lazy groups of built-ins it sets up later) counts
//!   nothing, though the objects the program stored on it do.
//! - A string value: `STRING_BYTES` plus two per UTF-16 code unit, once per distinct text. Property keys count as part
//!   of their property, an error's `stack` text as part of the error, and a built-in's own texts nothing.
//!
//! Measuring walks the reachable heap (`reach.rs`), so it is paced by allocation: the run counts roughly what it
//! allocated since the last measurement (objects and strings made, what concatenations copy, array contents, elements
//! and properties added at once, and `FUEL_BYTES` per unit of the reference's fuel for the rest), and measures again at
//! its next safe point once that could have taken it past the limit, and always as its body returns (its bindings
//! still live) and when the run ends. Over the limit, the run stops with `MemoryLimitExceeded`. When the
//! measurements between the first and the last fall differs from the reference's; what each one finds is the same.

use rustc_hash::FxHashSet;

use crate::DiagnosticKind;
use std::sync::Arc;

use crate::object::{Kind, Obj};
use crate::reach::Ref;
use crate::strings::Atom;
use crate::value::{Id, Value};
use crate::vm::Vm;

pub(crate) const OBJECT_BYTES: u64 = 64;
pub(crate) const PROPERTY_BYTES: u64 = 32;
pub(crate) const ELEMENT_BYTES: u64 = 16;
pub(crate) const ENTRY_BYTES: u64 = 32;
pub(crate) const STRING_BYTES: u64 = 16;
/// What a unit of fuel is assumed to allocate, for growth nothing else counts (`push`, a property added).
pub(crate) const FUEL_BYTES: u64 = 2;

/// One run's pacing of measurements against its limit.
pub(crate) struct HeapMeter {
    pub(crate) limit: u64,
    /// Roughly what the run allocated since the last measurement.
    pub(crate) debt: u64,
    /// The last measurement, or `None` before the first one of a restored run.
    live: Option<u64>,
    /// Objects and strings in the arenas as of the last look, whose growth is charged.
    objects: usize,
    strings: usize,
}

impl HeapMeter {
    fn due(&self) -> bool {
        match self.live {
            None => true,
            Some(live) => self.debt >= self.limit.saturating_sub(live).max(self.limit / 16),
        }
    }
}

impl Vm {
    /// Starts pacing measurements once the run is set up, if it has a heap limit; a restored run measures at its
    /// first safe point.
    pub(crate) fn start_heap_meter(&mut self, restored: bool) {
        self.heap_meter = self.limits.max_heap_bytes.map(|limit| {
            Box::new(HeapMeter {
                limit,
                debt: 0,
                live: if restored { None } else { Some(0) },
                objects: self.heap.len(),
                strings: self.atoms.bufs.len(),
            })
        });
    }

    /// Runs `setup`, a lazy group's, noting the objects it makes as built-ins when the run has a heap limit.
    pub(crate) fn making_builtins(&mut self, setup: fn(&mut Vm)) {
        if self.heap_meter.is_none() {
            return setup(self);
        }
        let (len, free) = (self.heap.len(), self.gc.free_objects().to_vec());
        setup(self);
        let left = self.gc.free_objects().len().min(free.len());
        self.lazy_builtins.extend_from_slice(&free[left..]);
        self.lazy_builtins.extend(len as Id..self.heap.len() as Id);
    }

    /// Charges the heap meter with `bytes` an instruction or built-in adds to an existing array or object, which
    /// allocates no object or string the arenas' growth would count.
    #[inline]
    pub(crate) fn charge_heap(&mut self, bytes: u64) {
        if let Some(m) = self.heap_meter.as_deref_mut() {
            m.debt += bytes;
        }
    }

    /// Charges the heap meter with `n` elements added to an existing array at once.
    #[cold]
    #[inline(never)]
    pub(crate) fn charge_elements(&mut self, n: usize) {
        self.charge_heap(n as u64 * ELEMENT_BYTES);
    }

    /// Charges the heap meter with the own properties `id` gained since it had `before`.
    pub(crate) fn charge_props(&mut self, id: Id, before: usize) {
        let now = self.heap[id as usize].props.len();
        self.charge_heap(now.saturating_sub(before) as u64 * PROPERTY_BYTES);
    }

    /// Charges what the arenas grew by, and `fuel` units of the reference's fuel.
    fn heap_charge(&mut self, fuel: u64) {
        let (objects, strings) = (self.heap.len(), self.atoms.bufs.len());
        let Some(m) = self.heap_meter.as_deref_mut() else {
            return;
        };
        m.debt += objects.saturating_sub(m.objects) as u64 * OBJECT_BYTES
            + strings.saturating_sub(m.strings) as u64 * STRING_BYTES
            + fuel * FUEL_BYTES;
        m.objects = objects;
        m.strings = strings;
    }

    /// A safe point after `fuel` units of the reference's fuel: measures the heap when that is due.
    #[cold]
    pub(crate) fn heap_point(&mut self, fuel: u64) {
        self.heap_charge(fuel);
        if self.heap_meter.as_deref().is_some_and(HeapMeter::due) {
            self.heap_measure();
        }
    }

    /// The body is returning `v`: the heap is measured once more, with the body's own bindings still on the stack, and
    /// `v` among them, as they are as it ends.
    #[cold]
    pub(crate) fn heap_body_end(&mut self, v: Value) {
        if self.fatal.is_some() {
            return;
        }
        self.heap_charge(0);
        self.push(v);
        self.heap_measure();
        self.pop();
    }

    /// The run ended: what it leaves reachable, its value among it, is measured once more.
    pub(crate) fn heap_final(&mut self) {
        if self.fatal.is_none() && self.heap_meter.is_some() {
            self.heap_measure();
        }
    }

    /// Measures the heap; over the limit, the run stops at its next check, which no handler sees.
    fn heap_measure(&mut self) {
        let bytes = measure(self);
        let Some(m) = self.heap_meter.as_deref_mut() else {
            return;
        };
        m.live = Some(bytes);
        m.debt = 0;
        if bytes <= m.limit || self.fatal.is_some() {
            return;
        }
        let message = format!("Execution exceeded its memory limit of {} bytes.", m.limit);
        self.fatal = Some((DiagnosticKind::MemoryLimitExceeded, message));
        self.stop_soon();
    }
}

/// What the run can still reach, in the size model above.
pub(crate) fn measure(vm: &Vm) -> u64 {
    let mut w = Walk {
        vm,
        objects: vec![false; vm.heap.len()],
        cells: vec![false; vm.cells.len()],
        strings: vec![false; vm.atoms.bufs.len()],
        texts: FxHashSet::default(),
        work: Vec::new(),
        bytes: 0,
    };
    crate::reach::roots_but(vm, true, &mut |r| w.see(r));
    let stack = vm.atoms.map.get("stack");
    let named = [Some(&vm.names.name), Some(&vm.names.length)];
    let base = vm.snapshot_base.heap;
    let mut own = vec![false; vm.heap.len().saturating_sub(base)];
    for id in &vm.lazy_builtins {
        if let Some(b) = (*id as usize)
            .checked_sub(base)
            .and_then(|i| own.get_mut(i))
        {
            *b = true;
        }
    }
    while let Some(id) = w.work.pop() {
        let o = &vm.heap[id as usize];
        if (id as usize) < base || own[id as usize - base] {
            // A built-in: what the program stored on it counts, its own names and texts do not.
            crate::reach::children(o, &mut |r| {
                if !matches!(r, Ref::Str(_)) {
                    w.see(r)
                }
            });
            continue;
        }
        w.bytes += object_bytes(vm, o);
        // A typed array's storage counts once, whole, however many views and `ArrayBuffer`s share it.
        if let Kind::Storage(data) = &o.kind {
            w.bytes += data.len() as u64;
        }
        // An error's `stack` text counts as part of the error, a function's `name` and `length` as part of it.
        let skip: &[Option<&Atom>] = match &o.kind {
            Kind::Error(_) => &[stack, stack],
            Kind::Closure(_) | Kind::Native { .. } | Kind::Bound(_) => &named,
            _ => &[],
        };
        if skip.is_empty() {
            crate::reach::children(o, &mut |r| w.see(r));
            continue;
        }
        crate::reach::head(o, &mut |r| w.see(r));
        for p in &o.props.items {
            if !skip.contains(&Some(&p.key)) {
                w.value(p.value());
            }
        }
    }
    w.bytes
}

fn object_bytes(vm: &Vm, o: &Obj) -> u64 {
    let props = match &o.kind {
        // A function's own `name` and `length` count as part of it.
        Kind::Closure(_) | Kind::Native { .. } | Kind::Bound(_) => o
            .props
            .items
            .iter()
            .filter(|p| p.key != vm.names.name && p.key != vm.names.length)
            .count(),
        _ => o.props.len(),
    };
    let own = OBJECT_BYTES + PROPERTY_BYTES * props as u64;
    match &o.kind {
        // An accessor's own object is part of its property; a buffer's storage counts as its bytes.
        // A BigInt counts nothing, as the reference counts its primitives.
        Kind::Accessor(_) | Kind::Storage(_) | Kind::BigInt(_) => 0,
        // The program's body, which the reference runs with no function object.
        Kind::Closure(c) if vm.protos.first().is_some_and(|p| Arc::ptr_eq(p, &c.proto)) => 0,
        Kind::Array(items) | Kind::Arguments(items) => own + ELEMENT_BYTES * items.len() as u64,
        Kind::Map(m) | Kind::Set(m) | Kind::WeakMap(m) | Kind::WeakSet(m) => {
            own + ENTRY_BYTES * m.live as u64
        }

        _ => own,
    }
}

struct Walk<'v> {
    vm: &'v Vm,
    objects: Vec<bool>,
    cells: Vec<bool>,
    strings: Vec<bool>,
    texts: FxHashSet<(&'v str, Option<&'v [u16]>)>,
    work: Vec<Id>,
    bytes: u64,
}

impl Walk<'_> {
    fn see(&mut self, r: Ref) {
        match r {
            Ref::Obj(id) => {
                if let Some(seen) = self.objects.get_mut(id as usize)
                    && !*seen
                {
                    *seen = true;
                    self.work.push(id);
                }
            }
            Ref::Str(s) => self.string(s),
            Ref::Cell(c) => {
                if let Some(seen) = self.cells.get_mut(c as usize)
                    && !*seen
                {
                    *seen = true;
                    self.value(self.vm.cells[c as usize].get());
                }
            }
            // A key, counted with its property.
            Ref::Atom(_) => {}
        }
    }

    fn value(&mut self, v: Value) {
        match v {
            Value::Obj(id) => self.see(Ref::Obj(id)),
            Value::Str(s) => self.string(s),
            _ => {}
        }
    }

    fn string(&mut self, s: u32) {
        let i = s as usize;
        if self.strings.get(i) != Some(&false) {
            return;
        }
        self.strings[i] = true;
        let r = self.vm.atoms.sref(s);
        if self.texts.insert((r.s, r.units)) {
            self.bytes += STRING_BYTES + 2 * r.len16() as u64;
        }
    }
}
