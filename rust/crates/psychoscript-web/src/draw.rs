//! A live draw post's commands, checked when the program posts them (widgets.md, Canvas; widgets-live.md): the rules
//! and messages of the other Rust hosts (Rune's `Command::from_value`, psychoscript-mobile's `widget-wire`), so a
//! command one host rejects every host rejects alike.

use psychoscript::HostValue;

/// The most commands a draw may have (widgets-live.md, "Lifecycle and budgets").
pub(crate) const MAX_COMMANDS: usize = 2000;

/// Checks a draw post's `commands`; the error is the invalid post's message.
pub(crate) fn check(commands: Option<&HostValue>) -> Result<(), String> {
    let Some(commands) = commands.filter(|c| !matches!(c, HostValue::Undefined)) else {
        return Err("a draw post needs commands".into());
    };
    let HostValue::Array(list) = commands else {
        return Err("draw commands must be a list".into());
    };
    if list.len() > MAX_COMMANDS {
        return Err(format!(
            "{} draw commands is over the budget of {MAX_COMMANDS} per frame",
            list.len()
        ));
    }
    for (i, c) in list.iter().enumerate() {
        command(c).map_err(|e| format!("draw command {i}: {e}"))?;
    }
    Ok(())
}

type Item = Option<HostValue>;

fn field<'a>(v: &'a HostValue, key: &str) -> Option<&'a HostValue> {
    v.get(key).filter(|v| !matches!(v, HostValue::Undefined))
}

/// A field unless JSON writes it as `null` or leaves it out (`undefined`, `null`, a non-finite number).
fn present<'a>(v: &'a HostValue, key: &str) -> Option<&'a HostValue> {
    field(v, key).filter(|v| match v {
        HostValue::Null => false,
        HostValue::Number(n) => n.is_finite(),
        _ => true,
    })
}

fn num(v: Option<&Item>, what: &str) -> Result<(), String> {
    match v {
        Some(Some(HostValue::Number(n))) if n.is_finite() => Ok(()),
        _ => Err(format!("{what} must be a finite number")),
    }
}

/// A theme token or `#rgb`, `#rrggbb`, `#rrggbbaa`.
fn color(v: &HostValue) -> Result<(), String> {
    let ok = match v {
        HostValue::String(s) => {
            let s = s.to_string_lossy();
            match s.strip_prefix('#') {
                None => matches!(
                    &*s,
                    "text"
                        | "muted"
                        | "accent"
                        | "bg"
                        | "surface"
                        | "border"
                        | "success"
                        | "warning"
                        | "error"
                ),
                Some(hex) => {
                    matches!(hex.len(), 3 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
                }
            }
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err("not a color".into())
    }
}

fn gradient(m: &HostValue) -> Result<(), String> {
    let coords = |key: &str, n: usize| -> Result<bool, String> {
        let Some(a) = field(m, key) else {
            return Ok(false);
        };
        match a {
            HostValue::Array(a) if a.len() == n => {
                a.iter().try_for_each(|x| num(Some(x), key))?;
                Ok(true)
            }
            _ => Err(format!("a {key} gradient takes {n} numbers")),
        }
    };
    // Both are checked, as the other hosts do.
    let (linear, radial) = (coords("linear", 4)?, coords("radial", 3)?);
    if !linear && !radial {
        return Err("a gradient needs linear or radial".into());
    }
    let Some(HostValue::Array(stops)) = field(m, "stops") else {
        return Err("a gradient needs stops".into());
    };
    for stop in stops {
        match stop {
            Some(HostValue::Array(p)) if p.len() == 2 => {
                num(p.first(), "a stop's offset")?;
                color(p[1].as_ref().unwrap_or(&HostValue::Null))?;
            }
            _ => return Err("a stop is [offset, color]".into()),
        }
    }
    Ok(())
}

fn paint(v: Option<&Item>) -> Result<(), String> {
    let Some(Some(m @ HostValue::Object(_))) = v else {
        return Err("a paint is an object".into());
    };
    match present(m, "fill") {
        None => {}
        Some(g @ HostValue::Object(_)) => gradient(g)?,
        Some(c) => color(c)?,
    }
    if let Some(c) = present(m, "stroke") {
        color(c)?;
    }
    match present(m, "width") {
        None | Some(HostValue::Number(_)) => Ok(()),
        Some(_) => Err("a stroke's width must be a finite number".into()),
    }
}

fn text_options(v: Option<&Item>) -> Result<(), String> {
    let Some(Some(m @ HostValue::Object(_))) = v else {
        return Ok(());
    };
    match present(m, "size") {
        None | Some(HostValue::Number(_)) => {}
        Some(_) => return Err("a text size must be a finite number".into()),
    }
    if let Some(c) = present(m, "color") {
        color(c)?;
    }
    Ok(())
}

fn command(v: &Item) -> Result<(), String> {
    let Some(HostValue::Array(a)) = v else {
        return Err("a command is an array".into());
    };
    let op = a
        .first()
        .and_then(|v| v.as_ref())
        .and_then(HostValue::as_str)
        .ok_or("a command starts with its name")?;
    let n = |i: usize| num(a.get(i), &format!("\"{op}\" argument {i}"));
    match op {
        "save" | "restore" => {}
        "translate" | "scale" => {
            n(1)?;
            n(2)?;
        }
        "rotate" | "alpha" => n(1)?,
        "rect" | "rrect" | "circle" | "line" => {
            let count = match op {
                "rect" | "line" => 4,
                "rrect" => 5,
                _ => 3,
            };
            (1..=count).try_for_each(n)?;
            paint(a.get(count + 1))?;
        }
        "path" => {
            let Some(Some(HostValue::Array(segments))) = a.get(1) else {
                return Err("\"path\" takes a list of segments".into());
            };
            for s in segments {
                let Some(HostValue::Array(s)) = s else {
                    return Err("a path segment is an array".into());
                };
                let count = match s
                    .first()
                    .and_then(|v| v.as_ref())
                    .and_then(HostValue::as_str)
                {
                    Some("M" | "L") => 2,
                    Some("Q") => 4,
                    Some("C") => 6,
                    Some("Z") => 0,
                    _ => return Err("unknown path segment".into()),
                };
                (1..=count).try_for_each(|i| num(s.get(i), "a path coordinate"))?;
            }
            paint(a.get(2))?;
        }
        "text" => {
            n(1)?;
            n(2)?;
            if a.get(3).is_none() {
                return Err("\"text\" is missing argument 3".into());
            }
            text_options(a.get(4))?;
        }
        "image" => {
            if !matches!(a.get(1), Some(Some(HostValue::String(_)))) {
                return Err("\"image\" takes a src".into());
            }
            (2..=5).try_for_each(n)?;
        }
        _ => return Err(format!("unknown draw command \"{op}\"")),
    }
    Ok(())
}
