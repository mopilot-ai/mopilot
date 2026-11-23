//! The core's routes for the children `spawn` owns, for electron/platform/coreChild.cjs. All run on the JS thread:
//! - `proc.spawn`: a JSON `Spec`, reply `{ id, pid, held, cost, ack }`, or `{ errno, message }` when the system refused. A
//!   caller reads the pid and writes to stdin in the same tick, as with Node's spawn, which holds main the same way: for
//!   libuv's own call on each platform, `posix_spawn` on macOS and until the exec on Linux, and for the threads' start;
//! - `proc.write`: the id, a newline, then the bytes for stdin; reply `0` queued, `1` queued and full, `2` gone. Queues only;
//! - `proc.endInput`: the id; reply `true` when stdin was open. What is queued is written first;
//! - `proc.closeInput`: the id; stdin ends now, whatever is queued, as a closed socket's does; reply empty;
//! - `proc.ack`: `<id> <output> <amount>`, what JS took of an output, charged as the reply to `proc.spawn` says;
//! - `proc.want`: `<id> <ask>`; JS reads a framed stdout and wants the line `ASK` number `ask` was about (`lines`);
//! - `proc.drop`: the id; JS destroyed a framed stdout, so what comes is dropped and no line kept;
//! - `proc.signal`: `<id> <signal number>`; reply `true` when it was sent.
//!
//! A child that has gone is no error: JS's calls race its last events, which are already on their way.

use super::{child, launch, start_thread, Failure, Spec, Start, Started, Written, ACK_EVERY, CHUNK_COST};
use dispatch::{Call, CallRoute, Reply, Route};
use serde_json::json;
use std::io;

fn spawn(payload: &[u8], call: &Call) -> Reply {
    spawn_with(payload, call, start_thread)
}

pub(super) fn spawn_with(payload: &[u8], call: &Call, start: Start) -> Reply {
    let spec: Spec = serde_json::from_slice(payload).map_err(|error| format!("proc.spawn takes a spawn: {error}"))?;
    match launch(&spec, call, start) {
        Ok(Started { id, pid, held }) => {
            Ok(json!({ "id": id, "pid": pid, "held": held, "cost": CHUNK_COST, "ack": ACK_EVERY }).to_string().into_bytes())
        }
        Err(Failure::Os(error)) => Ok(json!({ "errno": errno_of(&error), "message": error.to_string() }).to_string().into_bytes()),
        Err(Failure::Refused(why)) => Err(why),
    }
}

/// The system's number for `error`. A program not found on Windows' search of PATH has none: 2 is ENOENT there and here.
fn errno_of(error: &io::Error) -> Option<i32> {
    error.raw_os_error().or((error.kind() == io::ErrorKind::NotFound).then_some(2))
}

/// The `N` whitespace-separated numbers a payload is, or why not.
fn numbers<const N: usize>(payload: &[u8], route: &str) -> Result<[u64; N], String> {
    let bad = || format!("{route} takes {N} number(s)");
    let text = std::str::from_utf8(payload).map_err(|_| bad())?;
    let parsed: Vec<u64> = text.split_whitespace().map(str::parse).collect::<Result<_, _>>().map_err(|_| bad())?;
    parsed.try_into().map_err(|_| bad())
}

fn write(payload: &[u8]) -> Reply {
    let at = payload.iter().position(|&byte| byte == b'\n').ok_or("proc.write takes an id and bytes")?;
    let [id] = numbers(&payload[..at], "proc.write")?;
    let written = child(id).map_or(Written::Gone, |child| child.write(payload[at + 1..].to_vec()));
    Ok(vec![match written {
        Written::Queued => b'0',
        Written::Full => b'1',
        Written::Gone => b'2',
    }])
}

fn end_input(payload: &[u8]) -> Reply {
    let [id] = numbers(payload, "proc.endInput")?;
    Ok(child(id).is_some_and(|child| child.end_input()).to_string().into_bytes())
}

fn close_input(payload: &[u8]) -> Reply {
    let [id] = numbers(payload, "proc.closeInput")?;
    if let Some(child) = child(id) {
        child.close_input();
    }
    Ok(Vec::new())
}

fn ack(payload: &[u8]) -> Reply {
    let [id, output, amount] = numbers(payload, "proc.ack")?;
    if output > 1 {
        return Err("proc.ack takes output 0 or 1".into());
    }
    if let Some(child) = child(id) {
        child.ack(output as usize, amount as usize);
    }
    Ok(Vec::new())
}

fn want(payload: &[u8]) -> Reply {
    let [id, ask] = numbers(payload, "proc.want")?;
    if let Some(child) = child(id) {
        child.want(ask);
    }
    Ok(Vec::new())
}

fn drop_lines(payload: &[u8]) -> Reply {
    let [id] = numbers(payload, "proc.drop")?;
    if let Some(child) = child(id) {
        child.drop_lines();
    }
    Ok(Vec::new())
}

fn signal(payload: &[u8]) -> Reply {
    let [id, signal] = numbers(payload, "proc.signal")?;
    Ok(child(id).is_some_and(|child| child.signal(signal as i32)).to_string().into_bytes())
}

inventory::submit! { CallRoute { name: "proc.spawn", handler: spawn } }
inventory::submit! { Route { name: "proc.write", handler: write } }
inventory::submit! { Route { name: "proc.endInput", handler: end_input } }
inventory::submit! { Route { name: "proc.closeInput", handler: close_input } }
inventory::submit! { Route { name: "proc.ack", handler: ack } }
inventory::submit! { Route { name: "proc.want", handler: want } }
inventory::submit! { Route { name: "proc.drop", handler: drop_lines } }
inventory::submit! { Route { name: "proc.signal", handler: signal } }
