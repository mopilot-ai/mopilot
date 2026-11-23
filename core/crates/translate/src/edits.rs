//! An ACP edit tool call's file changes (shared/acpItems/editChanges.mjs): from a unified patch in its output, its diff
//! blocks, or its input. Patches are split at ASCII only, so a line's bytes stay what the JS's units were.

use crate::blocks::content_blocks;
use crate::reads::{at, first, is, line_end, string, text_from, text_of, text_or_empty};
use crate::Thrown;
use jsvalue::js::given;
use jsvalue::value::{Object, Text, Value};
use std::borrow::Cow;

fn add() -> Value {
    Value::Object(Object::of([("type", Value::text("add"))]))
}

fn update() -> Value {
    Value::Object(Object::of([("type", Value::text("update")), ("move_path", Value::Null)]))
}

/// Each of `lines` after `sign`, joined by newlines.
fn push_lines(diff: &mut Text, sign: &str, lines: &[&[u8]]) {
    for (at, line) in lines.iter().enumerate() {
        diff.push_str(if at > 0 { "\n" } else { "" });
        diff.push_str(sign);
        diff.push_bytes(line);
    }
}

fn lines_of(text: &Text) -> Vec<&[u8]> {
    text.as_bytes().split(|byte| *byte == b'\n').collect()
}

/// A hunk replacing `old` with `new`, numbered from line 1: the best a fragment or whole-file pair can say.
pub fn replace_diff(old: Option<&Value>, new: Option<&Value>) -> Result<Text, Thrown> {
    let (old, new) = (text_of(old)?, text_or_empty(new)?);
    let (old, new) = (lines_of(&old), lines_of(&new));
    let mut diff = Text::from(format!("@@ -1,{} +1,{} @@\n", old.len(), new.len()).as_str());
    push_lines(&mut diff, "-", &old);
    diff.push_str("\n");
    push_lines(&mut diff, "+", &new);
    Ok(diff)
}

/// `line.slice(4).replace(/\t.*$/, '')`: `.` stops at a line terminator, so the first tab after the last of those.
fn header_path(line: &[u8]) -> &[u8] {
    let path = &line[4..];
    let mut after = 0;
    while let Some((at, length)) = line_end(path, after) {
        after = at + length;
    }
    path[after..].iter().position(|byte| *byte == b'\t').map_or(path, |tab| &path[..after + tab])
}

/// The digits at the start of `line`, and the rest.
fn digits(line: &[u8]) -> (&[u8], &[u8]) {
    line.split_at(line.iter().position(|byte| !byte.is_ascii_digit()).unwrap_or(line.len()))
}

/// One side of a hunk header, at its first digit: its count, if it gives one, and the rest of the line.
fn side(line: &[u8]) -> Option<(Option<&[u8]>, &[u8])> {
    let (start, rest) = digits(line);
    if start.is_empty() {
        return None;
    }
    let Some(rest) = rest.strip_prefix(b",") else { return Some((None, rest)) };
    let (count, rest) = digits(rest);
    (!count.is_empty()).then_some((Some(count), rest))
}

/// `/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)`: how many old and new lines the hunk says it has, one when it doesn't.
fn hunk(line: &[u8]) -> Option<(f64, f64)> {
    let (old, rest) = side(line.strip_prefix(b"@@ -")?)?;
    let (new, rest) = side(rest.strip_prefix(b" +")?)?;
    rest.starts_with(b" @@").then(|| (count(old), count(new)))
}

/// `Number(digits ?? 1)`.
fn count(digits: Option<&[u8]>) -> f64 {
    digits.and_then(|digits| std::str::from_utf8(digits).ok()?.parse().ok()).unwrap_or(1.0)
}

struct File<'a> {
    from: &'a [u8],
    to: &'a [u8],
    hunks: Vec<&'a [u8]>,
}

/// The file a header's pair of paths names: git's a/ and b/ prefixes come off (/dev/null has none).
fn file_of<'a>(from: &'a [u8], to: &'a [u8]) -> File<'a> {
    let (mut from, mut to) = (from, to);
    if from.starts_with(b"a/") || to.starts_with(b"b/") {
        from = from.strip_prefix(b"a/").unwrap_or(from);
        to = to.strip_prefix(b"b/").unwrap_or(to);
    }
    File { from, to, hunks: Vec::new() }
}

fn change(path: Value, kind: Value, diff: Text) -> Value {
    Value::Object(Object::of([("path", path), ("kind", kind), ("diff", Value::String(diff))]))
}

