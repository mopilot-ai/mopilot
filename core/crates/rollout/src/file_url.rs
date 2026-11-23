//! `decodeURIComponent(new URL(url).pathname)` for a `file://` URL, by the WHATWG URL standard's steps for that scheme, which
//! the `url` crate parts from on `file:////a` and `file:///C|/`. A URL `new URL` refuses, or that doesn't decode, is `None`.
//!
//! A host is only checked: `new URL` refuses one that couldn't be a host, and a refusal fails the read. Codex writes none,
//! so the one thing left out is what needs Unicode's tables, an ill-formed international name, which is taken as valid.

use std::net::Ipv6Addr;

/// The path of `url`, which starts `file://`, with its escapes decoded.
pub fn plain_path(url: &str) -> Option<String> {
    let url: String = url.trim_end_matches(|c| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let rest = url.strip_prefix("file://")?;
    let (host, after) = rest.split_at(rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len()));
    // the standard's quirk: `file://C:/x` has a drive letter where its host would be
    let path = if is_drive_letter(host) {
        rest
    } else if valid_host(host) {
        after.strip_prefix(['/', '\\']).unwrap_or(after)
    } else {
        return None;
    };
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    decode_uri_component(&pathname(path))
}

/// `A:` or `A|`.
fn is_drive_letter(segment: &str) -> bool {
    matches!(segment.as_bytes(), [letter, b':' | b'|'] if letter.is_ascii_alphabetic())
}

