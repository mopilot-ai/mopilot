//! JS values as `JSON.parse` makes them, for a reader that must do what the JS did with whatever a line holds: strings of
//! UTF-16 units that may hold a lone surrogate (kept as WTF-8), objects whose keys are in JS's order and each once, and
//! numbers that are all doubles.

use std::cmp::Ordering;
use std::collections::HashMap;

/// A JS string, as WTF-8: UTF-8, but for a lone surrogate, which takes the three bytes UTF-8 would give it. Every search
/// of one here is for ASCII, which reads the same in these bytes as in the units.
#[derive(Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Text(Vec<u8>);

impl Text {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn is(&self, text: &str) -> bool {
        self.0 == text.as_bytes()
    }

    pub fn push_str(&mut self, text: &str) {
        self.0.extend_from_slice(text.as_bytes());
    }

    /// The bytes of a run that holds no surrogate of its own.
    pub fn push_bytes(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    /// The lead surrogate this ends in, if it does.
    fn trailing_lead(&self) -> Option<u16> {
        match self.0[self.0.len().saturating_sub(3)..] {
            [0xed, second @ 0xa0..=0xaf, third] => Some(0xd000 | u16::from(second & 0x3f) << 6 | u16::from(third & 0x3f)),
            _ => None,
        }
    }

    /// One UTF-16 unit, which joins a lead surrogate before it into their character.
    pub fn push_unit(&mut self, unit: u16) {
        if let (0xdc00..=0xdfff, Some(lead)) = (unit, self.trailing_lead()) {
            self.0.truncate(self.0.len() - 3);
            let code = 0x10000 + ((u32::from(lead) - 0xd800) << 10) + (u32::from(unit) - 0xdc00);
            let joined = char::from_u32(code).expect("a surrogate pair is a character");
            self.0.extend_from_slice(joined.encode_utf8(&mut [0; 4]).as_bytes());
            return;
        }
        match unit {
            0..=0x7f => self.0.push(unit as u8),
            0x80..=0x7ff => self.0.extend_from_slice(&[0xc0 | (unit >> 6) as u8, 0x80 | (unit & 0x3f) as u8]),
            _ => self.0.extend_from_slice(&[0xe0 | (unit >> 12) as u8, 0x80 | ((unit >> 6) & 0x3f) as u8, 0x80 | (unit & 0x3f) as u8]),
        }
    }

    /// `this + more`: a lead surrogate at the end of this and a trail one at the start of `more` become their character.
    pub fn push_text(&mut self, more: &Text) {
        let mut units = more.units();
        match units.next() {
            Some(first @ 0xdc00..=0xdfff) if self.trailing_lead().is_some() => {
                self.push_unit(first);
                self.0.extend_from_slice(&more.0[3..]);
            }
            _ => self.0.extend_from_slice(&more.0),
        }
    }

    /// The UTF-16 units, as JS indexes and compares them.
    pub fn units(&self) -> Units<'_> {
        Units { bytes: &self.0, low: None }
    }

    /// This as a string of scalar values: each lone surrogate is U+FFFD, as a web API's USVString makes it.
    pub fn lossy(&self) -> String {
        char::decode_utf16(self.units()).map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER)).collect()
    }

    /// JS's `<`: by UTF-16 unit, where UTF-8's order puts a character above U+FFFF after U+E000 to U+FFFF.
    pub fn compare_units(&self, other: &Text) -> Ordering {
        self.units().cmp(other.units())
    }
}

impl From<&str> for Text {
    fn from(text: &str) -> Self {
        Text(text.as_bytes().to_vec())
    }
}

impl From<u16> for Text {
    fn from(unit: u16) -> Self {
        let mut text = Text::default();
        text.push_unit(unit);
        text
    }
}

/// A `Text`'s UTF-16 units.
pub struct Units<'a> {
    bytes: &'a [u8],
    /// the second half of the pair just read
    low: Option<u16>,
}