/// One file of a patch as a change, with only its hunks (Undo adds headers relative to the chat's folder).
fn patched(file: &File) -> Value {
    const NOWHERE: &[u8] = b"/dev/null";
    let path = if file.to == NOWHERE { file.from } else { file.to };
    let kind = if file.from == NOWHERE {
        add()
    } else if file.to == NOWHERE {
        Value::Object(Object::of([("type", Value::text("delete"))]))
    } else {
        update()
    };
    let mut diff = Text::default();
    push_lines(&mut diff, "", &file.hunks);
    change(Value::String(text_from(path)), kind, diff)
}

/// A unified patch's files as changes. A hunk's lines are counted from its header, so a removed "-- x" line followed by
/// an added "++ y" line is content, not the next file.
pub fn patch_changes(text: Option<&Value>) -> Vec<Value> {
    let Some(text) = string(text) else { return Vec::new() };
    let lines: Vec<&[u8]> = text.as_bytes().split(|byte| *byte == b'\n').collect();
    let mut files: Vec<File> = Vec::new();
    let (mut old_left, mut new_left) = (0.0, 0.0);
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if old_left > 0.0 || new_left > 0.0 {
            // a hunk's lines reach here only once a header has made its file
            let last = files.len() - 1;
            files[last].hunks.push(line);
            let first = line.first();
            old_left -= if matches!(first, Some(b'+' | b'\\')) { 0.0 } else { 1.0 };
            new_left -= if matches!(first, Some(b'-' | b'\\')) { 0.0 } else { 1.0 };
            continue;
        }
        if line.starts_with(b"--- ") && lines.get(i).is_some_and(|next| next.starts_with(b"+++ ")) {
            files.push(file_of(header_path(line), header_path(lines[i])));
            i += 1;
        } else if let (Some(file), Some((old, new))) = (files.last_mut(), hunk(line)) {
            file.hunks.push(line);
            (old_left, new_left) = (old, new);
        } else if let Some(file) = files.last_mut().filter(|file| !file.hunks.is_empty() && line.starts_with(b"\\")) {
            file.hunks.push(line);
        }
    }
    files.iter().filter(|file| !file.hunks.is_empty()).map(patched).collect()
}

