//! スキーマ健全性アドバイザの「対応しない」(#1621)。意図的な冗長インデックスやログ用の PK なし
//! テーブルなど、利用者が「これは直さない」と決めた指摘を `advisor_ignores.json` に残し、
//! 次回以降の診断で本表から外して別枠に折りたたむ。
//!
//! 同一性は [`HealthFinding::key`] (`ルール | テーブル | 列 [| インデックス名]`)。接続先ごとに
//! 独立させるため、(プロファイル ID, データベース) と組にして保存する (プロファイルを持たない
//! 一時接続は `profile_id = null`)。保存するのは非秘密のメタデータだけで、秘密情報・行データは
//! 含まない。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::db::advisor::{HealthFinding, RuleId};
use crate::error::Result;
use crate::json_store::JsonStore;

/// 保存する「対応しない」1 件。`rule` / `table` / `columns` は人が JSON を開いたときに
/// 何の指摘か分かるようにするための控え (判定には `key` だけを使う)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvisorIgnore {
    #[serde(default)]
    pub profile_id: Option<String>,
    pub database: String,
    pub key: String,
    pub rule: RuleId,
    pub table: String,
    #[serde(default)]
    pub columns: Vec<String>,
    /// 「対応しない」にした時刻 (UTC, RFC 3339)。
    pub created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct IgnoreFile {
    #[serde(default)]
    ignores: Vec<AdvisorIgnore>,
}

static STORE: JsonStore = JsonStore::new("advisor_ignores.json");

fn matches(e: &AdvisorIgnore, profile_id: Option<&str>, database: &str) -> bool {
    e.profile_id.as_deref() == profile_id && e.database == database
}

/// この接続先で「対応しない」にしている指摘のキー集合。
pub fn ignored_keys(profile_id: Option<&str>, database: &str) -> Result<HashSet<String>> {
    let file: IgnoreFile = STORE.read()?;
    Ok(file
        .ignores
        .into_iter()
        .filter(|e| matches(e, profile_id, database))
        .map(|e| e.key)
        .collect())
}

fn add_to(
    file: &mut IgnoreFile,
    profile_id: Option<&str>,
    database: &str,
    f: &HealthFinding,
    now: &str,
) {
    let key = f.key();
    if file
        .ignores
        .iter()
        .any(|e| matches(e, profile_id, database) && e.key == key)
    {
        return;
    }
    file.ignores.push(AdvisorIgnore {
        profile_id: profile_id.map(str::to_string),
        database: database.to_string(),
        key,
        rule: f.rule,
        table: f.table.clone(),
        columns: f.columns.clone(),
        created_at: now.to_string(),
    });
}

fn remove_from(file: &mut IgnoreFile, profile_id: Option<&str>, database: &str, key: &str) {
    file.ignores
        .retain(|e| !(matches(e, profile_id, database) && e.key == key));
}

/// 指摘を「対応しない」にする (すでにあれば何もしない)。
pub fn add(profile_id: Option<&str>, database: &str, finding: &HealthFinding) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    STORE.update::<IgnoreFile, _>(|f| add_to(f, profile_id, database, finding, &now))
}

/// 「対応しない」を取り消す。
pub fn remove(profile_id: Option<&str>, database: &str, finding: &HealthFinding) -> Result<()> {
    let key = finding.key();
    STORE.update::<IgnoreFile, _>(|f| remove_from(f, profile_id, database, &key))
}

/// 指摘を (表示する, 対応しない) に振り分ける。順序は保つ。
pub fn partition(
    findings: Vec<HealthFinding>,
    ignored: &HashSet<String>,
) -> (Vec<HealthFinding>, Vec<HealthFinding>) {
    findings
        .into_iter()
        .partition(|f| !ignored.contains(&f.key()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::advisor::Severity;

    fn f(rule: RuleId, table: &str, cols: &[&str], ctx: &[&str]) -> HealthFinding {
        HealthFinding {
            rule,
            severity: Severity::Low,
            table: table.into(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            context: ctx.iter().map(|c| c.to_string()).collect(),
            fix_ddl: None,
            fix_ddl_online: None,
            statistical: false,
            size_bytes: None,
        }
    }

    #[test]
    fn add_is_idempotent_and_scoped_per_connection() {
        let mut file = IgnoreFile::default();
        let finding = f(RuleId::MissingPrimaryKey, "log", &[], &[]);
        add_to(&mut file, Some("p1"), "app", &finding, "t");
        add_to(&mut file, Some("p1"), "app", &finding, "t2");
        add_to(&mut file, Some("p2"), "app", &finding, "t");
        add_to(&mut file, Some("p1"), "other", &finding, "t");
        assert_eq!(file.ignores.len(), 3);
        assert_eq!(file.ignores[0].created_at, "t", "二重登録は無視する");

        remove_from(&mut file, Some("p1"), "app", &finding.key());
        assert_eq!(file.ignores.len(), 2);
        assert!(file
            .ignores
            .iter()
            .all(|e| !(matches(e, Some("p1"), "app"))));
    }

    #[test]
    fn partition_moves_ignored_findings_and_keeps_order() {
        let a = f(RuleId::MissingPrimaryKey, "a", &[], &[]);
        let b = f(RuleId::UnusedIndex, "b", &["x"], &["i1"]);
        let c = f(RuleId::MissingPrimaryKey, "c", &[], &[]);
        let ignored: HashSet<String> = [b.key()].into_iter().collect();
        let (active, silenced) = partition(vec![a.clone(), b.clone(), c.clone()], &ignored);
        assert_eq!(active, vec![a, c]);
        assert_eq!(silenced, vec![b]);
    }
}
