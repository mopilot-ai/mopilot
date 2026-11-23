//! Claude tool-use blocks and results as thread items, including commands and file diffs.

use crate::claude::agent_runs::{agent_launch, agent_result};
use crate::claude::common::{cat, is_mcp, joined, result_text};
use crate::claude::patterns as re;
use crate::reads::{at, first, is, string, text_from, text_of, text_or_empty};
use crate::Thrown;
use jsvalue::js::{given, join, number_text, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

fn kind_add() -> Value {
    Value::Object(Object::of([("type", Value::text("add"))]))
}

fn kind_update() -> Value {
    Value::Object(Object::of([("type", Value::text("update")), ("move_path", Value::Null)]))
}

/// One file's change.
fn change(path: Value, kind: Value, diff: Text) -> Value {
    Value::Object(Object::of([("path", path), ("kind", kind), ("diff", Value::String(diff))]))
}

/// A hunk's header number: `${h.oldStart}`, with what undefined and null spell.
fn hunks_to_diff(patch: Option<&Value>) -> Result<Text, Thrown> {
    let Some(Value::Array(hunks)) = patch else { return Err("a structured patch is no list".into()) };
    let mut diff = Vec::with_capacity(hunks.len());
    for hunk in hunks {
        if *hunk == Value::Null {
            return Err("a structured patch's hunk is null".into());
        }
        let Some(Value::Array(lines)) = hunk.field("lines") else { return Err("a hunk has no lines".into()) };
        let spelled = |key| text_of(hunk.field(key));
        let (old, old_lines, new, new_lines) = (spelled("oldStart")?, spelled("oldLines")?, spelled("newStart")?, spelled("newLines")?);
        diff.push(cat!("@@ -", old, ",", old_lines, " +", new, ",", new_lines, " @@\n", join(lines, "\n")?));
    }
    Ok(joined(&diff, "\n"))
}

/// Each line of `text` behind `sign`, and how many.
fn signed(text: &Text, sign: &str) -> (usize, Text) {
    let lines: Vec<Text> = text.as_bytes().split(|byte| *byte == b'\n').map(|line| cat!(sign, text_from(line))).collect();
    (lines.len(), joined(&lines, "\n"))
}

fn replace_diff(old: Option<&Value>, new: Option<&Value>) -> Result<Text, Thrown> {
    let (old_count, old) = signed(&text_or_empty(old)?, "-");
    let (new_count, new) = signed(&text_or_empty(new)?, "+");
    let header = format!("@@ -1,{} +1,{} @@\n", number_text(old_count as f64), number_text(new_count as f64));
    Ok(cat!(header.as_str(), old, "\n", new))
}

/// `/^[A-Za-z]:([\\/]|$)/.test(path) || /^\\\\[^\\]/.test(path)`: a drive or UNC path.
fn is_windows_path(path: &[u8]) -> bool {
    let drive = path.len() >= 2 && path[0].is_ascii_alphabetic() && path[1] == b':' && matches!(path.get(2), None | Some(b'\\' | b'/'));
    drive || (path.starts_with(b"\\\\") && path.len() > 2 && path[2] != b'\\')
}

/// `basename` of shared/paths.mjs. JS threw for a path that is no string.
fn basename(path: &Value) -> Result<Text, Thrown> {
    if !truthy(path) {
        return Ok(Text::default());
    }
    let Value::String(path) = path else { return Err("a path is no string".into()) };
    let bytes = path.as_bytes();
    let last = |is_slash: &dyn Fn(&u8) -> bool| {
        let end = bytes.iter().rposition(|byte| !is_slash(byte)).map_or(0, |at| at + 1);
        &bytes[bytes[..end].iter().rposition(is_slash).map_or(0, |at| at + 1)..end]
    };
    if is_windows_path(bytes) {
        return Ok(text_from(last(&|byte| matches!(byte, b'/' | b'\\'))));
    }
    let name = last(&|byte| *byte == b'/');
    Ok(if name.is_empty() { path.clone() } else { text_from(name) })
}

/// The item of a shell-like tool.
fn command(id: Option<&Value>, cwd: &Value, actions: Vec<Value>, command: Text) -> Object {
    let mut item = Object::of([("type", Value::text("commandExecution"))]);
    with_id(&mut item, id);
    for (key, value) in [
        ("command", Value::String(command)),
        ("cwd", cwd.clone()),
        ("processId", Value::Null),
        ("source", Value::text("agent")),
        ("status", Value::text("inProgress")),
        ("commandActions", Value::Array(actions)),
        ("aggregatedOutput", Value::Null),
        ("exitCode", Value::Null),
        ("durationMs", Value::Null),
        ("pluginId", Value::Null),
        ("scriptPath", Value::Null),
    ] {
        item.push(key, value);
    }
    item
}

fn with_id(item: &mut Object, id: Option<&Value>) {
    if let Some(id) = id {
        item.push("id", id.clone());
    }
}

fn action(fields: Vec<(&str, Value)>) -> Value {
    let mut entry = Object::default();
    for (key, value) in fields {
        entry.push(key, value);
    }
    Value::Object(entry)
}

/// `input.key ?? null`.
fn or_null(input: &Value, key: &str) -> Value {
    given(input.field(key)).cloned().unwrap_or(Value::Null)
}

/// A search tool's item.
fn search(id: Option<&Value>, cwd: &Value, name: &str, input: &Value) -> Result<Object, Thrown> {
    let fields = vec![
        ("type", Value::text("search")),
        ("command", Value::text(name)),
        ("query", or_null(input, "pattern")),
        ("path", or_null(input, "path")),
    ];
    Ok(command(id, cwd, vec![action(fields)], cat!(name, " ", text_or_empty(input.field("pattern"))?)))
}

/// A file tool's item.
fn file_change(id: Option<&Value>, changes: Vec<Value>) -> Object {
    let mut item = Object::of([("type", Value::text("fileChange"))]);
    with_id(&mut item, id);
    item.push("status", Value::text("inProgress"));
    item.push("changes", Value::Array(changes));
    item
}

fn web_search(id: Option<&Value>, query: Value, action: Value) -> Object {
    let mut item = Object::of([("type", Value::text("webSearch"))]);
    with_id(&mut item, id);
    item.push("query", query);
    item.push("action", action);
    item.push("results", Value::Null);
    item
}

fn agent_call(block: &Object, input: &Value, thread: &Value, at: f64) -> Object {
    let id = block.get("id");
    let mut item = Object::of([("type", Value::text("collabAgentToolCall"))]);
    with_id(&mut item, id);
    let prompt = given(input.field("description")).or(given(input.field("prompt"))).cloned().unwrap_or(Value::Null);
    for (key, value) in [
        ("tool", Value::text("spawnAgent")),
        ("status", Value::text("inProgress")),
        ("senderThreadId", thread.clone()),
        ("receiverThreadIds", Value::Array(Vec::new())),
        ("prompt", prompt),
        ("model", or_null(input, "model")),
        ("reasoningEffort", Value::Null),
        ("agentsStates", Value::Object(Object::default())),
        ("agent", Value::Object(agent_launch(id, input, at))),
    ] {
        item.push(key, value);
    }
    item
}

/// Any other tool: an MCP server's, or one Claude Code has no card for.
fn mcp_call(block: &Object, input: &Value) -> Result<Object, Thrown> {
    let name = block.get("name");
    let (server, tool) = if is_mcp(name)? {
        let held = string(name).map_or(&[][..], |name| name.as_bytes());
        let parts = split_on_underscores(held);
        (Value::String(text_from(parts.get(1).copied().unwrap_or_default())), parts.get(2).map(|tool| Value::String(text_from(tool))))
    } else {
        (Value::String(Text::default()), None)
    };
    let mut item = Object::of([("type", Value::text("mcpToolCall"))]);
    with_id(&mut item, block.get("id"));
    for (key, value) in [
        ("server", server),
        ("tool", tool.or_else(|| name.cloned()).unwrap_or(Value::Null)),
        ("status", Value::text("inProgress")),
        ("arguments", input.clone()),
        ("appContext", Value::Null),
        ("mcpAppUi", Value::Null),
        ("pluginId", Value::Null),
        ("readOnlyHint", Value::Null),
        ("result", Value::Null),
        ("error", Value::Null),
        ("durationMs", Value::Null),
    ] {
        item.push(key, value);
    }
    Ok(item)
}

/// `name.split('__')`.
pub fn split_on_underscores(name: &[u8]) -> Vec<&[u8]> {
    let mut parts = Vec::new();
    let mut from = 0;
    while let Some(at) = re::find(name, b"__", from) {
        parts.push(&name[from..at]);
        from = at + 2;
    }
    parts.push(&name[from..]);
    parts
}

/// The item of a `tool_use` block, or `None` when the tool has no item (plan updates, questions). `web_search`, the server's
/// own tool, has WebSearch's. What the JS threw on for a malformed call, this refuses.
pub fn tool_item(block: &Object, cwd: &Value, thread: &Value, when: f64) -> Result<Option<Object>, Thrown> {
    let empty = Value::Object(Object::default());
    let input = given(block.get("input")).unwrap_or(&empty);
    let id = block.get("id");
    // Newer Claude Code file tools take `path`; older ones `file_path`
    let path = given(input.field("file_path")).or(given(input.field("path")));
    let path_or_empty = || path.cloned().unwrap_or_else(|| Value::String(Text::default()));
    let path_text = || text_of(Some(&path_or_empty()));
    let name = block.get("name");
    let bytes = string(name).map_or(&[][..], |name| name.as_bytes());
    Ok(Some(match bytes {
        b"Bash" => {
            let description = string(input.field("description")).map(|text| trim(text.as_bytes())).filter(|text| !text.is_empty());
            let mut item = command(id, cwd, Vec::new(), text_or_empty(input.field("command"))?);
            if let Some(description) = description {
                item.push("description", Value::String(text_from(description)));
            }
            item
        }
        b"Read" => {
            let shown = path_text()?;
            let fields = vec![
                ("type", Value::text("read")),
                ("command", Value::text("Read")),
                ("name", Value::String(basename(&path_or_empty())?)),
                ("path", path_or_empty()),
            ];
            command(id, cwd, vec![action(fields)], cat!("Read ", shown))
        }
        b"Grep" => search(id, cwd, "Grep", input)?,
        b"Glob" => search(id, cwd, "Glob", input)?,
        b"LS" => {
            let fields = vec![("type", Value::text("listFiles")), ("command", Value::text("LS")), ("path", or_null(input, "path"))];
            command(id, cwd, vec![action(fields)], cat!("LS ", text_or_empty(input.field("path"))?))
        }
        b"Edit" => {
            let diff = replace_diff(input.field("old_string"), input.field("new_string"))?;
            file_change(id, vec![change(path_or_empty(), kind_update(), diff)])
        }
        b"MultiEdit" => {
            let edits = match given(input.field("edits")) {
                None => &[][..],
                Some(Value::Array(edits)) => edits,
                Some(_) => return Err("a MultiEdit's edits are no list".into()),
            };
            let mut diffs = Vec::with_capacity(edits.len());
            for edit in edits {
                if *edit == Value::Null {
                    return Err("a MultiEdit's edit is null".into());
                }
                diffs.push(replace_diff(edit.field("old_string"), edit.field("new_string"))?);
            }
            file_change(id, vec![change(path_or_empty(), kind_update(), joined(&diffs, "\n"))])
        }
        b"Write" => file_change(id, vec![change(path_or_empty(), kind_add(), text_or_empty(input.field("content"))?)]),
        b"NotebookEdit" => {
            let notebook = given(input.field("notebook_path")).cloned().unwrap_or_else(path_or_empty);
            let diff = replace_diff(None, input.field("new_source"))?;
            file_change(id, vec![change(notebook, kind_update(), diff)])
        }
        b"WebSearch" | b"web_search" => {
            let query = given(input.field("query")).cloned().unwrap_or_else(|| Value::String(Text::default()));
            let action = Object::of([("type", Value::text("search")), ("query", query.clone())]);
            web_search(id, query, Value::Object(action))
        }
        b"WebFetch" => {
            let url = given(input.field("url")).cloned().unwrap_or_else(|| Value::String(Text::default()));
            let action = Object::of([("type", Value::text("openPage")), ("url", url)]);
            web_search(id, Value::String(Text::default()), Value::Object(action))
        }
        b"Task" | b"Agent" => agent_call(block, input, thread, when),
        b"ExitPlanMode" => {
            // the CLI fills in the plan it saved (the model's own input is empty); one plan card, with its file approved on its
            // own card, after which Claude carries it out in the same turn
            let mut item = Object::of([("type", Value::text("plan"))]);
            with_id(&mut item, id);
            item.push("text", Value::String(text_or_empty(input.field("plan"))?));
            item.push("planFilePath", or_null(input, "planFilePath"));
            item.push("approvedInTurn", Value::Bool(true));
            item
        }
        b"AskUserQuestion" => return Ok(None),
        _ => mcp_call(block, input)?,
    }))
}

/// What a Bash tool_result says about the run (conformance C19): a command that exits 0 is a plain result whose structured
/// `tool_use_result` has stdout, stderr and `interrupted`, and any other exit is is_error with "Exit code N\n<output>".
/// Where the code isn't stated (a denial, a stop, a tool failure) it stays null: unknown.
fn bash_outcome(text: &Text, is_error: bool, structured: Option<&Value>) -> Result<(Text, Value), Thrown> {
    let live = structured.filter(|value| matches!(value, Value::Object(object) if object.get("stdout").is_some()));
    if !is_error {
        let Some(live) = live else { return Ok((text.clone(), Value::Number(0.0))) };
        let parts = [live.field("stdout"), live.field("stderr")];
        let kept: Vec<Value> = parts.into_iter().flatten().filter(|part| truthy(part)).cloned().collect();
        let exit = if live.field("interrupted").is_some_and(truthy) { Value::Null } else { Value::Number(0.0) };
        return Ok((join(&kept, "\n")?, exit));
    }
    Ok(match re::exit_code(text.as_bytes()) {
        Some((code, length)) => {
            let code = std::str::from_utf8(code).ok().and_then(|code| code.parse().ok()).unwrap_or(f64::NAN);
            (text_from(&text.as_bytes()[length..]), Value::Number(code))
        }
        None => (text.clone(), Value::Null),
    })
}

/// The status a result gives.
fn outcome(declined: bool, is_error: bool) -> &'static str {
    match (declined, is_error) {
        (true, _) => "declined",
        (_, true) => "failed",
        _ => "completed",
    }
}

