//! JSON ストア用のプロセス間排他ロック (#1546)。
//!
//! ストア単位のプロセス内 `Mutex` だけでは、noobDB を 2 つ同時に起動したとき
//! 「`load_all` → 変更 → `save_all`」が別プロセスと交錯して後勝ちの lost update になる。
//! そこで `Mutex` に加えて、ストアの隣に置いた専用ロックファイル (`<ストア>.lock`) へ OS の
//! 排他ファイルロック (`std::fs::File::lock`: Unix は `flock`、Windows は `LockFileEx`) を
//! 取り、read-modify-write 全体の間保持する。
//!
//! - ロックはデータ本体ではなく**別ファイル**にかける。本体は `write_atomic` が rename で
//!   差し替えるため、本体のハンドルにロックしても差し替え後の別 inode には効かない。
//! - ロックファイルは削除しない (消すと別プロセスが新旧 2 つの inode を握って排他が崩れる)。
//! - ガードを drop するとハンドルが閉じ、OS がロックを解放する。プロセスが異常終了しても
//!   OS が解放するので、ロックが残り続けることはない。
//! - 取得失敗 (権限・ディスクなど) は `AppError::Io` (kind `io`) で返す。ロックなしで続行すると
//!   データを壊しうるので、黙って素通りさせない。

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::error::Result;

/// プロセス内 `Mutex` とプロセス間ファイルロックの両方を保持するガード。
/// フィールドは drop で解放されることだけが目的なので読まない。
#[allow(dead_code)]
pub struct StoreGuard<'a> {
    // 宣言順 = drop 順。ファイルロック (別プロセス向け) を先に離し、その後 Mutex を離す。
    file: File,
    mutex: MutexGuard<'a, ()>,
}

/// ストアのデータファイルに対応するロックファイルのパス (`profiles.json` → `profiles.json.lock`)。
fn lock_path(data_file: &Path) -> PathBuf {
    let mut s = data_file.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

/// `mutex` (プロセス内) と `data_file` 隣のロックファイル (プロセス間) を順に取得する。
/// poisoning は無視して続行する: 本体は `write_atomic` のおかげで常に一貫した状態のまま。
pub fn acquire<'a>(mutex: &'a Mutex<()>, data_file: &Path) -> Result<StoreGuard<'a>> {
    let guard = mutex.lock().unwrap_or_else(PoisonError::into_inner);
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path(data_file))?;
    // `File::lock` は Rust 1.89 で安定化。Cargo.toml の `rust-version` (1.77) は名目値で、
    // CI は常に stable を使い、依存 (tauri-utils は edition 2024) も既に 1.85 以上を要求する。
    // rust-version を上げると他箇所の clippy (`unnecessary_map_or` など) が一斉に出るため、
    // ここだけ許可して新規依存 (fs4 など) を避ける。
    #[allow(clippy::incompatible_msrv)]
    file.lock()?;
    Ok(StoreGuard { file, mutex: guard })
}

#[cfg(test)]
#[allow(clippy::incompatible_msrv)] // 本体側の allow と同じ理由 (File::try_lock)
mod tests {
    use super::*;
    use std::sync::Arc;

    static LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noobdb-store-lock-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap_or_default();
        dir
    }

    /// 別ハンドル (= 別プロセス相当。プロセス内 Mutex は通さない) からは排他になる。
    #[test]
    fn file_lock_excludes_other_handle() {
        let dir = temp_dir("excl");
        let data = dir.join("x.json");
        let guard = acquire(&LOCK, &data).expect("lock");
        let other = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path(&data))
            .expect("open");
        assert!(
            other.try_lock().is_err(),
            "ロック保持中は別ハンドルで取れない"
        );
        drop(guard);
        let free = other.try_lock().is_ok();
        assert!(free, "解放後は取れる");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Mutex を共有せず (= 別プロセス相当) ファイルロックだけで read-modify-write を
    /// 直列化できる。ロックが効かなければ lost update で最終値が THREADS*ITERS を下回る。
    #[test]
    fn concurrent_read_modify_write_has_no_lost_update() {
        const THREADS: usize = 8;
        const ITERS: usize = 25;
        let dir = temp_dir("rmw");
        let data = Arc::new(dir.join("counter.json"));
        std::fs::write(data.as_path(), "0").expect("init");

        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let data = Arc::clone(&data);
                std::thread::spawn(move || {
                    for _ in 0..ITERS {
                        // スレッドごとに専用の Mutex を使い、プロセス内排他を無効化する。
                        let local: &'static Mutex<()> = Box::leak(Box::new(Mutex::new(())));
                        let _g = acquire(local, &data).expect("lock");
                        let n: usize = std::fs::read_to_string(data.as_path())
                            .expect("read")
                            .trim()
                            .parse()
                            .expect("parse");
                        std::thread::yield_now();
                        crate::atomic_write::write_atomic(&data, (n + 1).to_string().as_bytes())
                            .expect("write");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("join");
        }
        let total: usize = std::fs::read_to_string(data.as_path())
            .expect("read")
            .trim()
            .parse()
            .expect("parse");
        assert_eq!(total, THREADS * ITERS);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
