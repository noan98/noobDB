//! レプリケーション監視 (#2180) の共通型と純ロジック。
//!
//! PostgreSQL (`pg_stat_replication` / `pg_replication_slots` / `pg_stat_wal_receiver`) と
//! MySQL (`SHOW REPLICA STATUS`) の違いを、役割・接続先ごとの遅延・スロット一覧という共通の
//! 型へ寄せる。参照だけを行うので read_only セッションでも動く。権限不足はエラーにせず
//! [`ReplicationStatus::missing_privilege`] に必要な権限名を入れて返す (取れた範囲は返す)。
//! SQLite はレプリケーションの概念が無く、ドライバ側でエラーにする。

use serde::{Deserialize, Serialize};

/// 接続先サーバのレプリケーション上の役割。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplicationRole {
    /// 送信側 (レプリカやスロットを持つ)。
    Primary,
    /// 受信側 (上流から複製を受けている)。
    Replica,
    /// レプリケーション構成なし。
    Standalone,
}

/// [`ReplicationLink`] が自分から見てどちら向きか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplicationDirection {
    /// 自分から複製を送っている先 (PostgreSQL の `pg_stat_replication`、MySQL の `SHOW REPLICAS`)。
    Downstream,
    /// 自分が複製を受けている元 (PostgreSQL の `pg_stat_wal_receiver`、MySQL の `SHOW REPLICA STATUS`)。
    Upstream,
}

/// 接続先 1 件分のレプリケーション状態。エンジンが報告しない項目は `None`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplicationLink {
    pub direction: ReplicationDirection,
    /// 表示名。PostgreSQL は `application_name` (空なら `client_addr`)、MySQL は `host:port`
    /// (複数チャンネルのレプリカはチャンネル名を `host:port (channel)` として添える)。
    pub name: String,
    /// 相手のアドレス (取れなければ `None`)。
    pub address: Option<String>,
    /// PostgreSQL は `state` (`streaming` / `catchup` など)。MySQL は IO / SQL スレッドの要約。
    pub state: Option<String>,
    /// PostgreSQL の `sync_state` (`async` / `sync` / `quorum` / `potential`)。
    pub sync_state: Option<String>,
    /// 反映の遅れ (秒)。PostgreSQL は `replay_lag`、MySQL は `Seconds_Behind_Source`、
    /// PostgreSQL のレプリカ側は `now() - pg_last_xact_replay_timestamp()`。
    pub lag_secs: Option<f64>,
    /// PostgreSQL の `write_lag` (秒)。
    pub write_lag_secs: Option<f64>,
    /// PostgreSQL の `flush_lag` (秒)。
    pub flush_lag_secs: Option<f64>,
    /// 送信済み WAL と反映済み WAL の差 (バイト)。PostgreSQL の送信側のみ。
    pub lag_bytes: Option<i64>,
    /// MySQL の IO スレッド (`Replica_IO_Running`)。他は `None`。
    pub io_running: Option<bool>,
    /// MySQL の SQL スレッド (`Replica_SQL_Running`)。他は `None`。
    pub sql_running: Option<bool>,
    /// 直近のエラー (MySQL `Last_IO_Error` / `Last_SQL_Error`)。空は `None`。
    pub last_error: Option<String>,
}

/// レプリケーションスロット (PostgreSQL)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplicationSlot {
    pub name: String,
    /// `physical` / `logical`。
    pub slot_type: String,
    /// 論理スロットの出力プラグイン。
    pub plugin: Option<String>,
    pub active: bool,
    /// スロットが保持している WAL の量 (バイト)。`pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)`。
    /// 実用上 2^53 を超えない (9 PB)。念のため丸めずに飽和させて返す ([`clamp_js_safe`])。
    pub retained_bytes: Option<i64>,
    /// `reserved` / `extended` / `unreserved` / `lost` (PostgreSQL 13+)。
    pub wal_status: Option<String>,
}

