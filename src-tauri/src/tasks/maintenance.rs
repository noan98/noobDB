//! 定期メンテナンス (`TaskAction::RunMaintenance`、#2025) の SQL 生成。
//!
//! スケジューラのアクションは読み取り専用が前提 (#730) だが、メンテナンスは書き込み扱いの
//! 文 (VACUUM / OPTIMIZE など)。任意 SQL は受けず、**ここの列挙 (種別 × ドライバ) から
//! 生成した固定形の文だけ**を実行することで安全前提を保つ。識別子は必ず
//! `db::sync::quote_ident` を通す。フロントの `taskMaintenance.ts` (`buildTaskMaintenanceStatements`) と同じ文を返し、
//! 共有ゴールデンベクタ `src/__tests__/fixtures/taskMaintenanceVectors.json` で一致を固定している。
//! 副作用なしの純関数で、ドライバが対応しない組み合わせは理由付きで弾く。

use serde::{Deserialize, Serialize};

use crate::db::sync::quote_ident;
use crate::db::DriverKind;
use crate::error::{AppError, Result};

/// 1 タスクで指定できる対象テーブル数の上限。
pub const MAX_TARGETS: usize = 500;

/// メンテナンスの種別。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMaintenanceKind {
    /// 統計更新 (全ドライバ)。
    Analyze,
    /// MySQL `OPTIMIZE TABLE` (テーブル再構築 + 統計更新)。
    Optimize,
    /// PostgreSQL / SQLite `VACUUM`。
    Vacuum,
    /// PostgreSQL `VACUUM (ANALYZE)`。
    VacuumAnalyze,
    /// PostgreSQL / SQLite `REINDEX`。
    Reindex,
}

/// 生成した 1 文。`target` は対象テーブル (データベース全体なら `None`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaintenanceStatement {
    pub target: Option<String>,
    pub sql: String,
}

/// 種別がそのドライバで使えるか (対象数に依らない判定)。使えなければ理由を返す。
pub fn check_supported(driver: DriverKind, kind: TaskMaintenanceKind) -> Result<()> {
    use DriverKind::*;
    use TaskMaintenanceKind::*;
    let ok = matches!(
        (driver, kind),
        (Mysql, Analyze | Optimize)
            | (Postgres, Analyze | Vacuum | VacuumAnalyze | Reindex)
            | (Sqlite, Analyze | Vacuum | Reindex)
    );
    if ok {
        return Ok(());
    }
    let why = match (driver, kind) {
        (Mysql, Vacuum | VacuumAnalyze | Reindex) => "MySQL has no VACUUM / REINDEX (use OPTIMIZE)",
        (Postgres, Optimize) => "PostgreSQL has no OPTIMIZE (use VACUUM)",
        (Sqlite, Optimize) => "SQLite has no OPTIMIZE (use VACUUM)",
        (Sqlite, VacuumAnalyze) => {
            "SQLite has no VACUUM (ANALYZE) (run VACUUM and ANALYZE separately)"
        }
        _ => "unsupported maintenance kind for this driver",
    };
    Err(AppError::InvalidInput(format!(
        "maintenance kind {kind:?} is not available for {}: {why}",
        driver.as_str()
    )))
}

