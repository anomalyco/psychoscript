//! `Number.prototype.toLocaleString` and `BigInt.prototype.toLocaleString` through ICU4X, keeping step with the
//! reference, whose host `Intl.NumberFormat` is ICU4C under Bun.
//!
//! The reference reads the locale list and the `Intl.NumberFormat` options through their getters, converts each object
//! among them to a primitive, and hands them to the host. This module is handed those primitives (see
//! `number_locale_string`), resolves the options as `Intl.NumberFormat` does — in its order, with the host's error kinds
//! and messages — and formats with ICU4X's CLDR data. The locale is the first valid tag, as for Date
//! (`date_locale::locale_of`).
//!
//! Only the decimal style in standard notation is formatted: a `style` of `percent`, `currency` or `unit`, or a
//! `notation` other than `standard`, is validated as the reference validates it and then refused with a RangeError
//! that says so, rather than formatted wrongly. ICU4X has no NaN or infinity symbols: they are `NaN` and `∞` in every
//! locale. The differences from the host are recorded by `conformance/number-locale.ts` and replayed by
//! `bench/tests/date_locale.rs`.

use fixed_decimal::{
    Decimal, RoundingIncrement, Sign, SignDisplay, SignedRoundingMode, UnsignedRoundingMode,
};
use icu_decimal::options::{DecimalFormatterOptions, GroupingStrategy};
use icu_decimal::{DecimalFormatter, DecimalFormatterPreferences};
use icu_locale_core::extensions::unicode::Value as KeywordValue;
use icu_locale_core::preferences::extensions::unicode::keywords::NumberingSystem;
use writeable::Writeable;

use super::date_locale::{DateError, locale_of};

/// An option's value as the reference hands it to the host: a primitive, or an object it could not convert (an
/// opaque value), which the host's ToString reads as `text`.
pub(crate) enum Prim {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Big(String),
    Sym,
    Obj(String),
}

impl Prim {
    /// The host's ToString.
    fn text(&self) -> Result<String, DateError> {
        Ok(match self {
            Prim::Null => "null".into(),
            Prim::Bool(b) => b.to_string(),
            Prim::Num(n) => crate::value::num_to_string(*n),
            Prim::Str(s) | Prim::Big(s) | Prim::Obj(s) => s.clone(),
            Prim::Sym => {
                return Err(DateError::Type(
                    "Cannot convert a symbol to a string".into(),
                ));
            }
        })
    }

    /// The host's ToNumber.
    fn number(&self) -> Result<f64, DateError> {
        Ok(match self {
            Prim::Null => 0.0,
            Prim::Bool(b) => *b as u8 as f64,
            Prim::Num(n) => *n,
            Prim::Str(s) | Prim::Obj(s) => crate::value::str_to_num(s),
            Prim::Big(_) => {
                return Err(DateError::Type(
                    "Conversion from 'BigInt' to 'number' is not allowed.".into(),
                ));
            }
            Prim::Sym => {
                return Err(DateError::Type(
                    "Cannot convert a symbol to a number".into(),
                ));
            }
        })
    }

    /// The host's ToBoolean.
    fn truthy(&self) -> bool {
        match self {
            Prim::Null => false,
            Prim::Bool(b) => *b,
            Prim::Num(n) => *n != 0.0 && !n.is_nan(),
            Prim::Str(s) => !s.is_empty(),
            Prim::Big(s) => s != "0" && s != "-0",
            Prim::Sym | Prim::Obj(_) => true,
        }
    }
}

/// The options `Intl.NumberFormat` reads, in the reference's order (its `numberFormatOptions`); the digit options and
/// `roundingIncrement` convert with the number hint.
pub(crate) const NUMBER_OPTIONS: [&str; 21] = [
    "localeMatcher",
    "numberingSystem",
    "style",
    "currency",
    "currencyDisplay",
    "currencySign",
    "unit",
    "unitDisplay",
    "notation",
    "minimumIntegerDigits",
    "minimumFractionDigits",
    "maximumFractionDigits",
    "minimumSignificantDigits",
    "maximumSignificantDigits",
    "roundingIncrement",
    "roundingMode",
    "roundingPriority",
    "trailingZeroDisplay",
    "compactDisplay",
    "useGrouping",
    "signDisplay",
];

