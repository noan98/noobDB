import { useEffect, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Checkbox, Input, Select } from "./ui";
import { copyToClipboard } from "./clipboard";
import {
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
  resetPreviewHighlight,
  resetStreamingDefaults,
  resetSyntaxColors,
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
    <Box className="settings">
      <chakra.header className="settings-header">
        <chakra.h2>{t("settingsTitle")}</chakra.h2>
        <chakra.button
          className="icon"
          onClick={onClose}
          aria-label={t("settingsClose")}
          title={t("settingsClose")}
        >
          <Icon name="close" size={13} />
        </chakra.button>
      </chakra.header>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsLanguage")}</chakra.h3>
        </Box>
        <Box className="settings-toggle-row">
          <LanguageSwitcher />
          <chakra.span className="settings-help-inline">
            {t("settingsLanguageHelp")}
          </chakra.span>
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsAppearance")}</chakra.h3>
        </Box>
        <Box className="settings-number-row">
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
          <chakra.span className="settings-help-inline">
            {t("settingsFontSizeHelp", {
              min: MIN_FONT_SIZE_PX,
              max: MAX_FONT_SIZE_PX,
              default: DEFAULT_FONT_SIZE_PX,
            })}
          </chakra.span>
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsStreaming")}</chakra.h3>
          <chakra.button
            className="settings-reset"
            onClick={resetStreamingDefaults}
          >
            {t("settingsReset")}
          </chakra.button>
        </Box>
        <chakra.p className="settings-help">{t("settingsStreamingHelp")}</chakra.p>

        <Box className="settings-number-row">
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
          <chakra.span className="settings-help-inline">
            {t("settingsDefaultDisplayCountHelp")}
          </chakra.span>
        </Box>

        <Box className="settings-number-row">
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
          <chakra.span className="settings-help-inline">
            {t("settingsStreamPrefetchSizeHelp")}
          </chakra.span>
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsAutoLimit")}</chakra.h3>
        </Box>
        <chakra.p className="settings-help">{t("settingsAutoLimitHelp")}</chakra.p>
        <Box className="settings-toggle-row">
          <chakra.label htmlFor="settings-auto-limit" className="settings-toggle-label">
            <Checkbox
              id="settings-auto-limit"
              checked={settings.autoLimitEnabled}
              onChange={(e) => setAutoLimitEnabled(e.target.checked)}
            />
            {t("settingsAutoLimitEnabled")}
          </chakra.label>
          <chakra.span className="settings-help-inline">
            {t("settingsAutoLimitEnabledHelp")}
          </chakra.span>
        </Box>
        <Box className="settings-number-row">
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
          <chakra.span className="settings-help-inline">
            {t("settingsAutoLimitCountHelp")}
          </chakra.span>
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsSafety")}</chakra.h3>
        </Box>
        <Box className="settings-toggle-row">
          <chakra.label htmlFor="settings-confirm-prod" className="settings-toggle-label">
            <Checkbox
              id="settings-confirm-prod"
              checked={settings.confirmProductionConnect}
              onChange={(e) => setConfirmProductionConnect(e.target.checked)}
            />
            {t("settingsConfirmProductionConnect")}
          </chakra.label>
          <chakra.span className="settings-help-inline">
            {t("settingsConfirmProductionConnectHelp")}
          </chakra.span>
        </Box>
        <Box className="settings-toggle-row">
          <chakra.label htmlFor="settings-confirm-dangerous" className="settings-toggle-label">
            <Checkbox
              id="settings-confirm-dangerous"
              checked={settings.confirmDangerousQueries}
              onChange={(e) => setConfirmDangerousQueries(e.target.checked)}
            />
            {t("settingsConfirmDangerousQueries")}
          </chakra.label>
          <chakra.span className="settings-help-inline">
            {t("settingsConfirmDangerousQueriesHelp")}
          </chakra.span>
        </Box>
        <Box className="settings-number-row">
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
          <Box className="settings-timeout-aux">
            {Number.parseInt(timeoutInput, 10) === 0 && (
              <chakra.span className="settings-unlimited-badge">
                {t("settingsQueryTimeoutUnlimited")}
              </chakra.span>
            )}
            <chakra.span className="settings-help-inline">
              {t("settingsQueryTimeoutHelp")}
            </chakra.span>
          </Box>
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsTabPersistence")}</chakra.h3>
        </Box>
        <chakra.p className="settings-help">{t("settingsTabPersistenceHelp")}</chakra.p>
        <Box className="settings-toggle-row">
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
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsSyntaxHighlighting")}</chakra.h3>
          <chakra.button
            className="settings-reset"
            onClick={() => resetSyntaxColors(theme)}
          >
            {t("settingsReset")}
          </chakra.button>
        </Box>
        <chakra.p className="settings-help">{t("settingsSyntaxHelp", { theme: themeLabel })}</chakra.p>

        <Box className="settings-preset-row">
          <chakra.label htmlFor="settings-syntax-preset">
            {t("settingsSyntaxPresetLabel")}
          </chakra.label>
          <chakra.select
            id="settings-syntax-preset"
            className="settings-preset-select"
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
          <chakra.span className="settings-help-inline">
            {t("settingsSyntaxPresetHelp", { theme: themeLabel })}
          </chakra.span>
        </Box>

        <Box className="settings-color-grid">
          {FIELDS.map((f) => (
            <Box className="settings-color-row" key={f.key}>
              <chakra.label htmlFor={`syntax-${f.key}`}>{t(f.labelKey)}</chakra.label>
              <Box className="settings-color-controls">
                <chakra.input
                  id={`syntax-${f.key}`}
                  type="color"
                  className="settings-color-input"
                  value={colors[f.key]}
                  onChange={(e) => setSyntaxColor(theme, f.key, e.target.value)}
                />
                <chakra.span className="settings-color-hex">{colors[f.key]}</chakra.span>
                <chakra.span
                  className="settings-color-sample"
                  style={{ color: colors[f.key] }}
                >
                  {t(f.sampleKey)}
                </chakra.span>
              </Box>
            </Box>
          ))}
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsPreviewHighlight")}</chakra.h3>
          <chakra.button
            className="settings-reset"
            onClick={() => resetPreviewHighlight(theme)}
          >
            {t("settingsReset")}
          </chakra.button>
        </Box>
        <chakra.p className="settings-help">{t("settingsPreviewHighlightHelp", { theme: themeLabel })}</chakra.p>

        <Box className="settings-color-grid">
          <Box className="settings-color-row">
            <chakra.label htmlFor="preview-highlight">{t("settingsPreviewHighlightLabel")}</chakra.label>
            <Box className="settings-color-controls">
              <chakra.input
                id="preview-highlight"
                type="color"
                className="settings-color-input"
                value={previewHighlight}
                onChange={(e) => setPreviewHighlight(theme, e.target.value)}
              />
              <chakra.span className="settings-color-hex">{previewHighlight}</chakra.span>
              <chakra.span
                className="settings-color-sample preview-highlight-sample"
                style={{
                  background: `color-mix(in srgb, ${previewHighlight} 22%, transparent)`,
                  boxShadow: `inset 2px 0 0 ${previewHighlight}`,
                }}
              >
                {t("settingsPreviewHighlightSample")}
              </chakra.span>
            </Box>
          </Box>
        </Box>
      </chakra.section>

      <chakra.section className="settings-section">
        <Box className="settings-section-header">
          <chakra.h3>{t("settingsLogs")}</chakra.h3>
          <Box className="settings-logs-actions">
            <chakra.button className="settings-reset" onClick={loadLogs} disabled={logLoading}>
              {t("settingsLogsRefresh")}
            </chakra.button>
            <chakra.button className="settings-reset" onClick={copyLogs} disabled={!logText}>
              {logCopied ? t("settingsLogsCopied") : t("settingsLogsCopy")}
            </chakra.button>
            <chakra.button className="settings-reset" onClick={clearLogs} disabled={!logText}>
              {t("settingsLogsClear")}
            </chakra.button>
          </Box>
        </Box>
        <chakra.p className="settings-help">{t("settingsLogsHelp")}</chakra.p>
        <chakra.textarea
          className="settings-logs-view"
          readOnly
          wrap="off"
          value={logText}
          placeholder={t("settingsLogsEmpty")}
        />
        {logPath && (
          <chakra.span className="settings-help-inline settings-logs-path">
            {t("settingsLogsPath", { path: logPath })}
          </chakra.span>
        )}
      </chakra.section>
    </Box>
  );
}