/// 対象指定の妥当性 (空白だけ・前後空白・重複・多すぎる)。
pub fn validate_targets(targets: &[String]) -> Result<()> {
    if targets.len() > MAX_TARGETS {
        return Err(AppError::InvalidInput(format!(
            "too many maintenance targets (max {MAX_TARGETS})"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for t in targets {
        if t.contains('\0') {
            return Err(AppError::InvalidInput(
                "maintenance target contains a NUL character".into(),
            ));
        }
        if t.trim().is_empty() || t != t.trim() {
            return Err(AppError::InvalidInput(
                "maintenance target is empty or has surrounding whitespace".into(),
            ));
        }
        if !seen.insert(t.as_str()) {
            return Err(AppError::InvalidInput(format!(
                "duplicate maintenance target `{t}`"
            )));
        }
    }
    Ok(())
}

/// 修飾に使う `database` (MySQL のデータベース / PG のスキーマ) を検証する。実行時に必ず
/// 失敗する文字 (MySQL の `` ` ``、PG の `"` / `\`、NUL) は保存時に弾く。
pub fn validate_database(driver: Option<DriverKind>, database: Option<&str>) -> Result<()> {
    let Some(db) = database else { return Ok(()) };
    let bad = db.contains('\0')
        || match driver {
            Some(DriverKind::Mysql) => db.contains('`'),
            Some(DriverKind::Postgres) => db.contains('"') || db.contains('\\'),
            Some(DriverKind::Sqlite) => false,
            // ドライバ未確定 (保存前の事前検証) は NUL だけを弾く。ドライバ依存の文字は
            // プロファイル解決後の `build_statements` (`Some(driver)`) で検査する。
            None => false,
        };
    if bad {
        return Err(AppError::InvalidInput(
            "maintenance database / schema name contains an unsupported character".into(),
        ));
    }
    Ok(())
}

fn qualified(driver: DriverKind, database: Option<&str>, table: &str) -> String {
    match (driver, database.map(str::trim).filter(|d| !d.is_empty())) {
        (DriverKind::Sqlite, _) | (_, None) => quote_ident(driver, table),
        (_, Some(db)) => format!("{}.{}", quote_ident(driver, db), quote_ident(driver, table)),
    }
}

/// タスク定義から実行する文を生成する。`targets` が空ならデータベース全体 (MySQL は
/// 全体を取る文が無いので対象必須、PostgreSQL の REINDEX も同様)。`database` は
/// MySQL ではデータベース、PostgreSQL ではスキーマとして識別子の修飾に使う (SQLite は無視)。
pub fn build_statements(
    driver: DriverKind,
    database: Option<&str>,
    targets: &[String],
    kind: TaskMaintenanceKind,
) -> Result<Vec<MaintenanceStatement>> {
    use DriverKind::*;
    use TaskMaintenanceKind::*;
    check_supported(driver, kind)?;
    validate_targets(targets)?;
    validate_database(Some(driver), database)?;
    if targets.is_empty() {
        let sql = match (driver, kind) {
            (Mysql, _) => {
                return Err(AppError::InvalidInput(
                    "MySQL maintenance needs at least one target table (there is no database-wide statement)"
                        .into(),
                ))
            }
            (Postgres, Reindex) => {
                return Err(AppError::InvalidInput(
                    "PostgreSQL REINDEX needs at least one target table".into(),
                ))
            }
            (_, Analyze) => "ANALYZE;",
            (_, Vacuum) => "VACUUM;",
            (_, VacuumAnalyze) => "VACUUM (ANALYZE);",
            (Sqlite, Reindex) => "REINDEX;",
            _ => {
                return Err(AppError::InvalidInput(
                    "unsupported maintenance kind for this driver".into(),
                ))
            }
        };
        return Ok(vec![MaintenanceStatement {
            target: None,
            sql: sql.to_string(),
        }]);
    }
    // SQLite の VACUUM はデータベース全体にしか効かない。
    if driver == Sqlite && kind == Vacuum {
        return Err(AppError::InvalidInput(
            "SQLite VACUUM applies to the whole database; leave the target tables empty".into(),
        ));
    }
    Ok(targets
        .iter()
        .map(|table| {
            let name = qualified(driver, database, table);
            let sql = match (driver, kind) {
                (Mysql, Analyze) => format!("ANALYZE TABLE {name};"),
                (Mysql, _) => format!("OPTIMIZE TABLE {name};"),
                (Postgres, Analyze) | (Sqlite, Analyze) => format!("ANALYZE {name};"),
                (Postgres, Vacuum) => format!("VACUUM {name};"),
                (Postgres, VacuumAnalyze) => format!("VACUUM (ANALYZE) {name};"),
                (Postgres, _) => format!("REINDEX TABLE {name};"),
                (Sqlite, _) => format!("REINDEX {name};"),
            };
            MaintenanceStatement {
                target: Some(table.clone()),
                sql,
            }
        })
        .collect())
}

/// 16 進文字列 (`Value::Bytes` の表現) を UTF-8 文字列に戻す。不正なら `None`。
fn decode_hex_utf8(hex: &str) -> Option<String> {
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

/// MySQL の `ANALYZE` / `OPTIMIZE TABLE` の結果行 (Table / Op / Msg_type / Msg_text) から失敗の
/// 本文を集める (純関数)。`Msg_type` が大文字小文字を問わず `error` の行だけを失敗とし、
/// `status` / `note` / `warning` は数えない (InnoDB の OPTIMIZE は note と status OK を返す)。
/// 列は位置 (2 = Msg_type, 3 = Msg_text) で読み、足りない行は無視する。
pub fn mysql_maintenance_errors(rows: &[Vec<crate::db::types::Value>]) -> Vec<String> {
    // 文字列型の列は String、バイナリ照合順序の列は Bytes (16 進文字列) で返ることがあるので、
    // Bytes も UTF-8 として読む。
    let text = |v: Option<&crate::db::types::Value>| match v {
        Some(crate::db::types::Value::String(s)) => Some(s.clone()),
        Some(crate::db::types::Value::Bytes(hex)) => decode_hex_utf8(hex),
        _ => None,
    };
    rows.iter()
        .filter_map(|r| {
            let ty = text(r.get(2))?;
            if ty.eq_ignore_ascii_case("error") {
                Some(text(r.get(3)).unwrap_or_else(|| "error".to_string()))
            } else {
                None
            }
        })
        .collect()
}

/// 失敗した対象の要約 (`TaskRun.error`)。全成功なら `None`。他の `summarize_*_failures` と同形。
pub fn summarize_maintenance_failures(
    total: usize,
    failures: &[(String, String)],
) -> Option<String> {
    if failures.is_empty() {
        return None;
    }
    let list: Vec<String> = failures
        .iter()
        .map(|(target, e)| format!("{target} ({e})"))
        .collect();
    Some(format!(
        "{} of {} maintenance statements failed: {}",
        failures.len(),
        total,
        list.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use DriverKind::*;
    use TaskMaintenanceKind::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    fn sqls(r: Vec<MaintenanceStatement>) -> Vec<String> {
        r.into_iter().map(|m| m.sql).collect()
    }

    #[test]
    fn driverless_database_check_only_rejects_nul() {
        // 保存前 (ドライバ未確定) は NUL だけを弾き、ドライバ依存の文字は通す (#2025)。
        assert!(validate_database(None, Some("a`b")).is_ok());
        assert!(validate_database(None, Some("a\"b")).is_ok());
        assert!(validate_database(None, Some("a\0b")).is_err());
        assert!(validate_database(Some(DriverKind::Mysql), Some("a`b")).is_err());
        assert!(validate_database(Some(DriverKind::Postgres), Some("a\"b")).is_err());
    }

    #[test]
    fn mysql_table_statements_quote_identifiers() {
        let r = build_statements(Mysql, Some("mydb"), &s(&["a", "b`c"]), Optimize).unwrap();
        assert_eq!(
            sqls(r),
            vec![
                "OPTIMIZE TABLE `mydb`.`a`;",
                "OPTIMIZE TABLE `mydb`.`b``c`;"
            ]
        );
        let r = build_statements(Mysql, Some("d"), &s(&["t"]), Analyze).unwrap();
        assert_eq!(sqls(r), vec!["ANALYZE TABLE `d`.`t`;"]);
    }

    #[test]
    fn mysql_requires_targets_and_rejects_vacuum() {
        assert!(build_statements(Mysql, Some("d"), &[], Analyze).is_err());
        assert!(build_statements(Mysql, None, &s(&["t"]), Vacuum).is_err());
        assert!(build_statements(Mysql, None, &s(&["t"]), Reindex).is_err());
    }

    #[test]
    fn postgres_statements() {
        let r = build_statements(Postgres, Some("public"), &s(&["a\"b"]), VacuumAnalyze).unwrap();
        assert_eq!(sqls(r), vec!["VACUUM (ANALYZE) \"public\".\"a\"\"b\";"]);
        let r = build_statements(Postgres, None, &s(&["t"]), Reindex).unwrap();
        assert_eq!(sqls(r), vec!["REINDEX TABLE \"t\";"]);
        assert_eq!(
            sqls(build_statements(Postgres, None, &[], Vacuum).unwrap()),
            vec!["VACUUM;"]
        );
        assert_eq!(
            sqls(build_statements(Postgres, None, &[], VacuumAnalyze).unwrap()),
            vec!["VACUUM (ANALYZE);"]
        );
        assert!(build_statements(Postgres, None, &[], Reindex).is_err());
        assert!(build_statements(Postgres, None, &s(&["t"]), Optimize).is_err());
    }

    #[test]
    fn sqlite_statements() {
        assert_eq!(
            sqls(build_statements(Sqlite, Some("ignored"), &s(&["t"]), Analyze).unwrap()),
            vec!["ANALYZE \"t\";"]
        );
        assert_eq!(
            sqls(build_statements(Sqlite, None, &s(&["t"]), Reindex).unwrap()),
            vec!["REINDEX \"t\";"]
        );
        assert_eq!(
            sqls(build_statements(Sqlite, None, &[], Vacuum).unwrap()),
            vec!["VACUUM;"]
        );
        assert!(build_statements(Sqlite, None, &s(&["t"]), Vacuum).is_err());
        assert!(build_statements(Sqlite, None, &[], VacuumAnalyze).is_err());
        assert!(build_statements(Sqlite, None, &[], Optimize).is_err());
    }

    #[test]
    fn rejects_bad_targets() {
        assert!(build_statements(Sqlite, None, &s(&[" "]), Analyze).is_err());
        assert!(build_statements(Sqlite, None, &s(&[" t"]), Analyze).is_err());
        assert!(build_statements(Sqlite, None, &s(&["t", "t"]), Analyze).is_err());
        let many: Vec<String> = (0..=MAX_TARGETS).map(|i| format!("t{i}")).collect();
        assert!(build_statements(Sqlite, None, &many, Analyze).is_err());
    }

    #[test]
    fn mysql_error_rows_are_detected_case_insensitively() {
        use crate::db::types::Value;
        let row = |ty: &str, msg: &str| {
            vec![
                Value::String("d.t".into()),
                Value::String("analyze".into()),
                Value::String(ty.into()),
                Value::String(msg.into()),
            ]
        };
        let rows = vec![
            row(
                "note",
                "Table does not support optimize, doing recreate + analyze instead",
            ),
            row("status", "OK"),
            row("warning", "w"),
            row("Error", "Table 'd.t' doesn't exist"),
            row("ERROR", "denied"),
        ];
        assert_eq!(
            mysql_maintenance_errors(&rows),
            vec![
                "Table 'd.t' doesn't exist".to_string(),
                "denied".to_string()
            ]
        );
        assert!(mysql_maintenance_errors(&rows[..3]).is_empty());
        // Bytes (16 進) の Msg_type / Msg_text も読む。
        let hex = |s: &str| Value::Bytes(s.bytes().map(|b| format!("{b:02x}")).collect());
        let b = vec![Value::Null, Value::Null, hex("error"), hex("boom")];
        assert_eq!(mysql_maintenance_errors(&[b]), vec!["boom".to_string()]);
        assert!(mysql_maintenance_errors(&[vec![Value::Null]]).is_empty());
    }

    #[test]
    fn rejects_unquotable_database_and_nul_targets() {
        assert!(build_statements(Mysql, Some("a`b"), &s(&["t"]), Analyze).is_err());
        assert!(build_statements(Postgres, Some("a\"b"), &s(&["t"]), Analyze).is_err());
        assert!(build_statements(Postgres, Some("a\\b"), &s(&["t"]), Analyze).is_err());
        assert!(build_statements(Postgres, Some("a\0b"), &s(&["t"]), Analyze).is_err());
        assert!(build_statements(Sqlite, None, &s(&["a\0b"]), Analyze).is_err());
        // MySQL では " や \ は識別子として有効 (バッククォートだけが問題)。
        assert!(build_statements(Mysql, Some("a\"b"), &s(&["t"]), Analyze).is_ok());
    }

    #[test]
    fn statements_match_the_shared_vectors() {
        // フロント `buildTaskMaintenanceStatements` (タスク作成フォームのライブプレビュー) と同じ共有ベクタ。
        // 片方だけ生成規則を変えるとどちらかが落ちる (#2096)。
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/__tests__/fixtures/taskMaintenanceVectors.json"
        ))
        .unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let driver = DriverKind::parse(c["driver"].as_str().unwrap()).unwrap();
            let kind: TaskMaintenanceKind = serde_json::from_value(c["kind"].clone()).unwrap();
            let database = c["database"].as_str();
            let targets: Vec<String> = c["targets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t.as_str().unwrap().to_string())
                .collect();
            let got = build_statements(driver, database, &targets, kind);
            match c["sql"].as_array() {
                Some(expected) => {
                    let expected: Vec<&str> =
                        expected.iter().map(|x| x.as_str().unwrap()).collect();
                    let got = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                    let got: Vec<&str> = got.iter().map(|m| m.sql.as_str()).collect();
                    assert_eq!(got, expected, "{name}");
                }
                None => assert!(got.is_err(), "{name}: エラーになるはず"),
            }
        }
    }

    #[test]
    fn summarize_failures() {
        assert_eq!(summarize_maintenance_failures(2, &[]), None);
        let e = summarize_maintenance_failures(3, &[("a".into(), "boom".into())]).unwrap();
        assert_eq!(e, "1 of 3 maintenance statements failed: a (boom)");
    }

    #[test]
    fn serde_roundtrip_snake_case() {
        let k: TaskMaintenanceKind = serde_json::from_str("\"vacuum_analyze\"").unwrap();
        assert_eq!(k, VacuumAnalyze);
    }
}
