import { lazy, Suspense, useState } from "react";
import { Flex } from "@chakra-ui/react";
import type { QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { clearExplainPin, pinExplainPlan, useExplainPin } from "../explainPins";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

// 比較モーダルは ExplainViewer を内部で使うため、静的 import の循環を避けて遅延読み込みする。
const PlanCompareModal = lazy(() =>
  import("./PlanCompareModal").then((m) => ({ default: m.PlanCompareModal })),
);

/**
 * EXPLAIN タブのバーに置く「計画を固定 / 固定と比較 / 固定を解除」 (#1539)。
 * 固定は在メモリのみ (`explainPins.ts`)。固定した計画と今の計画が同じ接続方言のときだけ
 * 比較でき、比較は `PlanCompareModal` に委ねる。
 */
export function PlanPinControls({
  scope,
  sql,
  driver,
  result,
  canPin,
  analyze,
}: {
  scope: string;
  sql: string | null;
  driver: string;
  result: QueryResult | null;
  canPin: boolean;
  analyze: boolean;
}) {
  const t = useT();
  const pinned = useExplainPin(scope);
  const [comparing, setComparing] = useState(false);
  const sameDriver = pinned !== null && pinned.driver === driver;
  const canCompare = sameDriver && canPin && result !== null;
  const pinnedAt = pinned ? new Date(pinned.pinnedAt).toLocaleTimeString() : "";

  return (
    <Flex align="center" gap="1.5">
      <Tooltip label={t("planPinTooltip")} focusableWrapper={!canPin}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canPin || result === null}
          onClick={() => {
            if (result) pinExplainPlan(scope, { result, driver, pinnedAt: Date.now(), sql, analyze });
          }}
        >
          <Icon name="pin" size={ICON_SIZES.sm} />
          {pinned ? t("planPinRepin", { at: pinnedAt }) : t("planPin")}
        </Button>
      </Tooltip>
      {pinned && (
        <>
          <Tooltip
            label={!sameDriver ? t("planCompareDriverMismatch") : t("planCompareTooltip")}
            focusableWrapper={!canCompare}
          >
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={!canCompare}
              onClick={() => setComparing(true)}
            >
              {t("planCompareOpen")}
            </Button>
          </Tooltip>
          <Tooltip label={t("planPinClear")}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label={t("planPinClear")}
              onClick={() => clearExplainPin(scope)}
            >
              <Icon name="close" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
        </>
      )}
      {comparing && pinned && result && (
        <Suspense fallback={null}>
          <PlanCompareModal
            driver={driver}
            before={pinned.result}
            after={result}
            beforeLabel={pinnedAt}
            onClose={() => setComparing(false)}
          />
        </Suspense>
      )}
    </Flex>
  );
}
