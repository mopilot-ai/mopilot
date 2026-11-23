//! A Claude Code transcript read back into a chat's turns: a translator
//! fed a message at a time, and the turns it says.

use crate::claude::common::{cat, parse_time};
use crate::claude::fold::{apply, apply_to};
use crate::claude::patterns as re;
use crate::claude::signals::{compaction, is_prompt, plain_text};
use crate::claude::tasks::Note;
use crate::claude::translator::{Compacted, Translator};
use crate::claude::user_messages::{app_model_switch, status_note, user_content, Status};
use crate::reads::{at, is, string, text_of};
use crate::turns::{Turn, Turns};
use crate::Thrown;
use jsvalue::js::{given, strict_equals, truthy};
use jsvalue::value::{Object, Text, Value};

/// `/^\s*\/compact(?:\s|$)/`, of a turn's user input.
fn is_compact_command(content: &[Value]) -> bool {
    let mut text = Text::default();
    for block in content {
        if let Some(part) = string(block.field("text")).filter(|_| is(block.field("type"), "text")) {
            text.push_text(part);
        }
    }
    crate::compaction::is_compact_command(text.as_bytes())
}

impl Translator {
    fn turn_of_replay(&self, m: &Value, index: usize) -> Result<Text, Thrown> {
        Ok(cat!("h-", self.uuid_or_index(m, index)?))
    }

    fn uuid_or_index(&self, m: &Value, index: usize) -> Result<Text, Thrown> {
        match given(m.field("uuid")) {
            Some(uuid) => text_of(Some(uuid)),
            None => Ok(index.to_string().as_str().into()),
        }
    }

    fn user_item(user: &Object) -> Object {
        let mut item = vec![("type".into(), Value::text("userMessage"))];
        item.extend(user.entries().iter().cloned());
        Object::from_entries(item)
    }

    /// A summary read back joins the turn it came in, or heads one of its own when none is open. Whose it was is told by what
    /// follows: the /compact Claude Code writes after the summary.
    fn replay_compaction(&mut self, m: &Value, index: usize) -> Result<(), Thrown> {
        let summary = plain_text(at(m.field("message"), "content"));
        let id = given(m.field("uuid")).cloned().unwrap_or_else(|| Value::String(cat!("compact-", index.to_string().as_str())));
        let item = compaction(Some(&id), None, Some(&summary));
        let joined = self.is_running();
        if !joined {
            let turn = self.turn_of_replay(m, index)?;
            self.begin_turn(Some(Value::String(turn)), None);
        }
        self.compacted = Some(Compacted { item: item.clone(), turn: self.turn_id.clone(), joined });
        self.completed(self.turn_id.clone(), item);
        Ok(())
    }

    /// The user's /compact, read back while its compaction's turn is the open one: it heads that compaction's turn. True when
    /// `user` was that command and took its place there.
    fn replay_compact_command(&mut self, user: &Object) -> bool {
        let content = user.get("content").and_then(Value::as_array).unwrap_or_default();
        let turn = self.turn_id.clone();
        let opened = self.compacted.take_if(|held| strict_equals(held.turn.as_ref(), turn.as_ref()) && is_compact_command(content));
        let Some(Compacted { mut item, turn, joined }) = opened else { return false };
        item.set("trigger", Value::text("manual"));
        if joined {
            // the turns it folded away are in the chat: the divider stays where the summary came, now known to be the user's,
            // and the command is a turn's prompt as any
            self.completed(turn, item);
            return false;
        }
        self.completed(turn.clone(), Self::user_item(user));
        self.completed(turn, item);
        // the next prompt is a turn of its own, whatever the kept messages ended on
        self.last_kind = Some("text");
        true
    }

    /// What Claude does next is a turn of its own, once the turn before it has ended: `id` names it.
    fn next_turn_is(&mut self, id: Text) {
        if self.is_running() {
            self.end_turn("completed", Value::Null);
            self.last_kind = Some("user");
        }
        self.next_auto = Some(id);
    }

