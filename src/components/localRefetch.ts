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
 * - 元の接続の照合は、プロファイル id が記録されていれば id で行う。旧データ (id なし) は表示名 +
 *   ドライバで探し、同じ組の接続が 2 つ以上開いていればどちらが元か分からないので断る (ambiguous)。
 * - MySQL / PostgreSQL は、元の SQL を実行した DB (`source_database`) が記録されていない旧データ
 *   (null) だと、別 DB の同名表で置き換えるおそれがあるので断る (noDatabase)。登録時は「タブの
 *   database のみ」を記録し、タブが既定のまま実行していれば空文字 "" を記録する。"" は「接続の
 *   既定のまま流す」(database = null で実行) の意味で、PostgreSQL ではタブの database がスキーマ
 *   (search_path) を指すため、プロファイルの既定 DB 名で代用してはならない。MySQL で既定 DB も
 *   無い "" は、実行時に DB 側が「データベース未選択」で失敗する (そのエラーを表示する)。
 *   SQLite は DB 名を使わない。
 *
 * 注意: 再取得は通常の `run_query` を使うため、バックエンドの Query Result Cache (TTL 30 秒、
 * 書き込みで無効化) を迂回できない。直前に同じ SQL を流していれば、最大 30 秒前の結果が返りうる。
 */
export type LocalRefetchPlan =
  /** `database` は `runQuery` へ渡す値。null = 接続の既定のまま。 */
  | { kind: "ok"; sessionId: string; database: string | null }
  | { kind: "notReadOnly" }
  | { kind: "noDatabase" }
  | { kind: "ambiguous"; profileName: string }
  | { kind: "noConnection"; profileName: string | null };

export function planLocalRefetch(
  meta: Pick<
    LocalTableMeta,
    "source_profile" | "source_profile_id" | "source_sql" | "source_driver" | "source_database"
  >,
  connections: readonly { sessionId: string; profile: { id: string; name: string; driver: string } }[],
): LocalRefetchPlan {
  if (!isReadOnlySql(meta.source_sql, meta.source_driver ?? undefined)) {
    return { kind: "notReadOnly" };
  }
  const needsDatabase = meta.source_driver === "mysql" || meta.source_driver === "postgres";
  if (needsDatabase && meta.source_database === null) return { kind: "noDatabase" };
  if (meta.source_profile === null && meta.source_profile_id === null) {
    return { kind: "noConnection", profileName: null };
  }
  const database = meta.source_database === "" ? null : meta.source_database;
  const label = meta.source_profile;
  if (meta.source_profile_id !== null) {
    const hit = connections.find((c) => c.profile.id === meta.source_profile_id);
    return hit
      ? { kind: "ok", sessionId: hit.sessionId, database }
      : { kind: "noConnection", profileName: label };
  }
  const hits = connections.filter(
    (c) =>
      c.profile.name === meta.source_profile &&
      (meta.source_driver === null || c.profile.driver === meta.source_driver),
  );
  if (hits.length === 0) return { kind: "noConnection", profileName: label };
  if (hits.length > 1) return { kind: "ambiguous", profileName: label ?? "" };
  return { kind: "ok", sessionId: hits[0].sessionId, database };
}
