//! The JS's regular expressions, each as what it matched. Text here is a `Text`'s bytes, in which everything these look for is
//! ASCII or a whole character, so a byte offset means what a unit's did. `\w`, `\b` and `\d` are ASCII in JS, `i` without `u`
//! folds ASCII with ASCII only, and `\s` is what `trim` takes.

use crate::reads::line_end;
use jsvalue::{trim_end, trim_start};
use memchr::memmem;

pub fn find(text: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    memmem::find(&text[from..], needle).map(|at| at + from)
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `\b` before `text[at]`.
fn boundary(text: &[u8], at: usize) -> bool {
    let before = text.get(at.wrapping_sub(1)).copied().is_some_and(is_word);
    before != text.get(at).copied().is_some_and(is_word)
}

/// Where `\s*` from `at` ends.
fn skip_spaces(text: &[u8], at: usize) -> usize {
    text.len() - trim_start(&text[at..]).len()
}

/// What follows `/^\s*head/`, if that matched.
pub fn after_opening<'a>(text: &'a [u8], head: &[u8]) -> Option<&'a [u8]> {
    trim_start(text).strip_prefix(head)
}

/// `/<open>([\s\S]*?)<close>/`: what stands between the first `open` and the first `close` after it.
pub fn between<'a>(text: &'a [u8], open: &[u8], close: &[u8]) -> Option<&'a [u8]> {
    let start = find(text, open, 0)? + open.len();
    Some(&text[start..find(text, close, start)?])
}

/// `text.replace(/^ {2}/gm, '')`: a line starts after any of `.`'s terminators.
pub fn dedent(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut line = 0;
    loop {
        let start = if text[line..].starts_with(b"  ") { line + 2 } else { line };
        let Some((end, length)) = line_end(text, start) else {
            out.extend_from_slice(&text[start..]);
            return out;
        };
        out.extend_from_slice(&text[start..end + length]);
        line = end + length;
    }
}

/// `text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')`.
pub fn without_reminders(text: &[u8]) -> Vec<u8> {
    const OPEN: &[u8] = b"<system-reminder>";
    const CLOSE: &[u8] = b"</system-reminder>";
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while let Some(open) = find(text, OPEN, at) {
        let Some(close) = find(text, CLOSE, open + OPEN.len()) else { break };
        out.extend_from_slice(&text[at..open]);
        at = close + CLOSE.len();
    }
    out.extend_from_slice(&text[at..]);
    out
}

/// `text.replace(/\r\n?/g, '\n')`.
pub fn unix_lines(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut bytes = text.iter().copied().peekable();
    while let Some(byte) = bytes.next() {
        out.push(if byte == b'\r' { b'\n' } else { byte });
        if byte == b'\r' {
            bytes.next_if_eq(&b'\n');
        }
    }
    out
}

/// `/<command-name>(.*?)<\/command-name>/`: a name that stays on its line, or the next one that does.
pub fn command_name(text: &[u8]) -> Option<&[u8]> {
    const OPEN: &[u8] = b"<command-name>";
    let mut from = 0;
    while let Some(open) = find(text, OPEN, from) {
        let start = open + OPEN.len();
        let close = find(text, b"</command-name>", start)?;
        if line_end(&text[..close], start).is_none() {
            return Some(&text[start..close]);
        }
        from = start;
    }
    None
}

/// `/^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(text)`.
pub fn is_local_output(text: &[u8]) -> bool {
    let tags: [&[u8]; 4] = [b"<local-command-stdout>", b"<local-command-stderr>", b"<bash-stdout>", b"<bash-stderr>"];
    tags.iter().any(|tag| after_opening(text, tag).is_some())
}

/// `/^\s*<(?:task|agent|bash)-notification>/`: which it was.
pub fn notification_root(text: &[u8]) -> Option<&'static str> {
    let roots: [(&str, &[u8]); 3] =
        [("task", b"<task-notification>"), ("agent", b"<agent-notification>"), ("bash", b"<bash-notification>")];
    roots.iter().find_map(|(root, tag)| after_opening(text, tag).map(|_| *root))
}

