//! A tool call's merged state as a thread item (`toolItem` of shared/acpItems/toolItems.mjs). The kind decides the card: a
//! diff in its content, or an edit whose file it names, makes it an edit, execute a command, read and search the
//! explored-files rows, fetch a web item, everything else a generic tool card.

use crate::blocks::{content_blocks, normalize, tool_output};
use crate::edits::edit_changes;
use crate::reads::{at, first, is, line_end, status_of, string, text_from, text_of, text_or_empty};
use crate::Thrown;
use jsvalue::js::{given, is_safe_integer, join, truthy};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};

const BROWSER_SERVERS: [&[u8]; 2] = [b"mopilot_chrome", b"claude-in-chrome"];

/// `/^mcp__(.+?)__(.+)$/.exec(title)`: the server and the tool it names. `.` takes no line terminator, so there is none
/// anywhere in a title that matches.
fn mcp_name(title: &[u8]) -> Option<(&[u8], &[u8])> {
    let name = title.strip_prefix(b"mcp__")?;
    if line_end(name, 0).is_some() {
        return None;
    }
    (1..name.len().saturating_sub(2)).find(|at| name[*at..].starts_with(b"__")).map(|at| (&name[..at], &name[at + 2..]))
}

/// What a command call ran.
fn command_of(tc: &Object) -> Result<Text, Thrown> {
    let input = tc.get("rawInput");
    match given(at(input, "command")).or(given(at(input, "cmd"))) {
        Some(Value::Array(words)) => join(words, " "),
        Some(Value::String(command)) => Ok(command.clone()),
        _ => text_or_empty(tc.get("title")),
    }
}

/// A call's process exit code: its own when it reports a whole one, else what its status says.
fn exit_code(tc: &Object, status: &str) -> Value {
    match at(tc.get("rawOutput"), "exitCode") {
        Some(code) if is_safe_integer(code) => code.clone(),
        Some(_) => Value::Null,
        None if status == "completed" => Value::Number(0.0),
        None if status == "failed" => Value::Number(1.0),
        None => Value::Null,
    }
}

/// The commandExecution item of a call.
fn command_item(tc: &Object, id: &Text, status: &str, cwd: &Value, actions: Vec<Value>, command: Text) -> Result<Object, Thrown> {
    let output = tool_output(tc.get("content"))?;
    let output = if output.is_empty() { string(at(tc.get("rawOutput"), "output")).cloned() } else { Some(output) };
    Ok(Object::of([
        ("type", Value::text("commandExecution")),
        ("id", Value::String(id.clone())),
        ("command", Value::String(command)),
        ("cwd", cwd.clone()),
        ("processId", Value::Null),
        ("source", Value::text("agent")),
        ("status", Value::text(status)),
        ("commandActions", Value::Array(actions)),
        ("aggregatedOutput", output.map_or(Value::Null, Value::String)),
        ("exitCode", exit_code(tc, status)),
        ("durationMs", Value::Null),
        ("pluginId", Value::Null),
        ("scriptPath", Value::Null),
    ]))
}

/// `value ?? text`, as a value.
fn or_text(value: Option<&Value>, text: &str) -> Value {
    given(value).cloned().unwrap_or_else(|| Value::text(text))
}

/// A read: the file it names, or failing that its title.
fn read_action(tc: &Object, path: &Value) -> Result<Value, Thrown> {
    let title = tc.get("title");
    let named = if *path == Value::Null { title } else { Some(path) };
    let named = text_or_empty(named)?;
    let name = named.as_bytes().rsplit(|byte| *byte == b'/').next().unwrap_or_default();
    Ok(Value::Object(Object::of([
        ("type", Value::text("read")),
        ("command", or_text(title, "Read")),
        ("name", Value::String(text_from(name))),
        ("path", if *path == Value::Null { Value::text("") } else { path.clone() }),
    ])))
}

/// A read's command line.
fn read_command(tc: &Object, path: &Value) -> Result<Text, Thrown> {
    if let Some(title) = given(tc.get("title")) {
        return text_of(Some(title));
    }
    let mut command = Text::from("Read ");
    command.push_text(&text_or_empty(Some(path))?);
    Ok(command)
}

