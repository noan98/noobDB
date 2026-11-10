import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { directionalSlide, transitions } from "../motion";
import { useT } from "../i18n";
import {
  filterShortcuts,
  resolveShortcutBindings,
  SHORTCUTS,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
} from "../shortcuts";
import { formatCombo } from "../shortcutKeys";
import { markFeatureTried, useSettings } from "../settings";
import { groupProgress, overallProgress, recommendNext, type MasteryFeatureId } from "../mastery";
import { ActiveRowHighlight } from "./ActiveRowHighlight";
import { Callout } from "./Callout";
import { CountUp } from "./CountUp";
import { MasteryRing } from "./MasteryRing";
import { Icon, type IconName } from "./Icon";
import { Kbd } from "./Kbd";
import { Modal, ModalBody, ModalHeader } from "./Modal";
import { Button, Input } from "./ui";
import { filterHelpSections } from "../helpSearch";

/*
 * 機能ガイド (ヘルプ)。「目次 + 詳細」の 2 ペイン構成。
 *
 * - 左: 検索欄と、用途別グループに分けた全項目の目次。DB に書き込む項目には赤い点を付ける
 *   (読み取りのみの項目にはバッジを付けない — 以前は全カードに「反映されない」が並び、
 *   本当に注意すべき項目が埋もれていた)。
 * - 右: 選んだ 1 項目だけを大きめの文字で表示する。手順は番号付き、注意は警告の Callout。
 *   末尾の「前へ / 次へ」で目次順に読み進められる。
 * - ショートカットはカードではなく、カテゴリ別の「キー | 説明」の表にする。
 */

type Key = Parameters<ReturnType<typeof useT>>[0];
type Impact = "yes" | "no";

/** 『試す』ボタンの行き先 (#1631)。実際に開く処理は App が持つ (`onOpenFeature`)。 */
type HelpTryTarget =
  | { kind: "newQuery" }
  | { kind: "snippetForm" }
  | { kind: "settings"; section: string }
  | { kind: "view"; view: "compare" | "tasks" | "newConnection" };

interface Feature {
  /** 項目タイトルの i18n キー。習熟マップ (`mastery.ts`) の項目 ID を兼ねる (#2216)。 */
  titleKey: MasteryFeatureId;
  descKey: Key;
  impact?: Impact;
  stepKeys?: Key[];
  noteKey?: Key;
  /** 『試す』ボタンで開く画面 (#1631)。 */
  tryTarget?: HelpTryTarget;
  /** 『試す』を出せない項目の理由 (#2216)。`tryTarget` が無い項目は必ずどちらかを持つ。 */
  noTryKey?: Key;
  /** 『試す』で画面を開いた時点で「試した」と記録する (設定画面・全画面の参照系の項目)。 */
  markOnOpen?: boolean;
  /** 詳細を表示した時点で「試した」と記録する (読むだけの手順の項目)。 */
  markOnView?: boolean;
  /** 項目固有のグリフ。未指定なら節の `icon` (#1835)。 */
  icon?: IconName;
}

interface Section {
  headerKey: Key;
  /** 節の既定グリフ。各項目は `Feature.icon` で上書きできる (#1835)。 */
  icon: IconName;
  features: Feature[];
}

