//! 小さな非秘密の JSON ストア用の共通部品 (#1621)。`{ ... }` 1 ファイルを丸ごと読み書きする
//! だけの用途 (アサーション履歴・アドバイザの「対応しない」・テーブル統計の前回値など) で、
//! ストア規約 (`noobdb-storage` スキル) の必須対策をまとめて満たす。
//!
//! - ストア単位の `Mutex` で read-modify-write 全体を直列化する (lost update 防止)。
//! - 書き込みは `atomic_write::write_atomic` (一時ファイル → rename)。
//! - 壊れた JSON は `<file>.corrupt-<UTC>` へ退避して既定値から再開する (内容は失わない)。
//! - **秘密情報は載せない**こと (`profiles.json` / keyring の分離規約は呼び出し側が守る)。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use directories::ProjectDirs;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, Result};

/// 1 ファイルぶんの JSON ストア。`static` に置いて使う (`const fn new`)。
pub struct JsonStore {
    file_name: &'static str,
    lock: Mutex<()>,
}

impl JsonStore {
    pub const fn new(file_name: &'static str) -> Self {
        Self {
            file_name,
            lock: Mutex::new(()),
        }
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        // poisoning は無視して続行する: 本ファイルは `write_atomic` のおかげで常に
        // 直前の一貫した状態のまま。
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn path(&self) -> Result<PathBuf> {
        let dir = ProjectDirs::from("", "", "noobDB")
            .map(|p| p.data_dir().to_path_buf())
            .ok_or(AppError::ConfigDir)?;
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join(self.file_name))
    }

    /// 読み込み (ロックあり)。
    pub fn read<T: DeserializeOwned + Default>(&self) -> Result<T> {
        let _g = self.guard();
        load_from(&self.path()?)
    }

    /// 読み込み → 変更 → 書き込みを 1 回のロックで行い、`f` の戻り値を返す。
    pub fn update<T, R>(&self, f: impl FnOnce(&mut T) -> R) -> Result<R>
    where
        T: DeserializeOwned + Serialize + Default,
    {
        let _g = self.guard();
        update_at(&self.path()?, f)
    }
}

/// パス指定の読み込み (ロック非取得。テストと `JsonStore` が共有)。
pub fn load_from<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(T::default());
    }
    match serde_json::from_str::<T>(&content) {
        Ok(v) => Ok(v),
        Err(e) => {
            let backup = crate::json_tolerant::corrupt_backup_path(path);
            tracing::error!(
                path = %path.display(),
                backup = %backup.display(),
                error = %e,
                "json store is corrupt; moving it aside and starting empty"
            );
            std::fs::rename(path, &backup)?;
            Ok(T::default())
        }
    }
}

/// パス指定の read-modify-write (ロック非取得)。
pub fn update_at<T, R>(path: &Path, f: impl FnOnce(&mut T) -> R) -> Result<R>
where
    T: DeserializeOwned + Serialize + Default,
{
    let mut value: T = load_from(path)?;
    let out = f(&mut value);
    let content = serde_json::to_string_pretty(&value)?;
    crate::atomic_write::write_atomic(path, content.as_bytes())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Doc {
        #[serde(default)]
        items: Vec<String>,
    }

    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("noobdb_json_store_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_and_empty_files_are_default() {
        let dir = scratch("empty");
        let path = dir.join("d.json");
        assert_eq!(load_from::<Doc>(&path).unwrap(), Doc::default());
        std::fs::write(&path, " \n").unwrap();
        assert_eq!(load_from::<Doc>(&path).unwrap(), Doc::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_roundtrips_and_leaves_no_temp_files() {
        let dir = scratch("update");
        let path = dir.join("d.json");
        update_at::<Doc, _>(&path, |d| d.items.push("a".into())).unwrap();
        let n = update_at::<Doc, _>(&path, |d| {
            d.items.push("b".into());
            d.items.len()
        })
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(load_from::<Doc>(&path).unwrap().items, ["a", "b"]);
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_quarantined() {
        let dir = scratch("corrupt");
        let path = dir.join("d.json");
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(load_from::<Doc>(&path).unwrap(), Doc::default());
        let backups = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(backups, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
