//! Scoped replacement of provider files after a successful rewrite.
#[cfg(unix)]
mod unix;
#[cfg(target_os = "macos")]
pub use unix::directory_with_search;
#[cfg(unix)]
pub use unix::{DIR_FLAGS, directory, open_file, replace};

#[cfg(windows)]
pub use crate::filesystem::{DirectoryLock, directory, open_file, replace};

use std::{
    fs::File,
    io::{self, BufRead, BufReader, Write},
};

pub fn filter_jsonl(
    input: &File,
    output: &mut dyn Write,
    matches: impl Fn(&[u8]) -> bool,
) -> io::Result<usize> {
    let mut reader = BufReader::new(input);
    let mut line = Vec::new();
    let mut count = 0;
    while reader.read_until(b'\n', &mut line)? != 0 {
        if matches(&line) {
            count += 1;
        } else {
            output.write_all(&line)?;
        }
        line.clear();
    }
    Ok(count)
}
