//! The app's record files, read at startup for the chat store (electron/platform/chats.cjs): every file in a folder
//! with one extension, read in parallel, each checked as JSON. One reply carries them all, so the JS thread parses
//! once instead of reading and parsing file by file (docs/architecture/rust-core.md §6 step 2); and one record written
//! whole when the store commits it (`write`). The files' formats and what is made of them stay JS's: this reads files
//! and writes the bytes it is given.

use serde::de::IgnoredAny;
use std::fs;
use std::io;
use std::path::Path;

mod errors;
mod routes;
mod sys;
#[cfg(test)]
mod tests_write;
mod uv_table;
pub mod write;

/// One file of the folder, as read.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Entry {
    /// Its text, which is JSON: embedded in the reply as written.
    Json(String),
    /// Its text, which this did not accept as JSON: JS parses it as it always did, so whatever V8 makes of it (most
    /// often nothing, a damaged file) is what it made of it before.
    Text(String),
    /// It could not be read.
    Unread,
}

/// The files in `dir` whose names end in `ext`, sorted by name as Node lists them, each read and checked. Names and text are
/// decoded as Node decodes them, with invalid UTF-8 replaced. An error when the folder can't be listed.
pub fn read_records(dir: &Path, ext: &str) -> io::Result<Vec<(String, Entry)>> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|name| name.ends_with(ext))
        .collect();
    // in Node's order: fs.readdirSync sorts a folder's names byte by byte (libuv's scandir), and the store keeps it
    names.sort_unstable();
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8);
    let chunk = names.len().div_ceil(threads).max(1);
    let entries = std::thread::scope(|scope| {
        let workers: Vec<_> = names
            .chunks(chunk)
            .map(|part| scope.spawn(move || part.iter().map(|name| entry_of(fs::read(dir.join(name)))).collect::<Vec<_>>()))
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap_or_default()).collect::<Vec<_>>()
    });
    Ok(names.into_iter().zip(entries).collect())
}

/// A file's bytes as an entry: JSON when serde_json takes its text, else the text for JS to try.
fn entry_of(read: io::Result<Vec<u8>>) -> Entry {
    match read {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if serde_json::from_str::<IgnoredAny>(&text).is_ok() {
                Entry::Json(text)
            } else {
                Entry::Text(text)
            }
        }
        Err(_) => Entry::Unread,
    }
}

/// The reply: a JSON array of `[name, 0, value]`, `[name, 1, "text"]` and `[name, 2]`.
pub fn reply_json(entries: &[(String, Entry)]) -> String {
    let rows: Vec<String> = entries
        .iter()
        .map(|(name, entry)| match entry {
            Entry::Json(text) => format!("[{},0,{}]", json_string(name), text),
            Entry::Text(text) => format!("[{},1,{}]", json_string(name), json_string(text)),
            Entry::Unread => format!("[{},2]", json_string(name)),
        })
        .collect();
    format!("[{}]", rows.join(","))
}

/// `s` as a JSON string: quotes, backslashes and control characters escaped.
fn json_string(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system's temp folder, removed when dropped.
    struct Folder(std::path::PathBuf);
    impl Folder {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("mopilot-store-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("a folder");
            Folder(dir)
        }
        fn put(&self, name: &str, bytes: &[u8]) {
            fs::write(self.0.join(name), bytes).expect("a file");
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn each_file_with_the_extension_is_json_text_or_unread() {
        let f = Folder::new("kinds");
        f.put("a.v2", br#"{"id":"a","n":[1,2]}"#);
        f.put("b.v2", b"{not json");
        // a byte-order mark, which neither serde_json nor JSON.parse takes: text, which JS then finds unreadable
        f.put("c.v2", "\u{feff}{}".as_bytes());
        f.put("d.v2", b"{\"t\":\"\xff\"}");
        f.put("e.json", b"{}");
        fs::create_dir(f.0.join("f.v2")).expect("a folder named like a file");
        let got = read_records(&f.0, ".v2").expect("a listing");
        assert_eq!(
            got,
            vec![
                ("a.v2".into(), Entry::Json(r#"{"id":"a","n":[1,2]}"#.into())),
                ("b.v2".into(), Entry::Text("{not json".into())),
                ("c.v2".into(), Entry::Text("\u{feff}{}".into())),
                // invalid UTF-8 is replaced, as Node's utf8 decoding does, and the result is JSON
                ("d.v2".into(), Entry::Json("{\"t\":\"\u{fffd}\"}".into())),
                ("f.v2".into(), Entry::Unread),
            ]
        );
    }

    #[test]
    fn a_folder_that_cannot_be_listed_is_an_error_and_an_empty_one_is_no_entries() {
        let f = Folder::new("empty");
        assert_eq!(read_records(&f.0, ".v2").expect("a listing"), vec![]);
        assert!(read_records(&f.0.join("missing"), ".v2").is_err());
    }

    #[test]
    fn the_reply_embeds_json_as_written_and_escapes_names_and_text() {
        let entries = vec![
            ("a\"b.v2".to_string(), Entry::Json("{\"x\":1}".into())),
            ("c.v2".to_string(), Entry::Text("{\n\"oops".into())),
            ("d.v2".to_string(), Entry::Unread),
        ];
        assert_eq!(reply_json(&entries), r#"[["a\"b.v2",0,{"x":1}],["c.v2",1,"{\n\"oops"],["d.v2",2]]"#);
        assert_eq!(reply_json(&[]), "[]");
    }
}
