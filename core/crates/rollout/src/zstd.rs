//! A compressed rollout's first zstd frame as a stream, read as Node's `zlib.createZstdDecompress` reads a file: what
//! follows the frame is not read, a frame cut short ends where the file does, and anything else wrong fails. ruzstd is a
//! plain decoder under that: it checks no checksum, content size or reserved bit, reads nothing into a file too short to
//! have a magic number, and holds a window's worth of output back from a frame that never finishes.

use ruzstd::decoding::errors::{FrameDecoderError, ReadFrameHeaderError};
use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};
use std::io::{self, Read};

/// The largest window Node's decoder takes (`ZSTD_d_windowLogMax`'s default), past which a frame fails.
const MAX_WINDOW: u64 = 1 << 27;

const MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
/// A skippable frame's magic number; the first byte's low four bits are free.
const SKIPPABLE: [u8; 4] = [0x50, 0x2a, 0x4d, 0x18];

/// In a frame descriptor: what must be zero, and what says a frame has a content size.
const RESERVED: u8 = 0x08;
const SINGLE_SEGMENT: u8 = 0x20;
const SIZE_FLAG: u8 = 0xc0;

/// An empty last block and a checksum nobody reads: what finishes a frame that was cut short, and so lets go of what it
/// decoded.
const FINISH: [u8; 7] = [1, 0, 0, 0, 0, 0, 0];

/// The file, noting when something wanted more of it than it has.
struct Source {
    file: Box<dyn Read>,
    ended: bool,
}

impl Read for Source {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.file.read(buffer)?;
        self.ended |= read == 0 && !buffer.is_empty();
        Ok(read)
    }
}

/// A file's first frame, as bytes.
pub struct Frame {
    source: Source,
    decoder: Option<FrameDecoder>,
    /// the frame was cut short, so it has no checksum to hold it to, and only an upper bound on its size
    cut: bool,
    /// the size its header gives, and how much has come out
    size: Option<u64>,
    written: u64,
}

/// Whether a file could start with these bytes, of which there may be too few to tell: libzstd looks at what it has.
fn may_start_a_frame(head: &[u8]) -> bool {
    let skippable = |(at, (byte, want)): (usize, (&u8, &u8))| *want == if at == 0 { byte & 0xf0 } else { *byte };
    head.iter().zip(&MAGIC).all(|(byte, want)| byte == want) || head.iter().zip(&SKIPPABLE).enumerate().all(skippable)
}

fn failed(error: FrameDecoderError) -> io::Error {
    io::Error::other(error.to_string())
}

impl Frame {
    /// The frame `file` starts with. Nothing to read at all is an empty stream, as a file cut within the header is, and
    /// as one that starts with a skippable frame is: Node's decoder stops at the end of the first frame of any kind.
    pub fn new(file: impl Read + 'static) -> io::Result<Self> {
        let mut source = Source { file: Box::new(file), ended: false };
        let mut head = [0; 5];
        let mut got = 0;
        loop {
            let read = source.read(&mut head[got..])?;
            got += read;
            if read == 0 || got == head.len() {
                break;
            }
        }
        if !may_start_a_frame(&head[..got]) {
            return Err(io::Error::other("a compressed rollout is not zstd"));
        }
        let mut decoder = FrameDecoder::new();
        decoder.set_max_window_size(MAX_WINDOW);
        let started = match decoder.init(head[..got].chain(&mut source)) {
            Ok(()) if head[4] & RESERVED != 0 => return Err(io::Error::other("a compressed rollout's frame has a reserved bit set")),
            Ok(()) => true,
            Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame { .. })) => false,
            Err(_) if source.ended => false,
            Err(error) => return Err(failed(error)),
        };
        let sized = started && head[4] & (SIZE_FLAG | SINGLE_SEGMENT) != 0;
        let size = sized.then(|| decoder.content_size());
        Ok(Frame { source, decoder: started.then_some(decoder), cut: false, size, written: 0 })
    }

    /// The next block into the decoder. A block the file ends inside of never reaches it, so nothing it has is touched.
    fn decode(&mut self, decoder: &mut FrameDecoder) -> io::Result<()> {
        match decoder.decode_blocks(&mut self.source, BlockDecodingStrategy::UptoBlocks(1)) {
            Ok(_) => Ok(()),
            Err(error) if !self.source.ended => Err(failed(error)),
            // an end to this block with its checksum cut off takes this too: it doesn't count as finished until it has one
            Err(_) => {
                self.cut = true;
                decoder.decode_blocks(&FINISH[..], BlockDecodingStrategy::UptoBlocks(1)).map(drop).map_err(failed)
            }
        }
    }

    /// Whether the whole frame came out as its header and checksum say.
    fn verified(&self, decoder: &FrameDecoder) -> bool {
        if self.cut {
            return self.size.is_none_or(|size| self.written <= size);
        }
        self.size.is_none_or(|size| self.written == size)
            && decoder.get_checksum_from_data().is_none_or(|sum| Some(sum) == decoder.get_calculated_checksum())
    }
}

impl Read for Frame {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let Some(mut decoder) = self.decoder.take() else {
            return Ok(0);
        };
        loop {
            let read = decoder.read(buffer)?;
            if read > 0 {
                self.written += read as u64;
                self.decoder = Some(decoder);
                return Ok(read);
            }
            if decoder.is_finished() {
                return if self.verified(&decoder) {
                    Ok(0)
                } else {
                    Err(io::Error::other("a compressed rollout does not match its size or checksum"))
                };
            }
            self.decode(&mut decoder)?;
        }
    }
}
