//! What a translator says folded into a chat's turns. The fold lives here with the translator rather than across the boundary
//! from it: a sub-agent's every update says its whole transcript so far, which a list of what was said would have to spell
//! out each time, so a long sub-agent's history would grow as its square. A turn holds each item's JSON too, so that a page
//! of even a huge one is a copy.

use crate::emit::{write_item, Emit, Item, TurnId};
use crate::reads::{first, text_of};
use crate::translator::Translator;
use crate::Thrown;
use jsvalue::json::{write, write_text, Numbers};
use jsvalue::value::{Object, Text, Value};
use std::collections::HashMap;
use std::ops::Range;

/// A turn's identity as JS's `===` has it for what a transcript holds. An object or an array as an id is only ever equal to
/// itself there; two with the same spelling are one here (no writer makes either).
pub(crate) fn key_of(id: &TurnId) -> Vec<u8> {
    let mut key = Vec::new();
    if let Some(id) = id {
        write(&mut key, id, Numbers::Exact);
    }
    key
}

#[derive(Clone)]
pub(crate) struct Turn {
    pub(crate) id: TurnId,
    status: Value,
    items: Vec<Item>,
    /// where each item id is
    places: HashMap<Vec<u8>, usize>,
    started_at: Option<f64>,
    completed_at: Option<f64>,
    duration_ms: Option<f64>,
    error: Value,
    /// `diff` and `plan`, in the order they were first set
    pub(crate) extras: Object,
    /// each item's JSON, until something changes it: a page of even a huge turn is then a copy on the JS thread
    written: Vec<Option<Vec<u8>>>,
}

impl Turn {
    fn new(id: TurnId) -> Self {
        Turn {
            id,
            status: Value::text("inProgress"),
            items: Vec::new(),
            places: HashMap::new(),
            started_at: None,
            completed_at: None,
            duration_ms: None,
            error: Value::Null,
            extras: Object::default(),
            written: Vec::new(),
        }
    }

    /// `status`, and how it failed.
    pub(crate) fn finish(&mut self, status: Value, error: Value) {
        (self.status, self.error) = (status, error);
    }

    pub(crate) fn in_progress(&self) -> bool {
        crate::reads::is(Some(&self.status), "inProgress")
    }

    pub(crate) fn items(&self) -> &[Item] {
        &self.items
    }

    /// A message's time in this turn, in seconds: the turn spans its first to its last message. Its ms come from seconds, as
    /// the JS worked Claude's out; `stamp`'s are the other way about.
    pub(crate) fn stamp_at(&mut self, at: f64) {
        let started = *self.started_at.get_or_insert(at);
        self.completed_at = Some(at);
        self.duration_ms = Some(math_round((at - started) * 1000.0).max(0.0));
    }

    /// The last `at` of a record seen in this turn, in milliseconds.
    pub(crate) fn stamp(&mut self, at: f64) {
        let started = *self.started_at.get_or_insert(at / 1e3);
        self.completed_at = Some(at / 1e3);
        self.duration_ms = Some(math_round(at - started * 1e3).max(0.0));
    }

    /// A time a notification gave, as `stamp` takes a record's.
    fn stamp_seconds(&mut self, at: Option<f64>) {
        if let Some(at) = at {
            self.stamp(at * 1e3);
        }
    }

    /// An item in its place: a repeated id replaces, where JS's `Map` found it, and an object as an id (from a user message
    /// of a transcript no writer made) was only ever itself.
    pub(crate) fn put(&mut self, item: Item) {
        let id = item.id();
        if matches!(id, Some(Value::Array(_) | Value::Object(_))) {
            return self.push(item);
        }
        self.put_spelled(item);
    }

    /// An item in its place, by how its id is spelled.
    pub(crate) fn put_spelled(&mut self, item: Item) {
        let key = key_of(&item.id().cloned());
        match self.places.get(&key) {
            Some(&place) => {
                self.items[place] = item;
                self.written[place] = None;
            }
            None => {
                self.places.insert(key, self.items.len());
                self.push(item);
            }
        }
    }

    fn push(&mut self, item: Item) {
        self.items.push(item);
        self.written.push(None);
    }

    /// The item a delta extends, as a plain object, if there is one. It may be of another kind than the delta's: a tool call
    /// can be spelled like a stream item's id, and a turn with a falsy id leaves its stream open across kinds.
    pub(crate) fn plain_item(&mut self, id: &Text) -> Option<&mut Object> {
        let place = *self.places.get(&key_of(&Some(Value::String(id.clone()))))?;
        self.written[place] = None;
        let item = &mut self.items[place];
        item.make_plain();
        item.plain_mut()
    }

