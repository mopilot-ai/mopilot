//! The executable as a harness starts it: its environment read, its stdio served, its exit code the bridge's.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};

/// The executable started as a harness starts it, told to reach the tool socket at `address`.
fn start(address: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_sage-mcp"))
        .env("SAGE_MCP_SOCKET", address)
        .env("SAGE_MCP_TOKEN", "t0k")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("it starts")
}

/// The tool socket's side of one connection, `from_it` and `to_it`, and the harness's: hello read and accepted, a ping
/// answered, and the harness closing stdin ends it with success. Returns hello's params.
fn serve(child: &mut Child, from_it: impl Read, mut to_it: impl Write) -> serde_json::Value {
    let mut from_it = BufReader::new(from_it);
    let mut hello = String::new();
    from_it.read_line(&mut hello).expect("hello");
    let hello: serde_json::Value = serde_json::from_str(&hello).expect("JSON");
    assert_eq!((&hello["params"]["token"], &hello["params"]["pid"]), (&serde_json::json!("t0k"), &serde_json::json!(child.id())));
    to_it.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"hello\",\"result\":{\"serverName\":\"mopilot_1\"}}\n").expect("accepted");
    let mut stdin = child.stdin.take().expect("its stdin");
    stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n").expect("a ping");
    let mut answer = String::new();
    BufReader::new(child.stdout.take().expect("its stdout")).read_line(&mut answer).expect("an answer");
    // the key order is serde_json's, which another crate's features can change: the value is what counts
    let answer: serde_json::Value = serde_json::from_str(&answer).expect("JSON");
    assert_eq!(answer, serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    // the harness closing stdin ends it, with success
    drop(stdin);
    assert_eq!(child.wait().expect("it exits").code(), Some(0));
    hello["params"].clone()
}

#[test]
fn the_executable_reports_a_missing_socket_and_serves_a_harness_over_loopback() {
    let missing = Command::new(env!("CARGO_BIN_EXE_sage-mcp")).env_remove("SAGE_MCP_SOCKET").output().expect("it runs");
    assert_eq!(missing.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&missing.stderr), "sage-mcp: SAGE_MCP_SOCKET is not set\n");

    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("its address").port();
    let mut child = start(&format!("127.0.0.1:{port}"));
    let (stream, _) = listener.accept().expect("it connects");
    serve(&mut child, stream.try_clone().expect("a clone"), stream);
}

/// The Linux package's case: MoPilot's tool socket there is a Unix socket's path, and the parent named in hello is the
/// process that started the bridge.
#[cfg(unix)]
#[test]
fn the_executable_serves_a_harness_over_a_unix_socket_and_names_its_parent() {
    use std::os::unix::net::UnixListener;
    let dir = std::env::temp_dir().join(format!("sage-mcp-exe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a folder");
    let socket = dir.join("tools.sock");
    let listener = UnixListener::bind(&socket).expect("a socket");
    let mut child = start(socket.to_str().expect("a path"));
    let (stream, _) = listener.accept().expect("it connects");
    let hello = serve(&mut child, stream.try_clone().expect("a clone"), stream);
    assert_eq!(hello["ppid"], serde_json::json!(std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
}
