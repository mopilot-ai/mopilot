//! The app-server's ThreadItem for each item kind a rollout records (Codex's core TurnItem), by its `type` there: its
//! thread_history projection of the same file, in the shape thread/turns/list answers with. A kind it has no ThreadItem
//! for, or that this does not know, is left out rather than its shape guessed.
//!
//! Each kind gets the item with its keys in camelCase (`c`, a rollout writes either spelling) and as written (`i`). A shape
//! the JS threw a TypeError on is an `Err`, and fails the read as that did: it never was a bad line to skip.

use crate::file_url;
use crate::js::{camel, given, join, to_number, to_text, truthy};
use crate::value::{Object, Text, Value};

/// What a conversion gives, or the JS's TypeError.
type Made<T> = Result<T, String>;

/// An object of these fields in this order. `None` is `undefined`, which stringifying an item leaves out.
fn object(fields: Vec<(&str, Option<Value>)>) -> Object {
    Object::from_entries(fields.into_iter().filter_map(|(key, value)| Some((key.into(), value?))).collect())
}

/// `c[key]`.
fn own(c: &Object, key: &str) -> Option<Value> {
    c.get(key).cloned()
}

/// `value ?? null`.
fn or_null(value: Option<&Value>) -> Value {
    given(value).cloned().unwrap_or(Value::Null)
}

/// `c[key] ?? null`.
fn own_or_null(c: &Object, key: &str) -> Option<Value> {
    Some(or_null(c.get(key)))
}

/// The list in `value ?? []`, for a `.map`: what isn't an array has none, and the JS threw.
fn list<'a>(value: Option<&'a Value>, what: &str) -> Made<&'a [Value]> {
    match given(value) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(format!("a Codex rollout's {what} is not a list")),
    }
}

/// `camel(value)`, which only a string survives.
fn camel_of(value: Option<&Value>, what: &str) -> Made<Value> {
    match value {
        Some(Value::String(text)) => Ok(Value::String(camel(text))),
        _ => Err(format!("a Codex rollout's {what} is not a string")),
    }
}

/// Keys (and, for enum-like strings, values) in snake_case renamed as the app-server's v2 protocol spells them.
fn camelize(value: &Value, values: bool) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| camelize(item, values)).collect()),
        Value::Object(object) => Value::Object(camelize_object(object, values)),
        Value::String(text) if values => Value::String(camel(text)),
        other => other.clone(),
    }
}

fn camelize_object(object: &Object, values: bool) -> Object {
    Object::from_entries(object.entries().iter().map(|(key, item)| (camel(key), camelize(item, values))).collect())
}

/// A path the rollout records as a file:// URL, as the plain path the app-server sends:
/// `decodeURIComponent(new URL(p).pathname)`, whose refusals fail the read.
fn plain_path(path: Option<&Value>) -> Made<Value> {
    match path {
        Some(Value::String(text)) if text.as_bytes().starts_with(b"file://") => {
            let plain = file_url::plain_path(&text.lossy()).ok_or("a Codex rollout's file URL does not read")?;
            Ok(Value::text(&plain))
        }
        _ => Ok(or_null(path)),
    }
}

/// `{ secs, nanos }` in whole milliseconds, by JS's arithmetic.
fn millis(duration: Option<&Value>) -> Made<Value> {
    let Some(duration) = duration.filter(|value| truthy(value)) else {
        return Ok(Value::Null);
    };
    let (secs, nanos) = (to_number(duration.field("secs"))?, to_number(duration.field("nanos"))?);
    Ok(Value::Number(secs * 1000.0 + (nanos / 1e6).floor()))
}

