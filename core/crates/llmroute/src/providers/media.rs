//! What kind of document a file part is (PDF, text, or neither), and a text document read out of its base64 bytes, for a
//! spoke that sends documents as text.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/providers/media.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: Word and Excel files are not read (Nasiko's `office` module is left out),
//! so they count as neither and a spoke refuses them by name.

use crate::ir::{DataSource, UnsupportedPart};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;

/// The most text a document may carry.
pub(crate) const TEXT_DOCUMENT_MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocumentKind {
    Pdf,
    /// Sent to the model as the text it is.
    TextLike,
    Other,
}

pub(crate) fn document_kind(media_type: &str) -> DocumentKind {
    match media_type {
        "application/pdf" => DocumentKind::Pdf,
        m if m.starts_with("text/") || matches!(m, "application/json" | "application/xml" | "application/x-yaml" | "application/yaml") => {
            DocumentKind::TextLike
        }
        _ => DocumentKind::Other,
    }
}

/// The size of the bytes `b64` encodes, from its length alone.
pub(crate) fn decoded_len(b64: &str) -> u64 {
    b64.trim_end_matches('=').len() as u64 * 3 / 4
}

/// A text document's UTF-8 text, or why the model could not read it.
fn decode_text(source: &DataSource) -> Result<String, UnsupportedPart> {
    let Some((_, data)) = source.inline() else {
        return Err(UnsupportedPart::new("a text document given by URL"));
    };
    if decoded_len(data) > TEXT_DOCUMENT_MAX_BYTES {
        return Err(UnsupportedPart::new("a text document over 1 MiB"));
    }
    let bytes = STANDARD
        .decode(data)
        .or_else(|_| STANDARD_NO_PAD.decode(data))
        .map_err(|_| UnsupportedPart::new("a text document that is not valid base64"))?;
    let text = String::from_utf8(bytes).map_err(|_| UnsupportedPart::new("a text document that is not UTF-8"))?;
    if text.is_empty() {
        return Err(UnsupportedPart::new("an empty text document"));
    }
    Ok(text)
}

/// A text document as the text the model reads: its name, then its text.
pub(crate) fn text_document(source: &DataSource, filename: Option<&str>) -> Result<String, UnsupportedPart> {
    let name = filename.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("document");
    Ok(format!("File: {name}\n\n{}", decode_text(source)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inline(media_type: &str, bytes: &[u8]) -> DataSource {
        DataSource::from_inline(media_type, &STANDARD.encode(bytes))
    }

    #[test]
    fn the_decoded_size_comes_from_the_base64_length_alone() {
        assert_eq!(decoded_len(""), 0);
        assert_eq!(decoded_len("QQ=="), 1);
        assert_eq!(decoded_len("QUI="), 2);
        assert_eq!(decoded_len("QUJD"), 3);
        assert_eq!(decoded_len("QUJDRA"), 4);
        assert_eq!(decoded_len(&STANDARD.encode(vec![0u8; 1_048_577])), 1_048_577);
    }

    #[test]
    fn documents_are_sorted_into_pdf_text_and_everything_else() {
        assert_eq!(document_kind("application/pdf"), DocumentKind::Pdf);
        for text in
            ["text/plain", "text/csv", "text/markdown", "application/json", "application/xml", "application/x-yaml", "application/yaml"]
        {
            assert_eq!(document_kind(text), DocumentKind::TextLike, "{text}");
        }
        for other in [
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/zip",
            "application/octet-stream",
        ] {
            assert_eq!(document_kind(other), DocumentKind::Other, "{other}");
        }
    }

    #[test]
    fn a_text_document_decodes_to_its_utf8_text_with_its_name() {
        assert_eq!(
            text_document(&inline("text/plain", "résumé – 東京".as_bytes()), Some("cv.txt")).unwrap(),
            "File: cv.txt\n\nrésumé – 東京"
        );
        let unpadded = DataSource::from_inline("text/plain", "aGk");
        assert_eq!(text_document(&unpadded, Some("  ")).unwrap(), "File: document\n\nhi");
        assert_eq!(text_document(&unpadded, None).unwrap(), "File: document\n\nhi");
    }

    #[test]
    fn a_text_document_the_model_could_not_read_is_named() {
        let cases = [
            (inline("text/plain", &[0xff, 0xfe]), "not UTF-8"),
            (inline("text/plain", b""), "empty"),
            (inline("text/plain", &vec![b'a'; 1_048_577]), "over 1 MiB"),
            (DataSource::from_inline("text/plain", "!!!not base64"), "not valid base64"),
            (DataSource::Url("https://example.com/a.txt".into()), "by URL"),
        ];
        for (source, expected) in cases {
            let message = text_document(&source, None).unwrap_err().into_message();
            assert!(message.contains(expected), "{message}");
        }
        assert!(decode_text(&inline("text/plain", &vec![b'a'; 1_048_576])).is_ok());
    }
}
