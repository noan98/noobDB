import { chakra } from "@chakra-ui/react";
import { Tooltip } from "./Tooltip";
import { Icon, ICON_SIZES } from "./Icon";
import { useT } from "../i18n";
import type { SqlEditToggleView } from "../sqlResultEdit";

/**
 * SQL タブの結果ツールバーに出す「編集モード」トグル (#2355)。編集できない結果では無効にして
 * 理由をツールチップで示す。判定は `sqlResultEdit.ts` (純ロジック)。
 */
export function SqlEditToggle({ view, onToggle }: { view: SqlEditToggleView; onToggle: () => void }) {
  const t = useT();
  const unavailable = view.state === "unavailable";
  const label = unavailable ? t(`sqlEditBlock_${view.reason}`) : t("sqlEditToggleTip");
  return (
    <Tooltip label={label}>
      <chakra.label
        display="inline-flex"
        alignItems="center"
        gap="1"
        fontSize="xs"
        whiteSpace="nowrap"
        color={unavailable ? "app.textMuted" : "app.text"}
        cursor={unavailable ? "not-allowed" : "pointer"}
        data-testid="sql-edit-toggle"
      >
        <chakra.input
          type="checkbox"
          checked={view.state === "on"}
          disabled={unavailable}
          aria-label={unavailable ? `${t("sqlEditToggleLabel")}: ${label}` : t("sqlEditToggleLabel")}
          onChange={onToggle}
        />
        <Icon name="pencil" size={ICON_SIZES.sm} />
        {t("sqlEditToggleLabel")}
      </chakra.label>
    </Tooltip>
  );
}
