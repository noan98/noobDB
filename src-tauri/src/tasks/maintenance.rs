//! 定期メンテナンス (`TaskAction::RunMaintenance`、#2025) の SQL 生成。
//!
//! スケジューラのアクションは読み取り専用が前提 (#730) だが、メンテナンスは書き込み扱いの
//! 文 (VACUUM / OPTIMIZE など)。任意 SQL は受けず、**ここの列挙 (種別 × ドライバ) から
//! 生成した固定形の文だけ**を実行することで安全前提を保つ。識別子は必ず
//! `db::sync::quote_ident` を通す。フロントの `maintenanceCommands.ts` と同じ文を返す。
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
    fn mysql_table_statements_quote_identifiers() {
        let r = build_statements(Mysql, Some("my`db"), &s(&["a", "b`c"]), Optimize).unwrap();
        assert_eq!(
            sqls(r),
            vec![
                "OPTIMIZE TABLE `my``db`.`a`;",
                "OPTIMIZE TABLE `my``db`.`b``c`;"
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
