use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use directories::ProjectDirs;

use super::ConnectionProfile;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

/// `profiles.json` への read-modify-write を直列化するロック。`Tauri` の
/// `#[tauri::command] async fn` はプロセス内で並行実行されるため (`ssh::known_hosts`
/// の `KNOWN_HOSTS_LOCK` と全く同じ事情)、`upsert`/`delete` が行う
/// 「`load_all` → 変更 → `save_all`」を無防備なまま並行実行すると、後勝ちの
/// `save_all` が他方の変更を消す lost update が起きる。このロックを
/// 読み→書きの全体にわたって保持することでそれを防ぐ。poisoning は
/// `into_inner` で回復する: パニック時点で書きかけの内容は `write_atomic` の一時
/// ファイル側にしか無く、本ファイル (`profiles.json`) は直前の一貫した状態の
/// ままなので、ロックの中身自体は壊れていない。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn profiles_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("profiles.json"))
}

/// 実際のファイル読み込み (ロック非取得)。ロックを跨いだ複合操作
/// (`upsert`/`delete`) から呼ぶための内部版で、公開 API の `load_all` はこれを
/// ロック付きでラップするだけ。
fn load_all_locked() -> Result<Vec<ConnectionProfile>> {
    let path = profiles_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to read profiles.json");
        e
    })?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let values: Vec<serde_json::Value> = serde_json::from_str(&content).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to parse profiles.json");
        e
    })?;
    Ok(parse_tolerant(values).0)
}

/// 要素ごとにプロファイルとして解釈する。解釈できない要素 (手編集・新しい版が足した
/// 未知の列挙子など) は警告を出して読み飛ばし、生の JSON のまま第 2 戻り値で返す。
/// 1 件の不正で全プロファイルの一覧・保存・削除が不能になるのを防ぐ。
fn parse_tolerant(
    values: Vec<serde_json::Value>,
) -> (Vec<ConnectionProfile>, Vec<serde_json::Value>) {
    let mut ok = Vec::with_capacity(values.len());
    let mut raw = Vec::new();
    for v in values {
        match serde_json::from_value::<ConnectionProfile>(v.clone()) {
            Ok(p) => ok.push(p),
            Err(e) => {
                tracing::warn!(error = %e, "profiles: skipping unparsable profile entry");
                raw.push(v);
            }
        }
    }
    (ok, raw)
}

