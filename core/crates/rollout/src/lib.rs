//! A Codex thread's history read from its rollout file (JSONL, plain or zstd-compressed) rather than through the
//! app-server, for when the app-server is down, in the shape thread/turns/list answers with. The file is read off the JS
//! thread and its turns are held here, as JSON, so that a long chat's history is off the JS heap and paging parses nothing
//! again. Finding the file, whose home it is in, how long a parse is kept and the cursor are
//! `electron/harness/codexRollout.cjs`'s.
//!
//! The JS this replaced leaned on `JSON.parse` and on JS's coercions wherever a line held something odd, so the `jsvalue`
//! crate models those rather than a tidier reading of the format: what it took, this takes.

use dispatch::{Call, CancelToken, Handles};
use jsvalue::{js, json, value};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

mod file_url;
mod items;
mod reader;
mod routes;
mod usage;
mod zstd;

use reader::{History, Reader};

/// What is parsed and held, by id. One is kept and a few are being paged: this bounds what a leak can hold.
static ROLLOUTS: Handles<History> = Handles::big("rollout", 64);

/// How much of a file a read takes at once.
const READ_BYTES: usize = 1 << 20;

/// Replies stop growing about here, for a thread whose turns add up to more than a JS string can hold: the caller asks
/// again from where a page stopped.
const PAGE_BYTES: usize = 64 << 20;

/// The history in `lines`, a read that fails (or a call that is cancelled) failing it.
fn history_of(lines: &mut dyn BufRead, cancel: &CancelToken) -> Result<History, String> {
    let mut reader = Reader::default();
    let mut run = Vec::new();
    loop {
        cancel.check()?;
        run.clear();
        if lines.read_until(b'\n', &mut run).map_err(|error| format!("read a rollout: {error}"))? == 0 {
            return Ok(reader.finish());
        }
        reader.lines(&run)?;
    }
}

/// The text of the rollout at `path`, decompressed if its name ends in `.zst`.
fn input(path: &str) -> Result<BufReader<Box<dyn Read>>, String> {
    let file = File::open(path).map_err(|error| format!("open a rollout: {error}"))?;
    let input: Box<dyn Read> = if path.ends_with(".zst") {
        Box::new(zstd::Frame::new(file).map_err(|error| format!("read a rollout: {error}"))?)
    } else {
        Box::new(file)
    };
    Ok(BufReader::with_capacity(READ_BYTES, input))
}

/// The history of the rollout at `path`, compressed if its name ends in `.zst`.
fn read(path: &str, cancel: &CancelToken) -> Result<History, String> {
    history_of(&mut input(path)?, cancel)
}

/// Read the rollout at `path` and hold its turns for `call`'s owner: their id, the folder it ran in as JSON, and how
/// many turns it has.
fn open(path: &str, call: &Call) -> Result<(u64, Vec<u8>, usize), String> {
    let mut history = read(path, &call.cancel)?;
    let (cwd, count) = (std::mem::take(&mut history.cwd), history.turns.len());
    Ok((ROLLOUTS.open(call, history)?, cwd, count))
}

/// The sampling requests in the rollout at `path`, as JSON (usage.rs).
fn usage(path: &str, call: &Call) -> Result<Vec<u8>, String> {
    usage::usage_of(&mut input(path)?, &call.cancel)
}

/// The turns from `start` up to `end` as a JSON list. One that would take the reply past `limit` is left for the next
/// page, unless it is the first: a list shorter than was asked for is not the end.
fn page_of(history: &History, start: usize, end: usize, limit: usize) -> Vec<u8> {
    let mut json = vec![b'['];
    for turn in history.turns.get(start..end.min(history.turns.len())).unwrap_or_default() {
        if json.len() > 1 {
            if json.len() + turn.size() > limit {
                break;
            }
            json.push(b',');
        }
        turn.write_to(&mut json);
    }
    json.push(b']');
    json
}

fn page(id: u64, start: usize, end: usize) -> Result<Vec<u8>, String> {
    ROLLOUTS.with(id, |history| page_of(history, start, end, PAGE_BYTES))
}

fn close(id: u64) -> bool {
    ROLLOUTS.close(id)
}

#[cfg(test)]
mod parity;

#[cfg(test)]
mod scenarios;
