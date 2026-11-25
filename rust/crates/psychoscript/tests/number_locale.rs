//! What only Rust does in `Number.prototype.toLocaleString` and `BigInt.prototype.toLocaleString`: a style other than
//! `decimal`, or a notation other than `standard`, is refused with a RangeError that says so, once the options are
//! valid (an invalid value fails as the reference fails, which `conformance/number-locale.json` pins). The options
//! that only shape those styles are accepted with the decimal style, as the reference ignores them there.

use psychoscript::{Json, Runtime};
use serde_json::json;

fn run(code: &str) -> Json {
    match Runtime::make().execute(code).result {
        Ok(value) => value.to_json(),
        Err(d) => json!({ "uncaught": d.message_lossy() }),
    }
}

fn caught(call: &str) -> Json {
    run(&format!(
        "try {{ return {call} }} catch (e) {{ return [e.name, e.message] }}"
    ))
}

#[test]
fn styles_and_notations_rust_does_not_format_are_refused() {
    let refused = |method: &str, what: &str| {
        let only = if what.starts_with("style") {
            "only \"decimal\"; format the number yourself, e.g. with toFixed"
        } else {
            "only \"standard\""
        };
        json!([
            "RangeError",
            format!("{method}: {what} is not supported in the Rust implementation, {only}")
        ])
    };
    let number = "Number.prototype.toLocaleString";
    let bigint = "BigInt.prototype.toLocaleString";
    for (call, method, what) in [
        (
            r#"(0.5).toLocaleString("en-US", { style: "percent" })"#,
            number,
            r#"style "percent""#,
        ),
        (
            r#"(5).toLocaleString("en-US", { style: "currency", currency: "USD" })"#,
            number,
            r#"style "currency""#,
        ),
        (
            r#"(5).toLocaleString("de-DE", { style: "unit", unit: "kilometer-per-hour" })"#,
            number,
            r#"style "unit""#,
        ),
        (
            r#"(1234).toLocaleString("en-US", { notation: "compact" })"#,
            number,
            r#"notation "compact""#,
        ),
        (
            r#"(1234).toLocaleString("en-US", { notation: "scientific" })"#,
            number,
            r#"notation "scientific""#,
        ),
        (
            r#"(1234).toLocaleString(undefined, { notation: "engineering" })"#,
            number,
            r#"notation "engineering""#,
        ),
        (
            r#"(5n).toLocaleString("en-US", { style: "currency", currency: "EUR" })"#,
            bigint,
            r#"style "currency""#,
        ),
        (
            r#"(5n).toLocaleString("en-US", { notation: "compact", compactDisplay: "long" })"#,
            bigint,
            r#"notation "compact""#,
        ),
    ] {
        assert_eq!(caught(call), refused(method, what), "{call}");
    }
}

#[test]
fn an_invalid_option_fails_as_the_reference_does_before_the_refusal() {
    // The reference's own errors come first: a value it rejects, a currency style without a currency.
    assert_eq!(
        caught(r#"(5).toLocaleString("en-US", { style: "currency" })"#),
        json!(["TypeError", "currency must be a string"])
    );
    assert_eq!(
        caught(r#"(5).toLocaleString("en-US", { style: "percent", maximumFractionDigits: 101 })"#),
        json!(["RangeError", "maximumFractionDigits is out of range"])
    );
    assert_eq!(
        caught(r#"(5).toLocaleString("en-US", { notation: "compact", signDisplay: "bad" })"#),
        json!([
            "RangeError",
            "signDisplay must be either \"auto\", \"never\", \"always\", \"exceptZero\", or \"negative\""
        ])
    );
}

#[test]
fn the_options_of_other_styles_leave_the_decimal_style_as_it_is() {
    assert_eq!(
        run(
            r#"return (1234.5).toLocaleString("en-US", { currency: "USD", currencyDisplay: "name", unit: "meter", unitDisplay: "long", compactDisplay: "long" })"#
        ),
        json!("1,234.5")
    );
}

#[test]
fn an_uncaught_refusal_says_where() {
    let out = run(r#"const price = 5
return price.toLocaleString("en-US", { style: "currency", currency: "USD" })"#);
    let message = out["uncaught"].as_str().unwrap_or_default().to_owned();
    assert!(
        message.starts_with("RangeError: Number.prototype.toLocaleString: style \"currency\""),
        "{message}"
    );
    assert!(message.ends_with("(line 2, col 8)"), "{message}");
}
