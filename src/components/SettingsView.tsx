import { useEffect, useState } from "react";
import { useT } from "../i18n";
import {
  DEFAULT_DISPLAY_COUNT,
  DEFAULT_STREAM_PREFETCH_SIZE,
  SyntaxColors,
  Theme,
  resetStreamingDefaults,
  resetSyntaxColors,
  setDefaultDisplayCount,
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

export function SettingsView({ theme, onClose }: Props) {
  const t = useT();
  const settings = useSettings();
  const colors = settings.syntaxColors[theme];
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
          <h3>{t("settingsSyntaxHighlighting")}</h3>
          <button
            className="settings-reset"
            onClick={() => resetSyntaxColors(theme)}
          >
            {t("settingsReset")}
          </button>
        </div>
        <p className="settings-help">{t("settingsSyntaxHelp", { theme: themeLabel })}</p>

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
    </div>
  );
}
