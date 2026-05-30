import { useEffect, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Input, Select, Switch } from "./ui";
import {
  SettingsHelp,
  SettingsPane,
  SettingsHeader,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";
import { copyToClipboard } from "./clipboard";
import {
  ACCENT_PRESET_ORDER,
  ACCENT_PRESETS,
  AccentPresetKey,
  DEFAULT_AUTO_LIMIT_COUNT,
  DEFAULT_DISPLAY_COUNT,
  DEFAULT_FONT_SIZE_PX,
  DEFAULT_QUERY_TIMEOUT_SECS,
  DEFAULT_STREAM_PREFETCH_SIZE,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
  SYNTAX_PRESET_ORDER,
  SyntaxColors,
  SyntaxPresetKey,
  TabRestoreMode,
  Theme,
  applySyntaxPreset,
  detectSyntaxPreset,
  pickAccentForeground,
  resetAccentColor,
  resetPreviewHighlight,
  resetStreamingDefaults,
  resetSyntaxColors,
  setAccentCustomDark,
  setAccentCustomLight,
  setAccentPreset,
  setAutoLimitCount,
  setAutoLimitEnabled,
  setConfirmDangerousQueries,
  setConfirmProductionConnect,
  setDefaultDisplayCount,
  setFontSizePx,
  setQueryTimeoutSecs,
  setPreviewHighlight,
  setStreamPrefetchSize,
  setSyntaxColor,
  setTabRestoreMode,
  useSettings,
} from "../settings";

interface Props {
  theme: Theme;
  onClose: () => void;
}

// 各セクション内のレイアウト要素 (元々は App.css の `.settings-*` クラス)。
const SettingsReset = chakra("button", {
  base: { px: "10px", py: "4px", fontSize: "sm" },
});

const SettingsToggleRow = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    p: "8px",
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
    gap: "var(--space-2)",
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
    gap: "var(--space-3)",
    px: "8px",
    py: "6px",
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
    px: "8px",
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
    gap: "var(--space-3)",
    px: "8px",
    py: "6px",
    mb: "8px",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    "& label": { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text" },
  },
});

const SettingsColorGrid = chakra("div", {
  base: { display: "grid", gridTemplateColumns: "1fr", gap: "6px", mt: "6px" },
});

const SettingsColorRow = chakra("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    alignItems: "center",
    gap: "var(--space-3)",
    px: "8px",
    py: "6px",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    "& label": { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text" },
  },
});

const SettingsColorControls = chakra("div", {
  base: { display: "flex", alignItems: "center", gap: "10px" },
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
    "&::-webkit-color-swatch-wrapper": { padding: "2px" },
    "&::-webkit-color-swatch": { border: "none", borderRadius: "var(--radius-sm)" },
  },
});

const SettingsColorHex = chakra("span", {
  base: { fontFamily: "mono", fontSize: "sm", color: "app.textMuted", minWidth: "70px" },
});

const SettingsColorSample = chakra("span", {
  base: { fontFamily: "mono", fontSize: "md", fontWeight: 600 },
});

const SettingsLogsActions = chakra("div", {
  base: { display: "flex", alignItems: "center", gap: "var(--space-2)" },
});

