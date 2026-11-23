//! Claude user messages: Claude Code's status notes, the app's own /model, and a prompt's content without its markup.

use crate::blocks::content_blocks;
use crate::claude::agent_runs::{parse_task_notification, Notification};
use crate::claude::common::{cat, first_line, joined, text_blocks};
use crate::claude::patterns as re;
use crate::reads::{at, is, string, text_from, text_of};
use crate::Thrown;
use jsvalue::js::{given, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

/// Claude Code's internal markup out of a prompt; `None` when nothing a person can read is left.
fn clean_prompt(text: &[u8]) -> Option<Text> {
    if let Some(name) = re::command_name(text) {
        let args = re::between(text, b"<command-args>", b"</command-args>").map(trim).filter(|args| !args.is_empty());
        let mut line = text_from(name);
        if let Some(args) = args {
            line.push_str(" ");
            line.push_text(&text_from(args));
        }
        return Some(text_from(trim(line.as_bytes()))).filter(|text| !text.is_empty());
    }
    if re::is_local_output(text) {
        return None;
    }
    let kept = re::without_reminders(text);
    Some(text_from(trim(&kept))).filter(|text| !text.is_empty())
}

/// What Claude Code injected as a user turn, shown as a line of its own.
pub enum Status {
    /// a sub-agent's final report, delivered as a message
    Handback {
        agent: Value,
        report: Text,
    },
    Task {
        text: Text,
        notification: Notification,
    },
    /// a line with no work behind it: a turn something other than the user woke, or a peer's message
    Line {
        kind: &'static str,
        text: Text,
        wake: Option<Object>,
    },
}

/// The message's text, as its status is read from it.
fn status_text(content: Option<&Value>) -> Text {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => joined(&text_blocks(content), "\n"),
        _ => Text::default(),
    }
}

/// A sub-agent's report: the agent's id and its report, without the frame's indentation.
fn parse_handback(message: &Value, text: &Text) -> Option<Status> {
    let origin = message.field("origin");
    let bytes = text.as_bytes();
    let from = given(at(origin, "from")).cloned().or_else(|| re::handback_from(bytes).map(|from| Value::String(text_from(from))))?;
    let handback = at(origin, "handback").is_some_and(truthy) || re::find(bytes, b"[Subagent hand-back]", 0).is_some();
    if !truthy(&from) || !handback {
        return None;
    }
    let body = re::dedent(re::handback_body(bytes).unwrap_or_default());
    Some(Status::Handback { agent: from, report: text_from(trim(&body)) })
}

/// A Monitor's event as the note heading the turn it woke. The watch goes on: no task card.
pub fn monitor_wake(notification: &Notification) -> Status {
    let summary = notification.summary.as_ref();
    let label =
        summary.and_then(|summary| re::monitor_label(summary.as_bytes())).map(trim).filter(|label| !label.is_empty()).map(text_from);
    let label = label.or_else(|| notification.description.clone()).unwrap_or_else(|| "Monitor".into());
    let event = notification.event.as_ref().map_or(&[][..], |event| trim(event.as_bytes()));
    let lines: Vec<Text> = event.split(|byte| *byte == b'\n').filter(|line| !trim(line).is_empty()).map(text_from).collect();
    let detail = Value::String(first_line(&joined(&lines, ", ")));
    let wake = Object::of([
        ("by", Value::text("monitor")),
        ("key", Value::String(notification.task_id.clone().unwrap_or_else(|| label.clone()))),
        ("label", Value::String(label.clone())),
        ("detail", detail),
        ("failed", Value::Bool(re::says_failed(event))),
    ]);
    Status::Line { kind: "wake", text: cat!("Monitor event \u{b7} ", label), wake: Some(wake) }
}

