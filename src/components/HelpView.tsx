import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { SHORTCUTS } from "../shortcuts";
import { Icon } from "./Icon";
import { Modal, ModalBody, ModalHeader } from "./Modal";
import {
  SettingsHelp,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";

type Key = Parameters<ReturnType<typeof useT>>[0];
type Impact = "yes" | "no";

const HelpFeatureGrid = chakra("div", {
  base: { display: "flex", flexDirection: "column", gap: "2", mt: "1.5" },
});

const HelpFeature = chakra("article", {
  base: {
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    px: "3",
    py: "2.5",
  },
});

const HelpFeatureHead = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "3",
    flexWrap: "wrap",
    "& h4": { margin: 0, fontSize: "md", fontWeight: 600, color: "app.text" },
  },
});

const HelpFeatureDesc = chakra("p", {
  base: { margin: "8px 0 0", fontSize: "sm", lineHeight: "1.55", color: "app.text" },
});

const HelpUsageTitle = chakra("p", {
  base: { margin: "10px 0 2px", fontSize: "sm", fontWeight: 600, color: "app.text" },
});

const HelpSteps = chakra("ol", {
  base: {
    margin: 0,
    pl: "5",
    fontSize: "sm",
    lineHeight: "1.55",
    color: "app.text",
    "& li": { margin: "2px 0" },
  },
});

const HelpNote = chakra("p", {
  base: {
    margin: "10px 0 0",
    fontSize: "sm",
    lineHeight: "1.5",
    color: "app.textMuted",
    "& strong": { color: "app.text" },
  },
});

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
      {
        titleKey: "helpSchemaCompareTitle",
        descKey: "helpSchemaCompareDesc",
        impact: "no",
        noteKey: "helpSchemaCompareNote",
      },
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
    // ショートカット一覧は `shortcuts.ts` の単一ソースから生成し、`?` で開く
    // チートシート (`ShortcutCheatSheet`) と定義を共有する (#448)。
    features: SHORTCUTS.map((s) => ({ titleKey: s.keysKey, descKey: s.descKey })),
  },
];

function DbImpactBadge({ impact }: { impact: Impact }) {
  const t = useT();
  const writes = impact === "yes";
  const tone = writes ? "var(--status-error)" : "var(--status-connected)";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="5px"
      px="2"
      py="0.5"
      borderRadius="pill"
      fontSize="xs"
      fontWeight={600}
      whiteSpace="nowrap"
      border="1px solid transparent"
      color={tone}
      background={`color-mix(in srgb, ${tone} 12%, transparent)`}
      borderColor={`color-mix(in srgb, ${tone} 35%, transparent)`}
    >
      <chakra.span fontSize="xs" lineHeight="1" aria-hidden>
        <Icon name={writes ? "check" : "close"} />
      </chakra.span>
      {`${t("helpImpactLabel")}: ${t(writes ? "helpImpactYes" : "helpImpactNo")}`}
    </chakra.span>
  );
}

export function HelpView({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal onClose={onClose} width="760px">
      <ModalHeader onClose={onClose} closeLabel={t("helpClose")}>
        {t("helpTitle")}
      </ModalHeader>
      <ModalBody>
        <chakra.div display="flex" flexDirection="column" gap="18px">
      <SettingsHelp fontSize="md" lineHeight="1.5">{t("helpIntro")}</SettingsHelp>

      {SECTIONS.map((section) => (
        <SettingsSection key={section.headerKey}>
          <SettingsSectionHeader>
            <chakra.h3>{t(section.headerKey)}</chakra.h3>
          </SettingsSectionHeader>
          <SettingsHelp>{t(section.descKey)}</SettingsHelp>

          <HelpFeatureGrid>
            {section.features.map((f) => (
              <HelpFeature key={f.titleKey}>
                <HelpFeatureHead>
                  <chakra.h4>{t(f.titleKey)}</chakra.h4>
                  {f.impact && <DbImpactBadge impact={f.impact} />}
                </HelpFeatureHead>
                <HelpFeatureDesc>{t(f.descKey)}</HelpFeatureDesc>

                {f.stepKeys && (
                  <>
                    <HelpUsageTitle>{t("helpUsageTitle")}</HelpUsageTitle>
                    <HelpSteps>
                      {f.stepKeys.map((s) => (
                        <chakra.li key={s}>{t(s)}</chakra.li>
                      ))}
                    </HelpSteps>
                  </>
                )}

                {f.noteKey && (
                  <HelpNote>
                    <chakra.strong>{t("helpNoteLabel")}:</chakra.strong> {t(f.noteKey)}
                  </HelpNote>
                )}
              </HelpFeature>
            ))}
          </HelpFeatureGrid>
        </SettingsSection>
      ))}
        </chakra.div>
      </ModalBody>
    </Modal>
  );
}
