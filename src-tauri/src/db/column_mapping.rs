//! データ比較の列の対応付け (#2099)。
//!
//! 列名を変えた移行 (`user_name` → `username` など) の後で新旧のデータが一致しているかを確かめる
//! ため、ソース列 → ターゲット列の対応表を受け取り、列名を解決する純粋層。DB には触れない。
//!
//! 解決の優先順位は 明示の対応 > 同名の列。ドライバをまたぐ比較 (#1869) では、同名が無い列を
//! 大文字小文字を無視して 1 つに決まる列へ対応付ける ([`super::cross_compare::map_target_columns`])。
//! フロントの「同名の列は自動で対応付け、残りを手動で割り当てる」UI は、この解決で
//! 「ターゲットに相手がいない列」を [`unmatched_source_columns`] で数える。Rust と TS の判定を
//! 共有ゴールデン (`src/__tests__/fixtures/columnMappingVectors.json`) で固定する。

use std::collections::{BTreeMap, HashMap};

use super::cross_compare::map_target_columns;

/// ソース列名 → ターゲット列名。
pub type ColumnMapping = BTreeMap<String, String>;

/// IPC で受け取った対応表を整える。空のキー / 値と、同名への対応 (`a → a`、指定しないのと
/// 同じ) は落とす。列名は UI が実際の列一覧から選んだ値なので、前後の空白も含めてそのまま使う
/// (PostgreSQL / SQLite は `" name"` のような空白入りの引用識別子を持てる)。
pub fn clean_mapping(raw: Option<HashMap<String, String>>) -> ColumnMapping {
    raw.unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| (!k.is_empty() && !v.is_empty() && k != v).then_some((k, v)))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MappingError {
    /// 対応表のキーがソースの列に無い。
    UnknownSource(String),
    /// 対応先がターゲットの列に無い。
    UnknownTarget { source: String, target: String },
    /// 複数のソース列が同じターゲット列に対応する (取り違えて上書きし合うので拒否)。
    Duplicate {
        target: String,
        sources: Vec<String>,
    },
    /// クロスドライバの自動対応付けが 1 つに決まらない (大文字小文字だけ違う候補が複数)。
    Ambiguous {
        column: String,
        candidates: Vec<String>,
    },
}

/// 各ソース列が対応するターゲット列名 (`source` と同じ並び)。
///
/// - 明示の対応はターゲットの実際の綴りに直す (`target_eq` で照合。PostgreSQL は大小を区別)。
/// - 明示が無い列は同名。`fold_case` (クロスドライバ) のときは、同名が無い列だけ大文字小文字を
///   無視して 1 つに決まる列へ対応付ける。対応先が無い列はソースの名前のまま返す
///   (欠落は呼び出し側の検証が報告する)。
/// - 2 つ以上のソース列が同じターゲット列になる場合は [`MappingError::Duplicate`]。
pub fn resolve_target_columns(
    source: &[String],
    target: &[String],
    mapping: &ColumnMapping,
    target_eq: impl Fn(&str, &str) -> bool,
    fold_case: bool,
) -> Result<Vec<String>, MappingError> {
    if let Some(k) = mapping.keys().find(|k| !source.contains(k)) {
        return Err(MappingError::UnknownSource(k.clone()));
    }
    let mut out: Vec<Option<String>> = Vec::with_capacity(source.len());
    for name in source {
        match mapping.get(name) {
            None => out.push(None),
            Some(want) => match target.iter().find(|t| target_eq(t, want)) {
                Some(actual) => out.push(Some(actual.clone())),
                None => {
                    return Err(MappingError::UnknownTarget {
                        source: name.clone(),
                        target: want.clone(),
                    })
                }
            },
        }
    }
    if fold_case {
        let rest_src: Vec<String> = source
            .iter()
            .zip(&out)
            .filter(|(_, o)| o.is_none())
            .map(|(n, _)| n.clone())
            .collect();
        let rest_tgt: Vec<String> = target
            .iter()
            .filter(|t| !out.iter().flatten().any(|u| u == *t))
            .cloned()
            .collect();
        let auto = map_target_columns(&rest_src, &rest_tgt)
            .map_err(|(column, candidates)| MappingError::Ambiguous { column, candidates })?;
        let mut auto = auto.into_iter();
        for slot in out.iter_mut().filter(|o| o.is_none()) {
            *slot = auto.next();
        }
    }
    let resolved: Vec<String> = source
        .iter()
        .zip(out)
        .map(|(n, o)| o.unwrap_or_else(|| n.clone()))
        .collect();
    for (i, a) in resolved.iter().enumerate() {
        let same: Vec<String> = resolved
            .iter()
            .enumerate()
            .filter(|(j, b)| *j >= i && target_eq(a, b))
            .map(|(j, _)| source[j].clone())
            .collect();
        // i より前に同じものがあれば既に報告済み (先頭の 1 件だけで判定する)。
        let first = resolved.iter().position(|b| target_eq(a, b)).unwrap_or(i);
        if first == i && same.len() > 1 {
            return Err(MappingError::Duplicate {
                target: a.clone(),
                sources: same,
            });
        }
    }
    Ok(resolved)
}