/// A /loop check-in firing: the turn it starts is the check-in's, never the user's words again.
fn check_in(text: &Text) -> Status {
    let kept = re::without_reminders(text.as_bytes());
    let prompt = text_from(trim(&kept));
    let label = if prompt.is_empty() { "Scheduled check-in".into() } else { first_line(&prompt) };
    let wake = Object::of([
        ("by", Value::text("checkin")),
        ("key", Value::text("checkin")),
        ("label", Value::String(label)),
        ("detail", Value::Null),
        ("failed", Value::Bool(false)),
    ]);
    Status::Line { kind: "wake", text: "Scheduled check-in".into(), wake: Some(wake) }
}

/// Status that Claude Code injects as a user turn, shown as a one-line note instead of a user bubble.
pub fn status_note(message: &Value) -> Option<Status> {
    let text = status_text(at(message.field("message"), "content"));
    let origin = at(message.field("origin"), "kind");
    if let Some(handback) = parse_handback(message, &text) {
        return Some(handback);
    }
    let bytes = text.as_bytes();
    if is(origin, "task-notification") || re::notification_root(bytes).is_some() {
        let notification = parse_task_notification(bytes);
        // a Monitor's tick carries an event, not a status: the task goes on, so no card, but the turn it wakes says why
        if notification.event.is_some() {
            return Some(monitor_wake(&notification));
        }
        let text = notification.summary.clone().unwrap_or_else(|| match &notification.status {
            Some(status) => cat!("Background task ", status),
            None => "Background task update".into(),
        });
        return Some(Status::Task { text, notification });
    }
    let scheduled = is(message.field("turnOrigin"), "scheduled") || is(origin, "scheduled");
    if message.field("isMeta") == Some(&Value::Bool(true)) && scheduled {
        return Some(check_in(&text));
    }
    if is(origin, "peer") || re::is_cross_session(bytes) {
        let text = match re::cross_session_name(bytes).filter(|name| !name.is_empty()) {
            Some(name) => cat!("Message from another Claude session \u{b7} ", text_from(name)),
            None => "Message from another Claude session".into(),
        };
        return Some(Status::Line { kind: "peer", text, wake: None });
    }
    None
}

/// A `/model` the CLI writes to the transcript when the app switches a live session's model through the SDK, which no one
/// typed (#2304): it has no human origin, and read back it would be the user's message.
pub fn app_model_switch(message: &Value) -> bool {
    if is(at(message.field("origin"), "kind"), "human") {
        return false;
    }
    let content = at(message.field("message"), "content");
    let first_text;
    let text = match content {
        Some(Value::String(text)) => Some(text),
        _ => {
            first_text = text_blocks(content).into_iter().next();
            first_text.as_ref()
        }
    };
    text.is_some_and(|text| re::after_opening(text.as_bytes(), b"<command-name>/model</command-name>").is_some())
}

/// A prompt's text as a user message holds it.
fn text_input(text: Text) -> Value {
    Value::Object(Object::of([("type", Value::text("text")), ("text", Value::String(text)), ("text_elements", Value::Array(Vec::new()))]))
}

/// A prompt's content, as a user message holds it.
pub fn user_content(content: Option<&Value>) -> Result<Vec<Value>, Thrown> {
    if let Some(Value::String(text)) = content {
        return Ok(clean_prompt(text.as_bytes()).map(text_input).into_iter().collect());
    }
    let mut out = Vec::new();
    for block in content_blocks(content) {
        if is(block.get("type"), "text") {
            let text = string(block.get("text")).map_or(&[][..], |text| text.as_bytes());
            out.extend(clean_prompt(text).map(text_input));
        } else if is(block.get("type"), "image") && is(at(block.get("source"), "type"), "base64") {
            let source = block.get("source");
            let (kind, data) = (text_of(at(source, "media_type"))?, text_of(at(source, "data"))?);
            let url = cat!("data:", kind, ";base64,", data);
            out.push(Value::Object(Object::of([("type", Value::text("image")), ("url", Value::String(url))])));
        }
    }
    Ok(out)
}