/// Whether option `at` of `NUMBER_OPTIONS` converts with the number hint.
pub(crate) fn numeric(at: usize) -> bool {
    (9..=14).contains(&at)
}

/// The number being formatted: a Number, or a BigInt's decimal digits.
pub(crate) enum Input {
    Number(f64),
    BigInt(String),
}

/// The locale tags and the options a `toLocaleString` call read: `options[i]` is `NUMBER_OPTIONS[i]`'s value.
pub(crate) struct Request {
    /// `Number.prototype.toLocaleString` or `BigInt.prototype.toLocaleString`, for the refusal's message.
    pub method: &'static str,
    pub tags: Vec<String>,
    pub options: Vec<Option<Prim>>,
}

impl Request {
    fn get(&self, name: &str) -> Option<&Prim> {
        let at = NUMBER_OPTIONS.iter().position(|n| *n == name)?;
        self.options.get(at)?.as_ref()
    }

    /// GetOption for a string: one of `allowed`, or the host's RangeError `message`.
    fn string(
        &self,
        name: &str,
        allowed: &[&str],
        message: &str,
    ) -> Result<Option<String>, DateError> {
        let Some(value) = self.get(name) else {
            return Ok(None);
        };
        let text = value.text()?;
        if !allowed.is_empty() && !allowed.contains(&text.as_str()) {
            return Err(DateError::Range(message.into()));
        }
        Ok(Some(text))
    }

    /// GetNumberOption / DefaultNumberOption: an integer in `min..=max`, or the host's RangeError.
    fn number(&self, name: &str, min: f64, max: f64) -> Result<Option<f64>, DateError> {
        let Some(value) = self.get(name) else {
            return Ok(None);
        };
        let n = value.number()?;
        if n.is_nan() || n < min || n > max {
            return Err(DateError::Range(format!("{name} is out of range")));
        }
        Ok(Some(n.floor()))
    }
}

/// How the digits are rounded (the spec's `[[RoundingType]]`).
#[derive(Clone, Copy, PartialEq)]
enum RoundingType {
    Fraction,
    Significant,
    MorePrecision,
    LessPrecision,
}

/// The resolved digit, rounding, grouping and sign options.
struct Resolved {
    min_integer: i16,
    min_fraction: i16,
    max_fraction: i16,
    min_significant: i16,
    max_significant: i16,
    rounding: RoundingType,
    increment: u16,
    mode: SignedRoundingMode,
    strip_if_integer: bool,
    grouping: GroupingStrategy,
    sign: SignDisplay,
    numbering_system: Option<String>,
}

const STYLES: [&str; 4] = ["decimal", "percent", "currency", "unit"];
const ROUNDING_MODES: [&str; 9] = [
    "ceil",
    "floor",
    "expand",
    "trunc",
    "halfCeil",
    "halfFloor",
    "halfExpand",
    "halfTrunc",
    "halfEven",
];
const INCREMENTS: [u16; 15] = [
    1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000,
];

/// Formats `input` for the resolved locale and options.
pub(crate) fn format(input: &Input, request: &Request) -> Result<String, DateError> {
    let locale = locale_of(&request.tags)?;
    let resolved = resolve(request)?;
    let mut prefs = DecimalFormatterPreferences::from(&locale);
    // The option wins over the locale's `-u-nu-`; one with no data falls back to the locale's own.
    if let Some(nu) = resolved
        .numbering_system
        .as_deref()
        .and_then(|nu| KeywordValue::try_from_str(nu).ok())
        .and_then(|value| NumberingSystem::try_from(&value).ok())
    {
        prefs.numbering_system = Some(nu);
    }
    let formatter =
        DecimalFormatter::try_new(prefs, DecimalFormatterOptions::from(resolved.grouping))
            .or_else(|_| DecimalFormatter::try_new(Default::default(), Default::default()))
            .map_err(|_| DateError::Range("Internal error: no number formatting data".into()))?;
    let number = match input {
        Input::Number(x) if x.is_nan() => {
            return Ok(symbol(&formatter, "NaN", nan_sign(&resolved)));
        }
        Input::Number(x) if x.is_infinite() => {
            let mut one = Decimal::from(1);
            if *x < 0.0 {
                one.set_sign(Sign::Negative);
            }
            one.apply_sign_display(resolved.sign);
            return Ok(symbol(&formatter, "∞", one.sign));
        }
        // Rust writes a finite double as its shortest round-trip decimal, without an exponent.
        Input::Number(x) => format!("{x}"),
        Input::BigInt(digits) => digits.clone(),
    };
    let Ok(mut decimal) = Decimal::try_from_str(&number) else {
        return Ok(number);
    };
    round(&mut decimal, &resolved);
    if resolved.strip_if_integer {
        decimal.absolute.trim_end_if_integer();
    }
    decimal.absolute.pad_start(resolved.min_integer);
    decimal.apply_sign_display(resolved.sign);
    Ok(formatter.format(&decimal).write_to_string().into_owned())
}

