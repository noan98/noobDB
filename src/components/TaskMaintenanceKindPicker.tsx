import { chakra } from "@chakra-ui/react";

import type { TaskMaintenanceKind } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken, type SemanticRole } from "../semanticColors";
import { TASK_MAINTENANCE_LABEL_KEYS } from "../taskFormat";
import { FieldLabel, FormSection } from "./modalForm";
import { Icon, ICON_SIZES } from "./Icon";
import { SelectableCard } from "./ui";
import {
  isMaintenanceSupported,
  maintenanceImpact,
  maintenanceUnsupportedReasonKey,
  TASK_MAINTENANCE_INFO,
  TASK_MAINTENANCE_ORDER,
} from "./taskMaintenance";

/** ロック・書き込みの影響を伝える意味色バッジ。色に加えて文言でも伝える。 */
function ImpactBadge({ tone, children, testId }: { tone: SemanticRole; children: string; testId: string }) {
  return (
    <chakra.span
      px="1.5"
      py="0.5"
      borderRadius="sm"
      border="1px solid"
      borderColor={semanticColorToken(tone, "border")}
      bg={semanticColorToken(tone, "subtle")}
      color={semanticColorToken(tone, "text")}
      textStyle="caption"
      whiteSpace="nowrap"
      data-testid={testId}
    >
      {children}
    </chakra.span>
  );
}

/**
 * 定期メンテナンスの種別を選ぶ説明付きカード (#2096)。効果の 1 行説明と「ロックの重さ」「書き込みを
 * ブロック」のバッジを載せ、選んだドライバで使えない種別は理由付きで無効にする。
 */
export function TaskMaintenanceKindPicker({
  driver,
  value,
  onChange,
}: {
  driver: string | undefined;
  value: TaskMaintenanceKind;
  onChange: (kind: TaskMaintenanceKind) => void;
}) {
  const t = useT();
  return (
    <FormSection>
      <FieldLabel as="div">{t("taskFormMaintenanceKind")}</FieldLabel>
      <chakra.div
        role="group"
        aria-label={t("taskFormMaintenanceKind")}
        display="grid"
        gridTemplateColumns="repeat(2, 1fr)"
        gap="2"
      >
        {TASK_MAINTENANCE_ORDER.map((kind) => {
          const supported = isMaintenanceSupported(driver ?? "mysql", kind);
          const reasonKey = maintenanceUnsupportedReasonKey(driver, kind);
          const impact = maintenanceImpact(driver, kind);
          const info = TASK_MAINTENANCE_INFO[kind];
          return (
            <SelectableCard
              key={kind}
              type="button"
              size="compact"
              disabled={!supported}
              aria-pressed={supported && value === kind}
              onClick={() => onChange(kind)}
              data-testid={`task-maint-kind-${kind}`}
            >
              <chakra.span display="flex" alignItems="center" gap="1.5" textStyle="subheading">
                <Icon name={info.icon} size={ICON_SIZES.md} />
                {t(TASK_MAINTENANCE_LABEL_KEYS[kind])}
              </chakra.span>
              <chakra.span textStyle="caption" color="app.textMuted">
                {supported ? t(info.effectKey) : reasonKey ? t(reasonKey) : null}
              </chakra.span>
              {supported && (
                <chakra.span display="flex" flexWrap="wrap" gap="1">
                  <ImpactBadge
                    tone={impact.lock === "heavy" ? "warning" : "success"}
                    testId={`task-maint-lock-${kind}`}
                  >
                    {t(impact.lock === "heavy" ? "taskMaintLockHeavy" : "taskMaintLockLight")}
                  </ImpactBadge>
                  {impact.blocksReads && (
                    <ImpactBadge tone="danger" testId={`task-maint-blocks-reads-${kind}`}>
                      {t("taskMaintBlocksReads")}
                    </ImpactBadge>
                  )}
                  {impact.blocksWrites && (
                    <ImpactBadge tone="danger" testId={`task-maint-blocks-${kind}`}>
                      {t("taskMaintBlocksWrites")}
                    </ImpactBadge>
                  )}
                </chakra.span>
              )}
            </SelectableCard>
          );
        })}
      </chakra.div>
    </FormSection>
  );
}
