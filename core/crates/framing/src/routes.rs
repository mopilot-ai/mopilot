//! The framing crate's core routes, for a stream the core doesn't own (electron/platform/coreFraming.cjs), all on the JS
//! thread: `framing.open` (payload: the line limit in UTF-16 units, or nothing for none; reply: the framer's id),
//! `framing.push` (payload: the id, a newline, then the bytes; reply: the complete lines, as the crate's header says) and
//! `framing.close` (payload: the id; reply: `true` or `false`).

use dispatch::{Call, CallRoute, Route};

fn open(payload: &[u8], call: &Call) -> Result<Vec<u8>, String> {
    let limit = std::str::from_utf8(payload).ok().map(str::trim).ok_or_else(|| "framing.open takes a limit".to_string())?;
    let max = if limit.is_empty() { None } else { Some(limit.parse().map_err(|_| "framing.open takes a limit".to_string())?) };
    Ok(crate::open(call, max)?.to_string().into_bytes())
}

fn push(payload: &[u8]) -> Result<Vec<u8>, String> {
    let at = payload.iter().position(|&b| b == b'\n').ok_or_else(|| "framing.push takes an id and bytes".to_string())?;
    let id = id_of(&payload[..at])?;
    crate::push(id, &payload[at + 1..])
}

fn close(payload: &[u8]) -> Result<Vec<u8>, String> {
    Ok(crate::close(id_of(payload)?).to_string().into_bytes())
}

/// The framer id a payload names.
fn id_of(bytes: &[u8]) -> Result<u64, String> {
    std::str::from_utf8(bytes).ok().and_then(|s| s.trim().parse().ok()).ok_or_else(|| "framing routes take a framer id".to_string())
}

inventory::submit! { CallRoute { name: "framing.open", handler: open } }
inventory::submit! { Route { name: "framing.push", handler: push } }
inventory::submit! { Route { name: "framing.close", handler: close } }

#[cfg(test)]
mod tests {
    use dispatch::dispatch;

    #[test]
    fn a_framer_opens_frames_and_closes_through_the_routes() {
        let id = String::from_utf8(dispatch("framing.open", b"3").expect("an id")).expect("utf-8");
        let push = |bytes: &[u8]| dispatch("framing.push", &[id.as_bytes(), b"\n", bytes].concat());
        assert_eq!(push(b"ab\ncd"), Ok(vec![2, 0, 0, 0, 0, 0, 0, 0, b'a', b'b']));
        assert_eq!(push(b"ef\n"), Ok(vec![0xff; 8]), "the line past the limit is told");
        assert!(push(b"x").expect_err("closed").starts_with("no framer"));
        assert_eq!(dispatch("framing.close", id.as_bytes()), Ok(b"false".to_vec()));
        let open = String::from_utf8(dispatch("framing.open", b"").expect("an id")).expect("utf-8");
        assert_eq!(dispatch("framing.close", open.as_bytes()), Ok(b"true".to_vec()));
    }

    #[test]
    fn a_payload_that_names_nothing_is_refused() {
        for bad in [&b"x"[..], &[0xff][..]] {
            assert!(dispatch("framing.open", bad).is_err());
        }
        assert!(dispatch("framing.push", b"no newline").is_err());
        assert!(dispatch("framing.push", b"x\nbytes").is_err());
        assert!(dispatch("framing.close", b"x").is_err());
    }
}
