//! What a Claude translator reads of one message of the conversation: a streamed event, a reply with its text and its tool calls,
//! and a user message with the results of those calls.

use crate::blocks::content_blocks;
use crate::claude::common::{cat, is_todo_tool, joined, map_key, ms_time, text_blocks};
use crate::claude::failures::{assistant_text, Taken};
use crate::claude::signals::{goal_note, review_card};
use crate::claude::tasks::Note;
use crate::claude::tools::{complete_tool, tool_item};
use crate::claude::translator::{cut_off, Background, Translator};
use crate::claude::user_messages::{status_note, Status};
use crate::claude::Said;
use crate::emit::{Emit, TurnId};
use crate::reads::{at, is, string, text_from, text_of};
use crate::Thrown;
use jsvalue::js::{given, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

impl Translator {
    pub(crate) fn on_stream(&mut self, event: Option<&Value>) -> Result<(), Thrown> {
        let Some(e) = event.filter(|event| truthy(event)) else { return Ok(()) };
        let kind = e.field("type");
        if is(kind, "message_start") {
            self.ensure_turn()?;
        }
        if !self.is_running() {
            return Ok(());
        }
        let turn = self.turn_id.clone();
        if is(kind, "message_start") {
            self.msg_id = given(at(e.field("message"), "id")).cloned().unwrap_or(Value::String(Text::default()));
            return Ok(());
        }
        let item_id = || Ok::<_, Thrown>(cat!(text_of(Some(&self.msg_id))?, ":", text_of(e.field("index"))?));
        if is(kind, "content_block_start") {
            let block = at(e.field("content_block"), "type");
            let is_text = is(block, "text");
            if !is_text && !is(block, "thinking") {
                return Ok(());
            }
            let id = item_id()?;
            self.stream.entry(map_key(Some(&self.msg_id))).or_default().push((id.clone(), if is_text { "text" } else { "thinking" }));
            let mut item = if is_text {
                assistant_text(&Value::Null, id, Text::default())
            } else {
                Object::of([
                    ("type", Value::text("reasoning")),
                    ("id", Value::String(id)),
                    ("summary", Value::Array(vec![Value::String(Text::default())])),
                    ("content", Value::Array(Vec::new())),
                ])
            };
            if self.source_ids {
                item.set("sourceId", Value::String(id_for_source(&self.msg_id, e.field("index"))?));
            }
            self.started(turn, item);
        } else if is(kind, "content_block_delta") {
            let item = item_id()?;
            let delta = e.field("delta");
            let (text, thought) = match delta.and_then(|delta| delta.field("type")) {
                kind if is(kind, "text_delta") => (string(at(delta, "text")), false),
                kind if is(kind, "thinking_delta") => (string(at(delta, "thinking")), true),
                _ => (None, false),
            };
            if let Some(delta) = text.cloned() {
                self.out.push(Said::Plain(if thought {
                    Emit::ThoughtDelta { turn, item, delta }
                } else {
                    Emit::MessageDelta { turn, item, delta }
                }));
            }
        }
        Ok(())
    }

    fn take_streamed(&mut self, message: Option<&Value>, kind: &str) -> Option<Text> {
        let list = self.stream.get_mut(&map_key(message))?;
        let at = list.iter().position(|held| held.1 == kind)?;
        Some(list.remove(at).0)
    }

    /// The next text or reasoning id without a stream: `<message id>:t<n>`.
    fn own_id(&mut self, message: Option<&Value>, mark: &str) -> Result<Text, Thrown> {
        let id = cat!(text_of(message)?, ":", mark, self.text_count.to_string().as_str());
        self.text_count += 1;
        Ok(id)
    }

    pub(crate) fn on_assistant(&mut self, m: &Value) -> Result<(), Thrown> {
        self.ensure_turn()?;
        let turn = self.turn_id.clone();
        match self.failures.assistant(m, &turn)? {
            Taken::Passed => {}
            Taken::Quiet => return Ok(()),
            Taken::Note(item) | Taken::Retracted(item) => {
                self.last_kind = Some("text");
                self.completed(turn, item);
                return Ok(());
            }
        }
        if self.goal_note(m)? {
            self.last_kind = Some("text");
            return Ok(());
        }
        let content = at(m.field("message"), "content");
        if self.review.is_some() && is(at(m.field("message"), "model"), "<synthetic>") {
            let parts = text_blocks(content);
            let text = joined(&parts, "\n");
            let text = trim(text.as_bytes());
            if !text.is_empty() {
                // the review's findings, as Markdown in the review result card, not as a reply
                let id = match given(m.field("uuid")) {
                    Some(id) => id.clone(),
                    None => Value::String(cat!("review-", self.fresh_id())),
                };
                let review = Value::String(text_from(text));
                self.completed(turn, Object::of([("type", Value::text("exitedReviewMode")), ("id", id), ("review", review)]));
                self.last_kind = Some("text");
                return Ok(());
            }
        }
        let message_id = given(at(m.field("message"), "id")).or(m.field("uuid"));
        for (index, block) in content_blocks(content).into_iter().enumerate() {
            self.assistant_block(m, message_id, &block, &turn, index)?;
        }
        Ok(())
    }

    fn assistant_block(&mut self, m: &Value, message: Option<&Value>, block: &Object, turn: &TurnId, index: usize) -> Result<(), Thrown> {
        let kind = block.get("type");
        let is_tool = is(kind, "tool_use") || is(kind, "server_tool_use");
        let text = string(block.get("text"));
        if is(kind, "text") && text.is_some_and(|text| !trim(text.as_bytes()).is_empty()) {
            self.last_kind = Some("text");
        } else if is_tool {
            self.last_kind = Some("tool");
        }
        if is(kind, "text") {
            let id = match self.take_streamed(message, "text") {
                Some(id) => id,
                None => self.own_id(message, "t")?,
            };
            let mut item = assistant_text(m, id, text.cloned().unwrap_or_default());
            if self.source_ids {
                item.set("sourceId", Value::String(id_for_source(message.unwrap_or(&Value::Null), Some(&Value::Number(index as f64)))?));
            }
            self.completed(turn.clone(), item);
        } else if is(kind, "thinking") || is(kind, "redacted_thinking") {
            let streamed = self.take_streamed(message, "thinking");
            let thought = string(block.get("thinking")).filter(|text| !text.is_empty());
            if let Some(thought) = thought {
                let id = match streamed {
                    Some(id) => id,
                    None => self.own_id(message, "r")?,
                };
                let mut item = Object::of([
                    ("type", Value::text("reasoning")),
                    ("id", Value::String(id)),
                    ("summary", Value::Array(vec![Value::String(thought.clone())])),
                    ("content", Value::Array(Vec::new())),
                ]);
                if self.source_ids {
                    item.set(
                        "sourceId",
                        Value::String(id_for_source(message.unwrap_or(&Value::Null), Some(&Value::Number(index as f64)))?),
                    );
                }
                self.completed(turn.clone(), item);
            }
        } else if is_tool {
            return self.tool_use(m, block, turn);
        }
        Ok(())
    }

    fn tool_use(&mut self, m: &Value, block: &Object, turn: &TurnId) -> Result<(), Thrown> {
        let name = block.get("name");
        if is_todo_tool(name) {
            if let Some(plan) = self.todos.apply(block)? {
                self.out.push(Said::Plain(Emit::Plan { turn: turn.clone(), plan }));
            }
            return Ok(());
        }
        let key = map_key(block.get("id"));
        if is(name, "ReportFindings") {
            // a review's typed findings, or their outcomes after a fix: a review card once the call succeeds (a call the CLI
            // rejects is retried, and shows nothing)
            self.finding_calls.insert(key, (turn.clone(), block.get("input").cloned()));
            return Ok(());
        }
        let when = ms_time(m, self.now);
        let Some(item) = tool_item(block, &self.cwd, &self.thread, when)? else { return Ok(()) };
        if item.get("agent").is_some() {
            self.children.insert(key.clone(), self.new_child(block.get("id").cloned()));
        }
        if is(name, "Bash") && at(block.get("input"), "run_in_background") == Some(&Value::Bool(true)) {
            self.launched.insert(key.clone(), "shell");
        }
        self.tools.set(key.clone(), item.clone());
        self.tool_start.insert(key, when);
        self.started(turn.clone(), item);
        Ok(())
    }

    /// Goal messages from Claude Code ("Goal set", each unmet check, /goal's own output) show as a one-line note in the turn,
    /// not as a reply or a user bubble. Whether this was one.
    pub(crate) fn goal_note(&mut self, m: &Value) -> Result<bool, Thrown> {
        let Some(text) = goal_note(m)? else { return Ok(false) };
        let id = match given(m.field("uuid")) {
            Some(id) => id.clone(),
            None => Value::String(cat!("goal-", self.fresh_id())),
        };
        self.note(Note { kind: "goal", text: Value::String(text), task: None, wake: None }, id)?;
        Ok(true)
    }

    /// `m.uuid ?? note-<fresh>`.
    fn note_id(&mut self, m: &Value) -> Value {
        match given(m.field("uuid")) {
            Some(id) => id.clone(),
            None => Value::String(cat!("note-", self.fresh_id())),
        }
    }

    pub(crate) fn on_user(&mut self, m: &Value) -> Result<(), Thrown> {
        if self.goal_note(m)? {
            return Ok(());
        }
        let when = ms_time(m, self.now);
        match status_note(m) {
            Some(Status::Handback { agent, report }) => return self.on_handback(&agent, report),
            Some(Status::Task { text, notification }) => {
                if let Some(note) = self.task_note(text, &notification, when)? {
                    let id = self.note_id(m);
                    self.note(note, id)?;
                }
                return Ok(());
            }
            Some(Status::Line { kind, text, wake }) => {
                let id = self.note_id(m);
                return self.note(Note::line(kind, text, wake), id);
            }
            None => {}
        }
        let turn = self.turn_id.clone();
        let content = at(m.field("message"), "content");
        if !matches!(content, Some(Value::Array(_))) {
            return Ok(());
        }
        for block in content_blocks(content) {
            if is(block.get("type"), "tool_result") {
                self.last_kind = Some("tool_result");
                if turn.as_ref().is_some_and(truthy) {
                    self.tool_result(m, &block, &turn, when)?;
                }
            }
        }
        Ok(())
    }

    fn tool_result(&mut self, m: &Value, block: &Object, turn: &TurnId, when: f64) -> Result<(), Thrown> {
        let structured = m.field("tool_use_result");
        if let Some(plan) = self.todos.result(block, structured)? {
            self.out.push(Said::Plain(Emit::Plan { turn: turn.clone(), plan }));
        }
        let key = map_key(block.get("tool_use_id"));
        if let Some((call_turn, input)) = self.finding_calls.remove(&key) {
            if !block.get("is_error").is_some_and(truthy) {
                let item = review_card(block.get("tool_use_id"), input.as_ref())?;
                self.completed(call_turn, item);
            }
            return Ok(());
        }
        let Some(item) = self.tools.get(&key).cloned() else { return Ok(()) };
        self.tools.delete(&key);
        let raw = complete_tool(&item, block, structured, self.tool_start.get(&key).copied(), when)?;
        let done = if !is(raw.get("status"), "declined") {
            raw
        } else if self.interrupted {
            cut_off(raw)
        } else {
            self.declined.push((turn.clone(), raw.clone()));
            raw
        };
        self.tool_start.remove(&key);
        // a background launch: its row follows the task until it settles (its effective status)
        if is(at(done.get("agent"), "status"), "running") {
            self.background.set(key.clone(), Background { item: done.clone(), turn: turn.clone() });
            self.launched.insert(key, "agent");
        } else if is(done.get("type"), "commandExecution") && done.get("background").is_some_and(truthy) {
            self.launched.insert(key, "shell");
        }
        self.completed(turn.clone(), done);
        Ok(())
    }

    /// The replay reached "[Request interrupted by user for tool use]": the declined tools before it were cut off.
    pub(crate) fn replay_stop(&mut self) {
        for (turn, item) in std::mem::take(&mut self.declined) {
            self.completed(turn, cut_off(item));
        }
    }
}

/// The same native message block in live streaming and transcript replay, independent of translator counters.
fn id_for_source(message: &Value, index: Option<&Value>) -> Result<Text, Thrown> {
    Ok(cat!(text_of(Some(message))?, ":", text_of(index)?))
}
