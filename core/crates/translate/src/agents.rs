//! ACP sub-agents: what launches one, whose an update is (also the stream batcher's key, core/crates/batcher), and a launch
//! as a collab agent item with its AgentRun.

use crate::blocks::tool_output;
use crate::emit::{AgentItem, Item, TurnId};
use crate::ordered::Ordered;
use crate::reads::{at, is, status_of, string, text_from, text_of, text_or_empty};
use crate::Thrown;
use jsvalue::js::given;
use jsvalue::value::{Object, Text, Value};
use jsvalue::{prefix_units, trim, unit_length};
use std::collections::HashMap;
use std::sync::Arc;

/// A sub-agent call: the turn that launched it, its merged call, and its own calls and items.
pub struct Agent {
    pub turn: TurnId,
    pub tc: Object,
    pub calls: HashMap<Text, Object>,
    pub running: Ordered<Object>,
    pub items: Vec<Arc<Object>>,
    pub count: u64,
}

impl Agent {
    pub fn new(turn: TurnId, tc: Object) -> Self {
        Agent { turn, tc, calls: HashMap::new(), running: Ordered::default(), items: Vec::new(), count: 0 }
    }
}

/// A tool call that launches a sub-agent: its tool is named so (claude-agent-acp's Task and Agent, Qwen Code's agent), or its
/// input names a sub-agent type. `toLowerCase` folds as Rust's does on every name that could come out as one of these.
pub fn is_agent_call(tc: &Object) -> bool {
    let meta = tc.get("_meta");
    let name = given(at(at(meta, "claudeCode"), "toolName")).or(given(at(meta, "toolName"))).or(given(tc.get("name")));
    if string(name).is_some_and(|name| matches!(name.lossy().to_lowercase().as_str(), "task" | "agent")) {
        return true;
    }
    string(at(tc.get("rawInput"), "subagent_type")).is_some() && !is(tc.get("kind"), "execute")
}

/// The sub-agent call an update belongs to, from its `_meta` (claude-agent-acp's parentToolUseId, Qwen's parentToolCallId).
pub fn parent_of(update: Option<&Object>) -> Result<Option<Text>, Thrown> {
    let meta = update.and_then(|update| update.get("_meta"));
    let parent =
        given(at(at(meta, "claudeCode"), "parentToolUseId")).or(given(at(meta, "parentToolCallId"))).or(given(at(meta, "parentToolUseId")));
    match string(parent) {
        Some(parent) if !parent.is_empty() && *parent != text_of(update.and_then(|update| update.get("toolCallId")))? => {
            Ok(Some(parent.clone()))
        }
        _ => Ok(None),
    }
}

/// The first line of `value`, clipped to what a row shows.
fn first_line(value: Option<&Value>) -> Result<Text, Thrown> {
    let text = text_or_empty(value)?;
    let line = trim(trim(text.as_bytes()).split(|byte| *byte == b'\n').next().unwrap_or_default());
    if unit_length(line) <= 80 {
        return Ok(text_from(line));
    }
    let mut clipped = prefix_units(&text_from(line), 79);
    clipped.push_str("\u{2026}");
    Ok(clipped)
}

/// What the agent is called on its row.
fn description(tc: &Object, prompt: Option<&Value>) -> Result<Text, Thrown> {
    for line in [at(tc.get("rawInput"), "description"), tc.get("title"), prompt] {
        let line = first_line(line)?;
        if !line.is_empty() {
            return Ok(line);
        }
    }
    Ok("Agent".into())
}

/// What the agent reported, once it ended.
fn report(tc: &Object) -> Result<Value, Thrown> {
    let output = tool_output(tc.get("content"))?;
    let raw = string(tc.get("rawOutput")).map(|raw| trim(raw.as_bytes())).unwrap_or_default();
    let said = if trim(output.as_bytes()).is_empty() { raw } else { trim(output.as_bytes()) };
    Ok(if said.is_empty() { Value::Null } else { Value::String(text_from(said)) })
}

