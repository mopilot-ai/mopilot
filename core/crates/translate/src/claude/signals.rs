//! What the Claude translator reads from single messages: how a `result` ended, Claude Code's goal messages, its notices, a
//! review's findings, an API retry and a `result`'s token usage. Main and the window keep their own JS of the first, the
//! second, the fourth and the last (shared/claudeResult.mjs, claudeGoals.mjs, reviewFindings.mjs, claudeItems/tokenUsage.mjs),
//! and `claude-helpers.json` holds the two to one answer.

use crate::blocks::content_blocks;
use crate::claude::common::{cat, joined, js_add, text_blocks};
use crate::claude::patterns as re;
use crate::claude::Said;
use crate::emit::TurnId;
use crate::reads::{at, is, string, text_from, text_of, text_or_empty};
use crate::turns::math_round;
use crate::Thrown;
use jsvalue::js::{given, join, number_text, to_number, to_text, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

/// The errors of a result a person should read: its `errors` without the CLI's diagnostic lines (anything else stays).
pub fn result_errors(message: &Value) -> Result<Vec<Text>, Thrown> {
    let Some(Value::Array(errors)) = message.field("errors") else { return Ok(Vec::new()) };
    let shown = errors.iter().filter(|error| !matches!(error, Value::String(text) if text.as_bytes().starts_with(b"[ede_diagnostic]")));
    shown.map(to_text).collect()
}

/// Whether a `result` reports a failure: not a success, unless every error it lists is one of the CLI's diagnostics.
pub fn result_failed(message: &Value) -> Result<bool, Thrown> {
    if is(message.field("subtype"), "success") {
        return Ok(message.field("is_error") == Some(&Value::Bool(true)));
    }
    let listed = message.field("errors").and_then(Value::as_array).is_some_and(|errors| !errors.is_empty());
    Ok(!(listed && result_errors(message)?.is_empty()))
}

/// A goal message's text.
fn goal_text(content: Option<&Value>) -> Text {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => joined(&text_blocks(content), "\n"),
        _ => Text::default(),
    }
}

/// "/goal" and "/goal clear" print local command output (a system message live, a tagged user record on disk).
fn local_output(message: &Value) -> Result<Option<Text>, Thrown> {
    if is(message.field("type"), "system") && is(message.field("subtype"), "local_command_output") {
        return text_or_empty(message.field("content")).map(Some);
    }
    if is(message.field("type"), "user") {
        let text = goal_text(at(message.field("message"), "content"));
        if let Some(rest) = re::after_opening(text.as_bytes(), b"<local-command-stdout>") {
            return Ok(re::find(rest, b"</local-command-stdout>", 0).map(|end| text_from(&rest[..end])));
        }
    }
    Ok(None)
}

/// What a message says of a goal, for a note.
enum Goal {
    Set(Text),
    Check(Text),
    /// what the CLI printed says it all
    Said,
}

/// `s.split('\n')[0].trim()`.
fn goal_line(line: &[u8]) -> Text {
    text_from(trim(line.split(|byte| *byte == b'\n').next().unwrap_or_default()))
}

/// The goal event a message is.
fn parse_goal(message: &Value, output: Option<&Text>) -> Option<Goal> {
    if message.field("parent_tool_use_id").is_some_and(truthy) {
        return None;
    }
    let content = at(message.field("message"), "content");
    if is(message.field("type"), "assistant") {
        return re::goal_set(goal_text(content).as_bytes()).map(|condition| Goal::Set(text_from(condition)));
    }
    if let Some(output) = output {
        let text = trim(output.as_bytes());
        if let Some(condition) = re::rest_of_line(text, b"Goal set: ") {
            return Some(Goal::Set(goal_line(condition)));
        }
        let known = re::rest_of_line(text, b"Goal active: ").is_some()
            || re::opens_word(text, b"Goal cleared")
            || re::opens_word(text, b"No goal set");
        return known.then_some(Goal::Said);
    }
    if is(message.field("type"), "user") {
        return re::stop_feedback(goal_text(content).as_bytes()).map(|(_, reason)| Goal::Check(text_from(reason)));
    }
    None
}

