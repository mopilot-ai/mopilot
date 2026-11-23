//! Each family's stream contract (docs/performance/design.md D3): which of its events are text deltas the batcher joins,
//! their keys and the text they join on, and which wait for the tick unjoined. The gates come first: an event no gate
//! admits is neither, so JS reads them (the `batcher.families` route) and serializes only what one admits.

use jsvalue::js::{given, to_text, truthy};
use jsvalue::json::{write, Numbers};
use jsvalue::value::{Text, Value};
use translate::parent_of;

/// A harness family, or the remote item feed's own stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Codex,
    Claude,
    Acp,
    Feed,
}

/// What one of an event's fields must be for a gate to admit it.
pub enum Is {
    /// One of these strings.
    OneOf(&'static [&'static str]),
    /// An object that is no array.
    Record,
}

/// One condition of a gate: the field at `path`, read as `e?.a?.b` reads it.
pub struct Test {
    pub path: &'static [&'static str],
    pub is: Is,
}

/// Codex's text-delta methods (shared/streamDelta.mjs `TEXT_METHODS`).
const TEXT_METHODS: &[&str] = &[
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
];
/// Live reasoning parts an item may have (shared/streamDelta.mjs `MAX_REASONING_PARTS`).
const MAX_REASONING_PARTS: f64 = 4096.0;
const ACP_CHUNKS: &[&str] = &["agent_message_chunk", "agent_thought_chunk"];

const CODEX: &[Test] =
    &[Test { path: &["kind"], is: Is::OneOf(&["notification"]) }, Test { path: &["method"], is: Is::OneOf(TEXT_METHODS) }];
const CLAUDE: &[Test] = &[
    Test { path: &["kind"], is: Is::OneOf(&["message"]) },
    Test { path: &["msg", "type"], is: Is::OneOf(&["stream_event"]) },
    Test { path: &["msg", "event", "type"], is: Is::OneOf(&["content_block_delta"]) },
];
const ACP: &[Test] =
    &[Test { path: &["kind"], is: Is::OneOf(&["update"]) }, Test { path: &["update", "sessionUpdate"], is: Is::OneOf(ACP_CHUNKS) }];
/// ACP's tool calls, their progress, usage, a plan: every update goes out with the chunks around it, in order.
const ACP_WAITS: &[Test] = &[Test { path: &["kind"], is: Is::OneOf(&["update"]) }, Test { path: &["update"], is: Is::Record }];
const FEED: &[Test] = &[Test { path: &["ev"], is: Is::OneOf(&["items.delta"]) }];

/// Where a delta's text is.
const CODEX_TEXT: &[&str] = &["params", "delta"];
const CLAUDE_TEXT: &[&str] = &["msg", "event", "delta", "text"];
const CLAUDE_THINKING: &[&str] = &["msg", "event", "delta", "thinking"];
const ACP_TEXT: &[&str] = &["update", "content", "text"];
const FEED_TEXT: &[&str] = &["text"];

/// What the batcher does with an event.
#[derive(Debug, PartialEq)]
pub enum Kind {
    /// A text delta: joined with the one before it in its chat's queue when their keys match.
    Delta { key: Vec<u8>, text: &'static [&'static str] },
    /// Queued behind the chat's deltas, never joined.
    Waits,
    /// Sent at once, after its chat's pending deltas.
    Alone,
    /// Its key could not be read, as the JS threw: every chat's deltas go first, and then it.
    Malformed,
}

impl Family {
    pub const ALL: [Family; 4] = [Family::Codex, Family::Claude, Family::Acp, Family::Feed];

