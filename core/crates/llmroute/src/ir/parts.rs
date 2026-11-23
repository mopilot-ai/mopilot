//! The hub's content-part grammar: what a message's parts are (text, image, file, audio, video) and where a part's bytes
//! live, decided once for every spoke.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/ir/parts.rs`, commit 0ed4b3d, Apache-2.0; build/THIRD_PARTY_NOTICES.md)
//! and modified: the content view and the helpers only Nasiko's other spokes read are left out.
//!
//! [`crate::ir::Message::content`] stays a raw value on purpose: that permissiveness lets a spoke forward shapes it does
//! not model. This module is a projection over it: a spoke that must translate a part matches on [`ContentPart`]'s
//! variants, and a new variant breaks every spoke at compile time until each decides what to do with it. Policy stays in
//! the spokes: this says what the caller sent, and whether a backend can carry it is that backend's rule.

use serde_json::{json, Value};

/// A part the hub understands but some spoke cannot carry: the message names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedPart {
    message: String,
}

impl UnsupportedPart {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn into_message(self) -> String {
        self.message
    }
}

const BASE64_MARKER: &str = ";base64";

/// A base64 `data:` URL split into its media type and payload; `None` when `url` is not a data URL or is malformed.
/// Callers that must tell those apart check the `data:` prefix first, as [`DataSource::from_url_field`] does.
pub fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    let at = header.len().checked_sub(BASE64_MARKER.len())?;
    header.get(at..).filter(|tail| tail.eq_ignore_ascii_case(BASE64_MARKER)).map(|_| (&header[..at], data))
}

fn normalize_media_type(declared: &str) -> String {
    declared.split(';').next().unwrap_or_default().trim().to_ascii_lowercase()
}

/// The `name=` or `filename=` parameter of a data URL's header.
fn data_url_name(url: &str) -> Option<&str> {
    let (header, _) = split_data_url(url)?;
    header.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        let value = value.trim();
        (["name", "filename"].iter().any(|k| key.trim().eq_ignore_ascii_case(k)) && !value.is_empty()).then_some(value)
    })
}

/// Where a media part's bytes live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataSource {
    /// A base64 payload carried in the request itself.
    Inline { media_type: String, data: String },
    /// An http(s) URL the provider is expected to fetch for itself.
    Url(String),
}

impl DataSource {
    pub fn from_inline(media_type: &str, data: &str) -> Self {
        Self::Inline { media_type: normalize_media_type(media_type), data: data.to_string() }
    }

    /// An OpenAI-shaped URL field (`image_url.url`, `file.file_data`) read; `field` names it in the error.
    pub fn from_url_field(url: &str, field: &str) -> Result<Self, UnsupportedPart> {
        if url.starts_with("data:") {
            let (media_type, data) = split_data_url(url).ok_or_else(|| {
                UnsupportedPart::new(format!("invalid base64 data URL in {field}: expected data:<media type>;base64,<data>"))
            })?;
            let source = Self::from_inline(media_type, data);
            if source.media_type().is_some_and(str::is_empty) {
                return Err(UnsupportedPart::new(format!("invalid base64 data URL in {field}: no media type")));
            }
            Ok(source)
        } else if url.starts_with("http://") || url.starts_with("https://") {
            Ok(Self::Url(url.to_string()))
        } else {
            Err(UnsupportedPart::new(format!("unsupported {field} format (must be http(s) or base64 data URL)")))
        }
    }

    /// The canonical OpenAI URL field.
    pub fn to_url_field(&self) -> String {
        match self {
            Self::Inline { media_type, data } => format!("data:{media_type};base64,{data}"),
            Self::Url(url) => url.clone(),
        }
    }

    /// The inline bytes, or `None` for a URL.
    pub fn inline(&self) -> Option<(&str, &str)> {
        match self {
            Self::Inline { media_type, data } => Some((media_type, data)),
            Self::Url(_) => None,
        }
    }

    /// The declared media type, when the bytes are inline.
    pub fn media_type(&self) -> Option<&str> {
        self.inline().map(|(media_type, _)| media_type)
    }
}

/// One canonical content part, in the hub's (OpenAI-shaped) vocabulary. `detail` is a real OpenAI knob a passthrough
/// must round-trip, and `filename` is what OpenAI requires beside a file's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentPart {
    Text(String),
    Image {
        source: DataSource,
        detail: Option<String>,
    },
    File {
        source: DataSource,
        filename: Option<String>,
    },
    Audio {
        data: String,
        format: String,
    },
    /// OpenAI has no video part; `video_url`, mirroring `image_url`, is the convention of the OpenAI-compatible
    /// endpoints that take video.
    Video {
        source: DataSource,
    },
}

