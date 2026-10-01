import type { CellValue } from "../api/tauri";

/**
 * 結果ハンドル (#1264): ストリーミングで流した大きな結果をバックエンドが上限付きで保持
 * しているときの ID を、**行配列に紐づけて**持つ小さなレジストリ。
 *
 * ハンドルは「その行配列の内容」に対してだけ正しい。セル編集の適用 (`applyEditsToRows`)・
 * 行の追加/削除・load-more・自動リフレッシュのパッチなどで `rows` が別の配列に置き換わると
 * `WeakMap` のキー (配列の同一性) が変わり、自動的に見つからなくなる。呼び出し側は
 * JS の行を送る従来の経路へ戻る — つまり JS 側の行配列とバックエンドの保持行がずれたら、
 * ハンドルを使わない (整合性優先)。`streamStats.ts` / `refreshPatch.ts` と同じ方式。
 */

/** これ以上の行数の結果だけ、ソート・フィルタ・検索をバックエンドのハンドル経由にする。 */
export const HANDLE_SORT_MIN_ROWS = 50_000;

/** ハンドル経由の結果内検索で受け取るヒット数の上限。 */
export const HANDLE_FIND_LIMIT = 10_000;

/** バックエンド (`db/result_store.rs::RESULT_GONE`) が「ハンドルが無い」エラーに付ける接頭辞。 */
export const RESULT_GONE_MARKER = "result handle gone";

interface Attached {
  id: string;
  rowCount: number;
}

const registry = new WeakMap<object, Attached>();

/** `rows` の内容に対応するハンドルを登録する。 */
export function attachResultHandle(rows: CellValue[][], id: string | null | undefined): void {
  if (id) registry.set(rows, { id, rowCount: rows.length });
}

/**
 * `rows` に対応するハンドル ID を返す。無い・行数が食い違う (= 配列が後から変わった)
 * ときは `null`。
 */
export function resultHandleFor(rows: CellValue[][] | null | undefined): string | null {
  if (!rows) return null;
  const a = registry.get(rows);
  return a && a.rowCount === rows.length ? a.id : null;
}

/** ソート・フィルタ・検索をハンドル経由にしてよい大きさか。 */
export function shouldUseHandleForGrid(rows: CellValue[][] | null | undefined): string | null {
  if (!rows || rows.length < HANDLE_SORT_MIN_ROWS) return null;
  return resultHandleFor(rows);
}

/** バックエンドが「ハンドルが破棄済み」と返したエラーか (rows 付きで再試行する合図)。 */
export function isResultGoneError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.includes(RESULT_GONE_MARKER);
}
