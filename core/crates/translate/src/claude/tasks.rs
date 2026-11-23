//! What a Claude translator does for work that goes on beside its turn: status notes, sub-agents' messages and Agent rows, and
//! background tasks settling.

use crate::blocks::content_blocks;
use crate::claude::agent_runs::{
    count_of, is_handback_notice, parse_agent_trailer, settle_agent, settled_status, task_kind, Notification, Settled,
};
use crate::claude::agent_transcript::AgentTranscript;
use crate::claude::common::{cat, first_line, map_key, ms_time, num};
use crate::claude::patterns as re;
use crate::claude::signals::tool_line;
use crate::claude::translator::Translator;
use crate::claude::Said;
use crate::reads::{at, is, string, text_from, text_of};
use crate::Thrown;
use jsvalue::js::{given, strict_equals, to_text, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

const AGENT_ACTIVITY: usize = 30;

/// A one-line note in a turn.
pub struct Note {
    pub kind: &'static str,
    pub text: Value,
    pub task: Option<Object>,
    pub wake: Option<Object>,
}

impl Note {
    /// A line with no work behind it.
    pub fn line(kind: &'static str, text: Text, wake: Option<Object>) -> Note {
        Note { kind, text: Value::String(text), task: None, wake }
    }
}

impl Translator {
    pub(crate) fn new_child(&self, key: Option<Value>) -> AgentTranscript {
        AgentTranscript::new(key, self.thread.clone(), self.cwd.clone())
    }

    /// Tools the agent at `key` left running were cut off, if it has a transcript.
    pub(crate) fn cut_child(&mut self, key: &Text) {
        let says = self.says_children;
        let said = self
            .children
            .get_mut(key)
            .and_then(|child| (child.cut_off() && says).then(|| Said::Children { key: child.key.clone(), items: child.items.clone() }));
        self.out.extend(said);
    }

    /// The notes' home: a settle note goes on its task's running card, which it replaces.
    pub(crate) fn note(&mut self, note: Note, id: Value) -> Result<(), Thrown> {
        let settled = note.task.as_ref().filter(|task| !is(task.get("status"), "running")).and_then(|task| task.get("taskId")).cloned();
        let card = settled.as_ref().map(|id| map_key(Some(id)));
        if let Some(home) = card.and_then(|card| self.running_cards.remove(&card)) {
            let id = cat!("task-", text_of(settled.as_ref())?, "-running");
            let mut item = Object::of([
                ("type", Value::text("statusNote")),
                ("id", Value::String(id)),
                ("kind", Value::text(note.kind)),
                ("text", note.text),
            ]);
            item.push("task", note.task.map_or(Value::Null, Value::Object));
            self.completed(home, item);
            return Ok(());
        }
        if !self.is_running() {
            self.pending_notes.push((note, id));
            return Ok(());
        }
        let mut item = Object::of([("type", Value::text("statusNote")), ("id", id), ("kind", Value::text(note.kind)), ("text", note.text)]);
        if let Some(task) = note.task {
            item.push("task", Value::Object(task));
        }
        if let Some(wake) = note.wake {
            item.push("wake", Value::Object(wake));
        }
        self.completed(self.turn_id.clone(), item);
        Ok(())
    }

    /// The Agent row of a call still running in this turn, or of a background agent still being followed.
    fn agent_item(&self, key: &Text) -> Option<Object> {
        match self.tools.get(key) {
            Some(tool) if is(tool.get("type"), "collabAgentToolCall") => Some(tool.clone()),
            _ => self.background.get(key).map(|held| held.item.clone()),
        }
    }

    /// Show an Agent row's new state, in the turn it belongs to.
    fn put_agent(&mut self, key: &Text, item: Object) {
        let turn = if self.tools.contains(key) {
            self.tools.set(key.clone(), item.clone());
            self.turn_id.clone()
        } else {
            // every row a key finds is one or the other
            self.background.get_mut(key).and_then(|held| {
                held.item = item.clone();
                held.turn.clone()
            })
        };
        self.out.push(Said::Updated { turn, item });
    }

    /// A sub-agent's message: into its own transcript (the agent page), and its Agent row's heartbeat (tool count, latest tool,
    /// model) and activity lines (the latest few are kept).
    pub(crate) fn on_subagent(&mut self, m: &Value) -> Result<(), Thrown> {
        let key = map_key(m.field("parent_tool_use_id"));
        let (now, says) = (self.now, self.says_children);
        let Some(child) = self.children.get_mut(&key) else { return Ok(()) };
        let changed = child.add(m, now);
        // what it said goes out as it stands: an agent launched under its own key takes its place from here on
        let said = (says && matches!(changed, Ok(true))).then(|| Said::Children { key: child.key.clone(), items: child.items.clone() });
        // each agent it launched, even by a message that went on to fail
        for id in std::mem::take(&mut child.launched) {
            let new = self.new_child(id.clone());
            self.children.insert(map_key(id.as_ref()), new);
        }
        changed?;
        self.out.extend(said);
        let parent = self.agent_item(&key);
        let Some(parent) = parent.filter(|_| is(m.field("type"), "assistant")) else { return Ok(()) };
        let mut lines = Vec::new();
        let mut uses = 0.0;
        let mut last = None;
        for block in content_blocks(at(m.field("message"), "content")) {
            let text = string(block.get("text")).filter(|text| !trim(text.as_bytes()).is_empty());
            if let Some(text) = text.filter(|_| is(block.get("type"), "text")) {
                lines.push(Value::String(first_line(text)));
            } else if is(block.get("type"), "tool_use") {
                lines.push(Value::String(tool_line(&block)?));
                uses += 1.0;
                last = block.get("name").cloned();
            }
        }
        // every row this finds is an Agent call's
        let agent = parent.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();
        let model = at(m.field("message"), "model").filter(|model| truthy(model) && !is(Some(model), "<synthetic>"));
        if lines.is_empty() && !model.is_some_and(|model| !strict_equals(Some(model), agent.get("model"))) {
            return Ok(());
        }
        let mut item = parent.clone();
        let mut activity = parent.get("activity").and_then(Value::as_array).unwrap_or_default().to_vec();
        activity.extend(lines);
        item.set("activity", Value::Array(activity.split_off(activity.len().saturating_sub(AGENT_ACTIVITY))));
        let mut run = agent.clone();
        run.set("toolUses", Value::Number(count_of(&agent, "toolUses") + uses));
        if let Some(last) = last.filter(|last| *last != Value::Null) {
            run.set("latestTool", last);
        }
        if let Some(model) = model {
            run.set("model", model.clone());
        }
        item.set("agent", Value::Object(run));
        self.put_agent(&key, item);
        Ok(())
    }

    /// A background task settled: its Agent row takes the status (and the report the notification carries), and the transcript
    /// gets a task event, once per task and status. The event, or `None` when it was already shown.
    fn task_settled(&mut self, n: &Settled, when: f64) -> Result<Option<Object>, Thrown> {
        let key = map_key(Some(&n.tool_use_id));
        let held = if truthy(&n.tool_use_id) { self.background.get(&key).map(|held| held.item.clone()) } else { None };
        if let Some(item) = &held {
            let result = string(Some(&n.result)).filter(|result| !is_handback_notice(result));
            let report = result.map(|result| parse_agent_trailer(result).report);
            let run = item.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();
            if let Some(agent) = settle_agent(&run, n, report, when) {
                let done = !is(agent.get("status"), "completed");
                let mut next = item.clone();
                next.set("agent", Value::Object(agent));
                self.put_agent(&key, next);
                if done {
                    self.cut_child(&key);
                }
            }
        }
        let status = settled_status(given(Some(&n.status))).unwrap_or("running");
        let id = given(Some(&n.task_id)).or(given(Some(&n.tool_use_id))).cloned();
        if let Some(id) = id.as_ref().filter(|id| truthy(id)) {
            if !self.noted.insert(cat!(to_text(id)?, ":", status)) {
                return Ok(None);
            }
        }
        // read as a string, and said as it came
        let said = given(Some(&n.summary));
        let summary = said.map_or(Ok(Text::default()), to_text)?;
        let kind = given(Some(&n.kind)).cloned().or_else(|| self.launched.get(&key).map(|kind| Value::text(kind)));
        let kind = kind.unwrap_or_else(|| Value::text(if re::opens_with_agent(summary.as_bytes()) { "agent" } else { "task" }));
        let title = given(Some(&n.description))
            .cloned()
            .or_else(|| held.as_ref().and_then(|item| given(at(item.get("agent"), "description")).cloned()));
        let quoted = || re::first_quoted(summary.as_bytes()).map(|quoted| Value::String(text_from(quoted)));
        let title = title.or_else(quoted).or_else(|| said.filter(|said| truthy(said)).cloned()).unwrap_or(Value::text("Background task"));
        Ok(Some(Object::of([
            ("taskId", id.unwrap_or(Value::String(Text::default()))),
            ("kind", kind),
            ("title", title),
            ("status", Value::text(status)),
            ("durationMs", n.duration_ms.map_or(Value::Null, Value::Number)),
            ("toolUseId", given(Some(&n.tool_use_id)).cloned().unwrap_or(Value::Null)),
        ])))
    }

    /// The SDK's task_notification for a task this session launched in the background.
    pub(crate) fn on_task_notification(&mut self, m: &Value) -> Result<(), Thrown> {
        let key = m.field("tool_use_id");
        if !key.is_some_and(truthy) || !self.launched.contains_key(&map_key(key)) || m.field("ambient").is_some_and(truthy) {
            return Ok(());
        }
        let usage = given(m.field("usage"));
        let summary = m.field("summary").filter(|summary| truthy(summary)).cloned();
        let settled = Settled {
            task_id: given(m.field("task_id")).cloned().unwrap_or(Value::Null),
            tool_use_id: key.cloned().unwrap_or(Value::Null),
            status: m.field("status").cloned().unwrap_or(Value::Null),
            summary: summary.clone().unwrap_or(Value::Null),
            description: Value::Null,
            result: Value::Null,
            kind: Value::Null,
            tokens: num(at(usage, "total_tokens")),
            tool_uses: num(at(usage, "tool_uses")),
            duration_ms: num(at(usage, "duration_ms")),
        };
        let Some(task) = self.task_settled(&settled, self.now)? else { return Ok(()) };
        let status = text_of(task.get("status"))?;
        let id = text_of(task.get("taskId"))?;
        let text = summary.unwrap_or_else(|| Value::String(cat!("Background task ", &status)));
        self.note(Note { kind: "task", text, task: Some(task), wake: None }, Value::String(cat!("task-", id, "-", status)))
    }

    /// The output a running Bash command has written so far (main polls it, D-68): the tail the card shows until the result replaces it.
    pub(crate) fn on_bash_output(&mut self, m: &Value) {
        let key = map_key(m.field("tool_use_id"));
        let Some(item) =
            self.tools.get(&key).filter(|item| is(item.get("type"), "commandExecution") && is(item.get("status"), "inProgress"))
        else {
            return;
        };
        let Some(output) = string(m.field("output")).filter(|_| self.is_running()) else { return };
        let mut next = item.clone();
        let shown = if m.field("truncated").is_some_and(truthy) { cat!("\u{2026}\n", output) } else { output.clone() };
        next.set("aggregatedOutput", Value::String(shown));
        self.tools.set(key, next.clone());
        self.out.push(Said::Updated { turn: self.turn_id.clone(), item: next });
    }

    /// A command, monitor or workflow that starts in the background: its running card in the transcript, which its settle note
    /// later replaces in place.
    fn on_background_start(&mut self, m: &Value) -> Result<(), Thrown> {
        let kind = task_kind(m.field("task_type")).unwrap_or("task");
        let task_id = m.field("task_id").filter(|id| truthy(id));
        let Some(task_id) = task_id.filter(|_| m.field("is_backgrounded") == Some(&Value::Bool(true)) && kind != "agent") else {
            return Ok(());
        };
        let described = string(m.field("description")).map(|text| trim(text.as_bytes())).filter(|text| !text.is_empty());
        let title = described.map_or_else(|| "Background task".into(), text_from);
        let task = Object::of([
            ("taskId", task_id.clone()),
            ("kind", Value::text(kind)),
            ("title", Value::String(title.clone())),
            ("status", Value::text("running")),
            ("durationMs", Value::Null),
            ("toolUseId", given(m.field("tool_use_id")).cloned().unwrap_or(Value::Null)),
        ]);
        if self.is_running() {
            self.running_cards.insert(map_key(Some(task_id)), self.turn_id.clone());
        }
        let id = Value::String(cat!("task-", text_of(Some(task_id))?, "-running"));
        self.note(Note { kind: "task", text: Value::String(title), task: Some(task), wake: None }, id)
    }

    /// The sub-agent's progress summary (agentProgressSummaries), usage and latest tool on its Agent card.
    pub(crate) fn on_task_progress(&mut self, m: &Value) -> Result<(), Thrown> {
        let started = is(m.field("subtype"), "task_started");
        let id = m.field("tool_use_id").filter(|id| truthy(id));
        let key = map_key(id);
        let Some(parent) = id.and_then(|_| self.agent_item(&key)) else {
            return if started { self.on_background_start(m) } else { Ok(()) };
        };
        let summary = given(m.field("summary"))
            .or(if started { None } else { given(parent.get("summary")) })
            .filter(|summary| truthy(summary))
            .cloned();
        let mut item = parent.clone();
        item.set("taskId", given(m.field("task_id")).or(given(parent.get("taskId"))).cloned().unwrap_or(Value::Null));
        if let Some(summary) = summary {
            item.set("summary", summary);
        }
        if let Some(agent) = parent.get("agent").and_then(Value::as_object).filter(|_| !started) {
            let usage = given(m.field("usage"));
            let mut run = agent.clone();
            if let Some(tokens) = num(at(usage, "total_tokens")) {
                run.set("tokens", Value::Number(tokens));
            }
            run.set("toolUses", Value::Number(count_of(agent, "toolUses").max(num(at(usage, "tool_uses")).unwrap_or(0.0))));
            if let Some(tool) = given(m.field("last_tool_name")) {
                run.set("latestTool", tool.clone());
            }
            item.set("agent", Value::Object(run));
        }
        self.put_agent(&key, item);
        Ok(())
    }

    /// A sub-agent's report arriving as a message: it becomes its Agent row's report, not a message in the chat.
    pub(crate) fn on_handback(&mut self, agent_id: &Value, report: Text) -> Result<(), Thrown> {
        let running = self.tools.entries().map(|(key, item)| (key, item));
        let background = self.background.entries().map(|(key, held)| (key, &held.item));
        let found = running.chain(background).find(|(_, item)| strict_equals(at(item.get("agent"), "agentId"), Some(agent_id)));
        let Some((key, item)) = found else { return Ok(()) };
        if string(at(item.get("agent"), "report")) == Some(&report) {
            return Ok(());
        }
        let (key, mut next) = (key.clone(), item.clone());
        let mut run = next.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();
        run.set("report", Value::String(report));
        next.set("agent", Value::Object(run));
        self.put_agent(&key, next);
        Ok(())
    }

    /// A `<task-notification>` turn as a task event note, or `None` when that event was already shown.
    pub(crate) fn task_note(&mut self, text: Text, notification: &Notification, when: f64) -> Result<Option<Note>, Thrown> {
        let task = self.task_settled(&Settled::from(notification), when)?;
        Ok(task.map(|task| Note { kind: "task", text: Value::String(text), task: Some(task), wake: None }))
    }

    /// A message's own time, else now.
    pub(crate) fn time_of(&self, m: &Value) -> f64 {
        ms_time(m, self.now)
    }
}
