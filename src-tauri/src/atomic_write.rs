//! ユーザが選んだパスへ書き出すファイル (SQL 保存・バイナリ保存・プロファイルの書き出し)
//! 用の「一時ファイル → `rename`」置換 (#1593)。
//!
//! 保存先を直接開いて書くと、ディスクフルなどで途中失敗したときに既存ファイルが
//! 切り詰められた状態で残る。同じディレクトリの一時ファイルへ書き切って `sync_all`
//! してから `rename` するので、失敗時は既存ファイルが無傷のまま残る。
//! 既存ファイルがあればそのパーミッションを引き継ぎ、シンボリックリンクはリンク先を
//! 書き換える (リンクそのものを通常ファイルで置き換えない)。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    // シンボリックリンクなら実体を対象にする (無ければ指定パスのまま新規作成)。
    let target: PathBuf = std::fs::canonicalize(path).unwrap_or_else(|_| {
        // リンク先が存在しない symlink は canonicalize できない。リンク自体を置き換えず、
        // `read_link` で解決したリンク先へ新規作成する。
        match std::fs::read_link(path) {
            Ok(link) if link.is_absolute() => link,
            Ok(link) => path.parent().unwrap_or_else(|| Path::new(".")).join(link),
            Err(_) => path.to_path_buf(),
        }
    });
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}.{}",
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "noobdb-export".to_string()),
        std::process::id(),
        seq
    ));
    // `create_new` (`O_EXCL`) で排他予約する。`open` 自体の失敗時は他者のファイルかも
    // しれないので消さない。
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    let written = f.write_all(content).and_then(|()| f.sync_all()).map(|()| {
        // 既存ファイルのパーミッションを引き継ぐ (失敗しても保存自体は続ける)。
        if let Ok(meta) = std::fs::metadata(&target) {
            // 読み取り専用のパーミッションは引き継がない (Windows では一時ファイルの
            // rename / 後始末が拒否され、残骸が残りうる)。
            if meta.is_file() && !meta.permissions().readonly() {
                let _ = f.set_permissions(meta.permissions());
            }
        }
    });
    // Windows は開いたままのファイルを rename できないため、先に閉じる。
    drop(f);
    let written = written.and_then(|()| std::fs::rename(&tmp_path, &target));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("noobdb_atomic_write_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn replaces_existing_file_and_leaves_no_temp() {
        let dir = scratch("replace");
        let path = dir.join("a.sql");
        std::fs::write(&path, "old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 書き込めない (ここでは保存先がディレクトリで rename できない) ときは既存内容が
    // 変わらず、一時ファイルも残らない。
    #[test]
    fn failure_keeps_existing_target_and_cleans_temp() {
        let dir = scratch("fail");
        let target = dir.join("sub");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        assert!(write_atomic(&target, b"data").is_err());
        assert_eq!(std::fs::read_to_string(target.join("keep")).unwrap(), "x");
        let temps = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .count();
        assert_eq!(temps, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_is_resolved_not_replaced() {
        let dir = scratch("dangling");
        let real = dir.join("real.txt");
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink("real.txt", &link).unwrap();
        write_atomic(&link, b"x").unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_and_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perm");
        let real = dir.join("real.txt");
        std::fs::write(&real, "old").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
