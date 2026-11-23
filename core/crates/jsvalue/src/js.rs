//! What the JS reader leaned on the language for: truthiness, `String()`, `Number()`, the spelling of a number and the
//! renaming of a key.

use crate::value::{Text, Value};

/// `a === b`, undefined being `None`. Two objects or arrays are the same one only by identity, which nothing parsed has.
pub fn strict_equals(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Array(_) | Value::Object(_)), _) | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `Number.isSafeInteger(value)`.
pub fn is_safe_integer(value: &Value) -> bool {
    const LARGEST: f64 = 9_007_199_254_740_991.0;
    matches!(value, Value::Number(number) if number.fract() == 0.0 && number.abs() <= LARGEST)
}

/// Whether JS takes `value` as true.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(text) => !text.as_bytes().is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value`, unless it is null or undefined: the left of a `??`.
pub fn given(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| **value != Value::Null)
}

/// An object's own `toString` key: JSON can't make it callable, so JS finds no string in that object, and throws.
fn has_no_string(value: &Value) -> bool {
    value.field("toString").is_some()
}

/// `String(value)`, or the JS's TypeError.
pub fn to_text(value: &Value) -> Result<Text, String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string().as_str().into(),
        Value::Number(number) => number_text(*number).as_str().into(),
        Value::String(text) => text.clone(),
        Value::Array(items) => join(items, ",")?,
        Value::Object(_) if has_no_string(value) => return Err("an object has no string".into()),
        Value::Object(_) => "[object Object]".into(),
    })
}

/// `items.join(separator)`: null is empty, and everything else as `String` has it.
pub fn join(items: &[Value], separator: &str) -> Result<Text, String> {
    let mut joined = Text::default();
    for (at, item) in items.iter().enumerate() {
        if at > 0 {
            joined.push_str(separator);
        }
        if *item != Value::Null {
            joined.push_text(&to_text(item)?);
        }
    }
    Ok(joined)
}

/// `Number(value)`, undefined being NaN, or the JS's TypeError.
pub fn to_number(value: Option<&Value>) -> Result<f64, String> {
    Ok(match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => *number,
        Some(other) => text_number(&to_text(other)?.lossy()),
    })
}

/// Whitespace as JS trims it, which isn't Rust's: U+FEFF is in, and U+0085 is out.
fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `Number(text)`.
fn text_number(text: &str) -> f64 {
    let text = text.trim_matches(is_js_space);
    if text.is_empty() {
        return 0.0;
    }
    let prefix = text.get(..2).unwrap_or("").to_ascii_lowercase();
    let radix = match prefix.as_str() {
        "0x" => 16,
        "0o" => 8,
        "0b" => 2,
        _ => return decimal_number(text),
    };
    // past 2^53 this rounds at each digit, where JS rounds once, by a unit in the last place at most
    let digits = text[2..].chars().map(|c| c.to_digit(radix).map(f64::from));
    match digits.collect::<Option<Vec<_>>>() {
        Some(digits) if !digits.is_empty() => digits.iter().fold(0.0, |number, digit| number * f64::from(radix) + digit),
        _ => f64::NAN,
    }
}