/// The sign a NaN shows: only `always` gives it one, a plus.
fn nan_sign(resolved: &Resolved) -> Sign {
    match resolved.sign {
        SignDisplay::Always => Sign::Positive,
        _ => Sign::None,
    }
}

/// `text` (NaN or infinity) in the locale's sign pattern: its signed `1` with the digit replaced.
fn symbol(formatter: &DecimalFormatter, text: &str, sign: Sign) -> String {
    let one = formatter
        .format(&Decimal::from(1))
        .write_to_string()
        .into_owned();
    let signed = formatter
        .format(&Decimal::from(1).with_sign(sign))
        .write_to_string()
        .into_owned();
    match signed.rfind(&one) {
        Some(at) => format!("{}{text}{}", &signed[..at], &signed[at + one.len()..]),
        None => text.to_owned(),
    }
}

/// Rounds `decimal` as `FormatNumericToString` does: to fraction digits, significant digits, or whichever of the two
/// is more or less precise.
fn round(decimal: &mut Decimal, resolved: &Resolved) {
    match resolved.rounding {
        RoundingType::Fraction => {
            *decimal = round_fraction(decimal.clone(), resolved);
        }
        RoundingType::Significant => {
            *decimal = round_significant(decimal.clone(), resolved).0;
        }
        RoundingType::MorePrecision | RoundingType::LessPrecision => {
            let (significant, magnitude) = round_significant(decimal.clone(), resolved);
            let fraction = round_fraction(decimal.clone(), resolved);
            let significant_first = magnitude <= -resolved.max_fraction;
            *decimal = if significant_first == (resolved.rounding == RoundingType::MorePrecision) {
                significant
            } else {
                fraction
            };
        }
    }
}

/// ToRawFixed: rounded to `max_fraction` digits by the increment, then at least `min_fraction`.
fn round_fraction(mut decimal: Decimal, resolved: &Resolved) -> Decimal {
    // An increment is 1, 2, 5 or 25 at a power of ten.
    let n = resolved.increment;
    let (base, shift) = match n.is_multiple_of(25) && matches!(n / 25, 1 | 10 | 100) {
        true => (25, (n / 25).ilog10() as i16),
        false => (n / 10u16.pow(n.ilog10()), n.ilog10() as i16),
    };
    let step = match base {
        2 => RoundingIncrement::MultiplesOf2,
        5 => RoundingIncrement::MultiplesOf5,
        25 => RoundingIncrement::MultiplesOf25,
        _ => RoundingIncrement::MultiplesOf1,
    };
    decimal.round_with_mode_and_increment(-resolved.max_fraction + shift, resolved.mode, step);
    decimal.absolute.trim_end();
    decimal.absolute.pad_end(-resolved.min_fraction);
    decimal
}

/// ToRawPrecision: rounded to `max_significant` digits, then at least `min_significant`; with the rounding's
/// magnitude, the position of its last digit.
fn round_significant(mut decimal: Decimal, resolved: &Resolved) -> (Decimal, i16) {
    let start = decimal.absolute.nonzero_magnitude_start();
    decimal.round_with_mode(start - resolved.max_significant + 1, resolved.mode);
    let start = decimal.absolute.nonzero_magnitude_start();
    decimal.absolute.trim_end();
    decimal
        .absolute
        .pad_end(start - resolved.min_significant + 1);
    (decimal, start - resolved.max_significant + 1)
}