fn is_dot(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(segment: &str) -> bool {
    ["..", ".%2e", "%2e.", "%2e%2e"].iter().any(|dots| segment.eq_ignore_ascii_case(dots))
}

/// The pathname of a path with its first slash gone: the segments, past `.` and `..`, each after a slash. A drive letter
/// is `C:` however it was written, and `..` never goes above it.
fn pathname(path: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    let mut parts = path.split(['/', '\\']).peekable();
    while let Some(segment) = parts.next() {
        let last = parts.peek().is_none();
        if is_double_dot(segment) {
            if !matches!(segments.as_slice(), [only] if is_drive_letter(only)) {
                segments.pop();
            }
            if last {
                segments.push(String::new());
            }
        } else if !is_dot(segment) {
            let drive = segments.is_empty() && is_drive_letter(segment);
            segments.push(if drive { format!("{}:", &segment[..1]) } else { segment.to_string() });
        } else if last {
            segments.push(String::new());
        }
    }
    segments.iter().map(|segment| format!("/{segment}")).collect()
}

/// The value of a `%XX` at the start of `bytes`.
fn escape_at(bytes: &[u8]) -> Option<u8> {
    let [b'%', high, low, ..] = *bytes else {
        return None;
    };
    Some(((high as char).to_digit(16)? * 16 + (low as char).to_digit(16)?) as u8)
}

/// `decodeURIComponent(text)`, or `None` for what it throws on: a `%` with no two hex digits after it, or bytes that are
/// not UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            out.push(escape_at(&bytes[at..])?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A host's escapes decoded, leaving a `%` that starts none as it is: the standard's percent-decode, not the strict one.
fn percent_decoded(host: &str) -> String {
    let bytes = host.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match escape_at(&bytes[at..]) {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether `new URL` takes this host of a file URL.
fn valid_host(host: &str) -> bool {
    if let Some(inside) = host.strip_prefix('[') {
        return inside.strip_suffix(']').is_some_and(|address| address.parse::<Ipv6Addr>().is_ok());
    }
    let domain = percent_decoded(host);
    // U+FFFD is in Unicode's list of what no domain holds, and it is how a bad escape decodes
    let forbidden = |c: char| c <= ' ' || "#/:<>?@[\\]^|%\u{7f}\u{fffd}".contains(c);
    !domain.contains(forbidden) && (!ends_in_number(&domain) || is_ipv4(&domain))
}

/// An IPv4 address's number: decimal, `0x` hex or `0` octal, with `None` for what isn't one. Past any address it is simply
/// large.
fn ipv4_number(part: &str) -> Option<u64> {
    let lower = part.to_ascii_lowercase();
    let (radix, digits) = match lower.strip_prefix("0x") {
        Some(hex) => (16, hex),
        None if lower.len() > 1 && lower.starts_with('0') => (8, &lower[1..]),
        None => (10, lower.as_str()),
    };
    if part.is_empty() {
        return None;
    }
    digits.chars().try_fold(0u64, |number, digit| Some(number.saturating_mul(radix).saturating_add(digit.to_digit(radix as u32)?.into())))
}

/// A domain's dot-separated parts, a dot at its end not making one.
fn parts(domain: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = domain.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    parts
}

/// The standard's "ends in a number": such a host must be an IPv4 address.
fn ends_in_number(domain: &str) -> bool {
    let last = parts(domain).pop().unwrap_or_default();
    (!last.is_empty() && last.bytes().all(|byte| byte.is_ascii_digit())) || ipv4_number(last).is_some()
}

fn is_ipv4(domain: &str) -> bool {
    let parts = parts(domain);
    let Some(numbers) = parts.iter().map(|part| ipv4_number(part)).collect::<Option<Vec<_>>>() else {
        return false;
    };
    numbers.len() <= 4
        && numbers
            .split_last()
            .is_some_and(|(last, others)| others.iter().all(|&number| number <= 255) && *last < 256u64.pow(5 - others.len() as u32 - 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_normalize_as_the_standard_says() {
        for (url, path) in [
            ("file:///a/b", "/a/b"),
            ("file:///a%20b/%E4%B8%AD%2Fc", "/a b/\u{4e2d}/c"),
            ("file:///a b/\u{4e2d}", "/a b/\u{4e2d}"),
            ("file:////a", "//a"),
            ("file:///a//b/", "/a//b/"),
            ("file:///a/../b/./c", "/b/c"),
            ("file:///a/%2E%2e/b/%2e/c/.%2E", "/b/"),
            ("file:///a/%2e./.", "/"),
            ("file:///a/b/.", "/a/b/"),
            ("file:///a/b/..", "/a/"),
            ("file:///..", "/"),
            ("file:///a\\b", "/a/b"),
            ("file:///a?q#f", "/a"),
            ("file:///a#f?q", "/a"),
            ("file:///a\tb\nc\r", "/abc"),
            ("file:///a \u{1}", "/a"),
            ("file://", "/"),
            ("file:///", "/"),
            ("file://host", "/"),
            ("file://host/a", "/a"),
            ("file://host\\a", "/a"),
            ("file:///C:/x", "/C:/x"),
            ("file:///C|/x", "/C:/x"),
            ("file:///C|", "/C:"),
            ("file://C:/x", "/C:/x"),
            ("file://c|/x", "/c:/x"),
            ("file:///C:/../x", "/C:/x"),
            ("file:///C|/..", "/C:/"),
            ("file:///a/C|/x", "/a/C|/x"),
            ("file:///1:/x", "/1:/x"),
            ("file:///a%00b", "/a\0b"),
        ] {
            assert_eq!(plain_path(url).as_deref(), Some(path), "{url}");
        }
    }

    #[test]
    fn what_is_no_url_or_does_not_decode_is_refused() {
        for bad in ["/a", "file:///%", "file:///%2", "file:///%zz", "file:///%ff", "file:///%ed%a0%80", "file:///\u{4e2d}%e4"] {
            assert_eq!(plain_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_host_is_only_checked() {
        for good in [
            "h",
            "H.example",
            "a..b",
            "a%2Eb",
            "\u{e9}.example",
            "[::1]",
            "[1:2::3]",
            "localhost",
            "1.2.3.4",
            "1.2.3.4.",
            "1.2.3",
            "1.2",
            "16909060",
            "0x7f.1",
            "0177.0.0.1",
            "0",
            "0x",
            "4294967295",
            "1.a",
            "1.2.a",
            ".",
            "xn--a",
        ] {
            assert_eq!(plain_path(&format!("file://{good}/p")).as_deref(), Some("/p"), "{good}");
        }
        for bad in [
            "[",
            "[::1",
            "[1]",
            "a b",
            "a%20b",
            "exa%mple",
            "h:80",
            "u@h",
            "a[",
            "a]",
            "a^b",
            "a|b",
            "a<b",
            "a>b",
            "256.1.1.1",
            "1.2.3.256",
            "1.2.65536",
            "1.16777216",
            "4294967296",
            "1.2.3.4.5",
            "1.2.3.09",
            "a.1",
            "a.0x1",
            "0x.0xg.1",
            "99999999999999999999999",
            "%ff",
            "%fe.a",
        ] {
            assert_eq!(plain_path(&format!("file://{bad}/p")), None, "{bad}");
        }
    }
}
