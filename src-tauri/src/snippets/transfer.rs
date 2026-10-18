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
/// 取り込む JSON の最大バイト数。`read_text_file` の上限 (8MB) に揃え、フロントが読めない
/// 大きさのファイルを IPC 経由で渡されても拒否する (手違いで巨大なファイルを取り込まない)。
pub const MAX_IMPORT_BYTES: usize = 8 * 1024 * 1024;
/// 取り込む ID の最大文字数。これを超える ID は採番し直す。
const MAX_ID_LEN: usize = 64;

/// 既存と ID が衝突した要素 1 件 (#1490)。プレビューの「上書きで置き換わる先」の表示用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnippetConflict {
    pub id: String,
    pub existing_name: String,
    pub incoming_name: String,
}

/// 取り込みの集計。プレビュー (書き込まない) と本番で同じ意味。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportCounts {
    /// 新規に追加した件数 (衝突して採番し直したものを含む)。
    pub imported: u32,
    /// 衝突してスキップした件数。
    pub skipped: u32,
    /// 衝突して既存を上書きした件数。
    pub overwritten: u32,
    /// 既存のスニペットと ID が衝突した件数 (戦略に関わらず数える。プレビュー用)。
    pub conflicts: u32,
    /// ファイルの中で、先に出てきた要素と ID が重複した件数 (既存との衝突とは別に数える)。
    pub duplicates_in_file: u32,
    /// 取り込み先に存在しないプロファイルを指していたため、全接続スコープへ戻した件数。
    pub scope_reset: u32,
    /// 既存と ID が衝突した要素の一覧 (件数 `conflicts` と同じ処理から出す)。
    pub conflict_list: Vec<SnippetConflict>,
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
        // 知らないドライバ名は「ドライバ指定なし」にする (どの接続にも出ない孤立を避ける)。
        s.driver = s
            .driver
            .filter(|d| crate::commands::profiles::is_known_driver(d));
        // 空・長すぎる・制御文字入りの ID は採番し直す (空 ID は取り込み時に採番される)。
        if s.id.len() > MAX_ID_LEN || s.id.chars().any(char::is_control) {
            s.id = String::new();
        }
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
    // 衝突一覧に載せる「既存側の名前」。上書きで差し替わる前の名前を保つ。
    let existing_names: std::collections::HashMap<String, String> = existing
        .iter()
        .map(|e| (e.id.clone(), e.name.clone()))
        .collect();
    for mut s in incoming {
        let collides = !s.id.is_empty() && taken.contains(&s.id);
        if collides {
            // 既存との衝突と、ファイル内の先行要素との重複は別々に数える。
            if let Some(existing_name) = existing_names.get(&s.id) {
                counts.conflicts += 1;
                counts.conflict_list.push(SnippetConflict {
                    id: s.id.clone(),
                    existing_name: existing_name.clone(),
                    incoming_name: s.name.clone(),
                });
            } else {
                counts.duplicates_in_file += 1;
            }
            match strategy {
                ImportStrategy::Skip => {
                    counts.skipped += 1;
                    continue;
                }
                ImportStrategy::Overwrite => {
                    reset_unknown_scope(&mut s, known_profile_ids, &mut counts);
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
        // スコープの付け替えは、実際に取り込む要素だけを数える (スキップ分は数えない)。
        reset_unknown_scope(&mut s, known_profile_ids, &mut counts);
        taken.insert(s.id.clone());
        existing.push(s);
        counts.imported += 1;
    }
    (existing, counts)
}

/// 取り込み先に無いプロファイルを指すスコープを全接続 (`Any`) へ戻す。
fn reset_unknown_scope(
    s: &mut Snippet,
    known_profile_ids: &HashSet<String>,
    counts: &mut ImportCounts,
) {
    if let SnippetScope::Profile { profile_id } = &s.scope {
        if !known_profile_ids.contains(profile_id) {
            s.scope = SnippetScope::Any;
            counts.scope_reset += 1;
        }
    }
}

/// 採番する。生成器が 16 回続けて衝突したら、最後の候補に連番の接尾辞を付けて
/// 一意になるまで回す (必ず終わり、必ず一意)。
fn fresh_id(taken: &HashSet<String>, new_id: &mut impl FnMut() -> String) -> String {
    let mut candidate = new_id();
    for _ in 0..16 {
        if !taken.contains(&candidate) {
            return candidate;
        }
        candidate = new_id();
    }
    if !taken.contains(&candidate) {
        return candidate;
    }
    let base = candidate;
    let mut n: u64 = 2;
    loop {
        let next = format!("{base}-{n}");
        if !taken.contains(&next) {
            return next;
        }
        n += 1;
    }
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
        assert_eq!((c.conflicts, c.duplicates_in_file), (0, 1));
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
    fn a_generator_that_keeps_colliding_still_yields_unique_ids() {
        let existing = vec![snip("aaaaaaaa", "old", SnippetScope::Any)];
        let incoming = vec![
            snip("aaaaaaaa", "new", SnippetScope::Any),
            snip("aaaaaaaa", "new2", SnippetScope::Any),
        ];
        let (all, _) = plan_import(
            existing,
            incoming,
            ImportStrategy::Rename,
            &known(&[]),
            || "aaaaaaaa".to_string(),
        );
        let ids: HashSet<&str> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(all.len(), 3);
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn duplicates_inside_the_file_are_counted_apart_from_existing_conflicts() {
        let existing = vec![snip("aaaaaaaa", "old", SnippetScope::Any)];
        let incoming = vec![
            snip("aaaaaaaa", "hits existing", SnippetScope::Any),
            snip("bbbbbbbb", "first", SnippetScope::Any),
            snip("bbbbbbbb", "dup in file", SnippetScope::Any),
        ];
        let (_, c) = plan_import(
            existing,
            incoming,
            ImportStrategy::Skip,
            &known(&[]),
            counter(),
        );
        assert_eq!((c.conflicts, c.duplicates_in_file), (1, 1));
        assert_eq!((c.imported, c.skipped), (1, 2));
    }

    #[test]
    fn scope_reset_counts_only_snippets_that_are_actually_imported() {
        let existing = vec![snip("aaaaaaaa", "old", SnippetScope::Any)];
        let gone = SnippetScope::Profile {
            profile_id: "gone".into(),
        };
        let incoming = vec![
            snip("aaaaaaaa", "skipped", gone.clone()),
            snip("bbbbbbbb", "kept", gone),
        ];
        let (_, c) = plan_import(
            existing,
            incoming,
            ImportStrategy::Skip,
            &known(&[]),
            counter(),
        );
        assert_eq!((c.skipped, c.imported, c.scope_reset), (1, 1, 1));
    }

    #[test]
    fn parse_drops_unknown_drivers_and_reassigns_bad_ids() {
        let long = "x".repeat(MAX_ID_LEN + 1);
        let json = format!(
            r#"[
            {{"id": "ok", "name": "a", "sql": "s", "driver": "oracle"}},
            {{"id": "ok2", "name": "b", "sql": "s", "driver": "postgres"}},
            {{"id": "{long}", "name": "c", "sql": "s"}},
            {{"id": "bad\u0007id", "name": "d", "sql": "s"}}
        ]"#
        );
        let (v, rejected) = parse_import(&json).unwrap();
        assert!(rejected.is_empty());
        assert_eq!(v[0].driver, None);
        assert_eq!(v[1].driver.as_deref(), Some("postgres"));
        assert_eq!(v[0].id, "ok");
        assert_eq!(v[2].id, "");
        assert_eq!(v[3].id, "");
    }

    #[test]
    fn oversized_import_is_rejected_at_the_read_text_file_limit() {
        let big = " ".repeat(MAX_IMPORT_BYTES + 1);
        assert!(parse_import(&big).is_err());
        assert_eq!(MAX_IMPORT_BYTES, 8 * 1024 * 1024);
    }

    #[test]
    fn preview_scope_reset_matches_each_strategy_for_colliding_unknown_scope() {
        let gone = SnippetScope::Profile {
            profile_id: "gone".into(),
        };
        let run = |strategy| {
            plan_import(
                vec![snip("aaaaaaaa", "old", SnippetScope::Any)],
                vec![snip("aaaaaaaa", "new", gone.clone())],
                strategy,
                &known(&[]),
                counter(),
            )
            .1
        };
        // 衝突しても取り込まれる Rename / Overwrite では数え、Skip では数えない。
        assert_eq!(run(ImportStrategy::Rename).scope_reset, 1);
        assert_eq!(run(ImportStrategy::Overwrite).scope_reset, 1);
        assert_eq!(run(ImportStrategy::Skip).scope_reset, 0);
        let c = run(ImportStrategy::Skip);
        assert_eq!(c.conflict_list.len(), 1);
        assert_eq!(c.conflict_list[0].existing_name, "old");
        assert_eq!(c.conflict_list[0].incoming_name, "new");
    }
}
