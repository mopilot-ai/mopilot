//! A rollout's sampling requests and their token usage, for the request ledger's import of Codex sessions run outside
//! MoPilot (electron/ledger/backfill.cjs): one request per `token_count` event whose thread total differs from the one
//! before (a stopped turn repeats its last), as the ledger's live Codex tap (electron/ledger/codexTap.cjs) counts them, with
//! the same key, `<thread>:<total>`, so a request MoPilot recorded itself is matched exactly. A request whose
//! `token_usage_record` names another thread is that thread's (a fork's copy of its parent's history), and a MoPilot Host's
//! rollout has none (the app that runs a Host's chat records them, under the Host's session ids). Nothing a request said or
//! answered is read: only the thread's id, the model and the counts.

use crate::js::number_text;
use crate::json::{parse, write_text};
use crate::value::{Text, Value};
use dispatch::CancelToken;
use memchr::memmem::find;
use std::io::BufRead;

/// Only these lines are parsed: the model's own records are most of a file.
fn wanted(line: &[u8]) -> bool {
    [&b"\"token_count\""[..], b"\"token_usage_record\"", b"\"turn_context\"", b"\"session_meta\""]
        .iter()
        .any(|kind| find(line, kind).is_some())
}

/// The client name a MoPilot Host's app-server gives (host/src/codexFamily.mjs), which Codex writes as the originator.
const HOST_ORIGINATOR: &str = "mopilot_host";

/// A count as the ledger keeps one: a whole number, none when it is not a positive one.
fn count(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.round() as u64
    } else {
        0
    }
}

fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => *number,
        _ => 0.0,
    }
}

fn text(value: Option<&Value>) -> Option<&Text> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text),
        _ => None,
    }
}

/// The requests so far, as a JSON list of `[id, thread, time, model, in, out, cacheRead, cacheWrite]`.
pub struct Usage {
    /// the thread's id: the first session_meta's (a fork's file also holds its parent's, after its own)
    thread: Option<Text>,
    /// whether a MoPilot Host started the thread
    host: bool,
    model: Option<Text>,
    total: Option<f64>,
    /// the thread the request record before the next token_count names
    record: Option<Text>,
    json: Vec<u8>,
}

impl Default for Usage {
    fn default() -> Self {
        Usage { thread: None, host: false, model: None, total: None, record: None, json: vec![b'['] }
    }
}

impl Usage {
    /// One line of the file. One that is cut off (Codex is writing it) or is not a record is skipped.
    pub fn line(&mut self, line: &[u8]) {
        if !wanted(line) {
            return;
        }
        let Some(Value::Object(record)) = parse(&String::from_utf8_lossy(line)) else {
            return;
        };
        let (Some(Value::String(kind)), Some(p)) = (record.get("type"), record.get("payload")) else {
            return;
        };
        let at = text(record.get("timestamp"));
        if kind.is("session_meta") {
            if let (None, Some(id)) = (&self.thread, text(p.field("id"))) {
                self.thread = Some(id.clone());
                self.host = text(p.field("originator")).is_some_and(|o| o.is(HOST_ORIGINATOR));
            }
        } else if kind.is("token_usage_record") {
            self.record = text(p.field("thread_id")).cloned();
        } else if kind.is("turn_context") {
            if let Some(model) = text(p.field("model")) {
                self.model = Some(model.clone());
            }
        } else if kind.is("event_msg") && text(p.field("type")).is_some_and(|event| event.is("token_count")) {
            self.token_count(p.field("info"), at);
        }
    }

    fn token_count(&mut self, info: Option<&Value>, at: Option<&Text>) {
        let record = self.record.take();
        let (Some(info), Some(at)) = (info, at) else {
            return;
        };
        let (Some(Value::Number(total)), Some(last)) =
            (info.field("total_token_usage").and_then(|t| t.field("total_tokens")), info.field("last_token_usage"))
        else {
            return;
        };
        let total = *total;
        // a stopped turn repeats its last event; a thread's total can also start again lower, and that is a new request
        if !total.is_finite() || self.total == Some(total) {
            return;
        }
        self.total = Some(total);
        let Some(thread) = &self.thread else {
            return;
        };
        // a request another thread's record names is a copy of that thread's (a fork's of its parent's): its own file has it
        if self.host || record.is_some_and(|named| named != *thread) {
            return;
        }
        let cached = number(last.field("cached_input_tokens"));
        let counts = [
            count(number(last.field("input_tokens")) - cached),
            count(number(last.field("output_tokens"))),
            count(cached),
            count(number(last.field("cache_write_input_tokens"))),
        ];
        if self.json.len() > 1 {
            self.json.push(b',');
        }
        self.json.push(b'[');
        let mut id = thread.clone();
        id.push_str(&format!(":{}", number_text(total)));
        write_text(&mut self.json, &id);
        self.json.push(b',');
        write_text(&mut self.json, thread);
        self.json.push(b',');
        write_text(&mut self.json, at);
        self.json.push(b',');
        match &self.model {
            Some(model) => write_text(&mut self.json, model),
            None => self.json.extend_from_slice(b"null"),
        }
        for n in counts {
            self.json.extend_from_slice(format!(",{n}").as_bytes());
        }
        self.json.push(b']');
    }

