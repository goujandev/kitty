//! Turning a child's stdout into whole protocol frames.
//!
//! Both harnesses speak newline-delimited JSON, so a frame is a line. The
//! reasons this is not `BufReader::lines()` are in ARCHITECTURE.md §7, and all
//! three are defects observed in `MonoCode`:
//!
//! * **A decode error must not end the stream.** `MonoCode` reads with
//!   `let Ok(line) = line else { break };`, so one invalid UTF-8 byte kills the
//!   reader thread permanently and the session goes mute with nothing surfaced.
//!   Here, invalid UTF-8 is replaced lossily and reading continues.
//! * **A frame must have a length cap.** `lines()` will allocate without bound
//!   for a single enormous line, and a large file patch is exactly that.
//!   Over-long frames are dropped, reported, and the stream resynchronises at
//!   the next newline.
//! * **Batching belongs at the source.** One read usually yields many frames.
//!   Returning them together means one hop across the channel and, later, one
//!   IPC message, instead of one per line.

use std::io::Read;

/// Frames longer than this are dropped rather than buffered.
///
/// Generous enough for a large tool result, small enough that a runaway child
/// cannot exhaust memory.
pub const DEFAULT_MAX_FRAME: usize = 8 * 1024 * 1024;

/// How much to ask for per read. Large enough that a burst of deltas arrives
/// in one batch.
const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// One complete protocol line, lossily decoded.
    Line(String),
    /// A frame exceeded the cap and was discarded. Reported rather than
    /// swallowed, because losing a frame silently is how a session goes
    /// mysteriously wrong.
    Oversized { bytes: usize },
}

/// What one read produced.
#[derive(Debug)]
pub enum Batch {
    /// Zero or more frames. Empty means the read produced only a partial line.
    Frames(Vec<Frame>),
    /// The child closed its pipe. Any trailing unterminated bytes come with it.
    Eof { trailing: Option<Frame> },
    /// The pipe itself failed. Distinct from a decode problem.
    Failed { message: String },
}

pub struct FrameReader<R> {
    inner: R,
    /// Read buffer, owned once rather than built per call. 64 KiB is too big
    /// to keep putting on the stack.
    chunk: Box<[u8]>,
    pending: Vec<u8>,
    max_frame: usize,
    /// True while discarding the tail of an over-long frame.
    resyncing: bool,
    discarded: usize,
}

