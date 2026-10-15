//! アサーション定義の JSON 書き出し・取り込み (#1621) の純ロジック。
//!
//! 書き出すのは `{ "format": "noobdb-assertions", "version": 1, "assertions": [...] }`。
//! 秘密情報を含まない (スコープ・スキーマ・テーブル・ルールだけ) ので keyring の分離規約とは
//! 無関係。取り込みは 1 件ずつ解釈・検証し、読めない要素は理由つきで報告して**残りは取り込む**
//! (1 件の誤りで全件を失敗させない)。ID の衝突解決と重複の除外は `store::plan_import`。

use serde::Serialize;
use serde_json::Value;

use super::Assertion;
use crate::db::assertions::validate;
use crate::error::{AppError, Result};
use crate::snippets::SnippetScope;

pub const EXPORT_FORMAT: &str = "noobdb-assertions";
pub const EXPORT_VERSION: u32 = 1;
/// 取り込む JSON の最大バイト数 (手違いで巨大なファイルを読み込まない)。
pub const MAX_IMPORT_BYTES: usize = 4 * 1024 * 1024;

/// 取り込めなかった要素 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportRejection {
    /// 何番目の要素か (0 始まり)。
    pub index: u32,
    /// 名前が読めればその名前。
    pub name: Option<String>,
    pub error: String,
}

/// 書き出し用の JSON 文字列を作る。
pub fn export_json(assertions: &[Assertion], exported_at: &str) -> Result<String> {
    let doc = serde_json::json!({
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exported_at": exported_at,
        "assertions": assertions,
    });
    Ok(serde_json::to_string_pretty(&doc)?)
}

