//! Each chat's live session state as main patches it (electron/session/state.cjs, docs/architecture/rust-core.md §6
//! step 4): the core owns the rules and the revision; main keeps a mirror its readers use.
//!
//! A store holds, per chat, the JSON form of every key and the revision. A patch keeps only the keys the session has
//! (and, from a window, only the keys a window may set), applies what a turn's change implies (a running turn is no
//! other app's; a finished one has no progress; a turn the user answered counts its quiet from now), and drops each
//! value that serializes as the stored one does, a goal's `updatedAt` aside. What is left bumps the revision.

pub mod routes;

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

/// One store: the shape of a chat no one has touched yet, the keys a window may set, and each chat's state.
struct Store {
    empty: Map<String, Value>,
    client: Vec<String>,
    chats: HashMap<String, (u64, Map<String, Value>)>,
    /// per chat, the queued messages that went back first in line, in the order they went back
    first: HashMap<String, Vec<Value>>,
}

fn stores() -> &'static Mutex<HashMap<u64, Store>> {
    static STORES: OnceLock<Mutex<HashMap<u64, Store>>> = OnceLock::new();
    STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Opens store `id` (anew, if it was open): `empty` is a new chat's state, `client` the keys a window may set.
pub fn open(id: u64, empty: Map<String, Value>, client: Vec<String>) {
    let store = Store { empty, client, chats: HashMap::new(), first: HashMap::new() };
    stores().lock().unwrap_or_else(PoisonError::into_inner).insert(id, store);
}

/// Closes store `id`; a store never opened is no error.
pub fn close(id: u64) {
    stores().lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
}

/// What a patch changed: the chat's new revision, the keys whose values changed, and the values the patch did not carry
/// that its turn implied (`runningElsewhere`, `progressAt`), for main to set beside its own.
#[derive(Debug, PartialEq)]
pub struct Change {
    pub rev: u64,
    pub keys: Vec<String>,
    pub implied: Map<String, Value>,
}

const RUNNING: [&str; 2] = ["running", "awaitingUser"];

/// The value as compared: its JSON text, a goal's `updatedAt` left out (the clock of whichever window saw it first).
fn comparable(key: &str, value: &Value) -> String {
    match (key, value) {
        ("goal", Value::Object(goal)) => {
            let mut goal = goal.clone();
            goal.shift_remove("updatedAt");
            Value::Object(goal).to_string()
        }
        _ => value.to_string(),
    }
}

/// The turn a patch's approvals move the chat to when the patch names none: a running turn that gets a new approval waits
/// on the user, and a waiting one whose last approval is answered runs again.
fn approvals_turn(state: &Map<String, Value>, partial: &Map<String, Value>, was: &str) -> Option<&'static str> {
    if partial.contains_key("turn") {
        return None;
    }
    let count = |v: Option<&Value>| v.and_then(Value::as_array).map_or(0, Vec::len);
    let (before, after) = (count(state.get("approvals")), count(Some(partial.get("approvals")?)));
    if after > before && RUNNING.contains(&was) {
        Some("awaitingUser")
    } else if after == 0 && was == "awaitingUser" {
        Some("running")
    } else {
        None
    }
}

/// Patches chat `chat` of store `id` with `partial` at `now` (ms epoch, as main's clock gave it). `client`: the patch comes from a window. Returns
/// what changed, or None when nothing did; an unknown store is an error.
pub fn patch(id: u64, chat: &str, partial: Map<String, Value>, now: Value, client: bool) -> Result<Option<Change>, String> {
    let mut stores = stores().lock().unwrap_or_else(PoisonError::into_inner);
    let store = stores.get_mut(&id).ok_or_else(|| format!("no session store {id}"))?;
    Ok(patch_store(store, chat, partial, now, client))
}

/// Whether a value counts as set, as JS reads it in a condition.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

