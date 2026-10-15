// スマート値ピッカー (#1067) の副作用層。
//
// `valuePicker.ts` の純ロジックが生成した読み取り専用 SQL を、呼び出し側から
// 渡された `lookup` (App が `api.runLookupQuery` を束ねたもの。バックエンドで
// 読み取り専用ガード・行数上限・`query_timeout_secs` が効く) で実行し、列ごとの
// 候補を保持する。取得に失敗した・未対応の列は候補が空のまま = 従来のテキスト
// 入力へ静かにフォールバックする (エラーは出さない)。
//
// 候補は `<datalist>` で入力欄に紐づけるだけなので、自由入力はそのまま可能で、
// 選んだ値も手で打った値と同じく既存の編集バッファ / 行追加バッファに載る。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueryResult, TableColumnInfo } from "../api/tauri";
import { useSettings } from "../settings";
import { isColumnMasked } from "./columnMask";
import {
  ALLOWED_VALUES_ROW_CAP,
  FK_CANDIDATE_LIMIT,
  buildAllowedValuesQueries,
  buildFkCandidatesSql,
  buildRefColumnsSql,
  isTextDataType,
  fkCandidatesWithLabels,
  pickDisplayColumn,
  refColumnsFromResult,
  collectAllowedValues,
  definitionsFromResult,
  fkSearchTerm,
  pickerKindFor,
  type AllowedValues,
  type PickerKind,
} from "./valuePicker";

/** 読み取り専用の候補取得クエリを実行する関数 (`rowCap` 件で打ち切られる)。 */
export type ValueLookup = (sql: string, rowCap: number) => Promise<QueryResult>;

export interface ValuePickerConfig {
  driver: string;
  database: string | null | undefined;
  table: string | null | undefined;
  columns: TableColumnInfo[] | null | undefined;
  /** 未指定ならピッカーは無効 (候補なし)。 */
  lookup?: ValueLookup;
}

export interface ValuePicker {
  /** 列の候補種別。候補を出せない列は null。 */
  kindOf: (column: string) => PickerKind | null;
  /** 列の現在の候補 (まだ取得していなければ空)。 */
  candidates: (column: string) => string[];
  /** FK 候補の説明文 (参照先の表示列、#1629)。値 → 説明文。無ければ空。 */
  labels: (column: string) => Record<string, string>;
  /** 入力欄を開いた / 入力が変わったときに呼ぶ。必要なら候補を (再) 取得する。 */
  request: (column: string, typed: string) => void;
}

/** FK 前方一致検索のデバウンス (ms)。 */
const FK_DEBOUNCE_MS = 200;
const NO_LABELS: Record<string, string> = {};