/// One word of a command line, quoted only when the shell needs it (prettyCommand in userText.mjs reads it back). The
/// JS's regex took any value as a string; what it left unquoted is left as it was for the `join` after it.
fn shell_word(word: &Value) -> Made<Value> {
    let text = to_text(word)?;
    let plain = |b: &u8| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(b);
    if !text.as_bytes().is_empty() && text.as_bytes().iter().all(plain) {
        return Ok(word.clone());
    }
    let quoted = |mark: &str, body: &[u8]| {
        let mut quoted = Text::from(mark);
        quoted.push_bytes(body);
        quoted.push_str(mark);
        Ok(Value::String(quoted))
    };
    match word {
        Value::String(text) if text.as_bytes().contains(&b'\'') => {
            let mut escaped = Vec::with_capacity(text.as_bytes().len());
            for &byte in text.as_bytes() {
                if byte == b'\\' || byte == b'"' {
                    escaped.push(b'\\');
                }
                escaped.push(byte);
            }
            quoted("\"", &escaped)
        }
        Value::String(text) => quoted("'", text.as_bytes()),
        // an array has `includes`, of a whole element, but not the `replace` that follows it
        Value::Array(items) if !items.contains(&Value::text("'")) => quoted("'", text.as_bytes()),
        _ => Err("a Codex rollout's command word is not a string".into()),
    }
}

fn command_line(command: Option<&Value>) -> Made<Value> {
    Ok(Value::String(match given(command) {
        Some(Value::Array(words)) => join(&words.iter().map(shell_word).collect::<Made<Vec<_>>>()?, " ")?,
        Some(command) => to_text(command)?,
        None => Text::default(),
    }))
}

/// A user message's input part.
fn user_input(part: &Value) -> Made<Value> {
    if *part == Value::Null {
        return Err("a Codex rollout's message part is null".into());
    }
    let (Value::Object(c), Some(kind)) = (part, part.field("type").map(to_text).transpose()?) else {
        return Ok(camelize(part, false));
    };
    let fields = match kind.as_bytes() {
        b"text" => vec![
            ("type", Some(Value::text("text"))),
            ("text", own(c, "text")),
            ("text_elements", Some(given(c.get("text_elements")).cloned().unwrap_or(Value::Array(vec![])))),
        ],
        b"image" => vec![
            ("type", Some(Value::text("image"))),
            ("detail", own_or_null(c, "detail")),
            ("url", given(c.get("image_url")).or(c.get("url")).cloned()),
        ],
        b"local_image" => {
            vec![("type", Some(Value::text("localImage"))), ("detail", own_or_null(c, "detail")), ("path", own(c, "path"))]
        }
        _ => return Ok(camelize(part, false)),
    };
    Ok(Value::Object(object(fields)))
}

/// An object's `Object.entries`: a list's are its indexes, and a string's are its UTF-16 units.
fn entries(value: Option<&Value>) -> Vec<(Text, Value)> {
    let numbered =
        |values: Vec<Value>| values.into_iter().enumerate().map(|(at, value)| (Text::from(at.to_string().as_str()), value)).collect();
    match given(value) {
        Some(Value::Object(object)) => object.entries().to_vec(),
        Some(Value::Array(items)) => numbered(items.clone()),
        Some(Value::String(text)) => numbered(text.units().map(|unit| Value::String(unit.into())).collect()),
        _ => Vec::new(),
    }
}

fn file_change((path, c): (Text, Value)) -> Made<Value> {
    if c == Value::Null {
        return Err("a Codex rollout's file change is null".into());
    }
    let kind = match c.field("type") {
        Some(Value::String(kind)) if kind.is("update") => {
            object(vec![("type", Some(Value::text("update"))), ("move_path", Some(or_null(c.field("move_path"))))])
        }
        kind => object(vec![("type", kind.cloned())]),
    };
    let diff = given(c.field("unified_diff")).or(given(c.field("content"))).cloned().unwrap_or(Value::text(""));
    Ok(Value::Object(object(vec![("path", Some(Value::String(path))), ("kind", Some(Value::Object(kind))), ("diff", Some(diff))])))
}

