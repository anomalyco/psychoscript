//! Iteration in bytecode over an iterator the VM does not step itself: one whose `[Symbol.iterator]`, `next` or
//! `return` is the program's (or a helper's, or the host's). The iteration instruction pushes a native frame (see
//! `native.rs`) that makes the call and hands the result back to the instruction's frame as the instruction would:
//! a value pushed, or for a finished `for...of` a jump to its exit, as a finished generator hands its end back
//! (`Vm::generator_done`). A step that fails forgets the iterator first, so it is not closed afterwards.
//!
//! `yield*` and `for await` do the same: a delegated iterator's `next`, `throw` or `return` of the program's, a
//! delegated generator resumed with a `return` or `throw` request, the sync iterator behind an async-from-sync one
//! (its step's promise settled once the call returns), and an async open or close that calls the program.

use crate::accessors::Got;
use crate::native::{Frame, Input, NativeOp, Step};
use crate::object::*;
use crate::value::{Id, Slot, Value};
use crate::vm::{REQ_RETURN, Reaction, Res, Vm};

/// The steps, by the frame's sub-op.
const OPEN: u16 = 0;
const NEXT: u16 = 1;
const STEP: u16 = 2;
const REST: u16 = 3;
const SPREAD: u16 = 4;
const CLOSE: u16 = 5;
/// A delegated iterator's `next`, `throw` or `return` for `yield*` or `for await`, or an async iterator's `return`
/// closing it, called as native code calls: its result is pushed.
const CALL: u16 = 6;
/// A `yield*` over a generator suspended at a `yield` that gets a `return` or `throw` request: the generator resumed
/// with it, its value pushed and the `DelegateResult` after skipped or left through its exit.
const RESUME: u16 = 7;
/// A step of an async-from-sync iterator (`for await` or an async generator's `yield*` over a sync iterable): the sync
/// iterator's method called or its generator resumed, then the step's promise settled from the result.
const ADAPT: u16 = 8;
/// `GetAsyncIter` over a value whose `[Symbol.asyncIterator]` or `[Symbol.iterator]` is the program's.
const ASYNC_OPEN: u16 = 9;
/// Reads a `next()` result's `done` and `value` for the frame below, calling a program getter among them from a frame
/// (see `read_result`).
const RESULT: u16 = 10;
/// `DelegateCall` or `AsyncClose` over an iterator whose `throw` or `return` is a program getter: called from the
/// frame, then the method it gives taken as the instruction takes one (see `Vm::method_by_call`).
const METHOD: u16 = 11;

// The slots of a `METHOD` frame: the iterator, the method's key, the argument and whether there is one, the request
// (`REQ_*`), whether it closes (`AsyncClose`) and where the instruction goes when the method is missing.
const M_IT: usize = 0;
const M_KEY: usize = 1;
const M_ARG: usize = 2;
const M_HAS_ARG: usize = 3;
const M_KIND: usize = 4;
const M_CLOSE: usize = 5;
const M_MISSING: usize = 6;
/// Whether the frame called the method, whose result it hands to the instruction.
const M_CALLED: usize = 7;

// Slots shared by the steps.
const IT: usize = 0;
const NEXT_FN: usize = 1;
/// The instruction's iterator slot, in its frame.
const SLOT: usize = 2;
/// `for...of`'s exit; for an open or a close, its fuel; for a close, whether it is quiet (`IterCloseQuiet`).
const EXTRA: usize = 3;
/// The values collected so far (an internal array) for a rest element or a spread; for an open, the source.
const OUT: usize = 4;
/// Whether a spread has opened its iterator yet; whether an async open adapts a sync iterator.
const FLAG: usize = 5;

// `FLAG` of a step or spread frame while a program getter it called runs: for the `next()` result's `done` and
// `value` (`RESULT`), or for the iterator's `next`; and of an open or a close, for `next` or `return`.
const READING_RESULT: usize = 2;
const READING_NEXT: usize = 3;
const READING_METHOD: usize = 4;
/// The source's `[Symbol.iterator]`, a program getter, for an open or a spread.
const READING_ITER: usize = 5;

// The slots of a `RESULT` frame: the result, what it reads for (`FOR_ITEM`, `FOR_PARTS`, `FOR_DELEGATE`), which
// getter runs, and for a `DelegateResult` its exit.
const RESULT_OF: usize = 0;
const RESULT_FOR: usize = 1;
const RESULT_AT: usize = 2;
const RESULT_EXIT: usize = 3;
/// The value, `Value::Uninit` when done (`value` is not read then).
const FOR_ITEM: usize = 0;
/// `[value, done]` as an internal array, both read, as `Vm::iter_result_parts` reads them.
const FOR_PARTS: usize = 1;
/// A `DelegateResult` instruction's: the value is pushed and the instruction's frame jumps as the instruction would.
const FOR_DELEGATE: usize = 2;

// More slots of an async open: the instruction's context, for its errors, and whether the frame reads a getter for
// `[Symbol.asyncIterator]` first.
const ASYNC_CTX: usize = 6;
const ASYNC_GETTER: usize = 7;

// The slots of a call (`CALL`): its argument, and whether it has one.
const ARG: usize = 0;
const HAS_ARG: usize = 1;

// The slots of a resumed generator (`RESUME`).
const GEN: usize = 0;
const MODE: usize = 1;
const SENT: usize = 2;

// The slots of an async-from-sync step (`ADAPT`): the step's promise, the sync iterator, the request (`REQ_*`), its
// argument and whether it has one, and how the step goes (`BY_*`).
const MADE: usize = 0;
const SYNC: usize = 1;
const KIND: usize = 2;
const SYNC_ARG: usize = 3;
const SYNC_HAS_ARG: usize = 4;
const HOW: usize = 5;
/// The sync iterator's method called as native code calls it.
pub(crate) const BY_UNCOUNTED: usize = 0;
/// Its `next` called as bytecode calls it.
pub(crate) const BY_COUNTED: usize = 1;
/// The sync iterator, a generator, resumed with `next`.
pub(crate) const BY_RESUME: usize = 2;
/// Its `return` called to close it, as it lacks the `throw` asked for: the promise is rejected after.
pub(crate) const BY_CLOSE: usize = 3;
/// Its result's `done` and `value` read by a `RESULT` frame, as one of them is a program getter.
const READING_PARTS: usize = 4;

impl Vm {
    /// Whether `it`, kept with `next` in an iterator record, is stepped through a call the VM makes for it: anything
    /// but a built-in iterator stepped directly and a generator.
    pub(crate) fn steps_by_call(&self, it: Slot, next: Slot) -> bool {
        let Some(id) = it.obj() else { return false };
        match self.heap[id as usize].kind {
            Kind::ArrayIter { .. }
            | Kind::MapIter { .. }
            | Kind::StrIter { .. }
            | Kind::ListIter { .. } => !next.get().is_nullish(),
            Kind::Generator(_) => false,
            _ => true,
        }
    }

