import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";
import {
  DEFAULT_DISPLAY_COUNT,
  DEFAULT_STREAM_PREFETCH_SIZE,
  SYNTAX_PRESET_ORDER,
  SyntaxColors,
  SyntaxPresetKey,
  Theme,
  applySyntaxPreset,
  detectSyntaxPreset,
  resetPreviewHighlight,
  resetStreamingDefaults,
  resetSyntaxColors,
  setConfirmProductionConnect,
  setDefaultDisplayCount,
  setPreviewHighlight,
  setStreamPrefetchSize,
  setSyntaxColor,
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
  useEffect(() => setDisplayInput(String(settings.defaultDisplayCount)), [settings.defaultDisplayCount]);
  useEffect(() => setPrefetchInput(String(settings.streamPrefetchSize)), [settings.streamPrefetchSize]);

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

  return (
    <div className="settings">
      <header className="settings-header">
        <h2>{t("settingsTitle")}</h2>
        <button onClick={onClose}>{t("settingsClose")}</button>
      </header>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>{t("settingsLanguage")}</h3>
        </div>
        <div className="settings-toggle-row">
          <LanguageSwitcher />
          <span className="settings-help-inline">
            {t("settingsLanguageHelp")}
          </span>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>{t("settingsStreaming")}</h3>
          <button
            className="settings-reset"
            onClick={resetStreamingDefaults}
          >
            {t("settingsReset")}
          </button>
        </div>
        <p className="settings-help">{t("settingsStreamingHelp")}</p>

        <div className="settings-number-row">
          <label htmlFor="settings-default-display">
            {t("settingsDefaultDisplayCount")}
          </label>
          <input
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
          <span className="settings-help-inline">
            {t("settingsDefaultDisplayCountHelp")}
          </span>
        </div>

        <div className="settings-number-row">
          <label htmlFor="settings-stream-prefetch">
            {t("settingsStreamPrefetchSize")}
          </label>
          <input
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
          <span className="settings-help-inline">
            {t("settingsStreamPrefetchSizeHelp")}
          </span>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>{t("settingsSafety")}</h3>
        </div>
        <div className="settings-toggle-row">
          <label htmlFor="settings-confirm-prod" className="settings-toggle-label">
            <input
              id="settings-confirm-prod"
              type="checkbox"
              checked={settings.confirmProductionConnect}
              onChange={(e) => setConfirmProductionConnect(e.target.checked)}
            />
            {t("settingsConfirmProductionConnect")}
          </label>
          <span className="settings-help-inline">
            {t("settingsConfirmProductionConnectHelp")}
          </span>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>{t("settingsSyntaxHighlighting")}</h3>
          <button
            className="settings-reset"
            onClick={() => resetSyntaxColors(theme)}
          >
            {t("settingsReset")}
          </button>
        </div>
        <p className="settings-help">{t("settingsSyntaxHelp", { theme: themeLabel })}</p>

        <div className="settings-preset-row">
          <label htmlFor="settings-syntax-preset">
            {t("settingsSyntaxPresetLabel")}
          </label>
          <select
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
          </select>
          <span className="settings-help-inline">
            {t("settingsSyntaxPresetHelp", { theme: themeLabel })}
          </span>
        </div>

        <div className="settings-color-grid">
          {FIELDS.map((f) => (
            <div className="settings-color-row" key={f.key}>
              <label htmlFor={`syntax-${f.key}`}>{t(f.labelKey)}</label>
              <div className="settings-color-controls">
                <input
                  id={`syntax-${f.key}`}
                  type="color"
                  className="settings-color-input"
                  value={colors[f.key]}
                  onChange={(e) => setSyntaxColor(theme, f.key, e.target.value)}
                />
                <span className="settings-color-hex">{colors[f.key]}</span>
                <span
                  className="settings-color-sample"
                  style={{ color: colors[f.key] }}
                >
                  {t(f.sampleKey)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>{t("settingsPreviewHighlight")}</h3>
          <button
            className="settings-reset"
            onClick={() => resetPreviewHighlight(theme)}
          >
            {t("settingsReset")}
          </button>
        </div>
        <p className="settings-help">{t("settingsPreviewHighlightHelp", { theme: themeLabel })}</p>

        <div className="settings-color-grid">
          <div className="settings-color-row">
            <label htmlFor="preview-highlight">{t("settingsPreviewHighlightLabel")}</label>
            <div className="settings-color-controls">
              <input
                id="preview-highlight"
                type="color"
                className="settings-color-input"
                value={previewHighlight}
                onChange={(e) => setPreviewHighlight(theme, e.target.value)}
              />
              <span className="settings-color-hex">{previewHighlight}</span>
              <span
                className="settings-color-sample preview-highlight-sample"
                style={{
                  background: `color-mix(in srgb, ${previewHighlight} 22%, transparent)`,
                  boxShadow: `inset 2px 0 0 ${previewHighlight}`,
                }}
              >
                {t("settingsPreviewHighlightSample")}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
