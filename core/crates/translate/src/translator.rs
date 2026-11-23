//! Per-session translation of ACP updates into a thread's turns and items (`stream` is its streamed messages). One turn is one session/prompt through to its
//! stop reason; updates that arrive with no prompt running (an unattended burst) get a turn of their own. What it says
//! collects in `out` until its caller takes it, so a failure partway keeps what came before it, as the JS's emits had gone
//! out by the time it threw.

use crate::agents::{agent_item, is_agent_call, parent_of, Agent};
use crate::blocks::block_text;
use crate::compaction::is_compact_command;
use crate::emit::{Emit, Item, TurnId};
use crate::ordered::Ordered;
use crate::reads::{at, first, is, string, text_of, text_or_empty};
use crate::stop::{acp_stop, Note, Stop};
use crate::stream::{message_item, thought_item, Kind, Stream};
use crate::tools::tool_item;
use crate::Thrown;
use jsvalue::js::{given, join, strict_equals, truthy};
use jsvalue::value::{Object, Text, Value};
use std::collections::hash_map::{Entry, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

/// The user's text in a prompt.
fn prompt_text(user: Option<&Value>) -> Result<Text, Thrown> {
    let Some(Value::Array(blocks)) = at(user, "content") else { return Ok(Text::default()) };
    let texts = blocks.iter().filter(|block| is(block.field("type"), "text"));
    join(&texts.map(|block| block.field("text").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(), "")
}

/// What `...value` puts in an object literal: an object's entries, or an array's or a string's by index.
fn spread(value: Option<&Value>) -> Vec<(Text, Value)> {
    match value {
        Some(Value::Object(object)) => object.entries().to_vec(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(at, item)| (at.to_string().as_str().into(), item.clone())).collect(),
        Some(Value::String(text)) => {
            text.units().enumerate().map(|(at, unit)| (at.to_string().as_str().into(), Value::String(unit.into()))).collect()
        }
        _ => Vec::new(),
    }
}

/// Plan entries as the turn plan the thread shows. What the JS threw on, this refuses: a plan that is no list and a null
/// entry.
fn plan_steps(entries: Option<&Value>) -> Result<Value, Thrown> {
    let entries = match given(entries) {
        None => &[][..],
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("an ACP plan's entries are no list".into()),
    };
    let step = |entry: &Value| {
        if *entry == Value::Null {
            return Err("an ACP plan's entry is null".to_string());
        }
        let status = match entry.field("status") {
            status if is(status, "in_progress") => "inProgress",
            status if is(status, "completed") => "completed",
            _ => "pending",
        };
        let text = Value::String(text_or_empty(entry.field("content"))?);
        Ok(Value::Object(Object::of([("step", text), ("status", Value::text(status))])))
    };
    entries.iter().map(step).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

/// An update's fields onto a call's. `__proto__` is left out: in JS an assignment of it changed the object's prototype, not
/// its fields.
fn merge(tc: &mut Object, update: &Object) {
    let wanted = |(key, value): &&(Text, Value)| !key.is("sessionUpdate") && !key.is("__proto__") && *value != Value::Null;
    tc.assign(update.entries().iter().filter(wanted).map(|(key, value)| (key, value)).collect());
}

/// A tool call's item: a sub-agent launch (remembered, with the turn it is in) as a collab item, else its tool card.
fn item_of(agents: &mut HashMap<Text, Agent>, thread: &Value, cwd: &Value, tc: &Object, turn: &TurnId) -> Result<Item, Thrown> {
    let agent = match agents.entry(text_of(tc.get("toolCallId"))?) {
        Entry::Occupied(agent) => agent.into_mut(),
        Entry::Vacant(free) if is_agent_call(tc) => free.insert(Agent::new(turn.clone(), tc.clone())),
        Entry::Vacant(_) => return tool_item(tc, cwd).map(Item::Plain),
    };
    agent.tc = tc.clone();
    agent_item(tc, thread, agent)
}

/// An update a sub-agent made (its own tool call or message), kept as that agent's transcript: the agent's item, for the turn
/// that launched it to replace, if there is anything new to show.
fn nested(
    agent: &mut Agent,
    nested_of: &mut HashMap<Text, Text>,
    thread: &Value,
    cwd: &Value,
    update: &Object,
) -> Result<Option<Item>, Thrown> {
    let kind = update.get("sessionUpdate");
    if is(kind, "tool_call") || is(kind, "tool_call_update") {
        let id = text_of(update.get("toolCallId"))?;
        nested_of.insert(id.clone(), text_of(agent.tc.get("toolCallId"))?);
        let mut tc = agent.calls.get(&id).cloned().unwrap_or_else(|| Object::of([("toolCallId", Value::String(id.clone()))]));
        merge(&mut tc, update);
        agent.calls.insert(id.clone(), tc.clone());
        let item = tool_item(&tc, cwd)?;
        if is(item.get("status"), "inProgress") {
            agent.running.set(id.clone(), tc);
        } else {
            agent.running.delete(&id);
        }
        match agent.items.iter_mut().find(|held| string(held.get("id")) == Some(&id)) {
            Some(held) => *held = Arc::new(item),
            None => agent.items.push(Arc::new(item)),
        }
    } else {
        let delta = block_text(update.get("content"))?;
        if delta.is_empty() {
            return Ok(None);
        }
        let message = is(kind, "agent_message_chunk");
        let kind = if message { "agentMessage" } else { "reasoning" };
        match agent.items.last_mut().filter(|last| is(last.get("type"), kind)) {
            Some(last) => extended(Arc::make_mut(last), message, &delta),
            None => {
                let mut id = text_of(agent.tc.get("toolCallId"))?;
                id.push_str(&format!(":{}{}", if message { 'm' } else { 'r' }, agent.count));
                agent.count += 1;
                agent.items.push(Arc::new(if message { message_item(id, delta) } else { thought_item(id, delta) }));
            }
        }
    }
    agent_item(&agent.tc, thread, agent).map(Some)
}

/// A JS translator's state. `turn_id` is JS's `this.turnId`: null until a turn begins, and undefined (`None`) for a
/// transcript's turn with no id.
pub struct Translator {
    pub turn_id: TurnId,
    pub(crate) stream: Option<Stream>,
    tools: Ordered<Object>,
    /// sub-agent calls by tool call id
    agents: HashMap<Text, Agent>,
    /// a sub-agent's own call id, and that sub-agent's call id
    nested_of: HashMap<Text, Text>,
    /// stream items in this turn: ids count per turn, so a replayed turn and its live stream agree
    pub(crate) count: u64,
    /// the current turn's prompt is the user's /compact
    pub(crate) manual: bool,
    pub thread: Value,
    cwd: Value,
    /// what this translator's `auto-` turn ids start from, and how many it has made
    auto: Text,
    autos: u64,
    /// `Date.now()` as the caller read it
    pub now: f64,
    pub out: Vec<Emit>,
}

impl Translator {
    /// A translator for `{ threadId, cwd, auto }`.
    pub fn new(header: &Object) -> Self {
        let field = |key| header.get(key).cloned().unwrap_or(Value::Null);
        let auto = string(header.get("auto")).cloned().unwrap_or_default();
        let (thread, cwd) = (field("threadId"), field("cwd"));
        Translator {
            turn_id: Some(Value::Null),
            stream: None,
            tools: Ordered::default(),
            agents: HashMap::new(),
            nested_of: HashMap::new(),
            count: 0,
            manual: false,
            thread,
            cwd,
            auto,
            autos: 0,
            now: 0.0,
            out: Vec::new(),
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.turn_id.as_ref().is_some_and(truthy)
    }

    /// The id of a turn nobody named, in place of the JS's `crypto.randomUUID()`: `auto` is one per translator, from JS.
    fn next_auto(&mut self) -> Value {
        self.autos += 1;
        let mut id = Text::from("auto-");
        id.push_text(&self.auto);
        id.push_str(&format!("-{}", self.autos - 1));
        Value::String(id)
    }

    pub(crate) fn emit_item(&mut self, started: bool, turn: TurnId, item: Item) {
        self.out.push(Emit::Item { started, turn, item });
    }

    pub fn begin_turn(&mut self, id: TurnId, user: Option<&Value>) -> Result<(), Thrown> {
        if self.is_running() && !strict_equals(self.turn_id.as_ref(), id.as_ref()) {
            self.end_turn(Some(&Value::text("cancelled")), None, None)?;
        }
        if strict_equals(self.turn_id.as_ref(), id.as_ref()) {
            return Ok(());
        }
        self.turn_id = id.clone();
        self.stream = None;
        self.count = 0;
        // a prompt the language can't read still starts its turn: the JS threw here, and every item after went to a turn no
        // window had heard of
        let prompt = prompt_text(user);
        self.manual = prompt.as_ref().is_ok_and(|text| is_compact_command(text.as_bytes()));
        self.out.push(Emit::TurnStarted { id: id.clone(), at: self.now / 1e3 });
        if user.is_some_and(truthy) {
            let mut item = vec![("type".into(), Value::text("userMessage"))];
            item.extend(spread(user));
            self.emit_item(false, id, Item::Plain(Object::from_entries(item)));
        }
        prompt.map(|_| ())
    }

    /// One session/update. `turn` is main's turn for it (null outside a prompt, undefined for "whichever is running");
    /// `replaces` is the text of the open message it replaces (`chunk`).
    pub fn on_update(&mut self, update: Option<Value>, turn: TurnId, replaces: Option<&Value>) -> Result<(), Thrown> {
        let turn = turn.or_else(|| self.turn_id.clone());
        let Some(Value::Object(u)) = update else { return Ok(()) };
        let kind = u.get("sessionUpdate");
        let (message, thought, plan) = (is(kind, "agent_message_chunk"), is(kind, "agent_thought_chunk"), is(kind, "plan"));
        let (call, call_update) = (is(kind, "tool_call"), is(kind, "tool_call_update"));
        // state updates (modes, commands, config, usage) belong to the session, not a turn
        if !message && !thought && !plan && !call && !call_update {
            return Ok(());
        }
        if !plan {
            let own = parent_of(Some(&u))?;
            let parent = own
                .map_or_else(|| Ok(self.nested_of.get(&text_of(u.get("toolCallId"))?).cloned()), |parent| Ok::<_, Thrown>(Some(parent)))?;
            let agent = parent.filter(|parent| !parent.is_empty()).and_then(|parent| self.agents.get_mut(&parent));
            if let Some(agent) = agent {
                let item = nested(agent, &mut self.nested_of, &self.thread, &self.cwd, &u)?;
                let Some(item) = item else { return Ok(()) };
                let turn = agent.turn.clone();
                self.emit_item(false, turn, item);
                return Ok(());
            }
        }
        if !self.is_running() {
            let id = turn.filter(|id| *id != Value::Null).unwrap_or_else(|| self.next_auto());
            self.begin_turn(Some(id), None)?;
        }
        let tid = self.turn_id.clone();
        if message {
            return self.chunk(Kind::Message, u.get("content"), string(u.get("messageId")).cloned(), replaces);
        }
        if thought {
            return self.chunk(Kind::Thought, u.get("content"), None, replaces);
        }
        if plan {
            self.out.push(Emit::Plan { turn: tid, plan: plan_steps(u.get("entries"))? });
            return Ok(());
        }
        self.close_stream();
        if call {
            self.tool_call(u, tid)
        } else {
            self.tool_call_update(&u, tid)
        }
    }

    fn tool_call(&mut self, tc: Object, turn: TurnId) -> Result<(), Thrown> {
        let id = text_of(tc.get("toolCallId"))?;
        self.tools.set(id.clone(), tc.clone());
        let item = item_of(&mut self.agents, &self.thread, &self.cwd, &tc, &turn)?;
        let running = item.in_progress();
        self.emit_item(running, turn, item);
        if !running {
            self.tools.delete(&id);
        }
        Ok(())
    }

    fn tool_call_update(&mut self, update: &Object, turn: TurnId) -> Result<(), Thrown> {
        let id = text_of(update.get("toolCallId"))?;
        let known = self.tools.get(&id);
        let seen = known.is_some();
        let mut tc = known.cloned().unwrap_or_else(|| Object::of([("toolCallId", Value::String(id.clone()))]));
        merge(&mut tc, update);
        let item = item_of(&mut self.agents, &self.thread, &self.cwd, &tc, &turn)?;
        if item.in_progress() {
            self.tools.set(id, tc);
            // a later update can change the card (a diff arrives): the item is replaced in place
            self.emit_item(!seen, turn, item);
        } else {
            self.tools.delete(&id);
            self.emit_item(false, turn, item);
        }
        Ok(())
    }

    /// A tool call still running when its turn ended, finished as the stop says. A sub-agent's own calls still running end
    /// with it.
    fn finish_tool(&mut self, mut tc: Object, turn: &TurnId, status: &'static str) -> Result<(), Thrown> {
        let id = text_of(tc.get("toolCallId"))?;
        if let Some(agent) = self.agents.get_mut(&id) {
            agent.running.clear();
        }
        let interrupted = status == "interrupted";
        tc.set("status", Value::text(if status == "completed" { "completed" } else { "failed" }));
        tc.set("cancelled", Value::Bool(interrupted));
        let mut item = item_of(&mut self.agents, &self.thread, &self.cwd, &tc, turn)?;
        // Stop cut it off: the chat reads "Interrupted" on it rather than a failure (a sub-agent already reads "stopped")
        if interrupted && !self.agents.contains_key(&id) {
            item.mark_cut_off();
        }
        self.emit_item(false, turn.clone(), item);
        Ok(())
    }

    /// End the running turn, if there is one. It ends whatever it holds: a call the language can't read is the one thing
    /// left out, where the JS threw and left the chat's turn running for good, and every later turn's end throwing again.
    pub fn end_turn(&mut self, stop: Option<&Value>, error: Option<&Value>, provider: Option<&Value>) -> Result<(), Thrown> {
        if !self.is_running() {
            return Ok(());
        }
        let turn = self.turn_id.clone();
        self.close_stream();
        // clear first: what follows can't take the running turn with it
        self.turn_id = Some(Value::Null);
        let mut thrown = None;
        let stopped = acp_stop(stop, error, provider).unwrap_or_else(|failure| {
            thrown = Some(failure);
            Stop { status: "failed", error: Value::Null, note: None }
        });
        let tools: Vec<Object> = self.tools.values().cloned().collect();
        for tc in tools {
            if let Err(failure) = self.finish_tool(tc, &turn, stopped.status) {
                thrown.get_or_insert(failure);
            }
        }
        self.tools.clear();
        // a reply cut off or a usage limit says so in the chat (its id is the turn's, so a replay shows the same note)
        if let Some(note) = stopped.note {
            match text_of(turn.as_ref()) {
                Ok(id) => self.emit_note(note, &id, &turn),
                Err(failure) => {
                    thrown.get_or_insert(failure);
                }
            }
        }
        let error = if truthy(&stopped.error) { Value::Object(Object::of([("message", stopped.error)])) } else { Value::Null };
        self.out.push(Emit::TurnCompleted { id: turn, status: stopped.status, error, at: self.now / 1e3 });
        thrown.map_or(Ok(()), Err)
    }

    fn emit_note(&mut self, note: Note, turn_text: &Text, turn: &TurnId) {
        let mut id = Text::from(note.kind);
        id.push_str("-");
        id.push_text(turn_text);
        let item = Object::of([
            ("type", Value::text("statusNote")),
            ("id", Value::String(id)),
            ("kind", Value::text(note.kind)),
            ("text", note.text),
        ]);
        self.emit_item(false, turn.clone(), Item::Plain(item));
    }

    /// One transcript record (history replay).
    pub fn replay(&mut self, record: Value) -> Result<(), Thrown> {
        if record == Value::Null {
            return Err("an ACP transcript's record is null".into());
        }
        let Value::Object(mut record) = record else { return Ok(()) };
        let kind = record.get("t");
        let turn = record.get("turnId");
        if is(kind, "user") {
            return self.begin_turn(turn.cloned(), record.get("user"));
        }
        if is(kind, "update") {
            let turn = turn.cloned();
            return self.on_update(record.remove("update"), turn, None);
        }
        if is(kind, "end") {
            if strict_equals(self.turn_id.as_ref(), turn) {
                return self.end_turn(record.get("stopReason"), record.get("error"), record.get("providerError"));
            }
        } else if is(kind, "diff") {
            // what a turn changed in its folder, as a transcript may say it
            if let Some(diff) = string(record.get("diff")) {
                self.out.push(Emit::Diff { turn: turn.cloned(), diff: diff.clone() });
            }
        } else if is(kind, "card") {
            // a card a machine's Host closed, as the app wrote its outcome from the Host's journal item: a note in the turn the card belonged to
            if let (Some(line), Some(request)) =
                (string(record.get("line")).filter(|line| !line.as_bytes().is_empty()), string(record.get("requestId")))
            {
                let mut id = Text::from("card-");
                id.push_text(request);
                let item = Object::of([
                    ("type", Value::text("statusNote")),
                    ("id", Value::String(id)),
                    ("kind", Value::text("card")),
                    ("text", Value::String(line.clone())),
                ]);
                self.emit_item(false, turn.cloned(), Item::Plain(item));
            }
        }
        Ok(())
    }

    /// `step` at the time `now`: what it said, and why it stopped short. A panic is such a stop: nothing here is unsafe, so
    /// what it leaves is what a thrown error left in the JS, and the session goes on with its translator, where a panic
    /// reaching the handle would close it and lose the turn.
    pub fn run(&mut self, now: f64, step: impl FnOnce(&mut Translator) -> Result<(), Thrown>) -> Option<Thrown> {
        self.now = now;
        match catch_unwind(AssertUnwindSafe(|| step(self))) {
            Ok(result) => result.err(),
            Err(_) => Some("the translator panicked".into()),
        }
    }
}

/// `item` with `delta` on the end of its text, or of its summary.
fn extended(item: &mut Object, message: bool, delta: &Text) {
    let key = if message { "text" } else { "summary" };
    let held = item.get(key);
    let mut text = string(if message { held } else { first(held) }).cloned().unwrap_or_default();
    text.push_text(delta);
    let text = Value::String(text);
    item.set(key, if message { text } else { Value::Array(vec![text]) });
}
