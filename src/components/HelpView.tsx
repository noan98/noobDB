import { useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import { resolveShortcutBindings, SHORTCUTS, type ShortcutId } from "../shortcuts";
import { formatCombo } from "../shortcutKeys";
import { useSettings } from "../settings";
import { Icon } from "./Icon";
import { Modal, ModalBody, ModalHeader } from "./Modal";
import {
  SettingsHelp,
  SettingsNavAside,
  SettingsNavButton,
  SettingsNavEmpty,
  SettingsNavList,
  SettingsSection,
  SettingsSectionHeader,
} from "./settingsLayout";
import { Button, Input } from "./ui";
import { filterHelpSections } from "../helpSearch";
import { pickActiveSection } from "../sectionNav";

type Key = Parameters<ReturnType<typeof useT>>[0];
type Impact = "yes" | "no";

// 広げたモーダル幅で 1 行が長くなりすぎないよう、カードは 2 カラムに折り返す
// (狭いウィンドウでは minmax により自然に 1 カラムへフォールバック)。
const HelpFeatureGrid = chakra("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
    gap: "2",
    mt: "1.5",
  },
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
    "& h4": { margin: 0, textStyle: "subheading", fontSize: "md" },
  },
});

const HelpFeatureDesc = chakra("p", {
  base: { margin: "var(--space-2) 0 0", fontSize: "sm", lineHeight: "var(--leading-normal)", color: "app.text" },
});

const HelpUsageTitle = chakra("p", {
  base: { margin: "var(--space-2-5) 0 var(--space-0-5)", textStyle: "subheading" },
});

const HelpSteps = chakra("ol", {
  base: {
    margin: 0,
    pl: "5",
    fontSize: "sm",
    lineHeight: "var(--leading-normal)",
    color: "app.text",
    "& li": { margin: "var(--space-0-5) 0" },
  },
});

