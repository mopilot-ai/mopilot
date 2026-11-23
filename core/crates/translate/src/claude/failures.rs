//! Claude assistant provenance and typed failures: authentication recovery and quota notices across automatic continuations,
//! and the turn's refusal (`ClaudeFailures` of shared/claudeItems/failures.mjs, whole). What needs the translator is told it,
//! and what would have emitted hands back the item.

use crate::claude::common::{cat, joined, text_blocks};
use crate::claude::signals::{result_errors, result_failed};
use crate::emit::TurnId;
use crate::reads::{at, is, string, text_from, text_of};
use crate::Thrown;
use jsvalue::js::{strict_equals, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

/// What the chat says when a harness refused and gave no words of its own.
pub const REFUSAL_TEXT: &str = "The harness paused this chat: its safety filters flagged the request.";

/// Whether an assistant message is the CLI's own and not the model's.
pub fn is_synthetic(message: &Value) -> bool {
    message.field("error").is_some_and(truthy) || is(at(message.field("message"), "model"), "<synthetic>")
}

/// Assistant text with its native failure provenance, shared by main-thread and sub-agent display.
pub fn assistant_text(message: &Value, id: Text, text: Text) -> Object {
    let mut item = Object::of([("type", Value::text("agentMessage")), ("id", Value::String(id)), ("text", Value::String(text))]);
    item.push("phase", Value::Null);
    item.push("memoryCitation", Value::Null);
    item.push("delivery", Value::Null);
    if is_synthetic(message) {
        item.push("synthetic", Value::Bool(true));
    }
    item
}

fn failure_text(message: &Value) -> Text {
    let text = joined(&text_blocks(at(message.field("message"), "content")), "");
    text_from(trim(text.as_bytes()))
}

fn status_note(id: Text, kind: &str, text: Text) -> Object {
    Object::of([("type", Value::text("statusNote")), ("id", Value::String(id)), ("kind", Value::text(kind)), ("text", Value::String(text))])
}

/// The turn's refusal: its note, and the frame that said it (a fallback retry retracts it).
struct Refusal {
    id: Text,
    uuid: Option<Value>,
}

/// What a message made of a turn's failures.
pub enum Taken {
    /// not a failure: the message goes on as usual
    Passed,
    /// consumed, with nothing to show
    Quiet,
    /// consumed: this note goes in the turn, and the transcript ended on it
    Note(Object),
    /// consumed: this note takes the place of the turn's refusal
    Retracted(Object),
}

#[derive(Default)]
pub struct Failures {
    pub auth: Option<Text>,
    pub limited: bool,
    sequence: u64,
    limit_text: Option<Text>,
    refusal: Option<Refusal>,
}

impl Failures {
    pub fn begin_turn(&mut self) {
        self.refusal = None;
        self.auth = None;
        self.limited = false;
        self.limit_text = None;
    }

    /// The limit note of a typed quota failure, in the turn named: the authoritative transcript decides which notice it updates.
    pub fn limit_notice(&mut self, message: &Value, turn: Option<&Value>) -> Result<Option<Object>, Thrown> {
        if !is(message.field("error"), "rate_limit") {
            return Ok(None);
        }
        let named = jsvalue::js::given(message.field("uuid")).or(jsvalue::js::given(at(message.field("message"), "id")));
        let tail = match named {
            Some(id) => text_of(Some(id))?,
            None => {
                self.sequence += 1;
                cat!(text_of(turn)?, "-", self.sequence.to_string().as_str())
            }
        };
        let text = failure_text(message);
        let text = if text.is_empty() { "Usage limit reached. Try again when the limit resets.".into() } else { text };
        Ok(Some(status_note(cat!("limit-", tail), "limit", text)))
    }

    /// A refused request leaves one note per turn, whichever of the SDK's two words for it comes first; the turn then ends as a
    /// failed one whose result repeats the refusal's words, the same as at a usage limit.
    fn refuse(&mut self, turn: &TurnId, uuid: Option<&Value>, text: Text) -> Result<Taken, Thrown> {
        if self.refusal.is_some() || !turn.as_ref().is_some_and(truthy) {
            return Ok(Taken::Quiet);
        }
        let tail = match jsvalue::js::given(uuid) {
            Some(id) => text_of(Some(id))?,
            None => {
                self.sequence += 1;
                cat!(text_of(turn.as_ref())?, "-", self.sequence.to_string().as_str())
            }
        };
        let id = cat!("refusal-", tail);
        self.refusal = Some(Refusal { id: id.clone(), uuid: uuid.cloned() });
        self.limited = true;
        self.limit_text = Some(text.clone());
        Ok(Taken::Note(status_note(id, "refusal", text)))
    }

    /// The SDK's system notices about a refusal. A refusal a fallback model retried is no refusal: its note becomes a model note.
    pub fn system(&mut self, message: &Value, turn: &TurnId) -> Result<Taken, Thrown> {
        if is(message.field("subtype"), "model_refusal_no_fallback") {
            let said = string(message.field("content")).map(|text| text_from(trim(text.as_bytes()))).filter(|text| !text.is_empty());
            return self.refuse(turn, message.field("uuid"), said.unwrap_or_else(|| REFUSAL_TEXT.into()));
        }
        if !is(message.field("subtype"), "model_refusal_fallback") || !is(message.field("direction"), "retry") {
            return Ok(Taken::Passed);
        }
        let retracted = message.field("retracted_message_uuids").and_then(Value::as_array).unwrap_or_default();
        let Some(refusal) =
            self.refusal.as_ref().filter(|refusal| retracted.iter().any(|uuid| strict_equals(Some(uuid), refusal.uuid.as_ref())))
        else {
            return Ok(Taken::Quiet);
        };
        let or = |key, other: &str| jsvalue::js::given(message.field(key)).map_or(Ok(other.into()), |value| text_of(Some(value)));
        let text = cat!(
            or("original_model", "The model")?,
            " refused the request; it was retried on ",
            or("fallback_model", "another model")?,
            "."
        );
        let id = refusal.id.clone();
        self.refusal = None;
        self.limited = false;
        self.limit_text = None;
        Ok(Taken::Retracted(status_note(id, "model", text)))
    }

    /// Consume native error replies before ordinary assistant text is translated.
    pub fn assistant(&mut self, message: &Value, turn: &TurnId) -> Result<Taken, Thrown> {
        if is(at(message.field("message"), "stop_reason"), "refusal") {
            let uuid = jsvalue::js::given(message.field("uuid")).or(at(message.field("message"), "id"));
            let text = failure_text(message);
            return self.refuse(turn, uuid, if text.is_empty() { REFUSAL_TEXT.into() } else { text });
        }
        // the login lapsed, or the provider refuses it for its organization (HTTP 403 `oauth_not_allowed_for_organization`, the CLI's `oauth_org_not_allowed`): either way the login has to change, and the turn's failure is its sentence
        if is(message.field("error"), "authentication_failed") || is(message.field("error"), "oauth_org_not_allowed") {
            let text = failure_text(message);
            self.auth = Some(if text.is_empty() { "Failed to authenticate".into() } else { text });
            return Ok(Taken::Quiet);
        }
        let Some(notice) = self.limit_notice(message, turn.as_ref())? else {
            if !is_synthetic(message) {
                self.limited = false;
                self.auth = None;
            }
            return Ok(Taken::Passed);
        };
        self.limited = true;
        self.limit_text = string(notice.get("text")).cloned();
        Ok(Taken::Note(notice))
    }

    /// A result may repeat the synthetic quota reply; every distinct diagnostic stays.
    pub fn result_error(&self, message: &Value) -> Result<Value, Thrown> {
        if is(message.field("subtype"), "success") {
            let auth = self.auth.clone().filter(|_| message.field("is_error").is_some_and(truthy));
            return Ok(auth.map_or(Value::Null, Value::String));
        }
        if !result_failed(message)? {
            return Ok(Value::Null);
        }
        let repeats = |error: &Text| self.limited && Some(text_from(trim(error.as_bytes()))) == self.limit_text;
        let errors: Vec<Text> = result_errors(message)?.into_iter().filter(|error| !repeats(error)).collect();
        let text = joined(&errors, "\n");
        if !text.is_empty() {
            return Ok(Value::String(text));
        }
        Ok(if self.limited { Value::Null } else { message.field("subtype").cloned().unwrap_or(Value::Null) })
    }
}