const SettingsLogsView = chakra("textarea", {
  base: {
    mt: "6px",
    width: "100%",
    height: "260px",
    resize: "vertical",
    px: "10px",
    py: "8px",
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

const ACCENT_PRESET_LABEL_KEYS: Record<AccentPresetKey, Parameters<ReturnType<typeof useT>>[0]> = {
  blue: "settingsAccentPresetBlue",
  indigo: "settingsAccentPresetIndigo",
  violet: "settingsAccentPresetViolet",
  rose: "settingsAccentPresetRose",
  emerald: "settingsAccentPresetEmerald",
  amber: "settingsAccentPresetAmber",
  teal: "settingsAccentPresetTeal",
};

export function SettingsView({ theme, onClose }: Props) {
  const t = useT();
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
  const [fontSizeInput, setFontSizeInput] = useState(String(settings.fontSizePx));
  useEffect(() => setDisplayInput(String(settings.defaultDisplayCount)), [settings.defaultDisplayCount]);
  useEffect(() => setPrefetchInput(String(settings.streamPrefetchSize)), [settings.streamPrefetchSize]);
  useEffect(() => setAutoLimitInput(String(settings.autoLimitCount)), [settings.autoLimitCount]);
  useEffect(() => setTimeoutInput(String(settings.queryTimeoutSecs)), [settings.queryTimeoutSecs]);
  useEffect(() => setFontSizeInput(String(settings.fontSizePx)), [settings.fontSizePx]);

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
  const commitFontSize = () => {
    const n = Number.parseInt(fontSizeInput, 10);
    if (Number.isFinite(n)) setFontSizePx(n);
    else setFontSizeInput(String(settings.fontSizePx));
  };

  const [logText, setLogText] = useState("");
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logCopied, setLogCopied] = useState(false);

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
    await copyToClipboard(logText);
    setLogCopied(true);
    setTimeout(() => setLogCopied(false), 1500);
  };
  const clearLogs = async () => {
    if (!window.confirm(t("settingsLogsClearConfirm"))) return;
    await api.clearLogs();
    await loadLogs();
  };

  return (
    <SettingsPane>
      <SettingsHeader>
        <chakra.h2>{t("settingsTitle")}</chakra.h2>
        <chakra.button
          px="8px"
          py="4px"
          minW="28px"
          fontSize="base"
          lineHeight="1"
          onClick={onClose}
          aria-label={t("settingsClose")}
          title={t("settingsClose")}
        >
          <Icon name="close" size={13} />
        </chakra.button>
      </SettingsHeader>

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
      </SettingsSection>

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsAccentColor")}</chakra.h3>
          <SettingsReset onClick={resetAccentColor}>{t("settingsReset")}</SettingsReset>
        </SettingsSectionHeader>
        <SettingsHelp>{t("settingsAccentColorHelp")}</SettingsHelp>

        {/* Preset swatches */}
        <SettingsToggleRow>
          {ACCENT_PRESET_ORDER.map((key) => {
            const palette = ACCENT_PRESETS[key];
            const accentHex = theme === "dark" ? palette.dark.accent : palette.light.accent;
            const accentText = theme === "dark" ? palette.dark.accentText : palette.light.accentText;
            const isActive = settings.accentPreset === key;
            return (
              <chakra.button
                key={key}
                title={t(ACCENT_PRESET_LABEL_KEYS[key])}
                aria-label={t(ACCENT_PRESET_LABEL_KEYS[key])}
                aria-pressed={isActive}
                onClick={() => setAccentPreset(key)}
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                width="28px"
                height="28px"
                borderRadius="full"
                border="2px solid"
                borderColor={isActive ? "app.borderStrong" : "transparent"}
                bg={accentHex}
                color={accentText}
                outline={isActive ? "2px solid" : "none"}
                outlineOffset="2px"
                style={{ outlineColor: isActive ? accentHex : undefined }}
                cursor="pointer"
                fontSize="xs"
                fontWeight={700}
                flexShrink={0}
                _focusVisible={{ outline: "none", boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent)" }}
              >
                {isActive ? "✓" : ""}
              </chakra.button>
            );
          })}

          {/* Custom option */}
          <chakra.button
            title={t("settingsAccentPresetCustom")}
            aria-label={t("settingsAccentPresetCustom")}
            aria-pressed={settings.accentPreset === "custom"}
            onClick={() => setAccentPreset("custom")}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            width="28px"
            height="28px"
            borderRadius="full"
            border="2px solid"
            borderColor={settings.accentPreset === "custom" ? "app.borderStrong" : "app.borderSubtle"}
            bg="app.surfaceMuted"
            color="app.textSecondary"
            cursor="pointer"
            fontSize="xs"
            fontWeight={700}
            flexShrink={0}
            _hover={{ bg: "app.hover" }}
            _focusVisible={{ outline: "none", boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent)" }}
          >
            {t("settingsAccentPresetCustom").slice(0, 1)}
          </chakra.button>
        </SettingsToggleRow>

        {/* Custom color picker — only shown when "custom" preset is active */}
        {settings.accentPreset === "custom" && (
          <SettingsColorGrid>
            <SettingsColorRow>
              <chakra.label htmlFor="accent-custom">
                {t("settingsAccentCustomLabel", { theme: themeLabel })}
              </chakra.label>
              <SettingsColorControls>
                <SettingsColorInput
                  id="accent-custom"
                  type="color"
                  value={theme === "dark" ? settings.accentCustomDark : settings.accentCustomLight}
                  onChange={(e) => {
                    if (theme === "dark") setAccentCustomDark(e.target.value);
                    else setAccentCustomLight(e.target.value);
                  }}
                />
                <SettingsColorHex>
                  {theme === "dark" ? settings.accentCustomDark : settings.accentCustomLight}
                </SettingsColorHex>
                <SettingsColorSample
                  px="10px"
                  py="4px"
                  borderRadius="sm"
                  style={{
                    background: theme === "dark" ? settings.accentCustomDark : settings.accentCustomLight,
                    color: pickAccentForeground(
                      theme === "dark" ? settings.accentCustomDark : settings.accentCustomLight,
                    ),
                  }}
                >
                  {t("settingsAccentPresetCustom")}
                </SettingsColorSample>
              </SettingsColorControls>
            </SettingsColorRow>
          </SettingsColorGrid>
        )}
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
                px="10px"
                py="4px"
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

      <SettingsSection>
        <SettingsSectionHeader>
          <chakra.h3>{t("settingsLogs")}</chakra.h3>
          <SettingsLogsActions>
            <SettingsReset onClick={loadLogs} disabled={logLoading}>
              {t("settingsLogsRefresh")}
            </SettingsReset>
            <SettingsReset onClick={copyLogs} disabled={!logText}>
              {logCopied ? t("settingsLogsCopied") : t("settingsLogsCopy")}
            </SettingsReset>
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
    </SettingsPane>
  );
}
