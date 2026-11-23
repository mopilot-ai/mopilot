//! What a translator says folded into a chat's turns: a turn's items,
//! its plan and how it ended. Streamed deltas are no part of it (a message read back says itself whole), and one quota status
//! goes on standing for an uninterrupted episode (shared/limitNotices.mjs).

use crate::claude::Said;
use crate::emit::{Emit, Item, TurnId};
use crate::reads::is;
use crate::turns::{Turn, Turns};
use crate::Thrown;
use jsvalue::js::truthy;
use jsvalue::value::{Object, Value};

fn is_limit(item: &Object) -> bool {
    is(item.get("type"), "statusNote") && is(item.get("kind"), "limit")
}

/// What `item`, looking back from a new limit note, says of where that note goes: `Some(Some(id))` a limit note it updates,
/// `Some(None)` that an earlier one no longer stands, and `None` that it says nothing.
pub fn is_limit_home(item: &Object) -> Option<Option<Value>> {
    if is_limit(item) {
        return Some(Some(item.get("id").cloned().unwrap_or(Value::Null)));
    }
    let kind = item.get("kind");
    let resets = if is(item.get("type"), "statusNote") {
        ["switch", "account", "model"].iter().any(|reset| is(kind, reset))
    } else {
        !is(item.get("type"), "hookPrompt") && !item.get("synthetic").is_some_and(truthy)
    };
    resets.then_some(None)
}

/// The turn and id a new limit note takes.
fn limit_home(turns: &Turns, turn: TurnId, mut item: Object) -> (TurnId, Object) {
    for held in turns.turns.iter().rev() {
        for shown in held.items().iter().rev() {
            match is_limit_home(shown.head()) {
                Some(Some(id)) => {
                    item.set("id", id);
                    return (held.id.clone(), item);
                }
                Some(None) => return (turn, item),
                None => {}
            }
        }
    }
    (turn, item)
}

fn put(turns: &mut Turns, turn: TurnId, item: Object) -> Result<(), Thrown> {
    let (turn, item) = if is_limit(&item) { limit_home(turns, turn, item) } else { (turn, item) };
    let held = turns.turn(&turn).ok_or("an item for no turn")?;
    held.put_spelled(Item::Plain(item));
    Ok(())
}

/// One thing said, folded. An item for a turn that never started fails its record, as the JS's lookup did.
pub fn apply(turns: &mut Turns, said: Said) -> Result<(), Thrown> {
    match said {
        Said::Plain(Emit::TurnStarted { id, .. }) => turns.add(id),
        Said::Plain(Emit::TurnCompleted { id, status, error, .. }) => {
            if let Some(turn) = turns.turn(&id) {
                turn.finish(Value::text(status), error);
            }
        }
        Said::Plain(Emit::Item { turn, item: Item::Plain(item), .. }) | Said::Updated { turn, item } => put(turns, turn, item)?,
        Said::Plain(Emit::Plan { turn, plan }) => {
            if let Some(turn) = turns.turn(&turn) {
                turn.extras.set("plan", Value::Object(Object::of([("explanation", Value::Null), ("steps", plan)])));
            }
        }
        _ => {}
    }
    Ok(())
}

/// The end of a turn, folded into a copy of it. What ending a turn says is its running calls and its status, so it touches
/// that turn alone.
pub fn apply_to(turn: &mut Turn, said: Said) {
    match said {
        Said::Plain(Emit::TurnCompleted { status, error, .. }) => turn.finish(Value::text(status), error),
        Said::Plain(Emit::Item { item, .. }) => turn.put_spelled(item),
        _ => {}
    }
}
