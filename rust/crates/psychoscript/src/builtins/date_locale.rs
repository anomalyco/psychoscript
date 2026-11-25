//! `Date.prototype.toLocaleString`, `toLocaleDateString` and `toLocaleTimeString` through ICU4X, keeping step with
//! the reference, whose host `Intl.DateTimeFormat` is ICU4C under Bun.
//!
//! The reference reads the locale list and the 20 `Intl.DateTimeFormat` options through their getters, converts each
//! to a primitive (a string, `hour12` to a boolean, `fractionalSecondDigits` to a number), and hands them to the host.
//! This module is handed those already-converted values (see `date::locale_read`) together with the instant, resolves
//! the same way `Intl.DateTimeFormat` does, and formats with ICU4X's CLDR data.
//!
//! ICU4X expresses the ECMA-402 option model more coarsely than ICU4C does, so a few combinations render their
//! closest output rather than an exact one; the differences are recorded by `conformance/date-locale.ts` and replayed
//! by `bench/tests/date_locale.rs`.

use std::sync::OnceLock;

use icu_datetime::fieldsets::builder::{DateFields, FieldSetBuilder, ZoneStyle};
use icu_datetime::fieldsets::enums::CompositeFieldSet;
use icu_datetime::input::{TimeZone, UtcOffset, ZonedDateTime};
use icu_datetime::options::{Alignment, Length, SubsecondDigits, TimePrecision, YearStyle};
use icu_datetime::preferences::{CalendarAlgorithm, HijriCalendarAlgorithm, HourCycle};
use icu_datetime::{DateTimeFormatter, DateTimeFormatterPreferences};
use icu_locale_core::Locale;
use icu_time::zone::ZoneNameTimestamp;
use writeable::TryWriteable;

/// The three `toLocale*String` methods: they pick the defaults and which style conflicts are errors.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    DateTime,
    Date,
    Time,
}

/// A failure at option or locale resolution, named for the error the reference throws.
pub(crate) enum DateError {
    Range(String),
    Type(String),
}

impl DateError {
    fn range(message: impl Into<String>) -> Self {
        Self::Range(message.into())
    }
    fn ty(message: impl Into<String>) -> Self {
        Self::Type(message.into())
    }
}

/// The options `Intl.DateTimeFormat` reads, each already turned into its primitive (see `date::locale_read`);
/// `localeMatcher` and `formatMatcher` are read there for their getters but don't shape the output.
#[derive(Default)]
pub(crate) struct Options {
    pub calendar: Option<String>,
    pub hour12: Option<bool>,
    pub hour_cycle: Option<String>,
    pub time_zone: Option<String>,
    pub weekday: Option<String>,
    pub era: Option<String>,
    pub year: Option<String>,
    pub month: Option<String>,
    pub day: Option<String>,
    pub day_period: Option<String>,
    pub hour: Option<String>,
    pub minute: Option<String>,
    pub second: Option<String>,
    pub fractional_second_digits: Option<f64>,
    pub time_zone_name: Option<String>,
    pub date_style: Option<String>,
    pub time_style: Option<String>,
}

/// The locale tags and options a `toLocale*String` call resolved, in the reference's own read order.
pub(crate) struct Request {
    pub kind: Kind,
    /// The locale tags, converted to strings; empty means the host default (`en-US`).
    pub tags: Vec<String>,
    pub options: Options,
}

/// Formats `t` (milliseconds since the epoch) for the resolved locale and options.
///
/// The locale and options are validated before the date's validity is consulted, as `Intl` resolves them before it
/// formats: a bad time zone or field value throws even for an invalid Date, which otherwise reads "Invalid Date".
pub(crate) fn format(t: f64, request: &Request) -> Result<String, DateError> {
    let prefs = preferences(request)?;
    let zone = zone_at(request, t)?;
    // The instant as ICU4X sees it, projected into the requested (or host) zone. The displayed year picks the year
    // style below; the zone fields only matter when a time zone name is in the pattern.
    let secs = (t / 1000.0).floor().clamp(-8.64e12, 8.64e12) as i64;
    let base = ZonedDateTime::from_epoch_milliseconds_and_utc_offset(time_clip_ms(t), zone.offset);
    if !t.is_finite() {
        return Ok("Invalid Date".into());
    }
    if let Some(year) = two_digit_year_alone(request, &prefs, time_clip_ms(t), zone.offset) {
        return Ok(year);
    }
    let builder = resolve(request, base.date.year().extended_year())?;
    let Ok(fset) = builder.build_composite() else {
        // Every resolved request builds; Y/M/YM are promoted to a date field set below.
        return Ok("Invalid Date".into());
    };
    let Some(formatter) = formatter(prefs, fset) else {
        return Ok("Invalid Date".into());
    };
    let info = zone
        .time_zone
        .with_offset(Some(zone.offset))
        .with_zone_name_timestamp(ZoneNameTimestamp::from_epoch_seconds(secs));
    let input = ZonedDateTime {
        date: base.date,
        time: base.time,
        zone: info,
    };
    Ok(formatter
        .format(&input)
        .to_string()
        .replace('\u{202f}', " "))
}