    /// `GetIter` over a value whose `[Symbol.iterator]` the program wrote: checks it as `get_iterator_in` does, then
    /// pushes a frame that calls it. `None` when opening it makes no call.
    pub(crate) fn open_by_call(&mut self, v: &Value, slot: u32, ctx: u8) -> Option<Res> {
        if self.iterator_getter(v) {
            // The getter is called from the frame, which then calls the method it gives.
            if !self.is_iterable(v) {
                return Some(Err(self.not_iterable(v, ctx)));
            }
            let cost = self.open_fuel(v, ctx);
            let slots = [
                Value::Undef,
                Value::Undef,
                Value::Num(slot as f64),
                Value::Num(cost as f64),
                *v,
                Value::Num(READING_ITER as f64),
            ];
            return Some(self.enter_native_with(
                NativeOp::Iteration,
                OPEN,
                Value::Undef,
                Value::Undef,
                &slots,
            ));
        }
        let method = match self.program_iterator_method(v)? {
            Ok(m) => m,
            Err(e) => return Some(Err(e)),
        };
        if !self.is_iterable(v) {
            return Some(Err(self.not_iterable(v, ctx)));
        }
        if !self.is_callable(&method) {
            return Some(Err(self.type_error("Iterator method must be a function.")));
        }
        let cost = self.open_fuel(v, ctx);
        let slots = [
            Value::Undef,
            Value::Undef,
            Value::Num(slot as f64),
            Value::Num(cost as f64),
            *v,
            Value::Undef,
        ];
        Some(self.enter_native_with(NativeOp::Iteration, OPEN, method, Value::Undef, &slots))
    }

    /// Whether opening `v` reads its `[Symbol.iterator]` through a program getter (see `program_iterator_method`).
    pub(crate) fn iterator_getter(&self, v: &Value) -> bool {
        let Value::Obj(id) = v else { return false };
        !self.walks(v) && !self.iterates_itself(*id) && self.has_program_getter(*id, SYM_ITERATOR)
    }

    /// Whether `id` opens as itself, with no `[Symbol.iterator]` of the program's: a generator or a built-in iterator,
    /// and the arguments object while arrays are walked (after, its own `[Symbol.iterator]` is called).
    fn iterates_itself(&self, id: Id) -> bool {
        match self.heap[id as usize].kind {
            Kind::Generator(_) | Kind::ArrayIter { .. } | Kind::StrIter { .. } => true,
            Kind::Arguments(_) => self.arrays_walked,
            _ => false,
        }
    }

    /// The `[Symbol.iterator]` method opening `v` calls, when it is not one the VM runs itself.
    pub(crate) fn program_iterator_method(&mut self, v: &Value) -> Option<Res> {
        let Value::Obj(id) = v else { return None };
        if self.walks(v) || self.iterates_itself(*id) {
            return None;
        }
        if self.has_program_getter(*id, SYM_ITERATOR) {
            return Some(self.get_calling(*id, SYM_ITERATOR));
        }
        let f = self.get_obj(*id, SYM_ITERATOR);
        (!f.is_nullish() && !matches!(&f, Value::Obj(m) if matches!(self.heap[*m as usize].kind, Kind::Native { .. })))
            .then_some(Ok(f))
    }

    /// `IterNext` (`exit` is its jump), `IterStep` (`exit` none) or `IterRest` (`rest`) over an iterator stepped by a
    /// call: pushes the frame that steps it.
    pub(crate) fn step_by_call(
        &mut self,
        it: Slot,
        next: Slot,
        slot: u32,
        exit: Option<u32>,
        rest: bool,
    ) -> Res {
        let sub = match (exit, rest) {
            (_, true) => REST,
            (Some(_), _) => NEXT,
            (None, _) => STEP,
        };
        let out = if rest {
            self.new_array(Vec::new())
        } else {
            Value::Undef
        };
        let exit = Value::Num(exit.unwrap_or(0) as f64);
        let slots = [
            it.get(),
            next.get(),
            Value::Num(slot as f64),
            exit,
            out,
            Value::Undef,
        ];
        self.enter_native_with(NativeOp::Iteration, sub, Value::Undef, Value::Undef, &slots)
    }

    /// `ArraySpread` of a value opened or stepped by a call into the array below it: pushes the frame that does it.
    pub(crate) fn spread_by_call(&mut self, src: Value) -> Option<Res> {
        let Value::Obj(id) = src else { return None };
        if self.walks(&src) || matches!(self.heap[id as usize].kind, Kind::Generator(_)) {
            return None;
        }
        let method = self.get_obj(id, SYM_ITERATOR);
        let native = matches!(&method, Value::Obj(m) if matches!(self.heap[*m as usize].kind, Kind::Native { .. }));
        let stepped_by_call = matches!(
            self.heap[id as usize].kind,
            Kind::IterHelper(_) | Kind::ExoticIter { .. }
        );
        if native && !stepped_by_call && !matches!(self.heap[id as usize].kind, Kind::Ordinary) {
            return None;
        }
        let slots = [
            Value::Undef,
            Value::Undef,
            Value::Num(0.0),
            Value::Num(0.0),
            src,
            Value::Undef,
        ];
        Some(self.enter_native_with(
            NativeOp::Iteration,
            SPREAD,
            Value::Undef,
            Value::Undef,
            &slots,
        ))
    }

    /// `IterClose` or `IterCloseQuiet` of an iterator closed by a call (a generator suspended at a `yield`, or one with
    /// a `return` method that is not the VM's): pushes the frame that closes it. `None` when closing makes no call.
    pub(crate) fn close_by_call(&mut self, it: &Value, quiet: bool) -> Option<Res> {
        let Value::Obj(id) = it else { return None };
        let call = match &self.heap[*id as usize].kind {
            Kind::Generator(GenState::Suspended(_)) => true,
            Kind::Generator(_)
            | Kind::ArrayIter { .. }
            | Kind::MapIter { .. }
            | Kind::StrIter { .. }
            | Kind::ListIter { .. } => false,
            _ => {
                let rk = self.names.return_;
                let f = self.get_obj(*id, rk);
                // A getter is called from the frame, which closes as `iter_close` would with what it gives.
                self.is_callable(&f) || self.has_program_getter(*id, rk)
            }
        };
        if !call {
            return None;
        }
        let cost = self.close_fuel(it);
        let slots = [
            *it,
            Value::Undef,
            Value::Num(0.0),
            Value::Num(cost as f64),
            Value::Bool(quiet),
            Value::Undef,
        ];
        Some(self.enter_native_with(
            NativeOp::Iteration,
            CLOSE,
            Value::Undef,
            Value::Undef,
            &slots,
        ))
    }

    /// Whether calling `f` runs code of the program's (or a bound function or namespace path over it), which a frame
    /// calls; a native is called at once.
    pub(crate) fn calls_program(&self, f: &Value) -> bool {
        matches!(f, Value::Obj(id) if self.heap[*id as usize].is_callable()
            && !matches!(self.heap[*id as usize].kind, Kind::Native { .. }))
    }

