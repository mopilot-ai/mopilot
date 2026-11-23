//! The rollout crate's core routes, for electron/harness/codexRollout.cjs: `rollout.open` (payload: the file's path; reply:
//! JSON `{ id, cwd, count }`, its turns held behind the id), `rollout.page` (payload: `id start end`; reply: those turns as
//! a JSON list, which may stop short of `end` when they are large) and `rollout.close` (payload: the id; reply: `true` or
//! `false`), and `rollout.usage` (payload: the file's path; reply: its sampling requests as a JSON list of
//! `[id, thread, time, model, in, out, cacheRead, cacheWrite]`, for the request ledger's import).

use dispatch::{Call, CallRoute, Route};

fn open(payload: &[u8], call: &Call) -> Result<Vec<u8>, String> {
    let path = std::str::from_utf8(payload).map_err(|_| "rollout.open takes a path".to_string())?;
    let (id, cwd, count) = crate::open(path, call)?;
    let mut reply = format!(r#"{{"id":{id},"cwd":"#).into_bytes();
    reply.extend_from_slice(&cwd);
    reply.extend_from_slice(format!(r#","count":{count}}}"#).as_bytes());
    Ok(reply)
}

fn usage(payload: &[u8], call: &Call) -> Result<Vec<u8>, String> {
    let path = std::str::from_utf8(payload).map_err(|_| "rollout.usage takes a path".to_string())?;
    crate::usage(path, call)
}

/// The numbers a payload holds, split by spaces.
fn numbers(payload: &[u8]) -> Option<Vec<u64>> {
    std::str::from_utf8(payload).ok()?.split(' ').map(|n| n.parse().ok()).collect()
}

fn page(payload: &[u8]) -> Result<Vec<u8>, String> {
    let Some(&[id, start, end]) = numbers(payload).as_deref() else {
        return Err("rollout.page takes an id, a start and an end".into());
    };
    crate::page(id, start as usize, end as usize)
}

fn close(payload: &[u8]) -> Result<Vec<u8>, String> {
    let Some(&[id]) = numbers(payload).as_deref() else {
        return Err("rollout.close takes an id".into());
    };
    Ok(crate::close(id).to_string().into_bytes())
}

inventory::submit! { CallRoute { name: "rollout.open", handler: open } }
inventory::submit! { Route { name: "rollout.page", handler: page } }
inventory::submit! { Route { name: "rollout.close", handler: close } }
inventory::submit! { CallRoute { name: "rollout.usage", handler: usage } }

#[cfg(test)]
mod tests {
    use dispatch::dispatch;
    use std::path::PathBuf;

    fn file(name: &str, text: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mopilot-rollout-route-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder");
        let path = dir.join(name);
        std::fs::write(&path, text).expect("a file");
        path
    }

    fn turn(id: &str) -> String {
        format!(r#"{{"type":"event_msg","payload":{{"type":"user_message","turn_id":"{id}","message":"hi"}}}}"#)
    }

    #[test]
    fn a_rollout_opens_pages_and_closes_through_the_routes() {
        let text = format!("{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"/w\"}}}}\n{}\n{}\n{}\n", turn("a"), turn("b"), turn("c"));
        let path = file("three.jsonl", &text);
        let opened = dispatch("rollout.open", path.to_str().expect("UTF-8").as_bytes()).expect("opened");
        let opened: serde_json::Value = serde_json::from_slice(&opened).expect("JSON");
        assert_eq!((&opened["cwd"], &opened["count"]), (&serde_json::json!("/w"), &serde_json::json!(3)));
        let id = opened["id"].as_u64().expect("an id");
        let ids = |start: u32, end: u32| {
            let reply = dispatch("rollout.page", format!("{id} {start} {end}").as_bytes()).expect("a page");
            let turns: Vec<serde_json::Value> = serde_json::from_slice(&reply).expect("JSON");
            turns.iter().map(|t| t["id"].as_str().expect("an id").to_string()).collect::<Vec<_>>()
        };
        assert_eq!(ids(1, 3), ["b", "c"]);
        assert_eq!(ids(0, 1), ["a"]);
        assert_eq!(ids(0, 99), ["a", "b", "c"]);
        assert_eq!(ids(2, 1), [""; 0]);
        assert_eq!(ids(7, 9), [""; 0]);
        assert_eq!(dispatch("rollout.close", id.to_string().as_bytes()), Ok(b"true".to_vec()));
        assert_eq!(dispatch("rollout.close", id.to_string().as_bytes()), Ok(b"false".to_vec()));
        assert!(dispatch("rollout.page", format!("{id} 0 1").as_bytes()).expect_err("closed").starts_with("no rollout"));
    }

    #[test]
    fn an_empty_file_has_no_folder_and_no_turns() {
        let path = file("empty.jsonl", "");
        let opened = dispatch("rollout.open", path.to_str().expect("UTF-8").as_bytes()).expect("opened");
        let opened: serde_json::Value = serde_json::from_slice(&opened).expect("JSON");
        assert_eq!((&opened["cwd"], &opened["count"]), (&serde_json::Value::Null, &serde_json::json!(0)));
        assert_eq!(dispatch("rollout.close", opened["id"].to_string().as_bytes()), Ok(b"true".to_vec()));
    }

    #[test]
    fn a_rollouts_usage_comes_through_its_route_plain_or_compressed() {
        // the fixtures: one request, its stopped turn's repeat, and a message around them; the .zst made by the zstd CLI
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/core/rollout");
        let expected = serde_json::json!([["th:9", "th", "2026-11-01T00:00:02.000Z", "gpt-a", 4, 4, 1, 0]]);
        for name in ["usage.jsonl", "usage.jsonl.zst"] {
            let path = fixtures.join(name);
            let reply = dispatch("rollout.usage", path.to_str().expect("UTF-8").as_bytes()).expect("its usage");
            assert_eq!(serde_json::from_slice::<serde_json::Value>(&reply).expect("JSON"), expected, "{name}");
        }
        assert!(dispatch("rollout.usage", &[0xff]).expect_err("no path").starts_with("rollout.usage"));
        assert!(dispatch("rollout.usage", b"/no/such/rollout.jsonl").expect_err("no file").starts_with("open a rollout"));
    }

    #[test]
    fn a_bad_payload_is_refused() {
        assert!(dispatch("rollout.open", &[0xff]).expect_err("no path").starts_with("rollout.open"));
        assert!(dispatch("rollout.open", b"/no/such/rollout.jsonl").expect_err("no file").starts_with("open a rollout"));
        for bad in [&b"1 2"[..], b"x 1 2", b"1 2 3 4", b"", &[0xff]] {
            assert!(dispatch("rollout.page", bad).expect_err("not a page").starts_with("rollout.page"), "{bad:?}");
        }
        for bad in [&b"x"[..], b"1 2", b""] {
            assert!(dispatch("rollout.close", bad).expect_err("not an id").starts_with("rollout.close"), "{bad:?}");
        }
    }
}
