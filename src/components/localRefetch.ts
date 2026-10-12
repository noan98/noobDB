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
 * - 同じ表示名・ドライバの接続が 2 つ以上開いていれば、どちらが元か分からないので断る (ambiguous)。
 * - MySQL / PostgreSQL は、元の SQL を実行した DB が記録されていないと (旧データ)、接続の既定 DB
 *   で流して別 DB の同名表で置き換えるおそれがあるので断る (noDatabase)。SQLite は DB 名を使わない。
 *
 * 注意: 再取得は通常の `run_query` を使うため、バックエンドの Query Result Cache (TTL 30 秒、
 * 書き込みで無効化) を迂回できない。直前に同じ SQL を流していれば、最大 30 秒前の結果が返りうる。
 */
export type LocalRefetchPlan =
  | { kind: "ok"; sessionId: string; database: string | null }
  | { kind: "notReadOnly" }
  | { kind: "noDatabase" }
  | { kind: "ambiguous"; profileName: string }
  | { kind: "noConnection"; profileName: string | null };

export function planLocalRefetch(
  meta: Pick<LocalTableMeta, "source_profile" | "source_sql" | "source_driver" | "source_database">,
  connections: readonly { sessionId: string; profile: { name: string; driver: string } }[],
): LocalRefetchPlan {
  if (!isReadOnlySql(meta.source_sql, meta.source_driver ?? undefined)) {
    return { kind: "notReadOnly" };
  }
  const needsDatabase = meta.source_driver === "mysql" || meta.source_driver === "postgres";
  if (needsDatabase && !meta.source_database) return { kind: "noDatabase" };
  if (meta.source_profile === null) return { kind: "noConnection", profileName: null };
  const hits = connections.filter(
    (c) =>
      c.profile.name === meta.source_profile &&
      (meta.source_driver === null || c.profile.driver === meta.source_driver),
  );
  if (hits.length === 0) return { kind: "noConnection", profileName: meta.source_profile };
  if (hits.length > 1) return { kind: "ambiguous", profileName: meta.source_profile };
  return { kind: "ok", sessionId: hits[0].sessionId, database: meta.source_database };
}
