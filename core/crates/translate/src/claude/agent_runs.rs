//! Claude sub-agent launch and result records, what a background task's notification says, and how its run settles.

use crate::claude::common::{num, result_text};
use crate::claude::patterns as re;
use crate::reads::{is, string, text_from};
use jsvalue::js::{given, strict_equals, truthy};
use jsvalue::value::{Object, Text, Value};
use jsvalue::{prefix_units, trim, unit_length};

const DESCRIPTION_MAX: usize = 80;

/// The first line of a prompt as a title.
fn prompt_title(prompt: Option<&Text>) -> Text {
    let trimmed = prompt.map_or(&[][..], |prompt| trim(prompt.as_bytes()));
    let line = text_from(trim(trimmed.split(|byte| *byte == b'\n').next().unwrap_or_default()));
    if unit_length(line.as_bytes()) > DESCRIPTION_MAX {
        let mut title = prefix_units(&line, DESCRIPTION_MAX - 1);
        title.push_str("\u{2026}");
        title
    } else {
        line
    }
}

/// An Agent result's text split into the report and what the trailer says.
pub struct AgentResult {
    pub report: Text,
    pub agent_id: Option<Text>,
    pub tokens: Option<f64>,
    pub tool_uses: Option<f64>,
}

/// A report the CLI wrapped in its hand-back frame (a notice, then the report indented two spaces): just the report.
fn unframed(raw: &Text) -> Text {
    match re::handback_frame(raw.as_bytes()) {
        Some(frame) => text_from(&re::dedent(&raw.as_bytes()[frame..])),
        None => raw.clone(),
    }
}

/// `parseAgentTrailer`.
pub fn parse_agent_trailer(raw: &Text) -> AgentResult {
    let text = unframed(raw);
    let bytes = text.as_bytes();
    let Some(trailer) = re::trailer(bytes) else {
        return AgentResult { report: text.clone(), agent_id: None, tokens: None, tool_uses: None };
    };
    let mut report = text_from(&bytes[..trailer.index]);
    report.push_bytes(trailer.worktree);
    AgentResult {
        report: text_from(trim(report.as_bytes())),
        agent_id: Some(text_from(trailer.id)),
        tokens: Some(trailer.tokens),
        tool_uses: Some(trailer.tools),
    }
}

/// The run a Task/Agent tool_use starts.
pub fn agent_launch(id: Option<&Value>, input: &Value, at: f64) -> Object {
    let prompt = string(input.field("prompt"));
    let description = string(input.field("description")).map(|text| trim(text.as_bytes())).filter(|text| !text.is_empty());
    let title = prompt_title(prompt);
    let description = description.map_or_else(|| if title.is_empty() { "Agent".into() } else { title }, text_from);
    let mut run = Object::default();
    if let Some(id) = id {
        run.push("key", id.clone());
    }
    let model = string(input.field("model")).cloned().map_or(Value::Null, Value::String);
    for (key, value) in [
        ("description", Value::String(description)),
        ("prompt", prompt.cloned().map_or(Value::Null, Value::String)),
        ("model", model),
        ("background", Value::Bool(input.field("run_in_background") == Some(&Value::Bool(true)))),
        ("status", Value::text("running")),
        ("toolUses", Value::Number(0.0)),
        ("latestTool", Value::Null),
        ("tokens", Value::Null),
        ("startedAt", Value::Number(at)),
        ("completedAt", Value::Null),
        ("report", Value::Null),
        ("transcript", Value::text("full")),
        ("agentId", Value::Null),
    ] {
        run.push(key, value);
    }
    run
}

/// A run's count, which only this makes.
pub fn count_of(object: &Object, key: &str) -> f64 {
    num(object.get(key)).unwrap_or(0.0)
}

/// A status of `tool_use_result` that means the agent goes on in the background (the call returned at once).
fn launched_in_background(status: Option<&Value>) -> bool {
    ["async_launched", "remote_launched", "teammate_spawned"].iter().any(|launched| is(status, launched))
}

/// `/^\s*(?:Async|Remote) agent launched successfully/.test(text)`.
fn says_launched(text: &[u8]) -> bool {
    [&b"Async agent launched successfully"[..], b"Remote agent launched successfully"]
        .iter()
        .any(|words| re::after_opening(text, words).is_some())
}

/// The run once its tool_result came: a foreground one is done; a background launch runs on until its task settles.
pub fn agent_result(agent: &Object, block: &Object, structured: Option<&Value>, at: f64) -> Object {
    let text = result_text(block.get("content"));
    let empty = Value::Object(Object::default());
    let s = structured.filter(|value| matches!(value, Value::Object(_) | Value::Array(_))).unwrap_or(&empty);
    let trailer = parse_agent_trailer(&text);
    let background =
        agent.get("background").is_some_and(truthy) || launched_in_background(s.field("status")) || says_launched(text.as_bytes());
    let mut base = agent.clone();
    base.set("background", Value::Bool(background));
    let found = given(s.field("agentId")).cloned();
    let found = found.or_else(|| trailer.agent_id.clone().map(Value::String));
    let found = found.or_else(|| re::agent_id_anywhere(text.as_bytes()).map(|id| Value::String(text_from(id))));
    base.set("agentId", found.or_else(|| agent.get("agentId").cloned()).unwrap_or(Value::Null));
    let tokens = num(s.field("totalTokens")).or(trailer.tokens).map(Value::Number);
    base.set("tokens", tokens.or_else(|| agent.get("tokens").cloned()).unwrap_or(Value::Null));
    let tools = num(s.field("totalToolUseCount")).or(trailer.tool_uses).unwrap_or(0.0);
    base.set("toolUses", Value::Number(count_of(agent, "toolUses").max(tools)));
    if block.get("is_error").is_some_and(truthy) {
        base.set("status", Value::text("failed"));
        base.set("report", if text.is_empty() { Value::Null } else { Value::String(text) });
        base.set("completedAt", Value::Number(at));
    } else if !background {
        base.set("status", Value::text("completed"));
        base.set("report", if trailer.report.is_empty() { Value::Null } else { Value::String(trailer.report) });
        base.set("completedAt", Value::Number(at));
    }
    base
}

