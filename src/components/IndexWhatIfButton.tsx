import { lazy, Suspense, useState } from "react";
import { Flex } from "@chakra-ui/react";
import type { IndexWhatIfOutcome } from "../api/tauri";
import { useT } from "../i18n";
import type { WhatIfDescriptor } from "./IndexWhatIfModal";
import { Callout } from "./Callout";
import { SqlPreview } from "./SqlPreview";
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
 * 比較の下の補足: 試算で実際に実行した文 (折りたたみ) と、MySQL の IGNORE INDEX が一部の表参照にしか
 * 効いていない可能性の注意。
 */
function WhatIfFootnote({ outcome, driver }: { outcome: IndexWhatIfOutcome; driver: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const partial =
    outcome.refsApplied !== null &&
    outcome.refsMentioned !== null &&
    outcome.refsApplied < outcome.refsMentioned;
  return (
    <Flex direction="column" gap="2">
      {partial && <Callout tone="warning">{t("indexWhatIfPartialRefs")}</Callout>}
      <Flex>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("indexWhatIfHideStatements") : t("indexWhatIfShowStatements")}
        </Button>
      </Flex>
      {open && <SqlPreview sql={outcome.statements.join(";\n")} driver={driver} />}
    </Flex>
  );
}

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
            footnote={<WhatIfFootnote outcome={step.outcome} driver={driver} />}
            onClose={() => setStep(null)}
          />
        )}
      </Suspense>
    </>
  );
}
