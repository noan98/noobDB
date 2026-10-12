import type { LocalTableMeta } from "../api/tauri";
import { isReadOnlySql } from "../dangerousSql";

/**
 * ローカルテーブルの再取得 (#1541) の可否判定 (純ロジック)。
 *
 * ローカルテーブルは由来 (接続の表示名・実行 SQL・ドライバ) だけを持ち、接続 id や
 * 接続情報は持たない (秘密情報を残さない設計)。再取得は「いま開いている接続の中から、
 * 由来の表示名とドライバが一致するもの」に元の SQL を流し直す。
 *
 * - 読み取り専用の SQL だけを再実行する。結果セットの登録元は SELECT 系のはずだが、
 *   保存されているのは実行時の文字列そのもの。書き込みを含む文を黙って流し直さないよう、
 *   判定に通らないものは断る。
 * - 元の接続が閉じていれば案内のみ (自動で接続しない)。
 */
export type LocalRefetchPlan =
  | { kind: "ok"; sessionId: string }
  | { kind: "notReadOnly" }
  | { kind: "noConnection"; profileName: string | null };

export function planLocalRefetch(
  meta: Pick<LocalTableMeta, "source_profile" | "source_sql" | "source_driver">,
  connections: readonly { sessionId: string; profile: { name: string; driver: string } }[],
): LocalRefetchPlan {
  if (!isReadOnlySql(meta.source_sql, meta.source_driver ?? undefined)) {
    return { kind: "notReadOnly" };
  }
  if (meta.source_profile === null) return { kind: "noConnection", profileName: null };
  const hit = connections.find(
    (c) =>
      c.profile.name === meta.source_profile &&
      (meta.source_driver === null || c.profile.driver === meta.source_driver),
  );
  return hit ? { kind: "ok", sessionId: hit.sessionId } : { kind: "noConnection", profileName: meta.source_profile };
}
