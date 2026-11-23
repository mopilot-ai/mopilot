//! Newline-delimited JSON framing of a byte stream (docs/architecture/rust-core.md §6 step 3): the bytes as they arrive, cut
//! into complete lines within the transport's size limit. It frames only; the lines are decoded and parsed in JS
//! (electron/transport/jsonReader.cjs), where the values have to live anyway. A harness child's stdout is framed on its
//! reader thread (proc's `spawn`); any other stream through the routes here.
//!
//! Lines go out as one buffer: each line's length (eight bytes, little-endian) and then its bytes, without the newline. A
//! line past the limit ends it with `TOO_LONG` in place of a length, and the framer takes nothing after that.

use dispatch::{Call, Handles};

mod routes;

/// The length that says a line was past the limit: no line is this long.
pub const TOO_LONG: u64 = u64::MAX;
/// The room a long line leaves behind that is let go once it ends, so one record that was long costs nothing after.
const KEPT: usize = 1 << 20;

/// One stream's framing: the bytes of the line still arriving, and the limit on a line.
#[derive(Debug, Default)]
pub struct Framer {
    pending: Vec<u8>,
    /// The UTF-16 units of `pending[..counted]`; the rest is the start of a character still arriving.
    units: usize,
    counted: usize,
    /// The longest line, in UTF-16 units as JS counts a string's length; None for no limit.
    max_units: Option<usize>,
    /// A line was past the limit: nothing more is framed.
    failed: bool,
}

/// What a push put out.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Framed {
    /// Complete lines, in order.
    pub lines: usize,
    /// A line past the limit came after them, and `TOO_LONG` ends the output.
    pub too_long: bool,
}

impl Framer {
    pub fn new(max_units: Option<usize>) -> Self {
        Framer { max_units, ..Framer::default() }
    }

    /// The complete lines `bytes` ends, appended to `out`; what follows the last newline waits for the next push. A line
    /// past the limit is told as soon as the units that arrived prove it, as JS's own count of a decoded string would, and
    /// stops the framer: what is still pending is let go.
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<u8>) -> Framed {
        let mut framed = Framed::default();
        if self.failed {
            return framed;
        }
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|&b| b == b'\n') {
            let line = &rest[..at];
            rest = &rest[at + 1..];
            let fits = if self.pending.is_empty() {
                self.fits(0, line) && put(out, line)
            } else {
                self.pending.extend_from_slice(line);
                let fits = self.fits(self.units, &self.pending[self.counted..]) && put(out, &self.pending);
                if self.pending.capacity() > KEPT {
                    self.pending = Vec::new();
                } else {
                    self.pending.clear();
                }
                (self.units, self.counted) = (0, 0);
                fits
            };
            if !fits {
                return self.fail(out, framed);
            }
            framed.lines += 1;
        }
        self.pending.extend_from_slice(rest);
        if let Some(max) = self.max_units {
            let (units, took) = units_of(&self.pending[self.counted..], false);
            self.units += units;
            self.counted += took;
            if self.units > max {
                return self.fail(out, framed);
            }
        }
        framed
    }

    /// Take nothing more, and let the line still arriving go: its stream's reader went.
    pub fn stop(&mut self) {
        self.failed = true;
        self.pending = Vec::new();
    }

    /// The bytes of the line still arriving.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// Whether a line of `before` units and then `rest` is within the limit.
    fn fits(&self, before: usize, rest: &[u8]) -> bool {
        self.max_units.is_none_or(|max| before + units_of(rest, true).0 <= max)
    }

    fn fail(&mut self, out: &mut Vec<u8>, framed: Framed) -> Framed {
        out.extend_from_slice(&TOO_LONG.to_le_bytes());
        self.failed = true;
        self.pending = Vec::new();
        Framed { too_long: true, ..framed }
    }
}

/// One line into `out`; true, so a check can go before it.
fn put(out: &mut Vec<u8>, line: &[u8]) -> bool {
    out.extend_from_slice(&(line.len() as u64).to_le_bytes());
    out.extend_from_slice(line);
    true
}

