//! sage-mcp where there is no Swift helper (Windows, and the Linux package): MCP (newline-delimited JSON-RPC) on stdio
//! to the harness that started it, forwarded line for line to MoPilot's tool socket (electron/capabilities/mcp/socket.cjs),
//! as the Swift sage-mcp (native/sage-mcp) does on macOS and the portable one (host/src/sageMcpShim.mjs) does for a Host
//! and a Linux checkout. It ships beside the core's addon in resources/core (scripts/build-core.mjs). It says
//! `hello {token, pid, ppid}` first; until the socket accepts it, what the harness sends waits. The socket is
//! `127.0.0.1:<port>` on Windows, where Node listens on no Unix socket, and a Unix socket's path elsewhere.

use bridge::{Bridge, End, State};
use serde_json::json;
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

mod bridge;
#[cfg(test)]
mod testkit;

/// The version hello reports, the portable sage-mcp's.
pub const VERSION: &str = "1.0.0";
/// The one host a TCP address may name: main listens on loopback only, and the token never goes anywhere else.
const LOOPBACK: &str = "127.0.0.1:";

/// The two halves of a connection to the tool socket: what it says, and where to write to it.
pub type Conn = (Box<dyn Read + Send>, Box<dyn Write + Send>);

/// This process's pid and its parent's, for hello (the socket checks the pid; the parent is for its log).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ids {
    pub pid: u32,
    pub ppid: Option<u32>,
}

impl Ids {
    /// This process's own: Windows has no parent pid in std, and the socket does not need one.
    pub fn current() -> Self {
        #[cfg(unix)]
        let ppid = Some(std::os::unix::process::parent_id());
        #[cfg(not(unix))]
        let ppid = None;
        Ids { pid: std::process::id(), ppid }
    }
}

/// Open the tool socket at `address`: `127.0.0.1:<port>` over TCP, any other address as a Unix socket's path.
pub fn connect(address: &str) -> io::Result<Conn> {
    if let Some(port) = address.strip_prefix(LOOPBACK) {
        let port: u16 = port.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("no port in {address}")))?;
        let stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
        return Ok((Box::new(stream.try_clone()?), Box::new(stream)));
    }
    #[cfg(unix)]
    {
        let stream = std::os::unix::net::UnixStream::connect(address)?;
        Ok((Box::new(stream.try_clone()?), Box::new(stream)))
    }
    #[cfg(not(unix))]
    Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{address} is not 127.0.0.1:<port>")))
}

/// Run until the harness closes stdin or the socket closes; returns the exit code. `env` reads SAGE_MCP_SOCKET and
/// SAGE_MCP_TOKEN, `connect` opens the socket (`connect` above, or a test's).
pub fn run(
    env: impl Fn(&str) -> Option<String>,
    stdin: impl Read + Send + 'static,
    stdout: impl Write + Send + 'static,
    stderr: &mut dyn Write,
    ids: Ids,
    connect: impl FnOnce(&str) -> io::Result<Conn>,
) -> i32 {
    let (code, message) = start(env, stdin, stdout, ids, connect);
    if let Some(message) = message {
        let _ = writeln!(stderr, "sage-mcp: {message}");
    }
    code
}