/// The chat's queue as it stands when its first message can go: the turn is not running and that message waits on nothing.
fn ready_queue(state: &Map<String, Value>) -> Option<Vec<Value>> {
    let turn = state.get("turn").and_then(Value::as_str).unwrap_or("idle");
    let queue = state.get("queue").and_then(Value::as_array)?;
    let first = queue.first()?;
    (!RUNNING.contains(&turn) && !truthy(first.get("waitingFor"))).then(|| queue.clone())
}

/// Whether chat `chat`'s first queued message could go now, as far as its session says: the controller then checks what
/// only main knows (a folder change, a voice conversation, a compaction) before it drains.
pub fn drainable(id: u64, chat: &str) -> Result<bool, String> {
    let stores = stores().lock().unwrap_or_else(PoisonError::into_inner);
    let store = stores.get(&id).ok_or_else(|| format!("no session store {id}"))?;
    Ok(store.chats.get(chat).and_then(|(_, state)| ready_queue(state)).is_some())
}

/// The controller's drain (electron/session/controllerQueue.cjs): the first queued message leaves the queue to be sent when
/// it still can (`drainable`). Returns the change, or None when nothing goes.
pub fn drain(id: u64, chat: &str, now: Value) -> Result<Option<Change>, String> {
    let mut stores = stores().lock().unwrap_or_else(PoisonError::into_inner);
    let store = stores.get_mut(&id).ok_or_else(|| format!("no session store {id}"))?;
    let Some(queue) = store.chats.get(chat).and_then(|(_, state)| ready_queue(state)) else { return Ok(None) };
    let mut partial = Map::new();
    partial.insert("queue".into(), Value::Array(queue[1..].to_vec()));
    Ok(patch_store(store, chat, partial, now, false))
}

/// The state a turn's own step sets: it starts (running, under its id, whether a person started it, no crash), it ends
/// (idle), or its harness quits under it (crashed, saying why).
fn step_state(step: &str, args: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let arg = |k: &str| args.get(k).cloned().unwrap_or(Value::Null);
    let set = match step {
        "start" => {
            let human = args.get("human").and_then(Value::as_bool).unwrap_or(false);
            serde_json::json!({ "turn": "running", "activeTurn": { "id": arg("turnId"), "human": human }, "crashed": null })
        }
        "end" => serde_json::json!({ "turn": "idle", "activeTurn": null }),
        "crash" => serde_json::json!({ "turn": "crashed", "activeTurn": null, "crashed": arg("reason") }),
        _ => return Err(format!("no turn step {step}")),
    };
    Ok(set.as_object().cloned().unwrap_or_default())
}

/// Chat `chat` of store `id` takes turn step `step` (start, end, crash) with its `args`, along with `extra` keys the caller
/// sets with it (the approvals that outlive the turn, the queue a refused start keeps). The step's own values win over
/// `extra`, and come back with the change as implied, for main's mirror.
pub fn step(
    id: u64,
    chat: &str,
    step: &str,
    args: &Map<String, Value>,
    extra: Map<String, Value>,
    now: Value,
) -> Result<Option<Change>, String> {
    let set = step_state(step, args)?;
    let mut stores = stores().lock().unwrap_or_else(PoisonError::into_inner);
    let store = stores.get_mut(&id).ok_or_else(|| format!("no session store {id}"))?;
    let mut partial = extra;
    for (k, v) in &set {
        partial.insert(k.clone(), v.clone());
    }
    let Some(mut change) = patch_store(store, chat, partial, now, false) else { return Ok(None) };
    for (k, v) in set {
        if change.keys.contains(&k) {
            change.implied.insert(k, v);
        }
    }
    Ok(Some(change))
}