/// Resolves the options in `Intl.NumberFormat`'s order, failing as the host does, then refuses what is not
/// formatted here.
fn resolve(request: &Request) -> Result<Resolved, DateError> {
    request.string(
        "localeMatcher",
        &["lookup", "best fit"],
        "localeMatcher must be either \"lookup\" or \"best fit\"",
    )?;
    let numbering_system = request.string("numberingSystem", &[], "")?;
    if let Some(nu) = &numbering_system
        && !well_formed_type(nu)
    {
        return Err(DateError::Range(
            "numberingSystem is not a well-formed numbering system value".into(),
        ));
    }
    let style = request
        .string(
            "style",
            &STYLES,
            "style must be either \"decimal\", \"percent\", \"currency\", or \"unit\"",
        )?
        .unwrap_or_else(|| "decimal".into());
    let currency = request.string("currency", &[], "")?;
    if let Some(code) = &currency
        && !(code.len() == 3 && code.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        return Err(DateError::Range(
            "currency is not a well-formed currency code".into(),
        ));
    }
    request.string(
        "currencyDisplay",
        &["code", "symbol", "narrowSymbol", "name"],
        "currencyDisplay must be either \"code\", \"symbol\", or \"name\"",
    )?;
    request.string(
        "currencySign",
        &["standard", "accounting"],
        "currencySign must be either \"standard\" or \"accounting\"",
    )?;
    let unit = request.string("unit", &[], "")?;
    if let Some(unit) = &unit
        && !well_formed_unit(unit)
    {
        return Err(DateError::Range(
            "unit is not a well-formed unit identifier".into(),
        ));
    }
    request.string(
        "unitDisplay",
        &["short", "narrow", "long"],
        "unitDisplay must be either \"short\", \"narrow\", or \"long\"",
    )?;
    if style == "currency" && currency.is_none() {
        return Err(DateError::Type("currency must be a string".into()));
    }
    if style == "unit" && unit.is_none() {
        return Err(DateError::Type("unit must be a string".into()));
    }
    let notation = request
        .string(
            "notation",
            &["standard", "scientific", "engineering", "compact"],
            "notation must be either \"standard\", \"scientific\", \"engineering\", or \"compact\"",
        )?
        .unwrap_or_else(|| "standard".into());

    // SetNumberFormatDigitOptions, with the decimal style's defaults (0 and 3 fraction digits).
    let min_integer = request
        .number("minimumIntegerDigits", 1.0, 21.0)?
        .unwrap_or(1.0) as i16;
    let has = |name: &str| request.get(name).is_some();
    let increment = request
        .number("roundingIncrement", 1.0, 5000.0)?
        .unwrap_or(1.0) as u16;
    if !INCREMENTS.contains(&increment) {
        return Err(DateError::Range(
            "roundingIncrement must be one of 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000"
                .into(),
        ));
    }
    let mode = request
        .string(
            "roundingMode",
            &ROUNDING_MODES,
            "roundingMode must be either \"ceil\", \"floor\", \"expand\", \"trunc\", \"halfCeil\", \"halfFloor\", \"halfExpand\", \"halfTrunc\", or \"halfEven\"",
        )?
        .unwrap_or_else(|| "halfExpand".into());
    let priority = request
        .string(
            "roundingPriority",
            &["auto", "morePrecision", "lessPrecision"],
            "roundingPriority must be either \"auto\", \"morePrecision\", or \"lessPrecision\"",
        )?
        .unwrap_or_else(|| "auto".into());
    let trailing = request.string(
        "trailingZeroDisplay",
        &["auto", "stripIfInteger"],
        "trailingZeroDisplay must be either \"auto\" or \"stripIfInteger\"",
    )?;
    let (min_default, max_default) = if increment != 1 { (0, 0) } else { (0, 3) };
    let has_significant = has("minimumSignificantDigits") || has("maximumSignificantDigits");
    let has_fraction = has("minimumFractionDigits") || has("maximumFractionDigits");
    let need_significant = priority != "auto" || has_significant;
    let need_fraction = priority != "auto" || !has_significant;
    let (mut min_significant, mut max_significant) = (1, 21);
    if need_significant && has_significant {
        let min = request
            .number("minimumSignificantDigits", 1.0, 21.0)?
            .unwrap_or(1.0);
        let max = request
            .number("maximumSignificantDigits", min, 21.0)?
            .unwrap_or(21.0);
        (min_significant, max_significant) = (min as i16, max as i16);
    }
    let (mut min_fraction, mut max_fraction) = (min_default, max_default);
    if need_fraction && has_fraction {
        let min = request.number("minimumFractionDigits", 0.0, 100.0)?;
        let max = request.number("maximumFractionDigits", 0.0, 100.0)?;
        (min_fraction, max_fraction) = match (min, max) {
            (None, Some(max)) => ((min_default as f64).min(max) as i16, max as i16),
            (Some(min), None) => (min as i16, (max_default as f64).max(min) as i16),
            (Some(min), Some(max)) if min > max => {
                return Err(DateError::Range(
                    "Computed minimumFractionDigits is larger than maximumFractionDigits".into(),
                ));
            }
            (Some(min), Some(max)) => (min as i16, max as i16),
            (None, None) => (min_default, max_default),
        };
    }
    let rounding = match priority.as_str() {
        "morePrecision" => RoundingType::MorePrecision,
        "lessPrecision" => RoundingType::LessPrecision,
        _ if has_significant => RoundingType::Significant,
        _ => RoundingType::Fraction,
    };
    if increment != 1 {
        if rounding != RoundingType::Fraction {
            return Err(DateError::Type(
                "rounding type is not fraction-digits while roundingIncrement is specified".into(),
            ));
        }
        if max_fraction != min_fraction {
            return Err(DateError::Range(
                "maximumFractionDigits and minimumFractionDigits are different while roundingIncrement is specified"
                    .into(),
            ));
        }
    }
    request.string(
        "compactDisplay",
        &["short", "long"],
        "compactDisplay must be either \"short\" or \"long\"",
    )?;
    let grouping = match request.get("useGrouping") {
        None => GroupingStrategy::Auto,
        Some(Prim::Bool(true)) => GroupingStrategy::Always,
        Some(value) if !value.truthy() => GroupingStrategy::Never,
        Some(value) => match value.text()?.as_str() {
            "true" | "false" | "auto" => GroupingStrategy::Auto,
            "always" => GroupingStrategy::Always,
            "min2" => GroupingStrategy::Min2,
            _ => {
                return Err(DateError::Range(
                    "useGrouping must be either true, false, \"min2\", \"auto\", or \"always\""
                        .into(),
                ));
            }
        },
    };
    let sign = match request
        .string(
            "signDisplay",
            &["auto", "never", "always", "exceptZero", "negative"],
            "signDisplay must be either \"auto\", \"never\", \"always\", \"exceptZero\", or \"negative\"",
        )?
        .as_deref()
    {
        Some("never") => SignDisplay::Never,
        Some("always") => SignDisplay::Always,
        Some("exceptZero") => SignDisplay::ExceptZero,
        Some("negative") => SignDisplay::Negative,
        _ => SignDisplay::Auto,
    };

    // Valid, but not formatted here: say so, rather than format it as something else.
    if style != "decimal" {
        return Err(DateError::Range(format!(
            "{}: style \"{style}\" is not supported in the Rust implementation, only \"decimal\"; format the number yourself, e.g. with toFixed",
            request.method
        )));
    }
    if notation != "standard" {
        return Err(DateError::Range(format!(
            "{}: notation \"{notation}\" is not supported in the Rust implementation, only \"standard\"",
            request.method
        )));
    }
    Ok(Resolved {
        min_integer,
        min_fraction,
        max_fraction,
        min_significant,
        max_significant,
        rounding,
        increment,
        mode: rounding_mode(&mode),
        strip_if_integer: trailing.as_deref() == Some("stripIfInteger"),
        grouping,
        sign,
        numbering_system,
    })
}

