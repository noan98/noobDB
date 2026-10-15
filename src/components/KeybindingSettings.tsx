import { useEffect, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { semanticColorToken, semanticColorVar } from "../semanticColors";
import {
  REBINDABLE_SHORTCUTS,
  resolveShortcutBindings,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
  SHORTCUT_SCOPES,
  type ShortcutId,
} from "../shortcuts";
import { eventToCombo, findShortcutConflicts, formatCombo } from "../shortcutKeys";
import {
  applyShortcutBindings,
  replaceShortcutBindings,
  resetShortcutBindings,
  sanitizeShortcutOverrides,
  setShortcutBinding,
  useSettings,
} from "../settings";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api/tauri";
import { parseKeybindings, planBindingAssignment, serializeKeybindings } from "../keybindingIO";
import { useToast } from "./Toast";
import {
  SettingsInfo,
  SettingsLabelWithInfo,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";
import { Kbd } from "./Kbd";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

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
  base: {
    margin: 0,
    fontSize: "md",
    fontWeight: 500,
    color: "app.text",
    flex: "1 1 auto",
    minWidth: "180px",
  },
});

const CategoryHeading = chakra("div", {
  base: { pt: "1", textStyle: "overline" },
});

const ConflictNote = chakra("span", {
  base: {
    fontSize: "xs",
    fontWeight: 600,
    color: semanticColorVar("danger", "text"),
    whiteSpace: "nowrap",
  },
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
  const toast = useToast();
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
      // 同じスコープで既に使われているコンボなら、相手に元のコンボを渡して入れ替える (#1631)。
      const plan = planBindingAssignment(overrides, recordingId, combo);
      applyShortcutBindings(plan.changes);
      if (plan.swapped) {
        const label = (id: ShortcutId) =>
          t(REBINDABLE_SHORTCUTS.find((s) => s.id === id)?.descKey ?? "settingsShortcuts");
        toast.info(t("settingsShortcutSwapped", { other: label(plan.swapped) }));
      }
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, overrides, t, toast]);

  const handleExport = async () => {
    try {
      const dest = await saveFileDialog({
        defaultPath: "noobdb-keybindings.json",
        title: t("settingsShortcutsExportTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof dest !== "string" || !dest) return;
      await api.writeTextFile(dest, serializeKeybindings(overrides));
      toast.success(t("settingsShortcutsExportSuccess", { path: dest }));
    } catch (e) {
      toast.error(t("settingsShortcutsIoError", { error: String(e) }));
    }
  };

  const handleImport = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: t("settingsShortcutsImportTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const parsed = parseKeybindings(await api.readTextFile(picked), sanitizeShortcutOverrides);
      if (!parsed.ok) {
        toast.error(t("settingsShortcutsImportInvalid"));
        return;
      }
      replaceShortcutBindings(parsed.bindings);
      toast.success(
        t("settingsShortcutsImportSuccess", {
          count: Object.keys(parsed.bindings).length,
          ignored: parsed.ignored,
          conflicts: parsed.conflicts,
        }),
      );
    } catch (e) {
      toast.error(t("settingsShortcutsIoError", { error: String(e) }));
    }
  };

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsLabelWithInfo>
          <chakra.h3>{t("settingsShortcuts")}</chakra.h3>
          <SettingsInfo>{t("settingsShortcutsHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Button size="sm" type="button" onClick={handleExport}>
          {t("settingsShortcutsExport")}
        </Button>
        <Button size="sm" type="button" onClick={handleImport}>
          {t("settingsShortcutsImport")}
        </Button>
        <Button
          size="sm"
          type="button"
          onClick={() => {
            setRecordingId(null);
            resetShortcutBindings();
          }}
          disabled={!hasOverrides}
        >
          {t("settingsShortcutsResetAll")}
        </Button>
      </SettingsSectionHeader>

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
                  <Kbd
                    splitCombo
                    borderColor={conflicting ? semanticColorToken("danger", "text") : "app.border"}
                  >
                    {formatCombo(resolved[s.id])}
                  </Kbd>
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => setRecordingId(isRecording ? null : s.id)}
                    aria-pressed={isRecording}
                  >
                    {isRecording ? t("settingsShortcutRecording") : t("settingsShortcutRecord")}
                  </Button>
                  <Tooltip label={t("settingsReset")} focusableWrapper={!overridden}>
                    <Button
                      size="sm"
                      type="button"
                      onClick={() => setShortcutBinding(s.id, null)}
                      disabled={!overridden}
                    >
                      {t("settingsReset")}
                    </Button>
                  </Tooltip>
                </Row>
              );
            })}
          </chakra.div>
        );
      })}
    </SettingsSection>
  );
}
