//! Per-thread translation of Claude Code's messages. One turn is one
//! user prompt through to its `result`. Item ids: tool items use the tool_use id; text and thinking use `<message id>:<block
//! index>`. What it says collects in `out` until its caller takes it, so a failure partway keeps what came before it, as the
//! JS's emits had gone out by the time it threw. `messages` holds what it reads of a stream, a reply and a tool's result,
//! `tasks` what it does for background work and sub-agents, and `replay` what it does for a transcript.

use crate::claude::agent_transcript::AgentTranscript;
use crate::claude::common::cat;
use crate::claude::failures::{Failures, Taken};
use crate::claude::signals::{api_retry, compaction, hook_item, result_failed, review_command, token_usage};
use crate::claude::tasks::Note;
use crate::claude::todos::Todos;
use crate::claude::{patterns as re, Said};
use crate::emit::{Emit, Item, TurnId};
use crate::ordered::Ordered;
use crate::reads::{at, is, string, text_of};
use crate::Thrown;
use jsvalue::js::{given, strict_equals, truthy};
use jsvalue::value::{Object, Text, Value};
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// A background agent whose call returned: its row updates until its task settles.
pub struct Background {
    pub item: Object,
    pub turn: TurnId,
}

/// A compaction's summary read back, waiting for the /compact that says it was the user's.
pub struct Compacted {
    pub item: Object,
    pub turn: TurnId,
    pub joined: bool,
}

/// A tool Stop cut off: the CLI answers it as declined, the same words a refusal gets. After MoPilot's interrupt (live), or
/// before the transcript's "[Request interrupted by user for tool use]" (replay), the chat reads "Interrupted" on it.
pub(crate) fn cut_off(mut item: Object) -> Object {
    item.set("status", Value::text("failed"));
    item.set("cutOff", Value::Bool(true));
    item
}

