//! 明示トランザクション開始時のオプション (分離レベル / READ ONLY, #1166)。
//!
//! SQL 片は必ず [`TxIsolation`] の enum からだけ組み立て、呼び出し側の文字列を
//! 連結しない (インジェクション経路を作らない)。方言ごとの発行順序:
//!
//! - **MySQL / MariaDB**: `SET TRANSACTION ISOLATION LEVEL ...` を `START TRANSACTION`
//!   の**前**に発行する (修飾なしの SET TRANSACTION は「次の 1 トランザクションだけ」
//!   に効くので、プールへ戻る接続に設定が残らない)。READ ONLY は
//!   `START TRANSACTION READ ONLY`。
//! - **PostgreSQL**: `BEGIN ISOLATION LEVEL ... READ ONLY` を 1 文で発行する。
//!   `READ UNCOMMITTED` は PostgreSQL では `READ COMMITTED` と同じ挙動になる
//!   (構文は受理される)。
//! - **SQLite**: 非対応。オプションが指定されたら `InvalidInput` で拒否する
//!   (黙って無視すると「READ ONLY のつもりで書けてしまう」ため)。

use serde::Deserialize;

use crate::error::{AppError, Result};

/// トランザクション分離レベル。IPC では kebab-case 文字列で受ける。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TxIsolation {
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl TxIsolation {
    /// SQL の `ISOLATION LEVEL` に続くキーワード (固定文字列のみ)。
    pub fn sql_keyword(self) -> &'static str {
        match self {
            TxIsolation::ReadUncommitted => "READ UNCOMMITTED",
            TxIsolation::ReadCommitted => "READ COMMITTED",
            TxIsolation::RepeatableRead => "REPEATABLE READ",
            TxIsolation::Serializable => "SERIALIZABLE",
        }
    }
}

/// `begin_transaction` の任意オプション。既定 (両方未指定) はサーバ既定の挙動。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TxOptions {
    pub isolation: Option<TxIsolation>,
    pub read_only: bool,
}

impl TxOptions {
    pub fn is_default(&self) -> bool {
        self.isolation.is_none() && !self.read_only
    }

    /// MySQL: BEGIN の前に発行する `SET TRANSACTION ISOLATION LEVEL ...` (無ければ None)。
    pub fn mysql_pre_sql(&self) -> Option<String> {
        self.isolation
            .map(|i| format!("SET TRANSACTION ISOLATION LEVEL {}", i.sql_keyword()))
    }

    /// MySQL: 開始文。
    pub fn mysql_begin_sql(&self) -> &'static str {
        if self.read_only {
            "START TRANSACTION READ ONLY"
        } else {
            "START TRANSACTION"
        }
    }

    /// PostgreSQL: 開始文 (1 文)。
    pub fn postgres_begin_sql(&self) -> String {
        let mut sql = String::from("BEGIN");
        if let Some(i) = self.isolation {
            sql.push_str(" ISOLATION LEVEL ");
            sql.push_str(i.sql_keyword());
        }
        if self.read_only {
            sql.push_str(" READ ONLY");
        }
        sql
    }

    /// SQLite: 非対応。オプション指定があれば拒否する。
    pub fn ensure_default_for_sqlite(&self) -> Result<()> {
        if self.is_default() {
            Ok(())
        } else {
            Err(AppError::InvalidInput(
                "SQLite does not support transaction isolation level / READ ONLY options".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(i: Option<TxIsolation>, ro: bool) -> TxOptions {
        TxOptions {
            isolation: i,
            read_only: ro,
        }
    }

    #[test]
    fn default_keeps_legacy_statements() {
        let o = TxOptions::default();
        assert!(o.is_default());
        assert_eq!(o.mysql_pre_sql(), None);
        assert_eq!(o.mysql_begin_sql(), "START TRANSACTION");
        assert_eq!(o.postgres_begin_sql(), "BEGIN");
        assert!(o.ensure_default_for_sqlite().is_ok());
    }

    #[test]
    fn mysql_statements() {
        let o = opts(Some(TxIsolation::Serializable), true);
        assert_eq!(
            o.mysql_pre_sql().as_deref(),
            Some("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        );
        assert_eq!(o.mysql_begin_sql(), "START TRANSACTION READ ONLY");
        let o = opts(Some(TxIsolation::ReadCommitted), false);
        assert_eq!(o.mysql_begin_sql(), "START TRANSACTION");
    }

    #[test]
    fn postgres_statements() {
        assert_eq!(
            opts(Some(TxIsolation::RepeatableRead), false).postgres_begin_sql(),
            "BEGIN ISOLATION LEVEL REPEATABLE READ"
        );
        assert_eq!(opts(None, true).postgres_begin_sql(), "BEGIN READ ONLY");
        assert_eq!(
            opts(Some(TxIsolation::ReadUncommitted), true).postgres_begin_sql(),
            "BEGIN ISOLATION LEVEL READ UNCOMMITTED READ ONLY"
        );
    }

    #[test]
    fn sqlite_rejects_any_option() {
        assert!(opts(Some(TxIsolation::ReadCommitted), false)
            .ensure_default_for_sqlite()
            .is_err());
        assert!(opts(None, true).ensure_default_for_sqlite().is_err());
    }

    #[test]
    fn isolation_deserializes_from_kebab_case() {
        let i: TxIsolation = serde_json::from_str("\"repeatable-read\"").unwrap();
        assert_eq!(i, TxIsolation::RepeatableRead);
        assert!(serde_json::from_str::<TxIsolation>("\"x; DROP TABLE t\"").is_err());
    }
}
