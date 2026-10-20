//! NDJSON line reading with a size cap (ADR-0003, decision 7). An oversized line is dropped
//! while it streams in, so it never sits in memory.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// A complete line is in the buffer, without its `\n` or `\r\n`.
    Complete,
    /// A line longer than the cap was skipped.
    Oversize,
    Eof,
}

/// Reads the next line into `buf`. A final line without a newline counts as complete.
pub async fn read_line_capped<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> io::Result<Line> {
    buf.clear();
    let mut oversize = false;
    loop {
        let (consumed, done) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(match (oversize, buf.is_empty()) {
                    (true, _) => Line::Oversize,
                    (false, true) => Line::Eof,
                    (false, false) => Line::Complete,
                });
            }
            let newline = available.iter().position(|&b| b == b'\n');
            let chunk = &available[..newline.unwrap_or(available.len())];
            if !oversize {
                if buf.len() + chunk.len() > max {
                    oversize = true;
                    buf.clear();
                } else {
                    buf.extend_from_slice(chunk);
                }
            }
            match newline {
                Some(index) => (index + 1, true),
                None => (available.len(), false),
            }
        };
        reader.consume(consumed);
        if done {
            if oversize {
                return Ok(Line::Oversize);
            }
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Line::Complete);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    async fn read_all(input: &[u8], max: usize, capacity: usize) -> Vec<(Line, String)> {
        let mut reader = BufReader::with_capacity(capacity, input);
        let mut buf = Vec::new();
        let mut out = Vec::new();
        loop {
            let line = read_line_capped(&mut reader, &mut buf, max).await.unwrap();
            if line == Line::Eof {
                return out;
            }
            out.push((line, String::from_utf8(buf.clone()).unwrap()));
        }
    }

    #[tokio::test]
    async fn splits_lines_across_small_buffers() {
        let lines = read_all(b"{\"a\":1}\r\n{\"b\":2}\nlast", 1024, 3).await;
        assert_eq!(
            lines,
            vec![
                (Line::Complete, "{\"a\":1}".into()),
                (Line::Complete, "{\"b\":2}".into()),
                (Line::Complete, "last".into()),
            ]
        );
    }

    #[tokio::test]
    async fn drops_an_oversized_line_and_recovers() {
        let lines = read_all(b"0123456789abc\nok\n", 8, 4).await;
        assert_eq!(
            lines,
            vec![
                (Line::Oversize, String::new()),
                (Line::Complete, "ok".into())
            ]
        );
    }
}
