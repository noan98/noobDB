//! 明示トランザクション内の SAVEPOINT 操作 (#1418)。
//!
//! 3 ドライバとも `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` の
//! 構文が共通なので SQL の骨格は同一。名前は [`validate_name`] で
//! `[A-Za-z_][A-Za-z0-9_]{0,62}` に制限したうえで、さらに方言ごとの
//! `quote_ident` (単一ソース) でクォートする (識別子インジェクションの二重防御)。
//!
//! 意味論 (DB 側): `ROLLBACK TO` はその SAVEPOINT 自身を残し、より新しいものを
//! 破棄する。`RELEASE` は指定の SAVEPOINT とそれより新しいものを破棄する。
//! PostgreSQL ではエラーで aborted 状態になったトランザクションも
//! `ROLLBACK TO SAVEPOINT` で回復できる。

use crate::db::{sync::quote_ident, DriverKind};
use crate::error::{AppError, Result};

/// SAVEPOINT 名の最大長 (PostgreSQL の識別子上限 63 バイトに合わせる)。
const MAX_NAME_LEN: usize = 63;

/// 英数字と `_` のみ・先頭は英字か `_`・1〜63 文字だけ許可する。
pub fn validate_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let ok = match chars.next() {
        Some(c) => (c.is_ascii_alphabetic() || c == '_') && name.len() <= MAX_NAME_LEN,
        None => false,
    } && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "invalid savepoint name: {name:?} (use [A-Za-z_][A-Za-z0-9_]*, up to {MAX_NAME_LEN} chars)"
        )))
    }
}

/// `SAVEPOINT <name>`。
pub fn create_sql(driver: DriverKind, name: &str) -> Result<String> {
    validate_name(name)?;
    Ok(format!("SAVEPOINT {}", quote_ident(driver, name)))
}

/// `ROLLBACK TO SAVEPOINT <name>`。
pub fn rollback_to_sql(driver: DriverKind, name: &str) -> Result<String> {
    validate_name(name)?;
    Ok(format!(
        "ROLLBACK TO SAVEPOINT {}",
        quote_ident(driver, name)
    ))
}

/// `RELEASE SAVEPOINT <name>`。
pub fn release_sql(driver: DriverKind, name: &str) -> Result<String> {
    validate_name(name)?;
    Ok(format!("RELEASE SAVEPOINT {}", quote_ident(driver, name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [DriverKind; 3] = [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite];

    #[test]
    fn accepts_safe_names() {
        for n in ["sp_1", "_a", "A", "sp_1_2", &"a".repeat(63)] {
            assert!(validate_name(n).is_ok(), "{n}");
        }
    }

    #[test]
    fn rejects_unsafe_names() {
        for n in [
            "",
            "1a",
            "a b",
            "a-b",
            "a\"b",
            "a`b",
            "a;DROP TABLE t",
            "a'b",
            "日本語",
            "sp\n1",
            &"a".repeat(64),
        ] {
            assert!(validate_name(n).is_err(), "{n:?}");
        }
    }

    #[test]
    fn sql_is_quoted_per_dialect() {
        assert_eq!(
            create_sql(DriverKind::Mysql, "sp_1").unwrap(),
            "SAVEPOINT `sp_1`"
        );
        assert_eq!(
            create_sql(DriverKind::Postgres, "sp_1").unwrap(),
            "SAVEPOINT \"sp_1\""
        );
        assert_eq!(
            create_sql(DriverKind::Sqlite, "sp_1").unwrap(),
            "SAVEPOINT \"sp_1\""
        );
        for d in ALL {
            assert!(rollback_to_sql(d, "x")
                .unwrap()
                .starts_with("ROLLBACK TO SAVEPOINT "));
            assert!(release_sql(d, "x")
                .unwrap()
                .starts_with("RELEASE SAVEPOINT "));
            assert!(create_sql(d, "x\"; DROP").is_err());
            assert!(rollback_to_sql(d, "").is_err());
            assert!(release_sql(d, "1").is_err());
        }
    }
}
