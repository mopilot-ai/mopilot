//! The llmroute routes as the addon calls them: their framing, a stream translator's life, and each refusal.

use dispatch::dispatch;
use serde_json::{json, Value};

const CONFIG: &str = r#"{"inbound":"anthropic","config":{"provider":"openai","model":"gpt-4o-mini"}}"#;

fn framed(header: &str, body: &[u8]) -> Vec<u8> {
    [header.as_bytes(), b"\n", body].concat()
}

fn text(reply: Vec<u8>) -> String {
    String::from_utf8(reply).unwrap()
}

#[test]
fn a_request_comes_back_as_a_header_line_and_the_providers_body() {
    let body = br#"{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}"#;
    let reply = text(dispatch("llmroute.translateRequest", &framed(CONFIG, body)).unwrap());
    let (header, sent) = reply.split_once('\n').unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(header).unwrap(),
        json!({ "path": "/chat/completions", "headers": { "content-type": "application/json", "accept": "application/json" },
            "stream": false, "model": "gpt-4o-mini" })
    );
    assert_eq!(sent, r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":false,"max_completion_tokens":64}"#);
    let streamed = br#"{"messages":[],"stream":true}"#;
    let header = text(dispatch("llmroute.translateRequest", &framed(CONFIG, streamed)).unwrap());
    assert!(header.starts_with(
        r#"{"path":"/chat/completions","headers":{"content-type":"application/json","accept":"text/event-stream"},"stream":true"#
    ));
}

#[test]
fn a_whole_reply_comes_back_as_the_callers() {
    let reply = br#"{"id":"chatcmpl-9","model":"gpt-4o-mini-2024-07-18","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}"#;
    assert_eq!(
        text(dispatch("llmroute.translateResponse", &framed(CONFIG, reply)).unwrap()),
        concat!(
            r#"{"id":"msg_9","type":"message","role":"assistant","model":"gpt-4o-mini-2024-07-18","content":[{"type":"text","text":"ok"}],"#,
            r#""stop_reason":"max_tokens","stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}"#
        )
    );
}

#[test]
fn a_stream_translator_opens_takes_pushes_finishes_once_and_closes() {
    let id = text(dispatch("llmroute.streamOpen", CONFIG.as_bytes()).unwrap());
    let push = |bytes: &[u8]| text(dispatch("llmroute.streamPush", &framed(&id, bytes)).unwrap());
    assert_eq!(push(b"data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n"), "", "nothing until the event ends");
    assert!(push(b"\n").contains("\"text\":\"Hi\""));
    assert_eq!(push(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"), "");
    let end = text(dispatch("llmroute.streamFinish", id.as_bytes()).unwrap());
    assert!(end.contains("event: message_delta"), "{end}");
    assert!(end.ends_with("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"), "{end}");
    assert_eq!(dispatch("llmroute.streamFinish", id.as_bytes()).unwrap_err(), format!("no stream translator {id}"));
    assert_eq!(text(dispatch("llmroute.streamClose", id.as_bytes()).unwrap()), "false");
    let abandoned = dispatch("llmroute.streamOpen", CONFIG.as_bytes()).unwrap();
    assert_eq!(text(dispatch("llmroute.streamClose", &abandoned).unwrap()), "true");
}

#[test]
fn a_push_that_fails_says_why_and_leaves_the_translator_to_close() {
    let id = text(dispatch("llmroute.streamOpen", CONFIG.as_bytes()).unwrap());
    let endless = vec![b'a'; providers_max() + 1];
    assert!(dispatch("llmroute.streamPush", &framed(&id, &endless)).unwrap_err().contains("without ending it"));
    assert_eq!(text(dispatch("llmroute.streamClose", id.as_bytes()).unwrap()), "true");
}

fn providers_max() -> usize {
    crate::providers::sse::MAX_EVENT_BYTES
}

#[test]
fn each_route_refuses_what_it_cannot_read_by_name() {
    let refusal = |route: &str, payload: &[u8]| dispatch(route, payload).unwrap_err();
    assert_eq!(refusal("llmroute.translateRequest", b"not json\n{}"), "llmroute.translateRequest takes a line of JSON first");
    assert_eq!(refusal("llmroute.translateResponse", b"[1]"), "no inbound wire '' (the router reads: anthropic)");
    assert_eq!(
        refusal("llmroute.streamOpen", br#"{"inbound":"anthropic"}"#),
        "invalid routing config: invalid type: null, expected struct Config"
    );
    assert!(refusal("llmroute.translateRequest", &framed(CONFIG, b"{")).starts_with("the request body is not JSON"));
    assert!(refusal("llmroute.translateRequest", CONFIG.as_bytes()).starts_with("the request body is not JSON"));
    assert!(refusal("llmroute.translateRequest", &framed(CONFIG, br#"{"messages":[{"role":"user","content":[{"type":"hologram"}]}]}"#))
        .contains("'hologram'"));
    let refuses_urls = framed(
        CONFIG,
        br#"{"messages":[{"role":"user","content":[{"type":"document","source":{"type":"url","url":"https://e.com/a.pdf"}}]}]}"#,
    );
    assert!(refusal("llmroute.translateRequest", &refuses_urls).contains("a document given by URL"));
    assert!(refusal("llmroute.translateResponse", &framed(CONFIG, b"oops")).starts_with("the provider's reply is not a chat completion"));
    assert_eq!(refusal("llmroute.streamPush", b"x\ndata"), "llmroute.streamPush takes an id");
    assert_eq!(refusal("llmroute.streamPush", &[0xff, b'\n']), "llmroute.streamPush takes an id");
    assert_eq!(refusal("llmroute.streamFinish", b""), "llmroute.streamFinish takes an id");
    assert_eq!(refusal("llmroute.streamClose", b"-1"), "llmroute.streamClose takes an id");
    assert_eq!(refusal("llmroute.streamPush", b"999999\n"), "no stream translator 999999");
}