/// `get_replication_status` の応答。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplicationStatus {
    pub role: ReplicationRole,
    /// 状態を取るのに足りない権限名 (`pg_monitor` / `REPLICATION CLIENT`)。足りているなら `None`。
    /// 足りないときも、権限なしで読めた範囲 (スロット一覧など) は返す。
    pub missing_privilege: Option<String>,
    pub links: Vec<ReplicationLink>,
    pub slots: Vec<ReplicationSlot>,
}

/// JS の安全整数を超える値を上限に飽和させる。WAL のバイト数はこの範囲に収まるが、
/// 万一超えても IPC で別の値へ丸められないようにする。
pub fn clamp_js_safe(v: i64) -> i64 {
    v.clamp(
        -crate::db::types::JS_MAX_SAFE_INTEGER,
        crate::db::types::JS_MAX_SAFE_INTEGER,
    )
}

/// MySQL のバージョン文字列から、レプリカ状態の問い合わせ文を選ぶ。
/// 8.0.22 以上の MySQL は `SHOW REPLICA STATUS`、それ未満と判別できない場合は
/// `SHOW SLAVE STATUS` (MariaDB は旧構文を今も受け付ける)。
pub fn mysql_replica_status_sql(version: &str) -> &'static str {
    if mysql_supports_replica_syntax(version) {
        "SHOW REPLICA STATUS"
    } else {
        "SHOW SLAVE STATUS"
    }
}

/// 状態を読むのに必要な権限名。MariaDB 10.5.9 以降は `SLAVE MONITOR` (別名 `REPLICA MONITOR`)、
/// それ以外 (MySQL・旧 MariaDB) は `REPLICATION CLIENT`。
pub fn mysql_required_privilege(version: &str) -> &'static str {
    if version.to_ascii_lowercase().contains("mariadb") {
        let mut nums = version
            .split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .take(3)
            .map(|s| s.parse::<u32>().unwrap_or(0));
        let v = (
            nums.next().unwrap_or(0),
            nums.next().unwrap_or(0),
            nums.next().unwrap_or(0),
        );
        if v >= (10, 5, 9) {
            return "SLAVE MONITOR";
        }
    }
    "REPLICATION CLIENT"
}

/// `names` の候補のうち、`columns` に (大文字小文字を区別せず) 最初に見つかったものの列位置。
/// `Source_*` / `Master_*` のように版で列名が違う `SHOW ... STATUS` の読み分けに使う。
pub fn first_present_column(columns: &[&str], names: &[&str]) -> Option<usize> {
    names
        .iter()
        .find_map(|n| columns.iter().position(|c| c.eq_ignore_ascii_case(n)))
}

/// 接続中のレプリカ一覧の問い合わせ文 (`SHOW REPLICAS` は 8.0.22+、旧名は `SHOW SLAVE HOSTS`)。
pub fn mysql_replicas_sql(version: &str) -> &'static str {
    if mysql_supports_replica_syntax(version) {
        "SHOW REPLICAS"
    } else {
        "SHOW SLAVE HOSTS"
    }
}

/// `8.0.22` 以上の MySQL か。MariaDB (バージョン文字列に `MariaDB` を含む) は旧構文で動くので偽。
pub fn mysql_supports_replica_syntax(version: &str) -> bool {
    if version.to_ascii_lowercase().contains("mariadb") {
        return false;
    }
    let mut nums = version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .take(3)
        .map(|s| s.parse::<u32>().unwrap_or(0));
    let major = nums.next().unwrap_or(0);
    let minor = nums.next().unwrap_or(0);
    let patch = nums.next().unwrap_or(0);
    (major, minor, patch) >= (8, 0, 22)
}

