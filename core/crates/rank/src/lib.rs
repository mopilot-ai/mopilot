//! Fuzzy ranking of a folder's paths for the file pickers (`electron/platform/search.cjs`): fzy-style scores, where
//! consecutive runs and matches at the start of a word or path segment win and gaps cost.
//!
//! Every position is a UTF-16 unit, as the window highlights them, and paths sort in UTF-16 order, as JS compares strings.

use dispatch::{Call, Handles};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashSet;

mod routes;

const GAP_LEADING: f64 = -0.005;
const GAP_TRAILING: f64 = -0.005;
const GAP_INNER: f64 = -0.01;
const CONSECUTIVE: f64 = 1.0;
const AFTER_SLASH: f64 = 0.9;
const AFTER_WORD: f64 = 0.8;
const AFTER_CAPITAL: f64 = 0.7;
const AFTER_DOT: f64 = 0.6;
const IN_BASENAME: f64 = 0.2;

const SLASH: u16 = b'/' as u16;

/// One path of a listing, in the forms a search reads.
#[derive(Debug)]
struct Entry {
    path: String,
    units: Vec<u16>,
    lower: Vec<u16>,
    /// Where each unit of `lower` came from in `units`, when lowercasing changed the length.
    positions: Option<Vec<u32>>,
    directory: bool,
}

impl Entry {
    fn new(path: String, directory: bool) -> Self {
        let units: Vec<u16> = path.encode_utf16().collect();
        let lower: Vec<u16> = path.to_lowercase().encode_utf16().collect();
        let positions = (lower.len() != units.len()).then(|| positions_of(&units));
        Entry { path, units, lower, positions, directory }
    }

    /// The unit of `units` that `lower[at]` came from.
    fn origin(&self, at: usize) -> usize {
        self.positions.as_ref().map_or(at, |positions| positions[at] as usize)
    }
}

/// For each unit a lowercased path holds, which unit of the path it came from. Lowercasing can expand a character
/// (İ → i + combining dot); surrogates keep their length, as their pair does.
fn positions_of(units: &[u16]) -> Vec<u32> {
    let mut positions = Vec::with_capacity(units.len() + 4);
    for (at, &unit) in units.iter().enumerate() {
        let expanded = char::from_u32(unit.into()).map_or(1, |c| c.to_lowercase().map(char::len_utf16).sum());
        positions.extend(std::iter::repeat_n(at as u32, expanded));
    }
    positions
}

/// A folder's paths and the folders that hold them, in that order.
#[derive(Debug)]
pub struct Listing {
    entries: Vec<Entry>,
}

impl Listing {
    pub fn new(files: impl IntoIterator<Item = String>) -> Self {
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        let mut folders = Vec::new();
        for file in files {
            for (at, _) in file.match_indices('/') {
                if at == 0 {
                    break;
                }
                if seen.insert(file[..at].to_string()) {
                    folders.push(file[..at].to_string());
                }
            }
            entries.push(Entry::new(file, false));
        }
        entries.extend(folders.into_iter().map(|folder| Entry::new(folder, true)));
        Listing { entries }
    }

    /// The best `limit` hits for `query`, with its white space ignored. An empty query lists the shortest paths first.
    pub fn search(&self, query: &str, root: &str, limit: usize, dirs: bool) -> Vec<Hit> {
        let query: String = query.chars().filter(|&c| !is_js_space(c)).collect();
        let q: Vec<u16> = query.to_lowercase().encode_utf16().collect();
        let mut tables = Tables::default();
        let mut found: Vec<(f64, usize)> = Vec::new();
        for (order, entry) in self.entries.iter().enumerate() {
            if !entry.directory || dirs {
                if let Some(score) = tables.score(&q, entry) {
                    found.push((score, order));
                }
            }
        }
        let better = |a: &(f64, usize), b: &(f64, usize)| self.compare(*a, *b);
        if limit > 0 && limit < found.len() {
            found.select_nth_unstable_by(limit - 1, better);
            found.truncate(limit);
        }
        found.sort_unstable_by(better);
        found.truncate(limit);
        found
            .into_iter()
            .map(|(score, order)| {
                let entry = &self.entries[order];
                tables.score(&q, entry);
                entry.hit(root, tables.indices(&q, entry), score)
            })
            .collect()
    }

    /// Best first: score, shortest path, path order, then the order they were listed in.
    fn compare(&self, (score_a, a): (f64, usize), (score_b, b): (f64, usize)) -> Ordering {
        let (first, second) = (&self.entries[a], &self.entries[b]);
        score_b
            .total_cmp(&score_a)
            .then_with(|| first.units.len().cmp(&second.units.len()))
            .then_with(|| first.units.cmp(&second.units))
            .then_with(|| a.cmp(&b))
    }
}

