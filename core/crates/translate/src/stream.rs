//! A translator's streamed message or thought: its one open item, held back until its first characters say whether it is a
//! compaction summary, and its text corrected when a Host's whole message arrives after a lost delta.

use crate::blocks::block_text;
use crate::compaction::{compaction_item, is_compaction_summary, summary_start, Shape};
use crate::emit::{Emit, Item};
use crate::reads::{string, text_of};
use crate::replay::OpenText;
use crate::translator::Translator;
use crate::Thrown;
use jsvalue::js::truthy;
use jsvalue::value::{Object, Text, Value};
use jsvalue::{ends_with, without_tail};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Message,
    Thought,
}

/// The message or thought being streamed.
pub struct Stream {
    id: Text,
    kind: Kind,
    text: Text,
    msg: Option<Text>,
    shape: Shape,
}

/// A streamed message's item. A harness that reports its compaction only as an agent message gets the compaction item while
/// the text opens like its summary; once the message ends, it stays one only if the whole text is a summary, else it is the
/// reply it turned out to be.
fn stream_item(stream: &Stream, manual: bool, done: bool) -> Object {
    let id = stream.id.clone();
    if stream.kind == Kind::Thought {
        let summary = Value::Array(vec![Value::String(stream.text.clone())]);
        return Object::of([
            ("type", Value::text("reasoning")),
            ("id", Value::String(id)),
            ("summary", summary),
            ("content", Value::Array(Vec::new())),
        ]);
    }
    let compaction = if done { is_compaction_summary(stream.text.as_bytes()) } else { stream.shape == Shape::Summary };
    if stream.shape != Shape::Reply && compaction {
        return compaction_item(id, Some(if manual { "manual" } else { "auto" }), done.then_some(&stream.text));
    }
    message_item(id, if done { stream.text.clone() } else { Text::default() })
}

pub fn message_item(id: Text, text: Text) -> Object {
    Object::of([
        ("type", Value::text("agentMessage")),
        ("id", Value::String(id)),
        ("text", Value::String(text)),
        ("phase", Value::Null),
        ("memoryCitation", Value::Null),
        ("delivery", Value::Null),
    ])
}

/// A sub-agent's thought, its summary starting at `delta`.
pub fn thought_item(id: Text, delta: Text) -> Object {
    Object::of([
        ("type", Value::text("reasoning")),
        ("id", Value::String(id)),
        ("summary", Value::Array(vec![Value::String(delta)])),
        ("content", Value::Array(Vec::new())),
    ])
}

impl Translator {
    /// The open message as far as a window has it: not one held back, and not a compaction, whose text is no reply.
    pub fn open_text(&self) -> Option<OpenText> {
        let stream = self.stream.as_ref().filter(|stream| stream.shape == Shape::Reply)?;
        Some((self.turn_id.clone(), stream.id.clone(), stream.kind == Kind::Thought, stream.text.clone()))
    }

    pub(crate) fn close_stream(&mut self) {
        if !self.is_running() {
            return;
        }
        if let Some(stream) = self.stream.take() {
            self.emit_item(false, self.turn_id.clone(), Item::Plain(stream_item(&stream, self.manual, true)));
        }
    }

    /// One chunk of a message or a thought. `msg` is the update's messageId, when the harness gives one: a new message is an
    /// item of its own. `replaces` is text of the open message that this one takes the place of (a Host's whole message
    /// after a lost delta, electron/host/remoteChats.cjs): the item is shown again with its text corrected.
    pub(crate) fn chunk(&mut self, kind: Kind, content: Option<&Value>, msg: Option<Text>, replaces: Option<&Value>) -> Result<(), Thrown> {
        let turn = self.turn_id.clone();
        let delta = block_text(content)?;
        if delta.is_empty() && !replaces.is_some_and(truthy) {
            return Ok(());
        }
        if self.stream.as_ref().is_some_and(|stream| stream.kind != kind || (kind == Kind::Message && stream.msg != msg)) {
            self.close_stream();
        }
        if let (Some(open), Some(tail)) = (self.stream.as_mut(), string(replaces)) {
            if !tail.is_empty() && ends_with(&open.text, tail) {
                let mut text = without_tail(&open.text, tail);
                text.push_text(&delta);
                open.text = text;
                // a message still held back is shown once its first characters say what it is
                if open.shape != Shape::Open {
                    let item = stream_item(open, self.manual, true);
                    self.emit_item(false, turn, Item::Plain(item));
                }
                return Ok(());
            }
        }
        if delta.is_empty() {
            return Ok(());
        }
        let mut stream = match self.stream.take() {
            Some(stream) => stream,
            None => {
                let mut id = text_of(turn.as_ref())?;
                id.push_str(&format!(":{}{}", if kind == Kind::Message { 'm' } else { 'r' }, self.count));
                self.count += 1;
                // a message is held back until its first characters tell whether it is a compaction summary
                let shape = if kind == Kind::Message { Shape::Open } else { Shape::Reply };
                let stream = Stream { id, kind, text: Text::default(), msg, shape };
                if kind == Kind::Thought {
                    self.emit_item(true, turn.clone(), Item::Plain(stream_item(&stream, self.manual, false)));
                }
                stream
            }
        };
        stream.text.push_text(&delta);
        let item = stream.id.clone();
        if kind == Kind::Thought {
            self.out.push(Emit::ThoughtDelta { turn, item, delta });
        } else {
            let mut out = delta;
            if stream.shape == Shape::Open {
                stream.shape = summary_start(stream.text.as_bytes());
                if stream.shape != Shape::Open {
                    out = stream.text.clone();
                    self.emit_item(true, turn.clone(), Item::Plain(stream_item(&stream, self.manual, false)));
                }
            }
            if stream.shape == Shape::Reply {
                self.out.push(Emit::MessageDelta { turn, item, delta: out });
            }
        }
        self.stream = Some(stream);
        Ok(())
    }
}
