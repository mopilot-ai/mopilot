//! Main's stream batcher (docs/performance/design.md D3, docs/architecture/rust-core.md §6): one queue per chat across
//! every family. A delta joins the chat's last pending delta when their keys match, else it queues behind it; an event
//! that waits queues behind them unjoined; any other event sends the chat's pending deltas first. So for one chat
//! windows see events in the order the adapters produced them (across a harness switch too, since both segments share
//! the chat's queue), with runs of same-key deltas merged. Order across chats is not promised.
//!
//! The ticks are decided here and timed in JS (electron/harness/coreBatcher.cjs): a delta that arrives while no tick runs
//! goes out at once and starts one, deltas that arrive during a tick wait for its end, and a tick that sent something
//! starts the next. A flush from outside sends what is pending and leaves the tick running. Windows that do not show a
//! chat get its deltas from a second queue on the slower background tick; every flush of the chat sends both.
//!
//! The events themselves stay JS objects in JS, which holds each by the sequence number it pushed it with: a delta's
//! JSON crosses so its text can join, and comes back only when it did; an event that waits never crosses.

use jsvalue::unit_length;
use jsvalue::value::{Text, Value};

#[cfg(test)]
mod cases;
pub mod contracts;
mod routes;

use contracts::{text_mut, Family, Kind};

/// A chat's pending text past this many UTF-16 units (256 Ki) goes out at once, so a runaway stream never piles up.
pub const MAX_PENDING: usize = 256 * 1024;

/// One event in a queue: the number JS holds it by, and for a delta its key and value.
#[derive(Clone, Debug)]
struct Entry {
    seq: u64,
    family: Family,
    delta: Option<Delta>,
}

#[derive(Clone, Debug)]
struct Delta {
    key: Vec<u8>,
    text: &'static [&'static str],
    event: Value,
    /// Another delta's text joined this one's: the event goes back to JS as JSON.
    joined: bool,
}

/// A chat's pending events: for every window (`entries`) and for those not showing it (`background`), and the length of
/// the text that went into `entries` since the chat last sent them.
#[derive(Debug)]
struct Queue {
    chat: Text,
    entries: Vec<Entry>,
    background: Vec<Entry>,
    size: usize,
}

/// An event a flush sends: the number JS holds it by, which lane it is for, and the joined event when it is one.
#[derive(Debug, PartialEq)]
pub struct Out {
    pub seq: u64,
    pub background: bool,
    pub joined: Option<Value>,
}

/// What one chat's flush sends, in order: one message per window.
#[derive(Debug, PartialEq)]
pub struct Group {
    pub chat: Text,
    pub out: Vec<Out>,
}

/// What a push did with its event, beside what it sent.
#[derive(Debug, PartialEq)]
pub enum Pushed {
    /// Queued: JS holds the event for `refs` entries (one per lane it leads).
    Queued { refs: u8 },
    /// Not queued: JS sends it now, after the groups.
    Alone,
    /// Not queued, and its key could not be read: JS notes it and sends it now, after every chat's groups.
    Malformed,
}

/// What a call asks of JS: the groups to send, each in one batch, and which ticks to start.
#[derive(Debug, Default, PartialEq)]
pub struct Said {
    pub groups: Vec<Group>,
    pub schedule: bool,
    pub schedule_background: bool,
}

/// One batcher: the queues in the order their chats first queued, and whether each tick runs.
#[derive(Debug)]
pub struct Batcher {
    max_pending: usize,
    queues: Vec<Queue>,
    ticking: bool,
    background_ticking: bool,
}

impl Batcher {
    pub fn new(max_pending: usize) -> Self {
        Batcher { max_pending, queues: Vec::new(), ticking: false, background_ticking: false }
    }

    /// How many chats have something pending.
    pub fn pending(&self) -> usize {
        self.queues.len()
    }

    fn at(&self, chat: &Text) -> Option<usize> {
        self.queues.iter().position(|queue| queue.chat == *chat)
    }

