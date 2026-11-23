//! ACP content blocks as text (shared/contentBlocks.mjs, `blockText` and `toolOutput` of shared/acpItems/toolItems.mjs).

use crate::reads::{at, is, string, text_of};
use crate::Thrown;
use jsvalue::js::given;
use jsvalue::value::{Object, Text, Value};
use std::borrow::Cow;

/// The block as text fields have it, or `None` for what isn't one: missing text is empty, and any other kind of value in a
/// text field is malformed, never coerced into message text.
pub fn normalize(block: Option<&Value>) -> Option<Cow<'_, Object>> {
    let Some(Value::Object(object)) = block else { return None };
    let field = match object.get("type") {
        kind if is(kind, "text") => "text",
        kind if is(kind, "thinking") || is(kind, "redacted_thinking") => "thinking",
        _ => return Some(Cow::Borrowed(object)),
    };
    match object.get(field) {
        None | Some(Value::Null) => {
            let mut filled = object.clone();
            filled.set(field, Value::String(Text::default()));
            Some(Cow::Owned(filled))
        }
        Some(Value::String(_)) => Some(Cow::Borrowed(object)),
        Some(_) => None,
    }
}

/// `content`'s blocks, if it is a list.
pub fn content_blocks(content: Option<&Value>) -> Vec<Cow<'_, Object>> {
    match content {
        Some(Value::Array(blocks)) => blocks.iter().filter_map(|block| normalize(Some(block))).collect(),
        _ => Vec::new(),
    }
}

/// `[title](uri)`, as a resource link reads in markdown.
fn link(block: &Object) -> Result<Text, Thrown> {
    let uri = block.get("uri");
    let title = given(block.get("title")).or(given(block.get("name"))).or(uri);
    let mut text = Text::from("[");
    text.push_text(&text_of(title)?);
    text.push_str("](");
    text.push_text(&text_of(uri)?);
    text.push_str(")");
    Ok(text)
}

/// Text of one content block, as markdown.
pub fn block_text(block: Option<&Value>) -> Result<Text, Thrown> {
    let Some(block) = normalize(block) else { return Ok(Text::default()) };
    Ok(match block.get("type") {
        kind if is(kind, "text") => string(block.get("text")).cloned().unwrap_or_default(),
        kind if is(kind, "resource_link") => link(&block)?,
        kind if is(kind, "resource") => string(at(block.get("resource"), "text")).cloned().unwrap_or_default(),
        kind if is(kind, "image") => "[image]".into(),
        _ => Text::default(),
    })
}

/// Text of a tool call's content list: its content blocks and terminal output.
pub fn tool_output(content: Option<&Value>) -> Result<Text, Thrown> {
    let mut output = Text::default();
    for entry in content_blocks(content) {
        if !is(entry.get("type"), "content") {
            continue;
        }
        let text = block_text(entry.get("content"))?;
        if !text.is_empty() {
            if !output.is_empty() {
                output.push_str("\n");
            }
            output.push_text(&text);
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsvalue::json::parse;

    fn value(text: &str) -> Value {
        parse(text).expect("JSON")
    }

    fn text(block: &str) -> String {
        block_text(Some(&value(block))).expect("a block").lossy()
    }

    fn output(content: &str) -> String {
        tool_output(Some(&value(content))).expect("a list").lossy()
    }

    #[test]
    fn each_kind_of_block_reads_as_markdown() {
        assert_eq!(text(r#"{"type":"text","text":"hi"}"#), "hi");
        assert_eq!(text(r#"{"type":"text"}"#), "");
        assert_eq!(text(r#"{"type":"text","text":null}"#), "");
        assert_eq!(text(r#"{"type":"image","data":"x"}"#), "[image]");
        assert_eq!(text(r#"{"type":"audio"}"#), "");
        assert_eq!(text(r#"{"type":"resource","resource":{"text":"body"}}"#), "body");
        assert_eq!(text(r#"{"type":"resource","resource":{"blob":"b"}}"#), "");
        assert_eq!(text(r#"{"type":"resource"}"#), "");
        assert_eq!(text(r#"{"type":"resource_link","uri":"u","title":"t","name":"n"}"#), "[t](u)");
        assert_eq!(text(r#"{"type":"resource_link","uri":"u","name":"n"}"#), "[n](u)");
        assert_eq!(text(r#"{"type":"resource_link","uri":"u"}"#), "[u](u)");
        assert_eq!(text(r#"{"type":"resource_link"}"#), "[undefined](undefined)");
        assert_eq!(text(r#"{"type":"resource_link","uri":1,"title":null}"#), "[1](1)");
    }

    #[test]
    fn what_is_no_block_has_no_text() {
        for block in ["null", "7", r#""text""#, "[]", r#"{"type":"text","text":7}"#, r#"{"type":"thinking","thinking":{}}"#] {
            assert_eq!(text(block), "", "{block}");
        }
        assert_eq!(block_text(None), Ok(Text::default()));
    }

    #[test]
    fn a_block_with_no_string_throws_as_the_js_did() {
        for block in [r#"{"type":"resource_link","uri":{"toString":1}}"#, r#"{"type":"resource_link","uri":"u","title":{"toString":1}}"#] {
            assert!(block_text(Some(&value(block))).is_err(), "{block}");
        }
        assert!(tool_output(Some(&value(r#"[{"type":"content","content":{"type":"resource_link","uri":{"toString":1}}}]"#))).is_err());
    }

    #[test]
    fn text_fields_fill_in_place() {
        let filled = normalize(Some(&value(r#"{"thinking":null,"type":"redacted_thinking"}"#))).expect("a block").into_owned();
        assert_eq!(filled.entries()[0].0, Text::from("thinking"));
        assert_eq!(filled.get("thinking"), Some(&Value::text("")));
        let filled = normalize(Some(&value(r#"{"type":"thinking"}"#))).expect("a block").into_owned();
        assert_eq!(filled.get("thinking"), Some(&Value::text("")));
        assert!(matches!(normalize(Some(&value(r#"{"type":"thinking","thinking":"t"}"#))), Some(Cow::Borrowed(_))));
    }

    #[test]
    fn a_tool_output_joins_its_content_blocks() {
        let content = r#"[{"type":"content","content":{"type":"text","text":"a"}},null,{"type":"diff"},
            {"type":"content","content":{"type":"text","text":""}},{"type":"content","content":{"type":"image"}}]"#;
        assert_eq!(output(content), "a\n[image]");
        assert_eq!(output(r#"{"not":"a list"}"#), "");
        assert_eq!(tool_output(None), Ok(Text::default()));
    }
}
