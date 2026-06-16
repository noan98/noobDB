import { useEffect, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  REBINDABLE_SHORTCUTS,
  resolveShortcutBindings,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
  SHORTCUT_SCOPES,
  type ShortcutId,
} from "../shortcuts";
import {
  eventToCombo,
  findShortcutConflicts,
  formatCombo,
} from "../shortcutKeys";
import {
  resetShortcutBindings,
  setShortcutBinding,
  useSettings,
} from "../settings";
import {
  SettingsHelp,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";

const Row = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "2.5",
    p: "2",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
  },
});

const RowLabel = chakra("span", {
  base: { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text", flex: "1 1 auto", minWidth: "180px" },
});

const ComboKbd = chakra("kbd", {
  base: {
    px: "1.5",
    py: "1px",
    borderRadius: "sm",
    borderWidth: "1px",
    borderColor: "app.border",
    bg: "app.surface",
    fontSize: "xs",
    fontFamily: "inherit",
    color: "app.textSecondary",
    whiteSpace: "nowrap",
  },
});

const SmallButton = chakra("button", {
  base: { px: "2.5", py: "1", fontSize: "sm" },
});

const CategoryHeading = chakra("div", {
  base: {
    pt: "1",
    fontSize: "xs",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "app.textMuted",
  },
});

const ConflictNote = chakra("span", {
  base: { fontSize: "xs", fontWeight: 600, color: "var(--status-error)", whiteSpace: "nowrap" },
});

/**
 * キーボードショートカットの再割り当て UI (#557)。
 *
 * - 各「主要アクション」のキーを記録 (record) して上書き・既定リセットできる。
 * - 記録中は capture フェーズで keydown を奪い (`stopImmediatePropagation`)、押された
 *   コンボをそのまま割り当てる。アプリ本体のグローバルハンドラには伝播させない。
 * - 同一スコープ (window グローバル / CodeMirror エディタ) 内で重複した割り当ては
 *   `findShortcutConflicts` で検出し、行に警告を出す。
 * - 解決済みコンボは `shortcuts.ts` の単一ソース由来なので、チートシート/ヘルプにも
 *   即反映される。
 */
export function KeybindingSettings() {
  const t = useT();
  const settings = useSettings();
  const overrides = settings.shortcutOverrides;
  const resolved = resolveShortcutBindings(overrides);
  const conflicts = findShortcutConflicts(resolved, SHORTCUT_SCOPES);
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);

  // 記録中: capture フェーズで keydown を捕まえ、押下されたコンボを割り当てる。
  // 修飾子のみの押下は待機継続、Esc は取消。
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = eventToCombo(e);
      if (combo === null) return;
      setShortcutBinding(recordingId, combo);
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId]);

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <chakra.h3>{t("settingsShortcuts")}</chakra.h3>
        <SmallButton
          type="button"
          onClick={() => {
            setRecordingId(null);
            resetShortcutBindings();
          }}
          disabled={!hasOverrides}
        >
          {t("settingsShortcutsResetAll")}
        </SmallButton>
      </SettingsSectionHeader>
      <SettingsHelp>{t("settingsShortcutsHelp")}</SettingsHelp>

      {SHORTCUT_CATEGORY_ORDER.map((category) => {
        const items = REBINDABLE_SHORTCUTS.filter((s) => s.category === category);
        if (items.length === 0) return null;
        return (
          <chakra.div key={category} display="flex" flexDirection="column" gap="2">
            <CategoryHeading>{t(SHORTCUT_CATEGORY_LABEL[category])}</CategoryHeading>
            {items.map((s) => {
              const isRecording = recordingId === s.id;
              const overridden = s.id in overrides;
              const conflicting = conflicts.has(s.id);
              return (
                <Row key={s.id}>
                  <RowLabel>{t(s.descKey)}</RowLabel>
                  {conflicting && <ConflictNote>{t("settingsShortcutConflict")}</ConflictNote>}
                  <ComboKbd
                    borderColor={conflicting ? "var(--status-error)" : "app.border"}
                  >
                    {formatCombo(resolved[s.id])}
                  </ComboKbd>
                  <SmallButton
                    type="button"
                    onClick={() => setRecordingId(isRecording ? null : s.id)}
                    aria-pressed={isRecording}
                  >
                    {isRecording ? t("settingsShortcutRecording") : t("settingsShortcutRecord")}
                  </SmallButton>
                  <SmallButton
                    type="button"
                    onClick={() => setShortcutBinding(s.id, null)}
                    disabled={!overridden}
                    title={t("settingsReset")}
                  >
                    {t("settingsReset")}
                  </SmallButton>
                </Row>
              );
            })}
          </chakra.div>
        );
      })}
    </SettingsSection>
  );
}
