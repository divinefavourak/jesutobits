//! A JSON-lines file that rotates by size (NFR-014): `host.jsonl` is the newest, then
//! `host.1.jsonl` up to `host.<keep-1>.jsonl`. A line is never split across files.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct RotatingFile {
    dir: PathBuf,
    stem: String,
    max_bytes: u64,
    /// Total files kept, including the current one.
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    pub fn open(dir: &Path, stem: &str, max_bytes: u64, keep: usize) -> io::Result<Self> {
        assert!(keep >= 1, "keep at least the current file");
        let mut this = Self {
            dir: dir.to_owned(),
            stem: stem.to_owned(),
            max_bytes,
            keep,
            file: None,
            size: 0,
        };
        this.reopen()?;
        Ok(this)
    }

    /// Path of the current file (`index` 0) or of an older rotation.
    pub fn path(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.dir.join(format!("{}.jsonl", self.stem))
        } else {
            self.dir.join(format!("{}.{index}.jsonl", self.stem))
        }
    }

    /// Appends one line; `line` must not contain a newline.
    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        let len = line.len() as u64 + 1;
        if self.size > 0 && self.size + len > self.max_bytes {
            // A failed rotation (for example a file held open without delete sharing on
            // Windows) must not lose the line: keep appending and retry next time.
            if let Err(error) = self.rotate() {
                eprintln!("[host] could not rotate {}: {error}", self.stem);
                if self.file.is_none() {
                    self.reopen()?;
                }
            }
        }
        let file = match self.file.as_mut() {
            Some(file) => file,
            None => {
                self.reopen()?;
                self.file.as_mut().expect("reopened")
            }
        };
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        // One write per line, so a crash leaves at most one partial line.
        file.write_all(&bytes)?;
        self.size += len;
        Ok(())
    }

    fn reopen(&mut self) -> io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path(0))?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        // Windows cannot rename a file this process still has open.
        self.file = None;
        let oldest = self.path(self.keep - 1);
        if oldest.exists() {
            fs::remove_file(&oldest)?;
        }
        for index in (0..self.keep - 1).rev() {
            let from = self.path(index);
            if from.exists() {
                fs::rename(&from, self.path(index + 1))?;
            }
        }
        self.reopen()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("jesutobits-log-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn rotates_by_size_and_keeps_a_fixed_number_of_files() {
        let dir = temp_dir("rotate");
        // Each line is 10 bytes with its newline; 3 lines fit in 30 bytes.
        let mut log = RotatingFile::open(&dir, "host", 30, 3).unwrap();
        for n in 0..10 {
            log.write_line(&format!("line-{n:04}")).unwrap();
        }
        assert_eq!(lines(&log.path(0)), ["line-0009"]);
        assert_eq!(lines(&log.path(1)), ["line-0006", "line-0007", "line-0008"]);
        assert_eq!(lines(&log.path(2)), ["line-0003", "line-0004", "line-0005"]);
        assert!(!log.path(3).exists(), "only 3 files are kept");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_line_longer_than_the_limit_gets_a_file_of_its_own() {
        let dir = temp_dir("long");
        let mut log = RotatingFile::open(&dir, "host", 8, 3).unwrap();
        log.write_line("short").unwrap();
        log.write_line("much longer than eight bytes").unwrap();
        log.write_line("next").unwrap();
        assert_eq!(lines(&log.path(2)), ["short"]);
        assert_eq!(lines(&log.path(1)), ["much longer than eight bytes"]);
        assert_eq!(lines(&log.path(0)), ["next"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn continues_an_existing_file_across_restarts() {
        let dir = temp_dir("reopen");
        RotatingFile::open(&dir, "host", 1000, 3)
            .unwrap()
            .write_line("first run")
            .unwrap();
        let mut log = RotatingFile::open(&dir, "host", 1000, 3).unwrap();
        log.write_line("second run").unwrap();
        assert_eq!(lines(&log.path(0)), ["first run", "second run"]);
        fs::remove_dir_all(dir).unwrap();
    }
}
