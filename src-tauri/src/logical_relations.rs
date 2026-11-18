//! 論理リレーション (仮想 FK, #2356)。外部キー制約を張らない運用の DB で、命名規約などで暗黙に
//! 表されている「子テーブル.列 → 親テーブル.列」をアプリ側にだけ登録し、FK ジャンプ・関連行・
//! ER 図・JOIN 補完で宣言済み FK と同じように使えるようにする。
//!
//! - **DB には一切書かない** (DDL・スキーマ同期・ダンプにも出ない)。保存先は非秘密の JSON ストア
//!   `logical_relations.json` (`json_store::JsonStore` = ストア規約の必須対策込み)。
//! - 接続先ごとに独立させるため (プロファイル ID, データベース) と組にして保存する
//!   (プロファイルを持たない一時接続は `profile_id = null`)。ドライバ非依存で、識別子は
//!   各ドライバが返すテーブル名・列名のまま持つ (MySQL / PostgreSQL / SQLite 共通)。
//! - 秘密情報・行データは含まない。

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::json_store::JsonStore;

/// 登録 / 削除の入力 1 件。複合キーは `columns` と `referenced_columns` を同じ順で並べる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogicalRelationInput {
    /// 子テーブル (参照する側)。
    pub table: String,
    pub columns: Vec<String>,
    /// 親テーブル (参照される側)。
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

/// 保存済みの論理リレーション 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogicalRelation {
    #[serde(default)]
    pub profile_id: Option<String>,
    pub database: String,
    pub table: String,
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    /// 登録した時刻 (UTC, RFC 3339)。
    pub created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RelationFile {
    #[serde(default)]
    relations: Vec<LogicalRelation>,
}

static STORE: JsonStore = JsonStore::new("logical_relations.json");

fn matches(e: &LogicalRelation, profile_id: Option<&str>, database: &str) -> bool {
    e.profile_id.as_deref() == profile_id && e.database == database
}

fn same_relation(e: &LogicalRelation, input: &LogicalRelationInput) -> bool {
    e.table == input.table
        && e.columns == input.columns
        && e.referenced_table == input.referenced_table
        && e.referenced_columns == input.referenced_columns
}

/// 入力の形を検査する (空の名前・列数の不一致・重複列は `InvalidInput`)。DB に存在するかは
/// 確かめない (テーブル / 列が後から消えても、一覧で見えて削除できるようにするため)。
pub fn validate(input: &LogicalRelationInput) -> Result<()> {
    let bad = |m: &str| Err(AppError::InvalidInput(m.to_string()));
    if input.table.trim().is_empty() || input.referenced_table.trim().is_empty() {
        return bad("logical relation: table name is empty");
    }
    if input.columns.is_empty() || input.columns.len() != input.referenced_columns.len() {
        return bad("logical relation: columns and referenced columns must be non-empty and the same length");
    }
    if input
        .columns
        .iter()
        .chain(&input.referenced_columns)
        .any(|c| c.trim().is_empty())
    {
        return bad("logical relation: column name is empty");
    }
    let mut seen = std::collections::HashSet::new();
    if !input.columns.iter().all(|c| seen.insert(c)) {
        return bad("logical relation: duplicate column");
    }
    Ok(())
}

fn list_from(
    file: &RelationFile,
    profile_id: Option<&str>,
    database: &str,
) -> Vec<LogicalRelation> {
    file.relations
        .iter()
        .filter(|e| matches(e, profile_id, database))
        .cloned()
        .collect()
}

fn add_to(
    file: &mut RelationFile,
    profile_id: Option<&str>,
    database: &str,
    input: &LogicalRelationInput,
    now: &str,
) {
    if file
        .relations
        .iter()
        .any(|e| matches(e, profile_id, database) && same_relation(e, input))
    {
        return;
    }
    file.relations.push(LogicalRelation {
        profile_id: profile_id.map(str::to_string),
        database: database.to_string(),
        table: input.table.clone(),
        columns: input.columns.clone(),
        referenced_table: input.referenced_table.clone(),
        referenced_columns: input.referenced_columns.clone(),
        created_at: now.to_string(),
    });
}

