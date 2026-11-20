//! An error's `stack`, as the reference makes it: an own data property, not enumerable, whose `    at` lines are fixed
//! when the error is made and whose `name: message` header is formatted when it is first read (V8 formats on first
//! access, so a subclass constructor that sets `this.name` is in the header). Until then the property holds the lines
//! alone and has `PENDING_STACK` among its flags; any read formats it (`Vm::fix_stack`), a write replaces it.

use crate::object::*;
use crate::value::{Id, Value};
use crate::vm::{FrameKind, Vm};

/// How many frames a `stack` shows, as V8's `Error.stackTraceLimit`.
const STACK_LIMIT: usize = 10;

impl Vm {
    /// The program frames on the stack as `stack` lines, innermost first: a function's by its `name` (or
    /// `<anonymous>`), the program's own without one, each at the site it is at. Native frames are left out.
    pub(crate) fn stack_trace(&mut self) -> String {
        let mut trace = String::new();
        let mut shown = 0;
        for i in (0..self.frames.len()).rev() {
            if shown == STACK_LIMIT {
                break;
            }
            let f = &self.frames[i];
            if matches!(f.kind, FrameKind::Native(..)) {
                continue;
            }
            let Some(offset) = f.func.pos.get(f.pc.saturating_sub(1)).copied() else {
                continue;
            };
            let name = if f.func.is_program {
                None
            } else {
                let callee = self.stack.get(f.base.wrapping_sub(2)).map(|s| s.get());
                let name = match callee {
                    Some(Value::Obj(c)) if self.heap[c as usize].is_callable() => {
                        let nk = self.names.name;
                        match self.peek(c, nk) {
                            Value::Str(s) => self.text(s).to_owned(),
                            _ => String::new(),
                        }
                    }
                    _ => self.atoms.text(f.func.name).to_owned(),
                };
                Some(if name.is_empty() {
                    "<anonymous>".to_owned()
                } else {
                    name
                })
            };
            trace.push_str(&self.stack_line(offset, name.as_deref()));
            shown += 1;
        }
        trace
    }

    /// One `stack` line for a site of the program: `at name (<program>:line:col)`, or `at <program>:line:col`.
    pub(crate) fn stack_line(&self, offset: u32, name: Option<&str>) -> String {
        let (line, column) = crate::run::line_col(&self.code, offset);
        match name {
            Some(n) => format!("\n    at {n} (<program>:{line}:{column})"),
            None => format!("\n    at <program>:{line}:{column}"),
        }
    }

    /// Gives the new error `id` its `stack`, its lines `trace`, after the properties it has so far.
    pub(crate) fn add_stack(&mut self, id: Id, trace: String) {
        let sk = self.names.stack;
        let text = self.string_val(trace);
        self.heap[id as usize]
            .props
            .push_new(sk, text, HIDDEN | PENDING_STACK);
    }

    /// Leaves the lines of a host failure's `stack` to the handler that catches it (see `stack_caught`): until then
    /// they are undefined, which reads as none.
    pub(crate) fn stack_at_handler(&mut self, id: Id) {
        let sk = self.names.stack;
        if let Some(i) = self.heap[id as usize].props.find(sk) {
            self.heap[id as usize].props.items[i].value = Value::Undef;
        }
    }

    /// A handler of the frame `fi` caught `e`: a host failure's `stack` not read yet names the frame's site, where
    /// the program observed it (none in a native frame, the reference's internal code).
    pub(crate) fn stack_caught(&mut self, e: &Value, fi: usize) {
        let Value::Obj(id) = *e else { return };
        if !matches!(self.heap[id as usize].kind, Kind::Error(_)) {
            return;
        }
        let sk = self.names.stack;
        let Some(i) = self.heap[id as usize].props.find(sk) else {
            return;
        };
        let p = &self.heap[id as usize].props.items[i];
        if p.flags & PENDING_STACK == 0 || !matches!(p.value, Value::Undef) {
            return;
        }
        let f = &self.frames[fi];
        let offset = match f.kind {
            FrameKind::Native(..) => None,
            _ => f.func.pos.get(f.pc.saturating_sub(1)).copied(),
        };
        let line = offset.map(|o| self.stack_line(o, None)).unwrap_or_default();
        let text = self.string_val(line);
        self.heap[id as usize].props.items[i].value = text;
    }

    /// Points the lines of a failure's `stack` not read yet at the site `offset` it failed at, once it has one.
    pub(crate) fn locate_stack(&mut self, id: Id, offset: u32) {
        let sk = self.names.stack;
        let Some(i) = self.heap[id as usize].props.find(sk) else {
            return;
        };
        let p = &self.heap[id as usize].props.items[i];
        if p.flags & PENDING_STACK == 0
            || !matches!(p.value, Value::Str(s) if self.text(s).is_empty())
        {
            return;
        }
        let line = self.stack_line(offset, None);
        let text = self.string_val(line);
        self.heap[id as usize].props.items[i].value = text;
    }

    /// The `stack` of `id` at its first read: its header, the error's name and message read as display reads them
    /// (a program getter runs no code and reads as undefined), then its lines, from now on its value.
    pub(crate) fn fix_stack(&mut self, id: Id, key: Atom) -> Value {
        let Some(i) = self.heap[id as usize].props.find(key) else {
            return Value::Undef;
        };
        // Undefined lines are a host failure's no handler caught.
        let trace = match self.heap[id as usize].props.items[i].value {
            Value::Str(s) => self.text(s).to_owned(),
            _ => String::new(),
        };
        let header = crate::convert::error_to_string(self, id);
        let text = self.string_val(format!("{header}{trace}"));
        let p = &mut self.heap[id as usize].props.items[i];
        p.value = text;
        p.flags &= !PENDING_STACK;
        text
    }
}
