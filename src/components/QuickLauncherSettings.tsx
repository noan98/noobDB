import { chakra, Flex } from "@chakra-ui/react";
import { useT, type I18nKey } from "../i18n";
import {
  MAX_QUICK_LAUNCHER_SECTION_LIMIT,
  MIN_QUICK_LAUNCHER_SECTION_LIMIT,
  QUICK_LAUNCHER_SECTIONS,
  clearLauncherPosition,
  type QuickLauncherSectionId,
} from "../quickLauncher";
import { setQuickLauncherEnabled, setQuickLauncherSectionLimit, useSettings } from "../settings";
import { SettingsInfo, SettingsNumberRow, SettingsToggleLabel, SettingsToggleRow } from "./settingsLayout";
import { Button, Input, Switch } from "./ui";

/** セクション → 見出しの i18n キー (ランチャー本体と共有)。 */
export const QUICK_LAUNCHER_SECTION_LABEL: Record<QuickLauncherSectionId, I18nKey> = {
  favoriteSnippets: "quickLauncherSectionFavoriteSnippets",
  recentQueries: "quickLauncherSectionRecentQueries",
  favoriteTables: "quickLauncherSectionFavoriteTables",
  recentTables: "quickLauncherSectionRecentTables",
};

/** 位置リセットを (開いている) ランチャーへ伝えるイベント名。 */
export const QUICK_LAUNCHER_RESET_EVENT = "noobdb:quick-launcher-reset";

/** 保存位置を消し、表示中のランチャーを初期位置 (右下) へ戻す。 */
export function resetQuickLauncherPosition(): void {
  clearLauncherPosition();
  try {
    window.dispatchEvent(new Event(QUICK_LAUNCHER_RESET_EVENT));
  } catch {
    // window が無い環境では何もしない。
  }
}

/**
 * 設定画面「フローティング・ランチャー」(#1254) の中身。表示/非表示・各セクションの
 * 表示件数・位置のリセットを扱う。
 */
export function QuickLauncherSettings() {
  const t = useT();
  const settings = useSettings();
  return (
    <Flex direction="column" gap="2">
      <SettingsToggleRow>
        <SettingsToggleLabel htmlFor="settings-quick-launcher-enabled">
          {t("quickLauncherSettingsEnabled")}
        </SettingsToggleLabel>
        <Switch
          id="settings-quick-launcher-enabled"
          checked={settings.quickLauncherEnabled}
          onChange={setQuickLauncherEnabled}
        />
      </SettingsToggleRow>
      <Flex direction="column" gap="2" role="group" aria-label={t("quickLauncherSettingsLimits")}>
        {QUICK_LAUNCHER_SECTIONS.map((id) => (
          <SectionLimitRow
            key={id}
            id={id}
            label={t(QUICK_LAUNCHER_SECTION_LABEL[id])}
            value={settings.quickLauncherSectionLimits[id]}
            disabled={!settings.quickLauncherEnabled}
          />
        ))}
      </Flex>
      <chakra.span fontSize="sm" color="app.textMuted">
        {t("quickLauncherSettingsLimitsHelp", {
          min: MIN_QUICK_LAUNCHER_SECTION_LIMIT,
          max: MAX_QUICK_LAUNCHER_SECTION_LIMIT,
        })}
      </chakra.span>
      <Flex align="center" gap="2" wrap="wrap">
        <Button type="button" variant="secondary" size="sm" onClick={resetQuickLauncherPosition}>
          {t("quickLauncherResetPosition")}
        </Button>
        <SettingsInfo>{t("quickLauncherResetPositionHelp")}</SettingsInfo>
      </Flex>
    </Flex>
  );
}

function SectionLimitRow({
  id,
  label,
  value,
  disabled,
}: {
  id: QuickLauncherSectionId;
  label: string;
  value: number;
  disabled: boolean;
}) {
  const inputId = `settings-quick-launcher-limit-${id}`;
  return (
    <SettingsNumberRow>
      <chakra.label htmlFor={inputId}>{label}</chakra.label>
      <Input
        id={inputId}
        type="number"
        min={MIN_QUICK_LAUNCHER_SECTION_LIMIT}
        max={MAX_QUICK_LAUNCHER_SECTION_LIMIT}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n)) setQuickLauncherSectionLimit(id, n);
        }}
      />
    </SettingsNumberRow>
  );
}
