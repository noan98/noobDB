import { useEffect, useState } from "react";
import { chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { type DriverKind, type SchemaDiff, type SyncKind, type SyncPlan } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import { dialectLabel, needsSendScopeConfirm } from "../ai/errorExplain";
import {
  buildSyncRiskPrompt,
  countDmlStatements,
  buildSyncRiskSystem,
  finalizeRiskItems,
  groupRiskByIndex,
  parseSyncRiskResponse,
  selectStatementsForPrompt,
  SYNC_RISK_FORMAT,
  type DataSyncSummary,
  type SyncRiskItem,
  type SyncRiskSeverity,
} from "../ai/syncRisk";
import { useAiAvailable } from "../ai/useAiAvailable";
import { useLocale, useT } from "../i18n";
import { semanticColorVar, type SemanticRole } from "../semanticColors";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";

/** index ごとのリスク項目 (同期文の行バッジ用)。 */
export type RiskByIndex = ReadonlyMap<number, readonly SyncRiskItem[]>;

const SEVERITY_ROLE: Record<SyncRiskSeverity, SemanticRole> = {
  high: "danger",
  medium: "warning",
  low: "info",
};

function badgeCss(severity: SyncRiskSeverity): SystemStyleObject {
  const role = SEVERITY_ROLE[severity];
  return {
    display: "inline-block",
    px: "1.5",
    py: "0.25",
    borderRadius: "pill",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: semanticColorVar(role, "border"),
    background: semanticColorVar(role, "subtle"),
    color: semanticColorVar(role, "text"),
    fontSize: "var(--text-xs)",
    flexShrink: 0,
  };
}

/** 同期文の行に付ける重大度バッジ + 説明。 */
export function RiskBadge({ item }: { item: SyncRiskItem }) {
  const t = useT();
  const label =
    item.severity === "high"
      ? t("aiSyncRiskSeverityHigh")
      : item.severity === "medium"
        ? t("aiSyncRiskSeverityMedium")
        : t("aiSyncRiskSeverityLow");
  return (
    <Flex align="baseline" gap="1.5" data-testid="ai-sync-risk-badge" data-severity={item.severity}>
      <chakra.span css={badgeCss(item.severity)}>{label}</chakra.span>
      <chakra.span fontSize="xs" color="app.text" whiteSpace="pre-wrap">
        {item.risk}
      </chakra.span>
    </Flex>
  );
}

type State =
  | { kind: "idle" }
  | { kind: "running"; sends: string }
  | { kind: "done"; sends: string; summary: string; recommendation: string; items: SyncRiskItem[] }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiSyncRiskProps {
  plan: SyncPlan;
  planKind: "schema" | "data";
  diff: SchemaDiff | null;
  dataSummary: DataSyncSummary | null;
  sourceDriver: DriverKind;
  targetDriver: DriverKind;
  /** プラン生成時に使ったフラグ。 */
  allowDestructive: boolean;
  allowDelete: boolean;
  /** 同期文の種別ラベル (一覧表示用)。 */
  kindLabel: (kind: SyncKind) => string;
  /** どちらかの接続が本番扱いか。 */
  isProduction: boolean;
  /** 結果 (または null=クリア) を親へ渡す。親が各同期文にバッジを描く。 */
  onRisks: (risks: RiskByIndex | null) => void;
}

/**
 * 同期 SQL プレビューの下に置く「AI でリスクを要約」ボタンと結果パネル (#697)。
 * オンデマンドのみ (自動送信しない)。AI 無効時は何も描かない。適用フローには一切触れず、
 * 説明の追加だけを行う。プランが変わったら結果は破棄する。
 */
export function AiSyncRisk(props: AiSyncRiskProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const available = useAiAvailable();
  const { confirm, dialog } = useConfirm();
  const [state, setState] = useState<State>({ kind: "idle" });
  const stream = useAiStream({ idPrefix: "ai_sync" });
  const { onRisks } = props;

  // プランが差し替わったら、実行中の要求を中止して結果を捨てる (古い結果を新しい文に付けない)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: plan の差し替えだけをトリガーにする
  useEffect(() => {
    stream.reset();
    setState({ kind: "idle" });
    onRisks(null);
  }, [props.plan]);

  const sendsLine = () => {
    if (props.planKind === "data") {
      const n = countDmlStatements(props.plan.statements);
      return t("aiSyncRiskSendsData", {
        dialect: dialectLabel(props.targetDriver),
        inserts: n.inserts,
        updates: n.updates,
        deletes: n.deletes,
      });
    }
    const total = props.plan.statements.length;
    const shown = selectStatementsForPrompt(props.plan.statements).length;
    const sql = ai.maskLiterals ? t("aiSyncRiskSqlMasked") : t("aiSyncRiskSqlRaw");
    return shown < total
      ? t("aiSyncRiskSendsSchemaCapped", { dialect: dialectLabel(props.targetDriver), total, shown, sql })
      : t("aiSyncRiskSendsSchema", { dialect: dialectLabel(props.targetDriver), count: total, sql });
  };

  const run = async () => {
    if (!stream.acquire()) return;
    try {
      await runInner();
    } catch (e) {
      stream.release();
      setState({ kind: "error", sends: "", message: String(e), refused: false });
    }
  };

  const runInner = async () => {
    const abort = () => {
      stream.release();
    };
    const sends = sendsLine();
    // データ比較は SQL 本文を送らず件数だけなので、送信範囲の確認は SQL 本文を送るスキーマ比較のみ。
    if (props.planKind === "schema" && needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("aiSyncRiskScopeTitle"),
        message: `${t("aiSyncRiskScopeBody")}\n${sends}`,
        confirmLabel: t("aiSyncRiskConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (props.isProduction) {
      const ok = await confirm({
        title: t("aiSyncRiskProdTitle"),
        message: `${t("aiSyncRiskProdBody")}\n${sends}`,
        confirmLabel: t("aiSyncRiskConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    const statements = props.plan.statements;
    onRisks(null);
    setState({ kind: "running", sends });
    await stream.start(
      {
        task: "syncRisk",
        system: buildSyncRiskSystem(locale),
        prompt: buildSyncRiskPrompt({
          planKind: props.planKind,
          sourceDriver: props.sourceDriver,
          targetDriver: props.targetDriver,
          statements,
          warnings: props.plan.warnings,
          allowDestructive: props.allowDestructive,
          allowDelete: props.allowDelete,
          diff: props.diff,
          dataSummary: props.dataSummary,
          maskLiterals: ai.maskLiterals,
        }),
        settings: toAiSnapshot(ai),
        format: SYNC_RISK_FORMAT,
      },
      {
        parse: parseSyncRiskResponse,
        onDone: ({ parsed }) => {
          if (!parsed.ok) {
            setState({ kind: "raw", sends, raw: parsed.raw });
            return;
          }
          const items = finalizeRiskItems(
            parsed.value.risk_items,
            statements,
            t("aiSyncRiskMissingExplanation"),
          );
          setState({
            kind: "done",
            sends,
            summary: parsed.value.summary,
            recommendation: parsed.value.recommendation,
            items,
          });
          onRisks(groupRiskByIndex(items));
        },
        onError: (f) => setState({ kind: "error", sends, message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled", sends }),
      },
    );
  };

  if (!available) return null;
  const running = state.kind === "running";

  return (
    <Flex
      direction="column"
      gap="2"
      my="3"
      p="3"
      borderWidth="1px"
      borderColor="app.border"
      borderRadius="md"
      bg="app.surface"
      fontSize="sm"
      color="app.text"
      data-testid="ai-sync-risk"
    >
      <Flex align="center" gap="2" wrap="wrap">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={running}
          onClick={() => {
            void run();
          }}
        >
          {t("aiSyncRiskButton")}
        </Button>
        {running && (
          <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
            {t("aiSyncRiskCancel")}
          </Button>
        )}
      </Flex>
      {running && (
        <AiStreamProgress stream={stream} fields={["summary"]} waitingLabel={t("aiSyncRiskRunning")} />
      )}
      <Callout tone="info">{t("aiSyncRiskDisclaimer")}</Callout>
      {state.kind !== "idle" && state.sends !== "" && (
        <chakra.span color="app.textMuted" fontSize="xs">
          {state.sends}
        </chakra.span>
      )}
      {state.kind === "done" && (
        <Flex direction="column" gap="2" aria-live="polite" maxH="320px" overflow="auto">
          <Flex direction="column" gap="0.5">
            <FieldLabel as="div">{t("aiSyncRiskSummary")}</FieldLabel>
            <chakra.span whiteSpace="pre-wrap">{state.summary}</chakra.span>
          </Flex>
          {state.items.length > 0 && (
            <Flex direction="column" gap="1">
              <FieldLabel as="div">{t("aiSyncRiskRisks")}</FieldLabel>
              {state.items.map((it, i) => (
                <Flex key={`${it.statement_index}-${i}`} align="baseline" gap="1.5">
                  <chakra.span color="app.textMuted" fontFamily="mono" fontSize="xs" flexShrink={0}>
                    {`#${it.statement_index + 1} ${props.kindLabel(props.plan.statements[it.statement_index]?.kind ?? "add_column")} ${props.plan.statements[it.statement_index]?.table ?? ""}`}
                  </chakra.span>
                  <RiskBadge item={it} />
                </Flex>
              ))}
            </Flex>
          )}
          <Flex direction="column" gap="0.5">
            <FieldLabel as="div">{t("aiSyncRiskRecommendation")}</FieldLabel>
            <chakra.span whiteSpace="pre-wrap">{state.recommendation}</chakra.span>
          </Flex>
        </Flex>
      )}
      {state.kind === "raw" && (
        <Flex direction="column" gap="1">
          <ErrorNote role="alert">{t("aiSyncRiskParseError")}</ErrorNote>
          <CodePreview wrap maxH="160px">
            {state.raw}
          </CodePreview>
        </Flex>
      )}
      {state.kind === "error" &&
        (state.refused ? (
          <Callout tone="warning" role="alert">
            {t("aiSyncRiskRefused", { message: state.message })}
          </Callout>
        ) : (
          <ErrorNote role="alert">{t("aiSyncRiskError", { message: state.message })}</ErrorNote>
        ))}
      {state.kind === "cancelled" && (
        <Callout tone="info" role="status">
          {t("aiSyncRiskCancelled")}
        </Callout>
      )}
      {dialog}
    </Flex>
  );
}