impl Iterator for Units<'_> {
    type Item = u16;

    fn next(&mut self) -> Option<u16> {
        if let Some(low) = self.low.take() {
            return Some(low);
        }
        let (&first, rest) = self.bytes.split_first()?;
        let (more, start) = match first {
            0..=0x7f => (0, u32::from(first)),
            0x80..=0xdf => (1, u32::from(first & 0x1f)),
            0xe0..=0xef => (2, u32::from(first & 0x0f)),
            _ => (3, u32::from(first & 0x07)),
        };
        let code = rest[..more].iter().fold(start, |code, byte| code << 6 | u32::from(byte & 0x3f));
        self.bytes = &rest[more..];
        let Some(above) = code.checked_sub(0x10000) else {
            return Some(code as u16);
        };
        self.low = Some(0xdc00 | (above & 0x3ff) as u16);
        Some(0xd800 | (above >> 10) as u16)
    }
}

/// A key that is an array index: JS lists these first, in numeric order, whenever they were added.
fn index_of(key: &Text) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) || (bytes[0] == b'0' && bytes.len() > 1) {
        return None;
    }
    let index = bytes.iter().fold(0u64, |index, digit| index * 10 + u64::from(digit - b'0'));
    u32::try_from(index).ok().filter(|&index| index != u32::MAX)
}

/// A JS object: each key once, in the order JS lists them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object(Vec<(Text, Value)>);

