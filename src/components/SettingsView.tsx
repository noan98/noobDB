import { useEffect, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Modal, ModalBody, ModalHeader } from "./Modal";
import { Input, Select, Switch } from "./ui";
import {
  SettingsHelp,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";
import { copyToClipboard } from "./clipboard";
import { useConfirm } from "./ConfirmDialog";
import { KeybindingSettings } from "./KeybindingSettings";
import { useToast } from "./Toast";
import {
  DEFAULT_AUTO_LIMIT_COUNT,
  DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
  DEFAULT_DISPLAY_COUNT,
  DEFAULT_FONT_SIZE_PX,
  DEFAULT_QUERY_NOTIFICATION_THRESHOLD_SECS,
  DEFAULT_QUERY_TIMEOUT_SECS,
  DEFAULT_STREAM_PREFETCH_SIZE,
  MAX_AUTO_RECONNECT_RETRIES,
  MAX_QUERY_NOTIFICATION_THRESHOLD_SECS,
  MIN_AUTO_RECONNECT_RETRIES,
  MIN_QUERY_NOTIFICATION_THRESHOLD_SECS,
  DENSITY_ORDER,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
  MONO_FONT_PRESETS,
  UI_FONT_PRESETS,
  monoFontStack,
  uiFontStack,
  setMonoFontFamily,
  setUiFontFamily,
  THEME_PRESET_ORDER,
  setThemePreset,
  type ThemePreset,
  RESULT_GRID_PAGE_SIZE_OPTIONS,
  SYNTAX_PRESET_ORDER,
  Density,
  ResultGridMode,
  SyntaxColors,
  SyntaxPresetKey,
  TabRestoreMode,
  Theme,
  applySyntaxPreset,
  deserializeSettingsImport,
  detectSyntaxPreset,
  replaceAllSettings,
  resetAllSettings,
  resetAppearanceDefaults,
  resetPreviewHighlight,
  resetStreamingDefaults,
  resetSyntaxColors,
  serializeSettingsExport,
  setAccentColor,
  setAutoLimitCount,
  setAutoLimitEnabled,
  setAutoReconnectEnabled,
  setAutoReconnectMaxRetries,
  setConfirmDangerousQueries,
  setConfirmProductionConnect,
  setResultsInNewTab,
  setDefaultDisplayCount,
  setDensity,
  setFontSizePx,
  setQueryNotificationsEnabled,
  setQueryNotificationThresholdSecs,
  setAutoUpdateCheckEnabled,
  setQueryTimeoutSecs,
  setPreviewHighlight,
  setCellEditOnBlur,
  setResultGridMode,
  setResultGridPageSize,
  setRichCellRendering,
  setStreamPrefetchSize,
  setSyntaxColor,
  setTabRestoreMode,
  useSettings,
} from "../settings";
import { ACCENT_PRESETS } from "../accent";
import { checkForAppUpdate, getCurrentAppVersion } from "../updater";
import { displayVersion } from "../updaterFormat";
import { confirmAndInstallUpdate } from "./updatePrompt";

interface Props {
  theme: Theme;
  onClose: () => void;
}

/** Sentinel select values for the "default" and "custom" choices. */
const FONT_DEFAULT = "__default__";
const FONT_CUSTOM = "__custom__";

/**
 * Font family picker: a preset dropdown plus a free-form family input
 * (shown when "custom" is chosen), with a live sample rendered in the resulting
 * stack so the user sees the font before committing.
 */
function FontFamilyControl(props: {
  id: string;
  label: string;
  value: string | null;
  presets: readonly string[];
  customLabel: string;
  defaultLabel: string;
  placeholder: string;
  sample: string;
  stack: (family: string | null) => string | null;
  onChange: (value: string | null) => void;
}) {
  const { value, presets, stack } = props;
  const isPreset = value !== null && presets.includes(value);
  const selectValue = value === null ? FONT_DEFAULT : isPreset ? value : FONT_CUSTOM;
  const [customText, setCustomText] = useState(isPreset || value === null ? "" : (value ?? ""));
  useEffect(() => {
    if (value !== null && !presets.includes(value)) setCustomText(value);
  }, [value, presets]);

  const previewStack = stack(value) ?? "var(--font-mono)";

  return (
    <SettingsToggleRow>
      <SettingsToggleLabel as="label" htmlFor={props.id}>
        {props.label}
      </SettingsToggleLabel>
      <Select
        id={props.id}
        width="auto"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === FONT_DEFAULT) props.onChange(null);
          else if (v === FONT_CUSTOM) props.onChange(customText.trim() || null);
          else props.onChange(v);
        }}
      >
        <option value={FONT_DEFAULT}>{props.defaultLabel}</option>
        {presets.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value={FONT_CUSTOM}>{props.customLabel}</option>
      </Select>
      {selectValue === FONT_CUSTOM && (
        <Input
          width="auto"
          aria-label={props.customLabel}
          placeholder={props.placeholder}
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onBlur={() => props.onChange(customText.trim() || null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      )}
      <chakra.span
        aria-hidden="true"
        flex="1"
        minW="120px"
        fontSize="md"
        color="app.text"
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
        style={{ fontFamily: previewStack }}
      >
        {props.sample}
      </chakra.span>
    </SettingsToggleRow>
  );
}

// 各セクション内のレイアウト要素。
const SettingsReset = chakra("button", {
  base: { px: "2.5", py: "1", fontSize: "sm" },
});

const SettingsToggleRow = chakra("div", {
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

const SettingsToggleLabel = chakra("label", {
  base: {
    margin: 0,
    fontSize: "md",
    fontWeight: 500,
    color: "app.text",
    display: "inline-flex",
    alignItems: "center",
    gap: "2",
  },
});

const SettingsHelpInline = chakra("span", {
  base: { fontSize: "sm", color: "app.textMuted" },
});

const SettingsNumberRow = chakra("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "200px 120px 1fr",
    alignItems: "center",
    gap: "3",
    px: "2",
    py: "1.5",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    "& label": { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text" },
    "& input": { fontSize: "md", borderRadius: "sm" },
  },
});

const SettingsTimeoutAux = chakra("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    alignItems: "flex-start",
    minWidth: 0,
  },
});

