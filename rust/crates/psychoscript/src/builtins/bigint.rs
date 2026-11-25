//! BigInt: the reference's `bigintGlobal` (`src/stdlib/number.ts`), its BigInt operators
//! (`src/runtime/operations.ts`) and the size cap (`src/runtime/limits.ts`).
//!
//! A BigInt is a `Kind::BigInt` heap object, which `Value::Big` refers to and programs never see as an object. The
//! interner gives each value one object, so `===`, `Object.is` and Map keys compare ids. It is a weak table, as the
//! strings' interner is: the sweep drops a freed BigInt from it, and one it gives out while a cycle runs survives the
//! cycle (`Vm::gc_shade_big`).

use std::cmp::Ordering;

use num_bigint::BigInt;
use num_traits::{FromPrimitive, One, Signed, ToPrimitive, Zero};
use rustc_hash::{FxHashMap, FxHasher};

use super::{arg, fuel};
use crate::conversion::code;
use crate::object::*;
use crate::ops::Hint;
use crate::value::{Id, Value, is_js_whitespace, to_integer};
use crate::vm::{Res, Vm};

/// Most bits a BigInt may have: past about a million, one multiplication, division or decimal conversion takes long.
pub const MAX_BIGINT_BITS: u64 = 1 << 20;
pub const TOO_BIG: &str = "Maximum BigInt size exceeded";
const MIX: &str = "Cannot mix BigInt and other types, use explicit conversions.";

/// Whether `n` is under the size cap.
pub fn fits(n: &BigInt) -> bool {
    n.bits() <= MAX_BIGINT_BITS
}

/// The interner: each live BigInt's object by the value's hash.
#[derive(Default)]
pub struct Interned {
    by_hash: FxHashMap<u64, Id>,
    /// The rare BigInts whose hash another one holds in `by_hash`.
    collided: Vec<(u64, Id)>,
}

fn hash_of(n: &BigInt) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = FxHasher::default();
    n.hash(&mut h);
    h.finish()
}

impl Interned {
    fn add(&mut self, h: u64, id: Id) {
        match self.by_hash.entry(h) {
            std::collections::hash_map::Entry::Occupied(_) => self.collided.push((h, id)),
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(id);
            }
        }
    }

    /// Drops the freed BigInt `id` of value `n`.
    pub(crate) fn forget(&mut self, id: Id, n: &BigInt) {
        let h = hash_of(n);
        if self.by_hash.get(&h) == Some(&id) {
            self.by_hash.remove(&h);
            if let Some(i) = self.collided.iter().position(|e| e.0 == h) {
                let (_, other) = self.collided.swap_remove(i);
                self.by_hash.insert(h, other);
            }
        } else if let Some(i) = self.collided.iter().position(|e| e.1 == id) {
            self.collided.swap_remove(i);
        }
    }
}