/// `structured?.structuredPatch?.length`, as a truth.
fn has_patch(structured: Option<&Value>) -> bool {
    match at(structured, "structuredPatch") {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(object)) => object.get("length").is_some_and(truthy),
        _ => false,
    }
}

/// A file tool's changes once its structured result is in.
fn finished_changes(item: &Object, structured: Option<&Value>) -> Result<Option<Value>, Thrown> {
    let create = is(at(structured, "type"), "create");
    if !has_patch(structured) && !create {
        return Ok(None);
    }
    // a file tool's item always names one change
    let path = given(at(structured, "filePath")).or(at(first(item.get("changes")), "path")).cloned().unwrap_or(Value::Null);
    let entry = if create {
        change(path, kind_add(), text_or_empty(at(structured, "content"))?)
    } else {
        change(path, kind_update(), hunks_to_diff(at(structured, "structuredPatch"))?)
    };
    Ok(Some(Value::Array(vec![entry])))
}

/// `completeTool`: a tool item filled in from its `tool_result` block, and the structured `tool_use_result` when live.
pub fn complete_tool(item: &Object, block: &Object, structured: Option<&Value>, started: Option<f64>, when: f64) -> Result<Object, Thrown> {
    let text = result_text(block.get("content"));
    let is_error = block.get("is_error").is_some_and(truthy);
    let declined = is_error && re::was_denied(text.as_bytes());
    // every tool item is recorded with its start time, and both are dropped together
    let duration = Value::Number(when - started.unwrap_or(f64::NAN));
    let mut done = item.clone();
    match item.get("type") {
        kind if is(kind, "commandExecution") => {
            let (output, exit) = if declined { (text.clone(), Value::Null) } else { bash_outcome(&text, is_error, structured)? };
            done.set("status", Value::text(outcome(declined, is_error)));
            done.set("aggregatedOutput", Value::String(output));
            done.set("exitCode", exit);
            done.set("durationMs", duration);
            // the notice is in the result text; the structured result of a background launch has an empty stdout
            if !declined && !is_error && re::find(text.as_bytes(), b"Command running in background with ID: ", 0).is_some() {
                done.set("background", Value::Bool(true));
            }
        }
        kind if is(kind, "fileChange") => {
            if let Some(changes) = finished_changes(item, structured)? {
                done.set("changes", changes);
            }
            done.set("status", Value::text(outcome(declined, is_error)));
        }
        kind if is(kind, "mcpToolCall") => {
            let content = match block.get("content") {
                Some(content @ Value::Array(_)) => content.clone(),
                _ => Value::Array(vec![Value::Object(Object::of([("type", Value::text("text")), ("text", Value::String(text.clone()))]))]),
            };
            let result = Object::of([("content", content), ("structuredContent", Value::Null), ("_meta", Value::Null)]);
            done.set("status", Value::text(if is_error { "failed" } else { "completed" }));
            done.set("result", if is_error { Value::Null } else { Value::Object(result) });
            done.set("error", if is_error { Value::Object(Object::of([("message", Value::String(text))])) } else { Value::Null });
            done.set("durationMs", duration);
        }
        kind if is(kind, "collabAgentToolCall") => {
            let agent = item.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();
            done.set("status", Value::text(if is_error { "failed" } else { "completed" }));
            done.set("agent", Value::Object(agent_result(&agent, block, structured, when)));
        }
        kind if is(kind, "plan") => {
            if !item.get("text").is_some_and(truthy) {
                done.set("text", Value::String(text_or_empty(at(structured, "plan"))?));
            }
            if given(item.get("planFilePath")).is_none() {
                done.set("planFilePath", given(at(structured, "filePath")).cloned().unwrap_or(Value::Null));
            }
        }
        _ => {}
    }
    Ok(done)
}