/// A search: what it looks for and where.
fn search_action(tc: &Object, path: &Value) -> Value {
    let (input, title) = (tc.get("rawInput"), tc.get("title"));
    let query = given(at(input, "pattern")).or(given(at(input, "query"))).or(given(title));
    Value::Object(Object::of([
        ("type", Value::text("search")),
        ("command", or_text(title, "Search")),
        ("query", query.cloned().unwrap_or(Value::Null)),
        ("path", path.clone()),
    ]))
}

/// A fetch of a page, or a search of the web.
fn web_item(tc: &Object, id: &Text) -> Result<Object, Thrown> {
    let input = tc.get("rawInput");
    let url = at(input, "url").filter(|url| truthy(url));
    let query = || given(at(input, "query")).or(given(tc.get("title")));
    let action = match url {
        Some(url) => Object::of([("type", Value::text("openPage")), ("url", url.clone())]),
        None => Object::of([("type", Value::text("search")), ("query", Value::String(text_or_empty(query())?))]),
    };
    Ok(Object::of([
        ("type", Value::text("webSearch")),
        ("id", Value::String(id.clone())),
        ("query", if url.is_some() { Value::text("") } else { Value::String(text_or_empty(query())?) }),
        ("action", Value::Object(action)),
        ("results", Value::Null),
    ]))
}

/// What a finished generic call gave back: its text and its images.
fn call_result(tc: &Object, text: &Text) -> Value {
    let blocks = content_blocks(tc.get("content"));
    let images = blocks.iter().filter(|block| is(block.get("type"), "content")).filter_map(|block| normalize(block.get("content")));
    let images = images.filter(|block| is(block.get("type"), "image")).map(|block| Value::Object(block.into_owned()));
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(Value::Object(Object::of([("type", Value::text("text")), ("text", Value::String(text.clone()))])));
    }
    content.extend(images);
    Value::Object(Object::of([("content", Value::Array(content)), ("structuredContent", Value::Null), ("_meta", Value::Null)]))
}

/// A generic tool card.
fn mcp_item(tc: &Object, id: &Text, status: &str, title: &Text) -> Result<Object, Thrown> {
    let name = mcp_name(title.as_bytes());
    let text = tool_output(tc.get("content"))?;
    let message = if text.is_empty() { Text::from("Failed") } else { text.clone() };
    Ok(Object::of([
        ("type", Value::text("mcpToolCall")),
        ("id", Value::String(id.clone())),
        ("server", Value::String(name.map(|(server, _)| text_from(server)).unwrap_or_default())),
        ("tool", Value::String(name.map_or_else(|| title.clone(), |(_, tool)| text_from(tool)))),
        ("status", Value::text(status)),
        ("arguments", given(tc.get("rawInput")).cloned().unwrap_or(Value::Object(Object::default()))),
        ("appContext", Value::Null),
        ("mcpAppUi", Value::Null),
        ("pluginId", Value::Null),
        ("readOnlyHint", Value::Null),
        ("result", if status == "completed" { call_result(tc, &text) } else { Value::Null }),
        ("error", if status == "failed" { Value::Object(Object::of([("message", Value::String(message))])) } else { Value::Null }),
        ("durationMs", Value::Null),
    ]))
}

