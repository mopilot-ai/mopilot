//! A Server-Sent Events reader fed bytes as they arrive, cut anywhere: it hands back the `data:` payload of each event
//! once the blank line that ends it is in, and keeps the rest.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/providers/sse.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: fed by pushes rather than an async stream, each push looks for an event's
//! end only past what the last one searched, and an event that never ends is refused past a bound.

/// The most an event may hold before the blank line that ends it.
pub const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

/// The blank lines that end an event, as the SSE spec allows them. Gemini uses `\r\n\r\n`. The CRLF form comes before
/// `\r\r` so a CRLF pair is never read as two bare CRs.
const EVENT_SEPARATORS: [&[u8]; 3] = [b"\r\n\r\n", b"\n\n", b"\r\r"];

/// The longest separator less one: how far back a push looks, for a separator its bytes complete.
const OVERLAP: usize = 3;

/// The events of one stream, read as its bytes come.
#[derive(Default)]
pub struct SseReader {
    buf: Vec<u8>,
    /// how much of `buf` has been searched without finding an event's end
    searched: usize,
}

impl SseReader {
    /// The payloads of the events `bytes` complete, in order; an error once an event outgrows [`MAX_EVENT_BYTES`].
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.buf.extend_from_slice(bytes);
        let mut payloads = Vec::new();
        while let Some((at, len)) = find_event_end(&self.buf, self.searched.saturating_sub(OVERLAP)) {
            payloads.extend(extract_data(&self.buf[..at]));
            self.buf.drain(..at + len);
            self.searched = 0;
        }
        self.searched = self.buf.len();
        if self.buf.len() > MAX_EVENT_BYTES {
            return Err(format!("the provider sent an event of over {} MiB without ending it", MAX_EVENT_BYTES >> 20));
        }
        Ok(payloads)
    }

    /// The payload of a last event the stream ended without a blank line after.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        self.searched = 0;
        extract_data(&rest)
    }
}

/// Where the first separator at or after `from` starts in `buf`, and its length.
fn find_event_end(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    (from..buf.len()).find_map(|at| EVENT_SEPARATORS.iter().find(|sep| buf[at..].starts_with(sep)).map(|sep| (at, sep.len())))
}

/// The `data:` lines of one event joined by newlines; `None` when it has none (a comment or keep-alive).
fn extract_data(event: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(event);
    let lines: Vec<&str> =
        text.lines().filter_map(|line| line.strip_prefix("data:")).map(|rest| rest.strip_prefix(' ').unwrap_or(rest)).collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(chunks: &[&[u8]]) -> Vec<String> {
        let mut reader = SseReader::default();
        let mut got: Vec<String> = chunks.iter().flat_map(|chunk| reader.push(chunk).unwrap()).collect();
        got.extend(reader.finish());
        got
    }

    #[test]
    fn splits_events_across_chunk_boundaries() {
        // the "\n\n" between the two events is split across pushes
        assert_eq!(read(&[b"data: one\n", b"\ndata: two\n\n", b"data: [DONE]\n\n"]), ["one", "two", "[DONE]"]);
    }

    #[test]
    fn splits_crlf_events_across_chunk_boundaries() {
        assert_eq!(read(&[b"data: one\r\n\r", b"\ndata: two\r\n", b"\r\ndata: [DONE]\r\n\r\n"]), ["one", "two", "[DONE]"]);
    }

    /// Two events Gemini really streamed (Nasiko's QA test PR-01), framed with Google's `\r\n\r\n`.
    const GEMINI_PR01_STREAM: &str = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"42\"}],\"role\":\"model\"},\"index\":0}],",
        "\"usageMetadata\":{\"promptTokenCount\":16,\"candidatesTokenCount\":2,\"totalTokenCount\":18},",
        "\"modelVersion\":\"gemini-3.1-flash-lite\",\"responseId\":\"OV30arqIA52v694PgqiioAY\"}\r\n\r\n",
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"\",\"thoughtSignature\":\"EnMKcQFpFH0T25PNK1yc\"}],",
        "\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],",
        "\"modelVersion\":\"gemini-3.1-flash-lite\",\"responseId\":\"OV30arqIA52v694PgqiioAY\"}\r\n\r\n",
    );

    #[test]
    fn reads_a_real_crlf_stream_cut_at_every_byte() {
        let bytes = GEMINI_PR01_STREAM.as_bytes();
        let whole = read(&[bytes]);
        assert_eq!(whole.len(), 2);
        for payload in &whole {
            serde_json::from_str::<serde_json::Value>(payload).expect("payload is JSON");
        }
        for at in 0..=bytes.len() {
            assert_eq!(read(&[&bytes[..at], &bytes[at..]]), whole, "cut at {at}");
        }
        let one_at_a_time: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(read(&one_at_a_time), whole);
    }

    #[test]
    fn comments_and_other_fields_are_skipped_and_data_lines_join() {
        assert_eq!(read(&[b": keep-alive\n\nevent: x\nid: 1\ndata:a\ndata: b\n\n"]), ["a\nb"]);
    }

    #[test]
    fn a_last_event_without_its_blank_line_is_still_read_once() {
        let mut reader = SseReader::default();
        assert_eq!(reader.push(b"data: one\n\ndata: tail").unwrap(), ["one"]);
        assert_eq!(reader.finish().as_deref(), Some("tail"));
        assert_eq!(reader.finish(), None);
    }

    #[test]
    fn finds_each_separator_kind() {
        assert_eq!(find_event_end(b"data: a\n\nrest", 0), Some((7, 2)));
        assert_eq!(find_event_end(b"data: a\r\n\r\nrest", 0), Some((7, 4)));
        assert_eq!(find_event_end(b"data: a\r\rrest", 0), Some((7, 2)));
        assert_eq!(find_event_end(b"data: a\r\n\r", 0), None);
    }

    #[test]
    fn an_event_that_never_ends_is_refused_past_its_bound() {
        let mut reader = SseReader::default();
        assert_eq!(reader.push(&vec![b'a'; MAX_EVENT_BYTES]).unwrap(), Vec::<String>::new());
        assert_eq!(reader.push(b"a").unwrap_err(), "the provider sent an event of over 16 MiB without ending it");
    }
}
