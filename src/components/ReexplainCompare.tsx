import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { QueryResult } from "../api/tauri";
import { useExplainPin } from "../explainPins";

// 比較モーダルは ExplainViewer を内部で使うため、静的 import の循環を避けて遅延読み込みする。
const PlanCompareModal = lazy(() =>
  import("./PlanCompareModal").then((m) => ({ default: m.PlanCompareModal })),
);

/**
 * 「再 EXPLAIN して比較」 (#2327)。`requestId` が増えたら、そのときの結果を基準として覚え、
 * 再 EXPLAIN が流れ終わって新しい結果に変わったところで、固定した計画との比較モーダルを開く。
 * 再 EXPLAIN が失敗して結果が変わらなければ何も開かない。
 */
export function ReexplainCompare({
  requestId,
  scope,
  driver,
  result,
  streaming,
  analyze,
}: {
  requestId: number;
  scope: string;
  driver: string;
  result: QueryResult | null;
  streaming: boolean;
  analyze: boolean;
}) {
  const pinned = useExplainPin(scope);
  const [open, setOpen] = useState(false);
  const waiting = useRef<{ baseline: QueryResult | null; sawStreaming: boolean } | null>(null);
  const lastRequest = useRef(0);

  useEffect(() => {
    if (requestId !== lastRequest.current) {
      lastRequest.current = requestId;
      waiting.current = { baseline: result, sawStreaming: streaming };
      return;
    }
    const w = waiting.current;
    if (!w) return;
    if (streaming) {
      w.sawStreaming = true;
      return;
    }
    if (!w.sawStreaming) return;
    waiting.current = null;
    if (result !== null && result !== w.baseline) setOpen(true);
  }, [requestId, result, streaming]);

  if (!open || !pinned || !result || pinned.driver !== driver) return null;
  return (
    <Suspense fallback={null}>
      <PlanCompareModal
        driver={driver}
        before={pinned.result}
        after={result}
        beforeLabel={new Date(pinned.pinnedAt).toLocaleTimeString()}
        beforeAnalyze={pinned.analyze}
        afterAnalyze={analyze}
        onClose={() => setOpen(false)}
      />
    </Suspense>
  );
}
