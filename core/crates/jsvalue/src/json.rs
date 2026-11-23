//! JSON read as `JSON.parse` reads it, and written as `JSON.stringify` writes it, where serde_json differs: a string may
//! hold a lone surrogate, a number too large for a double is Infinity, a key may come twice, and keys and numbers come back
//! out in JS's order and spelling.

use crate::js::number_text;
use crate::value::{Object, Text, Value};

/// How deep a line may nest. JS's own limit is its stack's: this is near where it fails, and it keeps a route's recursion
/// inside its thread's stack, whose overflow nothing could catch. A line past it reads as a bad line.
const MAX_DEPTH: usize = 1000;

/// What `JSON.parse(text)` gives, or `None` for what it throws on or what nests past `MAX_DEPTH`.
pub fn parse(text: &str) -> Option<Value> {
    let mut parser = Parser { bytes: text.as_bytes(), at: 0 };
    let value = parser.value(0)?;
    parser.space();
    (parser.at == parser.bytes.len()).then_some(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    /// Past `byte`, if it is next.
    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        self.at += usize::from(found);
        found
    }

    /// Past JSON's four whitespace characters: not U+FEFF, or any other JS calls whitespace elsewhere.
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn word(&mut self, word: &[u8], value: Value) -> Option<Value> {
        self.bytes[self.at..].starts_with(word).then(|| {
            self.at += word.len();
            value
        })
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        self.space();
        match self.peek()? {
            b'{' if depth < MAX_DEPTH => self.object(depth),
            b'[' if depth < MAX_DEPTH => self.array(depth),
            b'"' => self.string().map(Value::String),
            b'n' => self.word(b"null", Value::Null),
            b't' => self.word(b"true", Value::Bool(true)),
            b'f' => self.word(b"false", Value::Bool(false)),
            b'-' | b'0'..=b'9' => self.number().map(Value::Number),
            _ => None,
        }
    }

    fn array(&mut self, depth: usize) -> Option<Value> {
        self.at += 1;
        let mut items = Vec::new();
        self.space();
        if self.eat(b']') {
            return Some(Value::Array(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.space();
            if self.eat(b']') {
                return Some(Value::Array(items));
            }
            if !self.eat(b',') {
                return None;
            }
        }
    }

    fn object(&mut self, depth: usize) -> Option<Value> {
        self.at += 1;
        let mut entries = Vec::new();
        self.space();
        if self.eat(b'}') {
            return Some(Value::Object(Object::default()));
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return None;
            }
            let key = self.string()?;
            self.space();
            if !self.eat(b':') {
                return None;
            }
            entries.push((key, self.value(depth + 1)?));
            self.space();
            if self.eat(b'}') {
                return Some(Value::Object(Object::from_entries(entries)));
            }
            if !self.eat(b',') {
                return None;
            }
        }
    }

    /// The string at its opening quote. A `\u` escape may be half of a pair or a lone surrogate: both are kept.
    fn string(&mut self) -> Option<Text> {
        self.at += 1;
        let mut text = Text::default();
        loop {
            let run = self.bytes[self.at..].iter().position(|&b| b == b'"' || b == b'\\' || b < 0x20)?;
            text.push_bytes(&self.bytes[self.at..self.at + run]);
            self.at += run;
            match self.bytes[self.at] {
                b'"' => {
                    self.at += 1;
                    return Some(text);
                }
                b'\\' => {
                    self.at += 1;
                    let unit = self.escape()?;
                    text.push_unit(unit);
                }
                _ => return None,
            }
        }
    }

    /// The escape after a backslash, as a UTF-16 unit.
    fn escape(&mut self) -> Option<u16> {
        let simple = match self.peek()? {
            b'"' => b'"',
            b'\\' => b'\\',
            b'/' => b'/',
            b'b' => 8,
            b'f' => 12,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'u' => {
                let digits = self.bytes.get(self.at + 1..self.at + 5)?;
                let unit = digits.iter().try_fold(0u16, |unit, &digit| Some(unit << 4 | (digit as char).to_digit(16)? as u16))?;
                self.at += 5;
                return Some(unit);
            }
            _ => return None,
        };
        self.at += 1;
        Some(simple.into())
    }

    fn digits(&mut self) -> bool {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at > start
    }

    /// A number as JSON spells one. A double's parse rounds as JS's does, and too large is Infinity, not a failure.
    fn number(&mut self) -> Option<f64> {
        let start = self.at;
        self.eat(b'-');
        if !self.eat(b'0') && !self.digits() {
            return None;
        }
        if self.eat(b'.') && !self.digits() {
            return None;
        }
        if self.eat(b'e') || self.eat(b'E') {
            let _ = self.eat(b'+') || self.eat(b'-');
            if !self.digits() {
                return None;
            }
        }
        std::str::from_utf8(&self.bytes[start..self.at]).ok()?.parse().ok()
    }
}

/// What a value is written for.
#[derive(Clone, Copy, PartialEq)]
pub enum Numbers {
    /// As `JSON.stringify` writes: NaN and the infinities are null, and -0 is 0. An item goes through this in the JS.
    Stringified,
    /// To come back from `JSON.parse` as this very number: the fields of a turn were never stringified in the JS.
    Exact,
}

/// `value` as JSON, onto `out`.
pub fn write(out: &mut Vec<u8>, value: &Value, numbers: Numbers) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(flag) => out.extend_from_slice(if *flag { b"true" } else { b"false" }),
        Value::Number(number) => write_number(out, *number, numbers),
        Value::String(text) => write_text(out, text),
        Value::Array(items) => {
            out.push(b'[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(b',');
                }
                write(out, item, numbers);
            }
            out.push(b']');
        }
        Value::Object(object) => write_object(out, object, numbers),
    }
}