    /// Event `seq` of `family` for `chat`, as `kind` reads it (`event` its value, which only a delta needs); `background`:
    /// a window open does not show the chat.
    pub fn push(&mut self, seq: u64, family: Family, chat: Text, background: bool, kind: Kind, mut event: Value) -> (Pushed, Said) {
        let mut said = Said::default();
        let delta = match kind {
            Kind::Malformed => {
                said.groups = self.flush_all();
                return (Pushed::Malformed, said);
            }
            Kind::Alone => {
                said.groups.extend(self.flush_chat(&chat));
                return (Pushed::Alone, said);
            }
            Kind::Waits => None,
            Kind::Delta { key, text } => {
                let units = unit_length(text_mut(&mut event, text).expect("a keyed delta has its text").as_bytes());
                Some((Delta { key, text, event, joined: false }, units))
            }
        };
        let at = self.at(&chat).unwrap_or_else(|| {
            self.queues.push(Queue { chat: chat.clone(), entries: Vec::new(), background: Vec::new(), size: 0 });
            self.queues.len() - 1
        });
        let queue = &mut self.queues[at];
        let mut refs = 0;
        if let Some((delta, units)) = delta {
            if background {
                refs += u8::from(join(&mut queue.background, seq, family, delta.clone()));
            }
            refs += u8::from(join(&mut queue.entries, seq, family, delta));
            queue.size += units;
        } else {
            // never joined: no delta has its key, so the next delta queues behind it
            let entry = Entry { seq, family, delta: None };
            if background {
                queue.background.push(entry.clone());
                refs += 1;
            }
            queue.entries.push(entry);
            refs += 1;
        }
        if background && !self.background_ticking {
            self.background_ticking = true;
            said.schedule_background = true;
        }
        // out at once: past the bound, or at the leading edge (no tick is running, so nothing was sent within the last one
        // and this delta needs no company); the tick that starts now paces the deltas behind it
        if self.queues[at].size >= self.max_pending || !self.ticking {
            said.groups.extend(self.flush_chat(&chat));
            if !self.ticking {
                self.ticking = true;
                said.schedule = true;
            }
        }
        (Pushed::Queued { refs }, said)
    }

    /// A chat's pending events, both lanes, in order: before its next event, its deletion or a harness switch. The tick
    /// keeps running: it is the cooldown of what was just sent.
    pub fn flush_chat(&mut self, chat: &Text) -> Option<Group> {
        let queue = self.queues.remove(self.at(chat)?);
        let mut out = outs(queue.entries, false);
        out.extend(outs(queue.background, true));
        Some(Group { chat: queue.chat, out })
    }

    /// Every chat's pending events, one group per chat in the order they queued.
    pub fn flush_all(&mut self) -> Vec<Group> {
        let chats: Vec<Text> = self.queues.iter().map(|queue| queue.chat.clone()).collect();
        chats.iter().filter_map(|chat| self.flush_chat(chat)).collect()
    }

    /// The tick's end: every chat's events for the windows that show it; a tick that sent some starts the next (`schedule`),
    /// so a steady stream stays at one send per tick.
    pub fn tick(&mut self) -> Said {
        self.ticking = false;
        let mut groups = Vec::new();
        self.queues.retain_mut(|queue| {
            queue.size = 0;
            let entries = std::mem::take(&mut queue.entries);
            if !entries.is_empty() {
                groups.push(Group { chat: queue.chat.clone(), out: outs(entries, false) });
            }
            // a chat with nothing left waiting for the background tick is done
            !queue.background.is_empty()
        });
        self.ticking = !groups.is_empty();
        Said { schedule: self.ticking, groups, schedule_background: false }
    }

    /// The background tick's end: what is pending for the windows that do not show a chat goes out, all chats at once.
    pub fn background_tick(&mut self) -> Said {
        self.background_ticking = false;
        let mut groups = Vec::new();
        self.queues.retain_mut(|queue| {
            if !queue.background.is_empty() {
                groups.push(Group { chat: queue.chat.clone(), out: outs(std::mem::take(&mut queue.background), true) });
            }
            // nothing left for either lane: no record stays behind
            !queue.entries.is_empty()
        });
        Said { groups, ..Said::default() }
    }

    /// The timers were cleared: no tick runs.
    pub fn cancel(&mut self) {
        self.ticking = false;
        self.background_ticking = false;
    }
}

/// A delta onto a lane: joined with the last one when their family and key match. Whether it leads a new entry.
fn join(entries: &mut Vec<Entry>, seq: u64, family: Family, mut next: Delta) -> bool {
    if let Some(Entry { family: last_family, delta: Some(last), .. }) = entries.last_mut() {
        if *last_family == family && last.key == next.key {
            let more = std::mem::take(text_mut(&mut next.event, next.text).expect("a keyed delta has its text"));
            text_mut(&mut last.event, last.text).expect("a keyed delta has its text").push_text(&more);
            last.joined = true;
            return false;
        }
    }
    entries.push(Entry { seq, family, delta: Some(next) });
    true
}

/// A lane's entries as a flush sends them.
fn outs(entries: Vec<Entry>, background: bool) -> Vec<Out> {
    let joined = |delta: Option<Delta>| delta.filter(|delta| delta.joined).map(|delta| delta.event);
    entries.into_iter().map(|entry| Out { seq: entry.seq, background, joined: joined(entry.delta) }).collect()
}