fn remove_from(
    file: &mut RelationFile,
    profile_id: Option<&str>,
    database: &str,
    input: &LogicalRelationInput,
) {
    file.relations
        .retain(|e| !(matches(e, profile_id, database) && same_relation(e, input)));
}

/// この接続先の論理リレーション (登録順)。
pub fn list(profile_id: Option<&str>, database: &str) -> Result<Vec<LogicalRelation>> {
    let file: RelationFile = STORE.read()?;
    Ok(list_from(&file, profile_id, database))
}

/// 論理リレーションを登録する (すでにあるものは無視)。全件を検査してから書くので、
/// 1 件でも不正なら何も保存しない。登録後のこの接続先の一覧を返す。
pub fn add_all(
    profile_id: Option<&str>,
    database: &str,
    inputs: &[LogicalRelationInput],
) -> Result<Vec<LogicalRelation>> {
    for i in inputs {
        validate(i)?;
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    STORE.update::<RelationFile, _>(|f| {
        for i in inputs {
            add_to(f, profile_id, database, i, &now);
        }
        list_from(f, profile_id, database)
    })
}

/// 論理リレーションを削除する。削除後のこの接続先の一覧を返す。
pub fn remove(
    profile_id: Option<&str>,
    database: &str,
    input: &LogicalRelationInput,
) -> Result<Vec<LogicalRelation>> {
    STORE.update::<RelationFile, _>(|f| {
        remove_from(f, profile_id, database, input);
        list_from(f, profile_id, database)
    })
}

/// プロファイル削除時に、そのプロファイルの論理リレーションをすべて消す (全データベース分)。
/// 削除した件数を返す。
pub fn delete_profile_data(profile_id: &str) -> Result<u64> {
    // 該当が無ければ書き込まない (先に読んで確認する)。
    let file: RelationFile = STORE.read()?;
    if !file
        .relations
        .iter()
        .any(|e| e.profile_id.as_deref() == Some(profile_id))
    {
        return Ok(0);
    }
    STORE.update::<RelationFile, _>(|f| purge_profile(f, profile_id))
}

/// 保存済みのプロファイル ID (起動時の孤立データ掃除用)。プロファイルを持たない一時接続は含まない。
pub fn profile_ids() -> Result<Vec<String>> {
    let file: RelationFile = STORE.read()?;
    Ok(distinct_ids(
        file.relations
            .iter()
            .filter_map(|e| e.profile_id.as_deref()),
    ))
}

/// 書き出しファイルの形式バージョン。
pub const EXPORT_VERSION: u32 = 1;
/// 取り込みファイルの最大件数 (これを超えるファイルは壊れているか別物とみなして拒否する)。
pub const MAX_IMPORT_RELATIONS: usize = 5_000;
/// 取り込みファイルの最大バイト数 (ファイル読み込み側の上限とは別に、パース前に再確認する)。
pub const MAX_IMPORT_BYTES: usize = 4 * 1024 * 1024;

/// 取り込みファイルのうち、形が不正で読み飛ばした要素 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogicalRelationRejection {
    /// ファイル内の要素の位置 (0 始まり)。
    pub index: usize,
    pub error: String,
}

/// `parse_import` の結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogicalRelationsImportParse {
    /// 読めた論理リレーション (ファイル内の重複は除いてある)。
    pub relations: Vec<LogicalRelationInput>,
    /// 形が不正で読み飛ばした要素。
    pub rejected: Vec<LogicalRelationRejection>,
    /// ファイル内で同じ関係が複数回出てきたために除いた件数。
    pub duplicate_in_file_count: usize,
}

