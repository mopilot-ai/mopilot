//! A Claude Code turn routed to an OpenAI model end to end through the routes, against fixtures (`fixtures/`): the
//! request it sends and the event stream Claude Code hears, byte for byte, however the provider's bytes are cut.
//!
//! In the spirit of Nasiko's REQUEST_JOURNEY fixtures (https://github.com/Nasiko-Labs/nasiko, commit 0ed4b3d,
//! Apache-2.0; build/THIRD_PARTY_NOTICES.md): a request with thinking, cache markers, tool calls, a tool result's image
//! and a PDF, and a streamed reply with text, a tool call, a keep-alive and OpenAI's cached-token usage.

use dispatch::dispatch;
use serde_json::Value;

const CONFIG: &str = r#"{"inbound":"anthropic","config":{"provider":"openai","model":"gpt-4o-mini","cacheKey":"chat-1f3c"}}"#;
const REQUEST: &[u8] = include_bytes!("../fixtures/claude-request.json");
const SENT: &[u8] = include_bytes!("../fixtures/openai-request.json");
const STREAM: &[u8] = include_bytes!("../fixtures/openai-stream.sse");
/// The file holds the events less the newline the last one ends with, as files keep no blank line at their end.
const HEARD_FILE: &[u8] = include_bytes!("../fixtures/anthropic-stream.sse");

fn translated(request: &[u8]) -> Vec<u8> {
    let reply = dispatch("llmroute.translateRequest", &[CONFIG.as_bytes(), b"\n", request].concat()).unwrap();
    let at = reply.iter().position(|byte| *byte == b'\n').unwrap();
    reply[at + 1..].to_vec()
}

/// What Claude Code hears for the provider's stream pushed in `pieces`.
fn heard(pieces: &[&[u8]]) -> Vec<u8> {
    let id = String::from_utf8(dispatch("llmroute.streamOpen", CONFIG.as_bytes()).unwrap()).unwrap();
    let mut out: Vec<u8> = Vec::new();
    for piece in pieces {
        out.extend(dispatch("llmroute.streamPush", &[id.as_bytes(), b"\n", piece].concat()).unwrap());
    }
    out.extend(dispatch("llmroute.streamFinish", id.as_bytes()).unwrap());
    out
}

#[test]
fn the_request_reaches_openai_as_the_fixture_byte_for_byte_every_time() {
    let sent = translated(REQUEST);
    assert_eq!(String::from_utf8_lossy(&sent), String::from_utf8_lossy(SENT));
    // a second session translating the same turn sends the same prefix, so the provider's cache keeps hitting (B8)
    assert_eq!(translated(REQUEST), sent);
    let body: Value = serde_json::from_slice(&sent).unwrap();
    let text = body.to_string();
    for gone in ["thinking", "I should look", "cache_control"] {
        assert!(!text.contains(gone), "{gone} reached OpenAI: {text}");
    }
    assert_eq!(body["messages"][3]["tool_call_id"], "toolu_01A", "the tool result answers the call by its id");
}

#[test]
fn the_stream_reaches_claude_code_as_the_fixture_however_it_is_cut() {
    let expected = [HEARD_FILE, b"\n"].concat();
    assert_eq!(String::from_utf8_lossy(&heard(&[STREAM])), String::from_utf8_lossy(&expected));
    for at in 0..=STREAM.len() {
        assert_eq!(heard(&[&STREAM[..at], &STREAM[at..]]), expected, "cut at byte {at}");
    }
    let bytes: Vec<&[u8]> = STREAM.chunks(1).collect();
    assert_eq!(heard(&bytes), expected, "one byte at a time");
}

#[test]
fn a_stream_cut_short_or_failing_part_way_ends_in_an_error_not_a_finished_reply() {
    let cut = &STREAM[..STREAM.windows(13).position(|w| w == b"\"tool_calls\"}").unwrap()];
    let heard_cut = String::from_utf8(heard(&[cut])).unwrap();
    assert!(heard_cut.ends_with(concat!(
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",",
        "\"message\":\"The provider's stream ended before its reply finished.\"}}\n\n"
    )));
    assert!(!heard_cut.contains("message_stop"));
    let failing = b"data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"error\":{\"message\":\"Overloaded\"}}\n\ndata: [DONE]\n\n";
    let heard_failing = String::from_utf8(heard(&[failing])).unwrap();
    assert!(heard_failing.ends_with("\"message\":\"The provider failed part way: Overloaded\"}}\n\n"), "{heard_failing}");
    // a last event without its blank line still counts, and a provider that sends a finish reason but no [DONE] is done
    let no_done = b"data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}";
    assert!(String::from_utf8(heard(&[no_done])).unwrap().ends_with("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
    let after_done = [STREAM, b"\ndata: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n".as_slice()].concat();
    assert_eq!(heard(&[&after_done]), [HEARD_FILE, b"\n"].concat(), "nothing the provider sends after [DONE] is heard");
    let error_last = b"data: {\"error\":{\"message\":\"gone\"}}";
    assert!(String::from_utf8(heard(&[error_last])).unwrap().ends_with("The provider failed part way: gone\"}}\n\n"));
}
