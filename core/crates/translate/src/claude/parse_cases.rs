//! What a sub-agent's report and a task's notification say, field by field: the parts a thread's items show only some of.

use crate::claude::agent_runs::{parse_agent_trailer, parse_task_notification, settle_agent, settled_status, Settled};
use crate::claude::patterns::trailer;
use jsvalue::value::{Object, Text, Value};

const AID: &str = "a0123456789abcdef";

fn tail() -> String {
    format!("agentId: {AID} (use SendMessage with to: '{AID}' to continue this agent)\n<usage>total_tokens: 1200\ntool_uses: 4\nduration_ms: 9000</usage>")
}

#[test]
fn the_trailer_gives_the_report_the_agent_id_usage_and_the_worktree() {
    let text = format!("Found three bugs.\n{}", tail().replace(")\n<usage>", ")\nworktreePath: /w/x\nworktreeBranch: fix\n<usage>"));
    let read = parse_agent_trailer(&Text::from(text.as_str()));
    assert_eq!(read.report, Text::from("Found three bugs.\nworktreePath: /w/x\nworktreeBranch: fix"));
    assert_eq!(read.agent_id, Some(Text::from(AID)));
    assert_eq!((read.tokens, read.tool_uses), (Some(1200.0), Some(4.0)));
    let found = trailer(text.as_bytes()).expect("a trailer");
    assert_eq!(found.index, "Found three bugs.".len());
    let recap = format!("agentId: {AID} (use SendMessage with to: '{AID}', summary: '<5-10 word recap>' to continue this agent)\n<usage>total_tokens: 5\ntool_uses: 0\nduration_ms: 1</usage>");
    assert_eq!(parse_agent_trailer(&Text::from(recap.as_str())).report, Text::default());
}

#[test]
fn a_report_in_its_hand_back_frame_is_the_report_alone_with_a_trailer_or_without() {
    let frame = "[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n";
    let framed = format!("{frame}  Found it.\n  - two\n{}", tail());
    let read = parse_agent_trailer(&Text::from(framed.as_str()));
    assert_eq!(read.report, Text::from("Found it.\n- two"));
    assert_eq!(read.agent_id, Some(Text::from(AID)));
    let bare = format!("{frame}  Bare report");
    assert_eq!(parse_agent_trailer(&Text::from(bare.as_str())).report, Text::from("Bare report"));
    let plain = parse_agent_trailer(&Text::from("plain"));
    assert_eq!((plain.report, plain.agent_id, plain.tokens, plain.tool_uses), (Text::from("plain"), None, None, None));
}

#[test]
fn statuses_settle_as_claude_desktop_normalizes_them() {
    let of = |status: &str| settled_status(Some(&Value::text(status)));
    for status in ["running", "pending", "paused", "started"] {
        assert_eq!(of(status), None);
    }
    for status in ["failed", "error", "blocked", "cancelled"] {
        assert_eq!(of(status), Some("failed"));
    }
    for status in ["stopped", "killed"] {
        assert_eq!(of(status), Some("stopped"));
    }
    // a notification that names no status ended as far as anyone knows
    assert_eq!(of("completed"), Some("completed"));
    assert_eq!(of("weird"), Some("completed"));
    assert_eq!(settled_status(None), Some("completed"));
}

#[test]
fn a_notification_gives_ids_status_usage_in_either_form_and_its_kind() {
    let xml = "<task-notification><task-id>t1</task-id><tool-use-id>ag</tool-use-id><task-type>local_agent</task-type><status>completed</status><summary>Agent \"Explore\" completed</summary><description>Explore</description><result>Report</result><usage><total_tokens>10</total_tokens><tool_uses>2</tool_uses><duration_ms>300</duration_ms></usage></task-notification>";
    let read = parse_task_notification(xml.as_bytes());
    assert_eq!(read.task_id, Some(Text::from("t1")));
    assert_eq!(read.tool_use_id, Some(Text::from("ag")));
    assert_eq!(read.status, Some(Text::from("completed")));
    assert_eq!(read.summary, Some(Text::from("Agent \"Explore\" completed")));
    assert_eq!(read.description, Some(Text::from("Explore")));
    assert_eq!(read.result, Some(Text::from("Report")));
    assert_eq!(read.event, None);
    assert_eq!(read.kind, Some("agent"));
    assert_eq!((read.tokens, read.tool_uses, read.duration_ms), (Some(10.0), Some(2.0), Some(300.0)));
    let other = "<task-notification><task_id>b</task_id><tool_use_id>u</tool_use_id><task_type>monitor_mcp</task_type><usage>subagent_tokens: 3\ntool_uses: 1\nduration_ms: 7</usage></task-notification>";
    let read = parse_task_notification(other.as_bytes());
    assert_eq!((read.task_id, read.tool_use_id, read.kind), (Some(Text::from("b")), Some(Text::from("u")), Some("monitor")));
    assert_eq!((read.tokens, read.duration_ms), (Some(3.0), Some(7.0)));
    let kind = |xml: &str| parse_task_notification(xml.as_bytes()).kind;
    assert_eq!(kind("<task-notification><task-type>local_bash</task-type></task-notification>"), Some("shell"));
    assert_eq!(kind("<task-notification><task-type>other</task-type></task-notification>"), None);
    assert_eq!(kind("<agent-notification><status>failed</status></agent-notification>"), Some("agent"));
    assert_eq!(kind("<bash-notification></bash-notification>"), Some("shell"));
    assert_eq!(parse_task_notification(b"<task-notification><summary> </summary></task-notification>").summary, None);
    // a monitor's tick carries an event and no status
    let tick = parse_task_notification(
        b"<task-notification><task-id>m1</task-id><summary>Monitor event: \"Ticks\"</summary><event>tick 1</event></task-notification>",
    );
    assert_eq!((tick.status, tick.event), (None, Some(Text::from("tick 1"))));
}

#[test]
fn a_run_that_settles_ends_a_duration_after_it_began_and_with_no_start_at_the_notification() {
    let told = parse_task_notification(b"<task-notification><status>completed</status><usage>duration_ms: 5</usage></task-notification>");
    let settled = Settled::from(&told);
    let ended = |run: &Object| settle_agent(run, &settled, None, 900.0).expect("a change").get("completedAt").cloned();
    let begun = Object::of([("status", Value::text("running")), ("startedAt", Value::Number(100.0))]);
    assert_eq!(ended(&begun), Some(Value::Number(105.0)));
    let no_start = Object::of([("status", Value::text("running")), ("startedAt", Value::Null)]);
    assert_eq!(ended(&no_start), Some(Value::Number(900.0)));
}