    /// `it.text += delta`.
    fn extend_text(&mut self, id: &Text, delta: &Text) -> Result<(), Thrown> {
        let Some(item) = self.plain_item(id) else { return Ok(()) };
        let mut text = text_of(item.get("text"))?;
        text.push_text(delta);
        item.set("text", Value::String(text));
        Ok(())
    }

    /// `it.summary = [it.summary[0] + delta]`.
    fn extend_summary(&mut self, id: &Text, delta: &Text) -> Result<(), Thrown> {
        let Some(item) = self.plain_item(id) else { return Ok(()) };
        let summary = item.get("summary");
        let mut text = match summary {
            None | Some(Value::Null) => return Err("an item with no summary took a delta".into()),
            Some(Value::String(text)) => {
                text.units().next().map_or(Ok("undefined".into()), |unit| text_of(Some(&Value::String(unit.into()))))?
            }
            summary => text_of(first(summary))?,
        };
        text.push_text(delta);
        item.set("summary", Value::Array(vec![Value::String(text)]));
        Ok(())
    }

    /// About how much JSON this comes to: what is written of it, and a little for the rest.
    pub(crate) fn size(&self) -> usize {
        self.written.iter().map(|json| json.as_ref().map_or(1 << 10, Vec::len)).sum()
    }

    /// How many items it has.
    pub(crate) fn item_count(&self) -> usize {
        self.written.len()
    }

    /// Let go of what its JSON says too, for a turn nothing changes again: a long chat's images would be held twice.
    pub(crate) fn keep_only_written(&mut self) {
        (self.items, self.places) = (Vec::new(), HashMap::new());
    }

    /// Write every item's JSON, for a page to copy.
    pub(crate) fn write_items(&mut self) {
        let (items, written) = (&self.items, &mut self.written);
        for (item, written) in items.iter().zip(written) {
            let mut json = Vec::new();
            write_item(&mut json, item);
            *written = Some(json);
        }
    }

    pub(crate) fn write(&self, out: &mut Vec<u8>) {
        self.write_as(out, self.id.as_ref());
    }

    /// This turn's JSON, under `id`.
    pub(crate) fn write_as(&self, out: &mut Vec<u8>, id: Option<&Value>) {
        self.write_part(out, id, 0..self.item_count());
    }

    /// Where the items from `from` stop for a reply of at most `room` bytes: past one at the least.
    pub(crate) fn items_within(&self, from: usize, room: usize) -> usize {
        let mut size = 0;
        let mut fits = |json: &Option<Vec<u8>>| {
            size += json.as_ref().map_or(1 << 10, Vec::len);
            size <= room
        };
        (from + self.written[from..].iter().take_while(|json| fits(json)).count()).max((from + 1).min(self.item_count()))
    }