// 用途別のグループ。以前は「DB に反映されない / される」で 2 分していたが、前者に
// 16 項目が詰め込まれて探しにくかったため、作業の流れに沿って分け直した。DB への
// 影響は各項目の `impact` (目次の赤い点と詳細のバッジ) で示す。
const SECTIONS: Section[] = [
  {
    headerKey: "helpGroupQuery",
    icon: "query",
    features: [
      {
        titleKey: "helpRunTitle",
        icon: "play",
        descKey: "helpRunDesc",
        impact: "yes",
        tryTarget: { kind: "newQuery" },
      },
      {
        titleKey: "helpDryRunTitle",
        icon: "eye",
        tryTarget: { kind: "newQuery" },
        descKey: "helpDryRunDesc",
        impact: "no",
        stepKeys: ["helpDryRunStep1", "helpDryRunStep2", "helpDryRunStep3"],
        noteKey: "helpDryRunNote",
      },
      {
        titleKey: "helpExplainTitle",
        icon: "explain",
        descKey: "helpExplainDesc",
        impact: "no",
        tryTarget: { kind: "newQuery" },
      },
      {
        titleKey: "helpFormatTitle",
        icon: "format",
        descKey: "helpFormatDesc",
        impact: "no",
        tryTarget: { kind: "newQuery" },
      },
      {
        titleKey: "helpSqlLintTitle",
        markOnOpen: true,
        icon: "warning",
        tryTarget: { kind: "settings", section: "settings-sec-sql-lint" },
        descKey: "helpSqlLintDesc",
        impact: "no",
        noteKey: "helpSqlLintNote",
      },
      {
        titleKey: "helpQueryBuilderTitle",
        icon: "columns",
        descKey: "helpQueryBuilderDesc",
        impact: "no",
        tryTarget: { kind: "newQuery" },
      },
      {
        titleKey: "helpSnippetTitle",
        icon: "snippet",
        descKey: "helpSnippetDesc",
        impact: "no",
        tryTarget: { kind: "snippetForm" },
      },
      {
        titleKey: "helpHistoryTitle",
        markOnOpen: true,
        icon: "clock",
        descKey: "helpHistoryDesc",
        impact: "no",
        tryTarget: { kind: "settings", section: "settings-sec-history" },
      },
    ],
  },
  {
    headerKey: "helpGroupResults",
    icon: "table",
    features: [
      {
        titleKey: "helpPaginationTitle",
        icon: "list",
        descKey: "helpPaginationDesc",
        impact: "no",
        tryTarget: { kind: "settings", section: "settings-sec-result-grid" },
        markOnOpen: true,
      },
      {
        titleKey: "helpCellEditTitle",
        icon: "table",
        descKey: "helpCellEditDesc",
        impact: "no",
        noTryKey: "helpNoTryResultGrid",
      },
      {
        titleKey: "helpDiscardTitle",
        icon: "undo",
        descKey: "helpDiscardDesc",
        impact: "no",
        noTryKey: "helpNoTryResultGrid",
      },
      {
        titleKey: "helpApplyTitle",
        noTryKey: "helpNoTryResultGrid",
        icon: "check",
        descKey: "helpApplyDesc",
        impact: "yes",
        noteKey: "helpApplyNote",
      },
      {
        titleKey: "helpExportTitle",
        icon: "download",
        descKey: "helpExportDesc",
        impact: "no",
        noTryKey: "helpNoTryResultGrid",
      },
      {
        titleKey: "helpImportTitle",
        icon: "upload",
        descKey: "helpImportDesc",
        impact: "yes",
        noTryKey: "helpNoTryImport",
      },
    ],
  },
  {
    headerKey: "helpGroupCompare",
    icon: "diff",
    features: [
      {
        titleKey: "helpSchemaCompareTitle",
        icon: "diff",
        tryTarget: { kind: "view", view: "compare" },
        descKey: "helpSchemaCompareDesc",
        impact: "no",
        noteKey: "helpSchemaCompareNote",
      },
      {
        titleKey: "helpSandboxTitle",
        noTryKey: "helpNoTrySandbox",
        icon: "flask",
        descKey: "helpSandboxDesc",
        impact: "no",
        noteKey: "helpSandboxNote",
      },
      {
        titleKey: "helpFlightRecorderTitle",
        markOnOpen: true,
        icon: "broadcast",
        tryTarget: { kind: "settings", section: "settings-sec-flight-recorder" },
        descKey: "helpFlightRecorderDesc",
        impact: "no",
        stepKeys: ["helpFlightRecorderStep1", "helpFlightRecorderStep2", "helpFlightRecorderStep3"],
        noteKey: "helpFlightRecorderNote",
      },
    ],
  },
  {
    headerKey: "helpGroupAutomation",
    icon: "calendar",
    features: [
      {
        titleKey: "helpTaskSchedulerTitle",
        icon: "calendar",
        tryTarget: { kind: "view", view: "tasks" },
        descKey: "helpTaskSchedulerDesc",
        impact: "no",
        noteKey: "helpTaskSchedulerNote",
      },
      {
        titleKey: "helpProfileBackupTitle",
        markOnOpen: true,
        icon: "transfer",
        tryTarget: { kind: "settings", section: "settings-sec-backup" },
        descKey: "helpProfileBackupDesc",
        impact: "no",
        stepKeys: ["helpProfileBackupStep1", "helpProfileBackupStep2", "helpProfileBackupStep3"],
        noteKey: "helpProfileBackupNote",
      },
    ],
  },
  {
    headerKey: "helpSectionGuards",
    icon: "lock",
    features: [
      {
        titleKey: "helpReadOnlyTitle",
        descKey: "helpReadOnlyDesc",
        tryTarget: { kind: "view", view: "newConnection" },
      },
      {
        titleKey: "helpProductionTitle",
        icon: "production",
        descKey: "helpProductionDesc",
        tryTarget: { kind: "view", view: "newConnection" },
      },
      {
        titleKey: "helpConfirmWritesTitle",
        descKey: "helpConfirmWritesDesc",
        tryTarget: { kind: "view", view: "newConnection" },
      },
      {
        titleKey: "helpTypeToConfirmTitle",
        descKey: "helpTypeToConfirmDesc",
        noTryKey: "helpNoTryTypeToConfirm",
      },
      {
        titleKey: "helpEmergencyModeTitle",
        icon: "alert-circle",
        descKey: "helpEmergencyModeDesc",
        noTryKey: "helpNoTryEmergency",
      },
    ],
  },
  {
    headerKey: "helpSectionConnection",
    icon: "server",
    features: [
      {
        // AWS IAM 認証 (#734)。トークン失効 (15 分) 後の再接続挙動をここに明記する。
        titleKey: "helpAwsIamTitle",
        icon: "key",
        tryTarget: { kind: "view", view: "newConnection" },
        descKey: "helpAwsIamDesc",
        stepKeys: ["helpAwsIamStep1", "helpAwsIamStep2", "helpAwsIamStep3"],
        noteKey: "helpAwsIamNote",
      },
      {
        // AWS SSM (Session Manager) 経路 (#1977)。フォームのヘルプ文 (formSsm*) と内容を揃える。
        titleKey: "helpSsmTitle",
        icon: "server",
        tryTarget: { kind: "view", view: "newConnection" },
        descKey: "helpSsmDesc",
        stepKeys: ["helpSsmStep1", "helpSsmStep2", "helpSsmStep3", "helpSsmStep4"],
        noteKey: "helpSsmNote",
      },
      {
        titleKey: "helpSsmTroubleTitle",
        noTryKey: "helpNoTryGuide",
        markOnView: true,
        icon: "alert-circle",
        descKey: "helpSsmTroubleDesc",
        stepKeys: ["helpSsmTrouble1", "helpSsmTrouble2", "helpSsmTrouble3", "helpSsmTrouble4"],
      },
    ],
  },
  {
    // AI 基盤 (#690)。何を送る / 送らないか、モデルの保持要件、価格の目安を明記する。
    headerKey: "helpSectionAi",
    icon: "sparkles",
    features: [
      {
        titleKey: "helpAiPolicyTitle",
        tryTarget: { kind: "settings", section: "settings-sec-ai" },
        markOnOpen: true,
        descKey: "helpAiPolicyDesc",
        stepKeys: ["helpAiPolicySend", "helpAiPolicyNotSend", "helpAiPolicyKey", "helpAiPolicyRetention"],
        noteKey: "helpAiPolicyNote",
      },
      {
        titleKey: "helpAiImpactTitle",
        tryTarget: { kind: "settings", section: "settings-sec-ai" },
        markOnOpen: true,
        descKey: "helpAiImpactDesc",
        stepKeys: ["helpAiImpactStep1", "helpAiImpactStep2"],
        noteKey: "helpAiImpactNote",
      },
      {
        titleKey: "helpAiPricingTitle",
        tryTarget: { kind: "settings", section: "settings-sec-ai" },
        markOnOpen: true,
        icon: "chart",
        descKey: "helpAiPricingDesc",
        stepKeys: ["helpAiPriceOpus", "helpAiPriceSonnet", "helpAiPriceHaiku", "helpAiPriceFable"],
      },
    ],
  },
];