    /// `DelegateCall` or `AsyncClose` calling the iterator's method `m` (see `calls_program`) on `it`, with `arg` if
    /// any: pushes the frame that calls it and pushes its result for the instruction.
    pub(crate) fn delegate_by_call(&mut self, m: Value, it: Value, arg: Option<Value>) -> Res {
        let slots = [arg.unwrap_or_default(), Value::Bool(arg.is_some())];
        self.enter_native_with(NativeOp::Iteration, CALL, m, it, &slots)
    }

    /// `DelegateCall` with a `return` (`mode` 1) or `throw` (2) request for the suspended generator `g`: pushes the
    /// frame that resumes it.
    pub(crate) fn resume_delegate_by_frame(&mut self, g: Id, mode: u8, sent: Value) -> Res {
        let slots = [Value::Obj(g), Value::Num(mode as f64), sent];
        self.enter_native_with(
            NativeOp::Iteration,
            RESUME,
            Value::Undef,
            Value::Undef,
            &slots,
        )
    }

    /// A step of an async-from-sync iterator over `sync` that calls the program or resumes a generator (`how` is one
    /// of `BY_*`; `m` the method to call): pushes the frame that takes it and settles `made` after.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn adapt_by_frame(
        &mut self,
        how: usize,
        made: Id,
        sync: Id,
        kind: u8,
        arg: Option<Value>,
        m: Value,
    ) -> Res {
        let slots = [
            Value::Obj(made),
            Value::Obj(sync),
            Value::Num(kind as f64),
            arg.unwrap_or_default(),
            Value::Bool(arg.is_some()),
            Value::Num(how as f64),
        ];
        self.enter_native_with(NativeOp::Iteration, ADAPT, m, Value::Undef, &slots)
    }

    /// Settles the promise `made` of an async-from-sync step from the sync iterator's answer: with the value once it
    /// resolved (closing the iterator if that fails and it is not done), or rejected with what the step threw.
    pub(crate) fn settle_from_sync(
        &mut self,
        made: Id,
        sync: Id,
        kind: u8,
        step: Result<(Value, bool), Value>,
    ) -> Result<(), Value> {
        match step {
            Ok((v, done)) => {
                let close = (kind != REQ_RETURN && !done).then_some(sync);
                let w = self.promise_resolve(v);
                self.perform_then(w, Reaction::FromSync { made, done, close });
            }
            Err(e) => {
                if self.fatal.is_some() {
                    return Err(e);
                }
                self.reject(made, e);
            }
        }
        Ok(())
    }

    /// `GetAsyncIter` opening `v` with the program's `method`: its `[Symbol.asyncIterator]`, or with `sync_open` (the
    /// open's fuel) its `[Symbol.iterator]`, whose iterator is adapted. Pushes the frame that calls it and writes the
    /// instruction's iterator record.
    pub(crate) fn open_async_by_call(
        &mut self,
        method: Value,
        v: Value,
        slot: u32,
        sync_open: Option<i32>,
    ) -> Res {
        let slots = [
            Value::Undef,
            Value::Undef,
            Value::Num(slot as f64),
            Value::Num(sync_open.unwrap_or(0) as f64),
            v,
            Value::Bool(sync_open.is_some()),
            Value::Num(0.0),
            Value::Bool(false),
        ];
        self.enter_native_with(NativeOp::Iteration, ASYNC_OPEN, method, v, &slots)
    }

    /// `GetAsyncIter` over a value whose `[Symbol.asyncIterator]` is a program getter: the frame calls it, then opens
    /// with what it gives as `Vm::get_async_iterator` does, and writes the instruction's iterator record.
    pub(crate) fn open_async_by_getter(&mut self, v: Value, slot: u32, ctx: u8) -> Res {
        let slots = [
            Value::Undef,
            Value::Undef,
            Value::Num(slot as f64),
            Value::Num(0.0),
            v,
            Value::Bool(false),
            Value::Num(ctx as f64),
            Value::Bool(true),
        ];
        self.enter_native_with(NativeOp::Iteration, ASYNC_OPEN, Value::Undef, v, &slots)
    }
}

/// The step of an iteration frame.
pub(crate) fn step(vm: &mut Vm, sub: u16, fr: Frame, input: Input) -> Result<Step, Value> {
    match sub {
        OPEN => open_step(vm, fr, input),
        NEXT | STEP | REST => next_step(vm, sub, fr, input),
        SPREAD => spread_step(vm, fr, input),
        CLOSE => close_step(vm, fr, input),
        CALL => call_step(vm, fr, input),
        RESUME => resume_step(vm, fr, input),
        ADAPT => adapt_step(vm, fr, input),
        ASYNC_OPEN => async_open_step(vm, fr, input),
        RESULT => result_step(vm, fr, input),
        METHOD => method_step(vm, fr, input),
        _ => Ok(Step::Done(Value::Undef)),
    }
}

/// The frame below the iteration frame: the instruction's.
fn caller(vm: &Vm) -> usize {
    vm.frames.len().saturating_sub(2)
}

/// Writes the instruction's iterator slot (and the slot after it, its record's `next`).
fn set_caller_slot(vm: &mut Vm, fr: Frame, k: usize, v: Slot) {
    let c = caller(vm);
    let at = vm.frames[c].base + fr.index(vm, SLOT) + k;
    if let Some(s) = vm.stack.get_mut(at) {
        *s = v;
    }
}

fn open_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    match input {
        Input::Start if fr.index(vm, FLAG) == READING_ITER => {
            let src = fr.get(vm, OUT);
            match vm.get_stepping_value(&src, SYM_ITERATOR)? {
                Got::Value(m) => open_method(vm, fr, m),
                Got::Call(step) => Ok(step),
            }
        }
        Input::Start => {
            let (f, src) = (fr.callee(vm), fr.slot(vm, OUT));
            fr.call_slots_as(vm, f, src, [], Step::CallUncounted)
        }
        Input::Returned(m) if fr.index(vm, FLAG) == READING_ITER => open_method(vm, fr, m.get()),
        Input::Returned(r) => {
            let (it, next) = if fr.index(vm, FLAG) == READING_METHOD {
                (fr.get(vm, IT), r.get())
            } else {
                let it = r.get();
                let Value::Obj(id) = it else {
                    return Err(vm.type_error("Iterator method result must be an object."));
                };
                let nk = vm.names.next;
                match vm.get_stepping(id, nk)? {
                    Got::Value(next) => (it, next),
                    Got::Call(step) => {
                        fr.set(vm, IT, it);
                        fr.set_index(vm, FLAG, READING_METHOD);
                        return Ok(step);
                    }
                }
            };
            if !vm.is_callable(&next) {
                return Err(vm.type_error("Iterator next must be a function."));
            }
            vm.fuel(fr.index(vm, EXTRA) as i32);
            let src = fr.get(vm, OUT);
            let next = vm.record_next_read(&src, &it, next)?;
            set_caller_slot(vm, fr, 0, Slot::pack(it));
            set_caller_slot(vm, fr, 1, Slot::pack(next));
            Ok(Step::DoneEmpty)
        }
        Input::Threw(e) => Err(e),
        Input::Finished(_) => Ok(Step::DoneEmpty),
    }
}

