use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

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

/// `tasks.json` への read-modify-write を直列化するロック。
/// `profiles::store::STORE_LOCK` / `ssh::known_hosts::KNOWN_HOSTS_LOCK` と同じ
/// 設計・同じ理由: Tauri の `async fn` コマンドはプロセス内で並行実行される。
/// このストアは `save_all`/`save_settings` 自身も「`tasks` と `settings` の
/// 片方だけを差し替えて丸ごと書き戻す」read-modify-write であり (もう片方の
/// フィールドを保つため必ず読んでから書く)、無防備だと後勝ちの書き込みが他方の
/// 更新を消す。poisoning は `into_inner` で回復する — パニック時点の書きかけ内容は
/// `write_atomic` の一時ファイル側にしか無く、本ファイルは直前の一貫した状態の
/// ままなので安全。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn tasks_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("tasks.json"))
}

/// 実際のファイル読み込み (ロック非取得)。ロックを跨いだ複合操作から使うための
/// 内部版。
fn load_file_locked() -> Result<TaskFile> {
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

/// 実際のファイル書き込み (ロック非取得)。`load_file_locked` と対。
fn save_file_locked(file: &TaskFile) -> Result<()> {
    let path = tasks_path()?;
    let content = serde_json::to_string_pretty(file)?;
    write_atomic(&path, content.as_bytes())?;
    Ok(())
}

/// `path` をアトミックに (全体差し替えで) 書き込む。`snippets::store::write_atomic`
/// と同じ理由 (書き込み途中のクラッシュ/電源断/ディスクフルで JSON が半端に残るのを防ぐ)。
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    // PID だけでは同一プロセス内の並行呼び出し (Tauri の `async fn` コマンドは
    // プロセス内で並行実行される) を区別できないため、プロセス内で単調増加する
    // カウンタも足して一時ファイル名を一意にする。
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "tasks.json".to_string()),
        std::process::id(),
        seq
    ));
    // `create` (`O_CREAT|O_TRUNC`) は既存エントリを開いてしまい、
    // シンボリックリンクなら**その指す先**を切り詰める。一時ファイル名は
    // PID + プロセス内カウンタで衝突しない前提だが、data_dir へ書ける
    // 別プロセスが候補パスを先回りして作れる以上、`create_new`
    // (`O_CREAT|O_EXCL`) で排他予約する (`commands::dump` の資格情報
    // ファイル / 一時ダンプファイルと同じ防御に揃える)。
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    // ここから先は「自分が排他予約に成功した」一時ファイルなので、途中で
    // 失敗したら必ず消してから抜ける。`create_new` にした以上、残骸を放置すると
    // PID が再利用された次回起動 (プロセス内カウンタは 0 から振り直される) で
    // 同じ候補パスに当たり、`AlreadyExists` で保存が**恒久的に**失敗しうる
    // (`create` だった頃は残骸を切り詰めて上書きするので無害だった)。
    //
    // **`open` 自体の失敗時に消さないのは意図的**: `AlreadyExists` は他プロセスの
    // 書きかけを指しうるので、それを消すと `create_new` による排他予約の意味が
    // 無くなる (消してよいのは自分が作ったものだけ)。
    let written = f.write_all(content).and_then(|()| f.sync_all());
    // Windows は開いたままのファイルを rename できないため、先に閉じる。
    drop(f);
    let written = written.and_then(|()| std::fs::rename(&tmp_path, path));
    if written.is_err() {
        // 後始末自体の失敗は握り潰す (呼び出し側には元のエラーを返したい)。
        let _ = std::fs::remove_file(&tmp_path);
    }
    written
}

pub fn load_all() -> Result<Vec<TaskDefinition>> {
    let _guard = lock_store();
    Ok(load_file_locked()?.tasks)
}

/// 「読み込み → 変更 → 保存」をロックを握ったまま一息で行う。
///
/// `load_all()` して変更してから `save_all()` する形だと、その**間にロックが
/// 解放される**ため、割り込んだ `upsert` / `delete` の変更を後から来た保存が
/// 丸ごと上書きしてしまう (lost update)。一覧全体を読んで書き戻す操作は必ず
/// この API を通すこと。`profiles::store::update_all` と同じ形。
///
/// `f` はロック下で実行されるので、**この中で他の公開 API を呼ばないこと** —
/// 同じ非再入 Mutex を取り直してデッドロックする。
pub fn update_all<F>(f: F) -> Result<()>
where
    F: FnOnce(&mut Vec<TaskDefinition>) -> Result<()>,
{
    // `settings` を保ったまま `tasks` だけ差し替える read-modify-write なので、
    // 読み→書きの全体をロックで保護する。
    let _guard = lock_store();
    let mut file = load_file_locked()?;
    f(&mut file.tasks)?;
    save_file_locked(&file)
}

pub fn upsert(task: TaskDefinition) -> Result<()> {
    let _guard = lock_store();
    let mut file = load_file_locked()?;
    if let Some(existing) = file.tasks.iter_mut().find(|t| t.id == task.id) {
        *existing = task;
    } else {
        file.tasks.push(task);
    }
    save_file_locked(&file)
}

pub fn delete(id: &str) -> Result<()> {
    let _guard = lock_store();
    let mut file = load_file_locked()?;
    file.tasks.retain(|t| t.id != id);
    save_file_locked(&file)
}

pub fn load_settings() -> Result<SchedulerSettings> {
    let _guard = lock_store();
    Ok(load_file_locked()?.settings)
}

pub fn save_settings(settings: SchedulerSettings) -> Result<()> {
    // `tasks` を保ったまま `settings` だけ差し替える read-modify-write。
    let _guard = lock_store();
    let mut file = load_file_locked()?;
    file.settings = settings;
    save_file_locked(&file)
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

    // 同一プロセス内で `write_atomic` を並行に呼んでも一時ファイル名が衝突しない
    // こと (`profiles::store` と同じ回帰テスト)。
    #[test]
    fn write_atomic_is_safe_under_same_process_concurrency() {
        let dir = scratch_dir("atomic_concurrent");
        let path = file_at(&dir);
        let path = std::sync::Arc::new(path);

        let handles: Vec<_> = (0..16)
            .map(|i| {
                let path = std::sync::Arc::clone(&path);
                std::thread::spawn(move || {
                    let content = format!("payload-{i}");
                    write_atomic(&path, content.as_bytes()).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let final_content = std::fs::read_to_string(&*path).unwrap();
        assert!(final_content.starts_with("payload-"));

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "tasks.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
