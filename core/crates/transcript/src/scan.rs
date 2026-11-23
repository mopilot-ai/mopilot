//! A transcript read for what a list or a search wants of it, off the JS thread: the records of some kinds, and whether a
//! term is anywhere in it. A long transcript is nearly all streamed updates, which neither wants parsed.

use serde::de::IgnoredAny;
use serde::Serialize;

/// What a scan found. `records` is a JSON array of the wanted lines as they were written, for JS to parse once.
#[derive(Debug, PartialEq, Serialize)]
pub struct Scan {
    pub records: String,
    /// lines that are not JSON objects: torn by a crash, or damaged
    pub torn: usize,
    pub found: bool,
}

/// Whether `line` is a JSON object. A line this build wrote starts with its brace.
fn is_record(line: &str) -> bool {
    line.starts_with('{') && serde_json::from_str::<IgnoredAny>(line).is_ok()
}

/// The start of a line this build wrote for `kind`, as JSON.stringify spells it.
fn prefix_of(kind: &str) -> Result<String, String> {
    serde_json::to_string(kind).map(|name| format!("{{\"t\":{name}")).map_err(|error| error.to_string())
}

/// Whether a line of another kind can be skipped by its prefix: a line in any other shape is parsed, so an older
/// transcript loads the same.
fn skipped(line: &str, wanted: &[String]) -> bool {
    line.starts_with("{\"t\":\"")
        && !wanted.iter().any(|prefix| line.strip_prefix(prefix.as_str()).is_some_and(|rest| rest.starts_with([',', '}'])))
}

/// Scan `bytes`: with `kinds`, only those records; with `needle` (lowercase), whether the text holds it however cased.
pub fn scan(bytes: &[u8], kinds: Option<&[String]>, needle: Option<&str>) -> Result<Scan, String> {
    let text = String::from_utf8_lossy(bytes);
    let wanted = kinds.map(|kinds| kinds.iter().map(|kind| prefix_of(kind)).collect::<Result<Vec<_>, _>>()).transpose()?;
    let mut records = String::from("[");
    let mut torn = 0;
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() || wanted.as_deref().is_some_and(|wanted| skipped(line, wanted)) {
            continue;
        }
        if is_record(line) {
            if records.len() > 1 {
                records.push(',');
            }
            records.push_str(line);
        } else {
            torn += 1;
        }
    }
    records.push(']');
    let found = needle.is_some_and(|needle| crate::contains(&text, needle));
    Ok(Scan { records, torn, found })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn only_the_wanted_kinds_are_kept_and_other_shapes_are_read() {
        let text = concat!(
            "{\"t\":\"session\",\"cwd\":\"/a\"}\n",
            "{\"t\":\"update\",\"n\":1}\n",
            "{\"t\":\"user\"}\n",
            "{\"t\":\"session-like\"}\n",
            "{\"turnId\":\"x\",\"t\":\"update\"}\n",
            "\n  \n",
        );
        let got = scan(text.as_bytes(), Some(&kinds(&["session", "user"])), None).unwrap();
        assert_eq!(got.records, r#"[{"t":"session","cwd":"/a"},{"t":"user"},{"turnId":"x","t":"update"}]"#);
        assert_eq!(got.torn, 0);
        assert!(!got.found);
    }

    #[test]
    fn torn_and_non_object_lines_are_counted_and_left_out() {
        let got = scan(b"{\"t\":\"a\"}\n{\"t\":\"b\n[1]\n7\n\"s\"\nnull\n", None, None).unwrap();
        assert_eq!(got.records, r#"[{"t":"a"}]"#);
        assert_eq!(got.torn, 5);
        // a line of an unwanted kind is skipped by its prefix, whatever follows it
        assert_eq!(scan(b"{\"t\":\"a\",torn", Some(&kinds(&["b"])), None).unwrap().torn, 0);
    }

    #[test]
    fn a_crlf_line_and_invalid_utf8_still_read() {
        let got = scan(b"{\"t\":\"a\"}\r\n{\"t\":\"\xff\"}\n", None, None).unwrap();
        assert_eq!(got.records, "[{\"t\":\"a\"},{\"t\":\"\u{fffd}\"}]");
    }

    #[test]
    fn a_term_is_found_however_it_is_cased_including_case_that_changes_length() {
        let text = "{\"t\":\"user\",\"text\":\"Hello WORLD \u{212a}elvin \u{130}x\"}\n";
        for needle in ["hello world", "kelvin", "i\u{307}x"] {
            assert!(scan(text.as_bytes(), None, Some(needle)).unwrap().found, "{needle}");
        }
        assert!(!scan(text.as_bytes(), None, Some("absent")).unwrap().found);
    }

    #[test]
    fn nothing_scans_as_nothing() {
        assert_eq!(scan(b"", None, Some("x")).unwrap(), Scan { records: "[]".into(), torn: 0, found: false });
    }
}
