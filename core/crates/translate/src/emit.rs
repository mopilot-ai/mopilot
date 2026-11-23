//! What a translator says, and each thing as the Codex-shaped notification a window reads: `[method, params]`, spelled as
//! `JSON.stringify` spelled the JS's. An undefined turn id is left out, as it was there.

use jsvalue::json::{parse, write, write_object, write_text, Numbers};
use jsvalue::value::{Object, Text, Value};
use std::sync::Arc;

/// A turn's id: `None` is JS's undefined, which a transcript's record without one gives.
pub type TurnId = Option<Value>;

/// A sub-agent's item. Its transcript is shared with the agent that goes on growing it, so that a long one's every update
/// costs a list of pointers, not a copy of everything so far.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentItem {
    /// the fields before `agentItems`
    pub head: Object,
    pub items: Vec<Arc<Object>>,
    /// the `agent` field, which comes after it
    pub agent: Object,
}

/// A thread item.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Plain(Object),
    Agent(Box<AgentItem>),
}

impl Item {
    /// What it holds, but for a sub-agent's transcript.
    pub fn head(&self) -> &Object {
        match self {
            Item::Plain(item) => item,
            Item::Agent(agent) => &agent.head,
        }
    }

    /// This item as one plain object.
    pub fn make_plain(&mut self) {
        if matches!(self, Item::Agent(_)) {
            let mut json = Vec::new();
            write_item(&mut json, self);
            // what this wrote reads back: its depth is what was read in, and a few fields
            let read = std::str::from_utf8(&json).ok().and_then(parse);
            *self = Item::Plain(read.as_ref().and_then(Value::as_object).cloned().unwrap_or_default());
        }
    }

    /// This item's object, once it is plain.
    pub fn plain_mut(&mut self) -> Option<&mut Object> {
        match self {
            Item::Plain(item) => Some(item),
            Item::Agent(_) => None,
        }
    }

    /// `item.cutOff = true`: Stop ended this call, and the chat says so.
    pub fn mark_cut_off(&mut self) {
        match self {
            Item::Plain(item) => item,
            Item::Agent(agent) => &mut agent.head,
        }
        .set("cutOff", Value::Bool(true));
    }

    pub fn id(&self) -> Option<&Value> {
        self.head().get("id")
    }

    /// Whether this item's call is still running: its status says so, and a web item has none.
    pub fn in_progress(&self) -> bool {
        crate::reads::is(self.head().get("status"), "inProgress")
    }
}

/// One notification.
#[derive(Debug, PartialEq)]
pub enum Emit {
    TurnStarted {
        id: TurnId,
        at: f64,
    },
    TurnCompleted {
        id: TurnId,
        status: &'static str,
        error: Value,
        at: f64,
    },
    /// `item/started`, or `item/completed`
    Item {
        started: bool,
        turn: TurnId,
        item: Item,
    },
    MessageDelta {
        turn: TurnId,
        item: Text,
        delta: Text,
    },
    ThoughtDelta {
        turn: TurnId,
        item: Text,
        delta: Text,
    },
    Plan {
        turn: TurnId,
        plan: Value,
    },
    Diff {
        turn: TurnId,
        diff: Text,
    },
}

fn value(out: &mut Vec<u8>, value: &Value) {
    write(out, value, Numbers::Stringified);
}

fn object(out: &mut Vec<u8>, object: &Object) {
    write_object(out, object, Numbers::Stringified);
}