/// この接続先の論理リレーションを書き出し用の JSON にする。`profile_id`・データベース名・
/// 登録時刻・接続情報は含めない (別の接続へ持ち出せる、関係の定義だけ)。
pub fn export_json(relations: &[LogicalRelation]) -> Result<String> {
    let items: Vec<LogicalRelationInput> = relations
        .iter()
        .map(|r| LogicalRelationInput {
            table: r.table.clone(),
            columns: r.columns.clone(),
            referenced_table: r.referenced_table.clone(),
            referenced_columns: r.referenced_columns.clone(),
        })
        .collect();
    let value = serde_json::json!({ "version": EXPORT_VERSION, "relations": items });
    Ok(serde_json::to_string_pretty(&value)?)
}

/// 書き出しファイルを寛容に読む (#2423)。壊れた JSON・サイズ / 件数の超過は `InvalidInput`。
/// トップレベルが `{ relations: [...] }` でも配列そのものでもよく、`version` は参照しない
/// (将来の版が項目を足しても読めるようにする)。解釈できない要素は読み飛ばして `rejected` に出す。
/// DB のスキーマとの照合はしない (フロントが接続先のスキーマと突き合わせる)。
pub fn parse_import(json: &str) -> Result<LogicalRelationsImportParse> {
    if json.len() > MAX_IMPORT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "logical relations file is too large ({} bytes, limit {} bytes)",
            json.len(),
            MAX_IMPORT_BYTES
        )));
    }
    let value: serde_json::Value = serde_json::from_str(json.trim_start_matches('\u{feff}'))
        .map_err(|e| AppError::InvalidInput(format!("not a valid JSON file: {e}")))?;
    let items = match &value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => match o.get("relations") {
            Some(serde_json::Value::Array(a)) => a,
            _ => {
                return Err(AppError::InvalidInput(
                    "logical relations file has no \"relations\" array".to_string(),
                ))
            }
        },
        _ => {
            return Err(AppError::InvalidInput(
                "logical relations file has no \"relations\" array".to_string(),
            ))
        }
    };
    if items.len() > MAX_IMPORT_RELATIONS {
        return Err(AppError::InvalidInput(format!(
            "logical relations file has too many relations ({}, limit {})",
            items.len(),
            MAX_IMPORT_RELATIONS
        )));
    }
    let mut relations: Vec<LogicalRelationInput> = Vec::new();
    let mut rejected = Vec::new();
    let mut duplicate_in_file_count = 0;
    for (index, item) in items.iter().enumerate() {
        let parsed = serde_json::from_value::<LogicalRelationInput>(item.clone())
            .map_err(|e| e.to_string())
            .and_then(|i| match validate(&i) {
                Ok(()) => Ok(i),
                Err(e) => Err(e.to_string()),
            });
        match parsed {
            Ok(i) => {
                if relations.contains(&i) {
                    duplicate_in_file_count += 1;
                } else {
                    relations.push(i);
                }
            }
            Err(error) => rejected.push(LogicalRelationRejection { index, error }),
        }
    }
    Ok(LogicalRelationsImportParse {
        relations,
        rejected,
        duplicate_in_file_count,
    })
}

