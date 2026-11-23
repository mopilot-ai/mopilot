//! What the fold does with what is odd, and what a page counts: the parity fixtures hold the rest.

use super::*;

fn turns_of(ids: &[&str]) -> Turns {
    let mut turns = Turns::default();
    for id in ids {
        turns.apply(Emit::TurnStarted { id: Some(Value::text(id)), at: 0.0 }).expect("a turn");
    }
    turns
}

fn turn() -> TurnId {
    Some(Value::text("t"))
}

fn item(fields: Object) -> Emit {
    Emit::Item { started: false, turn: turn(), item: Item::Plain(fields) }
}

fn with_id(extra: (&str, Value)) -> Object {
    Object::of([("id", Value::text("i")), extra])
}

fn delta(summary: bool) -> Emit {
    let (turn, item, delta) = (turn(), Text::from("i"), Text::from("+"));
    if summary {
        Emit::ThoughtDelta { turn, item, delta }
    } else {
        Emit::MessageDelta { turn, item, delta }
    }
}

fn written(turns: &Turns) -> String {
    String::from_utf8(turns.write()).expect("UTF-8")
}

#[test]
fn what_names_no_turn_or_item_changes_nothing() {
    let mut turns = turns_of(&[]);
    let none = turn();
    for emit in [
        Emit::TurnCompleted { id: none.clone(), status: "failed", error: Value::Null, at: 0.0 },
        item(Object::default()),
        delta(false),
        delta(true),
        Emit::Diff { turn: none.clone(), diff: "d".into() },
        Emit::Plan { turn: none, plan: Value::Null },
    ] {
        assert_eq!(turns.apply(emit), Ok(()));
    }
    assert_eq!(written(&turns), "[]");
    let mut turns = turns_of(&["t"]);
    assert_eq!(turns.apply(delta(false)), Ok(()));
    assert_eq!(turns.apply(delta(true)), Ok(()));
    assert!(written(&turns).contains(r#""items":[]"#));
}

#[test]
fn a_delta_reads_whatever_took_its_items_id_as_js_read_it() {
    let reads = |fields: Object, summary: bool| {
        let mut turns = turns_of(&["t"]);
        turns.apply(item(fields)).expect("an item");
        turns.apply(delta(summary)).map(|()| written(&turns))
    };
    assert!(reads(with_id(("text", Value::text("a"))), false).expect("a text").contains(r#""text":"a+""#));
    assert!(reads(with_id(("x", Value::Null)), false).expect("a text").contains(r#""text":"undefined+""#));
    assert!(reads(with_id(("summary", Value::Array(vec![Value::text("a")]))), true).expect("a summary").contains(r#""summary":["a+"]"#));
    assert!(reads(with_id(("summary", Value::text("ab"))), true).expect("a summary").contains(r#""summary":["a+"]"#));
    assert!(reads(with_id(("summary", Value::text(""))), true).expect("a summary").contains(r#""summary":["undefined+"]"#));
    assert!(reads(with_id(("summary", Value::Array(Vec::new()))), true).expect("a summary").contains(r#""summary":["undefined+"]"#));
    assert!(reads(with_id(("x", Value::Null)), true).is_err());
    assert!(reads(with_id(("summary", Value::Null)), true).is_err());
}

#[test]
fn a_delta_on_a_sub_agents_item_makes_it_plain_first() {
    let mut turns = turns_of(&["t"]);
    let agent =
        Item::Agent(Box::new(crate::emit::AgentItem { head: with_id(("n", Value::Null)), items: Vec::new(), agent: Object::default() }));
    turns.apply(Emit::Item { started: false, turn: turn(), item: agent }).expect("an item");
    turns.apply(delta(false)).expect("a delta");
    assert!(written(&turns).contains(r#""agentItems":[],"agent":{},"text":"undefined+""#));
}

#[test]
fn an_object_as_an_id_is_only_ever_itself() {
    let mut turns = turns_of(&["t"]);
    for _ in 0..2 {
        let id = Value::Object(Object::default());
        turns.apply(item(Object::of([("id", id)]))).expect("an item");
    }
    assert!(written(&turns).contains(r#""items":[{"id":{}},{"id":{}}]"#));
}

#[test]
fn rounding_is_js_rounding() {
    for (number, rounded) in [(2.5, 3.0), (-2.5, -2.0), (0.49999999999999994, 0.0), (1.4, 1.0), (1.6, 2.0), (-0.4, 0.0), (0.0, 0.0)] {
        assert_eq!(math_round(number), rounded, "{number}");
    }
}