export function useValuePicker(cfg: ValuePickerConfig): ValuePicker {
  const { driver, database, table, columns, lookup } = cfg;
  const enabled = !!lookup && !!table && !!columns && columns.length > 0;

  // 型由来の許可値 (クエリ不要) は即時に決まる。PG ENUM / CHECK 由来は初回
  // request 時に 1 度だけ取得して上書きする。
  const typeAllowed = useMemo(
    () => (enabled && columns ? collectAllowedValues(driver, columns) : new Map<string, AllowedValues>()),
    [enabled, driver, columns],
  );
  const [fetchedAllowed, setFetchedAllowed] = useState<Map<string, AllowedValues> | null>(null);
  const [fkValues, setFkValues] = useState<Record<string, string[]>>({});
  const [fkLabels, setFkLabels] = useState<Record<string, Record<string, string>>>({});
  const { columnMaskEnabled, columnMaskPatterns } = useSettings();
  const maskRef = useRef({ enabled: columnMaskEnabled, patterns: columnMaskPatterns });
  maskRef.current = { enabled: columnMaskEnabled, patterns: columnMaskPatterns };
  // 参照先テーブルごとの表示列 (null = 無し)。テーブルが変わったら捨てる。
  const displayCols = useRef<Map<string, Promise<string | null>>>(new Map());

  const tableKey = `${driver}\u0000${database ?? ""}\u0000${table ?? ""}`;
  const allowedRequested = useRef<string | null>(null);
  const fkState = useRef<Map<string, { search: string; seq: number }>>(new Map());
  // fkState をリセットしても巻き戻らない単調増加の連番 (旧テーブルの遅延応答を通さない)。
  const fkSeqRef = useRef(0);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  // テーブルが変わったら取得済みの候補を捨てる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tableKey は本体では使わず、テーブルが変わったら取得済みの候補を捨てるためのトリガー
  useEffect(() => {
    allowedRequested.current = null;
    fkState.current = new Map();
    displayCols.current = new Map();
    // デバウンス中のタイマーは旧テーブルの参照先を握ったクロージャなので解除する。
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    setFetchedAllowed(null);
    setFkValues({});
    setFkLabels({});
  }, [tableKey]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const allowed = fetchedAllowed ?? typeAllowed;
  const metaByName = useMemo(() => new Map((columns ?? []).map((c) => [c.name, c])), [columns]);

  const kindOf = useCallback(
    (column: string): PickerKind | null =>
      enabled ? pickerKindFor(metaByName.get(column), allowed.get(column)) : null,
    [enabled, metaByName, allowed],
  );

  const candidates = useCallback(
    (column: string): string[] => {
      if (!enabled) return [];
      const a = allowed.get(column);
      if (a && a.values.length > 0) return a.values;
      return fkValues[column] ?? [];
    },
    [enabled, allowed, fkValues],
  );

  const labels = useCallback(
    (column: string): Record<string, string> => fkLabels[column] ?? NO_LABELS,
    [fkLabels],
  );

  const loadAllowed = useCallback(() => {
    const run = lookupRef.current;
    if (!run || !table || !columns || allowedRequested.current === tableKey) return;
    allowedRequested.current = tableKey;
    const key = tableKey;
    const queries = buildAllowedValuesQueries(driver, database, table);
    if (queries.length === 0) return;
    void Promise.all(
      queries.map((q) =>
        run(q.sql, ALLOWED_VALUES_ROW_CAP).then(
          (res) => ({ purpose: q.purpose, res }),
          // 未対応バージョン (CHECK_CONSTRAINTS の無い MySQL 等)・権限不足は静かに縮退。
          () => ({ purpose: q.purpose, res: null as QueryResult | null }),
        ),
      ),
    ).then((results) => {
      if (allowedRequested.current !== key) return;
      const pgEnumRows = results.find((r) => r.purpose === "pgEnum")?.res?.rows ?? [];
      const checkDefs = results.flatMap((r) =>
        r.purpose === "check" && r.res ? definitionsFromResult(r.res) : [],
      );
      setFetchedAllowed(collectAllowedValues(driver, columns, pgEnumRows, checkDefs));
    });
  }, [driver, database, table, columns, tableKey]);

  const fetchFk = useCallback(
    (column: string, search: string) => {
      const run = lookupRef.current;
      const meta = metaByName.get(column);
      if (!run || !meta?.referenced_table || !meta.referenced_column) return;
      const seq = ++fkSeqRef.current;
      fkState.current.set(column, { search, seq });
      const refTable = meta.referenced_table;
      const refColumn = meta.referenced_column;
      // 参照先の表示列 (name / title など) を推定する。1 度だけ列一覧を引き、失敗・無しなら
      // null で従来どおり ID だけの候補にする (#1629)。
      let display = displayCols.current.get(refTable);
      if (!display) {
        display = run(buildRefColumnsSql(driver, database, refTable), ALLOWED_VALUES_ROW_CAP).then(
          (res) =>
            pickDisplayColumn(refColumnsFromResult(res), refColumn, (n) =>
              isColumnMasked(n, maskRef.current),
            ),
          () => null,
        );
        displayCols.current.set(refTable, display);
      }
      void display.then((displayColumn) => {
        if (fkState.current.get(column)?.seq !== seq) return;
        const sql = buildFkCandidatesSql({
          driver,
          database,
          refTable,
          refColumn,
          search,
          limit: FK_CANDIDATE_LIMIT,
          textColumn: isTextDataType(meta.data_type),
          displayColumn,
        });
        const apply = (values: string[], lbl: Record<string, string>) => {
          if (fkState.current.get(column)?.seq !== seq) return;
          setFkValues((cur) => ({ ...cur, [column]: values }));
          setFkLabels((cur) => ({ ...cur, [column]: lbl }));
        };
        run(sql, FK_CANDIDATE_LIMIT).then(
          (res) => {
            const r = fkCandidatesWithLabels(res);
            apply(r.values, r.labels);
          },
          () => apply([], NO_LABELS),
        );
      });
    },
    [driver, database, metaByName],
  );

  const request = useCallback(
    (column: string, typed: string) => {
      if (!enabled) return;
      loadAllowed();
      const meta = metaByName.get(column);
      if (!meta?.referenced_table || !meta.referenced_column) return;
      // 許可値 (ENUM / CHECK) が取れている列は FK 検索を省く。
      const a = allowed.get(column);
      if (a && a.values.length > 0) return;
      const search = fkSearchTerm(typed);
      const prev = fkState.current.get(column);
      // 前の検索語用に待機中のタイマーは、同じ検索語へ戻った場合でも必ず取り消す
      // (残すと取り消したはずの検索語で再取得され、候補が入力欄と食い違う)。
      const existing = timers.current.get(column);
      if (existing) {
        clearTimeout(existing);
        timers.current.delete(column);
      }
      if (prev && prev.search === search) return;
      // 初回 (まだ何も取っていない) は即時、入力中の再検索はデバウンスする。
      if (!prev) {
        fetchFk(column, search);
        return;
      }
      timers.current.set(
        column,
        setTimeout(() => {
          timers.current.delete(column);
          fetchFk(column, search);
        }, FK_DEBOUNCE_MS),
      );
    },
    [enabled, loadAllowed, metaByName, allowed, fetchFk],
  );

  return useMemo(() => ({ kindOf, candidates, labels, request }), [kindOf, candidates, labels, request]);
}

/**
 * 入力欄に紐づける候補リスト。`<input list={id}>` と組み合わせる。候補が無ければ
 * 何も描画しない (入力欄は従来のテキスト入力のまま)。
 */
export function ValueDatalist({
  id,
  values,
  labels,
}: {
  id: string;
  values: string[];
  /** 値 → 説明文 (FK の表示列、#1629)。`<option label>` として併記する。 */
  labels?: Record<string, string>;
}) {
  if (values.length === 0) return null;
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} label={labels?.[v] ? `${v} — ${labels[v]}` : undefined} />
      ))}
    </datalist>
  );
}
