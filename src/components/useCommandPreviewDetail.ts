import { useCallback, useEffect, useRef, useState } from "react";
import {
  TABLE_DETAIL_CACHE_LIMIT,
  tableDetailKey,
  type PreviewSource,
  type TableDetail,
} from "./commandPalettePreview";

/** カーソルが止まってから描画・取得を始めるまでの待ち (ms)。↑↓ の連打では間引く。 */
export const PREVIEW_DEBOUNCE_MS = 100;

/**
 * 値を `delay` ms だけ遅らせて追従させる。連続して変わる間は古い値のまま据え置く。
 * 最初の値はすぐ返す (パレットを開いた瞬間の先頭候補は待たせない)。
 * 2 つ目の戻り値 `flush` は待たずに最新値へ追いつかせる (Tab でプレビューへ移る直前など)。
 */
export function useDebouncedValue<T>(value: T, delay: number): [T, () => void] {
  const [debounced, setDebounced] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (Object.is(debounced, value)) return;
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay, debounced]);
  const flush = useCallback(() => setDebounced(latest.current), []);
  return [debounced, flush];
}

export type TableDetailLoader = (database: string, table: string) => Promise<TableDetail>;

export type TableDetailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; detail: TableDetail }
  | { status: "error" };

/**
 * テーブル候補がプレビュー中のとき、型・PK/FK・行数推定を 1 テーブル分だけ取得する (#2425)。
 *
 * - 取得はデバウンス済みの `source` が変わったときだけ。移動して離れたら結果は捨てる (取り消し)。
 * - 取得済みはこのインスタンスのキャッシュ (`TABLE_DETAIL_CACHE_LIMIT` 件、古い順に破棄) を使い、
 *   同じテーブルへ戻っても再取得しない。失敗もキャッシュして連打で再試行しない。
 * - `loader` が無ければ何もしない (スキーマキャッシュの列名だけを出す)。
 */
export function useCommandPreviewDetail(
  source: PreviewSource | null,
  loader: TableDetailLoader | undefined,
): TableDetailState {
  const cache = useRef<Map<string, TableDetail | "error">>(new Map());
  const [state, setState] = useState<TableDetailState>({ status: "none" });
  const latestLoader = useRef(loader);
  latestLoader.current = loader;
  const hasLoader = loader !== undefined;
  const database = source?.kind === "table" ? source.database : null;
  const table = source?.kind === "table" ? source.table : null;

  useEffect(() => {
    if (database === null || table === null || !hasLoader) {
      setState({ status: "none" });
      return;
    }
    const key = tableDetailKey(database, table);
    const hit = cache.current.get(key);
    if (hit !== undefined) {
      setState(hit === "error" ? { status: "error" } : { status: "ready", detail: hit });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const load = latestLoader.current;
    if (!load) return;
    load(database, table).then(
      (detail) => {
        remember(cache.current, key, detail);
        if (!cancelled) setState({ status: "ready", detail });
      },
      () => {
        remember(cache.current, key, "error");
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [database, table, hasLoader]);

  return state;
}

function remember(cache: Map<string, TableDetail | "error">, key: string, value: TableDetail | "error") {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > TABLE_DETAIL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