/// `{"threadId":…`, and the turn's id when it has one.
fn open(out: &mut Vec<u8>, method: &str, thread: &Value, turn: &TurnId) {
    out.extend_from_slice(br#"[""#);
    out.extend_from_slice(method.as_bytes());
    out.extend_from_slice(br#"",{"threadId":"#);
    value(out, thread);
    if let Some(turn) = turn {
        out.extend_from_slice(br#","turnId":"#);
        value(out, turn);
    }
}

/// `{"threadId":…,"turn":{"id":…,`, with no id when there is none.
fn open_turn(out: &mut Vec<u8>, method: &str, thread: &Value, id: &TurnId) {
    open(out, method, thread, &None);
    out.extend_from_slice(br#","turn":{"#);
    if let Some(id) = id {
        out.extend_from_slice(br#""id":"#);
        value(out, id);
        out.push(b',');
    }
}

/// `item`'s JSON.
pub fn write_item(out: &mut Vec<u8>, item: &Item) {
    match item {
        Item::Plain(item) => object(out, item),
        Item::Agent(agent) => {
            object(out, &agent.head);
            out.pop();
            out.extend_from_slice(br#","agentItems":["#);
            for (at, item) in agent.items.iter().enumerate() {
                if at > 0 {
                    out.push(b',');
                }
                object(out, item);
            }
            out.extend_from_slice(br#"],"agent":"#);
            object(out, &agent.agent);
            out.push(b'}');
        }
    }
}

fn delta(out: &mut Vec<u8>, item: &Text, summary: bool, delta: &Text) {
    out.extend_from_slice(br#","itemId":"#);
    write_text(out, item);
    if summary {
        out.extend_from_slice(br#","summaryIndex":0"#);
    }
    out.extend_from_slice(br#","delta":"#);
    write_text(out, delta);
}

/// `emit` as `[method, params]`.
pub fn write_emit(out: &mut Vec<u8>, thread: &Value, emit: &Emit) {
    match emit {
        Emit::TurnStarted { id, at } => {
            open_turn(out, "turn/started", thread, id);
            out.extend_from_slice(br#""status":"inProgress","items":[],"error":null,"startedAt":"#);
            value(out, &Value::Number(*at));
            out.extend_from_slice(br#","completedAt":null,"durationMs":null}"#);
        }
        Emit::TurnCompleted { id, status, error, at } => {
            open_turn(out, "turn/completed", thread, id);
            out.extend_from_slice(format!(r#""status":"{status}","error":"#).as_bytes());
            value(out, error);
            out.extend_from_slice(br#","completedAt":"#);
            value(out, &Value::Number(*at));
            out.extend_from_slice(br#","durationMs":null,"items":[]}"#);
        }
        Emit::Item { started, turn, item } => {
            open(out, if *started { "item/started" } else { "item/completed" }, thread, turn);
            out.extend_from_slice(br#","item":"#);
            write_item(out, item);
        }
        Emit::MessageDelta { turn, item, delta: text } => {
            open(out, "item/agentMessage/delta", thread, turn);
            delta(out, item, false, text);
        }
        Emit::ThoughtDelta { turn, item, delta: text } => {
            open(out, "item/reasoning/summaryTextDelta", thread, turn);
            delta(out, item, true, text);
        }
        Emit::Plan { turn, plan } => {
            open(out, "turn/plan/updated", thread, turn);
            out.extend_from_slice(br#","explanation":null,"plan":"#);
            value(out, plan);
        }
        Emit::Diff { turn, diff } => {
            open(out, "turn/diff/updated", thread, turn);
            out.extend_from_slice(br#","diff":"#);
            write_text(out, diff);
        }
    }
    out.extend_from_slice(b"}]");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(emit: &Emit) -> String {
        let mut out = Vec::new();
        write_emit(&mut out, &Value::text("c"), emit);
        String::from_utf8(out).expect("UTF-8")
    }

    fn turn() -> TurnId {
        Some(Value::text("t"))
    }

    #[test]
    fn each_notification_is_spelled_as_the_js_spelled_it() {
        for (emit, json) in [
            (
                Emit::TurnStarted { id: turn(), at: 1.5 },
                r#"["turn/started",{"threadId":"c","turn":{"id":"t","status":"inProgress","items":[],"error":null,"startedAt":1.5,"completedAt":null,"durationMs":null}}]"#,
            ),
            (
                Emit::TurnCompleted { id: turn(), status: "failed", error: Value::Null, at: 2.0 },
                r#"["turn/completed",{"threadId":"c","turn":{"id":"t","status":"failed","error":null,"completedAt":2,"durationMs":null,"items":[]}}]"#,
            ),
            (
                Emit::Item { started: true, turn: turn(), item: Item::Plain(Object::of([("id", Value::text("i"))])) },
                r#"["item/started",{"threadId":"c","turnId":"t","item":{"id":"i"}}]"#,
            ),
            (
                Emit::Item { started: false, turn: turn(), item: Item::Plain(Object::default()) },
                r#"["item/completed",{"threadId":"c","turnId":"t","item":{}}]"#,
            ),
            (
                Emit::MessageDelta { turn: turn(), item: "i".into(), delta: "d".into() },
                r#"["item/agentMessage/delta",{"threadId":"c","turnId":"t","itemId":"i","delta":"d"}]"#,
            ),
            (
                Emit::ThoughtDelta { turn: turn(), item: "i".into(), delta: "d".into() },
                r#"["item/reasoning/summaryTextDelta",{"threadId":"c","turnId":"t","itemId":"i","summaryIndex":0,"delta":"d"}]"#,
            ),
            (
                Emit::Plan { turn: turn(), plan: Value::Array(vec![Value::Null]) },
                r#"["turn/plan/updated",{"threadId":"c","turnId":"t","explanation":null,"plan":[null]}]"#,
            ),
            (Emit::Diff { turn: turn(), diff: "d".into() }, r#"["turn/diff/updated",{"threadId":"c","turnId":"t","diff":"d"}]"#),
        ] {
            assert_eq!(written(&emit), json);
        }
    }

    #[test]
    fn an_undefined_turn_id_is_left_out() {
        let started = written(&Emit::TurnStarted { id: None, at: 1.0 });
        assert!(started.contains(r#""turn":{"status":"inProgress""#), "{started}");
        let item = written(&Emit::Item { started: true, turn: None, item: Item::Plain(Object::default()) });
        assert_eq!(item, r#"["item/started",{"threadId":"c","item":{}}]"#);
    }

    #[test]
    fn an_agents_transcript_goes_between_its_fields() {
        let head = Object::of([("id", Value::text("a")), ("status", Value::text("inProgress"))]);
        let items = vec![Arc::new(Object::of([("n", Value::Number(1.0))])), Arc::new(Object::default())];
        let item = Item::Agent(Box::new(AgentItem { head, items, agent: Object::default() }));
        let mut out = Vec::new();
        write_item(&mut out, &item);
        assert_eq!(String::from_utf8(out).expect("UTF-8"), r#"{"id":"a","status":"inProgress","agentItems":[{"n":1},{}],"agent":{}}"#);
        assert_eq!(item.id(), Some(&Value::text("a")));
        assert!(item.in_progress());
        let mut plain = item.clone();
        plain.make_plain();
        assert!(plain.head().get("agentItems").is_some());
        let again = plain.clone();
        plain.make_plain();
        assert_eq!(plain, again);
        assert!(plain.plain_mut().is_some());
        assert!(item.clone().plain_mut().is_none());
    }

    #[test]
    fn a_cut_off_shows_on_either_kind_of_item() {
        let mut item = Item::Plain(Object::default());
        item.mark_cut_off();
        assert_eq!(item, Item::Plain(Object::of([("cutOff", Value::Bool(true))])));
        let mut item = Item::Agent(Box::new(AgentItem { head: Object::default(), items: Vec::new(), agent: Object::default() }));
        item.mark_cut_off();
        assert_eq!(item.head().get("cutOff"), Some(&Value::Bool(true)));
    }

    #[test]
    fn an_item_with_no_status_is_not_in_progress() {
        let item = Item::Plain(Object::of([("type", Value::text("webSearch"))]));
        assert!(!item.in_progress());
        assert_eq!(item.id(), None);
    }
}