    pub fn name(self) -> &'static str {
        match self {
            Family::Codex => "codex",
            Family::Claude => "claude",
            Family::Acp => "acp",
            Family::Feed => "feed",
        }
    }

    pub fn of(name: &[u8]) -> Option<Family> {
        Family::ALL.into_iter().find(|family| family.name().as_bytes() == name)
    }

    /// What a delta of the family has: an event it leaves out is no delta.
    pub fn delta_gate(self) -> &'static [Test] {
        match self {
            Family::Codex => CODEX,
            Family::Claude => CLAUDE,
            Family::Acp => ACP,
            Family::Feed => FEED,
        }
    }

    /// What an event that waits has, when no key is read from it; none for a family whose events never wait.
    pub fn wait_gate(self) -> Option<&'static [Test]> {
        (self == Family::Acp).then_some(ACP_WAITS)
    }

    /// What the batcher does with `event` of this family.
    pub fn classify(self, event: &Value) -> Kind {
        let key = if passes(self.delta_gate(), event) {
            match self {
                Family::Codex => codex(event),
                Family::Claude => claude(event),
                Family::Acp => acp(event),
                Family::Feed => feed(event),
            }
        } else {
            Ok(None)
        };
        match key {
            Err(()) => Kind::Malformed,
            Ok(Some((key, text))) => Kind::Delta { key, text },
            Ok(None) if self.wait_gate().is_some_and(|gate| passes(gate, event)) => Kind::Waits,
            Ok(None) => Kind::Alone,
        }
    }
}

/// `e?.a?.b`: only an object has a field this reads.
pub fn at<'a>(event: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(event, |value, key| value.field(key))
}

/// Whether `event` meets every test of `gate`.
pub fn passes(gate: &[Test], event: &Value) -> bool {
    gate.iter().all(|test| match (&test.is, at(event, test.path)) {
        (Is::OneOf(values), found) => string(found).is_some_and(|text| values.iter().any(|value| text.is(value))),
        (Is::Record, found) => matches!(found, Some(Value::Object(_))),
    })
}

/// A key's parts as one collision-free run of bytes: each part's length, then its bytes.
fn key_of(parts: &[&Text]) -> Vec<u8> {
    let mut key = Vec::new();
    for part in parts {
        key.extend_from_slice(&(part.as_bytes().len() as u64).to_le_bytes());
        key.extend_from_slice(part.as_bytes());
    }
    key
}

/// The string `value` is, if it is one.
pub fn string(value: Option<&Value>) -> Option<&Text> {
    match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// `String(part)` of a part that must be a string or a number (the JS's `keyOf`), else None: the delta goes out alone.
fn part(value: Option<&Value>) -> Option<Text> {
    match value? {
        number @ Value::Number(_) => to_text(number).ok(),
        other => string(Some(other)).cloned(),
    }
}

/// `part(value ?? '')`.
fn part_or_empty(value: Option<&Value>) -> Option<Text> {
    given(value).map_or(Some(Text::default()), |value| part(Some(value)))
}

/// `String(value ?? '')`, or Err where JS finds no string in an object and throws.
fn text_or_empty(value: Option<&Value>) -> Result<Text, ()> {
    given(value).map_or(Ok(Text::default()), |value| to_text(value).map_err(drop))
}

/// `Number.isInteger(value)`.
fn integer(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() && number.fract() == 0.0 => Some(*number),
        _ => None,
    }
}

type Keyed = Result<Option<(Vec<u8>, &'static [&'static str])>, ()>;

/// The key of parts that are all strings or numbers, with where the text is; None when one is not.
fn keyed(parts: &[Option<Text>], text: &'static [&'static str]) -> Option<(Vec<u8>, &'static [&'static str])> {
    let parts: Option<Vec<&Text>> = parts.iter().map(Option::as_ref).collect();
    Some((key_of(&parts?), text))
}