/// The string at `key` of `value`, if there is one.
fn string_at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value.and_then(|v| v.get(key)).and_then(Value::as_str)
}

impl ContentPart {
    /// One raw OpenAI content part projected into the vocabulary.
    pub fn from_openai_part(p: &Value) -> Result<Self, UnsupportedPart> {
        match p.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => Ok(Self::Text(string_at(Some(p), "text").unwrap_or_default().to_string())),
            "image_url" => {
                let image_url = p.get("image_url");
                let url = string_at(image_url, "url").ok_or_else(|| UnsupportedPart::new("image_url part missing url"))?;
                Ok(Self::Image {
                    source: DataSource::from_url_field(url, "image_url")?,
                    detail: string_at(image_url, "detail").map(str::to_string),
                })
            }
            "file" => {
                let file = p.get("file");
                if let Some(file_data) = string_at(file, "file_data") {
                    Ok(Self::File {
                        source: DataSource::from_url_field(file_data, "file_data")?,
                        filename: string_at(file, "filename").or_else(|| data_url_name(file_data)).map(str::to_string),
                    })
                } else if file.and_then(|v| v.get("file_id")).is_some() {
                    // a Files API id is one provider's state, and means nothing to another
                    Err(UnsupportedPart::new("unsupported content part type: 'file.file_id'"))
                } else {
                    Err(UnsupportedPart::new("file part missing file_data"))
                }
            }
            "input_audio" => {
                let audio = p.get("input_audio").ok_or_else(|| UnsupportedPart::new("input_audio part missing data"))?;
                let data = string_at(Some(audio), "data").ok_or_else(|| UnsupportedPart::new("input_audio missing base64 data"))?;
                // OpenAI's default format
                Ok(Self::Audio { data: data.to_string(), format: string_at(Some(audio), "format").unwrap_or("wav").to_string() })
            }
            "video_url" => {
                let url = string_at(p.get("video_url"), "url").ok_or_else(|| UnsupportedPart::new("video_url part missing url"))?;
                Ok(Self::Video { source: DataSource::from_url_field(url, "video_url")? })
            }
            other => Err(UnsupportedPart::new(format!("unsupported content part type: '{other}'"))),
        }
    }

    /// The raw OpenAI content part.
    pub fn to_openai_part(&self) -> Value {
        match self {
            Self::Text(text) => json!({ "type": "text", "text": text }),
            Self::Image { source, detail } => {
                let mut image_url = json!({ "url": source.to_url_field() });
                if let Some(detail) = detail {
                    image_url["detail"] = json!(detail);
                }
                json!({ "type": "image_url", "image_url": image_url })
            }
            Self::File { source, filename } => json!({
                "type": "file",
                "file": { "file_data": source.to_url_field(), "filename": openai_filename(source, filename.as_deref()) },
            }),
            Self::Audio { data, format } => json!({ "type": "input_audio", "input_audio": { "data": data, "format": format } }),
            Self::Video { source } => json!({ "type": "video_url", "video_url": { "url": source.to_url_field() } }),
        }
    }
}

/// The `file.filename` an OpenAI file part must carry. OpenAI takes a file part as `file_id` or as `file_data` with a
/// `filename`, and refuses one that is neither by naming the first, so a translated document without a name (an
/// Anthropic `document` without a `title`) gets one made from its media type.
pub(crate) fn openai_filename(source: &DataSource, filename: Option<&str>) -> String {
    if let Some(name) = filename.map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    match source.media_type().and_then(file_extension) {
        Some(ext) => format!("document.{ext}"),
        // a name without an extension still beats none: the provider can refuse the part on its media type's merits
        None => "document".to_string(),
    }
}

/// The extension of a document format a backend takes; `None` rather than a guess for anything else, since a wrong
/// extension reads as a real file type.
fn file_extension(media_type: &str) -> Option<&'static str> {
    match media_type.split(';').next().unwrap_or_default().trim() {
        "application/pdf" => Some("pdf"),
        "application/json" => Some("json"),
        "application/msword" => Some("doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.ms-excel" => Some("xls"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "text/plain" => Some("txt"),
        "text/markdown" => Some("md"),
        "text/csv" => Some("csv"),
        "text/html" => Some("html"),
        _ => None,
    }
}