    /// The JSON of the items of `range`.
    fn write_item_range(&self, out: &mut Vec<u8>, range: Range<usize>) {
        let start = range.start;
        for (at, json) in self.written[range.clone()].iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            match json {
                Some(json) => out.extend_from_slice(json),
                None => write_item(out, &self.items[start + at]),
            }
        }
    }

    /// This turn's JSON, under `id`, with only the items of `range`.
    pub(crate) fn write_part(&self, out: &mut Vec<u8>, id: Option<&Value>, range: Range<usize>) {
        let number = |out: &mut Vec<u8>, number: Option<f64>| write(out, &number.map_or(Value::Null, Value::Number), Numbers::Stringified);
        out.push(b'{');
        if let Some(id) = id {
            out.extend_from_slice(br#""id":"#);
            write(out, id, Numbers::Stringified);
            out.push(b',');
        }
        out.extend_from_slice(br#""status":"#);
        write(out, &self.status, Numbers::Stringified);
        out.extend_from_slice(br#","items":["#);
        self.write_item_range(out, range);
        out.extend_from_slice(br#"],"startedAt":"#);
        number(out, self.started_at);
        out.extend_from_slice(br#","completedAt":"#);
        number(out, self.completed_at);
        out.extend_from_slice(br#","durationMs":"#);
        number(out, self.duration_ms);
        out.extend_from_slice(br#","error":"#);
        write(out, &self.error, Numbers::Stringified);
        out.extend_from_slice(br#","itemTimes":{}"#);
        for (key, value) in self.extras.entries() {
            out.push(b',');
            write_text(out, key);
            out.push(b':');
            write(out, value, Numbers::Stringified);
        }
        out.push(b'}');
    }

    /// `{"items":[…]}`, the rest of a turn cut short.
    pub(crate) fn write_rest(&self, out: &mut Vec<u8>, range: Range<usize>) {
        out.extend_from_slice(br#"{"items":["#);
        self.write_item_range(out, range);
        out.extend_from_slice(b"]}");
    }

    /// About how much JSON the item at `at` comes to.
    pub(crate) fn item_size(&self, at: usize) -> usize {
        self.written[at].as_ref().map_or(1 << 10, Vec::len)
    }
}

/// A time a notification gives, in seconds.
fn seconds(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(at)) => Some(*at),
        _ => None,
    }
}

/// `Math.round`, which takes a half up, where Rust's takes it away from zero, and is not `(x + 0.5).floor()`, which is off
/// for the largest double below 0.5.
pub(crate) fn math_round(number: f64) -> f64 {
    let floor = number.floor();
    if number - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Turns as they are folded: repeated ids find the first turn with that id, as a `find` did.
#[derive(Default)]
pub struct Turns {
    pub(crate) turns: Vec<Turn>,
    first: HashMap<Vec<u8>, usize>,
}

impl Turns {
    pub(crate) fn turn(&mut self, id: &TurnId) -> Option<&mut Turn> {
        let at = self.place(id)?;
        self.turns.get_mut(at)
    }

    /// Where the first turn with this id is.
    pub(crate) fn place(&self, id: &TurnId) -> Option<usize> {
        self.first.get(&key_of(id)).copied()
    }

    fn apply(&mut self, emit: Emit) -> Result<(), Thrown> {
        match emit {
            Emit::TurnStarted { id, .. } => self.add(id),
            Emit::TurnCompleted { id, status, error, .. } => {
                if let Some(turn) = self.turn(&id) {
                    (turn.status, turn.error) = (Value::text(status), error);
                }
            }
            Emit::Item { turn, item, .. } => {
                if let Some(turn) = self.turn(&turn) {
                    turn.put(item);
                }
            }
            Emit::MessageDelta { turn, item, delta } => {
                if let Some(turn) = self.turn(&turn) {
                    turn.extend_text(&item, &delta)?;
                }
            }
            Emit::ThoughtDelta { turn, item, delta } => {
                if let Some(turn) = self.turn(&turn) {
                    turn.extend_summary(&item, &delta)?;
                }
            }
            Emit::Diff { turn, diff } => {
                if let Some(turn) = self.turn(&turn) {
                    turn.extras.set("diff", Value::String(diff));
                }
            }
            Emit::Plan { turn, plan } => {
                if let Some(turn) = self.turn(&turn) {
                    let plan = Object::of([("explanation", Value::Null), ("steps", plan)]);
                    turn.extras.set("plan", Value::Object(plan));
                }
            }
        }
        Ok(())
    }

    /// What `translator` said, folded. Failing at either end fails the replay, as a throw in the JS's did.
    pub(crate) fn drain(&mut self, translator: &mut Translator, thrown: Option<Thrown>) -> Result<(), Thrown> {
        for emit in std::mem::take(&mut translator.out) {
            self.apply(emit)?;
        }
        thrown.map_or(Ok(()), Err)
    }

    pub(crate) fn write(&self) -> Vec<u8> {
        let mut out = vec![b'['];
        for (at, turn) in self.turns.iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            turn.write(&mut out);
        }
        out.push(b']');
        out
    }
}

/// How much of a page goes across at most, past its first turn: a page's cost on the JS thread is its size, and a page of
/// long turns stops early and says where to go on from.
const PAGE_BYTES: usize = 8 << 20;

/// How much of a chat goes across in one slice for a reader in main that wants all of it: JS parses a slice in a tick.
const SLICE_BYTES: usize = 4 << 20;

impl Turns {
    /// A page of `{ turns, olderCursor }`: the `limit` turns before `before`, oldest first (the latest without it, all of them
    /// with no limit). A cursor is how many turns come before its page, so it always goes back and a turn id said twice can't
    /// send a reader round. Turns are added after, so it holds across reads, but for the empty turn a replay gives a turn id
    /// said twice, which a read that heard that from the session lacks (`begun`): a cursor used past its read can be one off
    /// there, a turn shown twice or not until the next read. One that isn't in the history pages from the end. Before the JSON, which JS passes on unread for the window to parse, come a byte for whether there are older
    /// turns and a line with the page's turn ids.
    pub(crate) fn page(&self, limit: usize, before: Option<&Value>) -> Vec<u8> {
        let cursor = before.and_then(|cursor| crate::reads::string(Some(cursor)));
        let cursor = cursor.and_then(|cursor| cursor.lossy().parse().ok());
        let end = cursor.map_or(self.turns.len(), |at: usize| at.min(self.turns.len()));
        let mut size = 0;
        let mut start = end;
        for turn in self.turns[..end].iter().rev() {
            if limit > 0 && (end - start == limit || (start < end && size + turn.size() > PAGE_BYTES)) {
                break;
            }
            size += turn.size();
            start -= 1;
        }
        let mut reply = Vec::with_capacity(size + 64 * (end - start) + 64);
        reply.push(if start > 0 { b'1' } else { b'0' });
        let ids = self.turns[start..end].iter().map(|turn| turn.id.clone().unwrap_or(Value::Null)).collect();
        write(&mut reply, &Value::Array(ids), Numbers::Stringified);
        reply.push(b'\n');
        reply.extend_from_slice(br#"{"turns":["#);
        for (at, turn) in self.turns[start..end].iter().enumerate() {
            if at > 0 {
                reply.push(b',');
            }
            turn.write(&mut reply);
        }
        reply.extend_from_slice(br#"],"olderCursor":"#);
        let cursor = if start > 0 { format!("\"{start}\"") } else { "null".to_string() };
        reply.extend_from_slice(cursor.as_bytes());
        reply.push(b'}');
        reply
    }

    /// `{ parts, next }`: the turns from item `item` of turn `turn` on, as far as `SLICE_BYTES`, for a reader that wants all of
    /// them a little at a time. Each part is a turn with the items that fit; the first is the rest of the turn the last reply
    /// stopped in, when `item` isn't 0. `next` is `[turn, item]`, or null at the end.
    pub(crate) fn chunk(&self, mut turn: usize, mut item: usize) -> Vec<u8> {
        let mut out = br#"{"parts":["#.to_vec();
        let start = out.len();
        while let Some(held) = self.turns.get(turn) {
            let room = (start + SLICE_BYTES).saturating_sub(out.len());
            if room == 0 {
                break;
            }
            let end = held.items_within(item, room);
            if out.len() > start {
                out.push(b',');
            }
            held.write_part(&mut out, held.id.as_ref(), item..end);
            item = end;
            if end < held.items.len() {
                break;
            }
            (turn, item) = (turn + 1, 0);
        }
        out.extend_from_slice(br#"],"next":"#);
        if turn < self.turns.len() {
            out.extend_from_slice(format!("[{turn},{item}]").as_bytes());
        } else {
            out.extend_from_slice(b"null");
        }
        out.push(b'}');
        out
    }

    /// A turn the session has begun: back in progress if the fold closed it, as one the transcript cut off.
    fn begun(&mut self, id: TurnId, at: Option<f64>) {
        let at_turn = match self.first.get(&key_of(&id)) {
            Some(&known) => known,
            None => {
                self.add(id);
                self.turns.len() - 1
            }
        };
        let turn = &mut self.turns[at_turn];
        (turn.status, turn.error) = (Value::text("inProgress"), Value::Null);
        turn.stamp_seconds(at);
    }

    pub(crate) fn add(&mut self, id: TurnId) {
        self.first.entry(key_of(&id)).or_insert(self.turns.len());
        self.turns.push(Turn::new(id));
    }

    /// What the session said while a read ran, `[method, params]`, on top of what the read found. Each says the whole of
    /// what it names, so one the file also held changes nothing. Streamed text is no part of it: it says only what is new,
    /// and `Held::stream` gives the open message whole.
    pub(crate) fn said(&mut self, said: &Value) {
        let Some([Value::String(method), params]) = said.as_array().and_then(<[Value]>::first_chunk) else { return };
        let turn = params.field("turnId").cloned();
        let told = params.field("turn");
        let field = |key| told.and_then(|turn| turn.field(key));
        let id = field("id").cloned();
        if method.is("turn/started") {
            self.begun(id, seconds(field("startedAt")));
        } else if method.is("turn/completed") {
            if let Some(held) = self.turn(&id) {
                held.status = field("status").cloned().unwrap_or(Value::Null);
                held.error = field("error").cloned().unwrap_or(Value::Null);
                held.stamp_seconds(seconds(field("completedAt")));
            }
        } else if method.is("turn/plan/updated") {
            if let Some(held) = self.turn(&turn) {
                let plan = Object::of([("explanation", Value::Null), ("steps", params.field("plan").cloned().unwrap_or(Value::Null))]);
                held.extras.set("plan", Value::Object(plan));
            }
        } else if let (Some(held), Some(item)) = (self.turn(&turn), params.field("item").and_then(Value::as_object)) {
            // a card only ever starts from nothing: over what the file held, it would say less
            if method.is("item/completed") || !held.places.contains_key(&key_of(&item.get("id").cloned())) {
                held.put(Item::Plain(item.clone()));
            }
        }
    }
}

#[cfg(test)]
mod fold;
