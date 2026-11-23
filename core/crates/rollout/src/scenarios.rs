//! What the parity fixture can't hold: reads that fail, calls that stop, pages that stop short, and the places this leaves
//! the JS on purpose.

use crate::reader::HeldTurn;
use crate::zstd::Frame;
use crate::{history_of, page_of, History};
use dispatch::CancelToken;
use std::io::{self, BufReader, Cursor, Read};

/// The JSON of each turn in `text`.
fn turns(text: &str) -> Vec<String> {
    let history = history_of(&mut text.as_bytes(), &CancelToken::default()).expect("a read");
    let json = |turn: &HeldTurn| {
        let mut out = Vec::new();
        turn.write_to(&mut out);
        String::from_utf8(out).expect("UTF-8")
    };
    history.turns.iter().map(json).collect()
}

/// A file that gives these bytes, then fails.
struct Failing(Cursor<Vec<u8>>);

impl Failing {
    fn after(bytes: &[u8]) -> Self {
        Failing(Cursor::new(bytes.to_vec()))
    }
}

impl Read for Failing {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.0.read(buffer)? {
            0 => Err(io::Error::other("the disk went away")),
            read => Ok(read),
        }
    }
}

const PLAN: &str = r#"{"type":"event_msg","payload":{"type":"item_completed","turn_id":"t","item":{"type":"Plan","id":"p","text":"x"}}}"#;

#[test]
fn a_line_that_holds_u2028_keeps_its_item_where_readline_lost_it() {
    let text = PLAN.replace('x', "a\u{2028}b\u{2029}c");
    assert_eq!(turns(&text).len(), 1);
}

#[test]
fn a_lone_cr_ends_a_line_and_each_part_is_filtered_alone() {
    assert_eq!(turns(&format!("{PLAN}\rnot json\r{PLAN}\n")).len(), 1);
    assert_eq!(turns(&format!("no filter word\r{PLAN}")).len(), 1);
}