/// 空文字・空白だけの文字列を `None` にする (`Last_Error` が空のときなど)。
pub fn non_blank(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// MySQL の IO / SQL スレッドの状態から表示用の要約を作る。
pub fn mysql_link_state(io: Option<bool>, sql: Option<bool>) -> Option<String> {
    match (io, sql) {
        (Some(true), Some(true)) => Some("running".into()),
        (None, None) => None,
        (io, sql) => {
            let mut stopped = Vec::new();
            if io != Some(true) {
                stopped.push("io_stopped");
            }
            if sql != Some(true) {
                stopped.push("sql_stopped");
            }
            Some(stopped.join("+"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replica_syntax_switches_at_8_0_22() {
        assert_eq!(mysql_replica_status_sql("8.0.22"), "SHOW REPLICA STATUS");
        assert_eq!(mysql_replica_status_sql("8.0.21"), "SHOW SLAVE STATUS");
        assert_eq!(mysql_replica_status_sql("8.4.0"), "SHOW REPLICA STATUS");
        assert_eq!(mysql_replica_status_sql("9.1.0-log"), "SHOW REPLICA STATUS");
        assert_eq!(mysql_replica_status_sql("5.7.44"), "SHOW SLAVE STATUS");
        assert_eq!(
            mysql_replica_status_sql("10.11.6-MariaDB-1:10.11.6"),
            "SHOW SLAVE STATUS"
        );
        assert_eq!(mysql_replica_status_sql(""), "SHOW SLAVE STATUS");
        assert_eq!(mysql_replicas_sql("8.0.30"), "SHOW REPLICAS");
        assert_eq!(mysql_replicas_sql("5.7.1"), "SHOW SLAVE HOSTS");
    }

    #[test]
    fn column_fallback_prefers_first_present_name() {
        let new_cols = ["Replica_IO_State", "Source_Host", "Seconds_Behind_Source"];
        let old_cols = ["Slave_IO_State", "Master_Host", "Seconds_Behind_Master"];
        assert_eq!(
            first_present_column(&new_cols, &["Source_Host", "Master_Host"]),
            Some(1)
        );
        assert_eq!(
            first_present_column(&old_cols, &["Source_Host", "Master_Host"]),
            Some(1)
        );
        assert_eq!(
            first_present_column(
                &old_cols,
                &["Seconds_Behind_Source", "Seconds_Behind_Master"]
            ),
            Some(2)
        );
        assert_eq!(first_present_column(&new_cols, &["source_host"]), Some(1));
        assert_eq!(first_present_column(&new_cols, &["Channel_Name"]), None);
    }

    #[test]
    fn required_privilege_depends_on_flavor() {
        assert_eq!(mysql_required_privilege("8.0.36"), "REPLICATION CLIENT");
        assert_eq!(
            mysql_required_privilege("10.5.8-MariaDB"),
            "REPLICATION CLIENT"
        );
        assert_eq!(mysql_required_privilege("10.5.9-MariaDB"), "SLAVE MONITOR");
        assert_eq!(
            mysql_required_privilege("11.4.2-MariaDB-log"),
            "SLAVE MONITOR"
        );
        assert_eq!(mysql_required_privilege(""), "REPLICATION CLIENT");
    }

    #[test]
    fn link_state_summarizes_threads() {
        assert_eq!(
            mysql_link_state(Some(true), Some(true)).as_deref(),
            Some("running")
        );
        assert_eq!(
            mysql_link_state(Some(false), Some(true)).as_deref(),
            Some("io_stopped")
        );
        assert_eq!(
            mysql_link_state(Some(false), Some(false)).as_deref(),
            Some("io_stopped+sql_stopped")
        );
        assert_eq!(mysql_link_state(None, None), None);
    }

    #[test]
    fn helpers_normalize_values() {
        assert_eq!(non_blank(Some("  ".into())), None);
        assert_eq!(non_blank(Some(" boom ".into())).as_deref(), Some("boom"));
        assert_eq!(
            clamp_js_safe(i64::MAX),
            crate::db::types::JS_MAX_SAFE_INTEGER
        );
        assert_eq!(clamp_js_safe(42), 42);
    }
}
