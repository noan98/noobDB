import { useT } from "../i18n";
import { Icon } from "./Icon";

type Key = Parameters<ReturnType<typeof useT>>[0];
type Impact = "yes" | "no";

interface Feature {
  titleKey: Key;
  descKey: Key;
  impact?: Impact;
  stepKeys?: Key[];
  noteKey?: Key;
}

interface Section {
  headerKey: Key;
  descKey: Key;
  features: Feature[];
}

const SECTIONS: Section[] = [
  {
    headerKey: "helpSectionSafe",
    descKey: "helpSectionSafeDesc",
    features: [
      {
        titleKey: "helpDryRunTitle",
        descKey: "helpDryRunDesc",
        impact: "no",
        stepKeys: ["helpDryRunStep1", "helpDryRunStep2", "helpDryRunStep3"],
        noteKey: "helpDryRunNote",
      },
      { titleKey: "helpExplainTitle", descKey: "helpExplainDesc", impact: "no" },
      { titleKey: "helpFormatTitle", descKey: "helpFormatDesc", impact: "no" },
      { titleKey: "helpQueryBuilderTitle", descKey: "helpQueryBuilderDesc", impact: "no" },
      { titleKey: "helpSnippetTitle", descKey: "helpSnippetDesc", impact: "no" },
      { titleKey: "helpExportTitle", descKey: "helpExportDesc", impact: "no" },
      { titleKey: "helpCellEditTitle", descKey: "helpCellEditDesc", impact: "no" },
      { titleKey: "helpDiscardTitle", descKey: "helpDiscardDesc", impact: "no" },
      { titleKey: "helpHistoryTitle", descKey: "helpHistoryDesc", impact: "no" },
      { titleKey: "helpPaginationTitle", descKey: "helpPaginationDesc", impact: "no" },
    ],
  },
  {
    headerKey: "helpSectionWrite",
    descKey: "helpSectionWriteDesc",
    features: [
      { titleKey: "helpRunTitle", descKey: "helpRunDesc", impact: "yes" },
      {
        titleKey: "helpApplyTitle",
        descKey: "helpApplyDesc",
        impact: "yes",
        noteKey: "helpApplyNote",
      },
      { titleKey: "helpImportTitle", descKey: "helpImportDesc", impact: "yes" },
    ],
  },
  {
    headerKey: "helpSectionGuards",
    descKey: "helpSectionGuardsDesc",
    features: [
      { titleKey: "helpReadOnlyTitle", descKey: "helpReadOnlyDesc" },
      { titleKey: "helpProductionTitle", descKey: "helpProductionDesc" },
    ],
  },
  {
    headerKey: "helpSectionShortcuts",
    descKey: "helpSectionShortcutsDesc",
    features: [
      { titleKey: "helpShortcutRunTitle", descKey: "helpShortcutRunDesc" },
      { titleKey: "helpShortcutPreviewTitle", descKey: "helpShortcutPreviewDesc" },
      { titleKey: "helpShortcutFormatTitle", descKey: "helpShortcutFormatDesc" },
      { titleKey: "helpShortcutCompleteTitle", descKey: "helpShortcutCompleteDesc" },
      { titleKey: "helpShortcutSearchTitle", descKey: "helpShortcutSearchDesc" },
      { titleKey: "helpShortcutNewTabTitle", descKey: "helpShortcutNewTabDesc" },
      { titleKey: "helpShortcutCloseTabTitle", descKey: "helpShortcutCloseTabDesc" },
      { titleKey: "helpShortcutCycleTabTitle", descKey: "helpShortcutCycleTabDesc" },
      { titleKey: "helpShortcutNthTabTitle", descKey: "helpShortcutNthTabDesc" },
    ],
  },
];

function DbImpactBadge({ impact }: { impact: Impact }) {
  const t = useT();
  const writes = impact === "yes";
  return (
    <span className={`help-impact-badge ${writes ? "impact-yes" : "impact-no"}`}>
      <span className="help-impact-mark" aria-hidden>
        <Icon name={writes ? "check" : "close"} />
      </span>
      {`${t("helpImpactLabel")}: ${t(writes ? "helpImpactYes" : "helpImpactNo")}`}
    </span>
  );
}

export function HelpView({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div className="settings help">
      <header className="settings-header">
        <h2>{t("helpTitle")}</h2>
        <button
          className="icon"
          onClick={onClose}
          aria-label={t("helpClose")}
          title={t("helpClose")}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <p className="settings-help help-intro">{t("helpIntro")}</p>

      {SECTIONS.map((section) => (
        <section className="settings-section" key={section.headerKey}>
          <div className="settings-section-header">
            <h3>{t(section.headerKey)}</h3>
          </div>
          <p className="settings-help">{t(section.descKey)}</p>

          <div className="help-feature-grid">
            {section.features.map((f) => (
              <article className="help-feature" key={f.titleKey}>
                <div className="help-feature-head">
                  <h4>{t(f.titleKey)}</h4>
                  {f.impact && <DbImpactBadge impact={f.impact} />}
                </div>
                <p className="help-feature-desc">{t(f.descKey)}</p>

                {f.stepKeys && (
                  <>
                    <p className="help-usage-title">{t("helpUsageTitle")}</p>
                    <ol className="help-steps">
                      {f.stepKeys.map((s) => (
                        <li key={s}>{t(s)}</li>
                      ))}
                    </ol>
                  </>
                )}

                {f.noteKey && (
                  <p className="help-note">
                    <strong>{t("helpNoteLabel")}:</strong> {t(f.noteKey)}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