/// `/^\s*<cross-session-message\b/.test(text)`.
pub fn is_cross_session(text: &[u8]) -> bool {
    after_opening(text, b"<cross-session-message").is_some_and(|rest| !rest.first().copied().is_some_and(is_word))
}

/// `/<cross-session-message\b[^>]*\bname="([^"]*)"/`: `[^>]*` is greedy, so of a tag's `name="`s the last that has a closing
/// quote wins, and a tag with none gives way to the next tag.
pub fn cross_session_name(text: &[u8]) -> Option<&[u8]> {
    const OPEN: &[u8] = b"<cross-session-message";
    const NAME: &[u8] = b"name=\"";
    let mut from = 0;
    while let Some(open) = find(text, OPEN, from) {
        let tag = open + OPEN.len();
        from = tag;
        if text.get(tag).copied().is_some_and(is_word) {
            continue;
        }
        let end = memchr::memchr(b'>', &text[tag..]).map_or(text.len(), |at| tag + at);
        let names: Vec<usize> = memmem::find_iter(&text[tag..end], NAME).map(|at| at + tag).filter(|at| boundary(text, *at)).collect();
        let quoted = names.iter().rev().find_map(|at| {
            let start = at + NAME.len();
            memchr::memchr(b'"', &text[start..]).map(|length| &text[start..start + length])
        });
        if quoted.is_some() {
            return quoted;
        }
    }
    None
}

/// `/Monitor event:\s*"([\s\S]*)"/`: from the first quote to the last.
pub fn monitor_label(summary: &[u8]) -> Option<&[u8]> {
    const HEAD: &[u8] = b"Monitor event:";
    let mut from = 0;
    while let Some(head) = find(summary, HEAD, from) {
        from = head + HEAD.len();
        let quote = skip_spaces(summary, from);
        if summary.get(quote) == Some(&b'"') {
            let close = memchr::memrchr(b'"', &summary[quote + 1..])?;
            return Some(&summary[quote + 1..quote + 1 + close]);
        }
    }
    None
}

/// The next run of word characters from `at`: where it starts and ends.
fn next_word(text: &[u8], at: usize) -> Option<(usize, usize)> {
    let start = at + text[at..].iter().position(|byte| is_word(*byte))?;
    let length = text[start..].iter().position(|byte| !is_word(*byte)).unwrap_or(text.len() - start);
    Some((start, start + length))
}

fn is_word_of(word: &[u8], words: &[&str]) -> bool {
    words.iter().any(|known| word.eq_ignore_ascii_case(known.as_bytes()))
}

/// `(?:fail\w*|errors?)` of a whole word, ignoring case.
fn is_failing_word(word: &[u8]) -> bool {
    word.get(..4).is_some_and(|head| head.eq_ignore_ascii_case(b"fail")) || is_word_of(word, &["error", "errors"])
}

/// `/\b(?:0|no|zero)\s+(?:fail\w*|errors?)\b/i` for the word at `word`: where it ends.
fn none_of_them(text: &[u8], word: (usize, usize)) -> Option<usize> {
    if !is_word_of(&text[word.0..word.1], &["0", "no", "zero"]) {
        return None;
    }
    let after = skip_spaces(text, word.1);
    let (start, end) = next_word(text, after).filter(|(start, _)| *start == after && after > word.1)?;
    is_failing_word(&text[start..end]).then_some(end)
}

/// `/\b(?:fail\w*|errors?)\s*[:=]\s*0\b/i` for the word at `word`: where it ends.
fn counted_as_none(text: &[u8], word: (usize, usize)) -> Option<usize> {
    if !is_failing_word(&text[word.0..word.1]) {
        return None;
    }
    let sign = skip_spaces(text, word.1);
    if !matches!(text.get(sign), Some(b':' | b'=')) {
        return None;
    }
    let zero = skip_spaces(text, sign + 1);
    (text.get(zero) == Some(&b'0') && boundary(text, zero + 1)).then_some(zero + 1)
}