/// An open's `[Symbol.iterator]` method, read through a getter: called as the open calls one it read itself.
fn open_method(vm: &mut Vm, fr: Frame, method: Value) -> Result<Step, Value> {
    fr.set_index(vm, FLAG, 0);
    if !vm.is_callable(&method) {
        return Err(vm.type_error("Iterator method must be a function."));
    }
    let src = fr.slot(vm, OUT);
    fr.call_slots_as(vm, Slot::pack(method), src, [], Step::CallUncounted)
}

/// Calls the iterator's `next` as `Vm::iter_step_with` does: the VM's own iterators and helpers without a native's
/// fifty, any other as bytecode calls it. A throw comes back to the frame, which forgets the iterator.
fn call_next(vm: &mut Vm, fr: Frame, it: Slot, next: Slot) -> Result<Step, Value> {
    let id = it.obj().unwrap_or(0);
    let direct = next.get().is_nullish();
    let f = if direct {
        let nk = vm.names.next;
        match vm.get_stepping(id, nk)? {
            Got::Value(f) => Slot::pack(f),
            Got::Call(step) => {
                fr.set_index(vm, FLAG, READING_NEXT);
                return Ok(step);
            }
        }
    } else {
        next
    };
    call_next_with(vm, fr, it, f, direct)
}

/// `call_next` once `next` is read.
fn call_next_with(vm: &mut Vm, fr: Frame, it: Slot, f: Slot, direct: bool) -> Result<Step, Value> {
    let id = it.obj().unwrap_or(0);
    let uncounted = match vm.heap[id as usize].kind {
        Kind::IterHelper(_) => true,
        Kind::ExoticIter { .. } => direct,
        _ => false,
    };
    let sp = (vm.stack.len() - fr.base()) as u32;
    vm.handlers_mut().push(crate::vm::Handler {
        pc: crate::native::THREW as u32,
        sp,
    });
    let mode = if uncounted {
        Step::CallUncounted
    } else {
        Step::Call
    };
    fr.call_slots_as(vm, f, it, [], mode)
}

/// What a `next()` result says: its value, or `None` when done. When `done` or `value` is a program getter, a
/// `RESULT` frame reads them instead, calling it from a frame: `Err` has the step to return, and the caller's next
/// input is the value, or `Value::Uninit` when done (see `item_of`). With `catching`, what that frame throws comes back
/// to the caller `catching` as `Input::Threw`.
pub(crate) fn read_result(
    vm: &mut Vm,
    r: Slot,
    catching: Option<Frame>,
) -> Result<Result<Option<Value>, Step>, Value> {
    let Some(rid) = r.obj() else {
        return Err(vm.type_error("Iterator next() result must be an object."));
    };
    let (dk, vk) = (vm.names.done, vm.names.value);
    if vm.has_program_getter(rid, dk) || vm.has_program_getter(rid, vk) {
        if let Some(fr) = catching {
            let sp = (vm.stack.len() - fr.base()) as u32;
            vm.handlers_mut().push(crate::vm::Handler {
                pc: crate::native::THREW as u32,
                sp,
            });
        }
        vm.enter_native_with(
            NativeOp::Iteration,
            RESULT,
            Value::Undef,
            Value::Undef,
            &[
                r.get(),
                Value::Num(FOR_ITEM as f64),
                Value::Num(0.0),
                Value::Undef,
            ],
        )?;
        // Pushed by a step, not by a built-in's call.
        vm.entered = false;
        return Ok(Err(Step::Pushed));
    }
    let d = vm.get_obj(rid, dk);
    if vm.truthy(&d) {
        return Ok(Ok(None));
    }
    Ok(Ok(Some(vm.get_obj(rid, vk))))
}

/// What a `RESULT` frame gave: the value, or `None` when done.
pub(crate) fn item_of(r: Slot) -> Option<Value> {
    match r.get() {
        Value::Uninit => None,
        v => Some(v),
    }
}

/// `iter_result_parts` of a result whose `done` or `value` is a program getter: a `RESULT` frame reads them and
/// gives `[value, done]` as an internal array (see `parts_of`), what it throws coming back to `catching` as
/// `Input::Threw`. `None` when reading them calls nothing.
pub(crate) fn read_parts(vm: &mut Vm, r: &Value, catching: Frame) -> Result<Option<Step>, Value> {
    if !reads_by_call(vm, r) {
        return Ok(None);
    }
    let sp = (vm.stack.len() - catching.base()) as u32;
    vm.handlers_mut().push(crate::vm::Handler {
        pc: crate::native::THREW as u32,
        sp,
    });
    vm.enter_native_with(
        NativeOp::Iteration,
        RESULT,
        Value::Undef,
        Value::Undef,
        &[
            *r,
            Value::Num(FOR_PARTS as f64),
            Value::Num(0.0),
            Value::Undef,
        ],
    )?;
    vm.entered = false;
    Ok(Some(Step::Pushed))
}

/// A `METHOD` frame: the getter called, then the method it gave taken as `Vm::delegate_call` or `Vm::async_close`
/// takes one.
fn method_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    let it = fr.get(vm, M_IT);
    let m = match input {
        Input::Start => {
            let key = match fr.get(vm, M_KEY) {
                Value::Sym(s) => s,
                k => vm.key_of(&k)?,
            };
            match vm.get_stepping_value(&it, key)? {
                Got::Value(m) => m,
                Got::Call(step) => return Ok(step),
            }
        }
        Input::Returned(r) if fr.index(vm, M_CALLED) == 1 => return Ok(Step::Done(r.get())),
        Input::Returned(m) => m.get(),
        Input::Threw(e) => return Err(e),
        Input::Finished(r) => return Ok(Step::Done(r.get())),
    };
    let close = matches!(fr.get(vm, M_CLOSE), Value::Bool(true));
    let kind = fr.index(vm, M_KIND) as u8;
    let arg = matches!(fr.get(vm, M_HAS_ARG), Value::Bool(true)).then(|| fr.get(vm, M_ARG));
    if m.is_nullish() {
        // As the instruction does with no method: on to where it goes then, a delegation with what it received.
        let missing = fr.index(vm, M_MISSING);
        let c = caller(vm);
        vm.frames[c].pc = missing;
        return Ok(if close {
            Step::DoneEmpty
        } else {
            Step::Done(arg.unwrap_or_default())
        });
    }
    if !vm.is_callable(&m) {
        let name = vm.request_name(kind);
        let name = vm.atoms.text(name).to_owned();
        return Err(vm.type_error(&format!("Iterator {name} must be a function.")));
    }
    if vm.calls_program(&m) {
        fr.set_index(vm, M_CALLED, 1);
        // As `delegate_by_call`'s frame calls it.
        let mode = Step::CallUncounted;
        return Ok(match arg {
            Some(a) => {
                vm.stack
                    .extend_from_slice(&[Slot::pack(m), Slot::pack(it), Slot::pack(a)]);
                mode(1)
            }
            None => {
                vm.stack.extend_from_slice(&[Slot::pack(m), Slot::pack(it)]);
                mode(0)
            }
        });
    }
    let args: &[Value] = match &arg {
        Some(a) => std::slice::from_ref(a),
        None => &[],
    };
    // A native: `AsyncClose` calls it as bytecode does, a delegation for fifty first.
    let r = if close {
        vm.call_counted(&m, it, args)?
    } else {
        vm.fuel(crate::vm::NATIVE_FUEL);
        vm.call(&m, it, args)?
    };
    Ok(Step::Done(r))
}

