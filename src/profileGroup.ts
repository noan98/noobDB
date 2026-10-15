// 接続プロファイルのグループ移動 (#1630)。既存の `save_profile` を流用し、`group` だけを書き換える
// 保存リクエストを組み立てる純関数。秘密 (パスワード等) のフィールドは**含めない**
// (`undefined` = キーリングの値を変えない)。

import type { ConnectionProfile, SaveProfileRequest } from "./api/tauri";

/** 入力されたグループ名を整える。空白だけ・空は `null` (未分類へ戻す)。 */
export function normalizeGroupName(input: string | null | undefined): string | null {
  const trimmed = (input ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** 既存のグループ名 (重複なし・名前順、未分類は含めない)。 */
export function existingGroupNames(profiles: readonly ConnectionProfile[]): string[] {
  const names = new Set<string>();
  for (const p of profiles) if (p.group) names.add(p.group);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * `profile` を `group` へ移すための保存リクエスト。ほかの設定は現状のまま引き継ぎ、
 * パスワード / パスフレーズは触らない。並び順は `save_profile` が id で上書きするので変わらない。
 */
export function buildGroupMoveRequest(profile: ConnectionProfile, group: string | null): SaveProfileRequest {
  return {
    id: profile.id,
    name: profile.name,
    driver: profile.driver,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database,
    ssh: profile.ssh,
    group: normalizeGroupName(group),
    color: profile.color,
    is_production: profile.is_production,
    confirm_writes: profile.confirm_writes,
    read_only: profile.read_only,
    skip_history: profile.skip_history,
    file_path: profile.file_path ?? null,
    ssl_mode: profile.ssl_mode ?? null,
    ssl_root_cert: profile.ssl_root_cert ?? null,
    ssl_client_cert: profile.ssl_client_cert ?? null,
    ssl_client_key: profile.ssl_client_key ?? null,
    init_sql: profile.init_sql ?? null,
    aws_iam: profile.aws_iam ?? null,
    ssm: profile.ssm ?? null,
  };
}
