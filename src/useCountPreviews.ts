import { useEffect, useMemo, useState } from "react";
import { api } from "./api/tauri";

/** 件数プレビュー 1 件 (`COUNT(*)` を返す読み取り専用 SQL)。 */
export interface CountPreviewItem {
  id: string;
  sql: string;
}

export type CountPreviewState =
  | { status: "loading" }
  | { status: "ok"; count: number }
  | { status: "error"; error: string };

/** 入力の途中で毎回クエリを撃たないための待ち時間 (ミリ秒)。 */
export const COUNT_PREVIEW_DEBOUNCE_MS = 500;
/** 件数プレビューのクエリを打ち切る秒数 (大きな表で UI を待たせない)。 */
const COUNT_PREVIEW_TIMEOUT_SECS = 15;

/** `COUNT(*)` の結果セル (number / 文字列 / bigint の文字列表現) を数値にする。読めなければ null。 */
export function parseCountCell(cell: unknown): number | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return cell;
  if (typeof cell === "string" && /^\d+$/.test(cell.trim())) return Number(cell.trim());
  return null;
}

/**
 * 読み取り専用の件数プレビューを、入力の変化に対してデバウンスしながら実行するフック (#1536)。
 *
 * - 実行は `run_lookup_query` 経由: セッションが `read_only` でも通り (バックエンドが読み取り専用の文
 *   だけを許す)、履歴・結果キャッシュを汚さず、タイムアウトで打ち切られる。
 * - `items` の中身 (id と SQL) が変わらない限り再実行しない。変わったら `COUNT_PREVIEW_DEBOUNCE_MS`
 *   待ってから実行し、待っている間に更に変わったら前の呼び出しを捨てる (古い応答で上書きしない)。
 * - `enabled` が false、または `items` が空なら何も実行しない。
 * 戻り値は id → 状態。まだ実行していない (デバウンス中を含む) id は `loading`。
 */
export function useCountPreviews(
  sessionId: string,
  database: string | null,
  items: readonly CountPreviewItem[],
  enabled = true,
): Record<string, CountPreviewState> {
  const signature = useMemo(() => JSON.stringify(items.map((i) => [i.id, i.sql])), [items]);
  const [settled, setSettled] = useState<{ signature: string; results: Record<string, CountPreviewState> } | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: items は signature が同一なら同じ内容なので signature だけを依存にする
  useEffect(() => {
    if (!enabled || items.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all(
        items.map(async (item): Promise<[string, CountPreviewState]> => {
          try {
            const res = await api.runLookupQuery({
              sessionId,
              sql: item.sql,
              database,
              queryTimeoutSecs: COUNT_PREVIEW_TIMEOUT_SECS,
              rowCap: 1,
            });
            const count = parseCountCell(res.rows[0]?.[0]);
            return [
              item.id,
              count === null ? { status: "error", error: "unexpected result" } : { status: "ok", count },
            ];
          } catch (e) {
            return [item.id, { status: "error", error: String(e) }];
          }
        }),
      ).then((entries) => {
        if (!cancelled) setSettled({ signature, results: Object.fromEntries(entries) });
      });
    }, COUNT_PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, database, signature, enabled]);

  return useMemo(() => {
    const out: Record<string, CountPreviewState> = {};
    for (const item of items) {
      out[item.id] =
        settled?.signature === signature && settled.results[item.id]
          ? settled.results[item.id]
          : { status: "loading" };
    }
    return out;
  }, [items, settled, signature]);
}
