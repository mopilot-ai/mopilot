//! The bridge's two directions: the harness's lines (answered here, forwarded to the tool socket, or held until the
//! socket accepts hello) and the socket's (its answer to hello, then lines for the harness), and how it ends.

use crate::VERSION;
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The MCP revision initialize answers with when the harness names none.
const PROTOCOL: &str = "2025-06-18";

/// How the bridge ended: its exit code, and what it says on stderr first.
pub(crate) type End = (i32, Option<String>);

/// What both directions share: whether the socket accepted hello, the harness's lines waiting until it has (and
/// whether the harness closed stdin meanwhile), the socket's writer, and the name the socket gave this server.
pub(crate) struct State {
    pub(crate) greeted: bool,
    pub(crate) queued: Vec<String>,
    pub(crate) stdin_closed: bool,
    pub(crate) server_name: String,
    pub(crate) socket: Box<dyn Write + Send>,
}

pub(crate) struct Bridge {
    pub(crate) state: Mutex<State>,
    pub(crate) stdout: Mutex<Box<dyn Write + Send>>,
    pub(crate) done: Sender<End>,
}

/// A poisoned lock's data is still whole here: every critical section writes a line or flips a flag.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Bridge {
    fn end(&self, code: i32, message: Option<String>) {
        // the first end is the one run returns; a later one finds nobody listening
        let _ = self.done.send((code, message));
    }

    /// One line to the harness; the harness having gone away ends the bridge, as there is nobody left to serve.
    fn to_harness(&self, line: &str) {
        let mut out = lock(&self.stdout);
        if out.write_all(format!("{line}\n").as_bytes()).and_then(|()| out.flush()).is_err() {
            self.end(0, None);
        }
    }

    /// An answer to the harness's request `id`: its `result` or its `error`.
    fn reply(&self, id: &Value, key: &str, value: Value) {
        let mut msg = serde_json::Map::new();
        msg.insert("jsonrpc".into(), json!("2.0"));
        msg.insert("id".into(), id.clone());
        msg.insert(key.into(), value);
        self.to_harness(&Value::Object(msg).to_string());
    }

    /// One line the harness sent, once the socket has accepted hello: answered here, forwarded, or let go.
    fn handle(&self, state: &mut State, line: &str) {
        if line.is_empty() {
            return;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return self.reply(&Value::Null, "error", json!({ "code": -32700, "message": "Parse error" }));
        };
        let method = msg.get("method").and_then(Value::as_str);
        let id = msg.get("id").filter(|id| !id.is_null());
        // the harness cancelling a call goes to the socket, which stops that call; it needs no answer
        if method == Some("notifications/cancelled") && msg.get("id").is_none() {
            let _ = forward(state, line);
            return;
        }
        // other notifications and responses need no answer
        let (Some(method), Some(id)) = (method, id) else { return };
        match method {
            "initialize" => {
                let version = msg.pointer("/params/protocolVersion").filter(|v| !v.is_null()).cloned().unwrap_or(json!(PROTOCOL));
                let result = json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": true } },
                    "serverInfo": { "name": state.server_name, "version": VERSION },
                });
                self.reply(id, "result", result);
            }
            "ping" => self.reply(id, "result", json!({})),
            "tools/list" | "tools/call" => {
                if forward(state, line).is_err() {
                    self.reply(id, "error", json!({ "code": -32603, "message": "MoPilot is not reachable" }));
                }
            }
            _ => self.reply(id, "error", json!({ "code": -32601, "message": format!("Method not found: {method}") })),
        }
    }

    /// What the socket says: its answer to hello, then lines for the harness. Its closing ends the bridge.
    pub(crate) fn serve_socket(&self, socket: impl Read) {
        let refused = || "MoPilot refused the connection".to_string();
        for line in BufReader::new(socket).lines() {
            let line = match line {
                Ok(line) => line,
                Err(e) => {
                    // once hello is accepted, a broken connection is main letting the session go (Windows resets a
                    // socket it destroys with bytes unread), as a close is
                    let greeted = lock(&self.state).greeted;
                    return if greeted { self.end(0, None) } else { self.end(1, Some(format!("can't reach MoPilot: {e}"))) };
                }
            };
            if line.is_empty() {
                continue;
            }
            let mut state = lock(&self.state);
            if state.greeted {
                self.to_harness(&line);
                continue;
            }
            let Ok(reply) = serde_json::from_str::<Value>(&line) else { return self.end(1, Some(refused())) };
            if let Some(error) = reply.get("error") {
                let why = error.get("message").and_then(Value::as_str).unwrap_or("");
                return self.end(1, Some(format!("{}: {why}", refused())));
            }
            if let Some(name) = reply.pointer("/result/serverName").and_then(Value::as_str) {
                state.server_name = name.to_string();
            }
            state.greeted = true;
            // under the same lock as the harness's next line, so what waited goes first
            for queued in std::mem::take(&mut state.queued) {
                self.handle(&mut state, &queued);
            }
            // the harness closed stdin before hello was accepted: what it sent has now been served
            if state.stdin_closed {
                return self.end(0, None);
            }
        }
        // the socket went away (or revoked this session): nothing more can be served
        let greeted = lock(&self.state).greeted;
        if greeted {
            self.end(0, None)
        } else {
            self.end(1, Some(refused()))
        }
    }

    /// What the harness says; its closing stdin ends the bridge, as it does the Swift one, once what it sent before
    /// hello was accepted has been served.
    pub(crate) fn serve_harness(&self, stdin: impl Read) {
        let mut reader = BufReader::new(stdin);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            // a line that is not UTF-8 is still a line: handle() answers what does not parse
            let text = String::from_utf8_lossy(&bytes);
            let line = text.trim_end_matches(['\n', '\r']).to_string();
            let mut state = lock(&self.state);
            if state.greeted {
                self.handle(&mut state, &line);
            } else {
                state.queued.push(line);
            }
        }
        let mut state = lock(&self.state);
        if state.greeted {
            self.end(0, None);
        } else {
            state.stdin_closed = true;
        }
    }
}