/// How many UTF-16 units `bytes` are as a JS string decoded from UTF-8, where each invalid sequence is one U+FFFD, and how
/// many bytes that took. Unless `last`, a character cut off at the end is left for the next count.
pub fn units_of(bytes: &[u8], last: bool) -> (usize, usize) {
    let mut units = 0;
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => return (units + utf16_len(valid.as_bytes()), bytes.len()),
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                units += utf16_len(valid);
                match error.error_len() {
                    Some(bad) => {
                        units += 1;
                        rest = &after[bad..];
                    }
                    None if last => return (units + 1, bytes.len()),
                    None => return (units, bytes.len() - after.len()),
                }
            }
        }
    }
}

/// The UTF-16 units of valid UTF-8: one per character, two for one past U+FFFF (a four-byte one).
fn utf16_len(valid: &[u8]) -> usize {
    valid.iter().map(|&b| usize::from(b & 0xC0 != 0x80) + usize::from(b >= 0xF0)).sum()
}

/// The most framers open at once: one per stream the core doesn't own (a socket, a child Node started), of which a machine
/// has a few hundred at most.
const MAX_FRAMERS: usize = 1024;

/// The framers the routes hold, by id. A framer goes with the environment that opened it.
static FRAMERS: Handles<Framer> = Handles::new("framer", MAX_FRAMERS);

/// A new framer's id, or why there can't be one.
pub fn open(call: &Call, max_units: Option<usize>) -> Result<u64, String> {
    FRAMERS.open(call, Framer::new(max_units))
}

/// Push `bytes` through framer `id`: its complete lines as one buffer, or a refusal for no such framer. A line past the
/// limit closes it.
pub fn push(id: u64, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (out, framed) = FRAMERS.with(id, |framer| {
        let mut out = Vec::new();
        let framed = framer.push(bytes, &mut out);
        (out, framed)
    })?;
    if framed.too_long {
        FRAMERS.close(id);
    }
    Ok(out)
}

