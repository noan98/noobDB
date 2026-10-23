use std::path::{Path, PathBuf};
use std::sync::Mutex;

use directories::ProjectDirs;

use super::ImportTemplate;
use crate::error::{AppError, Result};

/// 保持するテンプレート数の上限。超えたら更新が古いものから捨てる。
pub const MAX_TEMPLATES: usize = 500;
/// 1 テンプレートに載せるマッピング列数の上限。
pub const MAX_MAPPING_COLUMNS: usize = 1000;
/// 文字列フィールド 1 つの長さの上限 (文字数)。
const MAX_FIELD_CHARS: usize = 512;

/// `import_templates.json` の read-modify-write を直列化するロック (`snippets::store` と
/// 同じ理由・同じ設計)。poisoning は `into_inner` で回復する。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> Result<crate::store_lock::StoreGuard<'static>> {
    crate::store_lock::acquire(&STORE_LOCK, &store_path()?)
}

fn store_path() -> Result<PathBuf> {
    let dir = ProjectDirs::from("", "", "noobDB")
        .map(|p| p.data_dir().to_path_buf())
        .ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("import_templates.json"))
}

const KEY: &str = "templates";

fn load_at(path: &Path) -> Result<Vec<ImportTemplate>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    if crate::json_tolerant::quarantine_if_unexpected_shape(path, &content, KEY)? {
        return Ok(Vec::new());
    }
    Ok(crate::json_tolerant::parse_items::<ImportTemplate>(&content, KEY)?.0)
}

fn save_at(path: &Path, items: &[ImportTemplate]) -> Result<()> {
    // 解釈できなかった既存要素 (将来の版が足したものなど) は消さずに書き戻す。
    let ids: Vec<&str> = items.iter().map(|t| t.id.as_str()).collect();
    let raw = std::fs::read_to_string(path)
        .map(|c| crate::json_tolerant::unparsable_raw::<ImportTemplate>(&c, KEY, &ids))
        .unwrap_or_default();
    let value = crate::json_tolerant::build_with_raw(KEY, items, raw)?;
    let content = serde_json::to_string_pretty(&value)?;
    crate::atomic_write::write_atomic(path, content.as_bytes())?;
    Ok(())
}

fn clamp_field(s: &str) -> String {
    s.chars().take(MAX_FIELD_CHARS).collect()
}

/// 保存前の入力検証と正規化。ID の計算、文字列の長さ制限、空のテーブル名の拒否。
pub fn sanitize(mut t: ImportTemplate, now_ms: i64) -> Result<ImportTemplate> {
    if t.profile_id.trim().is_empty() {
        return Err(AppError::InvalidInput("profile id is empty".into()));
    }
    if t.table.trim().is_empty() {
        return Err(AppError::InvalidInput("table name is empty".into()));
    }
    if t.mapping.is_empty() {
        return Err(AppError::InvalidInput("mapping is empty".into()));
    }
    if t.mapping.len() > MAX_MAPPING_COLUMNS {
        return Err(AppError::InvalidInput("too many mapped columns".into()));
    }
    t.database = t.database.filter(|d| !d.is_empty());
    t.id = ImportTemplate::key_for(&t.profile_id, t.database.as_deref(), &t.table);
    t.format = clamp_field(&t.format);
    t.delimiter = clamp_field(&t.delimiter);
    t.quote = clamp_field(&t.quote);
    t.encoding = clamp_field(&t.encoding);
    t.null_token = t.null_token.map(|s| clamp_field(&s));
    t.sheet = t.sheet.map(|s| clamp_field(&s));
    t.key_columns = t.key_columns.iter().map(|s| clamp_field(s)).collect();
    for m in &mut t.mapping {
        m.column = clamp_field(&m.column);
        m.header = m.header.take().map(|h| clamp_field(&h));
    }
    t.updated_at_ms = now_ms;
    Ok(t)
}

/// 同じキーのテンプレートを置き換えて追加し、上限を超えたら古いものから捨てる。
fn upsert_into(all: &mut Vec<ImportTemplate>, t: ImportTemplate) {
    all.retain(|x| x.id != t.id);
    all.push(t);
    if all.len() > MAX_TEMPLATES {
        all.sort_by_key(|x| std::cmp::Reverse(x.updated_at_ms));
        all.truncate(MAX_TEMPLATES);
    }
}

/// `profile_id` の接続で `database` (指定時) / `table` (指定時) に合うテンプレート。
/// `table` が `None` ならそのデータベースの全テンプレート。
fn filter(
    all: Vec<ImportTemplate>,
    profile_id: &str,
    database: Option<&str>,
    table: Option<&str>,
) -> Vec<ImportTemplate> {
    let db = database.filter(|d| !d.is_empty());
    all.into_iter()
        .filter(|t| t.profile_id == profile_id)
        .filter(|t| t.database.as_deref() == db)
        .filter(|t| table.map_or(true, |tb| t.table == tb))
        .collect()
}