    /// One user line. Each real prompt starts a turn; a compaction's summary (#1501) is never one. Claude Code delivers messages
    /// sent while it works right after a tool result: they belong to the running turn, as they do in Claude's own UI.
    fn replay_user(&mut self, m: &Value, index: usize) -> Result<(), Thrown> {
        if m.field("isCompactSummary") == Some(&Value::Bool(true)) {
            return self.replay_compaction(m, index);
        }
        // a goal's checks run inside the turn that set it
        if self.is_running() && self.goal_note(m)? {
            return Ok(());
        }
        let mid_turn = self.is_running() && matches!(self.last_kind, Some("tool" | "tool_result"));
        let heading = |translator: &Translator| translator.turn_of_replay(m, index);
        let note_id = |translator: &Translator| Ok::<_, Thrown>(Value::String(cat!("note-", translator.uuid_or_index(m, index)?)));
        match status_note(m) {
            Some(Status::Handback { agent, report }) => {
                self.on_handback(&agent, report)?;
                // what Claude does in response is a turn of its own, headed by nothing (the report is on the agent's row)
                if !mid_turn {
                    let id = heading(self)?;
                    self.next_turn_is(id);
                }
                return Ok(());
            }
            // a background-task notification is a task event, never a user bubble. One that arrives after a reply still ends that
            // turn: the work Claude does in response gets a turn of its own, headed by the event
            Some(Status::Task { text, notification }) => {
                let when = self.time_of(m);
                let note = self.task_note(text, &notification, when)?;
                let id = note_id(self)?;
                if mid_turn {
                    return note.map_or(Ok(()), |note| self.note(note, id));
                }
                let next = heading(self)?;
                self.next_turn_is(next);
                self.pending_notes.extend(note.map(|note| (note, id)));
                return Ok(());
            }
            Some(Status::Line { kind, text, wake }) => {
                let note = Note::line(kind, text, wake);
                let id = note_id(self)?;
                if mid_turn {
                    return self.note(note, id);
                }
                // Claude responded to it in a turn of its own: start one, headed by the note instead of a bubble
                if self.is_running() {
                    self.end_turn("completed", Value::Null);
                }
                let turn = heading(self)?;
                self.begin_turn(Some(Value::String(turn)), None);
                self.last_kind = Some("user");
                return self.note(note, id);
            }
            None => {}
        }
        let content = at(m.field("message"), "content");
        if !is_prompt(content) {
            return self.on_user(m);
        }
        let raw = plain_text(content);
        if re::after_opening(raw.as_bytes(), b"[Request interrupted by user").is_some() {
            if re::find(raw.as_bytes(), b"for tool use", 0).is_some() {
                self.replay_stop();
            }
            // the user stopped the turn; the next prompt starts fresh
            if self.is_running() {
                self.end_turn("interrupted", Value::Null);
            }
            self.last_kind = Some("text");
            return Ok(());
        }
        let input = if app_model_switch(m) { Vec::new() } else { user_content(content)? };
        if input.is_empty() {
            return Ok(());
        }
        let mut user = Object::default();
        user.push("id", given(m.field("uuid")).cloned().unwrap_or_else(|| Value::String(cat!("u-", index.to_string().as_str()))));
        user.push("clientId", Value::Null);
        user.push("content", Value::Array(input));
        if self.replay_compact_command(&user) {
            return Ok(());
        }
        if mid_turn {
            self.completed(self.turn_id.clone(), Self::user_item(&user));
            return Ok(());
        }
        if self.is_running() {
            self.end_turn("completed", Value::Null);
        }
        let turn = heading(self)?;
        self.begin_turn(Some(Value::String(turn)), Some(&user));
        self.last_kind = Some("user");
        Ok(())
    }

    /// One line of a transcript.
    fn replay(&mut self, m: &Value, index: usize, fork_leaf: bool) -> Result<(), Thrown> {
        if m.field("parent_tool_use_id").is_some_and(truthy) {
            return self.on_message(Some(m));
        }
        // a turn Claude starts on its own with nothing heading it is named after its first message, so every read of the
        // transcript gives it the same id (older pages are found by turn id)
        if is(m.field("type"), "assistant") && !self.is_running() && self.next_auto.is_none() {
            if let Some(uuid) = m.field("uuid").filter(|uuid| truthy(uuid)) {
                self.next_auto = Some(cat!("auto-", text_of(Some(uuid))?));
            }
        }
        let read = if is(m.field("type"), "user") { self.replay_user(m, index) } else { self.on_message(Some(m)) };
        // a tool result that ended its turn (Claude Code's end-turn flag: a wrap-up box) is the turn's last word, as a reply is:
        // the next prompt starts a turn of its own. So is a fork's last copied message
        let flag = at(at(m.field("mcpMeta"), "_meta"), "claude/endTurn");
        if fork_leaf || (is(m.field("type"), "user") && flag == Some(&Value::Bool(true))) {
            self.last_kind = Some("text");
        }
        read
    }
}

