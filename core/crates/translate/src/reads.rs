//! Reading a JS value the way the JS's expressions did: `?.`, `String()` of what may be undefined, and `typeof`.

use crate::Thrown;
use jsvalue::js::{given, to_text};
use jsvalue::value::{Object, Text, Value};

/// `value?.key`. Nothing but an object has a key anything here reads.
pub fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.field(key)
}

/// `value?.[0]`: an array's first, or an object's key `0`.
pub fn first(value: Option<&Value>) -> Option<&Value> {
    match value? {
        Value::Array(items) => items.first(),
        Value::Object(object) => object.get("0"),
        _ => None,
    }
}

/// `String(value)`.
pub fn text_of(value: Option<&Value>) -> Result<Text, Thrown> {
    value.map_or(Ok("undefined".into()), to_text)
}

/// `String(value ?? '')`.
pub fn text_or_empty(value: Option<&Value>) -> Result<Text, Thrown> {
    given(value).map_or(Ok(Text::default()), to_text)
}

/// `value === text`.
pub fn is(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(held)) if held.is(text))
}

/// `value`, if `typeof value === 'string'`.
pub fn string(value: Option<&Value>) -> Option<&Text> {
    match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// `object.status` as an item has it.
pub fn status_of(tc: &Object) -> &'static str {
    match tc.get("status") {
        status if is(status, "completed") => "completed",
        status if is(status, "failed") => "failed",
        _ => "inProgress",
    }
}

/// `bytes`, which split a `Text` only at ASCII, as a `Text`.
pub fn text_from(bytes: &[u8]) -> Text {
    let mut text = Text::default();
    text.push_bytes(bytes);
    text
}

/// The first byte of a line terminator of `.`'s (`\n`, `\r`, U+2028, U+2029) and its length, from `from` on.
pub fn line_end(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    bytes[from..].iter().enumerate().find_map(|(at, byte)| match (byte, bytes.get(from + at + 1), bytes.get(from + at + 2)) {
        (b'\n' | b'\r', _, _) => Some((from + at, 1)),
        (0xe2, Some(0x80), Some(0xa8 | 0xa9)) => Some((from + at, 3)),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsvalue::json::parse;

    fn value(text: &str) -> Value {
        parse(text).expect("JSON")
    }

    #[test]
    fn optional_chains_read_nothing_from_what_has_no_key() {
        let object = value(r#"{"a":{"b":1},"s":"text","n":null}"#);
        assert_eq!(at(at(Some(&object), "a"), "b"), Some(&Value::Number(1.0)));
        assert_eq!(at(at(Some(&object), "s"), "length"), None);
        assert_eq!(at(at(Some(&object), "n"), "b"), None);
        assert_eq!(at(None, "a"), None);
    }

    #[test]
    fn a_first_entry_is_an_arrays_or_a_key_of_zero() {
        assert_eq!(first(Some(&value("[1,2]"))), Some(&Value::Number(1.0)));
        assert_eq!(first(Some(&value(r#"{"0":3}"#))), Some(&Value::Number(3.0)));
        assert_eq!(first(Some(&value("[]"))), None);
        assert_eq!(first(Some(&value(r#""text""#))), None);
        assert_eq!(first(None), None);
    }

    #[test]
    fn undefined_has_a_string_too() {
        assert_eq!(text_of(None), Ok("undefined".into()));
        assert_eq!(text_of(Some(&Value::Null)), Ok("null".into()));
        assert!(text_of(Some(&value(r#"{"toString":1}"#))).is_err());
        assert_eq!(text_or_empty(None), Ok(Text::default()));
        assert_eq!(text_or_empty(Some(&Value::Null)), Ok(Text::default()));
        assert_eq!(text_or_empty(Some(&Value::Bool(true))), Ok("true".into()));
    }

    #[test]
    fn a_status_is_finished_only_when_it_says_so() {
        for (status, read) in
            [(r#""completed""#, "completed"), (r#""failed""#, "failed"), (r#""pending""#, "inProgress"), ("7", "inProgress")]
        {
            let tc = value(&format!(r#"{{"status":{status}}}"#));
            assert_eq!(status_of(tc.as_object().expect("an object")), read);
        }
        assert_eq!(status_of(&Object::default()), "inProgress");
    }

    #[test]
    fn a_line_ends_where_a_regular_expressions_dot_stops() {
        assert_eq!(line_end(b"ab", 0), None);
        assert_eq!(line_end(b"a\nb", 0), Some((1, 1)));
        assert_eq!(line_end(b"a\rb\nc", 2), Some((3, 1)));
        assert_eq!(line_end("a\u{2028}b".as_bytes(), 0), Some((1, 3)));
        assert_eq!(line_end("a\u{2029}".as_bytes(), 0), Some((1, 3)));
        // neighbours of U+2028 that share its first bytes
        assert_eq!(line_end("\u{2027}\u{202a}\u{e2}".as_bytes(), 0), None);
        assert_eq!(line_end(&[0xe2], 0), None);
        assert_eq!(line_end(&[0xe2, 0x80], 0), None);
    }
}
