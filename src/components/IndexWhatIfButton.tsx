import { lazy, Suspense, useState } from "react";
import type { IndexWhatIfOutcome } from "../api/tauri";
import { useT } from "../i18n";
import type { WhatIfDescriptor } from "./IndexWhatIfModal";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

// 比較モーダルは ExplainViewer を内部で使うため、静的 import の循環を避けて遅延読み込みする。
const PlanCompareModal = lazy(() =>
  import("./PlanCompareModal").then((m) => ({ default: m.PlanCompareModal })),
);
const IndexWhatIfModal = lazy(() =>
  import("./IndexWhatIfModal").then((m) => ({ default: m.IndexWhatIfModal })),
);

/**
 * EXPLAIN タブのバーに置く「インデックス試算」(#2326)。押すと試算の条件を選ぶモーダルが開き、
 * 試算が終わると今の計画との比較 (`PlanCompareModal`) に切り替わる。
 */
export function IndexWhatIfButton({
  sessionId,
  driver,
  sql,
  database,
  disabled,
  initial,
  editableSql,
}: {
  sessionId: string;
  driver: string;
  sql: string | null;
  database: string | null;
  disabled: boolean;
  /** 選んでおく表・インデックス (アドバイザの未使用インデックスの指摘から開くとき)。 */
  initial?: { table: string; index?: string };
  /** SQL を画面で入力させる (アドバイザから開くとき)。 */
  editableSql?: boolean;
}) {
  const t = useT();
  const [step, setStep] = useState<
    { kind: "form" } | { kind: "compare"; outcome: IndexWhatIfOutcome; desc: WhatIfDescriptor } | null
  >(null);
  const usable = !disabled && (editableSql || (sql !== null && sql.trim() !== ""));
  const desc = step?.kind === "compare" ? step.desc : null;
  const afterName = desc?.action === "disable" ? desc.index : (desc?.columns.join(", ") ?? "");
  return (
    <>
      <Tooltip label={t("indexWhatIfOpenTip")} focusableWrapper={!usable}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!usable}
          onClick={() => setStep({ kind: "form" })}
        >
          {t("indexWhatIfOpen")}
        </Button>
      </Tooltip>
      <Suspense fallback={null}>
        {step?.kind === "form" && (
          <IndexWhatIfModal
            sessionId={sessionId}
            driver={driver}
            sql={sql ?? ""}
            initial={initial}
            editableSql={editableSql}
            database={database}
            onResult={(outcome, d) => setStep({ kind: "compare", outcome, desc: d })}
            onClose={() => setStep(null)}
          />
        )}
        {step?.kind === "compare" && desc && (
          <PlanCompareModal
            driver={driver}
            before={step.outcome.before}
            after={step.outcome.after}
            beforeLabel={t("indexWhatIfPaneBefore")}
            labels={{
              title: t(desc.action === "disable" ? "indexWhatIfCompareDisable" : "indexWhatIfCompareAdd"),
              beforeColumn: t("indexWhatIfColBefore"),
              afterColumn: t(desc.action === "disable" ? "indexWhatIfColDisable" : "indexWhatIfColAdd", {
                name: afterName,
              }),
              beforePane: t("indexWhatIfPaneBefore"),
              afterPane: t(desc.action === "disable" ? "indexWhatIfPaneDisable" : "indexWhatIfPaneAdd", {
                name: afterName,
                table: desc.table,
              }),
            }}
            onClose={() => setStep(null)}
          />
        )}
      </Suspense>
    </>
  );
}