impl Object {
    /// What `Object.fromEntries` makes: a key given twice keeps its first place and its last value, and array indexes
    /// come first in numeric order.
    pub fn from_entries(mut entries: Vec<(Text, Value)>) -> Self {
        let mut order: Vec<usize> = (0..entries.len()).collect();
        order.sort_unstable_by(|&a, &b| entries[a].0.cmp(&entries[b].0).then(a.cmp(&b)));
        let same_keys: Vec<&[usize]> = order.chunk_by(|&a, &b| entries[a].0 == entries[b].0).filter(|same| same.len() > 1).collect();
        let mut repeats = Vec::new();
        for same in same_keys {
            let last = std::mem::replace(&mut entries[same[same.len() - 1]].1, Value::Null);
            entries[same[0]].1 = last;
            repeats.extend_from_slice(&same[1..]);
        }
        if !repeats.is_empty() {
            repeats.sort_unstable();
            let mut at = 0;
            entries.retain(|_| {
                at += 1;
                repeats.binary_search(&(at - 1)).is_err()
            });
        }
        if entries.iter().any(|(key, _)| index_of(key).is_some()) {
            let (mut indexes, others): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(key, _)| index_of(key).is_some());
            indexes.sort_by_key(|(key, _)| index_of(key));
            indexes.extend(others);
            entries = indexes;
        }
        Object(entries)
    }

    /// An object of `entries`, whose keys differ and are no array index, as an object literal's are.
    pub fn of<const N: usize>(entries: [(&str, Value); N]) -> Self {
        Object(entries.into_iter().map(|(key, value)| (key.into(), value)).collect())
    }

    /// `this[key] = value`, for a key known to be new and no array index.
    pub fn push(&mut self, key: &str, value: Value) {
        self.0.push((key.into(), value));
    }

    pub fn entries(&self) -> &[(Text, Value)] {
        &self.0
    }

    pub fn into_entries(self) -> Vec<(Text, Value)> {
        self.0
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(name, _)| name.is(key)).map(|(_, value)| value)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.0.iter_mut().find(|(name, _)| name.is(key)).map(|(_, value)| value)
    }

    /// `this[key] = value`, for a key that is no array index: a key it has stays where it is.
    pub fn set(&mut self, key: &str, value: Value) {
        match self.get_mut(key) {
            Some(held) => *held = value,
            None => self.0.push((key.into(), value)),
        }
    }

    /// `this[key] = value`, for an object whose order nothing reads.
    pub fn set_key(&mut self, key: &Text, value: Value) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some((_, held)) => *held = value,
            None => self.0.push((key.clone(), value)),
        }
    }

    /// `this[key] = value` of each of `from`, in order, for an object whose order nothing reads, as `set_key` would. A scan
    /// per key is what a few cost, but what a third party can send makes that the square of their count, so past
    /// `SCANS` they go by an index made once.
    pub fn assign(&mut self, from: Vec<(&Text, &Value)>) {
        if self.0.len().saturating_mul(from.len()) <= SCANS {
            from.into_iter().for_each(|(key, value)| self.set_key(key, value.clone()));
            return;
        }
        let mut at = HashMap::with_capacity(self.0.len() + from.len());
        for (place, (key, _)) in self.0.iter().enumerate() {
            at.entry(key.clone()).or_insert(place);
        }
        for (key, value) in from {
            match at.get(key) {
                Some(&place) => self.0[place].1 = value.clone(),
                None => {
                    at.insert(key.clone(), self.0.len());
                    self.0.push((key.clone(), value.clone()));
                }
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let at = self.0.iter().position(|(name, _)| name.is(key))?;
        Some(self.0.remove(at).1)
    }
}

/// How many key comparisons `Object::assign` leaves to scans: a tool call's update is a few keys on a few, every one.
const SCANS: usize = 1 << 10;

/// A JS value `JSON.parse` can make. `undefined` is the `None` of an `Option<Value>`.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(Text),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    /// `this.key` for a value that isn't null: nothing but an object has a key this reads.
    pub fn field(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(object) => object.get(key),
            _ => None,
        }
    }

    /// This array, if it is one.
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// This object, if it is one.
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn text(text: &str) -> Value {
        Value::String(text.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(n: f64) -> Value {
        Value::Number(n)
    }

    fn keys(object: &Object) -> Vec<String> {
        object.entries().iter().map(|(key, _)| key.lossy()).collect()
    }

    #[test]
    fn assigning_many_keys_is_assigning_each_however_many_there_are() {
        let key = |at: usize| Text::from(format!("k{at}").as_str());
        let of = |keys: &[usize], from: usize| {
            keys.iter().enumerate().map(|(at, id)| (key(*id), number((from + at) as f64))).collect::<Vec<_>>()
        };
        let pairs = |list: &[(Text, Value)]| list.iter().map(|(name, value)| (name.clone(), value.clone())).collect::<Vec<_>>();
        for (held, given) in [(3, 2), (200, 300)] {
            let old: Vec<usize> = (0..held).collect();
            // half on what it has, half new, and one key given twice: the last says, where the first put it
            let mut new: Vec<usize> = (held / 2..held + given).collect();
            new.push(held + 1);
            let (old, new) = (of(&old, 0), of(&new, 1000));
            let mut scanned = Object::from_entries(pairs(&old));
            new.iter().for_each(|(name, value)| scanned.set_key(name, value.clone()));
            let mut assigned = Object::from_entries(pairs(&old));
            assigned.assign(new.iter().map(|(name, value)| (name, value)).collect());
            assert_eq!(assigned, scanned);
        }
    }

    #[test]
    fn a_key_given_twice_keeps_its_first_place_and_last_value() {
        let entries = ["a", "b", "a", "c", "a", "b"].iter().enumerate().map(|(at, key)| (Text::from(*key), number(at as f64))).collect();
        let object = Object::from_entries(entries);
        assert_eq!(keys(&object), ["a", "b", "c"]);
        assert_eq!(object.get("a"), Some(&number(4.0)));
        assert_eq!(object.get("b"), Some(&number(5.0)));
        assert_eq!(object.get("c"), Some(&number(3.0)));
    }

    #[test]
    fn array_indexes_come_first_in_numeric_order() {
        let names = ["b", "10", "2", "01", "-1", "4294967294", "4294967295", "00", "1.5", "12345678901", "", "1a", "0"];
        let object = Object::from_entries(names.iter().map(|key| (Text::from(*key), Value::Null)).collect());
        let first = ["0", "2", "10", "4294967294", "b", "01", "-1", "4294967295", "00", "1.5", "12345678901", "", "1a"];
        assert_eq!(keys(&object), first);
    }

    #[test]
    fn a_set_keeps_a_keys_place_and_a_remove_takes_it() {
        let mut object = Object::default();
        object.set("a", number(1.0));
        object.set("b", number(2.0));
        object.set("a", number(3.0));
        assert_eq!(keys(&object), ["a", "b"]);
        assert_eq!(object.get("a"), Some(&number(3.0)));
        assert_eq!(object.remove("a"), Some(number(3.0)));
        assert_eq!(object.remove("a"), None);
        object.set_key(&"b".into(), number(5.0));
        object.set_key(&"c".into(), number(6.0));
        assert_eq!(keys(&object), ["b", "c"]);
        assert_eq!(object.get("b"), Some(&number(5.0)));
        *object.get_mut("c").expect("a key") = number(7.0);
        assert_eq!(object.get("c"), Some(&number(7.0)));
        assert_eq!(object.get_mut("d"), None);
        assert_eq!(object.into_entries().len(), 2);
    }

    #[test]
    fn a_literal_keeps_the_order_it_was_written_in() {
        let mut object = Object::of([("b", number(1.0)), ("a", number(2.0))]);
        object.push("c", number(3.0));
        assert_eq!(keys(&object), ["b", "a", "c"]);
    }

    #[test]
    fn only_an_object_has_fields() {
        let mut object = Object::default();
        object.set("k", Value::Bool(true));
        assert_eq!(Value::Object(object).field("k"), Some(&Value::Bool(true)));
        assert_eq!(Value::Array(vec![]).field("k"), None);
        assert_eq!(Value::Array(vec![]).as_object(), None);
        assert_eq!(Value::Array(vec![]).as_array(), Some(&[][..]));
        assert_eq!(Value::Null.as_array(), None);
        assert_eq!(Value::Object(Object::default()).as_object(), Some(&Object::default()));
        assert_eq!(Value::text("s").field("length"), None);
    }

    #[test]
    fn units_are_utf_16_and_a_pair_is_joined_however_it_arrives() {
        let text = Text::from("a\u{e9}\u{4e2d}\u{1f600}");
        assert_eq!(text.units().collect::<Vec<_>>(), "a\u{e9}\u{4e2d}\u{1f600}".encode_utf16().collect::<Vec<_>>());
        let mut built = Text::default();
        for unit in "\u{1f600}".encode_utf16() {
            built.push_unit(unit);
        }
        assert_eq!(built, Text::from("\u{1f600}"));
        let (lead, trail) = (Text::from(0xd83du16), Text::from(0xde00u16));
        assert_eq!(lead.units().collect::<Vec<_>>(), [0xd83d]);
        let mut joined = lead.clone();
        joined.push_text(&trail);
        assert_eq!(joined, Text::from("\u{1f600}"));
        let mut more = trail.clone();
        more.push_str("z");
        let mut together = lead.clone();
        together.push_text(&more);
        assert_eq!(together, Text::from("\u{1f600}z"));
        // nothing to join: a trail surrogate alone, a lead before something else, and an ordinary end
        let mut apart = trail.clone();
        apart.push_text(&trail);
        assert_eq!(apart.units().collect::<Vec<_>>(), [0xde00, 0xde00]);
        let mut plain = lead.clone();
        plain.push_text(&Text::from("z"));
        assert_eq!(plain.units().collect::<Vec<_>>(), [0xd83d, 0x7a]);
        let mut empty = Text::default();
        assert!(empty.is_empty());
        empty.push_text(&trail);
        assert!(!empty.is_empty());
        assert_eq!(empty, trail);
        let mut ended = Text::from("ab");
        ended.push_bytes(b"c");
        ended.push_unit(0xde00);
        assert_eq!(ended.units().collect::<Vec<_>>(), [0x61, 0x62, 0x63, 0xde00]);
    }

    #[test]
    fn lone_surrogates_read_as_the_replacement_character() {
        let mut text = Text::from("a");
        text.push_unit(0xd800);
        text.push_str("b");
        assert_eq!(text.lossy(), "a\u{fffd}b");
    }

    #[test]
    fn units_order_is_js_order_not_utf_8_order() {
        let (high, astral) = (Text::from("\u{ffff}"), Text::from("\u{10000}"));
        assert!(high.as_bytes() < astral.as_bytes());
        assert_eq!(high.compare_units(&astral), Ordering::Greater);
    }
}