// ---------- locale ----------

/// The locale of a `toLocale*String` call: its first tag, once every tag is valid, else the host default.
pub(crate) fn locale_of(tags: &[String]) -> Result<Locale, DateError> {
    let mut locale = None;
    for tag in tags {
        let Ok(parsed) = Locale::try_from_str(tag) else {
            return Err(DateError::range(format!("invalid language tag: {tag}")));
        };
        locale.get_or_insert(parsed);
    }
    // Bun's host default is en-US whatever the environment says.
    Ok(locale.unwrap_or_else(|| Locale::try_from_str("en-US").expect("en-US is a valid locale")))
}

fn preferences(request: &Request) -> Result<DateTimeFormatterPreferences, DateError> {
    let mut prefs = DateTimeFormatterPreferences::from(locale_of(&request.tags)?);
    if let Some(algorithm) = request
        .options
        .calendar
        .as_deref()
        .and_then(calendar_algorithm)
    {
        prefs.calendar_algorithm = Some(algorithm);
    }
    if let Some(cycle) = hour_cycle(&request.options)? {
        prefs.hour_cycle = Some(cycle);
    }
    Ok(prefs)
}

/// `hour12` (a boolean) wins over `hourCycle`; both resolve to the locale's own cycle when they only bound it.
fn hour_cycle(options: &Options) -> Result<Option<HourCycle>, DateError> {
    Ok(match (options.hour12, options.hour_cycle.as_deref()) {
        (Some(true), _) => Some(HourCycle::Clock12),
        (Some(false), _) => Some(HourCycle::Clock24),
        (None, None) => None,
        (None, Some("h11")) => Some(HourCycle::H11),
        (None, Some("h12")) => Some(HourCycle::H12),
        (None, Some("h23")) => Some(HourCycle::H23),
        // ICU4X has no h24; its closest 24-hour cycle is h23.
        (None, Some("h24")) => Some(HourCycle::H23),
        (None, Some(_)) => {
            return Err(DateError::range(
                "hourCycle must be \"h11\", \"h12\", \"h23\", or \"h24\"",
            ));
        }
    })
}

/// The ECMA-402 `calendar` values ICU4X knows, including its aliases; an unknown value is ignored, as the host does.
fn calendar_algorithm(value: &str) -> Option<CalendarAlgorithm> {
    use HijriCalendarAlgorithm::{Civil, Rgsa, Tbla, Umalqura};
    Some(match value {
        "buddhist" => CalendarAlgorithm::Buddhist,
        "chinese" => CalendarAlgorithm::Chinese,
        "coptic" => CalendarAlgorithm::Coptic,
        "dangi" => CalendarAlgorithm::Dangi,
        "ethioaa" | "ethiopic-amete-alem" => CalendarAlgorithm::Ethioaa,
        "ethiopic" => CalendarAlgorithm::Ethiopic,
        "gregory" | "gregorian" => CalendarAlgorithm::Gregory,
        "hebrew" => CalendarAlgorithm::Hebrew,
        "indian" => CalendarAlgorithm::Indian,
        "islamic" => CalendarAlgorithm::Hijri(None),
        "islamic-umalqura" => CalendarAlgorithm::Hijri(Some(Umalqura)),
        "islamic-tbla" => CalendarAlgorithm::Hijri(Some(Tbla)),
        "islamic-civil" | "islamicc" => CalendarAlgorithm::Hijri(Some(Civil)),
        "islamic-rgsa" => CalendarAlgorithm::Hijri(Some(Rgsa)),
        "iso8601" => CalendarAlgorithm::Iso8601,
        "japanese" => CalendarAlgorithm::Japanese,
        "persian" => CalendarAlgorithm::Persian,
        "roc" => CalendarAlgorithm::Roc,
        _ => return None,
    })
}

