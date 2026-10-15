pub mod backup;
pub mod secrets;
pub mod store;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// Short slug (8 chars). Stable across renames.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssh: Option<SshProfile>,
    /// Optional group name used to organize connections in the sidebar.
    #[serde(default)]
    pub group: Option<String>,
    /// Optional accent color (e.g. `#dc2626`) shown on the profile row.
    #[serde(default)]
    pub color: Option<String>,
    /// When true and the corresponding setting is enabled, the UI shows a
    /// confirmation dialog before connecting.
    #[serde(default)]
    pub is_production: bool,
    /// When true (and `is_production` is set), the UI requires explicit
    /// approval before running any statement that is not strictly read-only.
    /// `read_only` takes precedence: a read-only session rejects writes
    /// outright, so there is nothing left to approve.
    #[serde(default)]
    pub confirm_writes: bool,
    /// When true, sessions opened from this profile reject any SQL that is
    /// not strictly read-only. Acts as a last-line safety net independent
    /// of DB-side privileges.
    #[serde(default)]
    pub read_only: bool,
    /// When true, statements run on sessions opened from this profile are not
    /// recorded in the query history. Useful for connections whose SQL may
    /// embed passwords or other sensitive literals.
    #[serde(default)]
    pub skip_history: bool,
    /// Database file path for file-backed drivers (SQLite). `None` for
    /// network-backed drivers (MySQL, PostgreSQL).
    #[serde(default)]
    pub file_path: Option<String>,
    /// TLS requirement level (`disable` / `prefer` / `require` / `verify_ca` /
    /// `verify_full`). `None` keeps the driver default for profiles saved before
    /// TLS settings existed. These are non-secret and live in `profiles.json`.
    #[serde(default)]
    pub ssl_mode: Option<crate::db::SslMode>,
    /// CA (root) certificate file path for verifying the server certificate.
    /// The path is non-secret; the file contents are read at connect time only.
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    /// Client certificate file path for mutual TLS (mTLS).
    #[serde(default)]
    pub ssl_client_cert: Option<String>,
    /// Client private key file path for mutual TLS (mTLS).
    #[serde(default)]
    pub ssl_client_key: Option<String>,
    /// Session-initialization SQL run right after each connection is established
    /// (e.g. `SET search_path`, `SET time_zone`, `PRAGMA`). Multiple statements
    /// allowed. Non-secret; stored in `profiles.json`.
    #[serde(default)]
    pub init_sql: Option<String>,
    /// AWS RDS / Aurora IAM database authentication (#734). `Some` selects the
    /// `aws_iam` auth method (no stored DB password); `None` is the classic
    /// password method, including every profile saved before this field existed.
    /// Holds only the region and AWS profile *name* — AWS access keys are never
    /// stored by noobDB (neither here nor in the keyring).
    #[serde(default)]
    pub aws_iam: Option<crate::db::aws_iam::AwsIamConfig>,
    /// AWS SSM Session Manager のポートフォワード経由の接続 (#1683)。`ssh` と排他。
    /// 踏み台のインスタンス ID・リージョン・AWS プロファイル名のみで、すべて非秘密
    /// (認証は AWS CLI 側が解決する)。`None` は SSM を使わず、本項目の追加前に保存された
    /// 旧プロファイルも `None` として読める。
    #[serde(default)]
    pub ssm: Option<crate::ssm::SsmConfig>,
}

/// How an SSH tunnel authenticates with the jump host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    /// Private key file plus optional passphrase.
    #[default]
    Key,
    /// Delegate signing to the running ssh-agent.
    Agent,
    /// Plain password authentication.
    Password,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Defaults to `Key` so profiles written before this field existed keep
    /// their original private-key behavior.
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    /// Path to the private key. Empty/unused for `agent` and `password`.
    #[serde(default)]
    pub private_key_path: PathBuf,
    /// Optional bastion/jump hop dialed *before* this hop (#708 multi-hop
    /// tunnel, ProxyJump-equivalent). When set, the tunnel opens
    /// jump -> `host` -> (remote DB) instead of connecting to `host` directly.
    /// Capped at one jump hop (2 SSH hops total) for now; `None` for profiles
    /// saved before this field existed (single-hop, unchanged behavior).
    #[serde(default)]
    pub jump: Option<SshJumpProfile>,
    /// トンネルのローカル待受ポートの固定値 (#1630)。`None` / 0 は従来どおり OS 任せの
    /// 自動割当。IDE・外部クライアントが接続先ポートを固定で持てるようにする。
    #[serde(default)]
    pub local_port: Option<u16>,
}

/// The bastion/jump hop of a 2-hop SSH tunnel (#708). Structurally the same
/// shape as [`SshProfile`] minus its own `jump` (chains are capped at one
/// bastion hop) since it is always the *first* hop dialed directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshJumpProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub private_key_path: PathBuf,
}

#[cfg(test)]
mod ssm_tests {
    use super::*;

    /// SSM 追加前に保存された JSON (`ssm` キー無し) も読め、`None` になる (#1683)。
    #[test]
    fn legacy_profile_json_without_ssm_still_loads() {
        let p: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "Prod", "driver": "mysql", "host": "db",
            "port": 3306, "user": "app", "database": null, "ssh": null
        }))
        .unwrap();
        assert!(p.ssm.is_none());
    }

    #[test]
    fn ssm_settings_roundtrip_through_json() {
        let p: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "Prod", "driver": "postgres", "host": "db",
            "port": 5432, "user": "app",
            "ssm": {"target": "i-0123456789abcdef0", "region": "", "profile": "work"}
        }))
        .unwrap();
        let ssm = p.ssm.clone().unwrap();
        assert_eq!(ssm.target, "i-0123456789abcdef0");
        assert_eq!(ssm.profile.as_deref(), Some("work"));
        let back: ConnectionProfile =
            serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back.ssm, p.ssm);
    }
}