/// 既存の profiles.json にある、解釈できない要素の生 JSON。保存時に書き戻して消さない。
fn unparsable_raw(path: &std::path::Path, known: &[ConnectionProfile]) -> Vec<serde_json::Value> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<serde_json::Value>>(&content) {
        // 解釈済みのプロファイルと id が重なるものは、書き戻すと重複するので除く。
        Ok(values) => parse_tolerant(values)
            .1
            .into_iter()
            .filter(|v| {
                v.get("id")
                    .and_then(|i| i.as_str())
                    .map_or(true, |id| !known.iter().any(|p| p.id == id))
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 読み飛ばされた (解釈できない) `profiles.json` の 1 要素の要約 (#1614)。UI が「n 件を
/// 読み込めませんでした」と出すためのもので、**秘密は含めない** (id・表示名・ドライバ・
/// 理由だけ。`profiles.json` に秘密は無いが、他のフィールドの値は返さない)。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct SkippedEntry {
    /// 解釈できなかった要素の並び順 (ファイル先頭から数えた 0 始まり)。`delete_skipped`
    /// の指定に使う。
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub driver: Option<String>,
    /// `serde` のエラー文 (長いものは切り詰める)。
    pub reason: String,
}

/// 理由文の最大文字数。
const SKIPPED_REASON_MAX_CHARS: usize = 200;

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// `values` のうち `ConnectionProfile` として解釈できない要素を、要約つきで返す。
fn skipped_entries(values: &[serde_json::Value]) -> Vec<SkippedEntry> {
    values
        .iter()
        .filter_map(|v| {
            serde_json::from_value::<ConnectionProfile>(v.clone())
                .err()
                .map(|e| (v, e))
        })
        .enumerate()
        .map(|(index, (v, e))| SkippedEntry {
            index,
            id: str_field(v, "id"),
            name: str_field(v, "name"),
            driver: str_field(v, "driver"),
            reason: e
                .to_string()
                .chars()
                .take(SKIPPED_REASON_MAX_CHARS)
                .collect(),
        })
        .collect()
}

/// 読み飛ばされた要素の一覧。ファイルが無い / 空 / 配列として壊れているときは空
/// (後者は `load_all` が別途エラーにする)。
pub fn list_skipped() -> Result<Vec<SkippedEntry>> {
    let _guard = lock_store();
    let path = profiles_path()?;
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    match serde_json::from_str::<Vec<serde_json::Value>>(&content) {
        Ok(values) => Ok(skipped_entries(&values)),
        Err(_) => Ok(Vec::new()),
    }
}

/// 読み飛ばされた要素のうち `index` 番目を `profiles.json` から取り除く。UI で選べない
/// ので、ファイルを手で直さずに消せるようにする。一覧を取った後にファイルが変わって
/// いた場合に別の要素を消さないよう、`id` (一覧で見えていたもの) が一致しなければ
/// 拒否する。
pub fn delete_skipped(index: usize, id: Option<&str>) -> Result<()> {
    let _guard = lock_store();
    let path = profiles_path()?;
    let content = std::fs::read_to_string(&path)?;
    let mut values: Vec<serde_json::Value> = serde_json::from_str(&content)?;
    let position = values
        .iter()
        .enumerate()
        .filter(|(_, v)| serde_json::from_value::<ConnectionProfile>((*v).clone()).is_err())
        .nth(index)
        .map(|(pos, _)| pos);
    let Some(pos) = position else {
        return Err(AppError::InvalidInput(
            "skipped profile entry not found (the file may have changed)".into(),
        ));
    };
    if str_field(&values[pos], "id").as_deref() != id {
        return Err(AppError::InvalidInput(
            "skipped profile entry changed since it was listed".into(),
        ));
    }
    values.remove(pos);
    let content = serde_json::to_string_pretty(&values)?;
    write_atomic(&path, content.as_bytes())?;
    Ok(())
}

/// 実際のファイル書き込み (ロック非取得)。`load_all_locked` と対で、複合操作から
/// 呼ぶための内部版。
fn save_all_locked(profiles: &[ConnectionProfile]) -> Result<()> {
    let path = profiles_path()?;
    // 読み飛ばした (解釈できない) 要素は生のまま末尾に残す。
    let mut values: Vec<serde_json::Value> = profiles
        .iter()
        .map(serde_json::to_value)
        .collect::<std::result::Result<_, _>>()?;
    values.extend(unparsable_raw(&path, profiles));
    let content = serde_json::to_string_pretty(&values).map_err(|e| {
        tracing::error!(error = %e, "profiles: failed to serialize profiles");
        e
    })?;
    write_atomic(&path, content.as_bytes()).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to write profiles.json");
        e
    })?;
    Ok(())
}

pub fn load_all() -> Result<Vec<ConnectionProfile>> {
    let _guard = lock_store();
    load_all_locked()
}

/// 「読み込み → 変更 → 保存」をロックを握ったまま一息で行う。
///
/// `load_all()` と `save_all()` を別々に呼ぶと、その**間にロックが解放される**
/// ため、間に割り込んだ `upsert` / `delete` の変更を後から来た `save_all` が
/// 丸ごと上書きしてしまう (lost update)。インポートや並べ替えのようにストア
/// 全体を読んで書き戻す操作は、必ずこの API を通すこと。
///
/// `f` はロック下で実行されるので、**この中で他の公開 API (`load_all` /
/// `save_all` / `upsert` / `delete`) を呼ばないこと** — 同じ非再入 Mutex を
/// 取り直してデッドロックする。
pub fn update_all<F>(f: F) -> Result<()>
where
    F: FnOnce(Vec<ConnectionProfile>) -> Result<Vec<ConnectionProfile>>,
{
    let _guard = lock_store();
    let current = load_all_locked()?;
    let next = f(current)?;
    save_all_locked(&next)
}

/// `path` をアトミックに (全体差し替えで) 書き込む。同じディレクトリに一時ファイル
/// を書いて `sync_all` してから `rename` することで、書き込み途中のクラッシュ/
/// 電源断/ディスクフルで本ファイルが半端な内容のまま残る (以後 JSON パース失敗で
/// 全プロファイルが読めなくなる) 事態を防ぐ。同一ファイルシステム内の `rename` は
/// アトミックなので、途中状態は一時ファイル側にしか現れない。
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    // プロセス ID だけでは同一プロセス内の並行呼び出し (Tauri の `async fn` コマンドは
    // プロセス内で並行実行される) 同士が同じ一時ファイル名を選んでしまい、互いの
    // 書き込みを上書きし合う (アトミック書き込みの保証そのものが壊れる) ため、
    // プロセス内で単調増加するカウンタも足して一意にする。
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "profiles.json".to_string()),
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