/// `FAILED_RE.test(text.replace(NONE_FAILED_RE, ''))` of a monitor's event: it says something went wrong, and not that nothing
/// did. Each alternative is whole words, so whole words are what this compares.
pub fn says_failed(text: &[u8]) -> bool {
    const FAILED: [&str; 10] = ["fail", "fails", "failed", "failure", "failing", "error", "errors", "errored", "canceled", "cancelled"];
    let mut kept = Vec::with_capacity(text.len());
    let (mut at, mut copied) = (0, 0);
    while let Some(word) = next_word(text, at) {
        match none_of_them(text, word).or_else(|| counted_as_none(text, word)) {
            Some(end) => {
                kept.extend_from_slice(&text[copied..word.0]);
                (at, copied) = (end, end);
            }
            None => at = word.1,
        }
    }
    kept.extend_from_slice(&text[copied..]);
    let mut at = 0;
    while let Some((start, end)) = next_word(&kept, at) {
        at = end;
        let word = &kept[start..end];
        if is_word_of(word, &FAILED) {
            return true;
        }
        if word.eq_ignore_ascii_case(b"timed") && kept.get(end) == Some(&b' ') {
            let out = next_word(&kept, end + 1).filter(|(start, _)| *start == end + 1);
            if out.is_some_and(|(start, end)| kept[start..end].eq_ignore_ascii_case(b"out")) {
                return true;
            }
        }
    }
    false
}

/// `/^\s*Goal set: ([\s\S]+?)\s*$/`: at least one unit, then all of it but trailing whitespace.
pub fn goal_set(text: &[u8]) -> Option<&[u8]> {
    let rest = after_opening(text, b"Goal set: ")?;
    let kept = trim_end(rest);
    if !kept.is_empty() {
        return Some(kept);
    }
    // whitespace alone: `+?` still takes one character of it, of one, two or three bytes
    let length = match rest.first()? {
        byte if *byte < 0x80 => 1,
        0xc2 => 2,
        _ => 3,
    };
    Some(&rest[..length])
}

/// `/^\s*Stop hook feedback:\s*\n\s*\[([^\n]*?)\]: ([\s\S]*?)\s*$/`: the condition and the reason.
pub fn stop_feedback(text: &[u8]) -> Option<(&[u8], &[u8])> {
    let rest = after_opening(text, b"Stop hook feedback:")?;
    let bracket = trim_start(rest);
    if !rest[..rest.len() - bracket.len()].contains(&b'\n') {
        return None;
    }
    let inner = bracket.strip_prefix(b"[")?;
    let close = find(inner, b"]: ", 0)?;
    if inner[..close].contains(&b'\n') {
        return None;
    }
    Some((&inner[..close], trim_end(&inner[close + 3..])))
}

/// What `/^head(.+)/` took: up to the end of the line, at least a character.
pub fn rest_of_line<'a>(text: &'a [u8], head: &[u8]) -> Option<&'a [u8]> {
    let rest = text.strip_prefix(head)?;
    let end = line_end(rest, 0).map_or(rest.len(), |(end, _)| end);
    (end > 0).then_some(&rest[..end])
}

/// `/^head\b/.test(text)`.
pub fn opens_word(text: &[u8], head: &[u8]) -> bool {
    text.starts_with(head) && boundary(text, head.len())
}

/// `/^Exit code (-?\d+)(?:\n|$)/`: the number's text, and how much the match took.
pub fn exit_code(text: &[u8]) -> Option<(&[u8], usize)> {
    const HEAD: &[u8] = b"Exit code ";
    let rest = text.strip_prefix(HEAD)?;
    let sign = usize::from(rest.first() == Some(&b'-'));
    let digits = rest[sign..].iter().position(|byte| !byte.is_ascii_digit()).unwrap_or(rest.len() - sign);
    let end = sign + digits;
    match rest.get(end) {
        _ if digits == 0 => None,
        Some(b'\n') => Some((&rest[..end], HEAD.len() + end + 1)),
        None => Some((&rest[..end], HEAD.len() + end)),
        Some(_) => None,
    }
}

