//! JS values in Rust, for a port that must do what the JS did with whatever a line held, rather than a tidier reading of
//! the format: `value` holds what `JSON.parse` makes, `json` reads and writes it as JS does, `js` is what the JS leaned on
//! the language for, and here are the string methods, on UTF-16 units where JS counts them. The bytes they take are a `Text`'s
//! WTF-8, in which a lone surrogate is three bytes no search for ASCII or for whitespace can match.

pub mod js;
pub mod json;
pub mod value;

use crate::value::Text;

/// Each character JS's `trim` takes, as UTF-8.
const SPACES: [&str; 25] = [
    "\t", "\n", "\u{b}", "\u{c}", "\r", " ", "\u{a0}", "\u{1680}", "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}",
    "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200a}", "\u{2028}", "\u{2029}", "\u{202f}", "\u{205f}", "\u{3000}", "\u{feff}",
];

/// `text.trimStart()`.
pub fn trim_start(mut text: &[u8]) -> &[u8] {
    while let Some(space) = SPACES.iter().find(|space| text.starts_with(space.as_bytes())) {
        text = &text[space.len()..];
    }
    text
}

/// `text.trimEnd()`.
pub fn trim_end(mut text: &[u8]) -> &[u8] {
    while let Some(space) = SPACES.iter().find(|space| text.ends_with(space.as_bytes())) {
        text = &text[..text.len() - space.len()];
    }
    text
}

/// `text.trim()`.
pub fn trim(text: &[u8]) -> &[u8] {
    trim_end(trim_start(text))
}

/// `text.length`: a character above U+FFFF is two units, and the only one to take four bytes.
pub fn unit_length(text: &[u8]) -> usize {
    text.iter().map(|byte| usize::from(byte & 0xc0 != 0x80) + usize::from(*byte >= 0xf0)).sum()
}

/// A JS string's units, as a `Text`.
pub fn from_units(units: impl IntoIterator<Item = u16>) -> Text {
    let mut text = Text::default();
    units.into_iter().for_each(|unit| text.push_unit(unit));
    text
}

/// `text.endsWith(tail)` by units: a tail can be half of the pair `text` ends in.
pub fn ends_with(text: &Text, tail: &Text) -> bool {
    let (text, tail): (Vec<u16>, Vec<u16>) = (text.units().collect(), tail.units().collect());
    text.ends_with(&tail)
}

/// `text.slice(0, text.length - tail.length)`, which may leave half of a pair.
pub fn without_tail(text: &Text, tail: &Text) -> Text {
    let units: Vec<u16> = text.units().collect();
    from_units(units[..units.len().saturating_sub(tail.units().count())].iter().copied())
}

/// `prefixUnits(text, n)` (shared/textPrefix.mjs): at most the first `n` units, one fewer when the last would be half of a
/// pair.
pub fn prefix_units(text: &Text, n: usize) -> Text {
    let mut units: Vec<u16> = text.units().take(n).collect();
    if units.last().is_some_and(|unit| (0xd800..=0xdbff).contains(unit)) {
        units.pop();
    }
    from_units(units)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &Text) -> Vec<u16> {
        text.units().collect()
    }

    /// A `Text` with a lone lead surrogate after `before`.
    fn lone(before: &str) -> Text {
        let mut text = Text::from(before);
        text.push_unit(0xd83d);
        text
    }

    #[test]
    fn whitespace_is_what_js_trims() {
        let spaces = " \t\n\u{b}\u{c}\r\u{a0}\u{1680}\u{2000}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
        let both = format!("{spaces}x y{spaces}");
        assert_eq!(trim(both.as_bytes()), b"x y");
        assert_eq!(trim_start(both.as_bytes()), format!("x y{spaces}").as_bytes());
        assert_eq!(trim_end(both.as_bytes()), format!("{spaces}x y").as_bytes());
        // Rust calls the first of these whitespace; JS keeps them all
        for kept in ["\u{85}", "\u{180e}", "\u{200b}", "\u{2060}"] {
            assert_eq!(trim(kept.as_bytes()), kept.as_bytes(), "{kept:?}");
        }
        assert_eq!(trim(b""), b"");
        assert_eq!(trim(b" \n "), b"");
        assert_eq!(trim(lone(" ").as_bytes()), lone("").as_bytes());
    }

    #[test]
    fn length_counts_units() {
        for (text, length) in [("", 0), ("abc", 3), ("\u{e9}", 1), ("\u{4e2d}", 1), ("\u{1f600}", 2), ("a\u{1f600}b", 4)] {
            assert_eq!(unit_length(text.as_bytes()), length, "{text}");
        }
        assert_eq!(unit_length(lone("a").as_bytes()), 2);
    }

    #[test]
    fn a_tail_is_matched_and_cut_by_units() {
        let text = Text::from("a\u{1f600}");
        let trail = Text::from(0xde00u16);
        assert!(ends_with(&text, &trail));
        assert_eq!(units(&without_tail(&text, &trail)), [0x61, 0xd83d]);
        assert!(ends_with(&text, &Text::from("\u{1f600}")));
        assert!(!ends_with(&text, &Text::from("b\u{1f600}")));
        assert!(!ends_with(&Text::from("a"), &Text::from("ba")));
        assert_eq!(without_tail(&Text::from("abc"), &Text::from("bc")), Text::from("a"));
        assert_eq!(without_tail(&Text::from("a"), &Text::from("long")), Text::default());
    }

    #[test]
    fn a_prefix_keeps_pairs_whole() {
        let text = Text::from("ab\u{1f600}c");
        assert_eq!(prefix_units(&text, 3), Text::from("ab"));
        assert_eq!(prefix_units(&text, 4), Text::from("ab\u{1f600}"));
        assert_eq!(prefix_units(&text, 2), Text::from("ab"));
        assert_eq!(prefix_units(&text, 9), text);
        assert_eq!(prefix_units(&text, 0), Text::default());
        // a lone lead at the cut goes too, as the JS's regular expression has it
        assert_eq!(prefix_units(&lone("x"), 2), Text::from("x"));
        let mut trail = Text::from("x");
        trail.push_unit(0xde00);
        assert_eq!(prefix_units(&trail, 2), trail);
    }

    #[test]
    fn units_make_the_text_they_came_from() {
        for text in ["", "a", "\u{e9}\u{4e2d}", "\u{1f600}"] {
            assert_eq!(from_units(text.encode_utf16()), Text::from(text));
        }
        assert_eq!(units(&from_units([0xd83d, 0x61])), [0xd83d, 0x61]);
    }
}
