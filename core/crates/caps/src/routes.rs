//! The caps crate's core routes, for electron/capabilities/mcp/socket.cjs and the Chrome native host's check:
//! `caps.peerPid` (payload: a socket's descriptor in this process; reply: the peer's pid), `caps.ancestry` (payload: a
//! pid; reply: `ancestry` as a JSON array), `caps.executable` (payload: a pid; reply: `executable` as a JSON string) and
//! `caps.ready` (no payload read; reply: `ready` as JSON), which only a core with the holder proof serves.

use dispatch::Route;

fn peer_pid(payload: &[u8]) -> Result<Vec<u8>, String> {
    let fd = number_of(payload, "caps.peerPid takes a socket descriptor")?;
    crate::peer_pid(fd).map(|pid| pid.to_string().into_bytes()).map_err(|e| format!("read the peer of socket {fd}: {e}"))
}

fn ancestry(payload: &[u8]) -> Result<Vec<u8>, String> {
    ancestry_reply(number_of(payload, "caps.ancestry takes a pid")?, proc::table())
}

/// `pid`'s ancestry in a reading of the table as JSON, or why the table could not be read.
fn ancestry_reply(pid: i32, table: std::io::Result<Vec<proc::Process>>) -> Result<Vec<u8>, String> {
    match table {
        Ok(rows) => {
            let chain: Vec<String> = crate::ancestry(&rows, pid).iter().map(i32::to_string).collect();
            Ok(format!("[{}]", chain.join(",")).into_bytes())
        }
        Err(e) => Err(format!("read the process table: {e}")),
    }
}

fn executable(payload: &[u8]) -> Result<Vec<u8>, String> {
    let pid = number_of(payload, "caps.executable takes a pid")?;
    let file = crate::executable(pid).map_err(|e| format!("read the file process {pid} runs: {e}"))?;
    Ok(serde_json::Value::String(file).to_string().into_bytes())
}

fn ready(_payload: &[u8]) -> Result<Vec<u8>, String> {
    Ok(crate::ready().to_string().into_bytes())
}

/// The decimal number a payload holds.
fn number_of(payload: &[u8], refusal: &str) -> Result<i32, String> {
    std::str::from_utf8(payload).ok().and_then(|s| s.trim().parse().ok()).ok_or_else(|| refusal.to_string())
}

inventory::submit! { Route { name: "caps.peerPid", handler: peer_pid } }
inventory::submit! { Route { name: "caps.ancestry", handler: ancestry } }
inventory::submit! { Route { name: "caps.executable", handler: executable } }
inventory::submit! { Route { name: "caps.ready", handler: ready } }

#[cfg(test)]
mod tests {
    use dispatch::dispatch;

    #[test]
    fn this_process_s_ancestry_starts_with_it_and_a_payload_naming_nothing_is_refused() {
        let me = std::process::id();
        let reply = String::from_utf8(dispatch("caps.ancestry", me.to_string().as_bytes()).expect("a chain")).expect("utf-8");
        assert!(reply.starts_with(&format!("[{me},")), "{reply}");
        assert_eq!(dispatch("caps.ancestry", b"x"), Err("caps.ancestry takes a pid".into()));
        assert_eq!(dispatch("caps.peerPid", b"x"), Err("caps.peerPid takes a socket descriptor".into()));
        assert!(dispatch("caps.peerPid", b"-1").expect_err("no socket").starts_with("read the peer of socket -1"));
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(super::ancestry_reply(7, Err(denied)), Err("read the process table: permission denied".into()));
    }

    #[test]
    fn the_ready_route_says_the_peer_check_works_here() {
        assert_eq!(dispatch("caps.ready", b"null"), Ok(b"true".to_vec()));
    }

    #[cfg(unix)]
    #[test]
    fn the_executable_route_answers_with_a_json_string() {
        let me = std::fs::canonicalize(std::env::current_exe().expect("this test")).expect("a path");
        let reply = dispatch("caps.executable", std::process::id().to_string().as_bytes()).expect("a file");
        assert_eq!(serde_json::from_slice::<String>(&reply).expect("JSON"), me.to_string_lossy());
        assert_eq!(dispatch("caps.executable", b"x"), Err("caps.executable takes a pid".into()));
        let gone = i32::MAX.to_string();
        assert!(dispatch("caps.executable", gone.as_bytes()).expect_err("no process").starts_with("read the file process"));
    }

    #[cfg(unix)]
    #[test]
    fn the_peer_route_answers_for_a_socket_pair() {
        use std::os::fd::AsRawFd;
        let (a, _b) = std::os::unix::net::UnixStream::pair().expect("a pair");
        let reply = dispatch("caps.peerPid", a.as_raw_fd().to_string().as_bytes()).expect("a peer");
        assert_eq!(reply, std::process::id().to_string().into_bytes());
    }
}
