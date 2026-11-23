//! How an ACP prompt's end reads in the chat (shared/acpStop.mjs): the turn's status, and a short note when the reply was
//! cut off or the harness ran into its usage limit. JS's `/i` without `/u` folds ASCII only, and a non-ASCII letter never
//! folds onto an ASCII one, so the texts below are searched for in the error's bytes with ASCII lowered.

use crate::reads::{is, line_end, text_of};
use crate::Thrown;
use jsvalue::js::truthy;
use jsvalue::trim;
use jsvalue::value::{Text, Value};
use memchr::memmem::find;

const PROVIDER_NEXT_STEP: &str =
    "Try again later, pick another model, or continue on another harness; check the provider account if it keeps failing.";

/// What usage-limit and quota errors say as basic harnesses word them, past what `is_limit_text` works out itself.
const LIMIT_TEXT: [&str; 33] = [
    "usage limit",
    "quota exceeded",
    "quota exhausted",
    "quota reached",
    "quota was exceeded",
    "quota was exhausted",
    "quota was reached",
    "quota has been exceeded",
    "quota has been exhausted",
    "quota has been reached",
    "exceeded your current quota",
    "exceeded the current quota",
    "exceeded_current_quota",
    "resource_exhausted",
    "resource exhausted",
    "too many requests",
    "hit your limit",
    "hit the limit",
    "hit your usage limit",
    "hit the usage limit",
    "hit your weekly limit",
    "hit the weekly limit",
    "hit your daily limit",
    "hit the daily limit",
    "hit your monthly limit",
    "hit the monthly limit",
    "hit your session limit",
    "hit the session limit",
    "credit balance is too low",
    "insufficient credits",
    "insufficient balance",
    "insufficient quota",
    "out of credits",
];

/// `/exhausted (your|the) .*quota/`: `.` stops at a line terminator.
fn exhausted_quota(text: &[u8]) -> bool {
    ["exhausted your ", "exhausted the "].iter().any(|start| {
        let mut from = 0;
        while let Some(at) = find(&text[from..], start.as_bytes()) {
            let after = from + at + start.len();
            let end = line_end(text, after).map_or(text.len(), |(end, _)| end);
            if find(&text[after..end], b"quota").is_some() {
                return true;
            }
            from = after;
        }
        false
    })
}

fn is_word(byte: Option<&u8>) -> bool {
    byte.is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// `/rate[ -]?limit(ed| exceeded| reached)?\b/`: past "limit", or past "limited", a word ends. The longer forms need nothing
/// more, as the space that opens each already ends "limit".
fn rate_limit(text: &[u8]) -> bool {
    ["ratelimit", "rate limit", "rate-limit"].iter().any(|start| {
        let mut from = 0;
        while let Some(at) = find(&text[from..], start.as_bytes()) {
            let after = from + at + start.len();
            if !is_word(text.get(after)) || (text[after..].starts_with(b"ed") && !is_word(text.get(after + 2))) {
                return true;
            }
            from = after;
        }
        false
    })
}

/// Whether a failed prompt's error text says the harness hit its usage limit.
pub fn is_limit_error(text: Option<&Value>) -> bool {
    let Some(Value::String(text)) = text else { return false };
    let lowered = text.as_bytes().to_ascii_lowercase();
    LIMIT_TEXT.iter().any(|limit| find(&lowered, limit.as_bytes()).is_some()) || exhausted_quota(&lowered) || rate_limit(&lowered)
}

/// The note a stopped turn leaves in the chat.
#[derive(Debug, PartialEq)]
pub struct Note {
    pub kind: &'static str,
    pub text: Value,
}

/// A prompt's end as the chat shows it.
#[derive(Debug, PartialEq)]
pub struct Stop {
    pub status: &'static str,
    pub error: Value,
    pub note: Option<Note>,
}

/// `before (String(value).trim())after`.
fn around(before: &str, value: Option<&Value>, after: &str) -> Result<Value, Thrown> {
    let said = text_of(value)?;
    let mut text = Text::from(before);
    text.push_bytes(trim(said.as_bytes()));
    text.push_str(after);
    Ok(Value::String(text))
}

/// The value, if JS takes it as true.
fn truthy_value(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| truthy(value))
}

