//! What the crate's tests share: a writer they read back, a stream that breaks, and the socket's answer to hello.

use crate::bridge::lock;
use serde_json::Value;
use std::io::{self, Cursor, Read, Write};
use std::sync::{Arc, Mutex};

pub(crate) const ACCEPTED: &str = "{\"jsonrpc\":\"2.0\",\"id\":\"hello\",\"result\":{\"serverName\":\"mopilot_7\"}}\n";

/// A writer the test reads back: what went to the harness, or to the socket.
#[derive(Clone, Default)]
pub(crate) struct Buf(Arc<Mutex<Vec<u8>>>);

impl Write for Buf {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        lock(&self.0).extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Buf {
    pub(crate) fn text(&self) -> String {
        String::from_utf8(lock(&self.0).clone()).expect("utf-8")
    }
    pub(crate) fn values(&self) -> Vec<Value> {
        self.text().lines().map(|l| serde_json::from_str(l).expect("a JSON line")).collect()
    }
}

/// A stream that fails every read and every flush, and every write unless `writes`: a harness that went away, a socket
/// that broke.
#[derive(Default)]
pub(crate) struct Broken {
    pub(crate) writes: bool,
}

impl Write for Broken {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        if self.writes {
            Ok(b.len())
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken"))
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken"))
    }
}

impl Read for Broken {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::ConnectionReset, "reset"))
    }
}

/// A connection that says `said`, then breaks: main destroying a socket with bytes unread (a reset on Windows).
pub(crate) struct ThenBroken(pub(crate) Cursor<&'static str>);

impl Read for ThenBroken {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        match self.0.read(b)? {
            0 => Broken::default().read(b),
            n => Ok(n),
        }
    }
}