// ---------- field resolution ----------

/// The widths the per-field options take.
#[derive(Clone, Copy, PartialEq)]
enum Font {
    Narrow,
    Short,
    Long,
}
#[derive(Clone, Copy, PartialEq)]
enum Digits {
    Numeric,
    TwoDigit,
}
#[derive(Clone, Copy, PartialEq)]
enum Month {
    Numeric,
    TwoDigit,
    Narrow,
    Short,
    Long,
}

fn three(value: Option<&str>, key: &str) -> Result<Option<Font>, DateError> {
    match value {
        None => Ok(None),
        Some("narrow") => Ok(Some(Font::Narrow)),
        Some("short") => Ok(Some(Font::Short)),
        Some("long") => Ok(Some(Font::Long)),
        Some(_) => Err(DateError::range(format!(
            "{key} must be \"narrow\", \"short\", or \"long\""
        ))),
    }
}

fn two(value: Option<&str>, key: &str) -> Result<Option<Digits>, DateError> {
    match value {
        None => Ok(None),
        Some("2-digit") => Ok(Some(Digits::TwoDigit)),
        Some("numeric") => Ok(Some(Digits::Numeric)),
        Some(_) => Err(DateError::range(format!(
            "{key} must be \"2-digit\" or \"numeric\""
        ))),
    }
}

fn month(value: Option<&str>) -> Result<Option<Month>, DateError> {
    match value {
        None => Ok(None),
        Some("2-digit") => Ok(Some(Month::TwoDigit)),
        Some("numeric") => Ok(Some(Month::Numeric)),
        Some("narrow") => Ok(Some(Month::Narrow)),
        Some("short") => Ok(Some(Month::Short)),
        Some("long") => Ok(Some(Month::Long)),
        Some(_) => Err(DateError::range(
            "month must be \"2-digit\", \"numeric\", \"narrow\", \"short\", or \"long\"",
        )),
    }
}

fn zone_style(value: Option<&str>) -> Result<Option<ZoneStyle>, DateError> {
    match value {
        None => Ok(None),
        Some("short") => Ok(Some(ZoneStyle::SpecificShort)),
        Some("long") => Ok(Some(ZoneStyle::SpecificLong)),
        Some("shortOffset") => Ok(Some(ZoneStyle::LocalizedOffsetShort)),
        Some("longOffset") => Ok(Some(ZoneStyle::LocalizedOffsetLong)),
        Some("shortGeneric") => Ok(Some(ZoneStyle::GenericShort)),
        Some("longGeneric") => Ok(Some(ZoneStyle::GenericLong)),
        Some(_) => Err(DateError::range(
            "timeZoneName must be \"short\", \"long\", \"shortOffset\", \"longOffset\", \"shortGeneric\", or \"longGeneric\"",
        )),
    }
}

fn fractional(value: Option<f64>) -> Result<Option<SubsecondDigits>, DateError> {
    let Some(value) = value else { return Ok(None) };
    let value = value.floor();
    // `GetNumberOption` floors and requires 1..=3.
    if !(1.0..=3.0).contains(&value) {
        return Err(DateError::range("fractionalSecondDigits is out of range"));
    }
    Ok(Some(match value as u8 {
        1 => SubsecondDigits::S1,
        2 => SubsecondDigits::S2,
        _ => SubsecondDigits::S3,
    }))
}

/// Resolves the options against the method (requirements and defaults) into an ICU4X field-set builder. The displayed
/// ISO year picks the numeric-year style, which differs from the reference only for years under 1000.
fn resolve(request: &Request, iso_year: i32) -> Result<FieldSetBuilder, DateError> {
    if let Some(styles) = resolve_styles(request)? {
        return Ok(styles);
    }
    resolve_fields(request, iso_year)
}

/// `{ year: "numeric" }` never shows an era in the reference; ICU4X's `Full` shows one for years under 1000, and its
/// `NoEra` shortens the present century, so pick per year: full for a four-digit year, no era otherwise.
fn numeric_year_style(iso_year: i32) -> YearStyle {
    if iso_year >= 1000 {
        YearStyle::Full
    } else {
        YearStyle::NoEra
    }
}