/// Codex: a normalized notification of a text-delta method that `isInvalidStreamNotification` passes, keyed by
/// (thread, turn, item, method, part index).
fn codex(e: &Value) -> Keyed {
    let p = e.field("params");
    let field = |name| p.and_then(|p| p.field(name));
    if string(field("delta")).is_none() {
        return Ok(None);
    }
    let method = string(e.field("method")).expect("the gate read it");
    // a reasoning part's index (`params?.[field] ?? (field === 'contentIndex' ? 0 : null)`) is an integer below the cap
    let reasoning = match () {
        _ if method.is("item/reasoning/summaryTextDelta") => Some(("summaryIndex", None)),
        _ if method.is("item/reasoning/textDelta") => Some(("contentIndex", Some(0.0))),
        _ => None,
    };
    if let Some((name, default)) = reasoning {
        let index = given(field(name)).map_or(default, |index| integer(Some(index)));
        if !index.is_some_and(|index| (0.0..MAX_REASONING_PARTS).contains(&index)) {
            return Ok(None);
        }
    }
    let index = given(field("summaryIndex")).or(given(field("contentIndex")));
    let index = index.map_or(Some(Text::from("0")), |index| part(Some(index)));
    Ok(keyed(&[part(field("threadId")), part(field("turnId")), part(field("itemId")), Some(method.clone()), index], CODEX_TEXT))
}

/// Claude Code: an SDK `stream_event` text or thinking delta of the chat's own session (not a sub-agent's), keyed by
/// (session, content block index, delta type, account, login).
fn claude(e: &Value) -> Keyed {
    let msg = e.field("msg").expect("the gate read it");
    if msg.field("parent_tool_use_id").is_some_and(truthy) {
        return Ok(None);
    }
    let ev = msg.field("event").expect("the gate read it");
    let index = ev.field("index");
    let kind = at(ev, &["delta", "type"]);
    let text = match string(kind) {
        Some(kind) if kind.is("text_delta") => CLAUDE_TEXT,
        Some(kind) if kind.is("thinking_delta") => CLAUDE_THINKING,
        _ => return Ok(None),
    };
    if integer(index).is_none() || string(at(e, text)).is_none() {
        return Ok(None);
    }
    // String(e.account ?? '') and String(e.login ?? ''), both read before the key's type is checked, as the JS's were
    let account = text_or_empty(e.field("account"))?;
    let login = text_or_empty(e.field("login"))?;
    Ok(keyed(&[part(e.field("key")), part(index), part(kind), Some(account), Some(login)], text))
}

/// ACP: an `update` of a message or thought chunk whose content is plain text, keyed by (session, turn, update kind,
/// sub-agent parent, tool call). A replacement goes out alone: joined behind a delta it would be drawn as more text.
fn acp(e: &Value) -> Keyed {
    let u = e.field("update").expect("the gate read it");
    let content = u.field("content");
    let plain = matches!(content, Some(Value::Object(_))) && string(at(u, &["content", "type"])).is_some_and(|t| t.is("text"));
    if e.field("replaces").is_some() || !plain || string(at(u, &["content", "text"])).is_none() {
        return Ok(None);
    }
    // where String(u.toolCallId) throws, so did the JS's keyOf
    let parent = parent_of(u.as_object()).map_err(drop)?;
    let parts = [
        part(e.field("key")),
        part_or_empty(e.field("turnId")),
        part(u.field("sessionUpdate")),
        Some(parent.unwrap_or_default()),
        part_or_empty(u.field("toolCallId")),
    ];
    Ok(keyed(&parts, ACP_TEXT))
}

/// The remote item feed's `items.delta`, keyed by JSON.stringify([chatId, turnId, itemId, field, index]).
fn feed(e: &Value) -> Keyed {
    if string(e.field("text")).is_none() {
        return Ok(None);
    }
    let mut key = Vec::new();
    for name in ["chatId", "turnId", "itemId", "field", "index"] {
        write(&mut key, e.field(name).unwrap_or(&Value::Null), Numbers::Stringified);
        key.push(b',');
    }
    Ok(Some((key, FEED_TEXT)))
}

/// `value[key]`, to change, for an object's own key.
pub fn field_mut<'a>(value: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    match value {
        Value::Object(object) => object.get_mut(key),
        _ => None,
    }
}

/// The text at `path`, to join onto: a keyed delta always has it.
pub fn text_mut<'a>(event: &'a mut Value, path: &[&str]) -> Option<&'a mut Text> {
    match path.iter().try_fold(event, |value, key| field_mut(value, key))? {
        Value::String(text) => Some(text),
        _ => None,
    }
}