/// A command's parsed action; a path it reads is the full path, from the folder the command ran in.
fn command_action(cwd: &Value, action: &Value) -> Made<Value> {
    let Value::Object(a) = action else {
        return Err("a Codex rollout's parsed command is not an object".into());
    };
    let mut out = a.clone();
    let command = out.remove("cmd");
    out.set("type", camel_of(a.get("type"), "parsed command's type")?);
    match command {
        Some(command) => out.set("command", command),
        None => drop(out.remove("command")),
    }
    let reading = matches!(a.get("type"), Some(Value::String(kind)) if kind.is("read"));
    if let (true, Some(Value::String(path)), true) = (reading, a.get("path"), truthy(cwd)) {
        if !path.as_bytes().starts_with(b"/") {
            let Value::String(folder) = cwd else {
                return Err("a Codex rollout's command folder is not a string".into());
            };
            let bytes = folder.as_bytes();
            let mut full = Text::default();
            // the path of a folder that is a string, with its last slash gone, keeps any surrogate it ended in
            full.push_bytes(bytes.strip_suffix(b"/").unwrap_or(bytes));
            full.push_str("/");
            full.push_text(path);
            out.set("path", Value::String(full));
        }
    }
    Ok(Value::Object(out))
}

/// An MCP call's app (a connector's action), as the app-server names it.
fn app_context(c: &Object) -> Option<Value> {
    if let Some(context) = given(c.get("appContext")) {
        return Some(context.clone());
    }
    if !c.get("connectorId").is_some_and(truthy) {
        return Some(Value::Null);
    }
    Some(Value::Object(object(vec![
        ("connectorId", own(c, "connectorId")),
        ("linkId", own_or_null(c, "linkId")),
        ("resourceUri", own_or_null(c, "resourceUri")),
        ("appName", own_or_null(c, "appName")),
        ("actionName", own_or_null(c, "actionName")),
    ])))
}

/// `{ ...value }` onto `into`: a list spreads its indexes, and a string its units.
fn spread(into: &mut Vec<(Text, Value)>, value: &Value) {
    into.extend(entries(Some(value)));
}

/// A web search, with its action's kind (and fields) as the app-server spells them; its results as written.
fn web_search(mut c: Object, i: &Object) -> Made<Object> {
    c.remove("kind");
    c.set("type", Value::text("webSearch"));
    c.set("results", or_null(i.get("results")));
    let Some(action) = c.get("action").filter(|action| truthy(action)).cloned() else {
        return Ok(c);
    };
    let kind = camel_of(Some(given(action.field("type")).unwrap_or(&Value::text("other"))), "web search's action")?;
    let unset: &[&str] = match &kind {
        Value::String(kind) if kind.is("search") => &["query", "queries"],
        Value::String(kind) if kind.is("openPage") => &["url"],
        Value::String(kind) if kind.is("findInPage") => &["url", "pattern"],
        _ => &[],
    };
    let mut fields: Vec<(Text, Value)> = unset.iter().map(|key| (Text::from(*key), Value::Null)).collect();
    spread(&mut fields, &action);
    fields.push(("type".into(), kind));
    c.set("action", Value::Object(Object::from_entries(fields)));
    Ok(c)
}

fn agent_message(c: &Object) -> Made<Object> {
    let mut text = Text::default();
    for part in list(c.get("content"), "agent message")? {
        if *part == Value::Null {
            return Err("a Codex rollout's message part is null".into());
        }
        if let Some(words) = given(part.field("text")) {
            text.push_text(&to_text(words)?);
        }
    }
    Ok(object(vec![
        ("type", Some(Value::text("agentMessage"))),
        ("id", own(c, "id")),
        ("text", Some(Value::String(text))),
        ("phase", own_or_null(c, "phase")),
        ("memoryCitation", own_or_null(c, "memoryCitation")),
        ("delivery", own_or_null(c, "delivery")),
        ("questions", own_or_null(c, "questions")),
    ]))
}