/// `/doesn't want to proceed|user (?:rejected|declined|denied)|permission (?:was )?denied|was rejected/i.test(text)`.
pub fn was_denied(text: &[u8]) -> bool {
    const WORDS: [&str; 7] = [
        "doesn't want to proceed",
        "user rejected",
        "user declined",
        "user denied",
        "permission denied",
        "permission was denied",
        "was rejected",
    ];
    let lower = text.to_ascii_lowercase();
    WORDS.iter().any(|words| memmem::find(&lower, words.as_bytes()).is_some())
}

/// The digits of a count after `name`, with `>` or `:` and any whitespace between (`/name(?:>|:)\s*(\d+)/`), and where it was.
fn digits_after<'a>(text: &'a [u8], name: &[u8]) -> Option<(&'a [u8], usize)> {
    let mut from = 0;
    while let Some(at) = find(text, name, from) {
        from = at + name.len();
        if matches!(text.get(from), Some(b'>' | b':')) {
            let start = skip_spaces(text, from + 1);
            let digits = text[start..].iter().position(|byte| !byte.is_ascii_digit()).unwrap_or(text.len() - start);
            if digits > 0 {
                return Some((&text[start..start + digits], at));
            }
        }
    }
    None
}

/// `Number` of digits.
fn number(digits: &[u8]) -> Option<f64> {
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// The first count after any of `names`: `/(?:subagent|total)_tokens(?:>|:)\s*(\d+)/` and its like.
pub fn count(text: &[u8], names: &[&str]) -> Option<f64> {
    let found = names.iter().filter_map(|name| digits_after(text, name.as_bytes()));
    number(found.min_by_key(|found| found.1)?.0)
}

/// `a` and 16 hex digits, at the start of `text`.
fn agent_id(text: &[u8]) -> Option<&[u8]> {
    let id = text.get(..17)?;
    (id[0] == b'a' && id[1..].iter().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))).then_some(id)
}

/// `/agentId: (a[0-9a-f]{16})/`.
pub fn agent_id_anywhere(text: &[u8]) -> Option<&[u8]> {
    memmem::find_iter(text, b"agentId: ").find_map(|at| agent_id(&text[at + 9..]))
}

/// What Claude Code's trailer on an Agent result says.
pub struct Trailer<'a> {
    pub index: usize,
    pub id: &'a [u8],
    pub worktree: &'a [u8],
    pub tokens: f64,
    pub tools: f64,
}

/// The digits at the start of `text`, as a number, and what follows them after `after`.
fn number_then<'a>(text: &'a [u8], after: &[u8]) -> Option<(f64, &'a [u8])> {
    let digits = text.iter().position(|byte| !byte.is_ascii_digit()).unwrap_or(text.len());
    let read = number(&text[..digits]).filter(|_| digits > 0)?;
    Some((read, text[digits..].strip_prefix(after)?))
}

