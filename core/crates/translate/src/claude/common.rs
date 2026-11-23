//! Claude message primitives for result text, time and tool recognition, what JS's language gave it, and the `Map` key a JS value makes.

use crate::blocks::{content_blocks, normalize};
use crate::reads::{is, string, text_from};
use crate::turns::key_of;
use crate::Thrown;
use jsvalue::js::{to_number, to_text};
use jsvalue::json::{write, Numbers};
use jsvalue::value::{Text, Value};
use jsvalue::{prefix_units, trim, unit_length};

/// What a template puts in its string.
pub trait Piece {
    fn add_to(&self, out: &mut Text);
}

impl Piece for &str {
    fn add_to(&self, out: &mut Text) {
        out.push_str(self);
    }
}

impl Piece for Text {
    fn add_to(&self, out: &mut Text) {
        out.push_text(self);
    }
}

impl Piece for &Text {
    fn add_to(&self, out: &mut Text) {
        out.push_text(self);
    }
}

/// A template literal: each piece in turn, a lead surrogate joining a trail one as JS's `+` joins them.
macro_rules! cat {
    ($($piece:expr),* $(,)?) => {{
        let mut out = jsvalue::value::Text::default();
        $( crate::claude::common::Piece::add_to(&$piece, &mut out); )*
        out
    }};
}
pub(crate) use cat;

/// A value's identity as a key of JS's `Map`: objects compare by spelling, and two that read alike were two there, which only
/// what no writer makes can tell.
pub fn map_key(id: Option<&Value>) -> Text {
    text_from(&key_of(&id.cloned()))
}

/// `JSON.stringify(value)`.
pub fn stringified(value: &Value) -> Text {
    let mut out = Vec::new();
    write(&mut out, value, Numbers::Stringified);
    text_from(&out)
}

/// The text of a `tool_result`'s content.
pub fn result_text(content: Option<&Value>) -> Text {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let mut joined = Text::default();
            let mut first = true;
            for block in blocks {
                let text = if is(block.field("type"), "text") {
                    // a text that isn't one is no line at all
                    let Some(block) = normalize(Some(block)) else { continue };
                    string(block.get("text")).cloned().unwrap_or_default()
                } else if is(block.field("type"), "image") {
                    "[image]".into()
                } else {
                    stringified(block)
                };
                if !first {
                    joined.push_str("\n");
                }
                first = false;
                joined.push_text(&text);
            }
            joined
        }
        None | Some(Value::Null) => Text::default(),
        Some(other) => stringified(other),
    }
}

/// `typeof v === 'number' && Number.isFinite(v) ? v : null`.
pub fn num(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

/// The days from 1970 to a civil date, whatever its day is: `Date` lets the 31st of February run on into March.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year.rem_euclid(400);
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    era * 146_097 + of_era * 365 + of_era / 4 - of_era / 100 + of_year - 719_468
}

/// The next `count` digits of `text` from `*at`, as a number.
fn digits(text: &[u8], at: &mut usize, count: usize) -> Option<i64> {
    let held = text.get(*at..*at + count).filter(|held| held.iter().all(u8::is_ascii_digit))?;
    *at += count;
    Some(held.iter().fold(0, |number, digit| number * 10 + i64::from(digit - b'0')))
}

/// Whether `text` has `byte` at `*at`, stepping past it.
fn takes(text: &[u8], at: &mut usize, byte: u8) -> bool {
    let found = text.get(*at) == Some(&byte);
    *at += usize::from(found);
    found
}