/// 対応表に無く、ターゲットに同名の列も無いソース列 (UI が「手動で割り当てる」候補として出す)。
/// `case_insensitive` は同名の照合規則 (MySQL / SQLite とクロスドライバは true、PostgreSQL 同士は false)。
pub fn unmatched_source_columns(
    source: &[String],
    target: &[String],
    mapping: &ColumnMapping,
    case_insensitive: bool,
) -> Vec<String> {
    source
        .iter()
        .filter(|s| !mapping.contains_key(*s))
        .filter(|s| {
            !target.iter().any(|t| {
                if case_insensitive {
                    t.eq_ignore_ascii_case(s)
                } else {
                    t == *s
                }
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    fn m(pairs: &[(&str, &str)]) -> ColumnMapping {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }
    fn exact(a: &str, b: &str) -> bool {
        a == b
    }
    fn ci(a: &str, b: &str) -> bool {
        a.eq_ignore_ascii_case(b)
    }

    #[test]
    fn clean_mapping_drops_blank_and_identity_entries() {
        let raw: HashMap<String, String> = [("a", "b"), ("", "x"), ("c", ""), ("d", "d")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(clean_mapping(Some(raw)), m(&[("a", "b")]));
        assert!(clean_mapping(None).is_empty());
    }

    #[test]
    fn clean_mapping_keeps_surrounding_whitespace_of_identifiers() {
        // PostgreSQL / SQLite の引用識別子は前後に空白を持てる。削ると別の列名になり解決に失敗する。
        let raw: HashMap<String, String> = [(" name", "full_name "), (" x ", " x ")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(clean_mapping(Some(raw)), m(&[(" name", "full_name ")]));
    }

    #[test]
    fn explicit_mapping_wins_and_others_keep_their_names() {
        let r = resolve_target_columns(
            &v(&["id", "user_name", "email"]),
            &v(&["id", "username", "email"]),
            &m(&[("user_name", "username")]),
            exact,
            false,
        );
        assert_eq!(r, Ok(v(&["id", "username", "email"])));
    }

    /// 照合規則は 3 ドライバで違う (MySQL / SQLite は大小無視、PostgreSQL は区別)。
    #[test]
    fn target_matching_follows_each_drivers_column_rule() {
        use crate::db::{column_names_match, DriverKind};
        for (driver, ok) in [
            (DriverKind::Mysql, true),
            (DriverKind::Sqlite, true),
            (DriverKind::Postgres, false),
        ] {
            let r = resolve_target_columns(
                &v(&["n"]),
                &v(&["Name"]),
                &m(&[("n", "name")]),
                |a, b| column_names_match(driver, a, b),
                false,
            );
            if ok {
                assert_eq!(r, Ok(v(&["Name"])), "{driver:?}");
            } else {
                assert_eq!(
                    r,
                    Err(MappingError::UnknownTarget {
                        source: "n".into(),
                        target: "name".into()
                    }),
                    "{driver:?}"
                );
            }
        }
    }

    #[test]
    fn explicit_target_takes_the_actual_spelling() {
        let r = resolve_target_columns(
            &v(&["id", "n"]),
            &v(&["ID", "Name"]),
            &m(&[("n", "name")]),
            ci,
            false,
        );
        assert_eq!(r, Ok(v(&["id", "Name"])));
    }

    #[test]
    fn swapping_two_columns_is_allowed() {
        let r = resolve_target_columns(
            &v(&["a", "b"]),
            &v(&["a", "b"]),
            &m(&[("a", "b"), ("b", "a")]),
            exact,
            false,
        );
        assert_eq!(r, Ok(v(&["b", "a"])));
    }

    #[test]
    fn rejects_unknown_columns_and_collisions() {
        let t = v(&["id", "x", "y"]);
        assert_eq!(
            resolve_target_columns(&v(&["id"]), &t, &m(&[("nope", "x")]), exact, false),
            Err(MappingError::UnknownSource("nope".into()))
        );
        assert_eq!(
            resolve_target_columns(&v(&["id", "a"]), &t, &m(&[("a", "zz")]), exact, false),
            Err(MappingError::UnknownTarget {
                source: "a".into(),
                target: "zz".into()
            })
        );
        // 2 つのソース列が同じターゲット列へ。
        assert_eq!(
            resolve_target_columns(
                &v(&["id", "a", "b"]),
                &t,
                &m(&[("a", "x"), ("b", "x")]),
                exact,
                false
            ),
            Err(MappingError::Duplicate {
                target: "x".into(),
                sources: v(&["a", "b"])
            })
        );
        // 明示の対応先が、別のソース列の同名と衝突する。
        assert_eq!(
            resolve_target_columns(&v(&["id", "a", "x"]), &t, &m(&[("a", "x")]), exact, false),
            Err(MappingError::Duplicate {
                target: "x".into(),
                sources: v(&["a", "x"])
            })
        );
    }

    #[test]
    fn cross_driver_folds_case_only_for_unmapped_columns() {
        let r = resolve_target_columns(
            &v(&["Id", "user_name", "Email"]),
            &v(&["id", "username", "email"]),
            &m(&[("user_name", "username")]),
            exact,
            true,
        );
        assert_eq!(r, Ok(v(&["id", "username", "email"])));
        // 明示で使われたターゲットは自動対応の候補から外れる。
        let r = resolve_target_columns(
            &v(&["ID", "key"]),
            &v(&["id", "ID2"]),
            &m(&[("key", "id")]),
            exact,
            true,
        );
        assert_eq!(r, Ok(v(&["ID", "id"])));
    }

    #[test]
    fn unmatched_columns_follow_the_case_rule() {
        let s = v(&["id", "User_Name", "email"]);
        let t = v(&["ID", "username", "email"]);
        assert_eq!(
            unmatched_source_columns(&s, &t, &ColumnMapping::new(), true),
            v(&["User_Name"])
        );
        assert_eq!(
            unmatched_source_columns(&s, &t, &ColumnMapping::new(), false),
            v(&["id", "User_Name"])
        );
        assert_eq!(
            unmatched_source_columns(&s, &t, &m(&[("User_Name", "username")]), false),
            v(&["id"])
        );
    }

    /// フロント (`columnMapping.ts` の `unmatchedSourceColumns`) と同じ判定を共有ゴールデンで固定する。
    #[test]
    fn golden_vectors() {
        let g: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/__tests__/fixtures/columnMappingVectors.json"
        ))
        .expect("columnMappingVectors.json をパースできない");
        let strs = |x: &serde_json::Value| -> Vec<String> {
            x.as_array()
                .expect("配列であること")
                .iter()
                .map(|e| e.as_str().expect("文字列であること").to_string())
                .collect()
        };
        let cases = g["cases"].as_array().expect("cases は配列");
        assert!(!cases.is_empty());
        for c in cases {
            let mapping: ColumnMapping = c["mapping"]
                .as_object()
                .expect("mapping はオブジェクト")
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect();
            let got = unmatched_source_columns(
                &strs(&c["source"]),
                &strs(&c["target"]),
                &mapping,
                c["caseInsensitive"].as_bool().expect("bool"),
            );
            assert_eq!(got, strs(&c["unmatched"]), "{}", c["name"]);
        }
    }
}
