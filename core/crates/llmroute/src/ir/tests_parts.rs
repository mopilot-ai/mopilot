//! The content-part grammar's rules: data URLs, sources, each part kind's round trip and its refusals.
//!
//! Ported from the tests of Nasiko's llm-router (`llm-router/src/ir/parts.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: the content-view cases are left out with the code they tested, and every
//! document extension and refusal is named.

use super::parts::*;
use super::parts_to_content_value;
use serde_json::json;

#[test]
fn data_url_round_trips_through_the_source() {
    let source = DataSource::from_url_field("data:image/png;base64,AAAA", "image_url").unwrap();
    assert_eq!(source, DataSource::Inline { media_type: "image/png".into(), data: "AAAA".into() });
    assert_eq!(source.inline(), Some(("image/png", "AAAA")));
    assert_eq!(source.to_url_field(), "data:image/png;base64,AAAA");
}

#[test]
fn web_url_stays_a_url_and_reports_no_inline_bytes() {
    for url in ["https://example.com/cat.png", "http://example.com/cat.png"] {
        let source = DataSource::from_url_field(url, "image_url").unwrap();
        assert_eq!(source, DataSource::Url(url.into()));
        assert_eq!((source.inline(), source.media_type()), (None, None));
        assert_eq!(source.to_url_field(), url);
    }
}

#[test]
fn a_data_url_media_type_is_lowercased_and_stripped_of_parameters() {
    for url in [
        "data:Image/PNG;base64,AAAA",
        "data: image/png ;base64,AAAA",
        "data:image/png;charset=binary;base64,AAAA",
        "data:image/png;BASE64,AAAA",
    ] {
        let source = DataSource::from_url_field(url, "image_url").unwrap();
        assert_eq!(source.inline(), Some(("image/png", "AAAA")), "{url}");
        assert_eq!(source.to_url_field(), "data:image/png;base64,AAAA", "{url}");
    }
}

#[test]
fn a_data_url_name_parameter_becomes_the_filename_unless_one_is_given() {
    // the name a file part carries, as its rendered OpenAI part names it
    let named = |file_data: &str, filename: Option<&str>| {
        let mut file = json!({ "file_data": file_data });
        if let Some(name) = filename {
            file["filename"] = json!(name);
        }
        let part = ContentPart::from_openai_part(&json!({ "type": "file", "file": file })).unwrap();
        part.to_openai_part()["file"]["filename"].as_str().unwrap().to_string()
    };
    assert_eq!(named("data:application/pdf;name=q3.pdf;base64,AAAA", None), "q3.pdf");
    assert_eq!(named("data:application/pdf;name=q3.pdf;base64,AAAA", Some("report.pdf")), "report.pdf");
    // none of these is a name, so the media type gives one
    for unnamed in [
        "data:application/pdf;name=;other=x;base64,AAAA",
        "data:application/pdf;title=q3.pdf;base64,AAAA",
        "data:application/pdf;charset;base64,AAAA",
    ] {
        assert_eq!(named(unnamed, None), "document.pdf", "{unnamed}");
    }
    assert_eq!(named("https://e.com/q3.pdf", None), "document");
}

#[test]
fn a_data_url_that_is_not_base64_or_has_no_media_type_is_refused_by_name() {
    let not_base64 = DataSource::from_url_field("data:text/plain,hello", "file_data").unwrap_err();
    let no_type = DataSource::from_url_field("data:;base64,AAAA", "image_url").unwrap_err();
    assert!(not_base64.message().contains("expected data:<media type>;base64,<data>"), "{not_base64:?}");
    assert!(no_type.message().contains("no media type"), "{no_type:?}");
}

#[test]
fn a_data_url_header_with_multibyte_characters_or_no_comma_is_refused_without_panicking() {
    for url in ["data:éx23456,AAAA", "data:é,AAAA", "data:,AAAA", "data:image/png;base64"] {
        assert!(DataSource::from_url_field(url, "image_url").is_err(), "{url}");
    }
    assert_eq!(split_data_url("https://e.com/c.png"), None);
}

#[test]
fn malformed_and_unknown_schemes_are_distinguishable() {
    let broken = DataSource::from_url_field("data:image/png,AAAA", "image_url").unwrap_err();
    assert!(broken.message().contains("invalid base64 data URL"));
    let scheme = DataSource::from_url_field("ftp://example.com/x.png", "image_url").unwrap_err();
    assert_eq!(scheme.into_message(), "unsupported image_url format (must be http(s) or base64 data URL)");
}