impl Vm {
    /// `DelegateCall` (`close` false) or `AsyncClose` reading the iterator's method `key` through a program getter:
    /// pushes the `METHOD` frame that calls it; the caller sees `Vm::entered`. `None` when it is no program getter.
    pub(crate) fn method_by_call(
        &mut self,
        it: Value,
        key: Atom,
        kind: u8,
        arg: Option<Value>,
        close: bool,
        missing: u32,
    ) -> Option<Res> {
        let Value::Obj(id) = it else { return None };
        if !self.has_program_getter(id, key) {
            return None;
        }
        let slots = [
            it,
            crate::conversion::key_value(self, key),
            arg.unwrap_or_default(),
            Value::Bool(arg.is_some()),
            Value::Num(kind as f64),
            Value::Bool(close),
            Value::Num(missing as f64),
            Value::Num(0.0),
        ];
        Some(self.enter_native_with(
            NativeOp::Iteration,
            METHOD,
            Value::Undef,
            Value::Undef,
            &slots,
        ))
    }
}

/// Whether reading a result's `done` and `value` calls a program getter.
fn reads_by_call(vm: &Vm, r: &Value) -> bool {
    let Value::Obj(rid) = *r else { return false };
    let (dk, vk) = (vm.names.done, vm.names.value);
    vm.has_program_getter(rid, dk) || vm.has_program_getter(rid, vk)
}

impl Vm {
    /// `DelegateResult` over a result whose `done` or `value` is a program getter: pushes the `RESULT` frame that
    /// reads them, pushes the value and jumps for the instruction (to `exit` when done, else on from `pc`, where the
    /// instruction's frame was left). `None` when reading them calls nothing.
    pub(crate) fn delegate_result_by_call(&mut self, r: &Value, exit: u32) -> Option<Res> {
        if !reads_by_call(self, r) {
            return None;
        }
        let slots = [
            *r,
            Value::Num(FOR_DELEGATE as f64),
            Value::Num(0.0),
            Value::Num(exit as f64),
        ];
        Some(self.enter_native_with(
            NativeOp::Iteration,
            RESULT,
            Value::Undef,
            Value::Undef,
            &slots,
        ))
    }
}

/// The value and done flag of a `RESULT` frame that read both.
pub(crate) fn parts_of(vm: &Vm, r: Slot) -> (Value, bool) {
    match r.obj().map(|id| &vm.heap[id as usize].kind) {
        Some(Kind::Array(items)) if items.len() == 2 => {
            (items[0], matches!(items[1], Value::Bool(true)))
        }
        _ => (Value::Undef, true),
    }
}

/// A `RESULT` frame: `done`, then `value` (not when done, unless it reads both), each getter called from a frame.
fn result_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    let rid = fr.slot(vm, RESULT_OF).obj().unwrap_or(0);
    let both = fr.index(vm, RESULT_FOR) != FOR_ITEM;
    let (dk, vk) = (vm.names.done, vm.names.value);
    let d = match input {
        Input::Start => match vm.get_stepping(rid, dk)? {
            Got::Value(d) => d,
            Got::Call(step) => return Ok(step),
        },
        Input::Returned(d) if fr.index(vm, RESULT_AT) == 0 => d.get(),
        Input::Returned(v) => return Ok(Step::Done(result_done(vm, fr, v.get(), both))),
        Input::Threw(e) => return Err(e),
        Input::Finished(_) => Value::Undef,
    };
    let done = vm.truthy(&d);
    if done && !both {
        return Ok(Step::Done(Value::Uninit));
    }
    // The done flag is kept where the step looks for which getter runs: 1 not done, 2 done.
    fr.set_index(vm, RESULT_AT, 1 + usize::from(done));
    match vm.get_stepping(rid, vk)? {
        Got::Value(v) => Ok(Step::Done(result_done(vm, fr, v, both))),
        Got::Call(step) => Ok(step),
    }
}

fn result_done(vm: &mut Vm, fr: Frame, v: Value, both: bool) -> Value {
    if !both {
        return v;
    }
    let done = fr.index(vm, RESULT_AT) == 2;
    if fr.index(vm, RESULT_FOR) == FOR_DELEGATE {
        let (c, exit) = (caller(vm), fr.index(vm, RESULT_EXIT));
        let f = &mut vm.frames[c];
        f.pc = if done {
            exit
        } else {
            crate::vm::delegate_continue(&f.func.code, f.pc)
        };
        return v;
    }
    vm.new_array(vec![v, Value::Bool(done)])
}

fn next_step(vm: &mut Vm, sub: u16, fr: Frame, input: Input) -> Result<Step, Value> {
    let (it, next) = (fr.slot(vm, IT), fr.slot(vm, NEXT_FN));
    let reading = fr.index(vm, FLAG);
    fr.set_index(vm, FLAG, 0);
    let got = match input {
        Input::Start => return call_next(vm, fr, it, next),
        Input::Returned(f) if reading == READING_NEXT => {
            return call_next_with(vm, fr, it, f, next.get().is_nullish());
        }
        Input::Returned(r) if reading == READING_RESULT => Ok(item_of(r)),
        // What a failing read throws comes back here, as a failing `next` does.
        Input::Returned(r) => match read_result(vm, r, Some(fr)) {
            Ok(Ok(got)) => Ok(got),
            Ok(Err(step)) => {
                fr.set_index(vm, FLAG, READING_RESULT);
                return Ok(step);
            }
            Err(e) => Err(e),
        },
        Input::Threw(e) => Err(e),
        Input::Finished(_) => Ok(None),
    };
    let got = match got {
        Ok(g) => g,
        Err(e) => {
            set_caller_slot(vm, fr, 0, Slot::UNDEF);
            return Err(e);
        }
    };
    match (sub, got) {
        (REST, Some(v)) => {
            let out = fr.slot(vm, OUT).obj().unwrap_or(0);
            if let Kind::Array(items) = &mut vm.heap[out as usize].kind {
                items.push(v);
            }
            call_next(vm, fr, it, next)
        }
        (REST, None) => {
            set_caller_slot(vm, fr, 0, Slot::UNDEF);
            Ok(Step::Done(fr.get(vm, OUT)))
        }
        (_, Some(v)) => Ok(Step::Done(v)),
        (NEXT, None) => {
            set_caller_slot(vm, fr, 0, Slot::UNDEF);
            let c = caller(vm);
            vm.frames[c].pc = fr.index(vm, EXTRA);
            Ok(Step::DoneEmpty)
        }
        (_, None) => {
            set_caller_slot(vm, fr, 0, Slot::UNDEF);
            Ok(Step::Done(Value::Undef))
        }
    }
}