pub fn upsert(profile: ConnectionProfile) -> Result<()> {
    // 読み→書きの全体でロックを保持する (`load_all`/`save_all` を素朴に呼ぶと
    // その間にロックが解放され、他の呼び出しの変更を踏む余地が生まれるため、
    // ロックを取らない内部版を直接使う)。
    let _guard = lock_store();
    let mut all = load_all_locked()?;
    if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile;
    } else {
        all.push(profile);
    }
    save_all_locked(&all)
}

pub fn delete(id: &str) -> Result<()> {
    let _guard = lock_store();
    let mut all = load_all_locked()?;
    all.retain(|p| p.id != id);
    save_all_locked(&all)
}

pub fn new_profile_id() -> String {
    use rand::RngExt;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..8)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_profiles_store_test_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn skipped_entries_summarize_unparsable_values_without_other_fields() {
        let values: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
              {"id":"ok1","name":"fine","driver":"sqlite","host":"","port":0,"user":"","database":"x"},
              {"id":"bad1","name":"broken","driver":"mysql","port":"not a number","secret":"s3cret"},
              {"name":"no id"},
              42
            ]"#,
        )
        .unwrap();
        let got = skipped_entries(&values);
        // 解釈できる要素 (1 件目が実際に解釈できるかは型次第なので、壊れた 3 件を検査する)。
        let bad: Vec<_> = got
            .iter()
            .filter(|e| e.id.as_deref() != Some("ok1"))
            .collect();
        assert!(bad.len() >= 3);
        let first = bad
            .iter()
            .find(|e| e.id.as_deref() == Some("bad1"))
            .unwrap();
        assert_eq!(first.name.as_deref(), Some("broken"));
        assert_eq!(first.driver.as_deref(), Some("mysql"));
        assert!(!first.reason.is_empty());
        assert!(!format!("{got:?}").contains("s3cret"));
        // index は 0 始まりの連番。
        for (i, e) in got.iter().enumerate() {
            assert_eq!(e.index, i);
        }
    }

    // 同一プロセス内で `write_atomic` を並行に呼んでも、一時ファイル名が衝突して
    // 互いの内容を混ぜてしまわないこと (#H の本題)。カウンタが無いと PID だけでは
    // 同一プロセス内の並行呼び出しを区別できず、2 本のスレッドが同じ一時ファイルを
    // create/write/rename して壊れた内容が残りうる。
    #[test]
    fn write_atomic_is_safe_under_same_process_concurrency() {
        let dir = scratch_dir("atomic_concurrent");
        let path = dir.join("profiles.json");
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

        // 最終的な内容はどれか 1 本の書き込みそのもの (途中で切れたり混ざったり
        // していない) であること。
        let final_content = std::fs::read_to_string(&*path).unwrap();
        assert!(final_content.starts_with("payload-"));
        let n: usize = final_content["payload-".len()..].parse().unwrap();
        assert!(n < 16);

        // 一時ファイルが残っていないこと。
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "profiles.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // H3: write_atomic はリネーム後に内容が読め、一時ファイルを残さないこと。
    #[test]
    fn write_atomic_leaves_only_the_final_file() {
        let dir = scratch_dir("atomic_new");
        let path = dir.join("profiles.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "profiles.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 既存ファイルを上書きするケースでも、書き込み完了後は新しい内容だけが
    // 残ること (アトミックな置き換え)。
    #[test]
    fn write_atomic_overwrites_existing_file() {
        let dir = scratch_dir("atomic_overwrite");
        let path = dir.join("profiles.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "profiles.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 解釈できない要素は読み飛ばされ、生の JSON として保持される。
    #[test]
    fn parse_tolerant_skips_unparsable_entries_and_keeps_raw() {
        let values = vec![serde_json::json!({"id": 1}), serde_json::json!("junk")];
        let (ok, raw) = parse_tolerant(values.clone());
        assert!(ok.is_empty());
        assert_eq!(raw, values);
    }

    // save_all_locked が解釈できない生要素を保持して書き戻す (往復)。
    #[test]
    fn unparsable_raw_survives_save_and_skips_known_ids() {
        let dir = scratch_dir("raw_roundtrip");
        let path = dir.join("profiles.json");
        std::fs::write(&path, r#"[{"id":"zz","bogus":true},"junk"]"#).unwrap();
        let raw = unparsable_raw(&path, &[]);
        assert_eq!(raw.len(), 2);
        // 書き戻した内容を再度読んでも、解釈済み 0 件・生要素 2 件のまま。
        let mut values: Vec<serde_json::Value> = Vec::new();
        values.extend(raw);
        write_atomic(&path, serde_json::to_string(&values).unwrap().as_bytes()).unwrap();
        assert_eq!(unparsable_raw(&path, &[]).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
