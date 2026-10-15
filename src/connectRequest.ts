/**
 * 保存済みプロファイルから `ConnectRequest` を組み立てる共通ヘルパー。
 *
 * サイドバー接続・データ転送・スキーマ比較など「プロファイルから接続する」箇所が
 * それぞれ手でフィールドを写していたため、TLS / init_sql / aws_iam / ssm の写し漏れ
 * (IAM 認証のプロファイルで IAM が使われない等) が起きていた。写すべき項目はここに集約する。
 *
 * 秘密 (DB パスワード / SSH パスフレーズ・パスワード) は常に空にし、`profile_id` を渡して
 * バックエンドにキーチェーンから解決させる。
 */
import type { ConnectRequest, ConnectionProfile, DriverKind } from "./api/tauri";

/** プロファイルの `driver` (プレーンな文字列) を `DriverKind` に絞る。未知は mysql。 */
export function normalizeDriver(driver: string): DriverKind {
  return driver === "postgres" || driver === "sqlite" ? driver : "mysql";
}

export type ConnectRequestOverrides = Partial<Pick<ConnectRequest, "read_only" | "skip_history">> & {
  /**
   * true のときだけプロファイルの固定ローカルポート (`ssh.local_port`, #1630) を引き継ぐ。
   * 既定は false (自動割当) — 補助セッション (スキーマ比較・データ転送) が本接続の
   * 固定ポートを奪い合って「使用中」で失敗するのを防ぐ。本接続だけ true にする。
   */
  pinLocalPort?: boolean;
};

export function connectRequestFromProfile(
  profile: ConnectionProfile,
  overrides: ConnectRequestOverrides = {},
): ConnectRequest {
  const ssh = profile.ssh
    ? {
        ...profile.ssh,
        passphrase: "",
        password: "",
        local_port: overrides.pinLocalPort ? (profile.ssh.local_port ?? null) : null,
        jump: profile.ssh.jump ? { ...profile.ssh.jump, passphrase: "", password: "" } : null,
      }
    : null;
  return {
    profile_id: profile.id,
    driver: normalizeDriver(profile.driver),
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: "",
    database: profile.database,
    ssh,
    file_path: profile.file_path,
    ssl_mode: profile.ssl_mode ?? null,
    ssl_root_cert: profile.ssl_root_cert ?? null,
    ssl_client_cert: profile.ssl_client_cert ?? null,
    ssl_client_key: profile.ssl_client_key ?? null,
    init_sql: profile.init_sql ?? null,
    aws_iam: profile.aws_iam ?? null,
    ssm: profile.ssm ?? null,
    read_only: overrides.read_only ?? profile.read_only,
    skip_history: overrides.skip_history ?? profile.skip_history,
  };
}