/// A decimal `Number()` reads: an optional sign, and `Infinity` or digits with an optional point and exponent. Rust's parse
/// also takes `inf` and `nan`, which is why it is asked only about what starts like a number; it rounds as JS does.
fn decimal_number(text: &str) -> f64 {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if !unsigned.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// `String(number)`: the shortest digits that read back as `number`, in the layout ECMAScript sets out.
pub fn number_text(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number == 0.0 {
        return "0".into();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("{:e} writes an exponent");
    let digits = mantissa.replace('.', "");
    let exponent: i32 = exponent.parse().expect("an exponent is a number");
    let places = exponent + 1;
    let count = digits.len() as i32;
    let body = if (count..=21).contains(&places) {
        format!("{digits}{}", "0".repeat((places - count) as usize))
    } else if (1..=21).contains(&places) {
        format!("{}.{}", &digits[..places as usize], &digits[places as usize..])
    } else if (-5..=0).contains(&places) {
        format!("0.{}{digits}", "0".repeat(-places as usize))
    } else {
        let sign = if exponent < 0 { '-' } else { '+' };
        let tail = if count > 1 { format!(".{}", &digits[1..]) } else { String::new() };
        format!("{}{tail}e{sign}{}", &digits[..1], exponent.abs())
    };
    if number < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// `text.replace(/_([a-z0-9])/g, upper)`: a key (or an enum-like value) as the app-server's v2 protocol spells it.
pub fn camel(text: &Text) -> Text {
    let bytes = text.as_bytes();
    if !bytes.contains(&b'_') {
        return text.clone();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes.get(at + 1) {
            Some(&next @ (b'a'..=b'z' | b'0'..=b'9')) if bytes[at] == b'_' => {
                out.push(next.to_ascii_uppercase());
                at += 2;
            }
            _ => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    let mut camel = Text::default();
    camel.push_bytes(&out);
    camel
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn value(text: &str) -> Value {
        parse(text).expect("JSON")
    }

    #[test]
    fn truthiness_is_js_truthiness() {
        for yes in ["true", "1", "-1", "\"0\"", "[]", "{}"] {
            assert!(truthy(&value(yes)), "{yes}");
        }
        for no in ["false", "0", "-0", "\"\"", "null"] {
            assert!(!truthy(&value(no)), "{no}");
        }
        assert!(!truthy(&Value::Number(f64::NAN)));
    }

    #[test]
    fn strict_equality_has_no_coercion_and_no_identity_for_a_parse() {
        for (a, b) in [("1", "1"), ("\"a\"", "\"a\""), ("null", "null"), ("true", "true"), ("0", "-0")] {
            assert!(strict_equals(Some(&value(a)), Some(&value(b))), "{a} {b}");
        }
        for (a, b) in [("1", "\"1\""), ("null", "false"), ("0", "false"), ("[]", "[]"), ("{}", "{}"), ("[]", "1"), ("1", "{}")] {
            assert!(!strict_equals(Some(&value(a)), Some(&value(b))), "{a} {b}");
        }
        assert!(strict_equals(None, None));
        assert!(!strict_equals(None, Some(&Value::Null)));
        assert!(!strict_equals(Some(&Value::Null), None));
        assert!(!strict_equals(Some(&Value::Number(f64::NAN)), Some(&Value::Number(f64::NAN))));
    }

    #[test]
    fn safe_integers_stop_at_two_to_the_53() {
        for yes in ["0", "-0", "7", "-7", "9007199254740991", "-9007199254740991", "1e3"] {
            assert!(is_safe_integer(&value(yes)), "{yes}");
        }
        for no in ["1.5", "9007199254740992", "-9007199254740992", "1e21", "\"7\"", "null", "true"] {
            assert!(!is_safe_integer(&value(no)), "{no}");
        }
        assert!(!is_safe_integer(&Value::Number(f64::INFINITY)));
        assert!(!is_safe_integer(&Value::Number(f64::NAN)));
    }

    #[test]
    fn nullish_is_only_null_and_undefined() {
        assert_eq!(given(None), None);
        assert_eq!(given(Some(&Value::Null)), None);
        assert_eq!(given(Some(&Value::Bool(false))), Some(&Value::Bool(false)));
    }

    #[test]
    fn strings_of_values_are_js_strings() {
        for (json, text) in [
            ("null", "null"),
            ("true", "true"),
            ("false", "false"),
            ("1.5", "1.5"),
            ("\"s\"", "s"),
            ("{}", "[object Object]"),
            ("[]", ""),
            ("[1,null,[2,[3]],\"a\",{}]", "1,,2,3,a,[object Object]"),
        ] {
            assert_eq!(to_text(&value(json)), Ok(Text::from(text)), "{json}");
        }
        assert_eq!(join(&[value("1"), Value::Null, value("\"x\"")], " "), Ok(Text::from("1  x")));
        for bad in [r#"{"toString":1}"#, r#"[[{"toString":null}]]"#] {
            assert!(to_text(&value(bad)).is_err(), "{bad}");
            assert!(to_number(Some(&value(bad))).is_err(), "{bad}");
        }
    }

    #[test]
    fn numbers_of_values_are_js_numbers() {
        assert_eq!(to_number(None).map(f64::is_nan), Ok(true));
        assert_eq!(to_number(Some(&value("{}"))).map(f64::is_nan), Ok(true));
        for (json, number) in [
            ("null", 0.0),
            ("true", 1.0),
            ("false", 0.0),
            ("2.5", 2.5),
            ("\"\"", 0.0),
            ("\"  12 \\n\"", 12.0),
            ("\"\\ufeff7\\u00a0\"", 7.0),
            ("[]", 0.0),
            ("[5]", 5.0),
            ("\"+1.5e1\"", 15.0),
            ("\"-.5\"", -0.5),
            ("\"1.\"", 1.0),
            ("\"Infinity\"", f64::INFINITY),
            ("\"+Infinity\"", f64::INFINITY),
            ("\"-Infinity\"", f64::NEG_INFINITY),
            ("\"0x1F\"", 31.0),
            ("\"0O17\"", 15.0),
            ("\"0b101\"", 5.0),
        ] {
            assert_eq!(to_number(Some(&value(json))), Ok(number), "{json}");
        }
        for json in [
            "[1,2]",
            "\"x\"",
            "\"0x\"",
            "\"0xg\"",
            "\"-0x10\"",
            "\"1a\"",
            "\"inf\"",
            "\"nan\"",
            "\"infinity\"",
            "\"-\"",
            "\"1e\"",
            "\"\\u0085 1\"",
        ] {
            assert_eq!(to_number(Some(&value(json))).map(f64::is_nan), Ok(true), "{json}");
        }
    }

    #[test]
    fn numbers_are_spelled_as_js_spells_them() {
        for (number, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (123456.789, "123456.789"),
            (100.0, "100"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1.2345678901234567e19, "12345678901234567000"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (0.0000015, "0.0000015"),
            (1e-7, "1e-7"),
            (-1.5e-7, "-1.5e-7"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(number_text(number), text);
        }
    }

    #[test]
    fn keys_are_renamed_as_the_regex_renames_them() {
        for (key, renamed) in [
            ("plain", "plain"),
            ("a_b", "aB"),
            ("a_b_c", "aBC"),
            ("a__b", "a_B"),
            ("__proto__", "_Proto__"),
            ("a_B", "a_B"),
            ("a_1", "a1"),
            ("_1", "1"),
            ("trailing_", "trailing_"),
            ("caf\u{e9}_x", "caf\u{e9}X"),
            ("\u{1f600}_x", "\u{1f600}X"),
            ("x_\u{e9}", "x_\u{e9}"),
        ] {
            assert_eq!(camel(&key.into()), Text::from(renamed), "{key}");
        }
        let mut lone = Text::from(0xd800u16);
        lone.push_str("_x");
        assert_eq!(camel(&lone).units().collect::<Vec<_>>(), [0xd800, 0x58]);
    }
}