pub fn list(
    profile_id: &str,
    database: Option<&str>,
    table: Option<&str>,
) -> Result<Vec<ImportTemplate>> {
    let _guard = lock_store()?;
    Ok(filter(
        load_at(&store_path()?)?,
        profile_id,
        database,
        table,
    ))
}

pub fn save(t: ImportTemplate, now_ms: i64) -> Result<ImportTemplate> {
    let t = sanitize(t, now_ms)?;
    let _guard = lock_store()?;
    let path = store_path()?;
    let mut all = load_at(&path)?;
    upsert_into(&mut all, t.clone());
    save_at(&path, &all)?;
    Ok(t)
}

pub fn delete(id: &str) -> Result<()> {
    let _guard = lock_store()?;
    let path = store_path()?;
    let mut all = load_at(&path)?;
    let before = all.len();
    all.retain(|t| t.id != id);
    if all.len() != before {
        save_at(&path, &all)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::TemplateColumn;
    use super::*;

    fn tpl(profile: &str, db: Option<&str>, table: &str) -> ImportTemplate {
        ImportTemplate {
            id: String::new(),
            profile_id: profile.into(),
            database: db.map(str::to_string),
            table: table.into(),
            format: "csv".into(),
            delimiter: ",".into(),
            quote: "\"".into(),
            has_header: true,
            null_token: Some("".into()),
            encoding: "utf-8".into(),
            sheet: None,
            conflict_mode: None,
            error_mode: None,
            key_columns: vec![],
            mapping: vec![TemplateColumn {
                column: "id".into(),
                header: Some("ID".into()),
                csv_index: 0,
            }],
            updated_at_ms: 0,
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_import_templates_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("mkdir");
        p.join("import_templates.json")
    }

    #[test]
    fn sanitize_computes_a_stable_key_and_rejects_empty_input() {
        let t = sanitize(tpl("p1", Some("shop"), "orders"), 5).expect("ok");
        assert_eq!(t.id, ImportTemplate::key_for("p1", Some("shop"), "orders"));
        assert_eq!(t.updated_at_ms, 5);
        assert!(sanitize(tpl("", None, "t"), 0).is_err());
        assert!(sanitize(tpl("p", None, " "), 0).is_err());
        let mut empty = tpl("p", None, "t");
        empty.mapping.clear();
        assert!(sanitize(empty, 0).is_err());
        // 空文字の database は None と同じキーになる。
        let a = sanitize(tpl("p", Some(""), "t"), 0).expect("ok");
        let b = sanitize(tpl("p", None, "t"), 0).expect("ok");
        assert_eq!(a.id, b.id);
    }

    #[test]
    fn upsert_replaces_the_same_table_and_evicts_the_oldest_past_the_cap() {
        let mut all = Vec::new();
        upsert_into(&mut all, sanitize(tpl("p", None, "t"), 1).expect("ok"));
        let mut newer = tpl("p", None, "t");
        newer.delimiter = ";".into();
        upsert_into(&mut all, sanitize(newer, 2).expect("ok"));
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].delimiter, ";");
        for i in 0..MAX_TEMPLATES {
            upsert_into(
                &mut all,
                sanitize(tpl("p", None, &format!("t{i}")), 10 + i as i64).expect("ok"),
            );
        }
        assert_eq!(all.len(), MAX_TEMPLATES);
        // 最も古い "t" (更新 2) が落ちている。
        assert!(all.iter().all(|t| t.table != "t"));
    }

    #[test]
    fn filter_matches_profile_database_and_table() {
        let all = vec![
            sanitize(tpl("p1", Some("a"), "x"), 1).expect("ok"),
            sanitize(tpl("p1", Some("a"), "y"), 1).expect("ok"),
            sanitize(tpl("p1", Some("b"), "x"), 1).expect("ok"),
            sanitize(tpl("p2", Some("a"), "x"), 1).expect("ok"),
        ];
        assert_eq!(filter(all.clone(), "p1", Some("a"), Some("x")).len(), 1);
        assert_eq!(filter(all.clone(), "p1", Some("a"), None).len(), 2);
        assert_eq!(filter(all, "p1", None, None).len(), 0);
    }

    #[test]
    fn file_roundtrip_keeps_unparsable_entries() {
        let path = scratch("roundtrip");
        let future = serde_json::json!({"id": "zzz", "profileId": 12, "unknown": true});
        std::fs::write(
            &path,
            serde_json::json!({ KEY: [future.clone()] }).to_string(),
        )
        .expect("write");
        assert!(load_at(&path).expect("load").is_empty());
        let t = sanitize(tpl("p", None, "t"), 3).expect("ok");
        save_at(&path, std::slice::from_ref(&t)).expect("save");
        let loaded = load_at(&path).expect("load");
        assert_eq!(loaded, vec![t]);
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(text.contains("\"unknown\""));
    }

    #[test]
    fn serialized_template_has_no_file_path_or_secret_fields() {
        let t = sanitize(tpl("p", None, "t"), 3).expect("ok");
        let v = serde_json::to_value(&t).expect("json");
        let keys: Vec<&str> = v
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert!(!keys
            .iter()
            .any(|k| k.contains("path") || k.contains("password")));
    }
}