/// What a search answers for one path, in the shape of Codex's fuzzyFileSearch.
#[derive(Debug, PartialEq, Serialize)]
pub struct Hit {
    pub root: String,
    pub path: String,
    pub file_name: String,
    pub match_type: &'static str,
    pub indices: Vec<u32>,
    pub score: f64,
}

impl Entry {
    fn hit(&self, root: &str, indices: Vec<u32>, score: f64) -> Hit {
        let base = self.path.rfind('/').map_or(0, |at| at + 1);
        Hit {
            root: root.to_string(),
            path: self.path.clone(),
            file_name: self.path[base..].to_string(),
            match_type: if self.directory { "directory" } else { "file" },
            indices,
            score,
        }
    }
}

/// White space as a JS regular expression's `\s` matches it.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// The bonus for a match at `at` in the path itself.
fn bonus_at(units: &[u16], at: usize) -> f64 {
    if at == 0 {
        return AFTER_SLASH;
    }
    let is = |unit: u16, low: u8, high: u8| (u16::from(low)..=u16::from(high)).contains(&unit);
    match units[at - 1] {
        SLASH => AFTER_SLASH,
        0x2d | 0x5f | 0x20 => AFTER_WORD,
        0x2e => AFTER_DOT,
        before if is(before, b'a', b'z') && is(units[at], b'A', b'Z') => AFTER_CAPITAL,
        _ => 0.0,
    }
}

fn is_subsequence(q: &[u16], s: &[u16]) -> bool {
    let mut wanted = q.iter();
    let mut next = wanted.next();
    for unit in s {
        if next == Some(unit) {
            next = wanted.next();
        }
    }
    next.is_none()
}

/// The scoring tables, kept between paths so a search allocates them once.
#[derive(Default)]
struct Tables {
    /// Best score with q[i] matched at s[j], row by row.
    matched: Vec<f64>,
    /// Best score of q[..=i] within s[..=j], row by row.
    best: Vec<f64>,
    bonus: Vec<f64>,
}

impl Tables {
    /// The score of `q` against `entry`, or None when it isn't a subsequence.
    fn score(&mut self, q: &[u16], entry: &Entry) -> Option<f64> {
        let (n, m, s) = (q.len(), entry.lower.len(), &entry.lower);
        if n == 0 {
            return Some(0.0);
        }
        if n > m || !is_subsequence(q, s) {
            return None;
        }
        let base = entry.units.iter().rposition(|&unit| unit == SLASH).map_or(0, |at| at + 1);
        self.bonus.clear();
        self.bonus.extend((0..m).map(|j| {
            let at = entry.origin(j);
            let boundary = if entry.positions.is_some() && j > 0 && entry.origin(j - 1) == at { 0.0 } else { bonus_at(&entry.units, at) };
            boundary + if at >= base { IN_BASENAME } else { 0.0 }
        }));
        self.matched.clear();
        self.matched.resize(n * m, f64::NEG_INFINITY);
        self.best.clear();
        self.best.resize(n * m, f64::NEG_INFINITY);
        for (i, wanted) in q.iter().enumerate() {
            let mut previous = f64::NEG_INFINITY;
            let gap = if i == n - 1 { GAP_TRAILING } else { GAP_INNER };
            for (j, unit) in s.iter().enumerate() {
                if wanted == unit {
                    let score = if i == 0 {
                        j as f64 * GAP_LEADING + self.bonus[j]
                    } else if j > 0 {
                        (self.best[(i - 1) * m + j - 1] + self.bonus[j]).max(self.matched[(i - 1) * m + j - 1] + CONSECUTIVE)
                    } else {
                        f64::NEG_INFINITY
                    };
                    self.matched[i * m + j] = score;
                    previous = score.max(previous + gap);
                } else {
                    previous += gap;
                }
                self.best[i * m + j] = previous;
            }
        }
        Some(self.best[n * m - 1])
    }

    /// The matched positions in the path itself, each once, from the tables of the last `score` of this `entry`.
    fn indices(&self, q: &[u16], entry: &Entry) -> Vec<u32> {
        let (n, m) = (q.len(), entry.lower.len());
        let mut indices = vec![None; n];
        let mut must_match = false;
        let mut from = m;
        for i in (0..n).rev() {
            for j in (0..from).rev() {
                let matched = self.matched[i * m + j];
                if matched != f64::NEG_INFINITY && (must_match || matched == self.best[i * m + j]) {
                    let best = self.best[i * m + j];
                    must_match = i > 0 && j.checked_sub(1).is_some_and(|before| best == self.matched[(i - 1) * m + before] + CONSECUTIVE);
                    indices[i] = Some(entry.origin(j) as u32);
                    from = j;
                    break;
                }
            }
        }
        let mut out: Vec<u32> = Vec::with_capacity(n);
        for at in indices.into_iter().flatten() {
            if !out.contains(&at) {
                out.push(at);
            }
        }
        out
    }
}

