//! A JS `Map`, as far as a translator uses one: entries stay in the order they were first set, a set of a key it has keeps
//! that key's place, and a delete forgets it.

use jsvalue::value::Text;
use std::collections::HashMap;

pub struct Ordered<V> {
    slots: Vec<Option<(Text, V)>>,
    places: HashMap<Text, usize>,
}

impl<V> Default for Ordered<V> {
    fn default() -> Self {
        Ordered { slots: Vec::new(), places: HashMap::new() }
    }
}

impl<V> Ordered<V> {
    pub fn get(&self, key: &Text) -> Option<&V> {
        self.slots[*self.places.get(key)?].as_ref().map(|(_, value)| value)
    }

    pub fn set(&mut self, key: Text, value: V) {
        match self.places.get(&key) {
            Some(&place) => self.slots[place] = Some((key, value)),
            None => {
                self.places.insert(key.clone(), self.slots.len());
                self.slots.push(Some((key, value)));
            }
        }
    }

    pub fn delete(&mut self, key: &Text) {
        if let Some(place) = self.places.remove(key) {
            self.slots[place] = None;
        }
        if self.places.is_empty() {
            self.slots.clear();
        }
    }

    pub fn clear(&mut self) {
        self.slots.clear();
        self.places.clear();
    }

    /// Each key and value, oldest first.
    pub fn entries(&self) -> impl Iterator<Item = &(Text, V)> {
        self.slots.iter().flatten()
    }

    pub fn contains(&self, key: &Text) -> bool {
        self.places.contains_key(key)
    }

    pub fn get_mut(&mut self, key: &Text) -> Option<&mut V> {
        let place = *self.places.get(key)?;
        self.slots[place].as_mut().map(|(_, value)| value)
    }

    /// The values, oldest first.
    pub fn values(&self) -> impl DoubleEndedIterator<Item = &V> {
        self.slots.iter().flatten().map(|(_, value)| value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(map: &Ordered<u8>) -> Vec<u8> {
        map.values().copied().collect()
    }

    #[test]
    fn a_key_keeps_its_place_until_it_is_deleted() {
        let (a, b, c) = (Text::from("a"), Text::from("b"), Text::from("c"));
        let mut map = Ordered::default();
        map.set(a.clone(), 1);
        map.set(b.clone(), 2);
        map.set(c.clone(), 3);
        map.set(a.clone(), 4);
        assert_eq!(values(&map), [4, 2, 3]);
        assert_eq!(map.get(&b), Some(&2));
        map.delete(&b);
        assert_eq!(map.get(&b), None);
        map.delete(&b);
        map.set(b.clone(), 5);
        assert_eq!(values(&map), [4, 3, 5]);
        assert_eq!(map.values().next_back(), Some(&5));
    }

    #[test]
    fn it_empties_whole() {
        let mut map: Ordered<u8> = Ordered::default();
        map.set("a".into(), 1);
        map.delete(&"a".into());
        assert!(map.slots.is_empty());
        map.set("b".into(), 2);
        map.clear();
        assert!(values(&map).is_empty());
    }
}