/// A transcript as far as it has been read: the translator, for what comes next, and the turns so far.
pub struct Reading {
    pub(crate) translator: Translator,
    pub(crate) turns: Turns,
    fork_leaf: Option<usize>,
    index: usize,
    last_at: f64,
}

/// A read done: what `history` keeps of it.
pub struct Finished {
    pub turns: Turns,
    /// the transcript's last turn as it reads if no one is still writing it, where that differs
    pub closed: Option<(usize, Turn)>,
    /// whether the transcript's last word was a reply
    pub ended_on_text: bool,
    pub last_at: f64,
}

impl Reading {
    /// A reading of `{ threadId, cwd, auto, now }`, in which `fork_leaf` is the line of a fork's last copied message: its copy carries
    /// the time of the fork, not its own (#1941).
    pub fn new(header: &Object, now: f64, fork_leaf: Option<usize>) -> Self {
        let mut translator = Translator::new(header);
        translator.now = now;
        // a sub-agent's page has its own read (`translate.claudeAgentItems`), so its list would only be cloned to be dropped
        translator.says_children = false;
        Reading { translator, turns: Turns::default(), fork_leaf, index: 0, last_at: 0.0 }
    }

    fn drain(&mut self) -> Result<(), Thrown> {
        let mut failed = Ok(());
        for said in std::mem::take(&mut self.translator.out) {
            let folded = apply(&mut self.turns, said);
            failed = failed.and(folded);
        }
        failed
    }

    /// A line that can't be read: the ones after it keep their places, which a turn's id may name.
    pub fn skip(&mut self) {
        self.index += 1;
    }

    /// A transcript's next line. A line about the session (a title, a summary) is not part of a turn and never stretches it.
    pub fn take(&mut self, message: &Value) -> Result<(), Thrown> {
        let index = self.index;
        self.index += 1;
        let now = self.translator.now;
        let fork_leaf = self.fork_leaf == Some(index);
        let thrown = self.translator.run(now, |translator| translator.replay(message, index, fork_leaf));
        let folded = self.drain();
        let time = parse_time(message.field("timestamp"));
        self.last_at = if time.is_nan() || time == 0.0 { 0.0 } else { time };
        if message.field("parent_tool_use_id").is_some_and(truthy) {
            return thrown.map_or(folded, Err);
        }
        // transcripts carry per-message timestamps: the turn spans its first to last message
        let timed = ["user", "assistant", "system"].iter().any(|kind| is(message.field("type"), kind));
        if timed && !fork_leaf && !time.is_nan() {
            if let Some(turn) = self.turns.turns.last_mut() {
                turn.stamp_at(time / 1000.0);
            }
        }
        thrown.map_or(folded, Err)
    }

    /// The end of the transcript: a task event Claude hasn't answered yet still shows, in the turn its answer will have, and a
    /// turn left open has what it reads as if no one is writing it put beside it. What was left of the translator goes.
    pub fn finish(mut self) -> Result<Finished, Thrown> {
        let mut failed = Ok(());
        if !self.translator.pending_notes.is_empty() {
            let now = self.translator.now;
            let thrown = self.translator.run(now, Translator::ensure_turn);
            failed = thrown.map_or(self.drain(), Err);
        }
        let ended_on_text = self.translator.last_kind == Some("text");
        let mut closed = None;
        if self.translator.is_running() {
            let place = self.turns.place(&self.translator.turn_id);
            let now = self.translator.now;
            self.translator.run(now, |translator| {
                translator.end_turn("completed", Value::Null);
                Ok(())
            });
            let said = std::mem::take(&mut self.translator.out);
            closed = place.map(|place| {
                let mut turn = self.turns.turns[place].clone();
                said.into_iter().for_each(|said| apply_to(&mut turn, said));
                (place, turn)
            });
        }
        failed.map(|()| Finished { turns: self.turns, closed, ended_on_text, last_at: self.last_at })
    }
}