fn forward(state: &mut State, line: &str) -> io::Result<()> {
    state.socket.write_all(format!("{line}\n").as_bytes())?;
    state.socket.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{Broken, Buf, ThenBroken, ACCEPTED};
    use std::io::Cursor;
    use std::sync::mpsc::{self, Receiver};

    fn bridge(socket: impl Write + Send + 'static, stdout: impl Write + Send + 'static) -> (Bridge, Receiver<End>) {
        let (done, ended) = mpsc::channel();
        let state = State { greeted: false, queued: Vec::new(), stdin_closed: false, server_name: "sage".into(), socket: Box::new(socket) };
        (Bridge { state: Mutex::new(state), stdout: Mutex::new(Box::new(stdout)), done }, ended)
    }

    #[test]
    fn what_the_harness_sends_before_hello_is_accepted_waits_then_goes_in_order() {
        let (socket, out) = (Buf::default(), Buf::default());
        let (b, ended) = bridge(socket.clone(), out.clone());
        let early = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\"}}\n\
                     {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n";
        // the harness writes and closes stdin before hello is answered: nothing ends, and nothing goes anywhere yet
        b.serve_harness(Cursor::new(early));
        assert!(ended.try_recv().is_err(), "a closed stdin waits for what it sent to be served");
        // nothing goes anywhere before hello is accepted
        assert_eq!((out.text(), socket.text()), (String::new(), String::new()));
        b.serve_socket(Cursor::new(format!("\n{ACCEPTED}{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"tools\":[]}}}}\n")));
        // served, then ended: the harness has gone
        assert_eq!(ended.recv().expect("served"), (0, None));
        let lines = out.values();
        assert_eq!(lines[0]["result"]["serverInfo"], json!({ "name": "mopilot_7", "version": VERSION }));
        assert_eq!(lines[0]["result"]["protocolVersion"], "2025-03-26");
        // the socket says list_changed when a tiered session's groups change: the harness is told to listen for it
        assert_eq!(lines[0]["result"]["capabilities"], json!({ "tools": { "listChanged": true } }));
        assert_eq!(lines.len(), 1);
        assert_eq!(socket.text(), "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n");
    }

    #[test]
    fn each_kind_of_line_from_the_harness_is_answered_forwarded_or_let_go() {
        let (socket, out) = (Buf::default(), Buf::default());
        let (b, _ended) = bridge(socket.clone(), out.clone());
        b.serve_socket(Cursor::new("{\"jsonrpc\":\"2.0\",\"id\":\"hello\",\"result\":{}}\n"));
        let lines = [
            "",
            "not json",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"initialize\",\"params\":{\"protocolVersion\":null}}",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"x\"}}",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"resources/list\"}",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":4}}",
            "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"notifications/cancelled\"}",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}",
        ];
        for line in lines {
            b.handle(&mut lock(&b.state), line);
        }
        let replies = out.values();
        assert_eq!(replies[0], json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }));
        // no name from the socket: the server keeps its own, and no revision from the harness: the default one
        assert_eq!(replies[1]["result"]["serverInfo"]["name"], "sage");
        assert_eq!(replies[1]["result"]["protocolVersion"], PROTOCOL);
        assert_eq!(replies[2]["result"]["protocolVersion"], PROTOCOL);
        assert_eq!(replies[3], json!({ "jsonrpc": "2.0", "id": 3, "result": {} }));
        assert_eq!(replies[4]["error"], json!({ "code": -32601, "message": "Method not found: resources/list" }));
        // a cancellation with an id is a request nobody serves
        assert_eq!(replies[5]["error"], json!({ "code": -32601, "message": "Method not found: notifications/cancelled" }));
        assert_eq!(replies.len(), 6, "notifications, null ids and responses get no answer: {replies:?}");
        assert_eq!(socket.text(), format!("{}\n{}\n", lines[5], lines[7]));
    }

    #[test]
    fn the_socket_refusing_hello_ends_the_bridge_with_why() {
        let cases = [
            ("{\"jsonrpc\":\"2.0\",\"id\":\"hello\",\"error\":{\"code\":-32001,\"message\":\"Not allowed\"}}\n", ": Not allowed"),
            ("{\"jsonrpc\":\"2.0\",\"id\":\"hello\",\"error\":{}}\n", ": "),
            ("garbage\n", ""),
            // closed before it answered
            ("", ""),
        ];
        for (said, why) in cases {
            let (b, ended) = bridge(Buf::default(), Buf::default());
            b.serve_socket(Cursor::new(said));
            assert_eq!(ended.recv().expect("ended"), (1, Some(format!("MoPilot refused the connection{why}"))), "{said}");
        }
    }

    #[test]
    fn a_broken_socket_or_harness_ends_the_bridge() {
        let (b, ended) = bridge(Buf::default(), Buf::default());
        b.serve_socket(Broken::default());
        assert_eq!(ended.recv().expect("ended"), (1, Some("can't reach MoPilot: reset".into())));
        // once hello is accepted, a reset is main letting the session go, as a close is
        let (b, ended) = bridge(Buf::default(), Buf::default());
        b.serve_socket(ThenBroken(Cursor::new(ACCEPTED)));
        assert_eq!(ended.recv().expect("ended"), (0, None));
        // a harness that stopped reading: nobody is left to serve
        let (b, ended) = bridge(Buf::default(), Broken::default());
        b.serve_socket(Cursor::new(ACCEPTED));
        assert_eq!(ended.recv().expect("socket closed"), (0, None));
        b.handle(&mut lock(&b.state), "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}");
        assert_eq!(ended.try_recv(), Ok((0, None)));
        // one whose pipe takes the line but fails to flush it is gone too
        let (b, ended) = bridge(Buf::default(), Broken { writes: true });
        b.serve_socket(Cursor::new(ACCEPTED));
        assert_eq!(ended.recv().expect("socket closed"), (0, None));
        b.handle(&mut lock(&b.state), "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}");
        assert_eq!(ended.try_recv(), Ok((0, None)));
        // a socket that takes no more lines: the call is answered here instead of waiting forever
        let out = Buf::default();
        let (b, _ended) = bridge(Broken::default(), out.clone());
        b.serve_socket(Cursor::new(ACCEPTED));
        b.handle(&mut lock(&b.state), "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/list\"}");
        assert_eq!(out.values()[0]["error"], json!({ "code": -32603, "message": "MoPilot is not reachable" }));
        // a stdin that fails is a harness gone
        let (b, ended) = bridge(Buf::default(), Buf::default());
        b.serve_socket(Cursor::new(ACCEPTED));
        assert_eq!(ended.recv().expect("socket closed"), (0, None));
        b.serve_harness(Broken::default());
        assert_eq!(ended.try_recv(), Ok((0, None)));
    }

    #[test]
    fn after_hello_the_socket_s_lines_reach_the_harness_and_so_do_the_harness_s() {
        let (socket, out) = (Buf::default(), Buf::default());
        let (b, ended) = bridge(socket.clone(), out.clone());
        let changed = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}";
        b.serve_socket(Cursor::new(format!("{ACCEPTED}{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{}}}}\n{changed}\n")));
        assert_eq!(ended.recv().expect("socket closed"), (0, None));
        let list_changed = json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" });
        assert_eq!(out.values(), vec![json!({ "jsonrpc": "2.0", "id": 1, "result": {} }), list_changed]);
        // a CRLF line is one line, and one that is not UTF-8 is answered as what it is: not JSON
        b.serve_harness(Cursor::new(&b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\r\n\xff\xfe\n"[..]));
        assert_eq!(socket.text(), "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n");
        assert_eq!(out.values()[2]["error"]["message"], "Parse error");
        assert_eq!(ended.recv().expect("stdin closed"), (0, None));
    }
}
