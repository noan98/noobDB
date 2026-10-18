//! スニペットの JSON 書き出し・取り込み (#1490) の純ロジック。
//!
//! 書き出すのは `{ "format": "noobdb-snippets", "version": 1, "snippets": [...] }`。
//! スニペットは非秘密 (名前・フォルダ・タグ・SQL・スコープ) なので keyring の分離規約とは
//! 無関係。取り込みは 1 件ずつ解釈・検証し、読めない要素は理由つきで報告して**残りは取り込む**
//! (1 件の誤りで全件を失敗させない)。ID の衝突解決はプロファイル取り込み
//! (`commands::profiles::ImportStrategy`) と同じ「新規採番 / スキップ / 上書き」。

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

use super::{Snippet, SnippetScope};
use crate::assertions::transfer::ImportRejection;
use crate::commands::profiles::ImportStrategy;
use crate::error::{AppError, Result};

pub const EXPORT_FORMAT: &str = "noobdb-snippets";
pub const EXPORT_VERSION: u32 = 1;
/// 取り込む JSON の最大バイト数 (手違いで巨大なファイルを読み込まない)。
pub const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;

/// 取り込みの集計。プレビュー (書き込まない) と本番で同じ意味。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportCounts {
    /// 新規に追加した件数 (衝突して採番し直したものを含む)。
    pub imported: u32,
    /// 衝突してスキップした件数。
    pub skipped: u32,
    /// 衝突して既存を上書きした件数。
    pub overwritten: u32,
    /// 既存と ID が衝突した件数 (戦略に関わらず数える。プレビュー用)。
    pub conflicts: u32,
    /// 取り込み先に存在しないプロファイルを指していたため、全接続スコープへ戻した件数。
    pub scope_reset: u32,
}

/// 書き出し用の JSON 文字列を作る。
pub fn export_json(snippets: &[Snippet], exported_at: &str) -> Result<String> {
    let doc = serde_json::json!({
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exported_at": exported_at,
        "snippets": snippets,
    });
    Ok(serde_json::to_string_pretty(&doc)?)
}