/// A spread: opened as `iterate_to_vec` opens it, then stepped to its end, its values appended to the array below.
fn spread_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    match input {
        Input::Returned(m) if fr.index(vm, FLAG) == READING_ITER => {
            fr.set_index(vm, FLAG, 0);
            return spread_open(vm, fr, m.get());
        }
        Input::Start => {
            let src = fr.get(vm, OUT);
            if vm.iterator_getter(&src) {
                match vm.get_stepping_value(&src, SYM_ITERATOR)? {
                    Got::Value(m) => return spread_open(vm, fr, m),
                    Got::Call(step) => {
                        fr.set_index(vm, FLAG, READING_ITER);
                        return Ok(step);
                    }
                }
            }
            if let Some(method) = vm.program_iterator_method(&src) {
                let method = method?;
                if !vm.is_callable(&method) {
                    return Err(vm.type_error("Iterator method must be a function."));
                }
                fr.set_index(vm, FLAG, 1);
                return fr.call_slots_as(
                    vm,
                    Slot::pack(method),
                    Slot::pack(src),
                    [],
                    Step::CallUncounted,
                );
            }
            let it = vm.get_iterator(&src)?;
            let next = vm.record_next_of(&src, &it)?;
            fr.set(vm, IT, it);
            fr.set(vm, NEXT_FN, next);
            let out = vm.new_array(Vec::new());
            fr.set(vm, OUT, out);
        }
        Input::Returned(r) if matches!(fr.index(vm, FLAG), 1 | READING_METHOD) => {
            // The opening call returned the iterator, then its `next` was read.
            let (it, next) = if fr.index(vm, FLAG) == READING_METHOD {
                (fr.get(vm, IT), r.get())
            } else {
                let it = r.get();
                let Value::Obj(id) = it else {
                    return Err(vm.type_error("Iterator method result must be an object."));
                };
                let nk = vm.names.next;
                match vm.get_stepping(id, nk)? {
                    Got::Value(next) => (it, next),
                    Got::Call(step) => {
                        fr.set(vm, IT, it);
                        fr.set_index(vm, FLAG, READING_METHOD);
                        return Ok(step);
                    }
                }
            };
            if !vm.is_callable(&next) {
                return Err(vm.type_error("Iterator next must be a function."));
            }
            let src = fr.get(vm, OUT);
            let next = vm.record_next_read(&src, &it, next)?;
            fr.set(vm, IT, it);
            fr.set(vm, NEXT_FN, next);
            fr.set_index(vm, FLAG, 0);
            let out = vm.new_array(Vec::new());
            fr.set(vm, OUT, out);
        }
        Input::Returned(f) if fr.index(vm, FLAG) == READING_NEXT => {
            fr.set_index(vm, FLAG, 0);
            let (it, next) = (fr.slot(vm, IT), fr.get(vm, NEXT_FN));
            return spread_call(vm, fr, it, f, next.is_nullish());
        }
        Input::Returned(r) => match spread_result(vm, fr, r)? {
            Err(step) => return Ok(step),
            Ok(Some(v)) => {
                let out = fr.slot(vm, OUT).obj().unwrap_or(0);
                if let Kind::Array(items) = &mut vm.heap[out as usize].kind {
                    if items.len() >= crate::ops::MAX_ARRAY_LEN {
                        return Err(vm.range_error("Invalid array length"));
                    }
                    items.push(v);
                }
            }
            Ok(None) => return spread_done(vm, fr),
        },
        Input::Threw(e) => return Err(e),
        Input::Finished(_) => return spread_done(vm, fr),
    }
    let (it, next) = (fr.slot(vm, IT), fr.slot(vm, NEXT_FN));
    if !vm.steps_by_call(it, next) {
        // The VM steps it itself after all: the rest of it at once.
        let (itv, nextv) = (it.get(), next.get());
        let out = fr.slot(vm, OUT).obj().unwrap_or(0);
        while let Some(v) = vm.iter_step_with(&itv, nextv)? {
            if let Kind::Array(items) = &mut vm.heap[out as usize].kind {
                if items.len() >= crate::ops::MAX_ARRAY_LEN {
                    return Err(vm.range_error("Invalid array length"));
                }
                items.push(v);
            }
        }
        return spread_done(vm, fr);
    }
    let id = it.obj().unwrap_or(0);
    let direct = next.get().is_nullish();
    let f = if direct {
        let nk = vm.names.next;
        match vm.get_stepping(id, nk)? {
            Got::Value(f) => Slot::pack(f),
            Got::Call(step) => {
                fr.set_index(vm, FLAG, READING_NEXT);
                return Ok(step);
            }
        }
    } else {
        next
    };
    spread_call(vm, fr, it, f, direct)
}

/// A spread's `[Symbol.iterator]` method, read through a getter: called as one read without.
fn spread_open(vm: &mut Vm, fr: Frame, method: Value) -> Result<Step, Value> {
    if !vm.is_callable(&method) {
        return Err(vm.type_error("Iterator method must be a function."));
    }
    fr.set_index(vm, FLAG, 1);
    let src = fr.slot(vm, OUT);
    fr.call_slots_as(vm, Slot::pack(method), src, [], Step::CallUncounted)
}

/// A spread's call of its iterator's `next`, once read.
fn spread_call(vm: &mut Vm, fr: Frame, it: Slot, f: Slot, direct: bool) -> Result<Step, Value> {
    let id = it.obj().unwrap_or(0);
    let uncounted = match vm.heap[id as usize].kind {
        Kind::IterHelper(_) => true,
        Kind::ExoticIter { .. } => direct,
        _ => false,
    };
    let mode = if uncounted {
        Step::CallUncounted
    } else {
        Step::Call
    };
    fr.call_slots_as(vm, f, it, [], mode)
}

/// What a spread's `next()` result says (see `read_result`), the value a `RESULT` frame gave it included.
fn spread_result(vm: &mut Vm, fr: Frame, r: Slot) -> Result<Result<Option<Value>, Step>, Value> {
    if fr.index(vm, FLAG) == READING_RESULT {
        fr.set_index(vm, FLAG, 0);
        return Ok(Ok(item_of(r)));
    }
    let got = read_result(vm, r, None)?;
    if got.is_err() {
        fr.set_index(vm, FLAG, READING_RESULT);
    }
    Ok(got)
}