fn command_execution(c: &Object, i: &Object) -> Made<Object> {
    let cwd = plain_path(c.get("cwd"))?;
    let actions = list(i.get("parsed_cmd"), "parsed commands")?.iter().map(|action| command_action(&cwd, action));
    let actions = actions.collect::<Made<Vec<_>>>()?;
    let source = Value::text("agent");
    Ok(object(vec![
        ("type", Some(Value::text("commandExecution"))),
        ("id", own(c, "id")),
        ("pluginId", own_or_null(c, "pluginId")),
        ("scriptPath", own_or_null(c, "scriptPath")),
        ("command", Some(command_line(c.get("command"))?)),
        ("cwd", Some(cwd)),
        ("processId", own_or_null(c, "processId")),
        ("source", Some(camel_of(Some(given(c.get("source")).unwrap_or(&source)), "command's source")?)),
        ("status", Some(camel_of(c.get("status"), "command's status")?)),
        ("commandActions", Some(Value::Array(actions))),
        ("aggregatedOutput", Some(c.get("aggregatedOutput").filter(|output| truthy(output)).cloned().unwrap_or(Value::Null))),
        ("exitCode", own_or_null(c, "exitCode")),
        ("durationMs", Some(millis(c.get("duration"))?)),
    ]))
}

fn file_changes(i: &Object) -> Made<Object> {
    let mut changes = entries(i.get("changes"));
    // paths are the keys of one object, so no two are equal
    changes.sort_by(|(a, _), (b, _)| a.compare_units(b));
    let changes = changes.into_iter().map(file_change).collect::<Made<Vec<_>>>()?;
    Ok(object(vec![
        ("type", Some(Value::text("fileChange"))),
        ("id", own(i, "id")),
        ("changes", Some(Value::Array(changes))),
        ("status", Some(camel_of(i.get("status"), "file change's status")?)),
    ]))
}

fn mcp_tool_call(c: &Object, i: &Object) -> Made<Object> {
    let result = i.get("result").filter(|result| truthy(result)).map(|result| {
        let content = given(result.field("content")).cloned().unwrap_or(Value::Array(vec![]));
        Value::Object(object(vec![
            ("content", Some(content)),
            ("structuredContent", Some(or_null(given(result.field("structured_content")).or(result.field("structuredContent"))))),
            ("_meta", Some(or_null(result.field("_meta")))),
        ]))
    });
    Ok(object(vec![
        ("type", Some(Value::text("mcpToolCall"))),
        ("id", own(c, "id")),
        ("server", own(c, "server")),
        ("tool", own(c, "tool")),
        ("status", Some(camel_of(c.get("status"), "tool call's status")?)),
        ("arguments", own_or_null(i, "arguments")),
        ("appContext", app_context(c)),
        ("mcpAppUi", own_or_null(c, "mcpAppUi")),
        ("pluginId", own_or_null(c, "pluginId")),
        ("readOnlyHint", own_or_null(c, "readOnlyHint")),
        ("result", result.or(Some(Value::Null))),
        ("error", own_or_null(c, "error")),
        ("durationMs", Some(millis(c.get("duration"))?)),
    ]))
}

/// `{ ...c, type }`.
fn retyped(mut c: Object, kind: &str) -> Object {
    c.set("type", Value::text(kind));
    c
}

/// An extension's item, by its kind: those with a ThreadItem of their own.
fn extension(mut c: Object, i: &Object) -> Made<Option<Object>> {
    let kind = c.get("kind").map(to_text).transpose()?.unwrap_or_default();
    Ok(Some(match kind.as_bytes() {
        b"clock.sleep" => {
            object(vec![("type", Some(Value::text("sleep"))), ("id", own(&c, "id")), ("durationMs", own_or_null(&c, "durationMs"))])
        }
        b"web.search" => web_search(c, i)?,
        b"image_gen.generation" => {
            c.remove("kind");
            retyped(c, "imageGeneration")
        }
        _ => return Ok(None),
    }))
}

fn collab_tool_call(mut c: Object) -> Made<Object> {
    let status = camel_of(c.get("status"), "agent call's status")?;
    c.remove("receiverAgents");
    let mut fields: Vec<(Text, Value)> = ["prompt", "model", "reasoningEffort"].map(|key| (key.into(), Value::Null)).to_vec();
    fields.extend(c.into_entries());
    let mut made = Object::from_entries(fields);
    made.set("type", Value::text("collabAgentToolCall"));
    made.set("status", status);
    Ok(made)
}