/// 取り込み JSON を解釈する。`{ "snippets": [...] }` (書き出し形式 / `snippets.json` と同形)
/// と、定義だけの配列 `[...]` のどちらも受ける。`format` があれば `noobdb-snippets` で
/// なければ拒否する (別種の書き出しファイルの取り違え防止)。
pub fn parse_import(json: &str) -> Result<(Vec<Snippet>, Vec<ImportRejection>)> {
    if json.len() > MAX_IMPORT_BYTES {
        return Err(AppError::InvalidInput(
            "snippets import: file is too large".into(),
        ));
    }
    let doc: Value = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidInput(format!("snippets import: invalid JSON: {e}")))?;
    let list = match &doc {
        Value::Array(a) => a,
        Value::Object(o) => {
            if let Some(format) = o.get("format").and_then(Value::as_str) {
                if format != EXPORT_FORMAT {
                    return Err(AppError::InvalidInput(format!(
                        "snippets import: unrecognized format: {format}"
                    )));
                }
            }
            match o.get("snippets") {
                Some(Value::Array(a)) => a,
                _ => {
                    return Err(AppError::InvalidInput(
                        "snippets import: no \"snippets\" array found".into(),
                    ))
                }
            }
        }
        _ => {
            return Err(AppError::InvalidInput(
                "snippets import: expected an object or an array".into(),
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
        let mut s: Snippet = match serde_json::from_value(raw) {
            Ok(s) => s,
            Err(e) => {
                rejected.push(ImportRejection {
                    index,
                    name,
                    error: e.to_string(),
                });
                continue;
            }
        };
        // `save_snippet` と同じ正規化。
        s.name = s.name.trim().to_string();
        s.folder = s.folder.filter(|f| !f.trim().is_empty());
        s.tags = s
            .tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        s.driver = s.driver.filter(|d| !d.is_empty());
        if s.name.is_empty() {
            rejected.push(ImportRejection {
                index,
                name,
                error: "name is required".into(),
            });
            continue;
        }
        ok.push(s);
    }
    Ok((ok, rejected))
}

/// 取り込みの純ロジック。`existing` に `incoming` を `strategy` で統合した結果と集計を返す。
///
/// - ID が既存 (または取り込み内の先行分) と衝突したときは `strategy` に従う
///   (`Rename` は `new_id` で採番し直し、`Skip` は捨て、`Overwrite` は既存を差し替える)。
/// - ID が空なら採番する。
/// - プロファイル限定スコープが `known_profile_ids` に無い ID を指していたら、どの接続からも
///   使われない孤立を避けるため全接続スコープ (`Any`) へ戻す。グループスコープはそのまま。
pub fn plan_import(
    mut existing: Vec<Snippet>,
    incoming: Vec<Snippet>,
    strategy: ImportStrategy,
    known_profile_ids: &HashSet<String>,
    mut new_id: impl FnMut() -> String,
) -> (Vec<Snippet>, ImportCounts) {
    let mut counts = ImportCounts::default();
    let mut taken: HashSet<String> = existing.iter().map(|s| s.id.clone()).collect();
    for mut s in incoming {
        if let SnippetScope::Profile { profile_id } = &s.scope {
            if !known_profile_ids.contains(profile_id) {
                s.scope = SnippetScope::Any;
                counts.scope_reset += 1;
            }
        }
        let collides = !s.id.is_empty() && taken.contains(&s.id);
        if collides {
            counts.conflicts += 1;
            match strategy {
                ImportStrategy::Skip => {
                    counts.skipped += 1;
                    continue;
                }
                ImportStrategy::Overwrite => {
                    if let Some(slot) = existing.iter_mut().find(|e| e.id == s.id) {
                        *slot = s;
                    }
                    counts.overwritten += 1;
                    continue;
                }
                ImportStrategy::Rename => {
                    s.id = fresh_id(&taken, &mut new_id);
                }
            }
        } else if s.id.is_empty() {
            s.id = fresh_id(&taken, &mut new_id);
        }
        taken.insert(s.id.clone());
        existing.push(s);
        counts.imported += 1;
    }
    (existing, counts)
}

/// 衝突し続ける生成器でも無限ループしないよう、試行回数に上限を置いて採番する。
fn fresh_id(taken: &HashSet<String>, new_id: &mut impl FnMut() -> String) -> String {
    let mut candidate = new_id();
    let mut tries = 0;
    while taken.contains(&candidate) && tries < 16 {
        candidate = new_id();
        tries += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(id: &str, name: &str, scope: SnippetScope) -> Snippet {
        Snippet {
            id: id.into(),
            name: name.into(),
            folder: Some("reports".into()),
            tags: vec!["daily".into()],
            sql: "SELECT 1".into(),
            driver: Some("mysql".into()),
            scope,
        }
    }

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn counter() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("new{n:05}")
        }
    }

    #[test]
    fn export_then_import_roundtrips_folder_tags_and_scope() {
        let src = vec![
            snip("aaaaaaaa", "any", SnippetScope::Any),
            snip(
                "bbbbbbbb",
                "grp",
                SnippetScope::Group {
                    group: "prod".into(),
                },
            ),
            snip(
                "cccccccc",
                "prof",
                SnippetScope::Profile {
                    profile_id: "p1".into(),
                },
            ),
        ];
        let json = export_json(&src, "2026-01-01T00:00:00Z").unwrap();
        let (back, rejected) = parse_import(&json).unwrap();
        assert!(rejected.is_empty());
        assert_eq!(back.len(), 3);
        assert_eq!(back[0].folder.as_deref(), Some("reports"));
        assert_eq!(back[0].tags, vec!["daily".to_string()]);
        assert_eq!(back[1].scope, src[1].scope);
        assert_eq!(back[2].scope, src[2].scope);
    }

    #[test]
    fn parse_accepts_a_bare_array_and_missing_ids() {
        let json = r#"[{"name": "x", "sql": "SELECT 1"}]"#;
        let (v, rejected) = parse_import(json).unwrap();
        assert!(rejected.is_empty());
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "");
    }

    #[test]
    fn parse_rejects_bad_items_but_keeps_the_rest() {
        let json = r#"{"snippets": [
            {"id": "a", "name": "ok", "sql": "SELECT 1"},
            {"id": "b", "name": "  ", "sql": "SELECT 1"},
            {"id": "c", "name": "bad scope", "sql": "s", "scope": {"kind": "future"}},
            {"id": "d", "sql": "no name"}
        ]}"#;
        let (v, rejected) = parse_import(json).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(rejected.len(), 3);
        assert_eq!(rejected[0].index, 1);
        assert_eq!(rejected[1].name.as_deref(), Some("bad scope"));
    }

    #[test]
    fn parse_rejects_wrong_format_and_garbage() {
        assert!(parse_import(r#"{"format": "noobdb-profiles", "snippets": []}"#).is_err());
        assert!(parse_import("not json").is_err());
        assert!(parse_import(r#"{"other": 1}"#).is_err());
        assert!(parse_import("3").is_err());
    }

    #[test]
    fn parse_normalizes_like_save_snippet() {
        let json =
            r#"[{"name": " n ", "sql": "s", "folder": "  ", "tags": [" a ", ""], "driver": ""}]"#;
        let (v, _) = parse_import(json).unwrap();
        assert_eq!(v[0].name, "n");
        assert_eq!(v[0].folder, None);
        assert_eq!(v[0].tags, vec!["a".to_string()]);
        assert_eq!(v[0].driver, None);
    }

    #[test]
    fn rename_gives_colliding_ids_a_fresh_one() {
        let existing = vec![snip("aaaaaaaa", "old", SnippetScope::Any)];
        let incoming = vec![
            snip("aaaaaaaa", "new", SnippetScope::Any),
            snip("zzzzzzzz", "other", SnippetScope::Any),
        ];
        let (all, c) = plan_import(
            existing,
            incoming,
            ImportStrategy::Rename,
            &known(&[]),
            counter(),
        );
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].name, "old");
        assert_eq!(all[1].id, "new00001");
        assert_eq!(all[2].id, "zzzzzzzz");
        assert_eq!(
            (c.imported, c.skipped, c.overwritten, c.conflicts),
            (2, 0, 0, 1)
        );
    }

    #[test]
    fn skip_keeps_existing_on_collision() {
        let existing = vec![snip("aaaaaaaa", "old", SnippetScope::Any)];
        let incoming = vec![snip("aaaaaaaa", "new", SnippetScope::Any)];
        let (all, c) = plan_import(
            existing,
            incoming,
            ImportStrategy::Skip,
            &known(&[]),
            counter(),
        );
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "old");
        assert_eq!((c.imported, c.skipped, c.conflicts), (0, 1, 1));
    }

    #[test]
    fn overwrite_replaces_existing_in_place() {
        let existing = vec![
            snip("aaaaaaaa", "old", SnippetScope::Any),
            snip("bbbbbbbb", "keep", SnippetScope::Any),
        ];
        let incoming = vec![snip("aaaaaaaa", "new", SnippetScope::Any)];
        let (all, c) = plan_import(
            existing,
            incoming,
            ImportStrategy::Overwrite,
            &known(&[]),
            counter(),
        );
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "new");
        assert_eq!(all[1].name, "keep");
        assert_eq!((c.imported, c.overwritten, c.conflicts), (0, 1, 1));
    }

    #[test]
    fn duplicates_inside_the_file_collide_with_earlier_ones() {
        let incoming = vec![
            snip("aaaaaaaa", "first", SnippetScope::Any),
            snip("aaaaaaaa", "second", SnippetScope::Any),
        ];
        let (all, c) = plan_import(
            vec![],
            incoming,
            ImportStrategy::Rename,
            &known(&[]),
            counter(),
        );
        assert_eq!(all.len(), 2);
        assert_ne!(all[0].id, all[1].id);
        assert_eq!(c.conflicts, 1);
    }

    #[test]
    fn empty_id_is_assigned_and_is_not_a_conflict() {
        let (all, c) = plan_import(
            vec![],
            vec![snip("", "x", SnippetScope::Any)],
            ImportStrategy::Skip,
            &known(&[]),
            counter(),
        );
        assert_eq!(all[0].id, "new00001");
        assert_eq!((c.imported, c.conflicts), (1, 0));
    }

    #[test]
    fn unknown_profile_scope_becomes_any_but_known_and_group_stay() {
        let incoming = vec![
            snip(
                "a",
                "unknown",
                SnippetScope::Profile {
                    profile_id: "gone".into(),
                },
            ),
            snip(
                "b",
                "known",
                SnippetScope::Profile {
                    profile_id: "p1".into(),
                },
            ),
            snip(
                "c",
                "group",
                SnippetScope::Group {
                    group: "gone".into(),
                },
            ),
        ];
        let (all, c) = plan_import(
            vec![],
            incoming,
            ImportStrategy::Rename,
            &known(&["p1"]),
            counter(),
        );
        assert_eq!(all[0].scope, SnippetScope::Any);
        assert_eq!(
            all[1].scope,
            SnippetScope::Profile {
                profile_id: "p1".into()
            }
        );
        assert!(matches!(all[2].scope, SnippetScope::Group { .. }));
        assert_eq!(c.scope_reset, 1);
    }

    #[test]
    fn a_generator_that_keeps_colliding_still_terminates() {
        let existing = vec![snip("aaaaaaaa", "old", SnippetScope::Any)];
        let incoming = vec![snip("aaaaaaaa", "new", SnippetScope::Any)];
        let (all, _) = plan_import(
            existing,
            incoming,
            ImportStrategy::Rename,
            &known(&[]),
            || "aaaaaaaa".to_string(),
        );
        assert_eq!(all.len(), 2);
    }
}
