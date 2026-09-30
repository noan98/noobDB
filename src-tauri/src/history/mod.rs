pub mod store;

use serde::{Deserialize, Serialize};

/// A persisted record of one executed statement. Mirrors the
/// `query_history` table; `id`/`executed_at` are filled in by the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    /// Profile the session was opened from, or `None` for an ad-hoc connection.
    pub profile_id: Option<String>,
    pub driver: String,
    pub database: Option<String>,
    /// 一覧表示用の SQL 要約 (#1256)。空白を 1 つに畳んだ先頭 [`SQL_PREVIEW_CHARS`]
    /// 文字で、超えた分は `…` で切る (`sql_summary` と同じ畳み方)。全文は一覧に
    /// 載せず、復元・コピーなど必要な時に `get_history_sql` で取得する (数十 KB の
    /// SQL が 100 件ぶん IPC を往復するのを避ける)。
    pub sql_preview: String,
    /// SQL 全文の文字数 (`sql_preview` が切り詰められたかの目安や、長大 SQL の表示用)。
    pub sql_len: i64,
    /// Number of rows returned (SELECT-shaped statements). `None` for writes.
    pub rows: Option<i64>,
    /// Number of rows affected (write statements). `None` for SELECTs.
    pub rows_affected: Option<i64>,
    pub elapsed_ms: Option<i64>,
    /// `"ok"` or `"error"`.
    pub status: String,
    pub error: Option<String>,
    /// ISO8601 (RFC3339, UTC) timestamp.
    pub executed_at: String,
}

/// Insert payload — everything except the auto-assigned `id`.
#[derive(Debug, Clone)]
pub struct NewHistoryEntry {
    pub profile_id: Option<String>,
    pub driver: String,
    pub database: Option<String>,
    pub sql: String,
    pub rows: Option<i64>,
    pub rows_affected: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub status: String,
    pub error: Option<String>,
    pub executed_at: String,
}

/// `HistoryEntry::sql_preview` の最大文字数。
pub const SQL_PREVIEW_CHARS: usize = 400;

/// SQL を 1 行へ畳んだ要約にする。空白の連続を 1 つの半角スペースにし、先頭
/// [`SQL_PREVIEW_CHARS`] 文字で切る (超えたら末尾に `…`)。
pub fn sql_preview(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > SQL_PREVIEW_CHARS {
        let head: String = one_line.chars().take(SQL_PREVIEW_CHARS).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_collapses_whitespace() {
        assert_eq!(sql_preview("SELECT\n  *\tFROM   t\n"), "SELECT * FROM t");
    }

    #[test]
    fn preview_truncates_with_ellipsis() {
        let long = format!("SELECT {}", "a, ".repeat(400));
        let p = sql_preview(&long);
        assert_eq!(p.chars().count(), SQL_PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
        // ちょうど上限ちょうどなら切らない。
        let exact = "x".repeat(SQL_PREVIEW_CHARS);
        assert_eq!(sql_preview(&exact), exact);
    }
}
