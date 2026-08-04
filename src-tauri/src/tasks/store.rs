use std::io::Write;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use super::{SchedulerSettings, TaskDefinition};
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

/// On-disk shape: `{ "settings": {...}, "tasks": [...] }`. `snippets/store.rs`
/// と同じくラップ形にしておくことで、将来のトップレベルメタデータ追加に
/// フォーマット移行を要らなくする。`settings` はプロファイル横断のグローバル
/// スケジューラ設定 (#730 の「未起動中に過ぎたスケジュール」の扱い)。
#[derive(Debug, Default, Serialize, Deserialize)]
struct TaskFile {
    #[serde(default)]
    settings: SchedulerSettings,
    #[serde(default)]
    tasks: Vec<TaskDefinition>,
}

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn tasks_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("tasks.json"))
}

fn load_file() -> Result<TaskFile> {
    let path = tasks_path()?;
    if !path.exists() {
        return Ok(TaskFile::default());
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(TaskFile::default());
    }
    Ok(serde_json::from_str(&content)?)
}

fn save_file(file: &TaskFile) -> Result<()> {
    let path = tasks_path()?;
    let content = serde_json::to_string_pretty(file)?;
    write_atomic(&path, content.as_bytes())?;
    Ok(())
}

/// `path` をアトミックに (全体差し替えで) 書き込む。`snippets::store::write_atomic`
/// と同じ理由 (書き込み途中のクラッシュ/電源断/ディスクフルで JSON が半端に残るのを防ぐ)。
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "tasks.json".to_string()),
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

pub fn load_all() -> Result<Vec<TaskDefinition>> {
    Ok(load_file()?.tasks)
}

pub fn save_all(tasks: &[TaskDefinition]) -> Result<()> {
    let mut file = load_file()?;
    file.tasks = tasks.to_vec();
    save_file(&file)
}

pub fn upsert(task: TaskDefinition) -> Result<()> {
    let mut file = load_file()?;
    if let Some(existing) = file.tasks.iter_mut().find(|t| t.id == task.id) {
        *existing = task;
    } else {
        file.tasks.push(task);
    }
    save_file(&file)
}

pub fn delete(id: &str) -> Result<()> {
    let mut file = load_file()?;
    file.tasks.retain(|t| t.id != id);
    save_file(&file)
}

pub fn load_settings() -> Result<SchedulerSettings> {
    Ok(load_file()?.settings)
}

pub fn save_settings(settings: SchedulerSettings) -> Result<()> {
    let mut file = load_file()?;
    file.settings = settings;
    save_file(&file)
}

pub fn new_task_id() -> String {
    crate::state::random_slug(8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_tasks_store_test_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn file_at(dir: &std::path::Path) -> PathBuf {
        dir.join("tasks.json")
    }

    #[test]
    fn write_atomic_leaves_only_the_final_file() {
        let dir = scratch_dir("atomic_new");
        let path = file_at(&dir);
        write_atomic(&path, b"{\"tasks\":[]}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"tasks\":[]}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "tasks.json")
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `TaskFile` の JSON ラウンドトリップ: `settings` と `tasks` が両方保持される。
    /// 実ファイル I/O は `tasks_path()` (data_dir 依存) 経由のため、ここでは
    /// (де)serialization そのものだけを検証する。
    #[test]
    fn task_file_roundtrips_settings_and_tasks() {
        let file = TaskFile {
            settings: SchedulerSettings {
                catch_up_missed: true,
            },
            tasks: vec![],
        };
        let json = serde_json::to_string(&file).unwrap();
        let back: TaskFile = serde_json::from_str(&json).unwrap();
        assert!(back.settings.catch_up_missed);
        assert!(back.tasks.is_empty());
    }

    /// 旧形式 (settings フィールドが無い / tasks だけの JSON) でも
    /// `#[serde(default)]` によりデフォルト設定として読める後方互換性。
    #[test]
    fn task_file_defaults_missing_settings() {
        let back: TaskFile = serde_json::from_str("{\"tasks\":[]}").unwrap();
        assert!(!back.settings.catch_up_missed);
    }
}