const FEATURE_BY_ID = new Map<string, { feature: Feature; section: Section }>(
  SECTIONS.flatMap((section) =>
    section.features.map((feature) => [feature.titleKey, { feature, section }] as const),
  ),
);

/** ショートカット表の擬似項目 id (目次の末尾に置く)。 */
const SHORTCUTS_ID = "shortcuts";

/** 目次の項目 id (= 詳細ペインに表示する対象)。項目は i18n キーで一意。 */
function featureId(f: Feature): string {
  return `help-item-${f.titleKey}`;
}

/** DB への影響を示すピル。書き込む項目は danger、読み取りのみは success の文字色。 */
function ImpactPill({ impact }: { impact: Impact }) {
  const t = useT();
  const writes = impact === "yes";
  return (
    <chakra.span
      // a11y ベースライン (a11y.browser.test.tsx) が対象ノードを特定するための安定クラス。
      className="help-impact-badge"
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="2"
      py="0.5"
      borderRadius="pill"
      textStyle="overline"
      whiteSpace="nowrap"
      border="1px solid"
      borderColor={writes ? "app.textError" : "app.borderSubtle"}
      color={writes ? "app.textError" : "app.textSuccess"}
    >
      <Icon name={writes ? "pencil" : "eye"} size="sm" />
      {t(writes ? "helpImpactWrites" : "helpImpactReadOnly")}
    </chakra.span>
  );
}

