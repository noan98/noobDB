// 実行前の影響行数プリフライト (#737) の実行フック。純ロジック (`preflight.ts`) が
// 組み立てた COUNT クエリを、デバウンス付きで裏実行し結果を返す。
//
// - **履歴を汚さない**: 実行は `api.runQuery` (非ストリーミング経路)。ページングや
//   セル編集の内部クエリと同じく、この経路はクエリ履歴に記録されない。
// - **編集続行で打ち切り**: 入力のたびに `runId` を進め、裏実行の結果が戻った時点で
//   `runId` が一致しなければ結果を捨てる (古い COUNT が新しい編集を上書きしない)。
//   in-flight のクエリ自体はセッションの `query_timeout_secs` が上限を掛ける
//   (`run_query` はストリーム登録されないため mid-flight のサーバ側 abort はしない)。
// - **read_only セッションでも安全**: COUNT は読み取りなので拒否されない。
//
// フック (React 依存) なので純ロジックとは分離し、Vitest 対象は `preflight.ts` 側に
// 寄せている。

import { useEffect, useRef, useState } from "react";
import { api } from "../api/tauri";
import { buildPreflightPlan, type PreflightPlan } from "./preflight";

/** デバウンス遅延 (ms)。SQL lint (#704) と同じ 500ms 目安。 */
const PREFLIGHT_DEBOUNCE_MS = 500;

export interface PreflightResult {
  /**
   * この結果が対象とする厳密な SQL テキスト。`DangerousQueryDialog` へ件数を
   * 引き継ぐ際、実行しようとしている SQL と一致するかの突き合わせに使う。
   */
  sql: string;
  /** 解析で得た計画 (verb / table / allRows / countSql)。 */
  plan: PreflightPlan;
  /** 解決済みの影響行数。counting / unestimable / error では null。 */
  count: number | null;
  /**
   * - `counting`     : COUNT を裏実行中 (まだ数字なし)。
   * - `ready`        : 影響行数が確定 (`count` 有効)。
   * - `unestimable`  : 変換不可能な形状 (数字を出さない)。
   * - `error`        : COUNT の実行に失敗 (推定不可扱い)。
   */
  status: "counting" | "ready" | "unestimable" | "error";
}

/**
 * エディタの現在テキスト (`sql`) を影響行数プリフライトへ掛ける。対象外なら null を
 * 返す (バッジを出さない)。UPDATE / DELETE のときだけ COUNT を裏実行する。
 */
export function usePreflightImpact(params: {
  /** プリフライト対象のテキスト (選択があれば選択、無ければ全文)。空/未対象は null 可。 */
  sql: string | null;
  sessionId: string | null;
  /** COUNT を流すデータベース文脈 (実行時と同じ既定 DB)。 */
  database: string | null;
  /** 設定 `preflightImpactEnabled` かつ接続中のとき true。 */
  enabled: boolean;
}): PreflightResult | null {
  const { sql, sessionId, database, enabled } = params;
  const [result, setResult] = useState<PreflightResult | null>(null);
  // 裏実行の世代トークン。編集や依存変化のたびに進め、古い結果を無効化する。
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    const myId = runIdRef.current;

    if (!enabled || !sessionId || !sql || sql.trim().length === 0) {
      setResult(null);
      return;
    }
    // 計画は同期に組み立て、verb / 全行 / 推定不可を即座にバッジへ反映する。
    const plan = buildPreflightPlan(sql);
    if (!plan) {
      setResult(null);
      return;
    }
    if (plan.countSql === null) {
      setResult({ sql, plan, count: null, status: "unestimable" });
      return;
    }
    // 実 COUNT はデバウンス後に裏実行。まずは「計測中」を出す。
    setResult({ sql, plan, count: null, status: "counting" });
    const countSql = plan.countSql;
    const timer = window.setTimeout(() => {
      void api
        .runQuery(sessionId, countSql, database)
        .then((res) => {
          if (runIdRef.current !== myId) return;
          const raw = res.rows[0]?.[0];
          const n = typeof raw === "number" ? raw : Number(raw);
          const ok = Number.isFinite(n);
          setResult({
            sql,
            plan,
            count: ok ? n : null,
            status: ok ? "ready" : "error",
          });
        })
        .catch(() => {
          if (runIdRef.current !== myId) return;
          setResult({ sql, plan, count: null, status: "error" });
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sql, sessionId, database, enabled]);

  return result;
}