/// The `dateStyle`/`timeStyle` path; `None` when neither is present.
fn resolve_styles(request: &Request) -> Result<Option<FieldSetBuilder>, DateError> {
    let o = &request.options;
    let date_style = style(o.date_style.as_deref(), "dateStyle")?;
    let time_style = style(o.time_style.as_deref(), "timeStyle")?;
    if date_style.is_none() && time_style.is_none() {
        return Ok(None);
    }
    let explicit = o.weekday.is_some()
        || o.era.is_some()
        || o.year.is_some()
        || o.month.is_some()
        || o.day.is_some()
        || o.day_period.is_some()
        || o.hour.is_some()
        || o.minute.is_some()
        || o.second.is_some()
        || o.fractional_second_digits.is_some()
        || o.time_zone_name.is_some();
    if explicit {
        return Err(DateError::ty(
            "dateStyle and timeStyle may not be used with other DateTimeFormat options",
        ));
    }
    if request.kind == Kind::Time && date_style.is_some() {
        return Err(DateError::ty(
            "dateStyle is specified while formatting time is requested",
        ));
    }
    if request.kind == Kind::Date && time_style.is_some() {
        return Err(DateError::ty(
            "timeStyle is specified while formatting date is requested",
        ));
    }
    let mut builder = FieldSetBuilder::default();
    match date_style {
        Some("full") => {
            builder.length = Some(Length::Long);
            builder.date_fields = Some(DateFields::YMDE);
            builder.year_style = Some(YearStyle::Full);
        }
        Some("long") => {
            builder.length = Some(Length::Long);
            builder.date_fields = Some(DateFields::YMD);
            builder.year_style = Some(YearStyle::Full);
        }
        Some("medium") => {
            builder.length = Some(Length::Medium);
            builder.date_fields = Some(DateFields::YMD);
            builder.year_style = Some(YearStyle::Full);
        }
        Some("short") => {
            builder.length = Some(Length::Short);
            builder.date_fields = Some(DateFields::YMD);
            builder.year_style = Some(YearStyle::Auto);
        }
        _ => {}
    }
    match time_style {
        Some("full") => {
            builder.time_precision = Some(TimePrecision::Second);
            builder.zone_style = Some(ZoneStyle::SpecificLong);
        }
        Some("long") => {
            builder.time_precision = Some(TimePrecision::Second);
            builder.zone_style = Some(ZoneStyle::SpecificShort);
        }
        Some("medium") => builder.time_precision = Some(TimePrecision::Second),
        Some("short") => builder.time_precision = Some(TimePrecision::Minute),
        _ => {}
    }
    Ok(Some(builder))
}

fn style<'a>(value: Option<&'a str>, key: &str) -> Result<Option<&'a str>, DateError> {
    match value {
        None | Some("full") | Some("long") | Some("medium") | Some("short") => Ok(value),
        Some(_) => Err(DateError::range(format!(
            "{key} must be \"full\", \"long\", \"medium\", or \"short\""
        ))),
    }
}

