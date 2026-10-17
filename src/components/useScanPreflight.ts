// SELECT 実行前のスキャン行数 / フルスキャン警告プリフライト (#1508) の実行フック。
// 純ロジック (`scanPreflight.ts`) が組み立てた EXPLAIN 文をデバウンス付きで裏実行する。
// 構造は `usePreflight.ts` (影響行数) と同じ。
//
// - **履歴を汚さない**: 実行は `api.runQuery` (非ストリーミング経路)。EXPLAIN は計画を
//   立てるだけでクエリ自体は実行しない。
// - **編集続行で打ち切り**: 入力のたびに `runId` を進め、古い結果は捨てる。
// - **入力中のエラーは黙る**: 編集途中の SQL は EXPLAIN が失敗しやすい (未完成の識別子・
//   プレースホルダなど)。失敗やプラン無しは結果 null (バッジ非表示) に倒し、入力のたびに
//   「推定不可」が点滅しないようにする。
// - **read_only セッションでも安全**: EXPLAIN は読み取り。

import { useEffect, useRef, useState } from "react";
import { api } from "../api/tauri";
import { PREFLIGHT_MAX_CHARS } from "./preflight";
import { buildScanPlan, summarizeScan, type ScanSummary } from "./scanPreflight";

/** EXPLAIN を裏実行するまでのデバウンス遅延 (ms)。エディタ側のテキストデバウンスを差し引いた値。 */
const SCAN_PREFLIGHT_DEBOUNCE_MS = 350;

export interface ScanPreflightResult {
  /** この結果が対象とする厳密な SQL テキスト。 */
  sql: string;
  /**
   * - `estimating`  : EXPLAIN を裏実行中。
   * - `ready`       : `summary` が確定。
   * - `unestimable` : 集合演算・サブクエリなど解析対象外の形状。
   */
  status: "estimating" | "ready" | "unestimable";
  summary: ScanSummary | null;
  /** ソート・集約の無い LIMIT 付き SELECT (実読み取りが少ない)。バッジの警告を和らげる。 */
  cheapLimit: boolean;
}

export function useScanPreflight(params: {
  /** プリフライト対象のテキスト (選択があれば選択、無ければ全文)。 */
  sql: string | null;
  sessionId: string | null;
  database: string | null;
  /** 設定 `scanPreflightEnabled` かつ接続中のとき true。 */
  enabled: boolean;
  driver?: string;
}): ScanPreflightResult | null {
  const { sql, sessionId, database, enabled, driver } = params;
  const [result, setResult] = useState<ScanPreflightResult | null>(null);
  const runIdRef = useRef(0);
  // single-flight: EXPLAIN は同時に 1 本だけ流す。編集のたびに古い EXPLAIN を重ねて投げると、
  // 手動トランザクションの ALTER 後などでロック待ちが積もり接続プールが枯れるため、実行中に
  // 来た要求は最新の 1 件だけ覚え、完了後にまとめて 1 回だけ再実行する。
  const inFlightRef = useRef(false);
  const pendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    runIdRef.current += 1;
    const myId = runIdRef.current;
    pendingRef.current = null;

    if (
      !enabled ||
      !sessionId ||
      !driver ||
      !sql ||
      sql.trim().length === 0 ||
      sql.length > PREFLIGHT_MAX_CHARS
    ) {
      setResult(null);
      return;
    }
    const plan = buildScanPlan(sql, driver);
    if (!plan) {
      setResult(null);
      return;
    }
    if (plan.explainSql === null) {
      setResult({ sql, status: "unestimable", summary: null, cheapLimit: false });
      return;
    }
    const explainSql = plan.explainSql;
    const cheapLimit = plan.cheapLimit === true;
    setResult({ sql, status: "estimating", summary: null, cheapLimit });

    const launch = (): void => {
      inFlightRef.current = true;
      void api
        .runQuery(sessionId, explainSql, database)
        .then((res) => {
          if (runIdRef.current !== myId) return;
          const summary = summarizeScan(driver, res);
          setResult(summary ? { sql, status: "ready", summary, cheapLimit } : null);
        })
        .catch(() => {
          if (runIdRef.current !== myId) return;
          setResult(null);
        })
        .finally(() => {
          inFlightRef.current = false;
          const next = pendingRef.current;
          pendingRef.current = null;
          next?.();
        });
    };
    const timer = window.setTimeout(() => {
      if (inFlightRef.current) pendingRef.current = launch;
      else launch();
    }, SCAN_PREFLIGHT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sql, sessionId, database, enabled, driver]);

  return result;
}
