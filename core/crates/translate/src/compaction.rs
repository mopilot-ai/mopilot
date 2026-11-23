//! How a compaction reads in a chat (shared/compaction.mjs): the compaction item, the user's own /compact, and the summary
//! templates of harnesses that report a compaction only as an agent message. The rule reads the text, never the harness's
//! name: a reply is a summary only by its shape.

use crate::reads::text_from;
use jsvalue::value::{Object, Text, Value};
use jsvalue::{trim, trim_end, trim_start, unit_length};

/// The headings each template always writes, in order. opencode 1.18 runs its compaction agent as one more assistant message
/// in the prompt, told to keep every section even when empty.
const SUMMARY_TEMPLATES: [[&[u8]; 5]; 1] =
    [[b"## Objective", b"## Important Details", b"## Work State", b"## Next Move", b"## Relevant Files"]];
/// Headings of a template, in order from its first, that make text a summary: one heading alone is a plain section.
const SUMMARY_MIN_HEADS: usize = 2;
/// Text that opens like a summary is held back this long at most while its second heading is awaited.
const HOLD_CHARS: usize = 2000;

/// What an agent message's text so far is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    /// it opens with a template's first two headings
    Summary,
    /// it can't be one
    Reply,
    /// it could still be either, held back at most `HOLD_CHARS`
    Open,
}

/// The compaction item every translator emits. `summary` is the only record of the turns before the compaction, so it is kept.
pub fn compaction_item(id: Text, trigger: Option<&str>, summary: Option<&Text>) -> Object {
    let summary = summary.map(|summary| trim(summary.as_bytes())).filter(|summary| !summary.is_empty());
    let trigger = trigger.map_or(Value::Null, Value::text);
    let mut item = Object::of([("type", Value::text("contextCompaction")), ("id", Value::String(id)), ("trigger", trigger)]);
    if let Some(summary) = summary {
        item.push("summary", Value::String(text_from(summary)));
    }
    item
}

/// `/^\s*\/compact(?:\s|$)/.test(text)`: the user's own /compact, with its optional instructions.
pub fn is_compact_command(text: &[u8]) -> bool {
    let Some(rest) = trim_start(text).strip_prefix(b"/compact") else { return false };
    rest.is_empty() || trim_start(rest).len() < rest.len()
}

fn lines(text: &[u8]) -> Vec<&[u8]> {
    text.split(|byte| *byte == b'\n').collect()
}

fn is_heading(line: &[u8]) -> bool {
    line.starts_with(b"## ")
}

/// How many of `heads` the text's headings are, in order from the first (which opens it), with no other heading among them.
fn heads_matched(text: &[u8], heads: &[&[u8]]) -> usize {
    let lines = lines(trim(text));
    if trim_end(lines[0]) != heads[0] {
        return 0;
    }
    let found: Vec<&[u8]> = lines.iter().map(|line| trim_end(line)).filter(|line| is_heading(line)).collect();
    let matched = found.iter().zip(heads).take_while(|(found, head)| *found == *head).count();
    if matched == found.len() {
        matched
    } else {
        0
    }
}

/// What an agent message's text so far is: a summary once it opens with a template's first two headings, a reply once it
/// can't be one, and open while it could still be either (its first heading, its first section, a heading still arriving).
pub fn summary_start(text: &[u8]) -> Shape {
    let text = trim_start(text);
    let lines = lines(text);
    for heads in &SUMMARY_TEMPLATES {
        if lines.len() == 1 && heads[0].starts_with(trim_end(text)) {
            return Shape::Open;
        }
        if lines.len() == 1 || trim_end(lines[0]) != heads[0] {
            continue;
        }
        let (last, done) = lines.split_last().unwrap_or((&lines[0], &[]));
        if let Some(second) = done[1..].iter().map(|line| trim_end(line)).find(|line| is_heading(line)) {
            return if second == heads[1] { Shape::Summary } else { Shape::Reply };
        }
        // a heading line still arriving, or the first section still being written
        if last.starts_with(b"#") && heads[1].starts_with(trim_end(last)) {
            return Shape::Open;
        }
        if is_heading(last) {
            return Shape::Reply;
        }
        return if unit_length(text) > HOLD_CHARS { Shape::Reply } else { Shape::Open };
    }
    Shape::Reply
}