/// A sub-agent call as a collab agent item with its AgentRun (`agent`). ACP doesn't nest: when the harness names the parent
/// of the agent's own calls, they are its transcript; otherwise the agent page shows the prompt, the report and the status.
pub fn agent_item(tc: &Object, thread: &Value, agent: &Agent) -> Result<Item, Thrown> {
    let id = Value::String(text_of(tc.get("toolCallId"))?);
    let status = status_of(tc);
    let input = tc.get("rawInput");
    let prompt = at(input, "prompt").filter(|prompt| matches!(prompt, Value::String(_)));
    let model = at(input, "model").filter(|model| matches!(model, Value::String(_))).cloned().unwrap_or(Value::Null);
    let running = status == "inProgress";
    let live = if running { agent.running.values().next_back() } else { None };
    let tool_uses = agent.items.iter().filter(|item| !is(item.get("type"), "agentMessage") && !is(item.get("type"), "reasoning"));
    let run = Object::of([
        ("key", id.clone()),
        ("description", Value::String(description(tc, prompt)?)),
        ("prompt", prompt.cloned().unwrap_or(Value::Null)),
        ("model", model.clone()),
        ("background", Value::Bool(at(input, "run_in_background") == Some(&Value::Bool(true)))),
        (
            "status",
            Value::text(if tc.get("cancelled").is_some_and(jsvalue::js::truthy) {
                "stopped"
            } else if running {
                "running"
            } else {
                status
            }),
        ),
        ("toolUses", Value::Number(tool_uses.count() as f64)),
        (
            "latestTool",
            live.map_or(Ok(Value::Null), |live| {
                given(live.get("title")).map_or(Ok(Value::text("Tool")), |title| text_of(Some(title)).map(Value::String))
            })?,
        ),
        ("tokens", Value::Null),
        ("startedAt", Value::Null),
        ("completedAt", Value::Null),
        ("report", if running { Value::Null } else { report(tc)? }),
        ("transcript", Value::text(if agent.items.is_empty() { "summary" } else { "full" })),
    ]);
    let head = Object::of([
        ("type", Value::text("collabAgentToolCall")),
        ("id", id),
        ("tool", Value::text("spawnAgent")),
        ("status", Value::text(status)),
        ("senderThreadId", thread.clone()),
        ("receiverThreadIds", Value::Array(Vec::new())),
        ("prompt", prompt.cloned().unwrap_or(Value::Null)),
        ("model", model),
        ("reasoningEffort", Value::Null),
        ("agentsStates", Value::Object(Object::default())),
    ]);
    Ok(Item::Agent(Box::new(AgentItem { head, items: agent.items.clone(), agent: run })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emit::write_item;
    use jsvalue::json::parse;

    fn object(text: &str) -> Object {
        parse(text).as_ref().and_then(Value::as_object).expect("an object").clone()
    }

    fn run(tc: &str) -> Value {
        let tc = object(tc);
        let agent = Agent::new(None, tc.clone());
        run_of(&agent_item(&tc, &Value::text("chat"), &agent).expect("an item"))
    }

    fn run_of(item: &Item) -> Value {
        let mut out = Vec::new();
        write_item(&mut out, item);
        let item = parse(std::str::from_utf8(&out).expect("UTF-8")).expect("JSON");
        item.field("agent").expect("a run").clone()
    }

    #[test]
    fn a_launch_is_named_so_or_names_a_sub_agent_type() {
        for tc in [
            r#"{"_meta":{"claudeCode":{"toolName":"Agent"}}}"#,
            r#"{"_meta":{"toolName":"agent"}}"#,
            r#"{"name":"Task"}"#,
            r#"{"name":"TASK"}"#,
            r#"{"rawInput":{"subagent_type":"reviewer"},"kind":"other"}"#,
        ] {
            assert!(is_agent_call(&object(tc)), "{tc}");
        }
        for tc in [
            r#"{"rawInput":{"subagent_type":"reviewer"},"kind":"execute"}"#,
            r#"{"rawInput":{"subagent_type":7}}"#,
            r#"{"_meta":{"toolName":"Bash"}}"#,
            r#"{"_meta":{"toolName":7}}"#,
            "{}",
        ] {
            assert!(!is_agent_call(&object(tc)), "{tc}");
        }
    }

    #[test]
    fn an_updates_parent_comes_from_its_meta() {
        let read = |update: &str| parent_of(parse(update).as_ref().and_then(Value::as_object));
        let parent = |update: &str| read(update).expect("a read").map(|parent| parent.lossy());
        let named = |text: &str| Some(text.to_string());
        assert_eq!(parent(r#"{"toolCallId":"x","_meta":{"claudeCode":{"parentToolUseId":"p"}}}"#), named("p"));
        assert_eq!(parent(r#"{"toolCallId":"x","_meta":{"parentToolCallId":"q"}}"#), named("q"));
        assert_eq!(parent(r#"{"toolCallId":"x","_meta":{"parentToolUseId":"r"}}"#), named("r"));
        for update in [
            r#"{"toolCallId":"x","_meta":{"parentToolCallId":"x"}}"#,
            r#"{"toolCallId":"x","_meta":{"parentToolCallId":""}}"#,
            r#"{"toolCallId":"x","_meta":{"parentToolCallId":7}}"#,
            r#"{"toolCallId":"x"}"#,
            "null",
        ] {
            assert_eq!(parent(update), None, "{update}");
        }
        assert!(read(r#"{"toolCallId":{"toString":1},"_meta":{"parentToolCallId":"p"}}"#).is_err());
        assert_eq!(read(r#"{"toolCallId":{"toString":1}}"#), Ok(None));
    }

    #[test]
    fn a_description_is_the_first_line_that_says_anything() {
        let description = |tc: &str| run(tc).field("description").cloned().expect("a description");
        assert_eq!(description(r#"{"rawInput":{"description":"  first\nsecond "}}"#), Value::text("first"));
        assert_eq!(description(r#"{"rawInput":{"description":" "},"title":"title"}"#), Value::text("title"));
        assert_eq!(description(r#"{"rawInput":{"prompt":"do it"}}"#), Value::text("do it"));
        assert_eq!(description("{}"), Value::text("Agent"));
        let long = "x".repeat(100);
        assert_eq!(description(&format!(r#"{{"rawInput":{{"prompt":"{long}"}}}}"#)), Value::text(&format!("{}\u{2026}", "x".repeat(79))));
        assert_eq!(description(&format!(r#"{{"rawInput":{{"prompt":"{}"}}}}"#, "x".repeat(80))), Value::text(&"x".repeat(80)));
        // 79 units end inside a pair: it goes whole
        let pairs = format!("x{}", "\u{1f600}".repeat(50));
        let cut = format!("x{}\u{2026}", "\u{1f600}".repeat(39));
        assert_eq!(description(&format!(r#"{{"rawInput":{{"prompt":"{pairs}"}}}}"#)), Value::text(&cut));
    }

    #[test]
    fn a_report_is_its_output_or_its_raw_text_once_it_ended() {
        let report = |tc: &str| run(tc).field("report").cloned().expect("a report");
        assert_eq!(report(r#"{"status":"completed","rawOutput":" raw "}"#), Value::text("raw"));
        let content = r#"[{"type":"content","content":{"type":"text","text":" said "}}]"#;
        assert_eq!(report(&format!(r#"{{"status":"completed","content":{content},"rawOutput":"raw"}}"#)), Value::text("said"));
        assert_eq!(report(&format!(r#"{{"content":{content}}}"#)), Value::Null);
        assert_eq!(report(r#"{"status":"failed"}"#), Value::Null);
        assert_eq!(report(r#"{"status":"completed","rawOutput":{"a":1}}"#), Value::Null);
    }

    #[test]
    fn a_runs_status_says_how_it_stands() {
        let status = |tc: &str| run(tc).field("status").cloned().expect("a status");
        assert_eq!(status("{}"), Value::text("running"));
        assert_eq!(status(r#"{"status":"completed"}"#), Value::text("completed"));
        assert_eq!(status(r#"{"status":"failed"}"#), Value::text("failed"));
        assert_eq!(status(r#"{"status":"failed","cancelled":true}"#), Value::text("stopped"));
        assert_eq!(status(r#"{"cancelled":false}"#), Value::text("running"));
    }

    #[test]
    fn a_runs_counts_come_from_its_own_items() {
        let tc = object(r#"{"toolCallId":"a"}"#);
        let mut agent = Agent::new(None, tc.clone());
        let chat = Value::text("chat");
        let read = |item: &Item, key: &str| run_of(item).field(key).cloned().expect("a field");
        let bare = agent_item(&tc, &chat, &agent).expect("an item");
        assert_eq!(
            (read(&bare, "toolUses"), read(&bare, "transcript"), read(&bare, "latestTool")),
            (Value::Number(0.0), Value::text("summary"), Value::Null)
        );
        for kind in ["agentMessage", "reasoning", "commandExecution"] {
            agent.items.push(Arc::new(Object::of([("type", Value::text(kind))])));
        }
        agent.running.set("c".into(), object(r#"{"title":"Grep"}"#));
        agent.running.set("d".into(), object("{}"));
        let live = agent_item(&tc, &chat, &agent).expect("an item");
        assert_eq!(
            (read(&live, "toolUses"), read(&live, "transcript"), read(&live, "latestTool")),
            (Value::Number(1.0), Value::text("full"), Value::text("Tool"))
        );
        agent.running.delete(&"d".into());
        assert_eq!(read(&agent_item(&tc, &chat, &agent).expect("an item"), "latestTool"), Value::text("Grep"));
        let done = object(r#"{"toolCallId":"a","status":"completed"}"#);
        assert_eq!(read(&agent_item(&done, &chat, &agent).expect("an item"), "latestTool"), Value::Null);
    }

    #[test]
    fn a_run_carries_its_input() {
        let run = run(r#"{"rawInput":{"prompt":"p","model":"m","run_in_background":true}}"#);
        assert_eq!(run.field("prompt"), Some(&Value::text("p")));
        assert_eq!(run.field("model"), Some(&Value::text("m")));
        assert_eq!(run.field("background"), Some(&Value::Bool(true)));
        let odd = self::run(r#"{"rawInput":{"prompt":7,"model":8,"run_in_background":"yes"}}"#);
        assert_eq!(odd.field("prompt"), Some(&Value::Null));
        assert_eq!(odd.field("model"), Some(&Value::Null));
        assert_eq!(odd.field("background"), Some(&Value::Bool(false)));
    }

    #[test]
    fn what_has_no_string_throws_as_the_js_did() {
        let bad = r#"{"toString":1}"#;
        for tc in [
            format!(r#"{{"toolCallId":{bad}}}"#),
            format!(r#"{{"title":{bad}}}"#),
            format!(r#"{{"rawInput":{{"description":{bad}}}}}"#),
            format!(r#"{{"status":"completed","content":[{{"type":"content","content":{{"type":"resource_link","uri":{bad}}}}}]}}"#),
        ] {
            let tc = object(&tc);
            assert!(agent_item(&tc, &Value::Null, &Agent::new(None, tc.clone())).is_err());
        }
        let tc = object("{}");
        let mut agent = Agent::new(None, tc.clone());
        agent.running.set("c".into(), object(&format!(r#"{{"title":{bad}}}"#)));
        assert!(agent_item(&tc, &Value::Null, &agent).is_err());
    }
}