/// The one-line note a goal message shows, in place of a reply or a user bubble; `None` when it is no such message.
pub fn goal_note(message: &Value) -> Result<Option<Text>, Thrown> {
    let output = local_output(message)?;
    let Some(goal) = parse_goal(message, output.as_ref()) else { return Ok(None) };
    Ok(Some(match goal {
        Goal::Set(condition) => cat!("Goal set: ", condition),
        Goal::Check(reason) => cat!("Goal not met yet: ", reason),
        Goal::Said => output.map(|output| text_from(trim(output.as_bytes()))).unwrap_or_default(),
    }))
}

/// Native notice text; transcript-only info and raw hook execution events stay internal.
fn hook_note(message: &Value) -> Option<Text> {
    let level = message.field("level");
    let blocked = [message.field("prevent_continuation"), message.field("preventContinuation")].contains(&Some(&Value::Bool(true)));
    if !["notice", "suggestion", "warning"].iter().any(|shown| is(level, shown)) && !(is(level, "info") && blocked) {
        return None;
    }
    let content = re::unix_lines(string(message.field("content"))?.as_bytes());
    // Claude includes the rejected prompt for terminal recovery; Desktop leaves that duplicate out of the notice
    let end = re::find(&content, b"\n\nOriginal prompt: ", 0).unwrap_or(content.len());
    Some(text_from(trim(&content[..end]))).filter(|text| !text.is_empty())
}

/// A native notice as a chat item, keeping its UUID so independent notices never overwrite each other.
pub fn hook_item(message: &Value) -> Option<(Text, Object)> {
    let text = hook_note(message)?;
    let id = string(message.field("uuid")).filter(|id| !id.is_empty())?.clone();
    let fragments = Value::Array(vec![Value::Object(Object::of([("text", Value::String(text))]))]);
    let item = Object::of([("type", Value::text("hookPrompt")), ("id", Value::String(id.clone())), ("fragments", fragments)]);
    Some((id, item))
}

/// The review command a prompt runs ("/code-review low"), or `None`.
pub fn review_command(content: Option<&Value>) -> Option<Text> {
    let text = joined(&text_blocks(content), "\n");
    let bytes = text.as_bytes();
    re::is_review_command(bytes).then(|| text_from(trim(bytes).split(|byte| *byte == b'\n').next().unwrap_or_default()))
}

/// One line for a sub-agent's tool call ("Read src/a.ts", "Bash npm test").
pub fn tool_line(block: &Object) -> Result<Text, Thrown> {
    let empty = Value::Object(Object::default());
    let input = given(block.get("input")).unwrap_or(&empty);
    let keys = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"];
    let arg = keys.iter().find_map(|key| given(input.field(key))).cloned().unwrap_or(Value::String(Text::default()));
    let name = block.get("name");
    let shown = if crate::claude::common::is_mcp(name)? {
        let held = string(name).map_or(&[][..], |name| name.as_bytes());
        let parts: Vec<Text> = crate::claude::tools::split_on_underscores(held).into_iter().skip(1).map(text_from).collect();
        joined(&parts, " \u{b7} ")
    } else {
        text_of(name)?
    };
    let line = if truthy(&arg) { cat!(shown, " ", to_text(&arg)?) } else { shown };
    Ok(crate::claude::common::first_line(&line))
}

