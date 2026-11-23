//! A harness child's stdout framed on its reader thread (Stage 4.2 of the Rust migration): JS hears the complete lines a
//! read ended, in the framing crate's layout, and never frames bytes itself (electron/platform/coreChild.cjs).
//!
//! A line still arriving waits here, so it counts against the window as what JS holds does: with nobody reading, a line
//! that never ends costs a window, as unframed output does. A line longer than the window would then never come, since JS
//! can't take what it hasn't been sent; so once it fills the window the reader asks (`ASK`, with the ask's number), and JS,
//! if it reads, says it wants it (`proc.want` with that number, so a want that comes late, after its line ended, is no want
//! of the next). The line then grows to its end, or to the spawn's limit, and comes whole. A stdout JS destroyed takes
//! nothing more (`proc.drop`): what is read is dropped, and no line is kept.

use super::{Child, State, WINDOW};
use framing::Framer;
use serde::Deserialize;

/// Framing asked for at the spawn: the longest line, in UTF-16 units as JS counts them, or None for no limit.
#[derive(Deserialize)]
pub(super) struct LineSpec {
    pub(super) limit: Option<usize>,
}

/// What JS said of a framed stdout's line still arriving.
#[derive(Debug, Default)]
pub(super) struct Demand {
    /// JS wants it, however long.
    pub(super) wanted: bool,
    /// JS was asked, and this is the ask's number.
    pub(super) asked: bool,
    pub(super) ask: u64,
    /// JS destroyed the stream: nothing is framed or told from here.
    pub(super) dropping: bool,
}

/// What one read tells JS: `event`, a header, with the complete lines `bytes` ended and a line past the limit if one was, or
/// nothing when it ended none (a line still arriving, a framer that stopped at a line too long, or a stream `dropping`).
pub(super) fn event(framer: &mut Framer, dropping: bool, mut event: Vec<u8>, bytes: &[u8]) -> Option<Vec<u8>> {
    if dropping {
        framer.stop();
    }
    let framed = framer.push(bytes, &mut event);
    (framed.lines > 0 || framed.too_long).then_some(event)
}

/// Whether output `which`'s reader must wait: its window is full of what JS holds, or of that and `pending` bytes of a line
/// still arriving that JS hasn't said it wants, in which case JS is asked once (`ask`, with the ask's number).
pub(super) fn held(state: &mut State, which: usize, pending: usize, ask: impl FnOnce(u64) -> bool) -> bool {
    let charged = state.charged[which];
    if charged >= WINDOW {
        return true;
    }
    let demand = &mut state.demand;
    if demand.wanted || demand.dropping || charged + pending < WINDOW {
        return false;
    }
    if !demand.asked {
        demand.asked = true;
        demand.ask += 1;
        ask(demand.ask);
    }
    true
}

/// Output `which` told JS something: for stdout, what JS was asked about has come, and the next long line asks again.
pub(super) fn told(state: &mut State, which: usize) {
    if which == 0 {
        (state.demand.wanted, state.demand.asked) = (false, false);
    }
}

impl Child {
    /// JS reads stdout and wants the line it was asked about, ask `ask`, however long: a want of an earlier ask is none.
    pub(super) fn want(&self, ask: u64) {
        let mut state = self.lock();
        let demand = &mut state.demand;
        demand.wanted |= demand.asked && demand.ask == ask;
        self.changed.notify_all();
    }

    /// JS destroyed stdout: what comes is read and dropped, and no line is kept, so nothing stalls and nothing piles up.
    pub(super) fn drop_lines(&self) {
        let mut state = self.lock();
        state.demand.dropping = true;
        self.changed.notify_all();
    }
}
