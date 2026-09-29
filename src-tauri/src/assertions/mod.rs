//! データ品質アサーション (#742) の定義型と永続化。
//!
//! 「この列は NULL であってはならない」「この列の値は 3 値のどれか」のような、
//! DB 制約として表現されていない業務上の期待をルールとして登録し、読み取り専用の
//! SELECT に変換して一括検証する。
//!
//! - 定義の永続化は `store` (`assertions.json`)。`snippets/store.rs` と同じ JSON
//!   ストアパターンで、スコープ (`SnippetScope`) もスニペットと共有する。
//!   **秘密情報は含まない**ので `profiles.json` と keyring の分離規約の対象外。
//! - ルール → SQL の変換と判定は副作用なしの純ロジック `db::assertions`。
//! - 実行は `commands::assertions` が既存の `run_lookup_query` 経路 (常に読み取り
//!   専用・タイムアウト付き・履歴/結果キャッシュに載らない) へ渡す。
//!
//! タスクスケジューラ (#730) の `TaskAction::RunAssertions` (#1170) は、実行の核
//! (`commands::assertions::run_assertion_with`) を `Assertion` 本体とセッションだけで
//! 呼ぶ。対象の絞り込みは純関数 `select_for_task`。

pub mod store;

use serde::{Deserialize, Serialize};

use crate::snippets::SnippetScope;

/// `row_count` ルールの比較演算子。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowCountOp {
    /// `行数 > value`
    Gt,
    /// `行数 >= value`
    Gte,
    /// `行数 < value`
    Lt,
    /// `行数 <= value`
    Lte,
    /// `行数 = value`
    Eq,
    /// `value <= 行数 <= max` (両端を含む)
    Between,
}

/// アサーションのルール本体。`kind` タグで判別する (JSON のフィールド名は
/// snake_case のまま — `SnippetScope` と同じ流儀)。
///
/// 値 (`values` / `min` / `max`) は**利用者が入力した文字列のまま**保持し、SQL を
/// 組み立てるときに初めてドライバ別のリテラルへ変換する (`db::assertions`)。
/// 保存時点では接続先ドライバが決まっていないため。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssertionRule {
    /// 列に NULL が無い。
    NotNull { column: String },
    /// 列 (または列の組) が一意。NULL を含む組は SQL の UNIQUE と同じく対象外。
    Unique { columns: Vec<String> },
    /// 値が指定リスト内 (NULL は対象外 — NULL を禁じたいなら `not_null` を併用)。
    AcceptedValues { column: String, values: Vec<String> },
    /// 数値/日時が範囲内 (両端を含む)。`min` / `max` の少なくとも一方が必要。
    Range {
        column: String,
        #[serde(default)]
        min: Option<String>,
        #[serde(default)]
        max: Option<String>,
    },
    /// 参照先テーブルに対応行が存在する (FK 未定義の論理参照の孤児行検出)。
    /// `columns` と `ref_columns` は同じ長さで、位置で対応する。
    Referential {
        columns: Vec<String>,
        #[serde(default)]
        ref_schema: Option<String>,
        ref_table: String,
        ref_columns: Vec<String>,
    },
    /// 行数が条件を満たす。`between` のときだけ `max` を使う。
    RowCount {
        op: RowCountOp,
        value: u64,
        #[serde(default)]
        max: Option<u64>,
    },
}

/// 保存済みのアサーション 1 件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Assertion {
    /// 8 文字スラッグ (プロファイル / スニペットと同じ生成規則)。
    pub id: String,
    /// 一覧に出す名前。
    pub name: String,
    /// どの接続のときに一覧へ出すか (スニペットと共有の型)。
    #[serde(default)]
    pub scope: SnippetScope,
    /// 対象テーブルのスキーマ (PostgreSQL のスキーマ、MySQL のデータベース)。
    /// `None` ならセッションの既定に任せる。
    #[serde(default)]
    pub schema: Option<String>,
    /// 対象テーブル。
    pub table: String,
    pub rule: AssertionRule,
}

/// スニペットと同じスコープ規則 (フロントの `scopeMatches` と同じ判定) で、
/// このアサーションが指定プロファイルの対象かを返す。
pub fn scope_matches(scope: &SnippetScope, profile_id: &str, group: Option<&str>) -> bool {
    match scope {
        SnippetScope::Any => true,
        SnippetScope::Profile { profile_id: p } => p == profile_id,
        SnippetScope::Group { group: g } => group.unwrap_or("") == g,
    }
}

/// タスクが実行するアサーションを選ぶ (#1170)。`ids` が空ならスコープの合うもの
/// すべて、指定があればその ID だけ (スコープは見ない — 利用者が明示的に選んだ
/// ものを尊重する)。存在しない ID は `Err(id)` として返し、呼び出し側が実行エラー
/// として記録する (削除されたアサーションを黙って飛ばさない)。
pub fn select_for_task(
    all: &[Assertion],
    ids: &[String],
    profile_id: &str,
    group: Option<&str>,
) -> Vec<std::result::Result<Assertion, String>> {
    if ids.is_empty() {
        return all
            .iter()
            .filter(|a| scope_matches(&a.scope, profile_id, group))
            .cloned()
            .map(Ok)
            .collect();
    }
    ids.iter()
        .map(|id| {
            all.iter()
                .find(|a| &a.id == id)
                .cloned()
                .ok_or_else(|| id.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(id: &str, scope: SnippetScope) -> Assertion {
        Assertion {
            id: id.into(),
            name: format!("name-{id}"),
            scope,
            schema: None,
            table: "t".into(),
            rule: AssertionRule::NotNull { column: "c".into() },
        }
    }

    fn sample() -> Vec<Assertion> {
        vec![
            a("any", SnippetScope::Any),
            a(
                "p1",
                SnippetScope::Profile {
                    profile_id: "P1".into(),
                },
            ),
            a(
                "p2",
                SnippetScope::Profile {
                    profile_id: "P2".into(),
                },
            ),
            a(
                "g",
                SnippetScope::Group {
                    group: "prod".into(),
                },
            ),
        ]
    }

    fn ids(v: &[std::result::Result<Assertion, String>]) -> Vec<String> {
        v.iter()
            .map(|r| match r {
                Ok(a) => a.id.clone(),
                Err(id) => format!("missing:{id}"),
            })
            .collect()
    }

    #[test]
    fn empty_ids_selects_by_scope() {
        let all = sample();
        assert_eq!(ids(&select_for_task(&all, &[], "P1", None)), ["any", "p1"]);
        assert_eq!(
            ids(&select_for_task(&all, &[], "P2", Some("prod"))),
            ["any", "p2", "g"]
        );
    }

    #[test]
    fn explicit_ids_ignore_scope_and_report_missing() {
        let all = sample();
        let sel = select_for_task(&all, &["p2".into(), "gone".into()], "P1", None);
        assert_eq!(ids(&sel), ["p2", "missing:gone"]);
    }
}
