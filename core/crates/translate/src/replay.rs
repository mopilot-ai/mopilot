//! A transcript replayed into a chat's turns (`buildAcpTurns`), without touching the live store per record: a translator and
//! the turns it says (`turns`), fed a record at a time. Only the turns as they end up cross, a page at a time for a reader
//! that asks (`history`).

use crate::emit::TurnId;
use crate::translator::Translator;
use crate::turns::{Turn, Turns};
use crate::Thrown;
use dispatch::CancelToken;
use jsvalue::js::strict_equals;
use jsvalue::json::parse;
use jsvalue::value::{Object, Text, Value};

/// A transcript as far as it has been replayed: the translator, for what comes next, and the turns so far.
pub struct Held {
    translator: Translator,
    turns: Turns,
}

impl Held {
    pub fn new(header: &Object) -> Self {
        Held { translator: Translator::new(header), turns: Turns::default() }
    }

    /// One transcript record. What was said before it failed stays.
    pub fn take(&mut self, record: Value) -> Result<(), Thrown> {
        let at = record.field("at").cloned();
        let thrown = self.translator.run(0.0, |translator| translator.replay(record));
        self.turns.drain(&mut self.translator, thrown)?;
        if let (Some(turn), Some(Value::Number(at))) = (self.turns.turns.last_mut(), at) {
            turn.stamp(at);
        }
        Ok(())
    }

    /// Whether the transcript's last turn is one a live turn left open. `live` says the turn still running, as true or its id.
    fn runs(&self, live: Option<&Value>) -> bool {
        live == Some(&Value::Bool(true)) || strict_equals(live, self.translator.turn_id.as_ref())
    }

    /// A prompt that never ended was cut off (the app quit mid-turn), unless it is the one still running.
    pub fn settle(&mut self, live: Option<&Value>) -> Result<(), Thrown> {
        if self.translator.is_running() && !self.runs(live) {
            let thrown = self.translator.run(0.0, |translator| translator.end_turn(Some(&Value::text("cancelled")), None, None));
            self.turns.drain(&mut self.translator, thrown)?;
        }
        Ok(())
    }

    /// See `Turns::said`.
    pub fn said(&mut self, said: &Value) {
        self.turns.said(said);
    }

    /// The session's open message as it stands, in place of what the read found of it.
    pub fn stream(&mut self, (turn, id, thought, text): OpenText) {
        if let Some(item) = self.turns.turn(&turn).and_then(|held| held.plain_item(&id)) {
            let text = Value::String(text);
            item.set(if thought { "summary" } else { "text" }, if thought { Value::Array(vec![text]) } else { text });
        }
    }

    /// See `Turns::chunk`.
    pub fn chunk(&self, turn: usize, item: usize) -> Vec<u8> {
        self.turns.chunk(turn, item)
    }

    /// The translator of a turn `live` says still runs, to go on from where the transcript ends, leaving none here.
    pub fn kept(&mut self, live: Option<&Value>) -> Option<Translator> {
        let keep = self.translator.is_running() && self.runs(live);
        keep.then(|| std::mem::replace(&mut self.translator, Translator::new(&Object::default())))
    }

    /// See `Turns::page`.
    pub fn page(&self, limit: usize, before: Option<&Value>) -> Vec<u8> {
        self.turns.page(limit, before)
    }

    /// Every item's JSON from here on, while nothing waits: `settle` writes again only what the session has touched since.
    pub fn finish(&mut self) {
        self.turns.turns.iter_mut().for_each(Turn::write_items);
    }
}

/// An open message: its turn and id, whether it is a thought, and its text so far.
pub type OpenText = (TurnId, Text, bool, Text);

/// A finished replay: its turns as JSON, and the translator of a turn still running when the caller asked to follow it, as
/// its transcript ends.
pub struct Replayed {
    pub turns: Vec<u8>,
    pub kept: Option<Translator>,
}

/// One record's line, read as `JSON.parse` would. A line this can't read is left out: JS's own limit on nesting was its
/// stack's, which here would be the process's.
pub(crate) fn record_of(line: &[u8]) -> Option<Value> {
    parse(&String::from_utf8_lossy(line))
}

/// Replay `lines` for `header`: `{ threadId, cwd, auto, live, keep }`. `live` says the last turn is still running, as true
/// or its id, and `keep` that its translator should go on from where the transcript ends.
pub fn replay<'a>(header: &Object, lines: impl Iterator<Item = &'a [u8]>, cancel: &CancelToken) -> Result<Replayed, Thrown> {
    let mut held = Held::new(header);
    for record in lines.filter_map(record_of) {
        cancel.check()?;
        held.take(record)?;
    }
    held.settle(header.get("live"))?;
    let keep = held.translator.is_running() && header.get("keep") == Some(&Value::Bool(true));
    Ok(Replayed { turns: held.turns.write(), kept: keep.then_some(held.translator) })
}