/// The most listings held at once: the file pickers keep a few folders' open between keystrokes.
const MAX_LISTINGS: usize = 32;

/// The listings the routes hold, by id. They go with the environment that opened them.
static LISTINGS: Handles<Listing> = Handles::big("listing", MAX_LISTINGS);

/// Hold a listing of `files` for `call`: its id, or why not.
pub fn open(call: &Call, files: impl IntoIterator<Item = String>) -> Result<u64, String> {
    LISTINGS.open(call, Listing::new(files))
}

/// Search listing `id`.
pub fn search(id: u64, query: &str, root: &str, limit: usize, dirs: bool) -> Result<Vec<Hit>, String> {
    LISTINGS.with(id, |listing| listing.search(query, root, limit, dirs))
}

/// Let listing `id` go; whether it was open.
pub fn close(id: u64) -> bool {
    LISTINGS.close(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Written from the JS ranker before it was deleted: 412 cases, with case folding that changes lengths, surrogate
    /// pairs and final sigma. Scores match to the bit, since the windows sort and show what this returns.
    #[test]
    fn it_ranks_as_the_js_it_replaced() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../../../tests/fixtures/core/rank/rank.json")).expect("the fixture");
        assert!(cases.len() > 400);
        for case in &cases {
            let files = case["files"].as_array().expect("files").iter().map(|f| f.as_str().expect("a path").to_string());
            let listing = Listing::new(files);
            let query = case["query"].as_str().expect("a query");
            let limit = case["limit"].as_u64().expect("a limit") as usize;
            let dirs = case["dirs"].as_bool().expect("dirs");
            let hits = listing.search(query, case["root"].as_str().expect("a root"), limit, dirs);
            let expected = case["hits"].as_array().expect("hits");
            assert_eq!(hits.len(), expected.len(), "{query:?} in {:?}", case["files"]);
            for (hit, want) in hits.iter().zip(expected) {
                assert_eq!(hit.path, want["path"], "{query:?}");
                assert_eq!(hit.file_name, want["file_name"]);
                assert_eq!(hit.match_type, want["match_type"]);
                assert_eq!(serde_json::to_value(&hit.indices).expect("indices"), want["indices"], "{query:?} in {}", hit.path);
                assert_eq!(hit.score.to_bits(), want["score"].as_f64().expect("a score").to_bits(), "{query:?} in {}", hit.path);
            }
        }
    }

    #[test]
    fn an_empty_query_lists_the_shortest_paths_and_a_limit_of_none_nothing() {
        let listing = Listing::new(["a/b/c/readme.md", "readme.md", "x/readme.md"].map(String::from));
        let paths = |hits: Vec<Hit>| hits.into_iter().map(|hit| hit.path).collect::<Vec<_>>();
        assert_eq!(paths(listing.search("", "", 2, false)), ["readme.md", "x/readme.md"]);
        assert!(listing.search("", "", 0, false).is_empty());
        assert!(listing.search("zzz", "", 5, true).is_empty());
    }

    #[test]
    fn folders_are_found_once_and_a_path_can_be_both() {
        let listing = Listing::new(["a/b/c.ts", "a/b/d.ts", "a/b", "/abs/e.ts"].map(String::from));
        let hits = listing.search("ab", "/r", 10, true);
        let kinds: Vec<_> = hits.iter().map(|hit| (hit.path.as_str(), hit.match_type)).collect();
        assert_eq!(kinds, [("a/b", "file"), ("a/b", "directory"), ("/abs/e.ts", "file"), ("a/b/c.ts", "file"), ("a/b/d.ts", "file")]);
        assert_eq!(hits[3].file_name, "c.ts");
        assert_eq!(hits[3].root, "/r");
    }

    #[test]
    fn a_query_longer_than_a_path_or_an_empty_path_does_not_match() {
        let listing = Listing::new(["ab".to_string(), String::new()]);
        assert!(listing.search("abc", "", 5, false).is_empty());
        assert_eq!(listing.search("ab", "", 5, false).len(), 1);
    }

    #[test]
    fn two_characters_of_a_query_on_one_character_of_a_path_mark_it_once() {
        // lowercase, U+0130 is two characters, and both match where the path has one
        let listing = Listing::new(["\u{130}x".to_string()]);
        let hits = listing.search("i\u{307}x", "", 5, false);
        assert_eq!(hits[0].indices, [0, 1]);
    }
}
