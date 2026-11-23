//! Reads of whole transcripts for one answer, off the JS thread: whether a term is in a Claude Code transcript, which of its
//! user messages can be rewound to, and which recordings a chat's transcript names.

use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashSet};
use std::fmt;
use std::fs::File;
use std::io::{self, Read};

/// The first `limit` bytes of a file.
pub fn head(file: &str, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(file)?.take(limit).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Whether `text` holds `needle` (lowercase), however it is cased.
pub fn contains(text: &str, needle: &str) -> bool {
    text.to_lowercase().contains(needle)
}

/// A recording's file name: 36 characters of a uuid and this.
const WAV: &[u8] = b".wav";
const UUID_LENGTH: usize = 36;

/// Adds every recording's file name in `bytes`. Names are ASCII and JSON.stringify leaves them as they are, so they are found
/// without parsing, wherever they stand. A name in a chat's text is kept as if referenced: a recording is only ever kept too long.
pub fn audio_names(bytes: &[u8], names: &mut BTreeSet<String>) {
    for (at, _) in bytes.windows(WAV.len()).enumerate().filter(|(_, window)| *window == WAV) {
        let Some(start) = at.checked_sub(UUID_LENGTH) else { continue };
        if bytes[start..at].iter().all(|byte| matches!(byte, b'a'..=b'f' | b'0'..=b'9' | b'-')) {
            names.insert(String::from_utf8_lossy(&bytes[start..at + WAV.len()]).into_owned());
        }
    }
}

/// The fields of a record a checkpoint reads. A repeated field keeps its last value and any other is skipped unread, as a line
/// holding text JSON.parse takes and serde_json's Value doesn't (a lone surrogate) still counts.
#[derive(Default)]
struct Record {
    kind: Option<Value>,
    message_id: Option<Value>,
    snapshot_update: Option<Value>,
    uuid: Option<Value>,
    parent: Option<Value>,
}

impl<'de> Deserialize<'de> for Record {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Record;
            fn expecting(&self, out: &mut fmt::Formatter) -> fmt::Result {
                out.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Record, A::Error> {
                let mut record = Record::default();
                while let Some(key) = map.next_key::<String>()? {
                    let field = match key.as_str() {
                        "type" => &mut record.kind,
                        "messageId" => &mut record.message_id,
                        "isSnapshotUpdate" => &mut record.snapshot_update,
                        "uuid" => &mut record.uuid,
                        "parentUuid" => &mut record.parent,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                            continue;
                        }
                    };
                    *field = Some(map.next_value()?);
                }
                Ok(record)
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

/// Whether JavaScript would call a JSON value true.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Whether a line can be a checkpoint's record. Most of a long transcript is replies and tool output, which isn't. A `\u`
/// escape can spell any of these words, so a line with one is always read.
fn may_matter(line: &str) -> bool {
    line.contains("file-history-snapshot") || line.contains("\"user\"") || line.contains("\\u")
}

/// The user messages a session can rewind to, each with what it follows: those with a file-history snapshot (sessions run with
/// checkpointing; older chats have none). The first message follows nothing (null).
pub fn checkpoints(text: &str) -> Map<String, Value> {
    let mut snapshots = HashSet::new();
    let mut users = Vec::new();
    for line in text.split('\n').filter(|line| may_matter(line)) {
        let Ok(record) = serde_json::from_str::<Record>(line) else { continue };
        match record.kind.as_ref().and_then(Value::as_str) {
            Some("file-history-snapshot") if !truthy(record.snapshot_update.as_ref()) => {
                if let Some(Value::String(id)) = record.message_id.filter(|id| truthy(Some(id))) {
                    snapshots.insert(id);
                }
            }
            Some("user") => {
                if let Some(Value::String(uuid)) = record.uuid {
                    users.push((uuid, record.parent.unwrap_or(Value::Null)));
                }
            }
            _ => {}
        }
    }
    users.into_iter().filter(|(uuid, _)| snapshots.contains(uuid)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(records: &[Value]) -> String {
        records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")
    }

    fn snapshot(id: &str) -> Value {
        json!({ "type": "file-history-snapshot", "messageId": id })
    }

    fn user(uuid: &str, parent: Value) -> Value {
        json!({ "type": "user", "uuid": uuid, "parentUuid": parent })
    }

    #[test]
    fn a_checkpoint_is_a_user_message_with_a_snapshot_wherever_it_stands() {
        let text = lines(&[
            user("first", Value::Null),
            snapshot("first"),
            json!({ "type": "assistant", "uuid": "a" }),
            snapshot("second"),
            user("second", json!("a")),
            user("third", json!("second")),
        ]);
        assert_eq!(Value::Object(checkpoints(&text)), json!({ "first": null, "second": "a" }));
    }

    #[test]
    fn no_snapshot_means_no_checkpoints() {
        assert!(checkpoints("").is_empty());
        assert!(checkpoints(&lines(&[user("a", Value::Null)])).is_empty());
    }

    #[test]
    fn a_snapshot_update_or_an_empty_id_is_no_checkpoint() {
        let text = lines(&[
            json!({ "type": "file-history-snapshot", "messageId": "a", "isSnapshotUpdate": true }),
            json!({ "type": "file-history-snapshot", "messageId": "", "isSnapshotUpdate": false }),
            json!({ "type": "file-history-snapshot", "messageId": 7 }),
            json!({ "type": "file-history-snapshot" }),
            json!({ "type": "file-history-snapshot", "messageId": "b", "isSnapshotUpdate": 0 }),
            user("a", Value::Null),
            user("", Value::Null),
            user("b", json!(null)),
            json!({ "type": "user", "uuid": 7 }),
        ]);
        assert_eq!(Value::Object(checkpoints(&text)), json!({ "b": null }));
    }

    #[test]
    fn what_truthy_means() {
        for value in [json!(true), json!(1), json!(-0.5), json!("x"), json!([]), json!({})] {
            assert!(truthy(Some(&value)), "{value}");
        }
        for value in [json!(false), json!(0), json!(0.0), json!(""), Value::Null] {
            assert!(!truthy(Some(&value)), "{value}");
        }
        assert!(!truthy(None));
    }

    #[test]
    fn the_last_of_a_repeated_field_counts_and_the_last_user_record_wins() {
        let text = concat!(
            "{\"type\":\"file-history-snapshot\",\"messageId\":\"x\",\"messageId\":\"p\"}\n",
            "{\"type\":\"assistant\",\"type\":\"user\",\"uuid\":\"p\",\"parentUuid\":\"one\"}\n",
            "{\"type\":\"user\",\"uuid\":\"p\",\"parentUuid\":\"two\"}\n",
        );
        assert_eq!(Value::Object(checkpoints(text)), json!({ "p": "two" }));
    }

    #[test]
    fn a_field_spelled_with_escapes_is_read_and_torn_lines_are_skipped() {
        let text = concat!(
            "{\"type\":\"file-history-\\u0073napshot\",\"messageId\":\"p\"}\n",
            "{\"\\u0074ype\":\"\\u0075ser\",\"uuid\":\"\\u0070\",\"parentUuid\":null}\r\n",
            "{\"type\":\"user\",\"uuid\":\"torn\n",
            "[\"user\"]\n",
        );
        assert_eq!(Value::Object(checkpoints(text)), json!({ "p": null }));
    }

    #[test]
    fn a_lone_surrogate_elsewhere_in_a_record_does_not_lose_it() {
        let text = concat!(
            "{\"type\":\"file-history-snapshot\",\"messageId\":\"p\"}\n",
            "{\"type\":\"user\",\"uuid\":\"p\",\"parentUuid\":null,\"message\":{\"content\":\"\\ud83d\"}}\n",
        );
        assert_eq!(Value::Object(checkpoints(text)), json!({ "p": null }));
    }

    #[test]
    fn a_line_with_no_word_of_interest_is_not_read() {
        assert!(!may_matter("{\"type\":\"assistant\",\"text\":\"a user\"}"));
        assert!(may_matter("{\"type\":\"user\"}"));
        assert!(may_matter("{\"type\":\"file-history-snapshot\"}"));
        assert!(may_matter("{\"\\u0074ype\":1}"));
    }

    #[test]
    fn a_term_is_found_however_it_is_cased() {
        assert!(contains("Hello WORLD \u{212a}elvin \u{130}x", "hello world"));
        assert!(contains("Hello WORLD \u{212a}elvin \u{130}x", "kelvin"));
        assert!(contains("Hello WORLD \u{212a}elvin \u{130}x", "i\u{307}x"));
        assert!(!contains("Hello", "absent"));
    }

    const NAME: &str = "01234567-89ab-cdef-0123-456789abcdef.wav";

    fn found(text: &str) -> Vec<String> {
        let mut names = BTreeSet::new();
        audio_names(text.as_bytes(), &mut names);
        names.into_iter().collect()
    }

    #[test]
    fn every_recording_named_is_found_once_wherever_it_stands() {
        let other = "fedcba98-7654-3210-fedc-ba9876543210.wav";
        let text = format!("{{\"path\":\"/a/{NAME}\"}}\n{{\"path\":\"C:\\\\a\\\\{other}\"}}\nsee {NAME} too");
        assert_eq!(found(&text), [NAME, other].map(String::from));
    }

    #[test]
    fn what_is_not_a_recording_name_is_left() {
        assert!(found("").is_empty());
        assert!(found("short.wav .wav").is_empty());
        assert!(found(&NAME.to_uppercase().replace(".WAV", ".wav")).is_empty());
        assert!(found("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.wav").is_empty());
    }

    #[test]
    fn a_name_at_the_very_start_or_end_of_the_bytes_counts() {
        assert_eq!(found(NAME), [NAME.to_string()]);
    }

    #[test]
    fn head_reads_at_most_the_limit_and_says_when_there_is_no_file() {
        let dir = std::env::temp_dir().join(format!("transcript-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.jsonl");
        std::fs::write(&file, "abcdef").unwrap();
        let name = file.to_str().unwrap();
        assert_eq!(head(name, 4).unwrap(), b"abcd");
        assert_eq!(head(name, 100).unwrap(), b"abcdef");
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(head(name, 4).unwrap_err().kind(), io::ErrorKind::NotFound);
    }
}