/// Where message `item` (its id) goes back in chat `chat`'s queue when it didn't start: behind the messages put back
/// first in line before it, so a stop that puts back a start and the steers behind it keeps the order they were sent, or
/// ahead of everything (`ahead`: the turn's own message). Returns the index; the caller inserts it there.
pub fn put_back(id: u64, chat: &str, item: Value, ahead: bool) -> Result<usize, String> {
    let mut stores = stores().lock().unwrap_or_else(PoisonError::into_inner);
    let store = stores.get_mut(&id).ok_or_else(|| format!("no session store {id}"))?;
    let queue = store.chats.get(chat).and_then(|(_, s)| s.get("queue")).and_then(Value::as_array).cloned().unwrap_or_default();
    let first = store.first.entry(chat.to_string()).or_default();
    let at = queue.iter().take_while(|q| q.get("id").is_some_and(|i| first.contains(i))).count();
    *first = queue[..at].iter().filter_map(|q| q.get("id").cloned()).chain(std::iter::once(item)).collect();
    Ok(if ahead { 0 } else { at })
}

/// "Send now" on a queued message (electron/session/controllerQueue.cjs sendNow), in two phases with chat `chat`'s session:
/// - `admit`: a message from another session (`peer`) is refused while the turn runs and waits on the user, is switching
///   harness, or its harness can't take a steer (`peer_steers`, asked for with `ask` only when the rest would refuse it);
///   else `admit`;
/// - `route`: with no turn running it `start`s one; a running one takes it as a `steer` when its harness steers (`steers`,
///   asked for with `ask`), else it goes `queueFirst`.
pub fn send_now(
    id: u64,
    chat: &str,
    phase: &str,
    peer: bool,
    peer_steers: Option<bool>,
    steers: Option<bool>,
) -> Result<&'static str, String> {
    let stores = stores().lock().unwrap_or_else(PoisonError::into_inner);
    let store = stores.get(&id).ok_or_else(|| format!("no session store {id}"))?;
    let state = store.chats.get(chat).map(|(_, s)| s);
    let turn = state.and_then(|s| s.get("turn")).and_then(Value::as_str).unwrap_or("idle");
    let busy = RUNNING.contains(&turn);
    match phase {
        "admit" if !peer || !busy => Ok("admit"),
        "admit" if turn == "awaitingUser" || truthy(state.and_then(|s| s.get("pendingSwitch"))) => Ok("refuse"),
        "admit" => Ok(match peer_steers {
            None => "ask",
            Some(true) => "admit",
            Some(false) => "refuse",
        }),
        "route" if !busy => Ok("start"),
        "route" => Ok(match steers {
            None => "ask",
            Some(true) => "steer",
            Some(false) => "queueFirst",
        }),
        _ => Err(format!("no send-now phase {phase}")),
    }
}