#[test]
fn a_kind_named_after_something_every_js_object_has_is_left_out() {
    // ITEMS, EXTENSIONS and USER_INPUT were objects: the JS found Object's own members in them, and made nonsense or threw
    for kind in ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "__defineGetter__"] {
        let item = PLAN.replace(r#""Plan""#, &format!("{kind:?}"));
        assert_eq!(turns(&item), Vec::<String>::new(), "{kind}");
    }
    let extension = PLAN.replace(r#""type":"Plan""#, r#""type":"Extension","kind":"constructor""#);
    assert_eq!(turns(&extension), Vec::<String>::new());
    let part = PLAN.replace(r#""type":"Plan""#, r#""type":"UserMessage","content":[{"type":"constructor","a_b":1}]"#);
    assert!(turns(&part)[0].contains(r#"{"type":"constructor","aB":1}"#));
    let action = PLAN.replace(r#""type":"Plan""#, r#""type":"WebSearch","action":{"type":"constructor"}"#);
    assert!(turns(&action)[0].contains(r#""action":{"type":"constructor"}"#));
}

#[test]
fn a_line_nested_past_the_limit_reads_as_a_bad_line() {
    let deep = format!("{}{}", "[".repeat(2000), "]".repeat(2000));
    assert_eq!(turns(&format!("{}\n{PLAN}\n", PLAN.replace(r#""x""#, &deep))).len(), 1);
}

#[test]
fn a_shape_the_js_threw_on_fails_the_read_with_the_lines_before_it() {
    let bad = PLAN.replace(r#""type":"Plan""#, r#""type":"FileChange""#);
    let read = history_of(&mut format!("{PLAN}\n{bad}\n").as_bytes(), &CancelToken::default());
    assert_eq!(read, Err("a Codex rollout's file change's status is not a string".to_string()));
    let bad = format!("{PLAN}\r{bad}\n");
    assert!(history_of(&mut bad.as_bytes(), &CancelToken::default()).is_err());
}

#[test]
fn a_read_that_fails_fails_the_history() {
    let read = history_of(&mut BufReader::new(Failing::after(b"{}\n")), &CancelToken::default());
    assert_eq!(read, Err("read a rollout: the disk went away".to_string()));
}

#[test]
fn a_call_cancelled_stops_the_read() {
    let cancel = CancelToken::default();
    cancel.cancel();
    assert_eq!(history_of(&mut format!("{PLAN}\n").as_bytes(), &cancel), Err(dispatch::CANCELLED.to_string()));
}

#[test]
fn a_turn_says_how_many_bytes_it_takes() {
    let turn = HeldTurn {
        before: b"[".as_slice().into(),
        items: vec![b"1".as_slice().into(), b"22".as_slice().into()],
        after: b"]".as_slice().into(),
    };
    let mut json = Vec::new();
    turn.write_to(&mut json);
    assert_eq!(json, b"[1,22]");
    assert!(turn.size() >= json.len());
}

#[test]
fn a_page_stops_short_of_too_many_bytes_but_never_empty() {
    let turn = |json: &[u8]| HeldTurn { before: b"[".as_slice().into(), items: vec![json.into()], after: b"]".as_slice().into() };
    let history = History { cwd: Vec::new(), turns: vec![turn(b"1"), turn(b"22"), turn(b"333")] };
    assert_eq!(page_of(&history, 0, 3, 1 << 20), b"[[1],[22],[333]]");
    assert_eq!(page_of(&history, 0, 3, 10), b"[[1],[22]]");
    assert_eq!(page_of(&history, 1, 3, 1), b"[[22]]");
    assert_eq!(page_of(&history, 3, 3, 10), b"[]");
    assert_eq!(page_of(&history, 2, 1, 10), b"[]");
    assert_eq!(page_of(&history, 2, 99, 10), b"[[333]]");
}

/// A frame of one raw block holding `text`, with a checksum of this value or none.
fn frame(text: &[u8], checksum: Option<u32>) -> Vec<u8> {
    let descriptor = 0x20 | if checksum.is_some() { 0x04 } else { 0 };
    let mut bytes = vec![0x28, 0xb5, 0x2f, 0xfd, descriptor, text.len() as u8];
    let header = (text.len() as u32) << 3 | 1;
    bytes.extend_from_slice(&header.to_le_bytes()[..3]);
    bytes.extend_from_slice(text);
    bytes.extend_from_slice(&checksum.map(u32::to_le_bytes).unwrap_or_default()[..if checksum.is_some() { 4 } else { 0 }]);
    bytes
}

fn unpacked(file: impl Read + 'static) -> io::Result<Vec<u8>> {
    let mut text = Vec::new();
    Frame::new(file)?.read_to_end(&mut text)?;
    Ok(text)
}

#[test]
fn a_frame_reads_to_its_end_and_no_further() {
    assert_eq!(unpacked(Cursor::new(frame(b"hello", None))).expect("a frame"), b"hello");
    let followed = [frame(b"one", None), frame(b"two", None)].concat();
    assert_eq!(unpacked(Cursor::new(followed)).expect("a frame"), b"one");
}

#[test]
fn a_checksum_is_held_to_what_came_out() {
    assert!(unpacked(Cursor::new(frame(b"hello", Some(0)))).expect_err("a wrong sum").to_string().contains("checksum"));
}

#[test]
fn a_file_that_fails_is_no_frame_cut_short() {
    let whole = frame(b"hello", None);
    assert!(unpacked(Failing::after(&whole[..2])).is_err(), "in the header");
    assert!(unpacked(Failing::after(&whole[..7])).is_err(), "in a block");
    let summed = frame(b"hello", Some(1));
    assert!(unpacked(Failing::after(&summed[..summed.len() - 2])).is_err(), "in the checksum");
}

#[test]
fn a_file_cut_short_lets_go_of_what_it_decoded() {
    assert_eq!(unpacked(Cursor::new(Vec::new())).expect("nothing to read"), b"");
    let block = |text: &[u8], last: u32| [((text.len() as u32) << 3 | last).to_le_bytes()[..3].to_vec(), text.to_vec()].concat();
    let start = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x48].to_vec();
    let cut = [start, block(b"first", 0), block(b"second", 0), block(b"never finished", 1)[..6].to_vec()].concat();
    assert_eq!(unpacked(Cursor::new(cut)).expect("what there is"), b"firstsecond");
}

#[test]
fn the_deepest_line_a_read_takes_fits_a_core_threads_stack() {
    let deep = format!("{}1{}", r#"{"a_b":"#.repeat(990), "}".repeat(990));
    let line = PLAN.replace(r#""type":"Plan""#, &format!(r#""type":"SubAgentActivity","deep":{deep}"#));
    let reading = std::thread::Builder::new().stack_size(8 << 20).spawn(move || turns(&line).len());
    assert_eq!(reading.expect("a thread").join().expect("no failure"), 1);
}

#[test]
fn a_window_past_nodes_limit_fails() {
    let frame = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xe8];
    assert!(Frame::new(Cursor::new(frame)).err().expect("too large").to_string().contains("window"));
}
