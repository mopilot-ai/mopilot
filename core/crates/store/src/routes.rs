//! The store crate's core routes (electron/platform/recordFiles.cjs, for the chat store): `store.readRecords`, whose
//! payload is a folder and an extension on two lines and whose reply is `reply_json` of the folder's record files; and
//! `store.writeRecord`, synchronous, whose payload is a JSON line naming the file, its temporary sibling and whether it
//! is private, then the bytes, and which answers once the file is in place (empty), or with its failure as JSON; and
//! `store.errorNames`, the names those failures take.

use crate::write::{write_atomic, Ask, Disk};
use dispatch::Route;
use std::io::ErrorKind;
use std::path::Path;

fn read_records(payload: &[u8]) -> Result<Vec<u8>, String> {
    let (dir, ext) = request_of(payload)?;
    match crate::read_records(Path::new(dir), ext) {
        Ok(entries) => Ok(crate::reply_json(&entries).into_bytes()),
        // no folder is an answer, not a failure: a first start has none yet
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(b"null".to_vec()),
        Err(error) => Err(format!("list {dir}: {error}")),
    }
}

/// The folder and the extension a payload names, one per line.
fn request_of(payload: &[u8]) -> Result<(&str, &str), String> {
    std::str::from_utf8(payload)
        .ok()
        .and_then(|text| text.split_once('\n'))
        .filter(|(dir, ext)| !dir.is_empty() && !ext.is_empty())
        .ok_or_else(|| "store.readRecords takes a folder and an extension, one per line".to_string())
}

inventory::submit! { Route { name: "store.readRecords", handler: read_records } }

fn write_record(payload: &[u8]) -> Result<Vec<u8>, String> {
    let (file, temp, private, data) = write_of(payload).ok_or_else(|| {
        "store.writeRecord takes a line naming the file, its temporary sibling and whether it is private, then the bytes".to_string()
    })?;
    let ask = Ask { file: Path::new(&file), temp: Path::new(&temp), private, data };
    write_atomic(&Disk, &ask).map(|()| Vec::new()).map_err(|failure| failure.reply())
}

/// The file, the temporary sibling (in the same folder, so the rename never crosses a disk), whether it is private, and
/// the bytes, that a payload names.
fn write_of(payload: &[u8]) -> Option<(String, String, bool, &[u8])> {
    let at = payload.iter().position(|&b| b == b'\n')?;
    let head: serde_json::Value = serde_json::from_slice(&payload[..at]).ok()?;
    let text = |key: &str| head.get(key)?.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let (file, temp, private) = (text("file")?, text("temp")?, head.get("private")?.as_bool()?);
    let sibling = Path::new(&temp).parent() == Path::new(&file).parent() && temp != file;
    sibling.then_some((file, temp, private, &payload[at + 1..]))
}

inventory::submit! { Route { name: "store.writeRecord", handler: write_record } }

/// libuv's names for this platform's OS errors as the core knows them, `[[code, name, text], …]`: what a test holds to
/// Node's own map (`util.getSystemErrorMap()`), so the core's errors read as Node's did.
fn error_names(_: &[u8]) -> Result<Vec<u8>, String> {
    Ok(crate::errors::names_json().into_bytes())
}

inventory::submit! { Route { name: "store.errorNames", handler: error_names } }

#[cfg(test)]
mod tests {
    #[test]
    fn the_route_reads_a_folder_and_refuses_what_names_none() {
        let dir = std::env::temp_dir().join(format!("mopilot-store-route-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a folder");
        std::fs::write(dir.join("a.v2"), b"[1]").expect("a file");
        let payload = format!("{}\n.v2", dir.display());
        assert_eq!(dispatch::dispatch("store.readRecords", payload.as_bytes()), Ok(br#"[["a.v2",0,[1]]]"#.to_vec()));
        let missing = format!("{}\n.v2", dir.join("missing").display());
        assert_eq!(dispatch::dispatch("store.readRecords", missing.as_bytes()), Ok(b"null".to_vec()));
        let file = format!("{}\n.v2", dir.join("a.v2").display());
        assert!(dispatch::dispatch("store.readRecords", file.as_bytes()).expect_err("no folder here").starts_with("list "));
        for bad in [&b"no newline"[..], b"\n.v2", b"dir\n", &[0xff, b'\n', b'x'][..]] {
            assert!(dispatch::dispatch("store.readRecords", bad).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