/** 「試した」の印 (詳細ペインのタイトル横)。 */
function TriedPill() {
  const t = useT();
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="2"
      py="0.5"
      borderRadius="pill"
      textStyle="overline"
      whiteSpace="nowrap"
      border="1px solid"
      borderColor="app.borderSubtle"
      color="app.textSuccess"
      data-testid="mastery-tried-pill"
    >
      <Icon name="check" size="sm" />
      {t("helpMasteryTried")}
    </chakra.span>
  );
}

/** グループ見出しの進捗リング + 「試した数 / 総数」(#2216)。 */
function GroupProgressBadge({ done, total }: { done: number; total: number }) {
  return (
    <chakra.span display="inline-flex" alignItems="center" gap="1" textTransform="none">
      <MasteryRing done={done} total={total} />
      <CountUp value={done} />
      <chakra.span aria-hidden="true">/{total}</chakra.span>
    </chakra.span>
  );
}

const NavGroupLabel = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "1.5",
    px: "2",
    pt: "3",
    pb: "1",
    textStyle: "overline",
    color: "app.textMuted",
  },
});

const NavItem = chakra("button", {
  base: {
    // アクティブ行の背景は滑る ActiveRowHighlight (設定画面の左ナビと同じ layoutId 手法) が担う。
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "2",
    width: "100%",
    textAlign: "left",
    pl: "6",
    pr: "2",
    py: "1",
    border: "none",
    borderRadius: "sm",
    background: "transparent",
    color: "app.textSecondary",
    fontSize: "sm",
    lineHeight: "var(--leading-normal)",
    cursor: "pointer",
    _hover: { background: "app.hover", color: "app.text" },
    _focusVisible: { outline: "none", boxShadow: "var(--focus-ring)" },
    "&[aria-current=true]": { color: "app.text", fontWeight: 600 },
  },
});

const WriteDot = chakra("span", {
  base: { flexShrink: 0, width: "1.5", height: "1.5", borderRadius: "pill", background: "app.textError" },
});

const StepNumber = chakra("span", {
  base: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "6",
    height: "6",
    borderRadius: "pill",
    border: "1px solid",
    borderColor: "app.border",
    background: "app.surfaceMuted",
    color: "app.accent",
    fontSize: "xs",
    fontWeight: 600,
  },
});

interface HelpViewProps {
  onClose: () => void;
  /** 「ツアーをもう一度見る」(#1274)。未指定ならボタンを出さない。 */
  onStartTour?: () => void;
  /** 「ショートカット一覧」(#1274)。未指定ならボタンを出さない。 */
  onOpenCheatSheet?: () => void;
  /** 詳細の『試す』ボタン (#1631)。未指定ならボタンを出さない。 */
  onOpenFeature?: (target: HelpTryTarget) => void;
}