fn rounding_mode(name: &str) -> SignedRoundingMode {
    use UnsignedRoundingMode as U;
    match name {
        "ceil" => SignedRoundingMode::Ceil,
        "floor" => SignedRoundingMode::Floor,
        "expand" => SignedRoundingMode::Unsigned(U::Expand),
        "trunc" => SignedRoundingMode::Unsigned(U::Trunc),
        "halfCeil" => SignedRoundingMode::HalfCeil,
        "halfFloor" => SignedRoundingMode::HalfFloor,
        "halfTrunc" => SignedRoundingMode::Unsigned(U::HalfTrunc),
        "halfEven" => SignedRoundingMode::Unsigned(U::HalfEven),
        _ => SignedRoundingMode::Unsigned(U::HalfExpand),
    }
}

/// A Unicode locale `type`: subtags of 3 to 8 letters or digits, joined by `-`.
fn well_formed_type(value: &str) -> bool {
    value
        .split('-')
        .all(|s| (3..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// IsWellFormedUnitIdentifier: a sanctioned unit, or two joined by `-per-`.
fn well_formed_unit(unit: &str) -> bool {
    const SANCTIONED: [&str; 45] = [
        "acre",
        "bit",
        "byte",
        "celsius",
        "centimeter",
        "day",
        "degree",
        "fahrenheit",
        "fluid-ounce",
        "foot",
        "gallon",
        "gigabit",
        "gigabyte",
        "gram",
        "hectare",
        "hour",
        "inch",
        "kilobit",
        "kilobyte",
        "kilogram",
        "kilometer",
        "liter",
        "megabit",
        "megabyte",
        "meter",
        "microsecond",
        "mile",
        "mile-scandinavian",
        "milliliter",
        "millimeter",
        "millisecond",
        "minute",
        "month",
        "nanosecond",
        "ounce",
        "percent",
        "petabyte",
        "pound",
        "second",
        "stone",
        "terabit",
        "terabyte",
        "week",
        "yard",
        "year",
    ];
    if SANCTIONED.contains(&unit) {
        return true;
    }
    match unit.split_once("-per-") {
        Some((a, b)) => SANCTIONED.contains(&a) && SANCTIONED.contains(&b),
        None => false,
    }
}

/// `Number.prototype.toLocaleString` and `BigInt.prototype.toLocaleString` once their receiver is checked: `null`
/// locales or options fail as the reference's `formatLocale` does, then the arguments are read (see
/// `date::read_locale_args`) and the number formatted.
pub(crate) fn to_locale_string(
    vm: &mut crate::vm::Vm,
    input: Input,
    args: &[crate::value::Value],
    method: &'static str,
) -> crate::vm::Res {
    use crate::value::Value;
    let locales = args.first().copied().unwrap_or(Value::Undef);
    let options = args.get(1).copied().unwrap_or(Value::Undef);
    if matches!(locales, Value::Null) || matches!(options, Value::Null) {
        return Err(vm.type_error("Cannot convert undefined or null to object."));
    }
    let mut c = super::fuel::Conversions::default();
    let r = (|| {
        let (tags, opted) = super::date::read_locale_args(
            vm,
            &mut c,
            locales,
            options,
            &NUMBER_OPTIONS,
            None,
            numeric,
        )?;
        let mut options: Vec<Option<Prim>> = NUMBER_OPTIONS.iter().map(|_| None).collect();
        for (at, value) in opted {
            options[at] = match value {
                Value::Undef | Value::Uninit => None,
                Value::Null => Some(Prim::Null),
                Value::Bool(b) => Some(Prim::Bool(b)),
                Value::Num(n) => Some(Prim::Num(n)),
                Value::Str(s) => Some(Prim::Str(vm.text(s).to_owned())),
                Value::Big(id) => Some(Prim::Big(vm.big_text(id))),
                Value::Sym(_) => Some(Prim::Sym),
                // An opaque value the conversion kept, which the host reads by its text.
                Value::Obj(_) => {
                    let s = vm.string_of(&value)?;
                    Some(Prim::Obj(vm.text(s).to_owned()))
                }
            };
        }
        let request = Request {
            method,
            tags,
            options,
        };
        match format(&input, &request) {
            Ok(s) => Ok(vm.string_val(s)),
            Err(DateError::Range(message)) => Err(vm.range_error(&message)),
            Err(DateError::Type(message)) => Err(vm.type_error(&message)),
        }
    })();
    c.finish(vm, r)
}