fn resolve_fields(request: &Request, iso_year: i32) -> Result<FieldSetBuilder, DateError> {
    let o = &request.options;
    let weekday = three(o.weekday.as_deref(), "weekday")?;
    let era = three(o.era.as_deref(), "era")?;
    let mut year = two(o.year.as_deref(), "year")?;
    let mut month = month(o.month.as_deref())?;
    let mut day = two(o.day.as_deref(), "day")?;
    let day_period = three(o.day_period.as_deref(), "dayPeriod")?;
    let mut hour = two(o.hour.as_deref(), "hour")?;
    let mut minute = two(o.minute.as_deref(), "minute")?;
    let mut second = two(o.second.as_deref(), "second")?;
    let fractional = fractional(o.fractional_second_digits)?;
    let zone_style = zone_style(o.time_zone_name.as_deref())?;

    // The method's `required` picks which fields can stop the defaults, and its `defaults` picks which the defaults
    // fill. `era` (and `timeZoneName` for the date side) never stop them.
    let date_gate = matches!(request.kind, Kind::DateTime | Kind::Date);
    let time_gate = matches!(request.kind, Kind::DateTime | Kind::Time);
    let mut need_defaults = true;
    if date_gate && (weekday.is_some() || year.is_some() || month.is_some() || day.is_some()) {
        need_defaults = false;
    }
    if time_gate
        && (day_period.is_some()
            || hour.is_some()
            || minute.is_some()
            || second.is_some()
            || fractional.is_some())
    {
        need_defaults = false;
    }
    if need_defaults {
        let date_defaults = matches!(request.kind, Kind::DateTime | Kind::Date);
        let time_defaults = matches!(request.kind, Kind::DateTime | Kind::Time);
        if date_defaults {
            year = Some(Digits::Numeric);
            month = Some(Month::Numeric);
            day = Some(Digits::Numeric);
        }
        if time_defaults {
            hour = Some(Digits::Numeric);
            minute = Some(Digits::Numeric);
            second = Some(Digits::Numeric);
        }
    }

    let mut date_fields = date_fields(
        era.is_some(),
        year.is_some(),
        month.is_some(),
        day.is_some(),
        weekday.is_some(),
    );
    let length = {
        let long = month == Some(Month::Long)
            || weekday == Some(Font::Long)
            || day_period == Some(Font::Long);
        let medium = matches!(month, Some(Month::Short | Month::Narrow))
            || matches!(weekday, Some(Font::Short | Font::Narrow))
            || matches!(day_period, Some(Font::Short | Font::Narrow));
        let short = matches!(month, Some(Month::Numeric | Month::TwoDigit));
        if long {
            Some(Length::Long)
        } else if medium {
            Some(Length::Medium)
        } else if short {
            Some(Length::Short)
        } else {
            None
        }
    };
    let alignment = if month == Some(Month::TwoDigit)
        || day == Some(Digits::TwoDigit)
        || hour == Some(Digits::TwoDigit)
    {
        Some(Alignment::Column)
    } else {
        None
    };
    let year_style = if era.is_some() {
        Some(YearStyle::WithEra)
    } else {
        match year {
            Some(Digits::Numeric) => Some(numeric_year_style(iso_year)),
            Some(Digits::TwoDigit) => Some(YearStyle::Auto),
            None => None,
        }
    };
    let time_precision = if let Some(digits) = fractional {
        Some(TimePrecision::Subsecond(digits))
    } else if second.is_some() {
        Some(TimePrecision::Second)
    } else if minute.is_some() {
        Some(TimePrecision::Minute)
    } else if hour.is_some() || day_period.is_some() {
        Some(TimePrecision::Hour)
    } else {
        None
    };

    // A year, month or year-month field set cannot be combined with a time or zone in ICU4X; widen it to year, month
    // and day (as the reference's field bag does), which the differences list notes when it shows extra fields.
    if let Some(df) = date_fields
        && df.is_calendar_period()
        && (time_precision.is_some() || zone_style.is_some())
    {
        date_fields = Some(DateFields::YMD);
    }

    let mut builder = FieldSetBuilder::default();
    builder.length = length;
    builder.date_fields = date_fields;
    builder.time_precision = time_precision;
    builder.zone_style = zone_style;
    builder.alignment = alignment;
    builder.year_style = year_style;
    Ok(builder)
}

/// The date field set from which date-side fields are shown, as ICU4X's field bag maps them; `era` only appears
/// alongside a year, so it implies the year field here.
fn date_fields(era: bool, year: bool, month: bool, day: bool, weekday: bool) -> Option<DateFields> {
    let (e, y, m, d, w) = (era, year, month, day, weekday);
    if !e && !y && !m && !d && !w {
        None
    } else if !m && !d && !w {
        Some(DateFields::Y)
    } else if !e && !y && !d && !w {
        Some(DateFields::M)
    } else if !d && !w {
        Some(DateFields::YM)
    } else if !e && !y && !m && !w {
        Some(DateFields::D)
    } else if !e && !y && !w {
        Some(DateFields::MD)
    } else if !w {
        Some(DateFields::YMD)
    } else if !e && !y && !m && !d {
        Some(DateFields::E)
    } else if !e && !y && !m {
        Some(DateFields::DE)
    } else if !e && !y {
        Some(DateFields::MDE)
    } else {
        Some(DateFields::YMDE)
    }
}

// ---------- time zone ----------

/// The instant's offset and IANA identity in the requested zone (or the host's local zone).
struct Zone {
    time_zone: TimeZone,
    offset: UtcOffset,
}

/// The host time zone, resolved once: `TZ` if it names a time zone, else `/etc/localtime`.
fn local_zone() -> &'static tz::TimeZone {
    static ZONE: OnceLock<Option<tz::TimeZone>> = OnceLock::new();
    ZONE.get_or_init(|| {
        let from_env = std::env::var("TZ")
            .ok()
            .filter(|s| !s.is_empty())
            .and_then(|s| tz::TimeZone::from_posix_tz(&s).ok());
        from_env.or_else(|| tz::TimeZone::local().ok())
    })
    .as_ref()
    .expect("a host time zone is resolvable")
}

