//! File-backed log sink with a fixed on-disk budget.
//!
//! `tracing` events are also written to `<data_dir>/noobdb.log` so the Settings
//! screen can show them — a packaged desktop build has no terminal to read
//! stdout from. The sink keeps two rotating segments: when the active file
//! reaches half the budget it is renamed to `noobdb.log.1` (replacing the
//! previous backup) and a fresh active file is started. The combined on-disk
//! size therefore stays around `MAX_TOTAL_BYTES` (~1 MiB) without unbounded
//! growth, while the most recent logs are always retained.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tracing_subscriber::fmt::MakeWriter;

use crate::profiles::store::data_dir;

/// Combined on-disk budget across both segments (~1 MiB).
const MAX_TOTAL_BYTES: u64 = 1024 * 1024;
/// Per-segment cap. With two segments (active + one backup) the total on disk
/// stays within [`MAX_TOTAL_BYTES`] (plus at most one trailing event each).
const SEGMENT_CAP: u64 = MAX_TOTAL_BYTES / 2;

const CURRENT_NAME: &str = "noobdb.log";
const PREV_NAME: &str = "noobdb.log.1";

static STORE: OnceLock<LogStore> = OnceLock::new();

struct LogStore {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    file: File,
    size: u64,
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

impl LogStore {
    fn open(dir: PathBuf) -> io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let file = open_append(&dir.join(CURRENT_NAME))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(LogStore {
            dir,
            inner: Mutex::new(Inner { file, size }),
        })
    }

    fn current_path(&self) -> PathBuf {
        self.dir.join(CURRENT_NAME)
    }

    fn prev_path(&self) -> PathBuf {
        self.dir.join(PREV_NAME)
    }

    fn write_bytes(&self, buf: &[u8]) -> io::Result<usize> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.file.write_all(buf)?;
        inner.size += buf.len() as u64;
        if inner.size >= SEGMENT_CAP {
            // Rotate: the active file becomes the single retained backup, then a
            // fresh active file is started. A failure here is non-fatal — we keep
            // appending to the (now oversized) active file rather than dropping
            // the writer entirely.
            if std::fs::rename(self.current_path(), self.prev_path()).is_ok() {
                if let Ok(file) = open_append(&self.current_path()) {
                    inner.file = file;
                    inner.size = 0;
                }
            }
        }
        Ok(buf.len())
    }

    fn read(&self) -> String {
        let _guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = String::new();
        if let Ok(prev) = std::fs::read_to_string(self.prev_path()) {
            out.push_str(&prev);
        }
        if let Ok(cur) = std::fs::read_to_string(self.current_path()) {
            out.push_str(&cur);
        }
        out
    }

    fn clear(&self) -> io::Result<()> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // アクティブファイルを空にする。新しいハンドルを開いて**成功したときだけ**
        // 既存の `inner.file` を差し替えるので、途中で失敗しても既存ハンドルは
        // 有効なまま残る (#H7: remove → 再オープンの順だと、再オープン失敗時に
        // `inner.file` が「削除済みで以後パスから見えないファイル」を指したままに
        // なり、以後の write は成功に見えても実体は次回起動までどこからも読めない
        // = 黙ってログが消える)。
        //
        // in-place の `set_len(0)` は使わない: Windows の SetEndOfFile は
        // write-data 権限を要求し、`open_append` の append 専用ハンドルでは
        // `Access Denied` になる (Unix の ftruncate は append fd でも成功するため
        // OS 差が出る)。代わりに `truncate(true)` で開き直す — 既存ファイルを
        // O_TRUNC で空にするだけなのでパスも inode も変わらず、全 OS で動く。
        let fresh = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(self.current_path())?;
        inner.file = fresh;
        inner.size = 0;
        // バックアップセグメントはアクティブハンドルに影響しないので、削除に
        // 失敗してもベストエフォートで無視してよい。
        let _ = std::fs::remove_file(self.prev_path());
        Ok(())
    }
}

/// Zero-sized handle that forwards writes to the global [`LogStore`]. `Copy` so
/// it satisfies `MakeWriter`, which hands out a fresh writer per event.
#[derive(Clone, Copy)]
pub struct LogWriter;