/// 取り込み JSON を解釈する。`{ "assertions": [...] }` (書き出し形式 / `assertions.json` と同形)
/// と、定義だけの配列 `[...]` のどちらも受ける。`current_profile_id` があれば、プロファイル
/// 限定のスコープは**取り込み先で存在しない ID を指している**ので、そのプロファイルへ付け替える
/// (グループ・全接続のスコープはそのまま)。
pub fn parse_import(
    json: &str,
    current_profile_id: Option<&str>,
) -> Result<(Vec<Assertion>, Vec<ImportRejection>)> {
    if json.len() > MAX_IMPORT_BYTES {
        return Err(AppError::InvalidInput(
            "assertions import: file is too large".into(),
        ));
    }
    let doc: Value = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidInput(format!("assertions import: invalid JSON: {e}")))?;
    let list = match &doc {
        Value::Array(a) => a,
        Value::Object(o) => match o.get("assertions") {
            Some(Value::Array(a)) => a,
            _ => {
                return Err(AppError::InvalidInput(
                    "assertions import: no \"assertions\" array found".into(),
                ))
            }
        },
        _ => {
            return Err(AppError::InvalidInput(
                "assertions import: expected an object or an array".into(),
            ))
        }
    };
    let mut ok = Vec::new();
    let mut rejected = Vec::new();
    for (i, raw) in list.iter().enumerate() {
        let index = u32::try_from(i).unwrap_or(u32::MAX);
        let name = raw.get("name").and_then(Value::as_str).map(str::to_string);
        // `id` は取り込み時に必ず振り直し得るので、欠けていても読む。
        let mut raw = raw.clone();
        if let Some(obj) = raw.as_object_mut() {
            obj.entry("id").or_insert(Value::String(String::new()));
        }
        let mut a: Assertion = match serde_json::from_value(raw) {
            Ok(a) => a,
            Err(e) => {
                rejected.push(ImportRejection {
                    index,
                    name,
                    error: e.to_string(),
                });
                continue;
            }
        };
        a.name = a.name.trim().to_string();
        a.table = a.table.trim().to_string();
        a.schema = a
            .schema
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if a.name.is_empty() {
            rejected.push(ImportRejection {
                index,
                name,
                error: "name is required".into(),
            });
            continue;
        }
        if let Err(e) = validate(&a.table, &a.rule) {
            rejected.push(ImportRejection {
                index,
                name,
                error: e.to_string(),
            });
            continue;
        }
        if let (Some(current), SnippetScope::Profile { .. }) = (current_profile_id, &a.scope) {
            a.scope = SnippetScope::Profile {
                profile_id: current.to_string(),
            };
        }
        ok.push(a);
    }
    Ok((ok, rejected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assertions::AssertionRule;

    fn sample(id: &str, scope: SnippetScope) -> Assertion {
        Assertion {
            id: id.into(),
            name: "no null email".into(),
            scope,
            schema: Some("public".into()),
            table: "users".into(),
            rule: AssertionRule::NotNull {
                column: "email".into(),
            },
        }
    }

    #[test]
    fn export_then_import_roundtrips() {
        let src = vec![
            sample("aaaaaaaa", SnippetScope::Any),
            sample(
                "bbbbbbbb",
                SnippetScope::Group {
                    group: "prod".into(),
                },
            ),
        ];
        let json = export_json(&src, "2026-01-01T00:00:00Z").unwrap();
        assert!(json.contains("\"format\": \"noobdb-assertions\""));
        let (ok, rejected) = parse_import(&json, None).unwrap();
        assert!(rejected.is_empty());
        assert_eq!(ok, src);
    }

    #[test]
    fn profile_scope_is_rebound_to_the_current_profile() {
        let src = vec![
            sample(
                "aaaaaaaa",
                SnippetScope::Profile {
                    profile_id: "OLD".into(),
                },
            ),
            sample("bbbbbbbb", SnippetScope::Any),
        ];
        let json = export_json(&src, "t").unwrap();
        let (ok, _) = parse_import(&json, Some("NEW")).unwrap();
        assert_eq!(
            ok[0].scope,
            SnippetScope::Profile {
                profile_id: "NEW".into()
            }
        );
        assert_eq!(ok[1].scope, SnippetScope::Any);
        // 付け替えなし。
        let (ok, _) = parse_import(&json, None).unwrap();
        assert_eq!(
            ok[0].scope,
            SnippetScope::Profile {
                profile_id: "OLD".into()
            }
        );
    }

    #[test]
    fn accepts_bare_array_and_missing_ids() {
        let json = r#"[{"name":"n","table":"t","rule":{"kind":"not_null","column":"c"}}]"#;
        let (ok, rejected) = parse_import(json, None).unwrap();
        assert!(rejected.is_empty());
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].id, "");
    }

    #[test]
    fn bad_items_are_reported_but_do_not_block_the_rest() {
        let json = r#"{"assertions":[
            {"id":"a","name":"good","table":"t","rule":{"kind":"not_null","column":"c"}},
            {"id":"b","name":"  ","table":"t","rule":{"kind":"not_null","column":"c"}},
            {"id":"c","name":"no column","table":"t","rule":{"kind":"not_null","column":""}},
            {"id":"d","name":"write","table":"t","rule":{"kind":"custom_sql","sql":"DELETE FROM t"}},
            {"id":"e","name":"broken","table":"t","rule":{"kind":"nope"}},
            42
        ]}"#;
        let (ok, rejected) = parse_import(json, None).unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].name, "good");
        assert_eq!(rejected.len(), 5);
        assert_eq!(rejected[0].index, 1);
        assert_eq!(rejected[4].index, 5);
        assert_eq!(rejected[2].name.as_deref(), Some("write"));
    }

    #[test]
    fn structural_errors_fail_the_whole_import() {
        assert!(parse_import("not json", None).is_err());
        assert!(parse_import("{}", None).is_err());
        assert!(parse_import("3", None).is_err());
        let big = format!("[\"{}\"]", "a".repeat(MAX_IMPORT_BYTES));
        assert!(parse_import(&big, None).is_err());
    }
}