#[test]
fn every_part_kind_survives_a_hub_round_trip() {
    for raw in [
        json!({ "type": "text", "text": "hi" }),
        json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }),
        json!({ "type": "image_url", "image_url": { "url": "https://e.com/c.png", "detail": "low" } }),
        json!({ "type": "file", "file": { "file_data": "data:application/pdf;base64,JVBE", "filename": "q3.pdf" } }),
        json!({ "type": "input_audio", "input_audio": { "data": "UklG", "format": "wav" } }),
        json!({ "type": "video_url", "video_url": { "url": "data:video/mp4;base64,AAAA" } }),
        json!({ "type": "video_url", "video_url": { "url": "https://e.com/v.mp4" } }),
    ] {
        let part = ContentPart::from_openai_part(&raw).unwrap();
        assert_eq!(part.to_openai_part(), raw, "round trip lost data for {raw}");
    }
}

#[test]
fn a_text_part_without_text_is_empty_and_audio_format_defaults_to_wav() {
    assert_eq!(ContentPart::from_openai_part(&json!({ "type": "text" })).unwrap(), ContentPart::Text(String::new()));
    let audio = ContentPart::from_openai_part(&json!({ "type": "input_audio", "input_audio": { "data": "UklG" } })).unwrap();
    assert_eq!(audio, ContentPart::Audio { data: "UklG".into(), format: "wav".into() });
}

#[test]
fn a_nameless_file_still_renders_a_filename_openai_will_accept() {
    let part =
        ContentPart::File { source: DataSource::Inline { media_type: "application/pdf".into(), data: "JVBE".into() }, filename: None };
    assert_eq!(
        part.to_openai_part(),
        json!({ "type": "file", "file": { "file_data": "data:application/pdf;base64,JVBE", "filename": "document.pdf" } })
    );
}

#[test]
fn a_synthesized_filename_takes_the_media_types_extension() {
    let named = |media_type: &str, filename: Option<&str>| {
        openai_filename(&DataSource::Inline { media_type: media_type.into(), data: "AAAA".into() }, filename)
    };
    for (media_type, ext) in [
        ("application/pdf", "pdf"),
        ("application/json", "json"),
        ("application/msword", "doc"),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
        ("application/vnd.ms-excel", "xls"),
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
        ("text/plain; charset=utf-8", "txt"),
        ("text/markdown", "md"),
        ("text/csv", "csv"),
        ("text/html", "html"),
    ] {
        assert_eq!(named(media_type, None), format!("document.{ext}"));
    }
    // an unknown media type gets no guessed extension, and a URL has no media type to read
    assert_eq!(named("application/x-tar", None), "document");
    assert_eq!(openai_filename(&DataSource::Url("https://e.com/q3.pdf".into()), None), "document");
    // a real name wins; a blank one is no name
    assert_eq!(named("application/pdf", Some("q3.pdf")), "q3.pdf");
    assert_eq!(named("application/pdf", Some("  ")), "document.pdf");
}

#[test]
fn file_id_missing_fields_and_unknown_types_are_refused_by_name() {
    for (part, named) in [
        (json!({ "type": "file", "file": { "file_id": "f-1" } }), "file.file_id"),
        (json!({ "type": "file", "file": {} }), "missing file_data"),
        (json!({ "type": "file" }), "missing file_data"),
        (json!({ "type": "image_url", "image_url": {} }), "image_url part missing url"),
        (json!({ "type": "input_audio" }), "input_audio part missing data"),
        (json!({ "type": "input_audio", "input_audio": {} }), "input_audio missing base64 data"),
        (json!({ "type": "video_url" }), "video_url part missing url"),
        (json!({ "type": "unknown_future" }), "unknown_future"),
        (json!({ "type": "image_url", "image_url": { "url": "data:image/png,AAAA" } }), "invalid base64 data URL in image_url"),
        (json!({ "type": "file", "file": { "file_data": "ftp://x" } }), "unsupported file_data format"),
        (json!({ "type": "video_url", "video_url": { "url": "ftp://x" } }), "unsupported video_url format"),
    ] {
        let refused = ContentPart::from_openai_part(&part).unwrap_err();
        assert!(refused.message().contains(named), "{} should name {named}", refused.message());
    }
}

#[test]
fn parts_collapse_to_a_bare_string_only_when_a_lone_text_part() {
    assert_eq!(parts_to_content_value(&[ContentPart::Text("hi".into())]), json!("hi"));
    let two = parts_to_content_value(&[ContentPart::Text("hi".into()), ContentPart::Text("there".into())]);
    assert_eq!(two.as_array().unwrap().len(), 2);
    let image = parts_to_content_value(&[ContentPart::Image { source: DataSource::Url("https://e.com/c.png".into()), detail: None }]);
    assert_eq!(image.as_array().unwrap().len(), 1);
    assert_eq!(parts_to_content_value(&[]), json!([]));
}