/// The time part after a date's `T`, with its zone: milliseconds from midnight, as UTC. A time with no zone is local time in
/// JS, which nothing here knows, so it reads as no time at all.
fn time_of_day(text: &[u8], at: &mut usize) -> Option<i64> {
    let hour = digits(text, at, 2)?;
    if !takes(text, at, b':') {
        return None;
    }
    let minute = digits(text, at, 2)?;
    let (mut second, mut ms) = (0, 0);
    if takes(text, at, b':') {
        second = digits(text, at, 2)?;
        if takes(text, at, b'.') {
            let start = *at;
            while text.get(*at).is_some_and(u8::is_ascii_digit) {
                *at += 1;
            }
            let fraction = &text[start..*at];
            if fraction.is_empty() {
                return None;
            }
            // three digits count, the rest are dropped
            ms = (0..3).fold(0, |ms, place| ms * 10 + fraction.get(place).map_or(0, |digit| i64::from(digit - b'0')));
        }
    }
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute, second, ms) != (0, 0, 0)) {
        return None;
    }
    let offset = match text.get(*at) {
        Some(b'Z') => {
            *at += 1;
            0
        }
        Some(sign @ (b'+' | b'-')) => {
            *at += 1;
            let (hours, minutes) = (digits(text, at, 2)?, Some(()).filter(|()| takes(text, at, b':')).and_then(|()| digits(text, at, 2))?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            (hours * 60 + minutes) * 60_000 * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return None,
    };
    Some((hour * 3600 + minute * 60 + second) * 1000 + ms - offset)
}

/// `Date.parse(text)` for ECMAScript's own format, in all its forms (a year alone up to milliseconds and a zone, a year of six
/// digits with a sign, the 31st of any month). V8 goes on to guess at anything else, by its own legacy rules and the machine's
/// time zone; Claude Code writes `toISOString()`, and what is not this format reads here as no time. NaN for none.
pub fn date_parse(text: &[u8]) -> f64 {
    const LIMIT: i64 = 8_640_000_000_000_000;
    let parsed = (|| {
        let mut at = 0;
        let sign = match text.first()? {
            b'+' => 1,
            b'-' => -1,
            _ => 0,
        };
        let year = if sign == 0 {
            digits(text, &mut at, 4)?
        } else {
            at = 1;
            let year = digits(text, &mut at, 6)?;
            if sign < 0 && year == 0 {
                return None;
            }
            year * sign
        };
        let (mut month, mut day) = (1, 1);
        if takes(text, &mut at, b'-') {
            month = digits(text, &mut at, 2)?;
            if takes(text, &mut at, b'-') {
                day = digits(text, &mut at, 2)?;
            }
        }
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let time = if takes(text, &mut at, b'T') { time_of_day(text, &mut at)? } else { 0 };
        (at == text.len()).then_some(days_from_civil(year, month, day) * 86_400_000 + time)
    })();
    parsed.filter(|time| time.abs() <= LIMIT).map_or(f64::NAN, |time| time as f64)
}

/// `Date.parse(value)`, for what isn't a string too: a number or a boolean is a text only V8's guessing reads.
pub fn parse_time(value: Option<&Value>) -> f64 {
    string(value).map_or(f64::NAN, |text| date_parse(text.as_bytes()))
}

/// `Date.parse(m?.timestamp ?? '') || now`: a message's own time (transcripts carry one), else now.
pub fn ms_time(message: &Value, now: f64) -> f64 {
    let time = parse_time(message.field("timestamp"));
    if time.is_nan() || time == 0.0 {
        now
    } else {
        time
    }
}

/// The first line of `text`, cut to 160 units.
pub fn first_line(text: &Text) -> Text {
    let trimmed = trim(text.as_bytes());
    let line = text_from(trimmed.split(|byte| *byte == b'\n').next().unwrap_or_default());
    if unit_length(line.as_bytes()) > 160 {
        let mut cut = prefix_units(&line, 160);
        cut.push_str("\u{2026}");
        cut
    } else {
        line
    }
}

/// `name.startsWith('mcp__')`; JS threw for what isn't a string.
pub fn is_mcp(name: Option<&Value>) -> Result<bool, Thrown> {
    string(name).map(|name| name.as_bytes().starts_with(b"mcp__")).ok_or_else(|| "a tool has no name".to_string())
}

/// Whether `block` calls a tool.
pub fn is_tool(block: &jsvalue::value::Object) -> bool {
    is(block.get("type"), "tool_use") || is(block.get("type"), "server_tool_use")
}

/// The tools that keep Claude Code's task list: no rows of their own, only the plan.
pub fn is_todo_tool(name: Option<&Value>) -> bool {
    is(name, "TodoWrite") || is(name, "TaskCreate") || is(name, "TaskUpdate")
}

/// JS's `a + b`, for the token counts of a `result`, which are a third party's to spell.
pub fn js_add(a: &Value, b: &Value) -> Result<Value, Thrown> {
    let concatenates = |value: &Value| matches!(value, Value::String(_) | Value::Array(_) | Value::Object(_));
    if concatenates(a) || concatenates(b) {
        let mut text = to_text(a)?;
        text.push_text(&to_text(b)?);
        return Ok(Value::String(text));
    }
    Ok(Value::Number(to_number(Some(a))? + to_number(Some(b))?))
}

/// The text blocks of `content`, each as it is.
pub fn text_blocks(content: Option<&Value>) -> Vec<Text> {
    let blocks = content_blocks(content);
    blocks
        .iter()
        .filter(|block| is(block.get("type"), "text"))
        .map(|block| string(block.get("text")).cloned().unwrap_or_default())
        .collect()
}

/// `parts.join(separator)`, of texts.
pub fn joined(parts: &[Text], separator: &str) -> Text {
    let mut text = Text::default();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            text.push_str(separator);
        }
        text.push_text(part);
    }
    text
}
