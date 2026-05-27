import { Box, chakra } from "@chakra-ui/react";
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
      { titleKey: "helpConfirmWritesTitle", descKey: "helpConfirmWritesDesc" },
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
    <chakra.span className={`help-impact-badge ${writes ? "impact-yes" : "impact-no"}`}>
      <chakra.span className="help-impact-mark" aria-hidden>
        <Icon name={writes ? "check" : "close"} />
      </chakra.span>
      {`${t("helpImpactLabel")}: ${t(writes ? "helpImpactYes" : "helpImpactNo")}`}
    </chakra.span>
  );
}

export function HelpView({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Box className="settings help">
      <chakra.header className="settings-header">
        <chakra.h2>{t("helpTitle")}</chakra.h2>
        <chakra.button
          className="icon"
          onClick={onClose}
          aria-label={t("helpClose")}
          title={t("helpClose")}
        >
          <Icon name="close" size={13} />
        </chakra.button>
      </chakra.header>

      <chakra.p className="settings-help help-intro">{t("helpIntro")}</chakra.p>

      {SECTIONS.map((section) => (
        <chakra.section className="settings-section" key={section.headerKey}>
          <Box className="settings-section-header">
            <chakra.h3>{t(section.headerKey)}</chakra.h3>
          </Box>
          <chakra.p className="settings-help">{t(section.descKey)}</chakra.p>

          <Box className="help-feature-grid">
            {section.features.map((f) => (
              <chakra.article className="help-feature" key={f.titleKey}>
                <Box className="help-feature-head">
                  <chakra.h4>{t(f.titleKey)}</chakra.h4>
                  {f.impact && <DbImpactBadge impact={f.impact} />}
                </Box>
                <chakra.p className="help-feature-desc">{t(f.descKey)}</chakra.p>

                {f.stepKeys && (
                  <>
                    <chakra.p className="help-usage-title">{t("helpUsageTitle")}</chakra.p>
                    <chakra.ol className="help-steps">
                      {f.stepKeys.map((s) => (
                        <chakra.li key={s}>{t(s)}</chakra.li>
                      ))}
                    </chakra.ol>
                  </>
                )}

                {f.noteKey && (
                  <chakra.p className="help-note">
                    <chakra.strong>{t("helpNoteLabel")}:</chakra.strong> {t(f.noteKey)}
                  </chakra.p>
                )}
              </chakra.article>
            ))}
          </Box>
        </chakra.section>
      ))}
    </Box>
  );
}
