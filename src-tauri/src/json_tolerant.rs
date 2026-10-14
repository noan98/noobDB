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