const HelpNote = chakra("p", {
  base: {
    margin: "var(--space-2-5) 0 0",
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
  /** 再割り当て可能なショートカット。見出しを解決済みコンボで表示する (#557)。 */
  shortcutId?: ShortcutId;
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
      {
        titleKey: "helpSqlLintTitle",
        descKey: "helpSqlLintDesc",
        impact: "no",
        noteKey: "helpSqlLintNote",
      },
      { titleKey: "helpQueryBuilderTitle", descKey: "helpQueryBuilderDesc", impact: "no" },
      { titleKey: "helpSnippetTitle", descKey: "helpSnippetDesc", impact: "no" },
      { titleKey: "helpExportTitle", descKey: "helpExportDesc", impact: "no" },
      {
        titleKey: "helpProfileBackupTitle",
        descKey: "helpProfileBackupDesc",
        impact: "no",
        stepKeys: [
          "helpProfileBackupStep1",
          "helpProfileBackupStep2",
          "helpProfileBackupStep3",
        ],
        noteKey: "helpProfileBackupNote",
      },
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
      {
        titleKey: "helpSandboxTitle",
        descKey: "helpSandboxDesc",
        impact: "no",
        noteKey: "helpSandboxNote",
      },
      {
        titleKey: "helpTaskSchedulerTitle",
        descKey: "helpTaskSchedulerDesc",
        impact: "no",
        noteKey: "helpTaskSchedulerNote",
      },
      {
        titleKey: "helpFlightRecorderTitle",
        descKey: "helpFlightRecorderDesc",
        impact: "no",
        stepKeys: [
          "helpFlightRecorderStep1",
          "helpFlightRecorderStep2",
          "helpFlightRecorderStep3",
        ],
        noteKey: "helpFlightRecorderNote",
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
      { titleKey: "helpTypeToConfirmTitle", descKey: "helpTypeToConfirmDesc" },
      { titleKey: "helpEmergencyModeTitle", descKey: "helpEmergencyModeDesc" },
    ],
  },
  {
    headerKey: "helpSectionConnection",
    descKey: "helpSectionConnectionDesc",
    features: [
      {
        // AWS IAM 認証 (#734)。トークン失効 (15 分) 後の再接続挙動をここに明記する。
        titleKey: "helpAwsIamTitle",
        descKey: "helpAwsIamDesc",
        stepKeys: ["helpAwsIamStep1", "helpAwsIamStep2", "helpAwsIamStep3"],
        noteKey: "helpAwsIamNote",
      },
    ],
  },
  {
    headerKey: "helpSectionShortcuts",
    descKey: "helpSectionShortcutsDesc",
    // ショートカット一覧は `shortcuts.ts` の単一ソースから生成し、`?` で開く
    // チートシート (`ShortcutCheatSheet`) と定義を共有する。
    features: SHORTCUTS.map((s) => ({
      titleKey: s.keysKey,
      descKey: s.descKey,
      ...(s.id ? { shortcutId: s.id } : {}),
    })),
  },
];

function DbImpactBadge({ impact }: { impact: Impact }) {
  const t = useT();
  const writes = impact === "yes";
  const tone = writes ? semanticColorVar("danger", "solid") : semanticColorVar("success", "solid");
  return (
    <chakra.span
      // a11y ベースライン (a11y.browser.test.tsx) が対象ノードを特定する
      // ための安定クラス。配色調整 (#559) で AA を満たしたら外してよい。
      className="help-impact-badge"
      display="inline-flex"
      alignItems="center"
      gap="1.25"
      px="2"
      py="0.5"
      borderRadius="pill"
      textStyle="overline"
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

/** 節ナビ / スクロール先に使う DOM id (節の見出し i18n キーから一意に決まる)。 */
function sectionDomId(section: Section): string {
  return `help-sec-${section.headerKey}`;
}

interface HelpViewProps {
  onClose: () => void;
  /** 「ツアーをもう一度見る」(#1274)。未指定ならボタンを出さない。 */
  onStartTour?: () => void;
  /** 「ショートカット一覧」(#1274)。未指定ならボタンを出さない。 */
  onOpenCheatSheet?: () => void;
}

export function HelpView({ onClose, onStartTour, onOpenCheatSheet }: HelpViewProps) {
  const t = useT();
  const settings = useSettings();
  const resolved = resolveShortcutBindings(settings.shortcutOverrides);

  // 節ナビ + 検索 (#1273)。設定画面 (#680) と同じ構造・同じ純ロジック (`sectionNav.ts`)。
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<string>(sectionDomId(SECTIONS[0]));
  const suppressSpyUntilRef = useRef(0);

  const featureTitle = (f: Feature) =>
    f.shortcutId ? formatCombo(resolved[f.shortcutId]) : t(f.titleKey);
  const visibleSections = filterHelpSections(
    SECTIONS.map((sec) => ({
      ...sec,
      header: t(sec.headerKey),
      desc: t(sec.descKey),
    })),
    query,
    (f: Feature) => ({
      title: featureTitle(f),
      desc: t(f.descKey),
      steps: f.stepKeys?.map((k) => t(k)),
      note: f.noteKey ? t(f.noteKey) : undefined,
    }),
  );

  const handleNavClick = (id: string) => {
    setActiveSection(id);
    suppressSpyUntilRef.current = Date.now() + 600;
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (Date.now() < suppressSpyUntilRef.current) return;
    const container = e.currentTarget;
    const containerTop = container.getBoundingClientRect().top;
    const ids = visibleSections.map(sectionDomId);
    const next = pickActiveSection(
      ids,
      ids.map((id) => {
        const el = document.getElementById(id);
        return el ? el.getBoundingClientRect().top - containerTop : null;
      }),
      container.scrollTop + container.clientHeight >= container.scrollHeight - 4,
    );
    if (next) setActiveSection(next);
  };

  return (
    <Modal
      // no-submit: 参照画面 (閉じるのみ)
      onClose={onClose} width="1120px">
      <ModalHeader onClose={onClose} closeLabel={t("helpClose")}>
        {t("helpTitle")}
      </ModalHeader>
      <ModalBody onScroll={handleScroll}>
        <chakra.div display="flex" gap="4" alignItems="flex-start">
          <SettingsNavAside aria-label={t("helpNavAria")}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("helpSearchPlaceholder")}
              aria-label={t("helpSearchPlaceholder")}
            />
            {visibleSections.length === 0 ? (
              <SettingsNavEmpty>{t("helpSearchNoMatch")}</SettingsNavEmpty>
            ) : (
              <SettingsNavList role="navigation" aria-label={t("helpTitle")}>
                {visibleSections.map((sec) => (
                  <SettingsNavButton
                    key={sec.headerKey}
                    type="button"
                    aria-current={activeSection === sectionDomId(sec)}
                    onClick={() => handleNavClick(sectionDomId(sec))}
                  >
                    {sec.header}
                  </SettingsNavButton>
                ))}
              </SettingsNavList>
            )}
          </SettingsNavAside>
          <chakra.div display="flex" flexDirection="column" gap="4.5" flex="1" minW={0}>
            <SettingsHelp fontSize="md" lineHeight="1.5">{t("helpIntro")}</SettingsHelp>

            {(onStartTour || onOpenCheatSheet) && (
              <chakra.div display="flex" gap="2" flexWrap="wrap">
                {onStartTour && (
                  <Button size="sm" onClick={onStartTour}>
                    {t("helpReplayTour")}
                  </Button>
                )}
                {onOpenCheatSheet && (
                  <Button size="sm" onClick={onOpenCheatSheet}>
                    {t("helpOpenCheatSheet")}
                  </Button>
                )}
              </chakra.div>
            )}

            {visibleSections.map((section) => (
              <SettingsSection
                key={section.headerKey}
                id={sectionDomId(section)}
                scrollMarginTop="8px"
              >
                <SettingsSectionHeader>
                  <chakra.h3>{section.header}</chakra.h3>
                </SettingsSectionHeader>
                <SettingsHelp>{section.desc}</SettingsHelp>

                <HelpFeatureGrid>
                  {section.features.map((f) => (
                    <HelpFeature key={f.titleKey}>
                      <HelpFeatureHead>
                        <chakra.h4>{featureTitle(f)}</chakra.h4>
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
        </chakra.div>
      </ModalBody>
    </Modal>
  );
}