fn start(
    env: impl Fn(&str) -> Option<String>,
    stdin: impl Read + Send + 'static,
    stdout: impl Write + Send + 'static,
    ids: Ids,
    connect: impl FnOnce(&str) -> io::Result<Conn>,
) -> End {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    let Some(address) = set("SAGE_MCP_SOCKET") else { return (1, Some("SAGE_MCP_SOCKET is not set".into())) };
    let Some(token) = set("SAGE_MCP_TOKEN") else { return (1, Some("SAGE_MCP_TOKEN is not set".into())) };
    let unreachable = |e: io::Error| (1, Some(format!("can't reach MoPilot: {e}")));
    let (reader, mut writer) = match connect(&address) {
        Ok(conn) => conn,
        Err(e) => return unreachable(e),
    };
    let hello = json!({
        "jsonrpc": "2.0",
        "id": "hello",
        "method": "hello",
        "params": { "token": token, "pid": ids.pid, "ppid": ids.ppid, "version": VERSION },
    });
    if let Err(e) = writer.write_all(format!("{hello}\n").as_bytes()).and_then(|()| writer.flush()) {
        return unreachable(e);
    }
    let (done, ended) = mpsc::channel();
    let state = State { greeted: false, queued: Vec::new(), stdin_closed: false, server_name: "sage".into(), socket: writer };
    let bridge = Arc::new(Bridge { state: Mutex::new(state), stdout: Mutex::new(Box::new(stdout)), done });
    let socket_side = Arc::clone(&bridge);
    thread::spawn(move || socket_side.serve_socket(reader));
    let harness_side = Arc::clone(&bridge);
    thread::spawn(move || harness_side.serve_harness(stdin));
    // both threads hold a sender, and each sends before it returns, so one answer always comes
    ended.recv().unwrap_or((1, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{Broken, Buf, ACCEPTED};
    use serde_json::Value;
    use std::io::{BufRead, BufReader, Cursor};
    use std::net::TcpListener;

    /// A host the test plays: a loopback listener, and the address sage-mcp is given for it.
    fn host() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = format!("127.0.0.1:{}", listener.local_addr().expect("its address").port());
        (listener, address)
    }

    #[test]
    fn run_says_hello_over_loopback_serves_the_harness_and_ends_when_the_socket_closes() {
        let (listener, address) = host();
        let ids = Ids { pid: 4242, ppid: Some(7) };
        let host = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("sage-mcp connects");
            let mut lines = BufReader::new(stream.try_clone().expect("a clone")).lines();
            let hello: Value = serde_json::from_str(&lines.next().expect("hello").expect("a line")).expect("JSON");
            let mut w = stream;
            w.write_all(ACCEPTED.as_bytes()).expect("accepted");
            let call = lines.next().expect("the forwarded call").expect("a line");
            w.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n").expect("answered");
            // the host goes away: sage-mcp ends
            (hello, call)
        });
        let (stdin, mut harness) = io::pipe().expect("a pipe");
        harness.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n").expect("written");
        let (out, mut err) = (Buf::default(), Vec::new());
        let vars = std::collections::HashMap::from([("SAGE_MCP_SOCKET", address), ("SAGE_MCP_TOKEN", "t0k".to_string())]);
        let env = move |name: &str| vars.get(name).cloned();
        assert_eq!(run(env, stdin, out.clone(), &mut err, ids, connect), 0);
        let (hello, call) = host.join().expect("the host");
        assert_eq!(
            hello,
            json!({ "jsonrpc": "2.0", "id": "hello", "method": "hello", "params": { "token": "t0k", "pid": 4242, "ppid": 7, "version": VERSION } })
        );
        assert_eq!(call, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
        assert_eq!(out.values(), vec![json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } })]);
        assert!(err.is_empty());
        drop(harness);
    }

    #[test]
    fn run_refuses_to_start_without_its_socket_and_token_or_a_host_to_reach() {
        let none = |_: &str| None;
        let only_socket = |name: &str| (name == "SAGE_MCP_SOCKET").then(|| "127.0.0.1:1".to_string());
        let both = |_: &str| Some("127.0.0.1:1".to_string());
        let refused = |_: &str| -> io::Result<Conn> { Err(io::Error::new(io::ErrorKind::ConnectionRefused, "refused")) };
        let hello_fails = |_: &str| -> io::Result<Conn> { Ok((Box::new(Cursor::new("")), Box::new(Broken::default()))) };
        let ids = Ids::current();
        type Env<'a> = &'a dyn Fn(&str) -> Option<String>;
        type Connect<'a> = &'a dyn Fn(&str) -> io::Result<Conn>;
        let cases: [(Env, Connect, &str); 4] = [
            (&none, &refused, "sage-mcp: SAGE_MCP_SOCKET is not set\n"),
            (&only_socket, &refused, "sage-mcp: SAGE_MCP_TOKEN is not set\n"),
            (&both, &refused, "sage-mcp: can't reach MoPilot: refused\n"),
            (&both, &hello_fails, "sage-mcp: can't reach MoPilot: broken\n"),
        ];
        for (env, conn, said) in cases {
            let mut err = Vec::new();
            assert_eq!(run(env, Cursor::new(""), Buf::default(), &mut err, ids, conn), 1, "{said}");
            assert_eq!(String::from_utf8(err).expect("utf-8"), said);
        }
    }

    #[test]
    fn connect_takes_a_loopback_port_and_on_unix_a_socket_path() {
        let (listener, address) = host();
        let (_r, mut w) = connect(&address).expect("connected");
        w.write_all(b"x").expect("written");
        drop(listener);
        assert_eq!(connect("127.0.0.1:port").err().map(|e| e.kind()), Some(io::ErrorKind::InvalidInput));
        let dir = std::env::temp_dir().join(format!("sage-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder");
        let path = dir.join("s.sock");
        #[cfg(unix)]
        {
            let _listener = std::os::unix::net::UnixListener::bind(&path).expect("a socket");
            assert!(connect(path.to_str().expect("a path")).is_ok());
        }
        #[cfg(not(unix))]
        assert_eq!(connect(path.to_str().expect("a path")).err().map(|e| e.kind()), Some(io::ErrorKind::InvalidInput));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(Ids::current().pid, std::process::id());
    }
}
