//! A Claude chat's history off the JS thread: `translate.claudeRead` replays what `getSessionMessages` read on whichever thread
//! calls it (the turns worker, or a core thread), and holds the turns; `translate.claudeSettle` cuts a page of them, in one step on
//! the JS thread, whose cost is that of the page's copy and never of the transcript. A window merges a page with its live
//! turns (src/session/harness/claude/history.ts), so the session going on meanwhile changes nothing here: the read has a
//! translator of its own. See routes.rs for the routes.

use crate::claude::replay::{Finished, Reading};
use crate::reads::{string, text_from};
use crate::turns::{key_of, Turn};
use crate::Thrown;
use jsvalue::js::truthy;
use jsvalue::json::{parse, write, Numbers};
use jsvalue::value::{Object, Text, Value};
use memchr::memmem;
use std::collections::HashMap;

/// How long after its last write another app's session still counts as working (shared/claudeItems/liveWindow.mjs).
const LIVE_WINDOW_MS: f64 = 30_000.0;
/// How much of a page goes across at most, past its first turn.
const PAGE_BYTES: usize = 8 << 20;
/// Between an id and which of its repeats a cursor means. No turn id holds it unless a transcript made it so.
const REPEAT: char = '\u{0}';

/// One line of a read's records, as `JSON.parse` reads it. A line this can't read is left out: JS's own limit on nesting was its
/// stack's, which here would be the process's.
fn record_of(line: &[u8]) -> Option<Value> {
    parse(&String::from_utf8_lossy(line)).filter(|record| matches!(record, Value::Object(_)))
}

/// The line of a fork's last copied message: `findLastIndex` of `forkedFrom`. `JSON.stringify` spells that key one way.
fn fork_leaf(lines: &[&[u8]]) -> Option<usize> {
    let finder = memmem::Finder::new(b"\"forkedFrom\"");
    lines.iter().rposition(|line| {
        finder.find(line).is_some() && record_of(line).is_some_and(|record| record.field("forkedFrom").is_some_and(truthy))
    })
}

/// What a read keeps: its turns, and which turn ids repeat, for cursors that have to tell them apart.
pub struct Held {
    done: Finished,
    repeats: HashMap<Vec<u8>, Vec<usize>>,
}

/// The records of `lines` replayed for `header`, and how many couldn't be read or replayed. Each of those is left out alone, so
/// one the language can't read doesn't cost the chat its history.
pub fn read<'a>(header: &Object, lines: impl Iterator<Item = &'a [u8]>, cancel: &dispatch::CancelToken) -> Result<(Held, usize), Thrown> {
    let lines: Vec<&[u8]> = lines.collect();
    let now = match header.get("now") {
        Some(Value::Number(now)) => *now,
        _ => 0.0,
    };
    let mut reading = Reading::new(header, now, fork_leaf(&lines));
    let mut unread = 0;
    for line in lines {
        cancel.check()?;
        match record_of(line) {
            Some(record) => unread += usize::from(reading.take(&record).is_err()),
            None => {
                unread += 1;
                reading.skip();
            }
        }
    }
    let mut done = reading.finish()?;
    let turns = done.turns.turns.iter_mut().chain(done.closed.as_mut().map(|(_, turn)| turn));
    turns.for_each(|turn| {
        turn.write_items();
        turn.keep_only_written();
    });
    Ok((Held::of(done), unread))
}

/// What a settle asks.
#[derive(Default)]
pub struct Asked {
    pub live_tail: bool,
    pub closed_tail: bool,
    pub open: bool,
    pub limit: usize,
    pub before: Option<Text>,
    pub now: f64,
    /// the turn the session is running here: a turn left open takes its id
    pub live: Option<Value>,
}

impl Held {
    fn of(done: Finished) -> Self {
        let mut places: HashMap<Vec<u8>, Vec<usize>> = HashMap::new();
        for (place, turn) in done.turns.turns.iter().enumerate() {
            places.entry(key_of(&turn.id)).or_default().push(place);
        }
        places.retain(|_, places| places.len() > 1);
        Held { done, repeats: places }
    }

    /// The turn at `place`, as it reads with its tail closed or left open.
    fn turn(&self, place: usize, closed: bool) -> &Turn {
        match &self.done.closed {
            Some((at, turn)) if closed && *at == place => turn,
            _ => &self.done.turns.turns[place],
        }
    }

    /// Where a page before `before` ends. A cursor no longer in the history (an edited message cut it off) pages from the end.
    fn end_of(&self, before: Option<&Text>) -> usize {
        let turns = &self.done.turns;
        let Some(before) = before else { return turns.turns.len() };
        if let Some(place) = turns.place(&Some(Value::String(before.clone()))) {
            return place;
        }
        // a cursor of a repeated id, which names one of them, so that paging always goes on back
        let bytes = before.as_bytes();
        let split = bytes.iter().rposition(|byte| *byte == REPEAT as u8).unwrap_or(0);
        let nth = std::str::from_utf8(&bytes[(split + 1).min(bytes.len())..]).ok().and_then(|nth| nth.parse::<usize>().ok());
        let id = Some(Value::String(text_from(&bytes[..split])));
        nth.and_then(|nth| self.repeats.get(&key_of(&id))?.get(nth).copied()).unwrap_or(turns.turns.len())
    }