export function HelpView({ onClose, onStartTour, onOpenCheatSheet, onOpenFeature }: HelpViewProps) {
  const t = useT();
  const settings = useSettings();
  // 習熟マップ (#2216)。記録がオフのときは印・リング・おすすめを出さない。
  const tracking = settings.masteryTrackingEnabled;
  const tried = settings.masteryTried;
  const progressByGroup = new Map(groupProgress(tried).map((g) => [g.group as string, g]));
  const overall = overallProgress(tried);
  const resolved = resolveShortcutBindings(settings.shortcutOverrides);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>(featureId(SECTIONS[0].features[0]));
  // 目次の滑るインジケータ (設定画面と同じ layoutId 手法)。ダイアログごとに名前空間を分ける。
  const navHighlightId = `help-nav-highlight-${useId()}`;
  // 詳細ペインの入場方向。目次で後ろへ進むとき +1 (右から)、前へ戻るとき -1 (左から)。
  const [slideDir, setSlideDir] = useState(0);
  // reduced-motion (OS 設定とアプリ内設定の両方) では opacity の補間も止めて即時に切り替える。
  const reducedMotion = useReducedMotionConfig() ?? false;
  const searchRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const visibleSections = filterHelpSections(
    SECTIONS.map((sec) => ({ ...sec, header: t(sec.headerKey), desc: "" })),
    query,
    (f: Feature) => ({
      title: t(f.titleKey),
      desc: t(f.descKey),
      steps: f.stepKeys?.map((k) => t(k)),
      note: f.noteKey ? t(f.noteKey) : undefined,
    }),
  );
  const shortcutKeysText = (s: (typeof SHORTCUTS)[number]) =>
    s.id ? formatCombo(resolved[s.id]) : t(s.keysKey);
  const shortcutsTitle = t("helpSectionShortcuts");
  const visibleShortcuts =
    query.trim() === "" || shortcutsTitle.toLowerCase().includes(query.trim().toLowerCase())
      ? SHORTCUTS
      : filterShortcuts(SHORTCUTS, query, (s) => ({ label: t(s.descKey), keys: shortcutKeysText(s) }));

  // 目次の並び順そのままの id 列。前へ / 次へ・矢印キー・検索後の自動選択に使う。
  const orderedIds = [
    ...visibleSections.flatMap((sec) => sec.features.map(featureId)),
    ...(visibleShortcuts.length > 0 ? [SHORTCUTS_ID] : []),
  ];
  // 検索で選択中の項目が消えたら、残った先頭を表示する (state は変えない — 検索を消せば戻る)。
  const current = orderedIds.includes(selected) ? selected : orderedIds[0];
  const currentIndex = current ? orderedIds.indexOf(current) : -1;

  // 読むだけの項目は、詳細を表示した時点で「試した」とする。
  useEffect(() => {
    const entry = current ? FEATURE_BY_ID.get(current.replace(/^help-item-/, "")) : undefined;
    if (entry?.feature.markOnView) markFeatureTried(entry.feature.titleKey);
  }, [current]);

  /** 「次のおすすめ」から飛ぶ。検索で絞られていて目次に無いときは絞り込みを解除する。 */
  const jumpTo = (featureKey: string) => {
    const id = `help-item-${featureKey}`;
    if (!orderedIds.includes(id)) setQuery("");
    setSlideDir(1);
    setSelected(id);
  };

  const select = (id: string, focus = false) => {
    const to = orderedIds.indexOf(id);
    if (to >= 0 && currentIndex >= 0 && to !== currentIndex) setSlideDir(to > currentIndex ? 1 : -1);
    setSelected(id);
    if (focus) navRef.current?.querySelector<HTMLElement>(`[data-help-id="${id}"]`)?.focus();
  };

  const handleNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (orderedIds.length === 0) return;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(orderedIds.length - 1, Math.max(0, currentIndex + delta));
    select(orderedIds[next], true);
  };

  const titleOf = (id: string): string => {
    if (id === SHORTCUTS_ID) return shortcutsTitle;
    for (const sec of SECTIONS) {
      const f = sec.features.find((x) => featureId(x) === id);
      if (f) return t(f.titleKey);
    }
    return "";
  };

  const renderFeature = (sec: (typeof visibleSections)[number], f: Feature) => {
    const title = t(f.titleKey);
    const isTried = tried.includes(f.titleKey);
    const next = tracking ? recommendNext(f.titleKey, tried) : [];
    return (
      <chakra.article display="flex" flexDirection="column" gap="4" aria-labelledby="help-detail-title">
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.div textStyle="caption" color="app.textMuted" display="flex" alignItems="center" gap="1.5">
            <Icon name={sec.icon} size="sm" />
            {sec.header}
          </chakra.div>
          <chakra.div display="flex" alignItems="center" gap="3" flexWrap="wrap">
            <chakra.span color="app.accent" display="inline-flex" aria-hidden="true">
              <Icon name={f.icon ?? sec.icon} size="lg" />
            </chakra.span>
            <chakra.h3 id="help-detail-title" m="0" fontSize="xl" fontWeight="semibold" lineHeight="1.3">
              {title}
            </chakra.h3>
            {f.impact && <ImpactPill impact={f.impact} />}
            {tracking && isTried && <TriedPill />}
          </chakra.div>
        </chakra.div>

        <chakra.p m="0" fontSize="md" lineHeight="1.8" color="app.text">
          {t(f.descKey)}
        </chakra.p>

        {f.stepKeys && (
          <chakra.section>
            <chakra.h4 m="0" mb="2" textStyle="subheading">
              {t("helpUsageTitle")}
            </chakra.h4>
            <chakra.ol m="0" p="0" listStyle="none" display="flex" flexDirection="column" gap="2.5">
              {f.stepKeys.map((s, i) => (
                <chakra.li
                  key={s}
                  display="flex"
                  gap="3"
                  alignItems="flex-start"
                  fontSize="md"
                  lineHeight="1.7"
                >
                  <StepNumber aria-hidden="true">{i + 1}</StepNumber>
                  <chakra.span color="app.text">{t(s)}</chakra.span>
                </chakra.li>
              ))}
            </chakra.ol>
          </chakra.section>
        )}

        {f.noteKey && (
          <Callout tone="warning" title={t("helpNoteLabel")}>
            {t(f.noteKey)}
          </Callout>
        )}

        {onOpenFeature && f.tryTarget && (
          <chakra.div>
            <Button
              size="sm"
              variant="primary"
              data-testid="help-try"
              aria-label={t("helpTryAria", { title })}
              onClick={() => {
                if (f.tryTarget) onOpenFeature(f.tryTarget);
                if (f.markOnOpen) markFeatureTried(f.titleKey);
              }}
            >
              <Icon name="external-link" size="sm" />
              {t("helpTry")}
            </Button>
          </chakra.div>
        )}

        {f.noTryKey && (
          <Callout tone="info" title={t("helpNoTryTitle")}>
            {t(f.noTryKey)}
          </Callout>
        )}

        {next.length > 0 && (
          <chakra.section data-testid="help-next-recommend">
            <chakra.h4 m="0" mb="2" textStyle="subheading">
              {t("helpRecommendTitle")}
            </chakra.h4>
            <chakra.div display="flex" flexWrap="wrap" gap="2">
              {next.map((id) => {
                const entry = FEATURE_BY_ID.get(id);
                if (!entry) return null;
                return (
                  <Button key={id} size="sm" variant="secondary" onClick={() => jumpTo(id)}>
                    <Icon name={entry.feature.icon ?? entry.section.icon} size="sm" />
                    {t(entry.feature.titleKey)}
                  </Button>
                );
              })}
            </chakra.div>
          </chakra.section>
        )}
      </chakra.article>
    );
  };

  const renderShortcuts = () => (
    <chakra.article display="flex" flexDirection="column" gap="4" aria-labelledby="help-detail-title">
      <chakra.div display="flex" flexDirection="column" gap="1.5">
        <chakra.div display="flex" alignItems="center" gap="3">
          <chakra.span color="app.accent" display="inline-flex" aria-hidden="true">
            <Icon name="query" size="lg" />
          </chakra.span>
          <chakra.h3 id="help-detail-title" m="0" fontSize="xl" fontWeight="semibold" lineHeight="1.3">
            {shortcutsTitle}
          </chakra.h3>
        </chakra.div>
        <chakra.p m="0" fontSize="sm" color="app.textMuted">
          {t("helpSectionShortcutsDesc")}
        </chakra.p>
      </chakra.div>
      {SHORTCUT_CATEGORY_ORDER.map((category) => {
        const items = visibleShortcuts.filter((s) => s.category === category);
        if (items.length === 0) return null;
        return (
          <chakra.section key={category}>
            <chakra.h4 m="0" mb="1.5" textStyle="overline" color="app.textMuted">
              {t(SHORTCUT_CATEGORY_LABEL[category])}
            </chakra.h4>
            <chakra.table width="100%" borderCollapse="collapse" fontSize="sm">
              <tbody>
                {items.map((s) => (
                  <chakra.tr key={s.keysKey} borderBottom="1px solid" borderColor="app.borderSubtle">
                    <chakra.td py="1.5" pr="4" width="38%" verticalAlign="top">
                      <Kbd splitCombo>{shortcutKeysText(s)}</Kbd>
                    </chakra.td>
                    <chakra.td py="1.5" color="app.text" lineHeight="var(--leading-normal)">
                      {t(s.descKey)}
                    </chakra.td>
                  </chakra.tr>
                ))}
              </tbody>
            </chakra.table>
          </chakra.section>
        );
      })}
    </chakra.article>
  );

  const renderDetail = () => {
    if (!current) {
      return (
        <chakra.p m="0" color="app.textMuted" role="status">
          {t("helpSearchNoMatch")}
        </chakra.p>
      );
    }
    if (current === SHORTCUTS_ID) return renderShortcuts();
    for (const sec of visibleSections) {
      const f = sec.features.find((x) => featureId(x) === current);
      if (f) return renderFeature(sec, f);
    }
    return null;
  };

  const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] : undefined;
  const nextId =
    currentIndex >= 0 && currentIndex < orderedIds.length - 1 ? orderedIds[currentIndex + 1] : undefined;

  return (
    <Modal
      // no-submit: 参照画面 (閉じるのみ)
      onClose={onClose}
      width="1120px"
      initialFocusEl={() => searchRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("helpClose")} brandRule>
        {t("helpTitle")}
      </ModalHeader>
      <ModalBody p="0" overflow="hidden" display="flex">
        <chakra.div display="flex" width="100%" height="min(680px, calc(90vh - 72px))" minH="0">
          <chakra.aside
            aria-label={t("helpNavAria")}
            width="300px"
            flexShrink={0}
            display="flex"
            flexDirection="column"
            borderRight="1px solid"
            borderColor="app.borderSubtle"
            minH="0"
          >
            {tracking && (
              <chakra.div
                px="4"
                pt="3"
                textStyle="caption"
                display="flex"
                alignItems="center"
                gap="1.5"
                data-testid="mastery-overall"
              >
                <MasteryRing done={overall.done} total={overall.total} />
                <chakra.span>
                  {t("helpMasteryOverall", { done: String(overall.done), total: String(overall.total) })}
                </chakra.span>
              </chakra.div>
            )}
            <chakra.div px="3" pt="3" pb="2">
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // 検索欄から ↓ で目次へ降りられるようにする。
                  if (e.key === "ArrowDown" && current) {
                    e.preventDefault();
                    select(current, true);
                  }
                }}
                placeholder={t("helpSearchPlaceholder")}
                aria-label={t("helpSearchPlaceholder")}
                autoComplete="off"
              />
              <chakra.div
                mt="1.5"
                display="flex"
                alignItems="center"
                gap="1.5"
                textStyle="caption"
                color="app.textMuted"
              >
                <WriteDot aria-hidden="true" />
                {t("helpWritesLegend")}
              </chakra.div>
            </chakra.div>
            {orderedIds.length === 0 ? (
              <chakra.p px="4" py="2" m="0" fontSize="sm" color="app.textMuted" role="status">
                {t("helpSearchNoMatch")}
              </chakra.p>
            ) : (
              <chakra.nav
                ref={navRef}
                aria-label={t("helpTitle")}
                flex="1"
                minH="0"
                overflowY="auto"
                px="2"
                pb="3"
                onKeyDown={handleNavKeyDown}
              >
                {visibleSections.map((sec) => (
                  <chakra.div
                    key={sec.headerKey}
                    role="group"
                    aria-label={
                      tracking && progressByGroup.get(sec.headerKey)
                        ? `${sec.header} (${t("helpMasteryGroupProgress", {
                            done: String(progressByGroup.get(sec.headerKey)?.done ?? 0),
                            total: String(progressByGroup.get(sec.headerKey)?.total ?? 0),
                          })})`
                        : sec.header
                    }
                  >
                    <NavGroupLabel aria-hidden="true">
                      <Icon name={sec.icon} size="sm" />
                      <chakra.span flex="1">{sec.header}</chakra.span>
                      {tracking && progressByGroup.get(sec.headerKey) && (
                        <GroupProgressBadge
                          done={progressByGroup.get(sec.headerKey)?.done ?? 0}
                          total={progressByGroup.get(sec.headerKey)?.total ?? 0}
                        />
                      )}
                    </NavGroupLabel>
                    {sec.features.map((f) => {
                      const id = featureId(f);
                      return (
                        <NavItem
                          key={id}
                          type="button"
                          data-help-id={id}
                          aria-current={current === id}
                          tabIndex={current === id ? 0 : -1}
                          onClick={() => select(id)}
                        >
                          {current === id && <ActiveRowHighlight layoutId={navHighlightId} />}
                          <chakra.span position="relative" zIndex={1} flex="1" minW="0">
                            {t(f.titleKey)}
                          </chakra.span>
                          {tracking && tried.includes(f.titleKey) && (
                            <>
                              <chakra.span
                                position="relative"
                                zIndex={1}
                                display="inline-flex"
                                color="app.textSuccess"
                                aria-hidden="true"
                                data-testid="mastery-tried-mark"
                              >
                                <Icon name="check" size="sm" />
                              </chakra.span>
                              <chakra.span srOnly>{t("helpMasteryTried")}</chakra.span>
                            </>
                          )}
                          {f.impact === "yes" && (
                            <>
                              <WriteDot position="relative" zIndex={1} aria-hidden="true" />
                              <chakra.span srOnly>{t("helpImpactWrites")}</chakra.span>
                            </>
                          )}
                        </NavItem>
                      );
                    })}
                  </chakra.div>
                ))}
                {visibleShortcuts.length > 0 && (
                  <chakra.div mt="2" pt="2" borderTop="1px solid" borderColor="app.borderSubtle">
                    <NavItem
                      type="button"
                      data-help-id={SHORTCUTS_ID}
                      aria-current={current === SHORTCUTS_ID}
                      tabIndex={current === SHORTCUTS_ID ? 0 : -1}
                      onClick={() => select(SHORTCUTS_ID)}
                      pl="2"
                    >
                      {current === SHORTCUTS_ID && <ActiveRowHighlight layoutId={navHighlightId} />}
                      <chakra.span position="relative" zIndex={1} display="inline-flex" aria-hidden="true">
                        <Icon name="query" size="sm" />
                      </chakra.span>
                      <chakra.span position="relative" zIndex={1} flex="1">
                        {shortcutsTitle}
                      </chakra.span>
                    </NavItem>
                  </chakra.div>
                )}
              </chakra.nav>
            )}
            {(onStartTour || onOpenCheatSheet) && (
              <chakra.div
                display="flex"
                flexDirection="column"
                gap="1"
                px="3"
                py="2.5"
                borderTop="1px solid"
                borderColor="app.borderSubtle"
              >
                {onStartTour && (
                  <Button size="sm" variant="ghost" justifyContent="flex-start" onClick={onStartTour}>
                    <Icon name="play" size="sm" />
                    {t("helpReplayTour")}
                  </Button>
                )}
                {onOpenCheatSheet && (
                  <Button size="sm" variant="ghost" justifyContent="flex-start" onClick={onOpenCheatSheet}>
                    <Icon name="query" size="sm" />
                    {t("helpOpenCheatSheet")}
                  </Button>
                )}
              </chakra.div>
            )}
          </chakra.aside>

          <chakra.div ref={detailRef} flex="1" minW="0" overflowY="auto" data-testid="help-detail">
            <chakra.div maxW="760px" px="8" py="6" display="flex" flexDirection="column" gap="6">
              {/* 目次の前後関係に応じて、右 / 左から入るクロスフェード。退場を待ってから次を出す
                  (mode="wait")。先頭へのスクロールは旧内容が退場し終えてから行う。 */}
              <AnimatePresence
                mode="wait"
                initial={false}
                custom={slideDir}
                onExitComplete={() => detailRef.current?.scrollTo?.({ top: 0 })}
              >
                <motion.div
                  key={current ?? "none"}
                  custom={slideDir}
                  variants={directionalSlide}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  transition={reducedMotion ? { duration: 0 } : transitions.enter}
                  data-testid="help-detail-pane"
                  data-slide-dir={slideDir}
                >
                  {renderDetail()}
                </motion.div>
              </AnimatePresence>
              {(prevId || nextId) && (
                <chakra.div
                  display="flex"
                  gap="2"
                  pt="4"
                  borderTop="1px solid"
                  borderColor="app.borderSubtle"
                  justifyContent="space-between"
                >
                  {prevId ? (
                    <Button size="sm" variant="ghost" onClick={() => select(prevId)} data-testid="help-prev">
                      <Icon name="chevron-left" size="sm" />
                      {t("helpPrev", { title: titleOf(prevId) })}
                    </Button>
                  ) : (
                    <span />
                  )}
                  {nextId && (
                    <Button size="sm" variant="ghost" onClick={() => select(nextId)} data-testid="help-next">
                      {t("helpNext", { title: titleOf(nextId) })}
                      <Icon name="chevron-right" size="sm" />
                    </Button>
                  )}
                </chakra.div>
              )}
            </chakra.div>
          </chakra.div>
        </chakra.div>
      </ModalBody>
    </Modal>
  );
}