impl Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match STORE.get() {
            Some(store) => store.write_bytes(buf),
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogWriter {
    type Writer = LogWriter;
    fn make_writer(&'a self) -> Self::Writer {
        *self
    }
}

/// Opens the log file under the data dir and installs the global sink, returning
/// the writer to attach to `tracing`. Returns `None` when there is no data dir
/// or the file cannot be opened; logging then falls back to stdout only.
pub fn init() -> Option<LogWriter> {
    let store = LogStore::open(data_dir()?).ok()?;
    STORE.set(store).ok()?;
    Some(LogWriter)
}

/// Current log contents (backup segment followed by the active one), oldest
/// first. Empty when the sink was never installed.
pub fn read() -> String {
    STORE.get().map(LogStore::read).unwrap_or_default()
}

/// Removes both segments and starts a fresh active file. No-op when the sink was
/// never installed.
pub fn clear() -> io::Result<()> {
    match STORE.get() {
        Some(store) => store.clear(),
        None => Ok(()),
    }
}

/// Absolute path of the active log file, for display in the UI.
pub fn path() -> Option<String> {
    STORE
        .get()
        .map(|s| s.current_path().to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("noobdb_logtest_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn writes_and_reads_back_in_order() {
        let dir = scratch_dir("rw");
        let store = LogStore::open(dir.clone()).unwrap();
        store.write_bytes(b"first\n").unwrap();
        store.write_bytes(b"second\n").unwrap();
        assert_eq!(store.read(), "first\nsecond\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_bounds_total_size_and_keeps_recent() {
        let dir = scratch_dir("rotate");
        let store = LogStore::open(dir.clone()).unwrap();

        // ~4 KiB entries, written well past the budget to force several rotations.
        let pad = "x".repeat(4080);
        let make = |i: u64| format!("{i:012} {pad}\n");
        let entry_len = make(0).len() as u64;
        let iterations = (MAX_TOTAL_BYTES / entry_len) * 3 + 5;
        for i in 0..iterations {
            store.write_bytes(make(i).as_bytes()).unwrap();
        }

        let on_disk = |p: PathBuf| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let total = on_disk(store.current_path()) + on_disk(store.prev_path());
        // Each segment can overshoot its cap by at most one entry before it
        // rotates, so the combined size stays within the budget plus that slop.
        assert!(
            total <= MAX_TOTAL_BYTES + 2 * entry_len,
            "total {total} exceeds budget"
        );

        // The most recently written entry must survive rotation.
        let content = store.read();
        let last = format!("{:012}", iterations - 1);
        assert!(content.contains(&last), "recent entry was lost");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_empties_both_segments() {
        let dir = scratch_dir("clear");
        let store = LogStore::open(dir.clone()).unwrap();
        store.write_bytes(b"before\n").unwrap();
        store.clear().unwrap();
        assert_eq!(store.read(), "");
        // Writing still works after a clear.
        store.write_bytes(b"after\n").unwrap();
        assert_eq!(store.read(), "after\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // H7: clear() はアクティブファイルを remove+再作成ではなく、同じパスを
    // O_TRUNC で開き直して空にするので、ファイルは再作成されず inode が保たれる。
    // Unix では inode 番号が変わらないことで検証できる。
    #[cfg(unix)]
    #[test]
    fn clear_truncates_active_file_preserving_inode() {
        use std::os::unix::fs::MetadataExt;

        let dir = scratch_dir("clear_inplace");
        let store = LogStore::open(dir.clone()).unwrap();
        store.write_bytes(b"before\n").unwrap();
        let ino_before = std::fs::metadata(store.current_path()).unwrap().ino();

        store.clear().unwrap();

        // The active log file still exists at the same path with the same
        // inode (truncated in place), not recreated from scratch.
        let meta_after = std::fs::metadata(store.current_path()).unwrap();
        assert_eq!(meta_after.ino(), ino_before, "active file was recreated");
        assert_eq!(meta_after.len(), 0);

        store.write_bytes(b"after\n").unwrap();
        assert_eq!(store.read(), "after\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
