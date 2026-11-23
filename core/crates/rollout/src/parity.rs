//! The JS parser's output, compared here byte for byte: `lines.json` holds what its tests read and each trap of JS and JSON
//! semantics, `zstd.json` compressed files and `fuzz.json` random odd rollouts (tests/fixtures/core/rollout/, made by the
//! parser before it was deleted, reading each case as electron/harness/codexRollout.cjs did). No `history` is a read that
//! failed.

use crate::{page_of, read};
use dispatch::CancelToken;
use serde_json::Value;

/// What was in the file.
fn input(case: &Value) -> Vec<u8> {
    if let Some(text) = case["text"].as_str() {
        return text.as_bytes().to_vec();
    }
    let hex = case["hex"].as_str().expect("the file's bytes").as_bytes();
    hex.chunks(2).map(|pair| u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("hex")).collect()
}

/// The history as the fixture spells it, `{ cwd, turns }`, or `None` for a read that failed.
fn history_json(path: &str) -> Option<String> {
    let history = read(path, &CancelToken::default()).ok()?;
    let turns = page_of(&history, 0, usize::MAX, usize::MAX);
    let cwd = String::from_utf8(history.cwd).expect("UTF-8");
    Some(format!(r#"{{"cwd":{cwd},"turns":{}}}"#, String::from_utf8(turns).expect("UTF-8")))
}

/// Each of the cases in `fixture`, read and held to what the JS read.
fn reads_as_the_js(fixture: &str, tag: &str, at_least: usize) {
    let cases: Vec<Value> = serde_json::from_str(fixture).expect("the fixture");
    assert!(cases.len() >= at_least, "{} cases", cases.len());
    let dir = std::env::temp_dir().join(format!("mopilot-rollout-parity-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a folder");
    for case in &cases {
        let path = dir.join(case["file"].as_str().unwrap_or("x.jsonl"));
        std::fs::write(&path, input(case)).expect("a file");
        let read = history_json(path.to_str().expect("UTF-8"));
        assert_eq!(read.as_deref(), case["history"].as_str(), "{}", case["name"]);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn lines_read_as_the_js_read_them() {
    reads_as_the_js(include_str!("../../../../tests/fixtures/core/rollout/lines.json"), "lines", 650);
}

#[test]
fn compressed_files_read_as_the_js_read_them() {
    reads_as_the_js(include_str!("../../../../tests/fixtures/core/rollout/zstd.json"), "zstd", 20);
}

#[test]
fn random_rollouts_read_as_the_js_read_them() {
    reads_as_the_js(include_str!("../../../../tests/fixtures/core/rollout/fuzz.json"), "fuzz", 1000);
}