    /// The requests, as JSON.
    pub fn finish(mut self) -> Vec<u8> {
        self.json.push(b']');
        self.json
    }
}

/// The requests in `lines`, a read that fails (or a call that is cancelled) failing it.
pub fn usage_of(lines: &mut dyn BufRead, cancel: &CancelToken) -> Result<Vec<u8>, String> {
    let mut usage = Usage::default();
    let mut run = Vec::new();
    loop {
        cancel.check()?;
        run.clear();
        if lines.read_until(b'\n', &mut run).map_err(|error| format!("read a rollout: {error}"))? == 0 {
            return Ok(usage.finish());
        }
        usage.line(&run);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requests(text: &str) -> serde_json::Value {
        let json = usage_of(&mut text.as_bytes(), &CancelToken::default()).expect("read");
        serde_json::from_slice(&json).expect("JSON")
    }

    fn meta(id: &str, at: &str) -> String {
        format!(r#"{{"timestamp":"{at}","type":"session_meta","payload":{{"id":"{id}","cwd":"/w"}}}}"#)
    }

    fn context(model: &str) -> String {
        format!(r#"{{"timestamp":"2026-11-01T00:00:01.000Z","type":"turn_context","payload":{{"turn_id":"t","model":"{model}"}}}}"#)
    }

    fn tokens(at: &str, total: u64, input: u64, cached: u64, out: u64) -> String {
        format!(
            r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"total_tokens":{total}}},"last_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":3,"output_tokens":{out},"reasoning_output_tokens":1,"total_tokens":{}}}}},"rate_limits":null}}}}"#,
            input + out
        )
    }

    #[test]
    fn each_change_of_the_total_is_one_request_keyed_as_the_live_tap_keys_it() {
        let text = [
            meta("th", "2026-11-01T00:00:00.000Z"),
            r#"{"timestamp":"2026-11-01T00:00:00.500Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#.into(),
            context("gpt-a"),
            tokens("2026-11-01T00:00:02.000Z", 120, 100, 40, 20),
            // a stopped turn's repeat
            tokens("2026-11-01T00:00:02.100Z", 120, 100, 40, 20),
            context("gpt-b"),
            tokens("2026-11-01T00:00:03.000Z", 300, 170, 150, 10),
            // the thread's total started again lower: a request all the same
            tokens("2026-11-01T00:00:04.000Z", 50, 45, 0, 5),
        ]
        .join("\n");
        assert_eq!(
            requests(&text),
            serde_json::json!([
                ["th:120", "th", "2026-11-01T00:00:02.000Z", "gpt-a", 60, 20, 40, 3],
                ["th:300", "th", "2026-11-01T00:00:03.000Z", "gpt-b", 20, 10, 150, 3],
                ["th:50", "th", "2026-11-01T00:00:04.000Z", "gpt-b", 45, 5, 0, 3],
            ])
        );
    }

    fn record(thread: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-11-02T00:00:04.000Z","type":"token_usage_record","payload":{{"thread_id":"{thread}","response_id":"r"}}}}"#
        )
    }

    #[test]
    fn a_fork_counts_its_own_requests_and_not_its_parents() {
        // as Codex writes a fork: its own session_meta, then its parent's, the copied lines stamped anew; a request whose
        // record names the parent is the parent's copy, one with no record (an older build's) is the thread's own
        let text = [
            meta("fork", "2026-11-02T00:00:00.000Z"),
            meta("parent", "2026-11-02T00:00:00.001Z"),
            record("parent"),
            tokens("2026-11-02T00:00:00.002Z", 500, 400, 0, 100),
            context("gpt-a"),
            record("fork"),
            tokens("2026-11-02T00:00:05.000Z", 900, 300, 0, 100),
            tokens("2026-11-02T00:00:06.000Z", 1000, 90, 0, 10),
        ]
        .join("\n");
        assert_eq!(
            requests(&text),
            serde_json::json!([
                ["fork:900", "fork", "2026-11-02T00:00:05.000Z", "gpt-a", 300, 100, 0, 3],
                ["fork:1000", "fork", "2026-11-02T00:00:06.000Z", "gpt-a", 90, 10, 0, 3],
            ])
        );
    }

    #[test]
    fn a_hosts_rollout_has_no_requests_of_its_own() {
        let host = r#"{"timestamp":"2026-11-01T00:00:00.000Z","type":"session_meta","payload":{"id":"h","originator":"mopilot_host"}}"#;
        let desktop =
            r#"{"timestamp":"2026-11-01T00:00:00.000Z","type":"session_meta","payload":{"id":"h","originator":"sage_codex_desktop"}}"#;
        let usage = tokens("2026-11-01T00:00:02.000Z", 10, 5, 0, 5);
        assert_eq!(requests(&format!("{host}\n{usage}")), serde_json::json!([]));
        assert_eq!(requests(&format!("{desktop}\n{usage}")).as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn what_cannot_be_counted_is_left_out() {
        let text = [
            // usage before any session_meta has no thread to be keyed by
            tokens("2026-11-01T00:00:01.000Z", 10, 5, 0, 5),
            r#"{"type":"session_meta","payload":{"id":"th"}}"#.into(),
            // no time, no last usage, no total, a total that is not a number, a cut-off line, a payload that is not an object
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":20},"last_token_usage":{}}}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":30}}}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{}}}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":"40"},"last_token_usage":{}}}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_tok"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":"token_count"}"#.into(),
            r#"{"type":"turn_context","payload":{"model":""}}"#.into(),
            r#"["session_meta"]"#.into(),
            r#"{"type":"session_meta"}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count"}}"#.into(),
            // counts that are not positive whole numbers count none; a time is a time with no session_meta time to be before
            r#"{"timestamp":"2026-11-01T00:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1e400},"last_token_usage":{}}}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":60},"last_token_usage":{"input_tokens":2.6,"cached_input_tokens":5,"output_tokens":-1,"cache_write_input_tokens":"9"}}}}"#.into(),
        ]
        .join("\r\n");
        assert_eq!(requests(&text), serde_json::json!([["th:60", "th", "2026-11-01T00:00:03.000Z", null, 0, 0, 5, 0]]));
    }

    #[test]
    fn a_line_that_only_mentions_usage_is_not_read_as_usage() {
        let text = [
            meta("th", "2026-11-01T00:00:00.000Z"),
            r#"{"timestamp":"2026-11-01T00:00:01.000Z","type":"response_item","payload":{"type":"message","content":"\"token_count\" \"turn_context\""}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"\"token_count\""}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:01.000Z","type":"turn_context","payload":{"turn_id":"t"}}"#.into(),
            // nor is another kind of record that has the word as a key, an event with no kind, or one whose kind is not a name
            r#"{"timestamp":"2026-11-01T00:00:01.000Z","type":"compacted","payload":{"token_count":1}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:01.000Z","type":"event_msg","payload":{"token_count":1}}"#.into(),
            r#"{"timestamp":"2026-11-01T00:00:01.000Z","type":"event_msg","payload":{"type":7,"token_count":1}}"#.into(),
        ]
        .join("\n");
        assert_eq!(requests(&text), serde_json::json!([]));
    }

    #[test]
    fn a_count_that_is_not_finite_counts_none() {
        let text = [
            meta("th", "2026-11-01T00:00:00.000Z"),
            r#"{"timestamp":"2026-11-01T00:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":5},"last_token_usage":{"input_tokens":1e400,"output_tokens":5}}}}"#.into(),
        ]
        .join("\n");
        assert_eq!(requests(&text), serde_json::json!([["th:5", "th", "2026-11-01T00:00:02.000Z", null, 0, 5, 0, 0]]));
    }

    /// A file whose read fails partway.
    struct Failing;
    impl std::io::Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("the disk went away"))
        }
    }

    #[test]
    fn a_read_that_fails_fails_the_usage() {
        let error = usage_of(&mut std::io::BufReader::new(Failing), &CancelToken::default()).expect_err("failed");
        assert_eq!(error, "read a rollout: the disk went away");
    }

    #[test]
    fn a_cancelled_read_fails() {
        let cancel = CancelToken::default();
        cancel.cancel();
        assert!(usage_of(&mut b"x\n".as_slice(), &cancel).is_err());
    }
}