fn dynamic_tool_call(mut c: Object) -> Made<Object> {
    let duration = c.remove("duration");
    let status = camel_of(c.get("status"), "tool call's status")?;
    let took = match given(c.get("durationMs")) {
        Some(took) => took.clone(),
        None => millis(duration.as_ref())?,
    };
    c.set("type", Value::text("dynamicToolCall"));
    c.set("status", status);
    c.set("durationMs", took);
    Ok(c)
}

/// The conversion of a known kind, or `None` for a kind this leaves out.
fn convert(kind: &[u8], c: Object, i: &Object) -> Made<Option<Object>> {
    Ok(Some(match kind {
        b"UserMessage" => {
            let content = list(i.get("content"), "user message")?.iter().map(user_input).collect::<Made<Vec<_>>>()?;
            object(vec![
                ("type", Some(Value::text("userMessage"))),
                ("id", own(&c, "id")),
                ("clientId", own_or_null(&c, "clientId")),
                ("content", Some(Value::Array(content))),
            ])
        }
        b"AgentMessage" => agent_message(&c)?,
        b"Reasoning" => object(vec![
            ("type", Some(Value::text("reasoning"))),
            ("id", own(&c, "id")),
            ("summary", Some(given(c.get("summaryText")).cloned().unwrap_or(Value::Array(vec![])))),
            ("content", Some(given(c.get("rawContent")).cloned().unwrap_or(Value::Array(vec![])))),
        ]),
        b"Plan" => object(vec![("type", Some(Value::text("plan"))), ("id", own(&c, "id")), ("text", own(&c, "text"))]),
        b"CommandExecution" => command_execution(&c, i)?,
        b"FileChange" => file_changes(i)?,
        b"McpToolCall" => mcp_tool_call(&c, i)?,
        b"WebSearch" => web_search(c, i)?,
        b"ImageView" => {
            object(vec![("type", Some(Value::text("imageView"))), ("id", own(&c, "id")), ("path", Some(plain_path(c.get("path"))?))])
        }
        b"ImageGeneration" => retyped(c, "imageGeneration"),
        b"ContextCompaction" => object(vec![("type", Some(Value::text("contextCompaction"))), ("id", own(&c, "id"))]),
        b"SubAgentActivity" => retyped(c, "subAgentActivity"),
        b"CollabAgentToolCall" => collab_tool_call(c)?,
        b"DynamicToolCall" => dynamic_tool_call(c)?,
        b"FunctionCallOutput" => {
            let mut c = c;
            match i.get("output") {
                Some(output) => c.set("output", output.clone()),
                None => drop(c.remove("output")),
            }
            retyped(c, "functionCallOutput")
        }
        b"Extension" => return extension(c, i),
        _ => return Ok(None),
    }))
}

/// The item as the app-server sends it, or `None` for a kind it has no ThreadItem for (or that this does not know).
pub fn item_from_rollout(item: Option<&Value>) -> Made<Option<Object>> {
    let Some(Value::Object(i)) = item else {
        return Ok(None);
    };
    let Some(kind) = i.get("type").map(to_text).transpose()? else {
        return Ok(None);
    };
    convert(kind.as_bytes(), camelize_object(i, false), i)
}

/// A turn's error as the app-server sends it: its error info's variant (and fields) in camelCase.
pub fn turn_error(error: &Value) -> Value {
    if !truthy(error) {
        return Value::Null;
    }
    Value::Object(object(vec![
        ("message", Some(given(error.field("message")).cloned().unwrap_or(Value::text("")))),
        ("codexErrorInfo", Some(camelize(given(error.field("codex_error_info")).unwrap_or(&Value::Null), true))),
        ("additionalDetails", Some(or_null(error.field("additional_details")))),
    ]))
}