fn zone_at(request: &Request, t: f64) -> Result<Zone, DateError> {
    let name = request.options.time_zone.as_deref();
    let secs = (t / 1000.0).floor().clamp(-8.64e12, 8.64e12) as i64;
    match name {
        Some(name) => {
            // `timeZone` names a time zone; an unknown name is a range error, as the host throws.
            let Some(zone) = tz::TimeZone::from_posix_tz(name).ok() else {
                return Err(DateError::range(format!("invalid time zone: {name}")));
            };
            Ok(Zone {
                time_zone: TimeZone::from_iana_id(name),
                offset: offset_of(&zone, secs),
            })
        }
        None => {
            // The host's own zone. When it is UTC the reference reads `UTC` as the zone's name.
            let offset = offset_of(local_zone(), secs);
            let time_zone = if offset == UtcOffset::zero() {
                TimeZone::from_iana_id("UTC")
            } else {
                TimeZone::UNKNOWN
            };
            Ok(Zone { time_zone, offset })
        }
    }
}

fn offset_of(zone: &tz::TimeZone, secs: i64) -> UtcOffset {
    let seconds = zone
        .find_local_time_type(secs)
        .map(|lt| lt.ut_offset())
        .unwrap_or(0);
    UtcOffset::try_from_seconds(seconds).unwrap_or_else(|_| UtcOffset::zero())
}

fn time_clip_ms(t: f64) -> i64 {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return 0;
    }
    t.trunc() as i64
}

// ---------- formatting ----------

fn formatter(
    prefs: DateTimeFormatterPreferences,
    fset: CompositeFieldSet,
) -> Option<DateTimeFormatter<CompositeFieldSet>> {
    DateTimeFormatter::try_new(prefs, fset).ok().or_else(|| {
        // A resolved locale should always load; fall back to en-US rather than fail a valid call.
        let en_us = Locale::try_from_str("en-US").ok()?;
        DateTimeFormatter::try_new(DateTimeFormatterPreferences::from(en_us), fset).ok()
    })
}

/// `{ year: "2-digit" }` on its own: the reference always prints two digits, but ICU4X's field sets render the year
/// alone in full, so format the invariant `yy` pattern directly, with the Gregorian calendar and the locale's digits.
#[allow(deprecated)] // `CalendarPreferences::resolved_algorithm` has no replacement yet.
fn two_digit_year_alone(
    request: &Request,
    prefs: &DateTimeFormatterPreferences,
    ms: i64,
    offset: UtcOffset,
) -> Option<String> {
    use icu_calendar::Gregorian;
    use icu_datetime::pattern::{DateTimePattern, FixedCalendarDateTimeNames};
    let o = &request.options;
    if request.kind == Kind::Time
        || o.year.as_deref() != Some("2-digit")
        || o.era.is_some()
        || o.month.is_some()
        || o.day.is_some()
        || o.weekday.is_some()
        || o.day_period.is_some()
        || o.hour.is_some()
        || o.minute.is_some()
        || o.second.is_some()
        || o.fractional_second_digits.is_some()
        || o.time_zone_name.is_some()
        || o.date_style.is_some()
        || o.time_style.is_some()
    {
        return None;
    }
    use icu_calendar::preferences::CalendarPreferences;
    let calendar = CalendarPreferences::from(prefs).resolved_algorithm();
    if !matches!(
        calendar,
        CalendarAlgorithm::Gregory | CalendarAlgorithm::Iso8601
    ) {
        return None;
    }
    let mut names = FixedCalendarDateTimeNames::<Gregorian>::try_new(*prefs).ok()?;
    let pattern = DateTimePattern::try_from_pattern_str("yy").ok()?;
    let formatter = names.include_for_pattern(&pattern).ok()?;
    let base = ZonedDateTime::from_epoch_milliseconds_and_utc_offset(ms, offset);
    let input = icu_datetime::input::DateTime {
        date: base.date.to_calendar(Gregorian),
        time: base.time,
    };
    Some(
        formatter
            .format(&input)
            .try_write_to_string()
            .ok()?
            .into_owned(),
    )
}