/// The thread item for a tool call (its merged state so far). A Chrome MCP call keeps its protocol identity and image output
/// even when an ACP server calls it a read or execute.
pub fn tool_item(tc: &Object, cwd: &Value) -> Result<Object, Thrown> {
    let id = text_of(tc.get("toolCallId"))?;
    let title = given(tc.get("title")).map_or(Ok(Text::from("Tool")), |title| text_of(Some(title)))?;
    let status = status_of(tc);
    let changes = edit_changes(tc)?;
    if !changes.is_empty() {
        let (kind, id) = (Value::text("fileChange"), Value::String(id));
        return Ok(Object::of([("type", kind), ("id", id), ("status", Value::text(status)), ("changes", Value::Array(changes))]));
    }
    let input = tc.get("rawInput");
    let path = given(at(first(tc.get("locations")), "path")).or(given(at(input, "path"))).or(given(at(input, "file_path")));
    let path = path.cloned().unwrap_or(Value::Null);
    let browser = mcp_name(title.as_bytes()).is_some_and(|(server, _)| BROWSER_SERVERS.contains(&server));
    let kind = if browser { None } else { tc.get("kind") };
    if is(kind, "execute") {
        let item = command_item(tc, &id, status, cwd, Vec::new(), command_of(tc)?)?;
        let described = string(at(input, "description")).map(|text| trim(text.as_bytes())).filter(|text| !text.is_empty());
        return Ok(described.into_iter().fold(item, |mut item, text| {
            item.push("description", Value::String(text_from(text)));
            item
        }));
    }
    if is(kind, "read") {
        let command = read_command(tc, &path)?;
        return command_item(tc, &id, status, cwd, vec![read_action(tc, &path)?], command);
    }
    if is(kind, "search") {
        let command = given(tc.get("title")).map_or(Ok(Text::from("Search")), |title| text_of(Some(title)))?;
        return command_item(tc, &id, status, cwd, vec![search_action(tc, &path)], command);
    }
    if is(kind, "fetch") {
        return web_item(tc, &id);
    }
    mcp_item(tc, &id, status, &title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsvalue::json::{parse, write, Numbers};

    fn call(text: &str) -> Object {
        parse(text).as_ref().and_then(Value::as_object).expect("an object").clone()
    }

    fn item(text: &str) -> Value {
        Value::Object(tool_item(&call(text), &Value::text("/w")).expect("an item"))
    }

    fn json(value: Option<&Value>) -> String {
        let mut out = Vec::new();
        write(&mut out, value.expect("a field"), Numbers::Stringified);
        String::from_utf8(out).expect("UTF-8")
    }

    fn field(value: &Value, key: &str) -> String {
        json(value.field(key))
    }

    #[test]
    fn an_mcp_title_names_its_server_and_tool() {
        let name = |title: &str| mcp_name(title.as_bytes()).map(|(a, b)| (a.to_vec(), b.to_vec()));
        let pair = |a: &str, b: &str| Some((a.as_bytes().to_vec(), b.as_bytes().to_vec()));
        assert_eq!(name("mcp__fs__read"), pair("fs", "read"));
        assert_eq!(name("mcp__a__b__c"), pair("a", "b__c"));
        assert_eq!(name("mcp_____x"), pair("_", "x"));
        assert_eq!(name("mcp__a____"), pair("a", "__"));
        for title in ["mcp__a__", "mcp____b", "mcp__a", "mcp__", "mcp__ab", "x__a__b", "mcp__a__b\n", "mcp__a\r__b", "mcp__a__b\u{2029}"] {
            assert_eq!(name(title), None, "{title:?}");
        }
    }

    #[test]
    fn a_command_reads_from_its_input_or_its_title() {
        let command = |call: &str| command_of(&self::call(call)).expect("a command").lossy();
        assert_eq!(command(r#"{"rawInput":{"command":["ls","-l",1,null]}}"#), "ls -l 1 ");
        assert_eq!(command(r#"{"rawInput":{"cmd":"ls"}}"#), "ls");
        assert_eq!(command(r#"{"rawInput":{"command":null,"cmd":"pwd"}}"#), "pwd");
        assert_eq!(command(r#"{"rawInput":{"command":7},"title":"t"}"#), "t");
        assert_eq!(command(r#"{"title":"t"}"#), "t");
        assert_eq!(command("{}"), "");
    }

    #[test]
    fn an_exit_code_is_the_calls_when_it_is_whole() {
        let code = |output: &str, status: &str| exit_code(&call(&format!(r#"{{"rawOutput":{output}}}"#)), status);
        assert_eq!(code(r#"{"exitCode":3}"#, "completed"), Value::Number(3.0));
        assert_eq!(code(r#"{"exitCode":1.5}"#, "completed"), Value::Null);
        assert_eq!(code(r#"{"exitCode":"3"}"#, "failed"), Value::Null);
        assert_eq!(code(r#"{"exitCode":null}"#, "failed"), Value::Null);
        assert_eq!(code(r#"{"exitCode":9007199254740992}"#, "completed"), Value::Null);
        assert_eq!(code("{}", "completed"), Value::Number(0.0));
        assert_eq!(code("{}", "failed"), Value::Number(1.0));
        assert_eq!(code("{}", "inProgress"), Value::Null);
        assert_eq!(code(r#""text""#, "completed"), Value::Number(0.0));
    }

    #[test]
    fn an_execute_call_is_a_command_with_its_description() {
        let run = item(r#"{"toolCallId":"c","kind":"execute","title":"ls","rawInput":{"description":"  list  "},"status":"completed"}"#);
        assert_eq!(field(&run, "type"), r#""commandExecution""#);
        assert_eq!(field(&run, "description"), r#""list""#);
        assert_eq!(field(&run, "exitCode"), "0");
        let quiet = item(r#"{"toolCallId":"c","kind":"execute","rawInput":{"description":"   "}}"#);
        assert_eq!(quiet.field("description"), None);
        let number = item(r#"{"toolCallId":"c","kind":"execute","rawInput":{"description":7}}"#);
        assert_eq!(number.field("description"), None);
    }

    #[test]
    fn a_commands_output_is_its_content_or_its_raw_output() {
        let shown =
            item(r#"{"kind":"execute","content":[{"type":"content","content":{"type":"text","text":"a"}}],"rawOutput":{"output":"b"}}"#);
        assert_eq!(field(&shown, "aggregatedOutput"), r#""a""#);
        assert_eq!(field(&item(r#"{"kind":"execute","rawOutput":{"output":"b"}}"#), "aggregatedOutput"), r#""b""#);
        assert_eq!(field(&item(r#"{"kind":"execute","rawOutput":{"output":7}}"#), "aggregatedOutput"), "null");
    }

    #[test]
    fn a_read_names_its_file_and_a_search_its_query() {
        let read = item(r#"{"toolCallId":"r","kind":"read","title":"Read a","locations":[{"path":"/w/a.ts"}]}"#);
        assert_eq!(field(&read, "command"), r#""Read a""#);
        assert_eq!(field(&read, "commandActions"), r#"[{"type":"read","command":"Read a","name":"a.ts","path":"/w/a.ts"}]"#);
        let bare = item(r#"{"toolCallId":"r","kind":"read"}"#);
        assert_eq!(field(&bare, "command"), r#""Read ""#);
        assert_eq!(field(&bare, "commandActions"), r#"[{"type":"read","command":"Read","name":"","path":""}]"#);
        let input = item(r#"{"toolCallId":"r","kind":"read","rawInput":{"file_path":"/x/b"}}"#);
        assert_eq!(field(&input, "command"), r#""Read /x/b""#);
        let titled = item(r#"{"toolCallId":"r","kind":"read","title":"dir/name"}"#);
        assert_eq!(field(&titled, "commandActions"), r#"[{"type":"read","command":"dir/name","name":"name","path":""}]"#);
        let search = item(r#"{"toolCallId":"s","kind":"search","title":"grep","rawInput":{"query":"q","path":"/w"}}"#);
        assert_eq!(field(&search, "commandActions"), r#"[{"type":"search","command":"grep","query":"q","path":"/w"}]"#);
        let plain = item(r#"{"toolCallId":"s","kind":"search"}"#);
        assert_eq!(field(&plain, "command"), r#""Search""#);
        assert_eq!(field(&plain, "commandActions"), r#"[{"type":"search","command":"Search","query":null,"path":null}]"#);
        let pattern = item(r#"{"toolCallId":"s","kind":"search","title":"t","rawInput":{"pattern":"p","query":"q"}}"#);
        assert_eq!(field(&pattern, "commandActions"), r#"[{"type":"search","command":"t","query":"p","path":null}]"#);
    }

    #[test]
    fn a_fetch_is_a_page_or_a_search() {
        let page = item(r#"{"toolCallId":"f","kind":"fetch","rawInput":{"url":"https://x"}}"#);
        assert_eq!(field(&page, "query"), r#""""#);
        assert_eq!(field(&page, "action"), r#"{"type":"openPage","url":"https://x"}"#);
        let search = item(r#"{"toolCallId":"f","kind":"fetch","title":"t","rawInput":{"url":"","query":"q"}}"#);
        assert_eq!(field(&search, "query"), r#""q""#);
        assert_eq!(field(&search, "action"), r#"{"type":"search","query":"q"}"#);
        assert_eq!(field(&item(r#"{"kind":"fetch","title":"t"}"#), "query"), r#""t""#);
        assert_eq!(field(&item(r#"{"kind":"fetch"}"#), "query"), r#""""#);
    }

    #[test]
    fn a_generic_call_is_a_tool_card() {
        let content = r#"[{"type":"content","content":{"type":"text","text":"out"}},{"type":"content","content":{"type":"image","data":"d"}},
            {"type":"content","content":null},{"type":"other","content":{"type":"image"}}]"#;
        let done =
            item(&format!(r#"{{"toolCallId":"m","title":"mcp__fs__read","status":"completed","rawInput":{{"a":1}},"content":{content}}}"#));
        assert_eq!((field(&done, "server"), field(&done, "tool")), (r#""fs""#.to_string(), r#""read""#.to_string()));
        assert_eq!(field(&done, "arguments"), r#"{"a":1}"#);
        let result =
            r#"{"content":[{"type":"text","text":"out\n[image]"},{"type":"image","data":"d"}],"structuredContent":null,"_meta":null}"#;
        assert_eq!(field(&done, "result"), result);
        assert_eq!(field(&done, "error"), "null");
        let failed = item(r#"{"toolCallId":"m","title":"plain","status":"failed","rawInput":null}"#);
        assert_eq!((field(&failed, "server"), field(&failed, "tool")), (r#""""#.to_string(), r#""plain""#.to_string()));
        assert_eq!(field(&failed, "arguments"), "{}");
        assert_eq!((field(&failed, "result"), field(&failed, "error")), ("null".to_string(), r#"{"message":"Failed"}"#.to_string()));
        let said = item(r#"{"status":"failed","content":[{"type":"content","content":{"type":"text","text":"bad"}}]}"#);
        assert_eq!(field(&said, "error"), r#"{"message":"bad"}"#);
        let empty = item(r#"{"status":"completed"}"#);
        assert_eq!(field(&empty, "result"), r#"{"content":[],"structuredContent":null,"_meta":null}"#);
        assert_eq!(field(&empty, "tool"), r#""Tool""#);
        assert_eq!(field(&empty, "id"), r#""undefined""#);
    }

    #[test]
    fn a_browser_call_keeps_its_card_whatever_its_kind() {
        for server in ["mopilot_chrome", "claude-in-chrome"] {
            let card = item(&format!(r#"{{"title":"mcp__{server}__click","kind":"execute"}}"#));
            assert_eq!(field(&card, "type"), r#""mcpToolCall""#);
        }
        assert_eq!(field(&item(r#"{"title":"mcp__other__click","kind":"execute"}"#), "type"), r#""commandExecution""#);
    }

    #[test]
    fn an_edit_it_can_place_is_a_file_change() {
        let edit =
            item(r#"{"toolCallId":"e","kind":"edit","status":"completed","rawInput":{"path":"/a","oldString":"x","newString":"y"}}"#);
        assert_eq!(field(&edit, "type"), r#""fileChange""#);
        assert_eq!(field(&edit, "status"), r#""completed""#);
    }

    #[test]
    fn what_has_no_string_throws_as_the_js_did() {
        let bad = r#"{"toString":1}"#;
        for call in [
            format!(r#"{{"toolCallId":{bad}}}"#),
            format!(r#"{{"title":{bad}}}"#),
            format!(r#"{{"kind":"execute","rawInput":{{"command":[{bad}]}}}}"#),
            format!(r#"{{"kind":"execute","title":{bad}}}"#),
            format!(r#"{{"kind":"read","rawInput":{{"path":{bad}}}}}"#),
            format!(r#"{{"kind":"search","title":{bad}}}"#),
            format!(r#"{{"kind":"fetch","rawInput":{{"query":{bad}}}}}"#),
            format!(r#"{{"content":[{{"type":"content","content":{{"type":"resource_link","uri":{bad}}}}}]}}"#),
            format!(r#"{{"kind":"edit","content":[{{"type":"diff","oldText":{bad}}}]}}"#),
            format!(r#"{{"kind":"execute","content":[{{"type":"content","content":{{"type":"resource_link","uri":{bad}}}}}]}}"#),
        ] {
            assert!(tool_item(&self::call(&call), &Value::Null).is_err(), "{call}");
        }
    }
}