/// Appends a spread's values to the array below the frame's callee and receiver.
fn spread_done(vm: &mut Vm, fr: Frame) -> Result<Step, Value> {
    let items = match fr
        .slot(vm, OUT)
        .obj()
        .map(|o| &mut vm.heap[o as usize].kind)
    {
        Some(Kind::Array(items)) => std::mem::take(items),
        _ => Vec::new(),
    };
    let target = vm.stack[fr.base() - 3].obj();
    if let Some(Kind::Array(arr)) = target.map(|t: Id| &mut vm.heap[t as usize].kind) {
        arr.extend(items);
    }
    Ok(Step::DoneEmpty)
}

/// A close: the generator resumed with a return, or the iterator's `return` called as native code calls it; then its
/// fuel. A quiet close ignores how it went; a plain one throws what it threw, after the fuel.
fn close_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    let it = fr.get(vm, IT);
    let quiet = matches!(fr.get(vm, OUT), Value::Bool(true));
    let outcome = match input {
        Input::Start => {
            let Value::Obj(id) = it else {
                return Ok(Step::DoneEmpty);
            };
            if matches!(vm.heap[id as usize].kind, Kind::Generator(_)) {
                let sp = (vm.stack.len() - fr.base()) as u32;
                vm.handlers_mut().push(crate::vm::Handler {
                    pc: crate::native::THREW as u32,
                    sp,
                });
                return match vm.native_resume(id, 1, Value::Undef) {
                    Ok(None) => Ok(Step::Pushed),
                    Ok(Some(_)) => close_done(vm, fr, Ok(()), quiet),
                    Err(e) => close_done(vm, fr, Err(e), quiet),
                };
            }
            let rk = vm.names.return_;
            let sp = (vm.stack.len() - fr.base()) as u32;
            let f = match vm.get_stepping(id, rk)? {
                Got::Value(f) => f,
                Got::Call(step) => {
                    // What the getter throws closes as a failing `return` does: quietly, or thrown after the fuel.
                    vm.handlers_mut().push(crate::vm::Handler {
                        pc: crate::native::THREW as u32,
                        sp,
                    });
                    fr.set_index(vm, FLAG, READING_METHOD);
                    return Ok(step);
                }
            };
            return close_call(vm, fr, it, f, quiet);
        }
        Input::Returned(f) if fr.index(vm, FLAG) == READING_METHOD => {
            fr.set_index(vm, FLAG, 0);
            return close_call(vm, fr, it, f.get(), quiet);
        }
        Input::Returned(r) => {
            let generator = matches!(it, Value::Obj(id) if matches!(vm.heap[id as usize].kind, Kind::Generator(_)));
            if !generator && r.obj().is_none() {
                Err(vm.type_error("Iterator return() result must be an object."))
            } else {
                Ok(())
            }
        }
        Input::Threw(e) => Err(e),
        Input::Finished(_) => Ok(()),
    };
    close_done(vm, fr, outcome, quiet)
}

/// A close's call of the iterator's `return`, once read: none to call closes it as `Vm::iter_close` does.
fn close_call(vm: &mut Vm, fr: Frame, it: Value, f: Value, quiet: bool) -> Result<Step, Value> {
    if f.is_nullish() {
        return close_done(vm, fr, Ok(()), quiet);
    }
    if !vm.is_callable(&f) {
        let e = vm.type_error("Iterator return must be a function.");
        return close_done(vm, fr, Err(e), quiet);
    }
    let sp = (vm.stack.len() - fr.base()) as u32;
    vm.handlers_mut().push(crate::vm::Handler {
        pc: crate::native::THREW as u32,
        sp,
    });
    fr.call_slots_as(vm, Slot::pack(f), Slot::pack(it), [], Step::CallUncounted)
}

fn close_done(
    vm: &mut Vm,
    fr: Frame,
    outcome: Result<(), Value>,
    quiet: bool,
) -> Result<Step, Value> {
    vm.fuel(fr.index(vm, EXTRA) as i32);
    match outcome {
        Err(e) if !quiet || vm.fatal.is_some() => Err(e),
        _ => Ok(Step::DoneEmpty),
    }
}

/// Calls the frame's callee on its receiver, with its argument if it has one, as `mode` asks. A closure costs the
/// same either way, so its frame is pushed at once.
fn call_with_arg(
    vm: &mut Vm,
    fr: Frame,
    this: Slot,
    arg: Option<Slot>,
    mode: fn(usize) -> Step,
) -> Result<Step, Value> {
    let f = fr.callee(vm);
    if f.obj()
        .is_some_and(|id| matches!(vm.heap[id as usize].kind, Kind::Closure(_)))
    {
        return match arg {
            Some(a) => fr.call_slots(vm, f, this, [a]),
            None => fr.call_slots(vm, f, this, []),
        };
    }
    match arg {
        Some(a) => fr.call_slots_as(vm, f, this, [a], mode),
        None => fr.call_slots_as(vm, f, this, [], mode),
    }
}

/// A delegated iterator's method: its result goes to the instruction as it is.
fn call_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    match input {
        Input::Start => {
            let arg = matches!(fr.get(vm, HAS_ARG), Value::Bool(true)).then(|| fr.slot(vm, ARG));
            let this = fr.this_slot(vm);
            call_with_arg(vm, fr, this, arg, Step::CallUncounted)
        }
        Input::Returned(r) | Input::Finished(r) => Ok(Step::Done(r.get())),
        Input::Threw(e) => Err(e),
    }
}

/// A delegated generator resumed with a `return` or `throw` request: what it yields or returns goes to the
/// instruction as a value and a done flag, as `Vm::sync_delegate_step` hands them over.
fn resume_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    let (v, done) = match input {
        Input::Start => {
            let g = fr.slot(vm, GEN).obj().unwrap_or(0);
            let (mode, sent) = (fr.index(vm, MODE) as u8, fr.get(vm, SENT));
            match crate::builtins::collections::resume_catching(vm, fr, g, mode, sent)? {
                None => return Ok(Step::Pushed),
                Some(step) => step,
            }
        }
        Input::Returned(r) => (r.get(), false),
        Input::Finished(r) => (r.get(), true),
        Input::Threw(e) => return Err(e),
    };
    // The value is pushed; a done one leaves through the following `DelegateResult`'s exit, else it is skipped.
    let c = caller(vm);
    let f = &mut vm.frames[c];
    f.pc = match f.func.code.get(f.pc) {
        Some(crate::bytecode::Op::DelegateResult(exit, _)) if done => *exit as usize,
        _ => crate::vm::delegate_continue(&f.func.code, f.pc + 1),
    };
    Ok(Step::Done(v))
}