/// A native task type's kind (any `monitor_*` is a monitor); `None` for a type it does not know or none.
pub fn task_kind(kind: Option<&Value>) -> Option<&'static str> {
    let kind = string(kind)?.as_bytes();
    match kind {
        b"local_agent" | b"remote_agent" | b"in_process_teammate" => Some("agent"),
        b"local_bash" => Some("shell"),
        b"local_workflow" => Some("workflow"),
        kind if kind.starts_with(b"monitor") => Some("monitor"),
        _ => None,
    }
}

/// The `<task-notification>` Claude Code injects as a user turn when a background task settles.
pub struct Notification {
    pub task_id: Option<Text>,
    pub tool_use_id: Option<Text>,
    pub status: Option<Text>,
    pub summary: Option<Text>,
    pub description: Option<Text>,
    pub result: Option<Text>,
    /// a monitor's tick: the task goes on, so this is progress, not a status
    pub event: Option<Text>,
    pub kind: Option<&'static str>,
    pub tokens: Option<f64>,
    pub tool_uses: Option<f64>,
    pub duration_ms: Option<f64>,
}

/// `<name>…</name>`, or with `other` for its name, trimmed; `None` for nothing.
fn tag(text: &[u8], name: &str, other: Option<&str>) -> Option<Text> {
    let read = |name: &str| {
        let (open, close) = (format!("<{name}>"), format!("</{name}>"));
        re::between(text, open.as_bytes(), close.as_bytes()).map(trim).filter(|held| !held.is_empty()).map(text_from)
    };
    read(name).or_else(|| other.and_then(read))
}

/// `parseTaskNotification`. Usage reads either `<total_tokens>N</total_tokens>` or `total_tokens: N`.
pub fn parse_task_notification(text: &[u8]) -> Notification {
    let task_type = tag(text, "task-type", Some("task_type")).map(Value::String);
    let kind = task_kind(task_type.as_ref()).or(match re::notification_root(text) {
        Some("agent") => Some("agent"),
        Some("bash") => Some("shell"),
        _ => None,
    });
    Notification {
        task_id: tag(text, "task-id", Some("task_id")),
        tool_use_id: tag(text, "tool-use-id", Some("tool_use_id")),
        status: tag(text, "status", None),
        summary: tag(text, "summary", None),
        description: tag(text, "description", None),
        result: tag(text, "result", None),
        event: tag(text, "event", None),
        kind,
        tokens: re::count(text, &["subagent_tokens", "total_tokens"]),
        tool_uses: re::count(text, &["tool_uses"]),
        duration_ms: re::count(text, &["duration_ms"]),
    }
}

/// What a finished background agent's notification says in place of its report, which came as a hand-back message.
pub fn is_handback_notice(result: &Text) -> bool {
    re::find(result.as_bytes(), b"was delivered to you as a message from", 0).is_some()
}

/// A task's native status as a settled one (Claude Desktop's normalization); `None` while it runs.
pub fn settled_status(status: Option<&Value>) -> Option<&'static str> {
    let Some(Value::String(status)) = status else { return Some("completed") };
    match status.as_bytes() {
        b"running" | b"pending" | b"paused" | b"started" => None,
        b"failed" | b"error" | b"blocked" | b"cancelled" => Some("failed"),
        b"stopped" | b"killed" => Some("stopped"),
        _ => Some("completed"),
    }
}

/// How a background task settled, whichever of its two reports said so.
pub struct Settled {
    pub task_id: Value,
    pub tool_use_id: Value,
    pub status: Value,
    pub summary: Value,
    pub description: Value,
    pub result: Value,
    pub kind: Value,
    pub tokens: Option<f64>,
    pub tool_uses: Option<f64>,
    pub duration_ms: Option<f64>,
}

impl From<&Notification> for Settled {
    fn from(n: &Notification) -> Self {
        let text = |value: &Option<Text>| value.clone().map_or(Value::Null, Value::String);
        Settled {
            task_id: text(&n.task_id),
            tool_use_id: text(&n.tool_use_id),
            status: text(&n.status),
            summary: text(&n.summary),
            description: text(&n.description),
            result: text(&n.result),
            kind: n.kind.map_or(Value::Null, Value::text),
            tokens: n.tokens,
            tool_uses: n.tool_uses,
            duration_ms: n.duration_ms,
        }
    }
}

/// The run once its background task settled; `None` when nothing is new.
pub fn settle_agent(a: &Object, n: &Settled, report: Option<Text>, at: f64) -> Option<Object> {
    let status = settled_status(given(Some(&n.status)))?;
    let held = a.get("report");
    let report = report.map(Value::String).or_else(|| held.cloned()).unwrap_or(Value::Null);
    let running = is(a.get("status"), "running");
    if !running && strict_equals(Some(&report), held) {
        return None;
    }
    let mut run = a.clone();
    if running {
        run.set("status", Value::text(status));
    }
    run.set("report", report);
    if let Some(tokens) = n.tokens {
        run.set("tokens", Value::Number(tokens));
    }
    run.set("toolUses", Value::Number(count_of(a, "toolUses").max(n.tool_uses.unwrap_or(0.0))));
    if given(a.get("completedAt")).is_none() {
        let done = num(a.get("startedAt")).zip(n.duration_ms).map_or(at, |(start, ms)| start + ms);
        run.set("completedAt", Value::Number(done));
    }
    Some(run)
}
