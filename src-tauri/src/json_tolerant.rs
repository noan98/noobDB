//! `{ "<key>": [ ... ] }` 形式の JSON ストア (snippets / sandboxes) の要素単位の寛容パース
//! (#1593)。`profiles::store` / `tasks::store` と同じ方針: 解釈できない要素 (将来の版が
//! 追加した値、手編集の誤りなど) 1 件のために全件の読み込み・保存が失敗しないようにし、
//! 解釈できなかった要素は保存時に生 JSON のまま書き戻して消さない。

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::Result;

/// `content` の `key` 配列を要素ごとに解釈する。戻り値は (解釈できた要素, 解釈できなかった
/// 生 JSON)。JSON として壊れている場合は従来どおりエラー。トップレベルや `key` が想定外の形
/// なら要素なしとして扱う。
pub(crate) fn parse_items<T: DeserializeOwned>(
    content: &str,
    key: &str,
) -> Result<(Vec<T>, Vec<Value>)> {
    let value: Value = serde_json::from_str(content)?;
    let mut items = Vec::new();
    let mut raw = Vec::new();
    if let Some(Value::Array(arr)) = value.get(key) {
        for v in arr {
            match serde_json::from_value::<T>(v.clone()) {
                Ok(t) => items.push(t),
                Err(e) => {
                    tracing::warn!(key, error = %e, "skipping unparsable entry");
                    raw.push(v.clone());
                }
            }
        }
    }
    Ok((items, raw))
}

/// 既存ファイルの内容から、解釈できない要素の生 JSON を取り出す。`known_ids` と `id` が
/// 重なるもの (同じ ID で新しく保存した要素) は除く。読めない / 壊れている場合は空。
pub(crate) fn unparsable_raw<T: DeserializeOwned>(
    existing: &str,
    key: &str,
    known_ids: &[&str],
) -> Vec<Value> {
    parse_items::<T>(existing, key)
        .map(|(_, raw)| raw)
        .unwrap_or_default()
        .into_iter()
        .filter(|v| {
            v.get("id")
                .and_then(|i| i.as_str())
                .map_or(true, |id| !known_ids.contains(&id))
        })
        .collect()
}

/// `{ key: items }` を作り、`raw` を配列の末尾に足した値を返す。
pub(crate) fn build_with_raw<T: serde::Serialize>(
    key: &str,
    items: &[T],
    raw: Vec<Value>,
) -> Result<Value> {
    let mut value = serde_json::json!({ key: serde_json::to_value(items)? });
    if let Some(Value::Array(arr)) = value.get_mut(key) {
        arr.extend(raw);
    }
    Ok(value)
}

/// 壊れたストアの退避先 `<name>.corrupt-<UTC秒>-<連番>`。同じ秒に複数回退避しても既存の
/// 退避を上書きしない (存在しない名前が見つかるまで連番を進める)。
pub(crate) fn corrupt_backup_path(path: &std::path::Path) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "store.json".to_string());
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let mut n = 0u32;
    loop {
        let candidate = path.with_file_name(format!("{name}.corrupt-{ts}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// JSON としては正しいが、トップレベルがオブジェクトでない / `key` が配列でない場合に、
/// ファイルを `corrupt_backup_path` へ退避して `true` を返す。呼び出し側は空として扱う
/// (放置すると次の保存が元の内容を退避なしで上書きする)。
pub(crate) fn quarantine_if_unexpected_shape(
    path: &std::path::Path,
    content: &str,
    key: &str,
) -> Result<bool> {
    let Ok(value) = serde_json::from_str::<Value>(content) else {
        return Ok(false);
    };
    if value.is_object() && value.get(key).map_or(true, Value::is_array) {
        return Ok(false);
    }
    let backup = corrupt_backup_path(path);
    tracing::error!(
        path = %path.display(),
        backup = %backup.display(),
        "store has an unexpected shape; moving it aside and starting empty"
    );
    std::fs::rename(path, &backup)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unexpected_shapes_are_quarantined() {
        let dir = std::env::temp_dir().join(format!("noobdb_jt_shape_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, body) in ["[1]", r#"{"k": {"a": 1}}"#].into_iter().enumerate() {
            let p = dir.join(format!("f{i}.json"));
            std::fs::write(&p, body).unwrap();
            assert!(quarantine_if_unexpected_shape(&p, body, "k").unwrap());
            assert!(!p.exists());
        }
        let ok = dir.join("ok.json");
        std::fs::write(&ok, r#"{"k": []}"#).unwrap();
        assert!(!quarantine_if_unexpected_shape(&ok, r#"{"k": []}"#, "k").unwrap());
        assert!(ok.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_backup_path_never_reuses_an_existing_name() {
        let dir = std::env::temp_dir().join(format!("noobdb_jt_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.join("x.json");
        let a = corrupt_backup_path(&base);
        std::fs::write(&a, "1").unwrap();
        let b = corrupt_backup_path(&base);
        assert_ne!(a, b);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