/// An async-from-sync step: the sync iterator's answer, or what its step threw, settles the step's promise, which
/// goes to the instruction.
fn adapt_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    let how = fr.index(vm, HOW);
    let made = fr.slot(vm, MADE).obj().unwrap_or(0);
    let sync = fr.slot(vm, SYNC).obj().unwrap_or(0);
    let kind = fr.index(vm, KIND) as u8;
    let step = match input {
        Input::Start if how == BY_RESUME => {
            let arg = fr.get(vm, SYNC_ARG);
            match crate::builtins::collections::resume_catching(vm, fr, sync, 0, arg) {
                Ok(None) => return Ok(Step::Pushed),
                Ok(Some(step)) => Ok(step),
                Err(e) => Err(e),
            }
        }
        Input::Start => {
            let sp = (vm.stack.len() - fr.base()) as u32;
            vm.handlers_mut().push(crate::vm::Handler {
                pc: crate::native::THREW as u32,
                sp,
            });
            let arg = matches!(fr.get(vm, SYNC_HAS_ARG), Value::Bool(true))
                .then(|| fr.slot(vm, SYNC_ARG));
            let mode = if how == BY_COUNTED {
                Step::Call
            } else {
                Step::CallUncounted
            };
            return call_with_arg(vm, fr, fr.slot(vm, SYNC), arg, mode);
        }
        Input::Returned(r) if how == READING_PARTS => Ok(parts_of(vm, r)),
        Input::Returned(r) => match how {
            BY_RESUME => Ok((r.get(), false)),
            BY_CLOSE if r.obj().is_none() => {
                Err(vm.type_error("Iterator return() result must be an object."))
            }
            BY_CLOSE => {
                Err(vm.type_error("The delegated iterator does not provide a throw() method."))
            }
            _ => match read_parts(vm, &r.get(), fr) {
                Ok(Some(step)) => {
                    fr.set_index(vm, HOW, READING_PARTS);
                    return Ok(step);
                }
                Ok(None) => vm.iter_result_parts(&r.get(), kind),
                Err(e) => Err(e),
            },
        },
        Input::Finished(r) => Ok((r.get(), true)),
        Input::Threw(e) => Err(e),
    };
    if how == BY_CLOSE {
        // Closing ends in a rejection either way: with what it threw, or for the missing `throw`.
        if let Err(e) = step {
            vm.reject(made, e);
        }
        return Ok(Step::Done(Value::Obj(made)));
    }
    vm.settle_from_sync(made, sync, kind, step)?;
    Ok(Step::Done(Value::Obj(made)))
}

/// An async open with the `[Symbol.asyncIterator]` a getter gave: a method of the program's called from the frame,
/// any other opening at once as `Vm::get_async_iterator` opens.
fn async_open_with(vm: &mut Vm, fr: Frame, src: Value, f: Value) -> Result<Step, Value> {
    let (method, sync) = if f.is_nullish() {
        let ctx = fr.index(vm, ASYNC_CTX) as u8;
        match vm.open_sync_for_async(&src, ctx)? {
            Ok(it) => return async_opened(vm, fr, it),
            Err((method, open)) => {
                fr.set_index(vm, EXTRA, open as usize);
                (method, true)
            }
        }
    } else if vm.calls_program(&f) {
        (f, false)
    } else {
        let it = vm.open_async_native(&f, &src)?;
        return async_opened(vm, fr, it);
    };
    fr.set(vm, FLAG, Value::Bool(sync));
    // The method is the frame's callee, as an open by call keeps it.
    vm.stack[fr.base() - 2] = Slot::pack(method);
    fr.call_slots_as(
        vm,
        Slot::pack(method),
        Slot::pack(src),
        [],
        Step::CallUncounted,
    )
}

/// The iterator an async open made without a call: its record written for the instruction.
fn async_opened(vm: &mut Vm, fr: Frame, it: Value) -> Result<Step, Value> {
    let next = vm.record_next(&it)?;
    set_caller_slot(vm, fr, 0, Slot::pack(it));
    set_caller_slot(vm, fr, 1, Slot::pack(next));
    Ok(Step::DoneEmpty)
}

/// An async open: the method returned the iterator, checked as `Vm::open_with` checks it, then kept in the
/// instruction's iterator record, adapted when it is a sync one.
fn async_open_step(vm: &mut Vm, fr: Frame, input: Input) -> Result<Step, Value> {
    if matches!(fr.get(vm, ASYNC_GETTER), Value::Bool(true)) {
        let src = fr.get(vm, OUT);
        let f = match input {
            Input::Start => match vm.get_stepping_value(&src, SYM_ASYNC_ITERATOR)? {
                Got::Value(f) => f,
                Got::Call(step) => return Ok(step),
            },
            Input::Returned(f) => f.get(),
            Input::Threw(e) => return Err(e),
            Input::Finished(_) => return Ok(Step::DoneEmpty),
        };
        fr.set(vm, ASYNC_GETTER, Value::Bool(false));
        return async_open_with(vm, fr, src, f);
    }
    let (id, next) = match input {
        Input::Start => {
            let (f, src) = (fr.callee(vm), fr.slot(vm, OUT));
            return fr.call_slots_as(vm, f, src, [], Step::CallUncounted);
        }
        // The iterator is kept once its `next` is a program getter, which returned this.
        Input::Returned(next) if fr.slot(vm, IT).obj().is_some() => {
            (fr.slot(vm, IT).obj().unwrap_or(0), next.get())
        }
        Input::Returned(r) => {
            let Value::Obj(id) = r.get() else {
                return Err(vm.type_error("Iterator method result must be an object."));
            };
            let nk = vm.names.next;
            match vm.get_stepping(id, nk)? {
                Got::Value(next) => (id, next),
                Got::Call(step) => {
                    fr.set(vm, IT, Value::Obj(id));
                    return Ok(step);
                }
            }
        }
        Input::Threw(e) => return Err(e),
        Input::Finished(_) => return Ok(Step::DoneEmpty),
    };
    if !vm.is_callable(&next) {
        return Err(vm.type_error("Iterator next must be a function."));
    }
    let it = if matches!(fr.get(vm, FLAG), Value::Bool(true)) {
        vm.fuel(fr.index(vm, EXTRA) as i32);
        let src = fr.get(vm, OUT);
        let next = vm.record_next_read(&src, &Value::Obj(id), next)?;
        let proto = vm.realm.async_from_sync_proto;
        Value::Obj(vm.alloc(Obj::new(
            Some(proto),
            Kind::AsyncFromSync { sync: id, next },
        )))
    } else {
        // The reference calls the method as bytecode calls it.
        if !vm.is_closure(&fr.callee(vm).get()) {
            vm.fuel(crate::vm::NATIVE_FUEL);
        }
        Value::Obj(id)
    };
    // The `next` read above, unless the record keeps none.
    let next = match it {
        Value::Obj(i) if i == id => match vm.heap[id as usize].kind {
            Kind::ArrayIter { .. }
            | Kind::MapIter { .. }
            | Kind::StrIter { .. }
            | Kind::ListIter { .. }
            | Kind::ExoticIter { .. }
            | Kind::Generator(_)
            | Kind::AsyncFromSync { .. } => Value::Undef,
            _ => next,
        },
        _ => vm.record_next(&it)?,
    };
    set_caller_slot(vm, fr, 0, Slot::pack(it));
    set_caller_slot(vm, fr, 1, Slot::pack(next));
    Ok(Step::DoneEmpty)
}