const SettingsUnlimitedBadge = chakra("span", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    px: "2",
    py: "1px",
    fontSize: "xs",
    fontWeight: 600,
    color: "app.accentText",
    bg: "app.accent",
    borderRadius: "999px",
  },
});

const SettingsPresetRow = chakra("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "120px minmax(200px, 280px) 1fr",
    alignItems: "center",
    gap: "3",
    px: "2",
    py: "1.5",
    mb: "2",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    "& label": { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text" },
  },
});

const SettingsColorGrid = chakra("div", {
  base: { display: "grid", gridTemplateColumns: "1fr", gap: "1.5", mt: "1.5" },
});

const SettingsColorRow = chakra("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    alignItems: "center",
    gap: "3",
    px: "2",
    py: "1.5",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    "& label": { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text" },
  },
});

const SettingsColorControls = chakra("div", {
  base: { display: "flex", alignItems: "center", gap: "2.5" },
});

const SettingsColorInput = chakra("input", {
  base: {
    width: "36px",
    height: "28px",
    p: "0",
    border: "1px solid",
    borderColor: "app.borderStrong",
    borderRadius: "sm",
    bg: "app.bgInput",
    cursor: "pointer",
    flexShrink: 0,
    "&::-webkit-color-swatch-wrapper": { padding: "0.5" },
    "&::-webkit-color-swatch": { border: "none", borderRadius: "var(--radius-sm)" },
  },
});

const SettingsColorHex = chakra("span", {
  base: { fontFamily: "mono", fontSize: "sm", color: "app.textMuted", minWidth: "70px" },
});

const SettingsColorSample = chakra("span", {
  base: { fontFamily: "mono", fontSize: "md", fontWeight: 600 },
});

// 表示密度の 3 択セグメント。アクティブはアクセント地に反転。
const SettingsSegment = chakra("div", {
  base: {
    display: "inline-flex",
    border: "1px solid",
    borderColor: "app.borderStrong",
    borderRadius: "md",
    overflow: "hidden",
    flexShrink: 0,
  },
});

const SettingsSegmentButton = chakra("button", {
  base: {
    px: "3",
    py: "5px",
    fontSize: "sm",
    fontWeight: 500,
    border: "none",
    borderRadius: 0,
    background: "app.surface",
    color: "app.text",
    cursor: "pointer",
    transitionProperty: "background, color",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { background: "app.hover" },
    "&[aria-pressed=true]": {
      background: "app.accent",
      color: "app.accentText",
    },
    "&[aria-pressed=true]:hover": { background: "app.accentHover" },
    "& + &": { borderLeft: "1px solid var(--border-strong)" },
  },
});

// アクセント色のプリセットスウォッチ列。
const SettingsSwatchRow = chakra("div", {
  base: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2" },
});

const SettingsSwatch = chakra("button", {
  base: {
    width: "26px",
    height: "26px",
    p: 0,
    borderRadius: "999px",
    border: "2px solid",
    borderColor: "app.borderStrong",
    background: "app.surfaceMuted",
    cursor: "pointer",
    flexShrink: 0,
    transitionProperty: "box-shadow, transform",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    // "既定 (テーマ追従)" のスウォッチは斜めストライプで他の単色と区別する。
    "&[data-default]": {
      background:
        "repeating-linear-gradient(45deg, var(--bg-muted), var(--bg-muted) 4px, var(--border-strong) 4px, var(--border-strong) 8px)",
    },
    "&[aria-pressed=true]": {
      borderColor: "app.text",
      boxShadow: "inset 0 0 0 2px var(--bg-elevated)",
    },
    _focusVisible: {
      outline: "none",
      boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)",
    },
  },
});

const SettingsLogsActions = chakra("div", {
  base: { display: "flex", alignItems: "center", gap: "2" },
});

const SettingsLogsIconButton = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    w: "28px",
    h: "28px",
    p: 0,
    color: "app.textSecondary",
    borderRadius: "sm",
    cursor: "pointer",
    transitionProperty: "color, background",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { color: "app.text", bg: "app.hover" },
    _disabled: { opacity: 0.35, cursor: "not-allowed" },
  },
});