pub struct Translator {
    pub turn_id: TurnId,
    pub interrupted: bool,
    /// the turn's tools answered as declined
    pub(crate) declined: Vec<(TurnId, Object)>,
    pub(crate) failures: Failures,
    /// prompts sent in this turn still waiting for their `result` (a steer adds one: the CLI runs it as its own segment)
    outstanding: i64,
    pub(crate) msg_id: Value,
    pub(crate) stream: HashMap<Text, Vec<(Text, &'static str)>>,
    pub(crate) tools: Ordered<Object>,
    pub(crate) tool_start: HashMap<Text, f64>,
    pub(crate) text_count: u64,
    /// Native block identities requested by phone live/history reconciliation.
    pub(crate) source_ids: bool,
    usage: Option<Object>,
    /// notes that arrived between turns, shown at the top of the turn Claude starts for them
    pub(crate) pending_notes: Vec<(Note, Value)>,
    /// each Agent call's own transcript, by tool_use id (nested agents' too)
    pub(crate) children: HashMap<Text, AgentTranscript>,
    /// whether a sub-agent's transcript is said: nobody shows it from a read, or from a phone's feed
    pub(crate) says_children: bool,
    /// background agents whose call returned
    pub(crate) background: Ordered<Background>,
    /// tool_use ids of background launches, with the kind of task each started
    pub(crate) launched: HashMap<Text, &'static str>,
    /// task events already shown (`<task id>:<status>`): the CLI may report one twice
    pub(crate) noted: HashSet<Text>,
    /// task id -> the turn holding its running card, which the settle note updates in place
    pub(crate) running_cards: HashMap<Text, TurnId>,
    /// id for the next turn Claude starts on its own, so a re-read transcript keeps the same ids
    pub(crate) next_auto: Option<Text>,
    /// what the transcript ended on so far; a prompt right after tool activity was sent mid-turn
    pub(crate) last_kind: Option<&'static str>,
    pub thread: Value,
    pub cwd: Value,
    /// the review command this turn runs, whose findings get the review card
    pub(crate) review: Option<Text>,
    /// ReportFindings calls waiting for their result: the turn they belong to and their input
    pub(crate) finding_calls: HashMap<Text, (TurnId, Option<Value>)>,
    pub(crate) todos: Todos,
    pub(crate) compacted: Option<Compacted>,
    /// the turn the CLI last said it ran for (shared/claudeTurnOver.mjs); undefined until it says
    cli_ran_for: TurnId,
    /// what this translator's generated ids start from, and how many it has made
    seed: Text,
    made: u64,
    /// `Date.now()` as the caller read it
    pub now: f64,
    pub out: Vec<Said>,
}

impl Translator {
    /// A translator for `{ threadId, cwd, auto, children }`: `children: false` is one nobody shows a sub-agent's transcript from.
    pub fn new(header: &Object) -> Self {
        let field = |key| header.get(key).cloned().unwrap_or(Value::Null);
        Translator {
            turn_id: Some(Value::Null),
            interrupted: false,
            declined: Vec::new(),
            failures: Failures::default(),
            outstanding: 0,
            msg_id: Value::String(Text::default()),
            stream: HashMap::new(),
            tools: Ordered::default(),
            tool_start: HashMap::new(),
            text_count: 0,
            source_ids: header.get("sourceIds") == Some(&Value::Bool(true)),
            usage: None,
            pending_notes: Vec::new(),
            children: HashMap::new(),
            says_children: header.get("children") != Some(&Value::Bool(false)),
            background: Ordered::default(),
            launched: HashMap::new(),
            noted: HashSet::new(),
            running_cards: HashMap::new(),
            next_auto: None,
            last_kind: None,
            thread: field("threadId"),
            cwd: field("cwd"),
            review: None,
            finding_calls: HashMap::new(),
            todos: Todos::default(),
            compacted: None,
            cli_ran_for: None,
            seed: string(header.get("auto")).cloned().unwrap_or_default(),
            made: 0,
            now: 0.0,
            out: Vec::new(),
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.turn_id.as_ref().is_some_and(truthy)
    }

    /// In place of the JS's `crypto.randomUUID()`: `seed` is one per translator, from JS.
    pub(crate) fn fresh_id(&mut self) -> Text {
        self.made += 1;
        cat!(&self.seed, "-", (self.made - 1).to_string().as_str())
    }

    pub(crate) fn completed(&mut self, turn: TurnId, item: Object) {
        self.out.push(Said::Plain(Emit::Item { started: false, turn, item: Item::Plain(item) }));
    }

    pub(crate) fn started(&mut self, turn: TurnId, item: Object) {
        self.out.push(Said::Plain(Emit::Item { started: true, turn, item: Item::Plain(item) }));
    }

    pub fn begin_turn(&mut self, id: TurnId, user: Option<&Object>) {
        if self.is_running() && !strict_equals(self.turn_id.as_ref(), id.as_ref()) {
            self.end_turn("interrupted", Value::Null);
        }
        self.turn_id = id.clone();
        self.failures.begin_turn();
        self.review = review_command(user.and_then(|user| user.get("content")));
        self.interrupted = false;
        self.declined.clear();
        self.outstanding = 1;
        self.stream.clear();
        self.todos.creates.clear();
        self.out.push(Said::Plain(Emit::TurnStarted { id: id.clone(), at: self.now / 1000.0 }));
        if let Some(user) = user {
            let mut item = vec![("type".into(), Value::text("userMessage"))];
            item.extend(user.entries().iter().cloned());
            self.completed(id, Object::from_entries(item));
        }
    }

    /// Claude Code started work on its own (after a background task finished, say): open a turn for it.
    pub(crate) fn ensure_turn(&mut self) -> Result<(), Thrown> {
        if self.is_running() {
            return Ok(());
        }
        let id = match self.next_auto.take() {
            Some(id) => id,
            None => cat!("auto-", self.fresh_id()),
        };
        self.begin_turn(Some(Value::String(id)), None);
        // the CLI is already running for it: its 'idle' ends this turn too
        self.cli_ran_for = self.turn_id.clone();
        for (note, id) in std::mem::take(&mut self.pending_notes) {
            self.note(note, id)?;
        }
        Ok(())
    }

    /// A message injected into the running turn; its own `result` follows the current one.
    pub fn add_steer(&mut self) {
        if self.is_running() {
            self.outstanding += 1;
        }
    }

    /// A steer that never reached Claude: no `result` comes for it, so a turn whose own came meanwhile ends now.
    pub fn drop_steer(&mut self) {
        // after an interrupt the next result ends the turn anyway
        if !self.is_running() || self.interrupted {
            return;
        }
        self.outstanding -= 1;
        if self.outstanding <= 0 {
            self.end_turn("completed", Value::Null);
        }
    }

    /// After an interrupt the CLI drops queued prompts, so the next `result` ends the turn.
    pub fn mark_interrupted(&mut self) {
        self.interrupted = true;
        self.outstanding = self.outstanding.min(1);
    }

    pub fn end_turn(&mut self, status: &'static str, error: Value) {
        if !self.is_running() {
            return;
        }
        let turn = self.turn_id.clone();
        let failed = status == "completed" && (self.failures.limited || self.failures.auth.is_some());
        let status = if failed { "failed" } else { status };
        let error = match (failed && error == Value::Null, &self.failures.auth) {
            (true, Some(auth)) => Value::String(auth.clone()),
            _ => error,
        };
        // clear first: what follows must not find this turn running
        self.turn_id = Some(Value::Null);
        self.outstanding = 0;
        // anything still running when the turn ends was cut off (`cutOff` on a stop: the chat reads "Interrupted" on it)
        let tools: Vec<(Text, Object)> = self.tools.entries().cloned().collect();
        for (key, item) in tools {
            let done = self.finished(&key, item, status);
            self.completed(turn.clone(), done);
        }
        self.tools.clear();
        self.tool_start.clear();
        let error = if truthy(&error) { Value::Object(Object::of([("message", error)])) } else { Value::Null };
        self.out.push(Said::Plain(Emit::TurnCompleted { id: turn, status, error, at: self.now / 1000.0 }));
    }

    /// A tool still running as its turn ended, as the end leaves it.
    fn finished(&mut self, key: &Text, item: Object, status: &str) -> Object {
        let kind = item.get("type");
        let ran = is(kind, "fileChange") || is(kind, "commandExecution") || is(kind, "mcpToolCall");
        let mut done = item.clone();
        if ran {
            done.set("status", Value::text(if status == "completed" { "completed" } else { "failed" }));
            if status == "interrupted" {
                done.set("cutOff", Value::Bool(true));
            }
        }
        // an agent cut off with its turn stopped (or failed with it)
        let agent = item.get("agent").and_then(Value::as_object).filter(|agent| is(agent.get("status"), "running"));
        if let Some(agent) = agent {
            let mut agent = agent.clone();
            agent.set("status", Value::text(if status == "failed" { "failed" } else { "stopped" }));
            agent.set("completedAt", Value::Number(self.now));
            done.set("agent", Value::Object(agent));
            self.cut_child(key);
        }
        done
    }

    /// One message of the SDK's.
    pub fn on_message(&mut self, message: Option<&Value>) -> Result<(), Thrown> {
        let m = given(message).ok_or("a message is missing")?;
        // a sub-agent's own messages show inside its Agent card
        if m.field("parent_tool_use_id").is_some_and(truthy) {
            return self.on_subagent(m);
        }
        match m.field("type") {
            kind if is(kind, "stream_event") => self.on_stream(m.field("event")),
            kind if is(kind, "assistant") => self.on_assistant(m),
            kind if is(kind, "user") => self.on_user(m),
            kind if is(kind, "result") => self.on_result(m),
            kind if is(kind, "system") => self.on_system(m),
            _ => Ok(()),
        }
    }

    fn on_result(&mut self, m: &Value) -> Result<(), Thrown> {
        let usage = token_usage(m, self.usage.as_ref())?;
        self.usage = Some(usage.clone());
        self.out.push(Said::Usage(usage));
        let failed = result_failed(m)?;
        self.outstanding -= 1;
        if self.outstanding > 0 && !self.interrupted && (is(m.field("subtype"), "success") || !failed) {
            return Ok(());
        }
        let error = self.failures.result_error(m)?;
        // duration_ms covers only the last segment; the store measures the whole turn from its start
        let status = match (self.interrupted, failed) {
            (true, _) => "interrupted",
            (_, true) => "failed",
            _ => "completed",
        };
        self.end_turn(status, if self.interrupted { Value::Null } else { error });
        Ok(())
    }

    fn on_system(&mut self, m: &Value) -> Result<(), Thrown> {
        let turn = self.turn_id.clone();
        match self.failures.system(m, &turn)? {
            Taken::Passed => {}
            Taken::Quiet => return Ok(()),
            Taken::Note(item) => {
                self.last_kind = Some("text");
                self.completed(turn, item);
                return Ok(());
            }
            Taken::Retracted(item) => {
                self.completed(turn, item);
                return Ok(());
            }
        }
        let subtype = m.field("subtype");
        if is(subtype, "session_state_changed") {
            if self.turn_over(m.field("state")) {
                self.end_turn(if self.interrupted { "interrupted" } else { "completed" }, Value::Null);
            }
            return Ok(());
        }
        if is(subtype, "task_started") && self.review.is_some() && self.is_running() {
            let description = given(m.field("description")).map_or(Ok(Text::default()), |description| text_of(Some(description)))?;
            if re::is_review_command(description.as_bytes()) {
                // /code-review runs as a forked task; its findings come back as the command's output (C13)
                let id = cat!("review-", text_of(m.field("task_id"))?);
                let review = self.review.as_ref().map(|review| cat!("with ", review)).unwrap_or_default();
                let item =
                    Object::of([("type", Value::text("enteredReviewMode")), ("id", Value::String(id)), ("review", Value::String(review))]);
                self.completed(turn, item);
                return Ok(());
            }
        }
        match subtype {
            kind if is(kind, "task_progress") || is(kind, "task_started") => self.on_task_progress(m),
            kind if is(kind, "task_notification") => self.on_task_notification(m),
            kind if is(kind, "sage_bash_output") => {
                self.on_bash_output(m);
                Ok(())
            }
            kind if is(kind, "informational") => {
                self.publish_hook_notice(m);
                Ok(())
            }
            kind if is(kind, "local_command_output") => self.goal_note(m).map(|_| ()),
            kind if is(kind, "api_retry") && self.is_running() => {
                self.out.push(api_retry(m, turn)?);
                Ok(())
            }
            kind if is(kind, "compact_boundary") && self.is_running() => {
                self.completed(turn, compaction(m.field("uuid"), at(m.field("compact_metadata"), "trigger"), None));
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// `claudeTurnOver`: a session_state_changed during the running turn. An 'idle' counts only after the CLI ran for the same
    /// turn, so the previous turn's late 'idle' never ends a new one.
    fn turn_over(&mut self, state: Option<&Value>) -> bool {
        if !is(state, "idle") {
            self.cli_ran_for = self.turn_id.clone();
            return false;
        }
        given(self.turn_id.as_ref()).is_some() && strict_equals(self.cli_ran_for.as_ref(), self.turn_id.as_ref())
    }

    /// A rejected prompt may never enter the transcript: its notice still has a completed, stable home on replay.
    fn publish_hook_notice(&mut self, m: &Value) {
        let Some((id, item)) = hook_item(m) else { return };
        let standalone = !self.is_running();
        if standalone {
            self.begin_turn(Some(Value::String(cat!("notice-", id))), None);
        }
        self.completed(self.turn_id.clone(), item);
        if standalone {
            self.end_turn("completed", Value::Null);
        }
    }

    /// `step` at the time `now`: what it said, and why it stopped short. A panic is such a stop: nothing here is unsafe, so what
    /// it leaves is what a thrown error left in the JS, and the session goes on with its translator.
    pub fn run(&mut self, now: f64, step: impl FnOnce(&mut Translator) -> Result<(), Thrown>) -> Option<Thrown> {
        self.now = now;
        match catch_unwind(AssertUnwindSafe(|| step(self))) {
            Ok(result) => result.err(),
            Err(_) => Some("the translator panicked".into()),
        }
    }
}