/// この接続先の論理リレーションを `inputs` で置き換える (取り込みの「上書き」)。全件を検査してから
/// 書くので、1 件でも不正なら何も変えない。置き換え後の一覧を返す。
pub fn replace_all(
    profile_id: Option<&str>,
    database: &str,
    inputs: &[LogicalRelationInput],
) -> Result<Vec<LogicalRelation>> {
    for i in inputs {
        validate(i)?;
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    STORE.update::<RelationFile, _>(|f| {
        replace_in(f, profile_id, database, inputs, &now);
        list_from(f, profile_id, database)
    })
}

fn replace_in(
    file: &mut RelationFile,
    profile_id: Option<&str>,
    database: &str,
    inputs: &[LogicalRelationInput],
    now: &str,
) {
    // 既に同じ関係があるものは登録時刻を保つ (消して作り直さない)。
    let keep: Vec<LogicalRelation> = file
        .relations
        .iter()
        .filter(|e| matches(e, profile_id, database) && inputs.iter().any(|i| same_relation(e, i)))
        .cloned()
        .collect();
    file.relations.retain(|e| !matches(e, profile_id, database));
    file.relations.extend(keep);
    for i in inputs {
        add_to(file, profile_id, database, i, now);
    }
}

fn purge_profile(file: &mut RelationFile, profile_id: &str) -> u64 {
    let before = file.relations.len();
    file.relations
        .retain(|e| e.profile_id.as_deref() != Some(profile_id));
    (before - file.relations.len()) as u64
}

fn distinct_ids<'a>(ids: impl Iterator<Item = &'a str>) -> Vec<String> {
    let set: std::collections::BTreeSet<&str> = ids.collect();
    set.into_iter().map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(table: &str, cols: &[&str], rt: &str, rcols: &[&str]) -> LogicalRelationInput {
        LogicalRelationInput {
            table: table.into(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            referenced_table: rt.into(),
            referenced_columns: rcols.iter().map(|c| c.to_string()).collect(),
        }
    }

    #[test]
    fn add_is_idempotent_and_scoped_per_connection() {
        let mut file = RelationFile::default();
        let r = input("orders", &["user_id"], "users", &["id"]);
        add_to(&mut file, Some("p1"), "app", &r, "t");
        add_to(&mut file, Some("p1"), "app", &r, "t2");
        add_to(&mut file, Some("p2"), "app", &r, "t");
        add_to(&mut file, Some("p1"), "other", &r, "t");
        add_to(&mut file, None, "app", &r, "t");
        assert_eq!(file.relations.len(), 4);
        assert_eq!(file.relations[0].created_at, "t", "二重登録は無視する");
        assert_eq!(list_from(&file, Some("p1"), "app").len(), 1);

        remove_from(&mut file, Some("p1"), "app", &r);
        assert_eq!(file.relations.len(), 3);
        assert!(list_from(&file, Some("p1"), "app").is_empty());
    }

    #[test]
    fn composite_keys_are_distinct_from_single_column_relations() {
        let mut file = RelationFile::default();
        add_to(&mut file, None, "d", &input("c", &["a"], "p", &["a"]), "t");
        add_to(
            &mut file,
            None,
            "d",
            &input("c", &["a", "b"], "p", &["a", "b"]),
            "t",
        );
        assert_eq!(file.relations.len(), 2);
    }

    #[test]
    fn validate_rejects_malformed_input() {
        assert!(validate(&input("o", &["u"], "users", &["id"])).is_ok());
        assert!(validate(&input("", &["u"], "users", &["id"])).is_err());
        assert!(validate(&input("o", &["u"], " ", &["id"])).is_err());
        assert!(validate(&input("o", &[], "users", &[])).is_err());
        assert!(validate(&input("o", &["a", "b"], "users", &["id"])).is_err());
        assert!(validate(&input("o", &["a", ""], "users", &["x", "y"])).is_err());
        assert!(validate(&input("o", &["a", "a"], "users", &["x", "y"])).is_err());
    }

    #[test]
    fn file_roundtrips_and_tolerates_missing_fields() {
        let json = r#"{"relations":[{"database":"d","table":"o","columns":["u"],
            "referenced_table":"users","referenced_columns":["id"],"created_at":"t"}]}"#;
        let file: RelationFile = serde_json::from_str(json).unwrap();
        assert_eq!(file.relations[0].profile_id, None);
        let again: RelationFile =
            serde_json::from_str(&serde_json::to_string(&file).unwrap()).unwrap();
        assert_eq!(again.relations, file.relations);
    }

    #[test]
    fn purge_profile_removes_only_that_profile_across_databases() {
        let mut f = RelationFile::default();
        let i = input("orders", &["user_id"], "users", &["id"]);
        add_to(&mut f, Some("p"), "db1", &i, "t");
        add_to(&mut f, Some("p"), "db2", &i, "t");
        add_to(&mut f, Some("q"), "db1", &i, "t");
        add_to(&mut f, None, "db1", &i, "t");
        assert_eq!(purge_profile(&mut f, "p"), 2);
        assert!(list_from(&f, Some("p"), "db1").is_empty());
        assert!(list_from(&f, Some("p"), "db2").is_empty());
        assert_eq!(list_from(&f, Some("q"), "db1").len(), 1);
        assert_eq!(list_from(&f, None, "db1").len(), 1);
        assert_eq!(purge_profile(&mut f, "p"), 0);
    }

    #[test]
    fn distinct_ids_dedupes_and_sorts() {
        assert_eq!(distinct_ids(["b", "a", "b"].into_iter()), vec!["a", "b"]);
    }

    #[test]
    fn export_has_no_profile_or_timestamp() {
        let rel = LogicalRelation {
            profile_id: Some("secret-profile".into()),
            database: "app".into(),
            table: "orders".into(),
            columns: vec!["user_id".into()],
            referenced_table: "users".into(),
            referenced_columns: vec!["id".into()],
            created_at: "2026-01-01T00:00:00Z".into(),
        };
        let json = export_json(&[rel]).unwrap();
        assert!(!json.contains("secret-profile"));
        assert!(!json.contains("profile_id"));
        assert!(!json.contains("created_at"));
        assert!(!json.contains("\"database\""));
        let back = parse_import(&json).unwrap();
        assert_eq!(back.relations.len(), 1);
        assert!(back.rejected.is_empty());
    }

    #[test]
    fn parse_import_is_tolerant_per_element() {
        let json = r#"{"version": 99, "future": 1, "relations": [
            {"table":"a","columns":["x"],"referenced_table":"b","referenced_columns":["id"],"extra":true},
            {"table":"a","columns":["x"],"referenced_table":"b","referenced_columns":["id"]},
            {"table":"a","columns":["x","y"],"referenced_table":"b","referenced_columns":["id"]},
            {"table":"a"},
            42
        ]}"#;
        let p = parse_import(json).unwrap();
        assert_eq!(p.relations.len(), 1);
        assert_eq!(p.duplicate_in_file_count, 1);
        assert_eq!(
            p.rejected.iter().map(|r| r.index).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
    }

    #[test]
    fn parse_import_accepts_bare_array_and_bom() {
        let json = "\u{feff}[{\"table\":\"a\",\"columns\":[\"x\"],\"referenced_table\":\"b\",\"referenced_columns\":[\"id\"]}]";
        assert_eq!(parse_import(json).unwrap().relations.len(), 1);
    }

    #[test]
    fn parse_import_rejects_broken_or_oversized_input() {
        assert!(parse_import("{ not json").is_err());
        assert!(parse_import("{\"relations\": 3}").is_err());
        assert!(parse_import("\"str\"").is_err());
        let many = format!(
            "[{}]",
            vec![r#"{"table":"a","columns":["x"],"referenced_table":"b","referenced_columns":["id"]}"#; MAX_IMPORT_RELATIONS + 1]
                .join(",")
        );
        assert!(parse_import(&many).is_err());
        let big = " ".repeat(MAX_IMPORT_BYTES + 1);
        assert!(parse_import(&big).is_err());
    }

    #[test]
    fn replace_swaps_only_this_connection_and_keeps_timestamps() {
        let mut file = RelationFile::default();
        let keep = input("orders", &["user_id"], "users", &["id"]);
        let drop = input("items", &["order_id"], "orders", &["id"]);
        add_to(&mut file, Some("p1"), "app", &keep, "old");
        add_to(&mut file, Some("p1"), "app", &drop, "old");
        add_to(&mut file, Some("p2"), "app", &drop, "other");
        let fresh = input("a", &["x"], "b", &["id"]);
        replace_in(
            &mut file,
            Some("p1"),
            "app",
            &[keep.clone(), fresh.clone()],
            "new",
        );
        let mine = list_from(&file, Some("p1"), "app");
        assert_eq!(mine.len(), 2);
        assert!(mine
            .iter()
            .any(|e| same_relation(e, &keep) && e.created_at == "old"));
        assert!(mine
            .iter()
            .any(|e| same_relation(e, &fresh) && e.created_at == "new"));
        assert!(!mine.iter().any(|e| same_relation(e, &drop)));
        assert_eq!(list_from(&file, Some("p2"), "app").len(), 1);
    }
}
