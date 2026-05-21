import { useT } from "../i18n";
import {
  SyntaxColors,
  Theme,
  resetSyntaxColors,
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

  return (
    <div className="settings">
      <header className="settings-header">
        <h2>{t("settingsTitle")}</h2>
        <button onClick={onClose}>{t("settingsClose")}</button>
      </header>

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