fn patch_store(store: &mut Store, chat: &str, partial: Map<String, Value>, now: Value, client: bool) -> Option<Change> {
    let mut partial = partial;
    if client {
        partial.retain(|k, _| store.client.iter().any(|c| c == k));
    }
    let empty = &store.empty;
    let (rev, state) = store.chats.entry(chat.to_string()).or_insert_with(|| (0, empty.clone()));
    let was = state.get("turn").and_then(Value::as_str).unwrap_or("idle").to_string();
    let mut implied = Map::new();
    if let Some(turn) = approvals_turn(state, &partial, &was) {
        partial.insert("turn".into(), Value::from(turn));
        implied.insert("turn".into(), Value::from(turn));
    }
    let turn = match partial.get("turn") {
        // as `partial.turn ?? s.turn`: null and missing keep the turn; any other value is the turn (not a running one)
        None | Some(Value::Null) => was.clone(),
        Some(Value::String(t)) => t.clone(),
        Some(_) => String::new(),
    };
    if RUNNING.contains(&turn.as_str()) {
        // a local turn owns the chat on every harness
        implied.insert("runningElsewhere".into(), Value::Bool(false));
    } else if !partial.contains_key("progressAt") {
        // a finished turn's progress is no use to the next one
        implied.insert("progressAt".into(), Value::Null);
    }
    if was == "awaitingUser" && turn == "running" && !partial.contains_key("progressAt") {
        // the user answered: the turn's quiet counts from now
        implied.insert("progressAt".into(), now);
    }
    for (k, v) in &implied {
        partial.insert(k.clone(), v.clone());
    }
    let mut keys = Vec::new();
    for (k, v) in partial {
        if k == "rev" || !state.contains_key(&k) {
            continue;
        }
        if state.get(&k).is_some_and(|old| comparable(&k, old) == comparable(&k, &v)) {
            continue;
        }
        state.insert(k.clone(), v);
        keys.push(k);
    }
    if keys.is_empty() {
        return None;
    }
    *rev += 1;
    implied.retain(|k, _| keys.contains(k));
    Some(Change { rev: *rev, keys, implied })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().cloned().expect("an object")
    }

    fn store(id: u64) {
        let empty = json!({ "rev": 0, "turn": "idle", "progressAt": null, "runningElsewhere": false, "plan": false, "goal": null, "queue": [], "pendingSwitch": null });
        open(id, obj(empty), vec!["plan".into(), "goal".into()]);
    }

    #[test]
    fn a_change_bumps_the_revision_and_an_unchanged_or_unknown_key_does_not() {
        store(1);
        let c = patch(1, "c", obj(json!({ "plan": true, "nope": 1, "rev": 9 })), json!(0), false).unwrap().unwrap();
        assert_eq!((c.rev, c.keys), (1, vec!["plan".to_string()]));
        assert_eq!(patch(1, "c", obj(json!({ "plan": true })), json!(0), false), Ok(None));
        let c = patch(1, "c", obj(json!({ "queue": [{ "a": 1, "b": 2 }] })), json!(0), false).unwrap().unwrap();
        assert_eq!(c.rev, 2);
        // key order counts, as JSON.stringify compares it
        assert_eq!(patch(1, "c", obj(json!({ "queue": [{ "b": 2, "a": 1 }] })), json!(0), false).unwrap().unwrap().rev, 3);
        assert_eq!(patch(1, "other", obj(json!({ "plan": true })), json!(0), false).unwrap().unwrap().rev, 1, "each chat counts its own");
        close(1);
        assert_eq!(patch(1, "c", Map::new(), json!(0), false), Err("no session store 1".into()));
    }

    #[test]
    fn a_window_sets_only_its_keys_and_a_goal_s_clock_is_no_change() {
        store(2);
        assert_eq!(patch(2, "c", obj(json!({ "turn": "running" })), json!(0), true), Ok(None));
        let goal = json!({ "text": "x", "updatedAt": 1 });
        assert!(patch(2, "c", obj(json!({ "goal": goal })), json!(0), true).unwrap().is_some());
        assert_eq!(patch(2, "c", obj(json!({ "goal": { "text": "x", "updatedAt": 2 } })), json!(0), true), Ok(None));
        close(2);
    }

    #[test]
    fn a_turn_s_change_implies_who_owns_the_chat_and_how_long_it_was_quiet() {
        store(3);
        let c = patch(3, "c", obj(json!({ "turn": "running", "runningElsewhere": true })), json!(5), false).unwrap().unwrap();
        assert_eq!(c.keys, vec!["turn".to_string()], "a local turn is no other app's: runningElsewhere stays false");
        let c = patch(3, "c", obj(json!({ "progressAt": 7 })), json!(5), false).unwrap().unwrap();
        assert_eq!(c.keys, vec!["progressAt".to_string()]);
        patch(3, "c", obj(json!({ "turn": "awaitingUser", "progressAt": 7 })), json!(5), false).unwrap();
        // the user answered: progress counts from now
        let c = patch(3, "c", obj(json!({ "turn": "running" })), json!(9), false).unwrap().unwrap();
        assert_eq!(c.implied, obj(json!({ "progressAt": 9 })));
        // the turn ends: no progress, a null turn leaves the turn as it was
        let c = patch(3, "c", obj(json!({ "turn": "idle" })), json!(9), false).unwrap().unwrap();
        assert_eq!((c.keys, c.implied), (vec!["turn".to_string(), "progressAt".to_string()], obj(json!({ "progressAt": null }))));
        // a turn that is no string is no running one, as in JS
        let c = patch(3, "c", obj(json!({ "turn": 5 })), json!(9), false).unwrap().unwrap();
        assert_eq!(c.keys, vec!["turn".to_string()]);
        patch(3, "c", obj(json!({ "turn": "idle" })), json!(9), false).unwrap();
        // as in JS: a null turn is the turn compared against, and is set
        assert_eq!(patch(3, "c", obj(json!({ "turn": null })), json!(9), false).unwrap().unwrap().keys, vec!["turn".to_string()]);
        close(3);
        close(3);
    }

    #[test]
    fn the_first_queued_message_goes_when_its_turn_is_not_running_and_it_waits_on_nothing() {
        store(6);
        assert_eq!((drainable(6, "c"), drain(6, "c", json!(1))), (Ok(false), Ok(None)), "a chat with no state");
        let queue = json!([{ "id": "a" }, { "id": "b", "waitingFor": "" }]);
        patch(6, "c", obj(json!({ "queue": queue, "turn": "running" })), json!(1), false).unwrap();
        assert_eq!((drainable(6, "c"), drain(6, "c", json!(1))), (Ok(false), Ok(None)), "a running turn");
        patch(6, "c", obj(json!({ "turn": "idle" })), json!(1), false).unwrap();
        assert_eq!(drainable(6, "c"), Ok(true));
        let c = drain(6, "c", json!(2)).unwrap().unwrap();
        assert_eq!((c.rev, c.keys), (3, vec!["queue".to_string()]));
        // the next one waits on nothing set ("" is unset, as in JS)
        assert!(drain(6, "c", json!(2)).unwrap().is_some());
        assert_eq!((drainable(6, "c"), drain(6, "c", json!(2))), (Ok(false), Ok(None)), "an empty queue");
        for (waiting, held) in
            [(json!("compaction"), true), (json!(true), true), (json!(0), false), (json!(2), true), (json!(null), false), (json!({}), true)]
        {
            patch(6, "c", obj(json!({ "queue": [{ "id": "x", "waitingFor": waiting }] })), json!(3), false).unwrap();
            assert_eq!(drainable(6, "c"), Ok(!held), "{waiting}");
            patch(6, "c", obj(json!({ "queue": [] })), json!(3), false).unwrap();
        }
        close(6);
        assert_eq!(drainable(6, "c"), Err("no session store 6".into()));
        assert_eq!(drain(6, "c", json!(3)), Err("no session store 6".into()));
    }

    #[test]
    fn a_turn_starts_ends_and_crashes_through_its_steps() {
        let empty = json!({ "rev": 0, "turn": "idle", "activeTurn": null, "crashed": "earlier", "progressAt": null, "runningElsewhere": false, "approvals": [], "queue": [] });
        open(7, obj(empty), vec![]);
        let none = Map::new();
        let c = step(7, "c", "start", &obj(json!({ "turnId": "pending-1", "human": true })), none.clone(), json!(1)).unwrap().unwrap();
        assert_eq!(c.keys, vec!["turn".to_string(), "activeTurn".to_string(), "crashed".to_string()]);
        assert_eq!(c.implied, obj(json!({ "turn": "running", "activeTurn": { "id": "pending-1", "human": true }, "crashed": null })));
        assert_eq!(
            step(7, "c", "start", &obj(json!({ "turnId": "pending-1", "human": true })), none.clone(), json!(1)),
            Ok(None),
            "the same start"
        );
        // the step's values win over what the caller sets with it
        let extra = obj(json!({ "approvals": [{ "id": 1 }], "turn": "running" }));
        let c = step(7, "c", "end", &Map::new(), extra, json!(2)).unwrap().unwrap();
        assert_eq!(
            c.implied,
            obj(json!({ "turn": "idle", "activeTurn": null, "progressAt": null }))
                .into_iter()
                .filter(|(k, _)| c.keys.contains(k))
                .collect()
        );
        assert_eq!(step(7, "c", "end", &Map::new(), none.clone(), json!(2)), Ok(None));
        let c = step(7, "c", "crash", &obj(json!({ "reason": "it quit" })), obj(json!({ "queue": [{ "id": "q" }] })), json!(3))
            .unwrap()
            .unwrap();
        assert_eq!(c.keys, vec!["queue".to_string(), "turn".to_string(), "crashed".to_string()]);
        assert_eq!(c.implied, obj(json!({ "turn": "crashed", "crashed": "it quit" })));
        // a start with no human flag is no person's
        let c = step(7, "c", "start", &obj(json!({ "turnId": "t" })), none.clone(), json!(4)).unwrap().unwrap();
        assert_eq!(c.implied["activeTurn"], json!({ "id": "t", "human": false }));
        assert_eq!(step(7, "c", "pause", &Map::new(), none.clone(), json!(4)), Err("no turn step pause".into()));
        close(7);
        assert_eq!(step(7, "c", "end", &Map::new(), none, json!(4)), Err("no session store 7".into()));
    }

    #[test]
    fn a_message_put_back_goes_behind_those_put_back_before_it_or_ahead_of_all() {
        store(8);
        assert_eq!(put_back(8, "c", json!("s"), false), Ok(0), "an empty queue");
        patch(8, "c", obj(json!({ "queue": [{ "id": "s" }, { "id": "x" }] })), json!(1), false).unwrap();
        // a steer behind the start put back before it
        assert_eq!(put_back(8, "c", json!("t"), false), Ok(1));
        patch(8, "c", obj(json!({ "queue": [{ "id": "s" }, { "id": "t" }, { "id": "x" }] })), json!(1), false).unwrap();
        assert_eq!(put_back(8, "c", json!("u"), false), Ok(2));
        // the turn's own message goes first, and the line starts again from it
        assert_eq!(put_back(8, "c", json!("own"), true), Ok(0));
        patch(8, "c", obj(json!({ "queue": [{ "id": "own" }, { "id": "s" }] })), json!(1), false).unwrap();
        assert_eq!(put_back(8, "c", json!("v"), false), Ok(2), "behind every message at the front that went back first");
        // a queue item with no id ends the line
        patch(8, "c", obj(json!({ "queue": [{ "text": "no id" }] })), json!(1), false).unwrap();
        assert_eq!(put_back(8, "c", json!("w"), false), Ok(0));
        close(8);
        assert_eq!(put_back(8, "c", json!("w"), false), Err("no session store 8".into()));
    }

    #[test]
    fn send_now_admits_and_routes_a_queued_message_by_the_turn() {
        store(9);
        let go = |phase, peer, ps, st| send_now(9, "c", phase, peer, ps, st);
        // no turn running: anything is admitted and starts one
        assert_eq!((go("admit", true, None, None), go("route", false, None, None)), (Ok("admit"), Ok("start")));
        patch(9, "c", obj(json!({ "turn": "running" })), json!(1), false).unwrap();
        assert_eq!(go("admit", false, None, None), Ok("admit"), "the user's own message");
        assert_eq!(go("admit", true, None, None), Ok("ask"), "another session's: can its harness take a steer?");
        assert_eq!((go("admit", true, Some(true), None), go("admit", true, Some(false), None)), (Ok("admit"), Ok("refuse")));
        assert_eq!(go("route", false, None, None), Ok("ask"));
        assert_eq!((go("route", false, None, Some(true)), go("route", false, None, Some(false))), (Ok("steer"), Ok("queueFirst")));
        patch(9, "c", obj(json!({ "turn": "awaitingUser" })), json!(1), false).unwrap();
        assert_eq!(go("admit", true, Some(true), None), Ok("refuse"), "waiting on the user");
        patch(9, "c", obj(json!({ "turn": "running", "pendingSwitch": { "harness": "claude" } })), json!(1), false).unwrap();
        assert_eq!(go("admit", true, Some(true), None), Ok("refuse"), "switching harness");
        assert_eq!(go("other", false, None, None), Err("no send-now phase other".into()));
        assert_eq!(send_now(9, "nobody", "route", false, None, None), Ok("start"), "a chat with no state");
        close(9);
        assert_eq!(go("admit", false, None, None), Err("no session store 9".into()));
    }

    #[test]
    fn approvals_move_a_turn_to_wait_on_the_user_and_back_unless_the_patch_names_the_turn() {
        let empty = json!({ "rev": 0, "turn": "idle", "progressAt": null, "runningElsewhere": false, "approvals": [] });
        open(5, obj(empty), vec![]);
        let one = json!([{ "id": 1 }]);
        // idle: an approval (a background agent's) leaves the turn as it is
        let c = patch(5, "c", obj(json!({ "approvals": one })), json!(1), false).unwrap().unwrap();
        assert_eq!(c.keys, vec!["approvals".to_string()]);
        // and answering it leaves the idle turn as it is too
        let c = patch(5, "c", obj(json!({ "approvals": [] })), json!(1), false).unwrap().unwrap();
        assert_eq!(c.keys, vec!["approvals".to_string()]);
        patch(5, "c", obj(json!({ "approvals": [], "turn": "running" })), json!(1), false).unwrap();
        // running: a new approval waits on the user
        let c = patch(5, "c", obj(json!({ "approvals": one })), json!(2), false).unwrap().unwrap();
        assert_eq!((c.keys, c.implied), (vec!["approvals".to_string(), "turn".to_string()], obj(json!({ "turn": "awaitingUser" }))));
        // its last approval answered: running again, its quiet counted from now
        let c = patch(5, "c", obj(json!({ "approvals": [] })), json!(3), false).unwrap().unwrap();
        assert_eq!(c.implied, obj(json!({ "turn": "running", "progressAt": 3 })));
        // a patch that names the turn (an end, a crash) keeps it
        patch(5, "c", obj(json!({ "approvals": one })), json!(4), false).unwrap();
        let c = patch(5, "c", obj(json!({ "approvals": [], "turn": "idle" })), json!(5), false).unwrap().unwrap();
        assert!(!c.implied.contains_key("turn"));
        // one answered of two: still waiting
        patch(5, "c", obj(json!({ "approvals": [], "turn": "running" })), json!(6), false).unwrap();
        patch(5, "c", obj(json!({ "approvals": [{ "id": 1 }, { "id": 2 }] })), json!(6), false).unwrap();
        assert!(patch(5, "c", obj(json!({ "approvals": one })), json!(7), false).unwrap().unwrap().implied.is_empty());
        close(5);
    }

    #[test]
    fn progress_a_patch_gives_is_kept_whether_the_turn_ends_or_resumes() {
        store(4);
        patch(4, "c", obj(json!({ "turn": "awaitingUser" })), json!(1), false).unwrap();
        // resumed with its own progress: that, not now
        let c = patch(4, "c", obj(json!({ "turn": "running", "progressAt": 3 })), json!(9), false).unwrap().unwrap();
        assert_eq!((c.keys, c.implied), (vec!["turn".to_string(), "progressAt".to_string()], Map::new()));
        // ended with its last progress given: kept, not cleared
        let c = patch(4, "c", obj(json!({ "turn": "idle", "progressAt": 4 })), json!(9), false).unwrap().unwrap();
        assert_eq!((c.keys, c.implied), (vec!["turn".to_string(), "progressAt".to_string()], Map::new()));
        // a turn that waited on the user and ends (a stop): no progress, and none counted from now
        patch(4, "c", obj(json!({ "turn": "awaitingUser" })), json!(1), false).unwrap();
        let c = patch(4, "c", obj(json!({ "turn": "idle" })), json!(9), false).unwrap().unwrap();
        assert_eq!((c.keys, c.implied), (vec!["turn".to_string(), "progressAt".to_string()], obj(json!({ "progressAt": null }))));
        close(4);
    }
}