const SettingsLogsView = chakra("textarea", {
  base: {
    mt: "1.5",
    width: "100%",
    height: "260px",
    resize: "vertical",
    px: "2.5",
    py: "2",
    fontFamily: "mono",
    fontSize: "sm",
    lineHeight: "1.5",
    whiteSpace: "pre",
    overflow: "auto",
    border: "1px solid",
    borderColor: "app.borderStrong",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    color: "app.text",
  },
});

const SettingsLogsPath = chakra("span", {
  base: {
    fontSize: "sm",
    color: "app.textMuted",
    fontFamily: "mono",
    wordBreak: "break-all",
  },
});

interface Field {
  key: keyof SyntaxColors;
  labelKey: Parameters<ReturnType<typeof useT>>[0];
  sampleKey: Parameters<ReturnType<typeof useT>>[0];
}

const FIELDS: Field[] = [
  { key: "keyword", labelKey: "settingsColorKeyword", sampleKey: "settingsColorKeywordSample" },
  { key: "string", labelKey: "settingsColorString", sampleKey: "settingsColorStringSample" },
  { key: "number", labelKey: "settingsColorNumber", sampleKey: "settingsColorNumberSample" },
  { key: "comment", labelKey: "settingsColorComment", sampleKey: "settingsColorCommentSample" },
  { key: "function", labelKey: "settingsColorFunction", sampleKey: "settingsColorFunctionSample" },
  { key: "operator", labelKey: "settingsColorOperator", sampleKey: "settingsColorOperatorSample" },
];

const PRESET_LABEL_KEYS: Record<SyntaxPresetKey, Parameters<ReturnType<typeof useT>>[0]> = {
  defaultLight: "settingsSyntaxPresetDefaultLight",
  defaultDark: "settingsSyntaxPresetDefaultDark",
  solarizedLight: "settingsSyntaxPresetSolarizedLight",
  solarizedDark: "settingsSyntaxPresetSolarizedDark",
  dracula: "settingsSyntaxPresetDracula",
  githubLight: "settingsSyntaxPresetGithubLight",
  githubDark: "settingsSyntaxPresetGithubDark",
  monokai: "settingsSyntaxPresetMonokai",
};

const DENSITY_LABEL_KEYS: Record<Density, Parameters<ReturnType<typeof useT>>[0]> = {
  compact: "settingsDensityCompact",
  normal: "settingsDensityNormal",
  spacious: "settingsDensitySpacious",
};

const THEME_PRESET_LABEL_KEYS: Record<ThemePreset, Parameters<ReturnType<typeof useT>>[0]> = {
  default: "themePresetDefault",
  dracula: "themePresetDracula",
  "high-contrast": "themePresetHighContrast",
  colorblind: "themePresetColorblind",
};

const ACCENT_LABEL_KEYS: Record<string, Parameters<ReturnType<typeof useT>>[0]> = {
  default: "settingsAccentDefault",
  blue: "settingsAccentBlue",
  indigo: "settingsAccentIndigo",
  violet: "settingsAccentViolet",
  teal: "settingsAccentTeal",
  green: "settingsAccentGreen",
  amber: "settingsAccentAmber",
  rose: "settingsAccentRose",
};