/// ACP diff blocks: whole-file old and new text by the spec (a new file has no old text).
fn block_changes(diffs: &[Cow<'_, Object>]) -> Result<Vec<Value>, Thrown> {
    diffs
        .iter()
        .map(|diff| {
            let path = diff.get("path");
            let (kind, text) = match given(diff.get("oldText")) {
                None => (add(), text_or_empty(diff.get("newText"))?),
                old => (update(), replace_diff(old, diff.get("newText"))?),
            };
            let mut item = Object::default();
            if let Some(path) = path {
                item.push("path", path.clone());
            }
            item.push("kind", kind);
            item.push("diff", Value::String(text));
            Ok(Value::Object(item))
        })
        .collect()
}

/// An edit call's input, for an agent that sends no diff block for it: a replacement or a whole file. A write is a new file
/// only when the agent says the file did not exist, or as a preview while it runs; a finished one that existed, or that
/// never said, carries no patch, since its old text is unknown: Undo must neither empty nor delete the file.
fn input_changes(tc: &Object) -> Result<Vec<Value>, Thrown> {
    let input = tc.get("rawInput");
    let path = ["filePath", "file_path", "path"].iter().map(|key| at(input, key)).chain([at(first(tc.get("locations")), "path")]);
    let Some(path) = path.flatten().find(|path| matches!(path, Value::String(text) if !text.is_empty())) else {
        return Ok(Vec::new());
    };
    let old = given(at(input, "oldString")).or(given(at(input, "old_string")));
    if let Some(old @ Value::String(_)) = old {
        let new = given(at(input, "newString")).or(given(at(input, "new_string")));
        return Ok(vec![change(path.clone(), update(), replace_diff(Some(old), new)?)]);
    }
    let Some(content) = string(at(input, "content")) else { return Ok(Vec::new()) };
    let running = !is(tc.get("status"), "completed") && !is(tc.get("status"), "failed");
    let exists = at(at(tc.get("rawOutput"), "metadata"), "exists");
    if exists == Some(&Value::Bool(false)) || (running && exists != Some(&Value::Bool(true))) {
        return Ok(vec![change(path.clone(), add(), content.clone())]);
    }
    Ok(vec![change(path.clone(), update(), Text::default())])
}

/// The changes a tool call made, or none when it is not a file edit we can place: a patch in its output first, then its
/// diff blocks (any kind), then an edit's input.
pub fn edit_changes(tc: &Object) -> Result<Vec<Value>, Thrown> {
    let blocks = content_blocks(tc.get("content"));
    let diffs: Vec<_> = blocks.into_iter().filter(|block| is(block.get("type"), "diff")).collect();
    let edit = is(tc.get("kind"), "edit");
    if edit || !diffs.is_empty() {
        let patched = patch_changes(at(at(tc.get("rawOutput"), "metadata"), "diff"));
        if !patched.is_empty() {
            return Ok(patched);
        }
    }
    if !diffs.is_empty() {
        return block_changes(&diffs);
    }
    if edit {
        return input_changes(tc);
    }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsvalue::json::{parse, write, Numbers};

    fn value(text: &str) -> Value {
        parse(text).expect("JSON")
    }

    fn object(text: &str) -> Object {
        value(text).as_object().expect("an object").clone()
    }

    fn json(changes: Vec<Value>) -> String {
        let mut out = Vec::new();
        write(&mut out, &Value::Array(changes), Numbers::Stringified);
        String::from_utf8(out).expect("UTF-8")
    }

    fn patch(text: &str) -> String {
        json(patch_changes(Some(&Value::text(text))))
    }

    fn edits(tc: &str) -> String {
        json(edit_changes(&object(tc)).expect("changes"))
    }

    #[test]
    fn a_replacement_counts_its_lines() {
        let diff = replace_diff(Some(&Value::text("a\nb")), Some(&Value::text("c")));
        assert_eq!(diff, Ok(Text::from("@@ -1,2 +1,1 @@\n-a\n-b\n+c")));
        assert_eq!(replace_diff(Some(&Value::text("")), None), Ok(Text::from("@@ -1,1 +1,1 @@\n-\n+")));
        assert_eq!(replace_diff(None, Some(&Value::Null)), Ok(Text::from("@@ -1,1 +1,1 @@\n-undefined\n+")));
    }

    #[test]
    fn a_patch_is_its_files_each_with_only_its_hunks() {
        assert_eq!(
            patch("Index: x\n--- a/one\t2024\n+++ b/one\t2024\n@@ -1 +1 @@\n-a\n+b\n\\ end\n--- /dev/null\n+++ b/two\n@@ -0,0 +1 @@\n+x\n"),
            r#"[{"path":"one","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-a\n+b\n\\ end"},{"path":"two","kind":{"type":"add"},"diff":"@@ -0,0 +1 @@\n+x"}]"#
        );
        assert_eq!(
            patch("--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"),
            r#"[{"path":"gone","kind":{"type":"delete"},"diff":"@@ -1 +0,0 @@\n-x"}]"#
        );
    }

    #[test]
    fn a_hunks_lines_are_counted_so_content_is_not_read_as_a_header() {
        let text = "--- a/q\n+++ b/q\n@@ -1,3 +1,3 @@\n keep\n--- old\n+++ new\n";
        assert_eq!(
            patch(text),
            r#"[{"path":"q","kind":{"type":"update","move_path":null},"diff":"@@ -1,3 +1,3 @@\n keep\n--- old\n+++ new\n"}]"#
        );
    }

    #[test]
    fn what_is_no_patch_has_no_changes() {
        for text in [
            "",
            "no patch",
            "--- a\nnext",
            "--- a\n",
            "@@ -1 +1 @@\n",
            "--- a/x\n+++ b/x\n",
            "--- a\n+++ b\n@@ -x +1 @@\n",
            "--- a\n+++ b\n@@ -1, +1 @@\n",
            "--- a\n+++ b\n@@ -1 +1\n",
            "--- a\n+++ b\n\\ early\n",
        ] {
            assert_eq!(patch(text), "[]", "{text:?}");
        }
        assert_eq!(patch_changes(Some(&Value::Number(42.0))), Vec::new());
        assert_eq!(patch_changes(None), Vec::new());
    }

    #[test]
    fn a_header_path_loses_what_follows_a_tab_on_its_last_line() {
        assert_eq!(header_path(b"--- a\tb"), b"a");
        assert_eq!(header_path(b"--- a"), b"a");
        assert_eq!(header_path(b"--- a\tb\rc\td"), b"a\tb\rc");
        assert_eq!(header_path("--- a\tb\u{2028}c".as_bytes()), "a\tb\u{2028}c".as_bytes());
    }

    #[test]
    fn counts_as_large_as_a_double_never_run_out() {
        let huge = format!("--- a\n+++ b\n@@ -1,{} +1 @@\n x\n y\n", "9".repeat(400));
        assert_eq!(patch(&huge).matches("x\\n y").count(), 1);
    }

    #[test]
    fn a_diff_block_is_a_new_file_or_a_replacement() {
        assert_eq!(
            edits(r#"{"content":[{"type":"diff","path":"a","newText":"x"}]}"#),
            r#"[{"path":"a","kind":{"type":"add"},"diff":"x"}]"#
        );
        assert_eq!(
            edits(r#"{"content":[{"type":"diff","path":"a","oldText":null}]}"#),
            r#"[{"path":"a","kind":{"type":"add"},"diff":""}]"#
        );
        assert_eq!(
            edits(r#"{"content":[{"type":"diff","oldText":"o","newText":"n"}]}"#),
            r#"[{"kind":{"type":"update","move_path":null},"diff":"@@ -1,1 +1,1 @@\n-o\n+n"}]"#
        );
        assert!(edit_changes(&object(r#"{"content":[{"type":"diff","oldText":{"toString":1}}]}"#)).is_err());
    }

    #[test]
    fn a_patch_in_its_output_comes_first() {
        let patch = "--- a/q\\n+++ b/q\\n@@ -1 +1 @@\\n-a\\n+b";
        let tc = format!(r#"{{"kind":"edit","rawOutput":{{"metadata":{{"diff":"{patch}"}}}},"rawInput":{{"path":"/p","oldString":"x"}}}}"#);
        assert!(edits(&tc).contains(r#""path":"q""#));
        let blocks = format!(r#"{{"content":[{{"type":"diff","path":"a"}}],"rawOutput":{{"metadata":{{"diff":"{patch}"}}}}}}"#);
        assert!(edits(&blocks).contains(r#""path":"q""#));
        // only an edit, or a call with diff blocks, reads it
        assert_eq!(edits(&format!(r#"{{"rawOutput":{{"metadata":{{"diff":"{patch}"}}}}}}"#)), "[]");
        let empty = r#"{"kind":"edit","rawOutput":{"metadata":{"diff":"none"}},"rawInput":{"path":"/p","oldString":"x"}}"#;
        assert!(edits(empty).contains(r#""path":"/p""#));
    }

    #[test]
    fn an_edits_input_says_what_it_can_place() {
        let update = r#"{"type":"update","move_path":null}"#;
        assert_eq!(
            edits(r#"{"kind":"edit","rawInput":{"file_path":"/a","old_string":"x","new_string":"y"}}"#),
            format!(r#"[{{"path":"/a","kind":{update},"diff":"@@ -1,1 +1,1 @@\n-x\n+y"}}]"#)
        );
        assert_eq!(
            edits(r#"{"kind":"edit","rawInput":{"filePath":"/a","oldString":"x"}}"#),
            format!(r#"[{{"path":"/a","kind":{update},"diff":"@@ -1,1 +1,1 @@\n-x\n+"}}]"#)
        );
        let running = r#"[{"path":"/a","kind":{"type":"add"},"diff":"body"}]"#;
        assert_eq!(edits(r#"{"kind":"edit","rawInput":{"path":"/a","content":"body"}}"#), running);
        assert_eq!(edits(r#"{"kind":"edit","locations":[{"path":"/a"}],"rawInput":{"content":"body"}}"#), running);
        assert_eq!(
            edits(
                r#"{"kind":"edit","status":"completed","rawInput":{"path":"/a","content":"body"},"rawOutput":{"metadata":{"exists":false}}}"#
            ),
            running
        );
        for done in [r#""status":"completed""#, r#""status":"failed""#, r#""rawOutput":{"metadata":{"exists":true}}"#] {
            let tc = format!(r#"{{"kind":"edit",{done},"rawInput":{{"path":"/a","content":"body"}}}}"#);
            assert_eq!(edits(&tc), format!(r#"[{{"path":"/a","kind":{update},"diff":""}}]"#), "{done}");
        }
        for nothing in [
            r#"{"kind":"edit"}"#,
            r#"{"kind":"edit","rawInput":{"path":"","content":"x"}}"#,
            r#"{"kind":"edit","rawInput":{"path":7,"content":"x"}}"#,
            r#"{"kind":"edit","rawInput":{"path":"/a"}}"#,
            r#"{"kind":"edit","rawInput":{"path":"/a","oldString":7,"content":7}}"#,
            r#"{"kind":"read","rawInput":{"path":"/a","content":"x"}}"#,
        ] {
            assert_eq!(edits(nothing), "[]", "{nothing}");
        }
    }
}