    /// The cursor that goes on from the turn at `place`: its id, or for a repeated one which of them it is.
    fn cursor(&self, place: usize) -> Value {
        let id = self.done.turns.turns[place].id.clone().unwrap_or(Value::Null);
        let key = key_of(&Some(id.clone()));
        match (self.repeats.get(&key).and_then(|places| places.iter().position(|at| *at == place)), string(Some(&id))) {
            (Some(nth), Some(text)) => {
                let mut cursor = text.clone();
                cursor.push_str(&format!("{REPEAT}{nth}"));
                Value::String(cursor)
            }
            _ => id,
        }
    }

    /// The first turn of a page ending at `end`: `limit` turns back, or as far as its size allows.
    fn start_of(&self, end: usize, limit: usize) -> usize {
        if limit == 0 {
            return 0;
        }
        let mut size = 0;
        let mut start = end;
        for turn in self.done.turns.turns[..end].iter().rev() {
            if end - start == limit || (start < end && size + turn.size() > PAGE_BYTES) {
                break;
            }
            size += turn.size();
            start -= 1;
        }
        start
    }

    /// Whether the last turn stays open: main runs it now (#1838), whatever the transcript's timestamps say, or another app wrote
    /// it a moment ago and it hasn't replied yet. An older page never holds the last turn.
    fn stays_open(&self, asked: &Asked) -> bool {
        asked.before.is_none()
            && (asked.open || (asked.live_tail && !self.done.ended_on_text && asked.now - self.done.last_at < LIVE_WINDOW_MS))
    }

    /// A page: `1` or `0` for whether there are older turns, a line of its turn ids as JSON (JS looks up their saved diffs), and
    /// then JSON `{ turns, olderCursor, closedTail }`, which JS passes on unread for the window to parse. With `closedTail`, a
    /// last turn left open for a live writer also comes as it reads with none (else null), for a caller that learns only after
    /// the read whether another app is writing.
    pub fn page(&self, asked: &Asked) -> Vec<u8> {
        let closed = !self.stays_open(asked);
        let end = self.end_of(asked.before.as_ref());
        let start = self.start_of(end, asked.limit);
        let places = start..end;
        let last = places.clone().last().map(|place| self.turn(place, closed));
        let renamed = |place: usize, turn: &Turn| {
            let open = place + 1 == end && turn.in_progress();
            asked.live.as_ref().filter(|live| open && Some(*live) != turn.id.as_ref())
        };
        let tail = asked.live_tail && asked.before.is_none() && asked.closed_tail && last.is_some_and(Turn::in_progress);
        let closed_tail = tail.then(|| self.done.turns.turns.len().checked_sub(1)).flatten().map(|place| self.turn(place, true));
        let mut ids = Vec::with_capacity(end - start + 1);
        for place in places.clone() {
            let turn = self.turn(place, closed);
            ids.push(renamed(place, turn).or(turn.id.as_ref()).cloned().unwrap_or(Value::Null));
        }
        ids.extend(closed_tail.map(|turn| turn.id.clone().unwrap_or(Value::Null)));
        let size: usize = places.clone().map(|place| self.turn(place, closed).size()).sum();
        let mut reply = Vec::with_capacity(size + 64 * ids.len() + 64);
        reply.push(if start > 0 { b'1' } else { b'0' });
        write(&mut reply, &Value::Array(ids), Numbers::Stringified);
        reply.push(b'\n');
        reply.extend_from_slice(br#"{"turns":["#);
        for place in places {
            if place > start {
                reply.push(b',');
            }
            let turn = self.turn(place, closed);
            turn.write_as(&mut reply, renamed(place, turn).or(turn.id.as_ref()));
        }
        reply.extend_from_slice(br#"],"olderCursor":"#);
        let cursor = if start > 0 { self.cursor(start) } else { Value::Null };
        write(&mut reply, &cursor, Numbers::Stringified);
        reply.extend_from_slice(br#","closedTail":"#);
        match closed_tail {
            Some(turn) => turn.write(&mut reply),
            None => reply.extend_from_slice(b"null"),
        }
        reply.push(b'}');
        reply
    }

    /// The next `bytes` or so of every turn from `turn`, item `item` on, oldest first, for a reader on the JS thread that has to
    /// parse it all: `{ continues, turns, rest }`. A turn is cut at an item when it has to be, so that one long turn costs no
    /// more at a time than many short ones do: `rest` is where to go on from (null at the end), and `continues` says the first
    /// of `turns` is only the rest of the last one's `items`. The walk goes by place, so it always ends.
    pub fn walk(&self, closed: bool, mut turn: usize, mut item: usize, bytes: usize) -> Vec<u8> {
        let continues = item > 0;
        let mut out = format!(r#"{{"continues":{continues},"turns":["#).into_bytes();
        let (mut used, mut first) = (0, true);
        let count = self.done.turns.turns.len();
        while turn < count && used < bytes {
            let held = self.turn(turn, closed);
            let items = held.item_count();
            item = item.min(items);
            let mut end = item;
            while end < items && (end == item && used == 0 || used + held.item_size(end) <= bytes) {
                used += held.item_size(end);
                end += 1;
            }
            if end == item && items > item {
                break;
            }
            if !first {
                out.push(b',');
            }
            first = false;
            if item > 0 {
                held.write_rest(&mut out, item..end);
            } else {
                held.write_part(&mut out, held.id.as_ref(), item..end);
            }
            used += 256;
            if end < items {
                item = end;
                break;
            }
            turn += 1;
            item = 0;
        }
        out.extend_from_slice(br#"],"rest":"#);
        if turn < count {
            out.extend_from_slice(format!("[{turn},{item}]").as_bytes());
        } else {
            out.extend_from_slice(b"null");
        }
        out.push(b'}');
        out
    }
}