/// The note of a stop reason that ends a reply before the agent finished it.
fn cut_off(reason: &Text) -> Option<&'static str> {
    if reason.is("max_tokens") {
        return Some("The reply was cut off: the harness reached its output limit for one reply. Ask it to continue.");
    }
    if reason.is("max_turn_requests") {
        return Some("The reply was cut off: the harness reached its limit of model requests for one message. Ask it to continue.");
    }
    None
}

/// An ACP prompt's end as the chat shows it.
pub fn acp_stop(stop: Option<&Value>, error: Option<&Value>, provider: Option<&Value>) -> Result<Stop, Thrown> {
    if is(stop, "cancelled") {
        let note = match truthy_value(provider) {
            Some(provider) => {
                let after = format!("). {PROVIDER_NEXT_STEP}");
                let text = around("Stopped while the provider kept failing (", Some(provider), &after)?;
                Some(Note { kind: if is_limit_error(Some(provider)) { "limit" } else { "provider" }, text })
            }
            None => None,
        };
        return Ok(Stop { status: "interrupted", error: Value::Null, note });
    }
    let failed = !stop.is_some_and(truthy) || is(stop, "error") || is(stop, "refusal");
    if failed && is_limit_error(error) {
        let after = "). It has no other account to switch to: try again when the limit resets, or continue on another harness.";
        let text = around("The harness reached its usage limit (", error, after)?;
        return Ok(Stop { status: "failed", error: Value::Null, note: Some(Note { kind: "limit", text }) });
    }
    if is(stop, "refusal") {
        let text = truthy_value(error).cloned().unwrap_or_else(|| Value::text("The agent refused to continue"));
        return Ok(Stop { status: "failed", error: Value::Null, note: Some(Note { kind: "refusal", text }) });
    }
    let message = truthy_value(error).cloned().unwrap_or(Value::Null);
    if failed {
        return Ok(Stop { status: "failed", error: message, note: None });
    }
    let cut = cut_off(&text_of(stop)?).map(|text| Note { kind: "cutOff", text: Value::text(text) });
    Ok(Stop { status: "completed", error: message, note: cut })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reads::string;
    use jsvalue::json::parse;

    fn value(text: &str) -> Value {
        Value::text(text)
    }

    fn limit(text: &str) -> bool {
        is_limit_error(Some(&value(text)))
    }

    #[test]
    fn limit_errors_are_read_from_how_harnesses_word_them() {
        for text in [
            "You've hit the Usage Limit",
            "Quota exceeded for quota metric",
            "quota was exhausted",
            "the quota has been reached",
            "You exhausted your daily quota",
            "exhausted the monthly\tquota",
            "You exceeded your current quota",
            "exceeded_current_quota",
            "RESOURCE_EXHAUSTED",
            "resource exhausted",
            "rate limit",
            "Rate-limit exceeded",
            "RATELIMIT",
            "rate limited",
            "rate limited.",
            "rate limit exceeded",
            "rate limit reached",
            "too many requests",
            "hit your usage limit",
            "credit balance is too low",
            "insufficient balance",
            "out of credits",
        ] {
            assert!(limit(text), "{text}");
        }
        for text in [
            "",
            "disk full",
            "context window too long",
            "rate limiter",
            "rate limitedly",
            "rate limit_x",
            "exhausted your quot",
            "exhausted your\nquota",
            "exhausted your plan\nquota",
            "exhausted your plan\u{2028}quota",
            "rate\u{212a}limit",
            "\u{17f}ate limit",
        ] {
            assert!(!limit(text), "{text}");
        }
        assert!(limit("exhausted your line\nexhausted your quota"), "a later line can still say it");
        assert!(limit("rate limiter, then rate limit"), "a later mention can still say it");
        assert!(!is_limit_error(None));
        assert!(!is_limit_error(Some(&Value::Number(1.0))));
    }

    #[test]
    fn a_turn_stopped_while_its_provider_failed_says_why() {
        let stop = acp_stop(Some(&value("cancelled")), None, Some(&value(" Overloaded "))).expect("a stop");
        assert_eq!((stop.status, &stop.error), ("interrupted", &Value::Null));
        let note = stop.note.expect("a note");
        assert_eq!(note.kind, "provider");
        assert_eq!(note.text, value(&format!("Stopped while the provider kept failing (Overloaded). {PROVIDER_NEXT_STEP}")));
        let limited = acp_stop(Some(&value("cancelled")), None, Some(&value("Rate limit exceeded"))).expect("a stop");
        assert_eq!(limited.note.expect("a note").kind, "limit");
        let plain = acp_stop(Some(&value("cancelled")), Some(&value("x")), None).expect("a stop");
        assert_eq!(plain, Stop { status: "interrupted", error: Value::Null, note: None });
        let empty = acp_stop(Some(&value("cancelled")), None, Some(&value(""))).expect("a stop");
        assert_eq!(empty.note, None);
    }

    #[test]
    fn a_limit_is_a_note_and_a_refusal_too() {
        let stop = acp_stop(Some(&value("error")), Some(&value("  Quota exceeded  ")), None).expect("a stop");
        let text = "The harness reached its usage limit (Quota exceeded). It has no other account to switch to: try again when the limit resets, or continue on another harness.";
        assert_eq!(stop, Stop { status: "failed", error: Value::Null, note: Some(Note { kind: "limit", text: value(text) }) });
        let stop = acp_stop(Some(&value("refusal")), Some(&value("by policy")), None).expect("a stop");
        assert_eq!(stop.note, Some(Note { kind: "refusal", text: value("by policy") }));
        let stop = acp_stop(Some(&value("refusal")), None, None).expect("a stop");
        assert_eq!(stop.note, Some(Note { kind: "refusal", text: value("The agent refused to continue") }));
    }

    #[test]
    fn a_failure_keeps_its_message_and_a_finish_says_if_it_was_cut_off() {
        for reason in [None, Some(value("")), Some(value("error")), Some(Value::Null), Some(Value::Number(0.0))] {
            let stop = acp_stop(reason.as_ref(), Some(&value("disk full")), None).expect("a stop");
            assert_eq!(stop, Stop { status: "failed", error: value("disk full"), note: None });
        }
        assert_eq!(acp_stop(None, None, None), Ok(Stop { status: "failed", error: Value::Null, note: None }));
        let done = acp_stop(Some(&value("end_turn")), Some(&value("rate limit")), None).expect("a stop");
        assert_eq!(done, Stop { status: "completed", error: value("rate limit"), note: None });
        for (reason, says) in [("max_tokens", "output limit"), ("max_turn_requests", "model requests")] {
            let note = acp_stop(Some(&value(reason)), None, None).expect("a stop").note.expect("a note");
            assert_eq!(note.kind, "cutOff");
            assert!(string(Some(&note.text)).expect("a text").lossy().contains(says));
        }
        // String(['max_tokens']) is the reason's own spelling
        let listed = parse(r#"["max_tokens"]"#).expect("JSON");
        assert_eq!(acp_stop(Some(&listed), None, None).expect("a stop").note.expect("a note").kind, "cutOff");
    }

    #[test]
    fn what_has_no_string_throws_as_the_js_did() {
        let bad = parse(r#"{"toString":1}"#).expect("JSON");
        assert!(acp_stop(Some(&bad), None, None).is_err());
        assert!(acp_stop(Some(&value("cancelled")), None, Some(&bad)).is_err());
    }
}
