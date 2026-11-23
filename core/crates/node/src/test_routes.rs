//! Routes that only the binding's tests call (feature `test-routes`, which scripts/rust-coverage.mjs builds with and no
//! shipped build does): a long route that stops only when cancelled, one that doesn't stop, one that panics, and ones
//! that emit on the stream.

use dispatch::{Call, CallRoute, Reply, Route};
use std::thread::sleep;
use std::time::Duration;

/// Holds a core thread until cancelled, as a long scan would.
fn hold(_: &[u8], call: &Call) -> Reply {
    loop {
        call.cancel.check()?;
        sleep(Duration::from_millis(1));
    }
}

/// Runs on a core thread for a while whatever is cancelled, as a route between two checks of its token does.
fn linger(_: &[u8], _: &Call) -> Reply {
    sleep(Duration::from_millis(200));
    Ok(Vec::new())
}

fn panics(_: &[u8]) -> Reply {
    panic!("a core bug")
}

/// Emits `<payload>-0` to `<payload>-<count - 1>`, for a payload of `<payload>:<count>`, and replies `<payload>`.
fn emits(payload: &[u8], call: &Call) -> Reply {
    let text = String::from_utf8_lossy(payload);
    let (name, count) = text.split_once(':').ok_or("emits takes name:count")?;
    let count: u32 = count.parse().map_err(|_| "emits takes a number")?;
    for i in 0..count {
        call.emit(format!("{name}-{i}").into_bytes());
    }
    Ok(name.as_bytes().to_vec())
}

/// Emits as fast as it can until cancelled, so an environment's end finds its stream full and still being written to.
fn floods(_: &[u8], call: &Call) -> Reply {
    loop {
        call.cancel.check()?;
        call.emit(b"flood".to_vec());
    }
}

/// Keeps emitting for a while whatever is cancelled, as a route between two checks of its token would, so a stream's end
/// finds a core thread still writing to it. It takes its call, so an environment's end doesn't wait for it.
fn emits_past_the_end(_: &[u8], call: &Call) -> Reply {
    for _ in 0..2000 {
        call.emit(b"late".to_vec());
        sleep(Duration::from_micros(100));
    }
    Ok(Vec::new())
}

/// Emits one event and then fails, so an error reply is seen to follow it too.
fn emits_then_fails(_: &[u8], call: &Call) -> Reply {
    call.emit(b"before".to_vec());
    Err("failed after an event".into())
}

inventory::submit! { CallRoute { name: "test.hold", handler: hold } }
inventory::submit! { CallRoute { name: "test.linger", handler: linger } }
inventory::submit! { Route { name: "test.panics", handler: panics } }
inventory::submit! { CallRoute { name: "test.emits", handler: emits } }
inventory::submit! { CallRoute { name: "test.emitsThenFails", handler: emits_then_fails } }
inventory::submit! { CallRoute { name: "test.floods", handler: floods } }
inventory::submit! { CallRoute { name: "test.emitsPastTheEnd", handler: emits_past_the_end } }