/// Claude Code retrying a failed API request (system/api_retry) as the `error` notification with willRetry that every
/// harness's provider failure becomes: the thread's retry banner, not a turn that only says Thinking (#1534).
pub fn api_retry(message: &Value, turn: TurnId) -> Result<Said, Thrown> {
    let count = |value: Option<&Value>| -> Result<f64, Thrown> {
        let number = to_number(value)?;
        Ok(if number.is_nan() { 0.0 } else { number })
    };
    let (attempt, max) = (count(message.field("attempt"))?, count(message.field("max_retries"))?);
    let tries = if attempt == 0.0 {
        String::new()
    } else if max == 0.0 {
        format!(" (attempt {})", number_text(attempt))
    } else {
        format!(" (attempt {} of {})", number_text(attempt), number_text(max))
    };
    let waited = count(at(message.field("no_response"), "waited_ms"))?;
    let parts = [message.field("error_status"), message.field("error")];
    let status: Vec<Value> = parts.into_iter().flatten().filter(|part| truthy(part)).cloned().collect();
    let status = join(&status, " ")?;
    let what = if waited != 0.0 {
        format!("sent no response in {} s", number_text(math_round(waited / 1000.0))).as_str().into()
    } else if status.is_empty() {
        Text::from("returned an error")
    } else {
        cat!("returned ", status)
    };
    let text = cat!("Claude's API ", what, ". Claude Code keeps retrying", tries.as_str(), ".");
    Ok(Said::Retry { turn, message: text })
}

/// `Object.values(value)`, of what `JSON.parse` can make.
fn values_of(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Object(object)) => object.entries().iter().map(|(_, value)| value.clone()).collect(),
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.units().map(|unit| Value::String(unit.into())).collect(),
        _ => Vec::new(),
    }
}

/// `(iterations ?? []).slice(-1)[0]`: what the last request says, or `None`.
fn last_iteration(iterations: Option<&Value>) -> Result<Option<Value>, Thrown> {
    match given(iterations) {
        None => Ok(None),
        Some(Value::Array(items)) => Ok(items.last().cloned()),
        Some(Value::String(text)) => Ok(text.units().last().map(|unit| Value::String(unit.into()))),
        Some(_) => Err("a result's iterations are no list".into()),
    }
}

/// `value ?? 0`.
fn or_zero(value: Option<&Value>) -> Value {
    given(value).cloned().unwrap_or(Value::Number(0.0))
}

/// A `result` message's token usage as the thread's: the last request, the running total and the context window.
pub fn token_usage(message: &Value, previous: Option<&Object>) -> Result<Object, Thrown> {
    let empty = Value::Object(Object::default());
    let usage = given(message.field("usage")).unwrap_or(&empty);
    let last_request = last_iteration(usage.field("iterations"))?;
    let request = given(last_request.as_ref()).unwrap_or(usage);
    let windows = values_of(given(message.field("modelUsage")));
    let window = windows.iter().filter_map(|model| model.field("contextWindow")).find(|window| truthy(window)).cloned();
    let (input, read, write) = (
        or_zero(request.field("input_tokens")),
        or_zero(request.field("cache_read_input_tokens")),
        or_zero(request.field("cache_creation_input_tokens")),
    );
    let input_tokens = js_add(&js_add(&input, &read)?, &write)?;
    let output = or_zero(request.field("output_tokens"));
    let total_tokens = js_add(&input_tokens, &output)?;
    let last = Object::of([
        ("inputTokens", input_tokens),
        ("cachedInputTokens", read),
        ("cacheWriteInputTokens", write),
        ("outputTokens", output),
        ("reasoningOutputTokens", or_zero(at(usage.field("output_tokens_details"), "thinking_tokens"))),
        ("totalTokens", total_tokens),
    ]);
    let total = match previous.and_then(|previous| previous.get("total")).and_then(Value::as_object) {
        Some(before) => {
            let mut total = Object::default();
            for (key, value) in last.entries() {
                let held = before.entries().iter().find(|(name, _)| name == key).map_or(&Value::Null, |(_, held)| held);
                total.set_key(key, js_add(held, value)?);
            }
            total
        }
        None => last.clone(),
    };
    Ok(Object::of([("total", Value::Object(total)), ("last", Value::Object(last)), ("modelContextWindow", window.unwrap_or(Value::Null))]))
}

