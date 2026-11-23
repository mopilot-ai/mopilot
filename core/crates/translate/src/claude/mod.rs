//! Claude Code's SDK messages translated into a thread's turns and items, live and when a transcript is read back
//! (electron/harness/items/claudeTranslator.cjs only calls this). `translator` is the state a native session keeps, held by id,
//! and `fold` what a read makes of what it says. The CLI's messages reach this as JSON, `JSON.stringify` of the SDK's objects
//! live and of `getSessionMessages`' when read, so nothing here assumes their shape: what the JS threw on is a `Result`'s
//! `Err`, with what the message said so far still going out.

pub mod agent_runs;
pub mod agent_transcript;
pub mod common;
pub mod failures;
pub mod fold;
pub mod history;
pub mod messages;
pub mod patterns;
pub mod replay;
pub mod routes;
pub mod signals;
pub mod tasks;
pub mod todos;
pub mod tools;
pub mod translator;
pub mod user_messages;

#[cfg(test)]
mod parity;

#[cfg(test)]
mod scenarios;

#[cfg(test)]
mod parse_cases;

#[cfg(test)]
mod run_cases;

use crate::emit::{write_emit, Emit, TurnId};
use agent_transcript::Written;
use jsvalue::json::{write, write_object, write_text, Numbers};
use jsvalue::value::{Object, Text, Value};
use std::sync::Arc;

/// What a translator says: what any translator says, and what only this one does.
#[derive(Debug, PartialEq)]
pub enum Said {
    Plain(Emit),
    /// `item/updated`
    Updated {
        turn: TurnId,
        item: Object,
    },
    /// `thread/tokenUsage/updated`
    Usage(Object),
    /// `error`, which the thread shows as its retry banner
    Retry {
        turn: TurnId,
        message: Text,
    },
    /// `agent/items`: a sub-agent's transcript so far
    Children {
        key: Option<Value>,
        items: Vec<Arc<Written>>,
    },
}

fn head(out: &mut Vec<u8>, method: &str, thread: &Value) {
    out.extend_from_slice(br#"[""#);
    out.extend_from_slice(method.as_bytes());
    out.extend_from_slice(br#"",{"threadId":"#);
    write(out, thread, Numbers::Stringified);
}

fn turn_of(out: &mut Vec<u8>, turn: &TurnId) {
    if let Some(turn) = turn {
        out.extend_from_slice(br#","turnId":"#);
        write(out, turn, Numbers::Stringified);
    }
}

/// `said` as `[method, params]`. A sub-agent's transcript goes in `tail`, and `itemsAt` says where: it is the whole of a long
/// transcript for every message, and main hands it to the window, which alone parses it.
pub fn write_said(out: &mut Vec<u8>, tail: &mut Vec<u8>, thread: &Value, said: &Said) {
    match said {
        Said::Plain(emit) => return write_emit(out, thread, emit),
        Said::Updated { turn, item } => {
            head(out, "item/updated", thread);
            turn_of(out, turn);
            out.extend_from_slice(br#","item":"#);
            write_object(out, item, Numbers::Stringified);
        }
        Said::Usage(usage) => {
            head(out, "thread/tokenUsage/updated", thread);
            out.extend_from_slice(br#","tokenUsage":"#);
            write_object(out, usage, Numbers::Stringified);
        }
        Said::Retry { turn, message } => {
            head(out, "error", thread);
            turn_of(out, turn);
            out.extend_from_slice(br#","willRetry":true,"error":{"message":"#);
            write_text(out, message);
            out.push(b'}');
        }
        Said::Children { key, items } => {
            head(out, "agent/items", thread);
            if let Some(key) = key {
                out.extend_from_slice(br#","agentKey":"#);
                write(out, key, Numbers::Stringified);
            }
            let from = tail.len();
            tail.push(b'[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    tail.push(b',');
                }
                tail.extend_from_slice(&item.json);
            }
            tail.push(b']');
            out.extend_from_slice(format!(r#","itemsAt":[{from},{}]"#, tail.len()).as_bytes());
        }
    }
    out.extend_from_slice(b"}]");
}