impl<R: Read> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self::with_max_frame(inner, DEFAULT_MAX_FRAME)
    }

    pub fn with_max_frame(inner: R, max_frame: usize) -> Self {
        Self {
            inner,
            chunk: vec![0u8; READ_CHUNK].into_boxed_slice(),
            pending: Vec::with_capacity(8 * 1024),
            max_frame,
            resyncing: false,
            discarded: 0,
        }
    }

    /// Blocks until the child writes something, then returns every complete
    /// frame in what arrived.
    pub fn next_batch(&mut self) -> Batch {
        // Swap the buffer out so `consume` can take `&mut self` without
        // copying what we just read. This is the hot path; a per-read
        // allocation here would be paid for on every delta.
        let mut buf = std::mem::take(&mut self.chunk);
        let outcome = self.inner.read(&mut buf);

        let batch = match outcome {
            Ok(0) => self.finish(),
            Ok(read) => {
                let mut frames = Vec::new();
                self.consume(&buf[..read], &mut frames);
                Batch::Frames(frames)
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => Batch::Frames(Vec::new()),
            Err(e) => Batch::Failed {
                message: e.to_string(),
            },
        };

        self.chunk = buf;
        batch
    }

    /// Splits `bytes` on newlines, emitting whole frames and keeping the tail.
    fn consume(&mut self, bytes: &[u8], out: &mut Vec<Frame>) {
        for &byte in bytes {
            if byte == b'\n' {
                if self.resyncing {
                    // The over-long frame ends here. Report and resynchronise.
                    out.push(Frame::Oversized {
                        bytes: self.discarded,
                    });
                    self.resyncing = false;
                    self.discarded = 0;
                } else if let Some(frame) = self.take_pending() {
                    out.push(frame);
                }
                continue;
            }

            if self.resyncing {
                self.discarded = self.discarded.saturating_add(1);
                continue;
            }

            self.pending.push(byte);
            if self.pending.len() > self.max_frame {
                // Drop what we have and skip to the next newline. Truncating
                // and handing over half a JSON object would be worse: the
                // codec would report a protocol error for a frame we broke.
                self.resyncing = true;
                self.discarded = self.pending.len();
                self.pending.clear();
            }
        }
    }

    /// Decodes the buffered bytes as one frame, trimming a trailing `\r`.
    fn take_pending(&mut self) -> Option<Frame> {
        if self.pending.last() == Some(&b'\r') {
            self.pending.pop();
        }
        if self.pending.is_empty() {
            // A blank line carries no protocol meaning for either harness.
            return None;
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        Some(Frame::Line(text))
    }

    fn finish(&mut self) -> Batch {
        if self.resyncing {
            let bytes = self.discarded;
            self.resyncing = false;
            self.discarded = 0;
            return Batch::Eof {
                trailing: Some(Frame::Oversized { bytes }),
            };
        }
        Batch::Eof {
            trailing: self.take_pending(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Batch, Frame, FrameReader};

    fn drain(input: &[u8], max: usize) -> (Vec<Frame>, Option<Frame>) {
        let mut reader = FrameReader::with_max_frame(input, max);
        let mut frames = Vec::new();
        loop {
            match reader.next_batch() {
                Batch::Frames(batch) => frames.extend(batch),
                Batch::Eof { trailing } => return (frames, trailing),
                Batch::Failed { message } => panic!("unexpected failure: {message}"),
            }
        }
    }

    fn lines(input: &[u8]) -> Vec<String> {
        let (frames, trailing) = drain(input, 1024);
        frames
            .into_iter()
            .chain(trailing)
            .filter_map(|f| match f {
                Frame::Line(text) => Some(text),
                Frame::Oversized { .. } => None,
            })
            .collect()
    }

    #[test]
    fn splits_on_newlines() {
        assert_eq!(lines(b"{\"a\":1}\n{\"b\":2}\n"), ["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn handles_crlf() {
        assert_eq!(lines(b"one\r\ntwo\r\n"), ["one", "two"]);
    }

    #[test]
    fn emits_a_trailing_unterminated_line_at_eof() {
        // A child that dies mid-write still gives us what it managed to say.
        assert_eq!(lines(b"one\ntwo"), ["one", "two"]);
    }

    #[test]
    fn skips_blank_lines() {
        assert_eq!(lines(b"one\n\n\ntwo\n"), ["one", "two"]);
    }

    #[test]
    fn invalid_utf8_does_not_end_the_stream() {
        // The exact failure mode in MonoCode: one bad byte and the session
        // goes silent. Here the frame is lossily decoded and reading continues.
        let input = b"before\n\xff\xfe bad\nafter\n";
        let got = lines(input);
        assert_eq!(got.len(), 3, "a bad byte must not stop the reader");
        assert_eq!(got[0], "before");
        assert!(got[1].contains("bad"));
        assert_eq!(got[2], "after");
    }

    #[test]
    fn an_oversized_frame_is_reported_not_buffered() {
        let mut input = Vec::new();
        input.extend_from_slice(b"small\n");
        input.extend(std::iter::repeat_n(b'x', 5_000));
        input.push(b'\n');
        input.extend_from_slice(b"after\n");

        let (frames, _) = drain(&input, 1024);
        assert_eq!(frames[0], Frame::Line("small".into()));
        assert!(
            matches!(frames[1], Frame::Oversized { bytes } if bytes >= 5_000),
            "expected an Oversized report, got {:?}",
            frames[1]
        );
        assert_eq!(
            frames[2],
            Frame::Line("after".into()),
            "the stream must resynchronise at the next newline"
        );
    }

    #[test]
    fn an_oversized_frame_at_eof_is_still_reported() {
        let mut input = Vec::new();
        input.extend(std::iter::repeat_n(b'x', 5_000));
        let (frames, trailing) = drain(&input, 1024);
        assert!(frames.is_empty());
        assert!(matches!(trailing, Some(Frame::Oversized { .. })));
    }

    #[test]
    fn frames_split_across_reads_are_reassembled() {
        // Simulates a pipe handing over one byte at a time.
        struct Dribble(std::vec::IntoIter<u8>);
        impl std::io::Read for Dribble {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                match self.0.next() {
                    Some(b) => {
                        buf[0] = b;
                        Ok(1)
                    }
                    None => Ok(0),
                }
            }
        }

        let mut reader = FrameReader::with_max_frame(
            Dribble(b"{\"hello\":\"world\"}\nsecond\n".to_vec().into_iter()),
            1024,
        );
        let mut got = Vec::new();
        loop {
            match reader.next_batch() {
                Batch::Frames(batch) => got.extend(batch),
                Batch::Eof { trailing } => {
                    got.extend(trailing);
                    break;
                }
                Batch::Failed { message } => panic!("{message}"),
            }
        }
        assert_eq!(
            got,
            vec![
                Frame::Line("{\"hello\":\"world\"}".into()),
                Frame::Line("second".into())
            ]
        );
    }

    #[test]
    fn one_read_yields_many_frames_in_one_batch() {
        // Batching at the source is the point: a burst of deltas should cross
        // the channel once, not once per line.
        let input = b"a\nb\nc\nd\ne\n";
        let mut reader = FrameReader::with_max_frame(&input[..], 1024);
        match reader.next_batch() {
            Batch::Frames(batch) => assert_eq!(batch.len(), 5),
            other => panic!("expected one batch of five, got {other:?}"),
        }
    }

    #[test]
    fn a_read_with_no_complete_line_yields_an_empty_batch() {
        let mut reader = FrameReader::with_max_frame(&b"partial"[..], 1024);
        assert!(matches!(reader.next_batch(), Batch::Frames(f) if f.is_empty()));
    }

    #[test]
    fn unicode_survives_intact() {
        assert_eq!(lines("héllo → 👋\n".as_bytes()), ["héllo → 👋"]);
    }
}