/// `typeof v === 'string' ? v.trim() : ''`.
fn trimmed(value: Option<&Value>) -> Text {
    string(value).map(|text| text_from(trim(text.as_bytes()))).unwrap_or_default()
}

/// Claude Code's ReportFindings input as findings; an entry without a file or a summary is dropped, so a malformed call
/// never shows a row that points nowhere. The review card's item: `{ type, id, review, level, findings }`.
pub fn review_card(id: Option<&Value>, input: Option<&Value>) -> Result<Object, Thrown> {
    let mut findings = Vec::new();
    let mut lines = Vec::new();
    for finding in at(input, "findings").and_then(Value::as_array).unwrap_or_default() {
        let (file, summary) = (trimmed(finding.field("file")), trimmed(finding.field("summary")));
        if file.is_empty() || summary.is_empty() {
            continue;
        }
        let line = match finding.field("line") {
            Some(Value::Number(line)) if line.fract() == 0.0 && *line > 0.0 => Some(*line),
            _ => None,
        };
        let mut entry = Object::of([("file", Value::String(file.clone()))]);
        entry.push("line", line.map_or(Value::Null, Value::Number));
        entry.push("summary", Value::String(summary.clone()));
        let scenario = trimmed(finding.field("failure_scenario"));
        let category = trimmed(finding.field("category"));
        for (key, value) in [
            ("shortSummary", trimmed(finding.field("short_summary"))),
            ("failureScenario", scenario.clone()),
            ("category", category.clone()),
            ("verdict", trimmed(finding.field("verdict"))),
            ("outcome", trimmed(finding.field("outcome"))),
        ] {
            if !value.is_empty() {
                entry.push(key, Value::String(value));
            }
        }
        findings.push(Value::Object(entry));
        let place = match line {
            Some(line) => cat!(file, ":", number_text(line).as_str()),
            None => file,
        };
        let tag = if category.is_empty() { Text::default() } else { cat!(" (", category, ")") };
        let head = cat!("- `", place, "`", tag, ": ", summary);
        lines.push(if scenario.is_empty() { head } else { cat!(head, "\n  ", scenario) });
    }
    let review = if lines.is_empty() { "No issues found.".into() } else { joined(&lines, "\n") };
    let level = trimmed(at(input, "level"));
    let mut item = Object::of([("type", Value::text("exitedReviewMode"))]);
    if let Some(id) = id {
        item.push("id", id.clone());
    }
    item.push("review", Value::String(review));
    item.push("level", if level.is_empty() { Value::Null } else { Value::String(level) });
    item.push("findings", Value::Array(findings));
    Ok(item)
}

/// The text of a compaction's summary, or of a prompt: a string, or its text blocks joined.
pub fn plain_text(content: Option<&Value>) -> Text {
    match content {
        Some(Value::String(text)) => text.clone(),
        _ => joined(&text_blocks(content), "\n"),
    }
}

/// Whether `content` holds a prompt: a string, or a list with text or an image.
pub fn is_prompt(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(_)) => true,
        Some(Value::Array(_)) => {
            content_blocks(content).iter().any(|block| is(block.get("type"), "text") || is(block.get("type"), "image"))
        }
        _ => false,
    }
}

/// A compaction as its item: `trigger` and `summary` as the harness gave them.
pub fn compaction(id: Option<&Value>, trigger: Option<&Value>, summary: Option<&Text>) -> Object {
    let mut item = Object::of([("type", Value::text("contextCompaction"))]);
    if let Some(id) = id {
        item.push("id", id.clone());
    }
    item.push("trigger", given(trigger).cloned().unwrap_or(Value::Null));
    if let Some(summary) = summary.map(|summary| trim(summary.as_bytes())).filter(|summary| !summary.is_empty()) {
        item.push("summary", Value::String(text_from(summary)));
    }
    item
}