/// Whether a whole agent message is a compaction summary: its `## ` headings are a template's, in order from the first, at
/// least its first two. A summary cut off still is one; a reply with a single matching section, or headings of its own, is
/// not.
pub fn is_compaction_summary(text: &[u8]) -> bool {
    SUMMARY_TEMPLATES.iter().any(|heads| heads_matched(text, heads) >= SUMMARY_MIN_HEADS)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMMARY: &str =
        "## Objective\n- Ship\n\n## Important Details\n- x\n\n## Work State\n- y\n\n## Next Move\n1. z\n\n## Relevant Files\n- a.ts\n";

    #[test]
    fn a_compaction_item_keeps_a_summary_it_was_given() {
        let id = Text::from("c");
        let plain = compaction_item(id.clone(), None, None);
        assert_eq!(plain.get("trigger"), Some(&Value::Null));
        assert_eq!(plain.get("summary"), None);
        let blank = compaction_item(id.clone(), Some("auto"), Some(&"   ".into()));
        assert_eq!(blank.get("trigger"), Some(&Value::text("auto")));
        assert_eq!(blank.get("summary"), None);
        let kept = compaction_item(id, Some("manual"), Some(&"  said \n".into()));
        assert_eq!(kept.get("summary"), Some(&Value::text("said")));
    }

    #[test]
    fn compact_is_the_command_alone_or_with_instructions() {
        for text in ["/compact", "  /compact", "\n/compact focus", "/compact\tx", "/compact\u{a0}x", "\u{feff}/compact"] {
            assert!(is_compact_command(text.as_bytes()), "{text:?}");
        }
        for text in ["/compacted", "x /compact", "/compac", "", "compact"] {
            assert!(!is_compact_command(text.as_bytes()), "{text:?}");
        }
    }

    #[test]
    fn a_whole_message_is_a_summary_by_its_headings() {
        let yes = |text: &str| is_compaction_summary(text.as_bytes());
        assert!(yes(SUMMARY));
        assert!(yes(&format!("\n{}\n", SUMMARY.replace('\n', "  \n"))));
        assert!(yes(&SUMMARY[..SUMMARY.find("## Work State").expect("a heading")]));
        assert!(!yes("## Objective\nShip the fix."));
        assert!(!yes("## Objective\nShip the fix.\n\n## Next Move\n1. Test it"));
        assert!(!yes(&SUMMARY.replace("## Work State", "## Status")));
        assert!(!yes(&format!("Here it is:\n{SUMMARY}")));
        assert!(!yes(&format!("{SUMMARY}\n\n## Notes\n- extra")));
        assert!(!yes(""));
    }

    #[test]
    fn a_message_in_progress_is_read_as_far_as_it_goes() {
        let shape = |text: &str| summary_start(text.as_bytes());
        for text in [
            "",
            "  \n#",
            "## Objective",
            "## Obj",
            "## Objective\n- Sign in\n",
            "## Objective\n- Sign in\n\n## Imp",
            "## Objective\n- Sign in\n\n#",
        ] {
            assert_eq!(shape(text), Shape::Open, "{text:?}");
        }
        assert_eq!(shape("## Objective\n- Sign in\n\n## Important Details\n"), Shape::Summary);
        for text in ["## Objective\n- Ship\n\n## Next Move\n", "## Objective\n- Ship\n\n## Next", "## Objectives\n", "Done."] {
            assert_eq!(shape(text), Shape::Reply, "{text:?}");
        }
        assert_eq!(shape(&format!("## Objective\n{}", "x".repeat(2001))), Shape::Reply);
        assert_eq!(shape(&format!("## Objective\n{}", "x".repeat(1980))), Shape::Open);
        // the limit counts units, as the JS's length does: 1100 of these are 2200 units in 4400 bytes
        assert_eq!(shape(&format!("## Objective\n{}", "\u{1f600}".repeat(1100))), Shape::Reply);
        assert_eq!(shape(&format!("## Objective\n{}", "\u{4e2d}".repeat(1000))), Shape::Open);
    }
}