export function SettingsView({ theme, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const settings = useSettings();
  const colors = settings.syntaxColors[theme];
  const previewHighlight = settings.previewHighlight[theme];
  const themeLabel = t(theme === "dark" ? "settingsThemeDark" : "settingsThemeLight");

  // Local input state so users can clear the field while typing without
  // snapping back to the persisted value on each keystroke.
  const [displayInput, setDisplayInput] = useState(String(settings.defaultDisplayCount));
  const [prefetchInput, setPrefetchInput] = useState(String(settings.streamPrefetchSize));
  const [autoLimitInput, setAutoLimitInput] = useState(String(settings.autoLimitCount));
  const [timeoutInput, setTimeoutInput] = useState(String(settings.queryTimeoutSecs));
  const [reconnectRetriesInput, setReconnectRetriesInput] = useState(
    String(settings.autoReconnectMaxRetries),
  );
  const [fontSizeInput, setFontSizeInput] = useState(String(settings.fontSizePx));
  const [notifyThresholdInput, setNotifyThresholdInput] = useState(
    String(settings.queryNotificationThresholdSecs),
  );
  useEffect(() => setDisplayInput(String(settings.defaultDisplayCount)), [settings.defaultDisplayCount]);
  useEffect(() => setPrefetchInput(String(settings.streamPrefetchSize)), [settings.streamPrefetchSize]);
  useEffect(() => setAutoLimitInput(String(settings.autoLimitCount)), [settings.autoLimitCount]);
  useEffect(() => setTimeoutInput(String(settings.queryTimeoutSecs)), [settings.queryTimeoutSecs]);
  useEffect(
    () => setReconnectRetriesInput(String(settings.autoReconnectMaxRetries)),
    [settings.autoReconnectMaxRetries],
  );
  useEffect(() => setFontSizeInput(String(settings.fontSizePx)), [settings.fontSizePx]);
  useEffect(
    () => setNotifyThresholdInput(String(settings.queryNotificationThresholdSecs)),
    [settings.queryNotificationThresholdSecs],
  );

  const commitDisplay = () => {
    const n = Number.parseInt(displayInput, 10);
    if (Number.isFinite(n) && n > 0) setDefaultDisplayCount(n);
    else setDisplayInput(String(settings.defaultDisplayCount));
  };
  const commitPrefetch = () => {
    const n = Number.parseInt(prefetchInput, 10);
    if (Number.isFinite(n) && n > 0) setStreamPrefetchSize(n);
    else setPrefetchInput(String(settings.streamPrefetchSize));
  };
  const commitAutoLimit = () => {
    const n = Number.parseInt(autoLimitInput, 10);
    if (Number.isFinite(n) && n > 0) setAutoLimitCount(n);
    else setAutoLimitInput(String(settings.autoLimitCount));
  };
  const commitTimeout = () => {
    const n = Number.parseInt(timeoutInput, 10);
    if (Number.isFinite(n) && n >= 0) setQueryTimeoutSecs(n);
    else setTimeoutInput(String(settings.queryTimeoutSecs));
  };
  const commitNotifyThreshold = () => {
    const n = Number.parseInt(notifyThresholdInput, 10);
    if (Number.isFinite(n)) setQueryNotificationThresholdSecs(n);
    else setNotifyThresholdInput(String(settings.queryNotificationThresholdSecs));
  };
  const commitReconnectRetries = () => {
    const n = Number.parseInt(reconnectRetriesInput, 10);
    if (Number.isFinite(n)) setAutoReconnectMaxRetries(n);
    else setReconnectRetriesInput(String(settings.autoReconnectMaxRetries));
  };
  const commitFontSize = () => {
    const n = Number.parseInt(fontSizeInput, 10);
    if (Number.isFinite(n)) setFontSizePx(n);
    else setFontSizeInput(String(settings.fontSizePx));
  };

  const [logText, setLogText] = useState("");
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logCopied, setLogCopied] = useState(false);

  // アプリ内自動更新 (#705): 現在バージョン表示と手動チェック。
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  useEffect(() => {
    let active = true;
    void getCurrentAppVersion().then((v) => {
      if (active) setAppVersion(v);
    });
    return () => {
      active = false;
    };
  }, []);
  const handleCheckForUpdates = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const update = await checkForAppUpdate();
      if (!update) {
        toast.success(t("updateUpToDate", { version: displayVersion(appVersion) }));
        return;
      }
      await confirmAndInstallUpdate(update, { t, toast, confirm });
    } catch {
      // 手動チェックは失敗を明示的に知らせる (起動時の静かな無視とは対照的)。
      toast.error(t("updateCheckFailed"));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const loadLogs = async () => {
    setLogLoading(true);
    try {
      const res = await api.readLogs();
      setLogText(res.text);
      setLogPath(res.path);
    } finally {
      setLogLoading(false);
    }
  };
  useEffect(() => {
    void loadLogs();
  }, []);

  const copyLogs = async () => {
    if (!logText) return;
    const ok = await copyToClipboard(logText);
    if (!ok) {
      toast.error(t("clipboardCopyFailed"));
      return;
    }
    setLogCopied(true);
    setTimeout(() => setLogCopied(false), 1500);
  };
  const clearLogs = async () => {
    const ok = await confirm({
      title: t("settingsLogsClear"),
      message: t("settingsLogsClearConfirm"),
      confirmLabel: t("settingsLogsClear"),
      tone: "danger",
    });
    if (!ok) return;
    await api.clearLogs();
    await loadLogs();
  };

  // 設定のエクスポート/インポート/全初期化 (#679)。接続プロファイル・秘密情報は
  // 対象外 — こちらは既存の `export_profiles` / `import_profiles` (#442) が担う。
  const handleExportSettings = async () => {
    try {
      const dest = await saveFileDialog({
        defaultPath: "noobdb-settings.json",
        title: t("settingsBackupExportTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof dest !== "string" || !dest) return;
      const json = serializeSettingsExport(settings);
      await api.writeBinaryFile(dest, new TextEncoder().encode(json));
      toast.success(t("settingsBackupExportSuccess", { path: dest }));
    } catch (e) {
      toast.error(t("settingsBackupExportError", { error: String(e) }));
    }
  };

  const handleImportSettings = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: t("settingsBackupImportTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const raw = await api.readTextFile(picked);
      const next = deserializeSettingsImport(raw);
      const ok = await confirm({
        title: t("settingsBackupImportTitle"),
        message: t("settingsBackupImportConfirm"),
        tone: "warning",
      });
      if (!ok) return;
      replaceAllSettings(next);
      toast.success(t("settingsBackupImportSuccess"));
    } catch (e) {
      toast.error(t("settingsBackupImportError", { error: String(e) }));
    }
  };

  const handleResetAllSettings = async () => {
    const ok = await confirm({
      title: t("settingsBackupResetAllTitle"),
      message: t("settingsBackupResetAllConfirm"),
      tone: "danger",
    });
    if (!ok) return;
    resetAllSettings();
    toast.success(t("settingsBackupResetAllSuccess"));
  };

  return (
    <>
    <Modal onClose={onClose} width="988px">
      <ModalHeader onClose={onClose} closeLabel={t("settingsClose")}>
        {t("settingsTitle")}
      </ModalHeader>
      <ModalBody>
        <chakra.div display="flex" flexDirection="column" gap="18px">
      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsLanguage")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsToggleRow>
          <LanguageSwitcher />
          <SettingsHelpInline>{t("settingsLanguageHelp")}</SettingsHelpInline>
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsAppearance")}</chakra.h3>
          <SettingsReset onClick={resetAppearanceDefaults}>
            {t("settingsReset")}
          </SettingsReset>
        </SettingsSectionHeader>
        <SettingsNumberRow>
          <chakra.label htmlFor="settings-font-size">{t("settingsFontSize")}</chakra.label>
          <Input
            id="settings-font-size"
            type="number"
            min={MIN_FONT_SIZE_PX}
            max={MAX_FONT_SIZE_PX}
            step={1}
            value={fontSizeInput}
            placeholder={String(DEFAULT_FONT_SIZE_PX)}
            onChange={(e) => setFontSizeInput(e.target.value)}
            onBlur={commitFontSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsHelpInline>
            {t("settingsFontSizeHelp", {
              min: MIN_FONT_SIZE_PX,
              max: MAX_FONT_SIZE_PX,
              default: DEFAULT_FONT_SIZE_PX,
            })}
          </SettingsHelpInline>
        </SettingsNumberRow>

        <SettingsToggleRow>
          <SettingsToggleLabel as="span">{t("settingsDensity")}</SettingsToggleLabel>
          <SettingsSegment role="group" aria-label={t("settingsDensity")}>
            {DENSITY_ORDER.map((d) => (
              <SettingsSegmentButton
                key={d}
                type="button"
                aria-pressed={settings.density === d}
                onClick={() => setDensity(d)}
              >
                {t(DENSITY_LABEL_KEYS[d])}
              </SettingsSegmentButton>
            ))}
          </SettingsSegment>
          <SettingsHelpInline>{t("settingsDensityHelp")}</SettingsHelpInline>
        </SettingsToggleRow>

        <FontFamilyControl
          id="settings-mono-font"
          label={t("settingsMonoFont")}
          value={settings.monoFontFamily}
          presets={MONO_FONT_PRESETS}
          defaultLabel={t("settingsFontDefault")}
          customLabel={t("settingsFontCustom")}
          placeholder={t("settingsFontCustomPlaceholder")}
          sample="SELECT 0 != 1; -- il1 O0"
          stack={monoFontStack}
          onChange={setMonoFontFamily}
        />
        <FontFamilyControl
          id="settings-ui-font"
          label={t("settingsUiFont")}
          value={settings.uiFontFamily}
          presets={UI_FONT_PRESETS}
          defaultLabel={t("settingsFontDefault")}
          customLabel={t("settingsFontCustom")}
          placeholder={t("settingsFontCustomPlaceholder")}
          sample={t("settingsFontSample")}
          stack={uiFontStack}
          onChange={setUiFontFamily}
        />

        <SettingsToggleRow>
          <SettingsToggleLabel as="span">{t("settingsThemePreset")}</SettingsToggleLabel>
          <SettingsSegment role="group" aria-label={t("settingsThemePreset")}>
            {THEME_PRESET_ORDER.map((p) => (
              <SettingsSegmentButton
                key={p}
                type="button"
                aria-pressed={settings.themePreset === p}
                onClick={() => setThemePreset(p as ThemePreset)}
              >
                {t(THEME_PRESET_LABEL_KEYS[p])}
              </SettingsSegmentButton>
            ))}
          </SettingsSegment>
          <SettingsHelpInline>{t("settingsThemePresetHelp")}</SettingsHelpInline>
        </SettingsToggleRow>

        <SettingsToggleRow>
          <SettingsToggleLabel as="span">{t("settingsAccentColor")}</SettingsToggleLabel>
          <SettingsSwatchRow role="group" aria-label={t("settingsAccentColor")}>
            {ACCENT_PRESETS.map((p) => {
              const selected =
                p.hex === null
                  ? settings.accentColor === null
                  : settings.accentColor?.toLowerCase() === p.hex.toLowerCase();
              return (
                <SettingsSwatch
                  key={p.key}
                  type="button"
                  aria-pressed={selected}
                  aria-label={t(ACCENT_LABEL_KEYS[p.key])}
                  title={t(ACCENT_LABEL_KEYS[p.key])}
                  data-default={p.hex === null ? "" : undefined}
                  style={p.hex ? { background: p.hex } : undefined}
                  onClick={() => setAccentColor(p.hex)}
                />
              );
            })}
            <SettingsColorInput
              type="color"
              aria-label={t("settingsAccentCustom")}
              title={t("settingsAccentCustom")}
              value={settings.accentColor ?? "#2563eb"}
              onChange={(e) => setAccentColor(e.target.value)}
            />
          </SettingsSwatchRow>
          <SettingsHelpInline>{t("settingsAccentColorHelp")}</SettingsHelpInline>
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsStreaming")}</chakra.h3>
          <SettingsReset onClick={resetStreamingDefaults}>
            {t("settingsReset")}
          </SettingsReset>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsStreamingHelp")}</SettingsHelp>

        <SettingsNumberRow>
          <chakra.label htmlFor="settings-default-display">
            {t("settingsDefaultDisplayCount")}
          </chakra.label>
          <Input
            id="settings-default-display"
            type="number"
            min={1}
            step={10}
            value={displayInput}
            placeholder={String(DEFAULT_DISPLAY_COUNT)}
            onChange={(e) => setDisplayInput(e.target.value)}
            onBlur={commitDisplay}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsHelpInline>
            {t("settingsDefaultDisplayCountHelp")}
          </SettingsHelpInline>
        </SettingsNumberRow>

        <SettingsNumberRow>
          <chakra.label htmlFor="settings-stream-prefetch">
            {t("settingsStreamPrefetchSize")}
          </chakra.label>
          <Input
            id="settings-stream-prefetch"
            type="number"
            min={1}
            step={10}
            value={prefetchInput}
            placeholder={String(DEFAULT_STREAM_PREFETCH_SIZE)}
            onChange={(e) => setPrefetchInput(e.target.value)}
            onBlur={commitPrefetch}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsHelpInline>
            {t("settingsStreamPrefetchSizeHelp")}
          </SettingsHelpInline>
        </SettingsNumberRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsAutoLimit")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsAutoLimitHelp")}</SettingsHelp>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-auto-limit">
            <Switch
              id="settings-auto-limit"
              checked={settings.autoLimitEnabled}
              onChange={setAutoLimitEnabled}
            />
            {t("settingsAutoLimitEnabled")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsAutoLimitEnabledHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsNumberRow>
          <chakra.label htmlFor="settings-auto-limit-count">
            {t("settingsAutoLimitCount")}
          </chakra.label>
          <Input
            id="settings-auto-limit-count"
            type="number"
            min={1}
            step={100}
            value={autoLimitInput}
            placeholder={String(DEFAULT_AUTO_LIMIT_COUNT)}
            disabled={!settings.autoLimitEnabled}
            onChange={(e) => setAutoLimitInput(e.target.value)}
            onBlur={commitAutoLimit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsHelpInline>
            {t("settingsAutoLimitCountHelp")}
          </SettingsHelpInline>
        </SettingsNumberRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsResultGridMode")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsResultGridModeHelp")}</SettingsHelp>
        <SettingsToggleRow>
          <SettingsToggleLabel>
            {t("settingsResultGridMode")}
          </SettingsToggleLabel>
          <Select
            value={settings.resultGridMode}
            onChange={(e) => setResultGridMode(e.target.value as ResultGridMode)}
          >
            <option value="scroll">{t("settingsResultGridModeScroll")}</option>
            <option value="paginate">{t("settingsResultGridModePaginate")}</option>
          </Select>
          <SettingsHelpInline>
            {t("settingsResultGridModeHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsNumberRow>
          <chakra.label htmlFor="settings-page-size">
            {t("settingsResultGridPageSize")}
          </chakra.label>
          <Select
            id="settings-page-size"
            value={String(settings.resultGridPageSize)}
            disabled={settings.resultGridMode !== "paginate"}
            onChange={(e) => setResultGridPageSize(Number(e.target.value))}
          >
            {RESULT_GRID_PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
          <SettingsHelpInline>
            {t("settingsResultGridPageSizeHelp")}
          </SettingsHelpInline>
        </SettingsNumberRow>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-cell-edit-on-blur">
            <Switch
              id="settings-cell-edit-on-blur"
              checked={settings.cellEditOnBlur === "confirm"}
              onChange={(checked) => setCellEditOnBlur(checked ? "confirm" : "commit")}
            />
            {t("settingsCellEditOnBlur")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsCellEditOnBlurHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-rich-cell-rendering">
            <Switch
              id="settings-rich-cell-rendering"
              checked={settings.richCellRendering}
              onChange={setRichCellRendering}
            />
            {t("settingsRichCellRendering")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsRichCellRenderingHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsSafety")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-confirm-prod">
            <Switch
              id="settings-confirm-prod"
              checked={settings.confirmProductionConnect}
              onChange={setConfirmProductionConnect}
            />
            {t("settingsConfirmProductionConnect")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsConfirmProductionConnectHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-confirm-dangerous">
            <Switch
              id="settings-confirm-dangerous"
              checked={settings.confirmDangerousQueries}
              onChange={setConfirmDangerousQueries}
            />
            {t("settingsConfirmDangerousQueries")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsConfirmDangerousQueriesHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-results-new-tab">
            <Switch
              id="settings-results-new-tab"
              checked={settings.resultsInNewTab}
              onChange={setResultsInNewTab}
            />
            {t("settingsResultsInNewTab")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsResultsInNewTabHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsNumberRow>
          <chakra.label htmlFor="settings-query-timeout">
            {t("settingsQueryTimeout")}
          </chakra.label>
          <Input
            id="settings-query-timeout"
            type="number"
            min={0}
            step={5}
            value={timeoutInput}
            placeholder={String(DEFAULT_QUERY_TIMEOUT_SECS)}
            onChange={(e) => setTimeoutInput(e.target.value)}
            onBlur={commitTimeout}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsTimeoutAux>
            {Number.parseInt(timeoutInput, 10) === 0 && (
              <SettingsUnlimitedBadge>
                {t("settingsQueryTimeoutUnlimited")}
              </SettingsUnlimitedBadge>
            )}
            <SettingsHelpInline>
              {t("settingsQueryTimeoutHelp")}
            </SettingsHelpInline>
          </SettingsTimeoutAux>
        </SettingsNumberRow>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-auto-reconnect">
            <Switch
              id="settings-auto-reconnect"
              checked={settings.autoReconnectEnabled}
              onChange={setAutoReconnectEnabled}
            />
            {t("settingsAutoReconnect")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsAutoReconnectHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsNumberRow>
          <chakra.label htmlFor="settings-auto-reconnect-retries">
            {t("settingsAutoReconnectMaxRetries")}
          </chakra.label>
          <Input
            id="settings-auto-reconnect-retries"
            type="number"
            min={MIN_AUTO_RECONNECT_RETRIES}
            max={MAX_AUTO_RECONNECT_RETRIES}
            step={1}
            value={reconnectRetriesInput}
            placeholder={String(DEFAULT_AUTO_RECONNECT_MAX_RETRIES)}
            disabled={!settings.autoReconnectEnabled}
            onChange={(e) => setReconnectRetriesInput(e.target.value)}
            onBlur={commitReconnectRetries}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsHelpInline>
            {t("settingsAutoReconnectMaxRetriesHelp")}
          </SettingsHelpInline>
        </SettingsNumberRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsNotifications")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-query-notifications">
            <Switch
              id="settings-query-notifications"
              checked={settings.queryNotificationsEnabled}
              onChange={setQueryNotificationsEnabled}
            />
            {t("settingsQueryNotifications")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsQueryNotificationsHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsNumberRow>
          <chakra.label htmlFor="settings-query-notification-threshold">
            {t("settingsQueryNotificationThreshold")}
          </chakra.label>
          <Input
            id="settings-query-notification-threshold"
            type="number"
            min={MIN_QUERY_NOTIFICATION_THRESHOLD_SECS}
            max={MAX_QUERY_NOTIFICATION_THRESHOLD_SECS}
            step={1}
            value={notifyThresholdInput}
            placeholder={String(DEFAULT_QUERY_NOTIFICATION_THRESHOLD_SECS)}
            disabled={!settings.queryNotificationsEnabled}
            onChange={(e) => setNotifyThresholdInput(e.target.value)}
            onBlur={commitNotifyThreshold}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <SettingsHelpInline>
            {t("settingsQueryNotificationThresholdHelp")}
          </SettingsHelpInline>
        </SettingsNumberRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsTabPersistence")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsTabPersistenceHelp")}</SettingsHelp>
        <SettingsToggleRow>
          <chakra.label htmlFor="settings-tab-restore-mode">
            {t("settingsTabRestoreMode")}
          </chakra.label>
          <Select
            id="settings-tab-restore-mode"
            value={settings.tabRestoreMode}
            onChange={(e) => setTabRestoreMode(e.target.value as TabRestoreMode)}
          >
            <option value="always">{t("settingsTabRestoreModeAlways")}</option>
            <option value="ask">{t("settingsTabRestoreModeAsk")}</option>
            <option value="never">{t("settingsTabRestoreModeNever")}</option>
          </Select>
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsSyntaxHighlighting")}</chakra.h3>
          <SettingsReset onClick={() => resetSyntaxColors(theme)}>
            {t("settingsReset")}
          </SettingsReset>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsSyntaxHelp", { theme: themeLabel })}</SettingsHelp>

        <SettingsPresetRow>
          <chakra.label htmlFor="settings-syntax-preset">
            {t("settingsSyntaxPresetLabel")}
          </chakra.label>
          <chakra.select
            id="settings-syntax-preset"
            fontSize="md"
            borderRadius="sm"
            value={detectSyntaxPreset(colors) ?? ""}
            onChange={(e) => {
              const v = e.target.value as SyntaxPresetKey | "";
              if (v) applySyntaxPreset(v, theme);
            }}
          >
            {detectSyntaxPreset(colors) === null && (
              <option value="">{t("settingsSyntaxPresetCustom")}</option>
            )}
            {SYNTAX_PRESET_ORDER.map((p) => (
              <option key={p} value={p}>
                {t(PRESET_LABEL_KEYS[p])}
              </option>
            ))}
          </chakra.select>
          <SettingsHelpInline>
            {t("settingsSyntaxPresetHelp", { theme: themeLabel })}
          </SettingsHelpInline>
        </SettingsPresetRow>

        <SettingsColorGrid>
          {FIELDS.map((f) => (
            <SettingsColorRow key={f.key}>
              <chakra.label htmlFor={`syntax-${f.key}`}>{t(f.labelKey)}</chakra.label>
              <SettingsColorControls>
                <SettingsColorInput
                  id={`syntax-${f.key}`}
                  type="color"
                  value={colors[f.key]}
                  onChange={(e) => setSyntaxColor(theme, f.key, e.target.value)}
                />
                <SettingsColorHex>{colors[f.key]}</SettingsColorHex>
                <SettingsColorSample style={{ color: colors[f.key] }}>
                  {t(f.sampleKey)}
                </SettingsColorSample>
              </SettingsColorControls>
            </SettingsColorRow>
          ))}
        </SettingsColorGrid>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsPreviewHighlight")}</chakra.h3>
          <SettingsReset onClick={() => resetPreviewHighlight(theme)}>
            {t("settingsReset")}
          </SettingsReset>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsPreviewHighlightHelp", { theme: themeLabel })}</SettingsHelp>

        <SettingsColorGrid>
          <SettingsColorRow>
            <chakra.label htmlFor="preview-highlight">{t("settingsPreviewHighlightLabel")}</chakra.label>
            <SettingsColorControls>
              <SettingsColorInput
                id="preview-highlight"
                type="color"
                value={previewHighlight}
                onChange={(e) => setPreviewHighlight(theme, e.target.value)}
              />
              <SettingsColorHex>{previewHighlight}</SettingsColorHex>
              <SettingsColorSample
                px="2.5"
                py="1"
                borderRadius="sm"
                color="app.text"
                style={{
                  background: `color-mix(in srgb, ${previewHighlight} 22%, transparent)`,
                  boxShadow: `inset 2px 0 0 ${previewHighlight}`,
                }}
              >
                {t("settingsPreviewHighlightSample")}
              </SettingsColorSample>
            </SettingsColorControls>
          </SettingsColorRow>
        </SettingsColorGrid>
      </SettingsSection>

      <KeybindingSettings />

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsLogs")}</chakra.h3>
          <SettingsLogsActions>
            <SettingsReset onClick={loadLogs} disabled={logLoading}>
              {t("settingsLogsRefresh")}
            </SettingsReset>
            <SettingsLogsIconButton
              type="button"
              onClick={copyLogs}
              disabled={!logText}
              title={logCopied ? t("settingsLogsCopied") : t("settingsLogsCopy")}
              aria-label={logCopied ? t("settingsLogsCopied") : t("settingsLogsCopy")}
            >
              <Icon name={logCopied ? "check" : "copy"} size={15} />
            </SettingsLogsIconButton>
            <SettingsReset onClick={clearLogs} disabled={!logText}>
              {t("settingsLogsClear")}
            </SettingsReset>
          </SettingsLogsActions>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsLogsHelp")}</SettingsHelp>
        <SettingsLogsView
          readOnly
          wrap="off"
          value={logText}
          placeholder={t("settingsLogsEmpty")}
        />
        {logPath && (
          <SettingsLogsPath>
            {t("settingsLogsPath", { path: logPath })}
          </SettingsLogsPath>
        )}
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsUpdates")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsUpdatesHelp")}</SettingsHelp>
        <SettingsToggleRow>
          <chakra.span>
            {t("settingsCurrentVersion", {
              version: appVersion ?? t("settingsVersionUnknown"),
            })}
          </chakra.span>
          <SettingsReset
            type="button"
            onClick={handleCheckForUpdates}
            disabled={checkingUpdate}
          >
            {checkingUpdate ? t("settingsCheckingForUpdates") : t("settingsCheckForUpdates")}
          </SettingsReset>
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsToggleLabel htmlFor="settings-auto-update-check">
            <Switch
              id="settings-auto-update-check"
              checked={settings.autoUpdateCheckEnabled}
              onChange={setAutoUpdateCheckEnabled}
            />
            {t("settingsAutoUpdateCheck")}
          </SettingsToggleLabel>
          <SettingsHelpInline>
            {t("settingsAutoUpdateCheckHelp")}
          </SettingsHelpInline>
        </SettingsToggleRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsBackup")}</chakra.h3>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsBackupHelp")}</SettingsHelp>
        <SettingsToggleRow>
          <SettingsReset type="button" onClick={handleExportSettings}>
            {t("settingsBackupExport")}
          </SettingsReset>
          <SettingsReset type="button" onClick={handleImportSettings}>
            {t("settingsBackupImport")}
          </SettingsReset>
          <SettingsHelpInline>{t("settingsBackupExcludesProfiles")}</SettingsHelpInline>
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsReset
            type="button"
            color="var(--status-error)"
            onClick={handleResetAllSettings}
          >
            {t("settingsBackupResetAll")}
          </SettingsReset>
          <SettingsHelpInline>{t("settingsBackupResetAllHelp")}</SettingsHelpInline>
        </SettingsToggleRow>
      </SettingsSection>
        </chakra.div>
      </ModalBody>
    </Modal>
    {confirmDialog}
    </>
  );
}