/// `object` as JSON, onto `out`.
pub fn write_object(out: &mut Vec<u8>, object: &Object, numbers: Numbers) {
    out.push(b'{');
    for (at, (key, item)) in object.entries().iter().enumerate() {
        if at > 0 {
            out.push(b',');
        }
        write_text(out, key);
        out.push(b':');
        write(out, item, numbers);
    }
    out.push(b'}');
}

fn write_number(out: &mut Vec<u8>, number: f64, numbers: Numbers) {
    let literal: &[u8] = match numbers {
        Numbers::Stringified if !number.is_finite() => b"null",
        Numbers::Exact if number.is_nan() => b"null",
        // literals past a double's range, which is how JSON.parse gets back to an infinity
        Numbers::Exact if number == f64::INFINITY => b"1e999",
        Numbers::Exact if number == f64::NEG_INFINITY => b"-1e999",
        Numbers::Exact if number == 0.0 && number.is_sign_negative() => b"-0",
        _ => return out.extend_from_slice(number_text(number).as_bytes()),
    };
    out.extend_from_slice(literal);
}

/// `text` as `JSON.stringify` writes a string: a lone surrogate as its escape, so that the output is UTF-8.
pub fn write_text(out: &mut Vec<u8>, text: &Text) {
    out.push(b'"');
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        let lone = byte == 0xed && bytes[at + 1] >= 0xa0;
        if byte >= 0x20 && byte != b'"' && byte != b'\\' && !lone {
            at += 1;
            continue;
        }
        out.extend_from_slice(&bytes[start..at]);
        match byte {
            b'"' => out.extend_from_slice(br#"\""#),
            b'\\' => out.extend_from_slice(br"\\"),
            8 => out.extend_from_slice(br"\b"),
            12 => out.extend_from_slice(br"\f"),
            b'\n' => out.extend_from_slice(br"\n"),
            b'\r' => out.extend_from_slice(br"\r"),
            b'\t' => out.extend_from_slice(br"\t"),
            0xed => {
                let unit = 0xd000 | u32::from(bytes[at + 1] & 0x3f) << 6 | u32::from(bytes[at + 2] & 0x3f);
                out.extend_from_slice(format!("\\u{unit:04x}").as_bytes());
                at += 2;
            }
            _ => out.extend_from_slice(format!("\\u{byte:04x}").as_bytes()),
        }
        at += 1;
        start = at;
    }
    out.extend_from_slice(&bytes[start..]);
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(value: &Value, numbers: Numbers) -> String {
        let mut out = Vec::new();
        write(&mut out, value, numbers);
        String::from_utf8(out).expect("UTF-8")
    }

    /// `text` parsed, then written as JSON.stringify does.
    fn again(text: &str) -> String {
        written(&parse(text).expect("JSON"), Numbers::Stringified)
    }

    #[test]
    fn values_read_and_write_back() {
        for text in ["null", "true", "false", "[]", "{}", "0", "1.5", "-2", r#""s""#, r#"[1,[2,{"a":[]}],null]"#, r#"{"a":{"b":1},"c":2}"#]
        {
            assert_eq!(again(text), text);
        }
        assert_eq!(again(" \t\r\n[ 1 , { \"a\" : 2 , \"b\" : [ ] } ] \n"), r#"[1,{"a":2,"b":[]}]"#);
    }

    #[test]
    fn what_json_parse_refuses_is_refused() {
        for bad in [
            "",
            " ",
            "nul",
            "tru",
            "fals",
            "[",
            "[1",
            "[1,",
            "[1,]",
            "[1 2]",
            "{",
            "{\"a\"",
            "{\"a\":",
            "{\"a\":1",
            "{\"a\":1,",
            "{\"a\":1,}",
            "{\"a\" 1}",
            "{a:1}",
            "{\"a\":1 \"b\":2}",
            "\"",
            "\"a",
            "\"\\",
            "\"\\x\"",
            "\"\\u12\"",
            "\"\\u12g4\"",
            "\"a\nb\"",
            "\"\t\"",
            "01",
            "-",
            "+1",
            ".5",
            "1.",
            "1e",
            "1e+",
            "--1",
            "1 2",
            "\u{feff}1",
            "\u{a0}1",
            "undefined",
            "NaN",
            "Infinity",
            "'a'",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn escapes_read_as_units() {
        assert_eq!(parse(r#""\"\\\/\b\f\n\r\t\u0041\u00e9\u4E2D""#), Some(Value::text("\"\\/\u{8}\u{c}\n\r\tA\u{e9}\u{4e2d}")));
        assert_eq!(parse(r#""\ud83d\ude00""#), Some(Value::text("\u{1f600}")));
    }

    #[test]
    fn a_lone_surrogate_survives_where_serde_json_refuses_it() {
        assert!(serde_json::from_str::<serde_json::Value>(r#""\ud800""#).is_err());
        for text in [r#""\ud800""#, r#""\udc00x""#, r#""a\ud83d\u0041""#] {
            assert_eq!(again(text), text.replace("\\u0041", "A"));
        }
    }

    #[test]
    fn numbers_past_a_double_are_as_js_has_them() {
        assert_eq!(parse("1e400"), Some(Value::Number(f64::INFINITY)));
        assert_eq!(parse("-1e400"), Some(Value::Number(f64::NEG_INFINITY)));
        assert_eq!(parse("1e-400"), Some(Value::Number(0.0)));
        assert_eq!(again("12345678901234567890"), "12345678901234567000");
        assert_eq!(again("1E3"), "1000");
        assert_eq!(again("1.5e+3"), "1500");
        assert_eq!(again("2.5e-1"), "0.25");
        assert_eq!(again("1e21"), "1e+21");
    }

    #[test]
    fn a_number_is_written_as_each_path_of_the_js_had_it() {
        for (number, stringified, exact) in [
            (f64::NAN, "null", "null"),
            (f64::INFINITY, "null", "1e999"),
            (f64::NEG_INFINITY, "null", "-1e999"),
            (-0.0, "0", "-0"),
            (0.0, "0", "0"),
            (1.5, "1.5", "1.5"),
        ] {
            assert_eq!(written(&Value::Number(number), Numbers::Stringified), stringified);
            assert_eq!(written(&Value::Number(number), Numbers::Exact), exact);
        }
    }

    #[test]
    fn strings_are_escaped_as_json_stringify_escapes_them() {
        let text = "\"\\/\u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f}\u{2028}\u{e9}\u{1f600}";
        assert_eq!(written(&Value::text(text), Numbers::Exact), "\"\\\"\\\\/\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}\u{e9}\u{1f600}\"");
    }

    #[test]
    fn nesting_stops_at_a_line_too_deep_to_read() {
        let deep = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        let objects = |n: usize| format!("{}1{}", "{\"a\":".repeat(n), "}".repeat(n));
        // a route's thread has this stack, and the deepest line must fit
        let reading = std::thread::Builder::new().stack_size(8 << 20).spawn(move || {
            assert!(parse(&deep(MAX_DEPTH)).is_some());
            assert!(parse(&objects(MAX_DEPTH)).is_some());
            assert_eq!(parse(&deep(MAX_DEPTH + 1)), None);
            assert_eq!(parse(&objects(MAX_DEPTH + 1)), None);
        });
        reading.expect("a thread").join().expect("no failure");
    }
}