/// A failure an operation found while it borrowed its operands.
enum Fail {
    Range(&'static str),
    Type(&'static str),
}

impl Vm {
    /// The value of BigInt `id`.
    pub fn big(&self, id: Id) -> &BigInt {
        match &self.heap[id as usize].kind {
            Kind::BigInt(n) => n,
            _ => &BigInt::ZERO,
        }
    }

    fn find_big(&self, h: u64, n: &BigInt) -> Option<Id> {
        let first = *self.bigints.by_hash.get(&h)?;
        if self.big(first) == n {
            return Some(first);
        }
        let mut others = self.bigints.collided.iter();
        others
            .find(|(c, id)| *c == h && self.big(*id) == n)
            .map(|e| e.1)
    }

    /// The BigInt `n`, unchecked against the cap.
    pub fn big_val(&mut self, n: BigInt) -> Value {
        let h = hash_of(&n);
        if let Some(id) = self.find_big(h, &n) {
            self.gc_shade_big(id);
            return Value::Big(id);
        }
        let id = self.alloc(Obj::new(None, Kind::BigInt(Box::new(n))));
        self.bigints.add(h, id);
        Value::Big(id)
    }

    /// The BigInt `n`, or the RangeError of a value past the cap.
    pub fn checked_big(&mut self, n: BigInt) -> Res {
        if !fits(&n) {
            return Err(self.range_error(TOO_BIG));
        }
        Ok(self.big_val(n))
    }

    /// Registers the BigInts a restored state holds from `from` on; false when two have one value.
    pub(crate) fn intern_restored(&mut self, from: usize) -> bool {
        for id in from..self.heap.len() {
            if let Kind::BigInt(n) = &self.heap[id].kind {
                let h = hash_of(n);
                if self.find_big(h, n).is_some() {
                    return false;
                }
                self.bigints.add(h, id as Id);
            }
        }
        true
    }

    fn fail(&mut self, f: Fail) -> Value {
        match f {
            Fail::Range(m) => self.range_error(m),
            Fail::Type(m) => self.type_error(m),
        }
    }

    /// A binary operator (`code::SUB..=USHR` or `ADD`) on primitives one of which is a BigInt: both must be, and the
    /// result stays under the cap, `**` and `<<` checked before they compute, the rest after.
    #[cold]
    #[inline(never)]
    pub(crate) fn big_binary(&mut self, op: u8, a: &Value, b: &Value) -> Res {
        let (Value::Big(x), Value::Big(y)) = (*a, *b) else {
            return Err(self.type_error(MIX));
        };
        let r = big_op(op, self.big(x), self.big(y));
        match r {
            Ok(n) => self.checked_big(n),
            Err(f) => Err(self.fail(f)),
        }
    }

    /// `-`, `~` (`code::NEG`, `BIT_NOT`), `++` and `--` (`INC`, `DEC`) of BigInt `id`; a result one past the cap fails.
    #[cold]
    #[inline(never)]
    pub(crate) fn big_unary(&mut self, op: u8, id: Id) -> Res {
        let x = self.big(id);
        let n = match op {
            code::NEG => -x,
            code::BIT_NOT => !x,
            code::INC => x + 1u32,
            _ => x - 1u32,
        };
        self.checked_big(n)
    }

    /// IsLessThan of primitives one of which is a BigInt: `None` when they don't compare.
    #[cold]
    #[inline(never)]
    pub(crate) fn big_less_than(&mut self, a: &Value, b: &Value) -> Result<Option<bool>, Value> {
        Ok(self.big_compare(a, b)?.map(Ordering::is_lt))
    }

    /// How primitives one of which is a BigInt order, by their mathematical values; `None` for NaN or a string that
    /// is no integer.
    fn big_compare(&mut self, a: &Value, b: &Value) -> Result<Option<Ordering>, Value> {
        let (x, y) = (self.numeric(a)?, self.numeric(b)?);
        Ok(match (x, y) {
            (Numeric::Big(x), Numeric::Big(y)) => Some(x.cmp(&y)),
            (Numeric::Big(x), Numeric::Num(y)) => cmp_big_num(&x, y),
            (Numeric::Num(x), Numeric::Big(y)) => cmp_big_num(&y, x).map(Ordering::reverse),
            (Numeric::Num(x), Numeric::Num(y)) => x.partial_cmp(&y),
        })
    }

    /// `==` of a BigInt and a number or string.
    pub(crate) fn big_loose_eq(&mut self, a: &Value, b: &Value) -> Result<bool, Value> {
        Ok(self.big_compare(a, b)? == Some(Ordering::Equal))
    }

    /// A comparison operand: a BigInt, a string read as one (StringToBigInt), or ToNumber of anything else.
    fn numeric(&mut self, v: &Value) -> Result<Numeric, Value> {
        Ok(match v {
            Value::Big(id) => Numeric::Big(self.big(*id).clone()),
            Value::Str(s) => text_numeric(self.atoms.get(*s)),
            v => Numeric::Num(self.number_of(v)?),
        })
    }

    /// The decimal text of BigInt `id`.
    pub fn big_text(&self, id: Id) -> String {
        self.big(id).to_str_radix(10)
    }

    /// ToBigInt of a primitive: numbers are refused, unlike `BigInt(n)`.
    fn bigint_of(&mut self, v: &Value) -> Res {
        match v {
            Value::Big(_) => Ok(*v),
            Value::Bool(b) => Ok(self.big_val(BigInt::from(*b as u8))),
            Value::Str(s) => {
                let s = *s;
                self.string_to_big(s)
            }
            v => {
                let d = super::describe_value(self, v);
                Err(self.type_error(&format!("Cannot convert {d} to a BigInt.")))
            }
        }
    }

    fn string_to_big(&mut self, s: crate::strings::StrId) -> Res {
        let text = self.atoms.get(s);
        let trimmed = text.trim_matches(is_js_whitespace);
        if !syntax(trimmed) {
            let head = self.atoms.sref(s).slice16(0, 64);
            let mut quoted = String::new();
            crate::convert::quote(&mut quoted, &head);
            return Err(self.syntax_error(&format!("Cannot convert {quoted} to a BigInt.")));
        }
        let body = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
        let decimal = body.starts_with(|c: char| c.is_ascii_digit());
        if trimmed.len() as u64 > MAX_BIGINT_BITS + 2
            || (decimal && trimmed.len() > max_decimal_digits())
        {
            return Err(self.range_error(TOO_BIG));
        }
        let n = parse_integer(trimmed);
        self.checked_big(n)
    }
}

/// The digits past which a decimal integer always exceeds the cap (barring leading zeros), the reference's
/// `maxDecimalDigits`.
fn max_decimal_digits() -> usize {
    (MAX_BIGINT_BITS as f64 * 2f64.log10()).ceil() as usize + 1
}

fn big_op(op: u8, x: &BigInt, y: &BigInt) -> Result<BigInt, Fail> {
    Ok(match op {
        code::ADD => x + y,
        code::SUB => x - y,
        code::MUL => x * y,
        code::DIV | code::MOD => {
            if y.is_zero() {
                return Err(Fail::Range("Division by zero"));
            }
            if op == code::DIV { x / y } else { x % y }
        }
        code::POW => {
            if y.is_negative() {
                return Err(Fail::Range("Exponent must be non-negative"));
            }
            if x.is_zero() || x.magnitude().is_one() || y <= &BigInt::one() {
                return Ok(if y.is_zero() {
                    BigInt::one()
                } else if x.is_negative() && x.magnitude().is_one() && !y.bit(0) {
                    -x
                } else {
                    x.clone()
                });
            }
            // The result has more than (bits - 1) * y bits.
            let e = y.to_u64().filter(|e| *e < MAX_BIGINT_BITS);
            match e {
                Some(e) if (x.bits() - 1).saturating_mul(e) < MAX_BIGINT_BITS => x.pow(e as u32),
                _ => return Err(Fail::Range(TOO_BIG)),
            }
        }
        code::BIT_AND => x & y,
        code::BIT_OR => x | y,
        code::BIT_XOR => x ^ y,
        code::SHL => shift_left(x, y)?,
        code::SHR => shift_left(x, &-y)?,
        _ => {
            return Err(Fail::Type(
                "BigInts have no unsigned right shift, use >> instead.",
            ));
        }
    })
}

fn shift_left(x: &BigInt, by: &BigInt) -> Result<BigInt, Fail> {
    if x.is_zero() || !by.is_positive() {
        // A right shift: past the value's bits it leaves its sign.
        let right = by.magnitude().to_u64().filter(|r| *r <= x.bits());
        return Ok(match right {
            Some(r) => x >> r,
            None if x.is_negative() => -BigInt::one(),
            None => BigInt::zero(),
        });
    }
    match by.to_u64().filter(|s| *s < MAX_BIGINT_BITS) {
        Some(s) => Ok(x << s),
        None => Err(Fail::Range(TOO_BIG)),
    }
}

/// How BigInt `x` orders against number `n`.
fn cmp_big_num(x: &BigInt, n: f64) -> Option<Ordering> {
    if n.is_nan() {
        return None;
    }
    if n.is_infinite() {
        return Some(if n > 0.0 {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    let t = n.trunc();
    let int = BigInt::from_f64(t)?;
    Some(match x.cmp(&int) {
        Ordering::Equal => 0.0.partial_cmp(&(n - t))?,
        o => o,
    })
}

enum Numeric {
    Num(f64),
    Big(BigInt),
}

/// The reference's `bigintSyntax`, on trimmed text.
fn syntax(t: &str) -> bool {
    let b = t.as_bytes();
    let all = |s: &[u8], f: fn(&u8) -> bool| !s.is_empty() && s.iter().all(f);
    if b.is_empty() {
        return true;
    }
    if b.len() > 1 && b[0] == b'0' {
        let rest = &b[2..];
        match b[1] {
            b'x' | b'X' => return all(rest, u8::is_ascii_hexdigit),
            b'o' | b'O' => return all(rest, |c| (b'0'..=b'7').contains(c)),
            b'b' | b'B' => return all(rest, |c| *c == b'0' || *c == b'1'),
            _ => {}
        }
    }
    let digits = if matches!(b[0], b'+' | b'-') {
        &b[1..]
    } else {
        b
    };
    all(digits, u8::is_ascii_digit)
}

/// The radix of text `syntax` accepted, and its digits after any sign or prefix.
fn radix_digits(t: &str) -> (u32, bool, &str) {
    let radix = match t.as_bytes().get(..2) {
        Some([b'0', b'x' | b'X']) => 16,
        Some([b'0', b'o' | b'O']) => 8,
        Some([b'0', b'b' | b'B']) => 2,
        _ => 10,
    };
    if radix != 10 {
        return (radix, false, &t[2..]);
    }
    match t.as_bytes().first() {
        Some(b'-') => (10, true, &t[1..]),
        Some(b'+') => (10, false, &t[1..]),
        _ => (10, false, t),
    }
}

/// The integer of text `syntax` accepted.
fn parse_integer(t: &str) -> BigInt {
    let (radix, negative, digits) = radix_digits(t);
    let n = BigInt::parse_bytes(digits.as_bytes(), radix).unwrap_or_default();
    if negative { -n } else { n }
}

/// A string compared with a BigInt, read as the reference's `longTextAsNumeric` reads it: NaN when it is no
/// integer, an infinity of its sign when it has more digits than any BigInt under the cap, else its BigInt. Long
/// texts are never parsed whole.
fn text_numeric(text: &str) -> Numeric {
    let trimmed = text.trim_matches(is_js_whitespace);
    if !syntax(trimmed) {
        return Numeric::Num(f64::NAN);
    }
    let (radix, negative, digits) = radix_digits(trimmed);
    let digits = digits.trim_start_matches('0');
    let bits_per_digit = match radix {
        16 => 4.0,
        8 => 3.0,
        2 => 1.0,
        _ => 10f64.log2(),
    };
    if (digits.len() as f64 - 1.0) * bits_per_digit >= MAX_BIGINT_BITS as f64 {
        return Numeric::Num(if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    let n = BigInt::parse_bytes(digits.as_bytes(), radix).unwrap_or_default();
    Numeric::Big(if negative { -n } else { n })
}

/// A BigInt as a number, rounded as JavaScript's `Number(n)` rounds.
pub fn big_to_f64(n: &BigInt) -> f64 {
    n.to_f64().unwrap_or(if n.is_negative() {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    })
}

/// What a BigInt that reaches JSON throws: at the host boundary, or in `JSON.stringify`.
pub(crate) fn json_error(vm: &mut Vm, boundary: bool) -> Value {
    if boundary {
        vm.invalid_data("A BigInt cannot cross to the host; pass text instead, e.g. `String(n)`.")
    } else {
        vm.type_error("Do not know how to serialize a BigInt; convert it first, e.g. `String(n)`.")
    }
}

/// Whether BigInts have a `toJSON`, which only the program can give them: JSON then takes its walk that calls it.
pub(crate) fn has_to_json(vm: &mut Vm) -> bool {
    let (p, k) = (vm.bigint_proto(), vm.names.to_json);
    vm.has_key(p, k)
}

// ---------- the global ----------

pub(crate) fn setup(vm: &mut Vm) {
    let op = vm.realm.object_proto;
    let proto = vm.alloc(Obj::new(Some(op), Kind::Ordinary));
    vm.realm.std.bigint = proto;
    // A function, not a constructor: `new BigInt()` fails as `new` on any other built-in function does.
    let c = vm.native_fn("BigInt", 1, bigint_call, Value::Undef);
    let Value::Obj(c) = c else {
        return;
    };
    let (pk, ck) = (vm.names.prototype, vm.names.constructor);
    vm.heap[c as usize]
        .props
        .insert(pk, Value::Obj(proto), FIXED);
    vm.define_hidden(proto, ck, Value::Obj(c));
    let a = vm.atoms.intern_static("BigInt");
    vm.global_map.insert(a, Value::Obj(c));
    vm.method(c, "asIntN", 2, as_int_n);
    vm.method(c, "asUintN", 2, as_uint_n);
    vm.method(proto, "toLocaleString", 0, to_locale_string);
    vm.method(proto, "toString", 0, to_string);
    vm.method(proto, "valueOf", 0, value_of);
}

fn bigint_call(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    fuel::with_primitives(vm, &[Hint::Number], [arg(args, 0)], false, |vm, [v]| {
        let Value::Num(n) = v else {
            return vm.bigint_of(&v);
        };
        if n.is_finite() && n.fract() == 0.0 {
            return Ok(vm.big_val(BigInt::from_f64(n).unwrap_or_default()));
        }
        let text = crate::value::num_to_string(n);
        Err(vm.range_error(&format!(
            "The number {text} cannot be converted to a BigInt because it is not an integer."
        )))
    })
}

/// `asIntN` and `asUintN`: past the cap every BigInt already fits, except a negative one made unsigned.
fn wrap(vm: &mut Vm, args: &[Value], signed: bool) -> Res {
    fuel::with_primitives(
        vm,
        &[Hint::Number],
        [arg(args, 0), arg(args, 1)],
        false,
        |vm, [bits, value]| {
            let width = match bits {
                Value::Undef => 0.0,
                v => to_integer(vm.number_of(&v)?),
            };
            if !(0.0..=9007199254740991.0).contains(&width) {
                return Err(vm.range_error("Invalid value: not (convertible to) a safe integer."));
            }
            let Value::Big(id) = vm.bigint_of(&value)? else {
                return Ok(Value::Undef);
            };
            let n = vm.big(id);
            if width > MAX_BIGINT_BITS as f64 {
                if !signed && n.is_negative() {
                    return Err(vm.range_error(TOO_BIG));
                }
                return Ok(Value::Big(id));
            }
            let width = width as u64;
            if !n.is_negative() && n.bits() + signed as u64 <= width {
                return Ok(Value::Big(id));
            }
            let mask = (BigInt::one() << width) - 1u32;
            let mut r = n & &mask;
            if signed && width > 0 && r.bit(width - 1) {
                r -= mask + 1u32;
            }
            Ok(vm.big_val(r))
        },
    )
}

fn as_int_n(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    wrap(vm, args, true)
}

fn as_uint_n(vm: &mut Vm, _this: Value, args: &[Value], _: Id) -> Res {
    wrap(vm, args, false)
}

fn this_big(vm: &mut Vm, this: &Value, name: &str) -> Result<Id, Value> {
    match this {
        Value::Big(id) => Ok(*id),
        _ => Err(vm.type_error(&format!(
            "BigInt.prototype.{name} requires that 'this' be a BigInt."
        ))),
    }
}

// Through ICU4X, as the reference's host `Intl.NumberFormat` (see `number_locale`).
fn to_locale_string(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_big(vm, &this, "toLocaleString")?;
    let digits = vm.big_text(id);
    super::number_locale::to_locale_string(
        vm,
        super::number_locale::Input::BigInt(digits),
        args,
        "BigInt.prototype.toLocaleString",
    )
}

fn to_string(vm: &mut Vm, this: Value, args: &[Value], _: Id) -> Res {
    let id = this_big(vm, &this, "toString")?;
    fuel::with_primitives(vm, &[Hint::Number], [arg(args, 0)], false, |vm, [radix]| {
        let base = match radix {
            Value::Undef => 10.0,
            v => to_integer(vm.number_of(&v)?),
        };
        if !(2.0..=36.0).contains(&base) {
            return Err(vm.range_error("toString() radix must be between 2 and 36."));
        }
        let text = vm.big(id).to_str_radix(base as u32);
        Ok(vm.string_val(text))
    })
}

fn value_of(vm: &mut Vm, this: Value, _args: &[Value], _: Id) -> Res {
    this_big(vm, &this, "valueOf").map(Value::Big)
}