/// The trailer whose `agentId: ` is at `at`, if the text ends with it.
fn trailer_at(text: &[u8], at: usize, index: usize) -> Option<Trailer<'_>> {
    let rest = text[at..].strip_prefix(b"agentId: ")?;
    let id = agent_id(rest)?;
    let rest = rest[17..].strip_prefix(b" (use SendMessage with to: '")?;
    let rest = rest.strip_prefix(id)?.strip_prefix(b"'")?;
    let rest = rest.strip_prefix(b", summary: '<5-10 word recap>'").unwrap_or(rest);
    let mut rest = rest.strip_prefix(b" to continue this agent)")?;
    let start = text.len() - rest.len();
    for _ in 0..2 {
        if !rest.starts_with(b"\nworktreePath: ") && !rest.starts_with(b"\nworktreeBranch: ") {
            break;
        }
        rest = &rest[1 + rest[1..].iter().position(|byte| *byte == b'\n').unwrap_or(rest.len() - 1)..];
    }
    let worktree = &text[start..text.len() - rest.len()];
    let rest = rest.strip_prefix(b"\n<usage>")?;
    let rest = rest.strip_prefix(b"subagent_tokens: ").or_else(|| rest.strip_prefix(b"total_tokens: "))?;
    let (tokens, rest) = number_then(rest, b"\ntool_uses: ")?;
    let (tools, rest) = number_then(rest, b"\nduration_ms: ")?;
    let (_, rest) = number_then(rest, b"</usage>")?;
    rest.is_empty().then_some(Trailer { index, id, worktree, tokens, tools })
}

/// `AGENT_TRAILER_RE`: the first `agentId: ` that opens a line and has a whole trailer to the end of the text.
pub fn trailer(text: &[u8]) -> Option<Trailer<'_>> {
    memmem::find_iter(text, b"agentId: ").find_map(|at| match at {
        0 => trailer_at(text, 0, 0),
        at if text[at - 1] == b'\n' => trailer_at(text, at, at - 1),
        _ => None,
    })
}

/// `/^\s*\[Subagent hand-back\][^\n]*?The report follows:\n/`: how much that took of `text`.
pub fn handback_frame(text: &[u8]) -> Option<usize> {
    let rest = after_opening(text, b"[Subagent hand-back]")?;
    let line = rest.iter().position(|byte| *byte == b'\n')?;
    rest[..line].ends_with(b"The report follows:").then_some(text.len() - rest.len() + line + 1)
}

/// `/The report follows:\n([\s\S]*?)\n?<\/agent-message>/`.
pub fn handback_body(text: &[u8]) -> Option<&[u8]> {
    const HEAD: &[u8] = b"The report follows:\n";
    let start = find(text, HEAD, 0)? + HEAD.len();
    let close = find(text, b"</agent-message>", start)?;
    Some(&text[start..if close > start && text[close - 1] == b'\n' { close - 1 } else { close }])
}

/// `/<agent-message from="([^"]*)"/`.
pub fn handback_from(text: &[u8]) -> Option<&[u8]> {
    const HEAD: &[u8] = b"<agent-message from=\"";
    let start = find(text, HEAD, 0)? + HEAD.len();
    memchr::memchr(b'"', &text[start..]).map(|length| &text[start..start + length])
}

/// `/Task #(\S+)/`.
pub fn task_number(text: &[u8]) -> Option<&[u8]> {
    memmem::find_iter(text, b"Task #").find_map(|at| {
        let start = at + 6;
        let mut end = start;
        while end < text.len() && skip_spaces(text, end) == end {
            end += 1;
        }
        (end > start).then_some(&text[start..end])
    })
}

/// `/"([^"]+)"/`: the first pair of quotes with something between them.
pub fn first_quoted(text: &[u8]) -> Option<&[u8]> {
    let quotes: Vec<usize> = memchr::memchr_iter(b'"', text).collect();
    quotes.windows(2).find(|pair| pair[1] > pair[0] + 1).map(|pair| &text[pair[0] + 1..pair[1]])
}

/// `/^\s*agent\b/i.test(text)`.
pub fn opens_with_agent(text: &[u8]) -> bool {
    let rest = trim_start(text);
    rest.get(..5).is_some_and(|word| word.eq_ignore_ascii_case(b"agent")) && boundary(rest, 5)
}

/// `/^\s*\/(code-review|review|security-review|ultrareview)\b/.test(text)`.
pub fn is_review_command(text: &[u8]) -> bool {
    let Some(rest) = after_opening(text, b"/") else { return false };
    let names: [&[u8]; 4] = [b"code-review", b"review", b"security-review", b"ultrareview"];
    names.iter().any(|name| rest.starts_with(name) && boundary(rest, name.len()))
}