/// Let framer `id` go, with whatever line it had begun; whether it was open.
pub fn close(id: u64) -> bool {
    FRAMERS.close(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines a buffer holds, and whether it ends too long.
    fn lines(out: &[u8]) -> (Vec<Vec<u8>>, bool) {
        let mut lines = Vec::new();
        let mut at = 0;
        while at < out.len() {
            let len = u64::from_le_bytes(out[at..at + 8].try_into().expect("a length"));
            if len == TOO_LONG {
                assert_eq!(at + 8, out.len(), "nothing follows");
                return (lines, true);
            }
            let len = len as usize;
            lines.push(out[at + 8..at + 8 + len].to_vec());
            at += 8 + len;
        }
        (lines, false)
    }

    fn push(f: &mut Framer, bytes: &[u8]) -> (Vec<Vec<u8>>, bool) {
        let mut out = Vec::new();
        let framed = f.push(bytes, &mut out);
        let (found, too_long) = lines(&out);
        assert_eq!(framed, Framed { lines: found.len(), too_long });
        (found, too_long)
    }

    #[test]
    fn lines_come_out_whole_however_the_bytes_are_cut() {
        let mut f = Framer::new(None);
        assert_eq!(push(&mut f, b"{\"a\":1}\n{\"b\""), (vec![b"{\"a\":1}".to_vec()], false));
        assert_eq!(push(&mut f, b":2}"), (vec![], false));
        assert_eq!(push(&mut f, b"\n\n{}\r\n"), (vec![b"{\"b\":2}".to_vec(), b"".to_vec(), b"{}\r".to_vec()], false));
        // a multi-byte character cut between pushes is whole in its line
        let snow = "\u{2603}".as_bytes();
        assert_eq!(push(&mut f, &snow[..1]), (vec![], false));
        assert_eq!(push(&mut f, &[&snow[1..], b"\n"].concat()), (vec![snow.to_vec()], false));
        // invalid bytes go as they came, and the end of a stream leaves its unterminated line unsaid
        assert_eq!(push(&mut f, &[0xff, b'\n', b'x']), (vec![vec![0xff]], false));
    }

    #[test]
    fn a_line_past_the_limit_is_too_long_as_its_units_arrive_and_nothing_follows() {
        let mut f = Framer::new(Some(3));
        // three units in nine bytes (three snowmen) fit; a fourth unit does not, and the lines before it still go
        assert_eq!(push(&mut f, "\u{2603}\u{2603}\u{2603}\n".as_bytes()).0.len(), 1);
        assert_eq!(push(&mut f, b"ab\nabcd\n"), (vec![b"ab".to_vec()], true));
        assert_eq!(push(&mut f, b"a\n"), (vec![], false), "a failed framer takes nothing");
        // still arriving: four units are too many before the line ends, three are not
        assert_eq!(push(&mut Framer::new(Some(3)), b"0123"), (vec![], true));
        let mut g = Framer::new(Some(3));
        assert_eq!(push(&mut g, b"012"), (vec![], false));
        assert_eq!(push(&mut g, b"\n"), (vec![b"012".to_vec()], false));
        // a line finished from what was pending counts all of it
        let mut h = Framer::new(Some(3));
        assert_eq!(push(&mut h, b"01"), (vec![], false));
        assert_eq!(push(&mut h, b"23\n"), (vec![], true));
        // an astral character is two units, counted once it is whole
        let mut e = Framer::new(Some(3));
        let face = "\u{1f600}".as_bytes();
        assert_eq!(push(&mut e, &[b"a", &face[..3]].concat()), (vec![], false));
        assert_eq!(push(&mut e, &face[3..]), (vec![], false));
        assert_eq!(push(&mut e, b"b"), (vec![], true));
    }

    #[test]
    fn a_long_line_s_room_goes_with_it_and_a_short_one_s_stays() {
        let mut f = Framer::new(None);
        assert_eq!(push(&mut f, &vec![b'x'; 2 * KEPT]), (vec![], false));
        assert_eq!(f.pending(), 2 * KEPT);
        assert_eq!(push(&mut f, b"\n").0.len(), 1);
        assert_eq!((f.pending(), f.pending.capacity()), (0, 0));
        push(&mut f, b"short");
        assert_eq!(push(&mut f, b"\n").0, vec![b"short".to_vec()]);
        assert!(f.pending.capacity() > 0, "a short line's room is kept for the next");
    }

    #[test]
    fn a_stopped_framer_lets_its_line_go_and_takes_nothing_more() {
        let mut f = Framer::new(None);
        push(&mut f, b"a line still arriving");
        f.stop();
        assert_eq!((f.pending(), f.pending.capacity()), (0, 0));
        assert_eq!(push(&mut f, b"\nmore\n"), (vec![], false));
    }

    #[test]
    fn units_count_as_js_strings_do() {
        assert_eq!(units_of(b"abc", true), (3, 3));
        assert_eq!(units_of("\u{1f600}\u{e9}".as_bytes(), true), (3, 6));
        // each invalid sequence is one U+FFFD, as Buffer's toString makes it
        assert_eq!(units_of(&[0xff, b'a', 0xed, 0xa0, 0x80], true), (5, 5));
        // a character cut off at the end waits, unless the line ends there
        assert_eq!(units_of(&[b'a', 0xe2, 0x98], false), (1, 1));
        assert_eq!(units_of(&[b'a', 0xe2, 0x98], true), (2, 3));
        assert_eq!(units_of(&[0xe2, b'a'], false), (2, 2));
    }

    #[test]
    fn framers_open_push_and_close_by_id() {
        let call = Call::default();
        let id = open(&call, Some(2)).expect("room");
        assert_eq!(lines(&super::push(id, b"ab\nc").expect("open")), (vec![b"ab".to_vec()], false));
        assert_eq!(lines(&super::push(id, b"def\n").expect("open")), (vec![], true));
        assert_eq!(super::push(id, b"x"), Err(format!("no framer {id}")), "a line past the limit closed it");
        assert!(!close(id));
        let other = open(&call, None).expect("room");
        assert!(close(other));
    }
}
