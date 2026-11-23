//! The rank crate's core routes, for electron/platform/search.cjs: `rank.open` (payload: the paths, each ended by a NUL;
//! reply: the listing's id), `rank.search` (payload: JSON `{ id, query, root, limit, dirs }`; reply: the hits as JSON) and
//! `rank.close` (payload: the id; reply: `true` or `false`).

use dispatch::{Call, CallRoute, Route};
use serde::Deserialize;

fn open(payload: &[u8], call: &Call) -> Result<Vec<u8>, String> {
    let paths = std::str::from_utf8(payload).map_err(|_| "rank.open takes UTF-8 paths".to_string())?;
    let files = paths.split('\0').filter(|path| !path.is_empty()).map(String::from);
    Ok(crate::open(call, files)?.to_string().into_bytes())
}

#[derive(Deserialize)]
struct Search {
    id: u64,
    query: String,
    root: String,
    limit: usize,
    dirs: bool,
}

fn search(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: Search = serde_json::from_slice(payload).map_err(|error| format!("rank.search: {error}"))?;
    let hits = crate::search(ask.id, &ask.query, &ask.root, ask.limit, ask.dirs)?;
    serde_json::to_vec(&hits).or(Err("rank.search: no reply".to_string()))
}

fn close(payload: &[u8]) -> Result<Vec<u8>, String> {
    let id = std::str::from_utf8(payload).ok().and_then(|s| s.trim().parse().ok()).ok_or_else(|| "rank.close takes an id".to_string())?;
    Ok(crate::close(id).to_string().into_bytes())
}

inventory::submit! { CallRoute { name: "rank.open", handler: open } }
inventory::submit! { Route { name: "rank.search", handler: search } }
inventory::submit! { Route { name: "rank.close", handler: close } }

#[cfg(test)]
mod tests {
    use dispatch::dispatch;

    #[test]
    fn a_listing_opens_searches_and_closes_through_the_routes() {
        let id = String::from_utf8(dispatch("rank.open", b"src/a.ts\0\0src/b.ts\0").expect("an id")).expect("utf-8");
        let ask = format!(r#"{{"id":{id},"query":"a","root":"/r","limit":5,"dirs":false}}"#);
        let hits: serde_json::Value = serde_json::from_slice(&dispatch("rank.search", ask.as_bytes()).expect("hits")).expect("JSON");
        assert_eq!(hits[0]["path"], "src/a.ts");
        assert_eq!(hits.as_array().expect("a list").len(), 1);
        assert_eq!(dispatch("rank.close", id.as_bytes()), Ok(b"true".to_vec()));
        assert_eq!(dispatch("rank.close", id.as_bytes()), Ok(b"false".to_vec()));
        assert!(dispatch("rank.search", ask.as_bytes()).expect_err("closed").starts_with("no listing"));
    }

    #[test]
    fn a_bad_payload_is_refused() {
        assert!(dispatch("rank.open", &[0xff]).is_err());
        assert!(dispatch("rank.search", b"{}").is_err());
        assert!(dispatch("rank.close", b"nope").is_err());
    }
}
