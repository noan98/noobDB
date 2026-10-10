import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import { dialectLabel, needsSendScopeConfirm, resolveTableDatabase } from "../ai/errorExplain";
import {
  buildImpactAnalysisPrompt,
  buildImpactAnalysisSystem,
  IMPACT_ANALYSIS_FORMAT,
  impactTableRefs,
  parseImpactAnalysisResponse,
  riskTone,
  selectRelatedForeignKeys,
  type ImpactAnalysisResponse,
  type ImpactForeignKey,
  type ImpactPreflight,
  type ImpactRisk,
  type ImpactTable,
} from "../ai/impactAnalysis";
import type { DangerFinding } from "../dangerousSql";
import { useLocale, useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Icon, ICON_SIZES } from "./Icon";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { Tooltip } from "./Tooltip";

type State =
  | { kind: "idle" }
  | { kind: "running"; sends: string }
  | { kind: "done"; sends: string; value: ImpactAnalysisResponse }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiImpactAnalysisProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** テーブル定義の引き先 (SQL 内で修飾されていないテーブルに使う)。 */
  database: string | null;
  sql: string;
  findings: DangerFinding[];
  isProduction: boolean;
  /** プリフライトの件数メタ情報 (行データは含まない)。 */
  preflight: ImpactPreflight | null;
}

/**
 * 危険クエリ確認ダイアログ内の「影響を AI で分析」ボタンと結果パネル (#694)。
 * AI 無効 (設定オフ / API キー未設定) のときは何も描かない。分析はオンデマンドのみで、
 * 実行中もダイアログの実行 / キャンセルは操作できる (ブロッキング要素にしない)。
 * 結果は `confirm_writes` と同じ UX ガードであり、バックエンド強制ではない旨を常に示す。
 */
export function AiImpactAnalysis(props: AiImpactAnalysisProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const [hasKey, setHasKey] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [open, setOpen] = useState(true);
  const stream = useAiStream({ idPrefix: "ai_impact" });
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .hasAiApiKey()
      .then((v) => {
        if (alive) setHasKey(v);
      })
      .catch(() => {
        /* 取得できなければ非表示のまま */
      });
    return () => {
      alive = false;
    };
  }, []);

  const tableRefs = useMemo(
    () => impactTableRefs(props.sql, props.findings, props.driver),
    [props.sql, props.findings, props.driver],
  );
  const sendsLine = (tableCount: number) =>
    t("dangerousAiSends", {
      sql: ai.maskLiterals ? t("dangerousAiSqlMasked") : t("dangerousAiSqlRaw"),
      dialect: dialectLabel(props.driver),
      tables:
        tableCount > 0 ? t("dangerousAiTablesSome", { count: tableCount }) : t("dangerousAiTablesNone"),
    });

  const run = async () => {
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner();
    } catch (e) {
      stream.release();
      setState({ kind: "error", sends: sendsLine(tableRefs.length), message: String(e), refused: false });
    }
  };

  const runInner = async () => {
    // 確保した実行権はストリームの終了までフックが保持する。送信前に取りやめた場合は戻す。
    const abort = () => {
      stream.release();
    };
    // 確認ダイアログは元のダイアログの上に重なる。閉じたときに Ark がこのボタンへ
    // フォーカスを戻すよう、開く前に明示的にフォーカスしておく (クリックでフォーカスが
    // 付かないブラウザ対策)。
    buttonRef.current?.focus();
    if (needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("dangerousAiScopeTitle"),
        message: `${t("dangerousAiScopeBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("dangerousAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (props.isProduction) {
      const ok = await confirm({
        title: t("dangerousAiProdTitle"),
        message: `${t("dangerousAiProdBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("dangerousAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    setOpen(true);
    // スキーマ取得中もスピナーを出す。
    setState({ kind: "running", sends: sendsLine(tableRefs.length) });

    // スキーマ情報はベストエフォート。取得できないものは黙って落とす。行データは取得しない。
    const resolved = tableRefs.map((ref) => ({
      ref,
      db: resolveTableDatabase(ref, props.database, props.driver),
    }));
    const dbs = [...new Set(resolved.map((r) => r.db).filter((d): d is string => d !== null))];
    const perDb = new Map<string, ImpactForeignKey[]>();
    await Promise.all(
      dbs.map(async (db) => {
        perDb.set(db, await api.foreignKeys(props.sessionId, db).catch(() => [] as ImpactForeignKey[]));
      }),
    );
    const fetched = await Promise.all(
      resolved.map(async ({ ref, db }): Promise<ImpactTable | null> => {
        if (!db) return null;
        try {
          const [columns, estimatedRows] = await Promise.all([
            api.describeTable(props.sessionId, db, ref.table),
            // 1 テーブル版 (統計なし・ビュー・SQLite は null)。取れなくても分析は続ける。
            api.tableRowEstimate(props.sessionId, db, ref.table).catch(() => null),
          ]);
          return { name: ref.table, columns, estimatedRows };
        } catch {
          return null;
        }
      }),
    );
    // スキーマ取得中にダイアログが閉じられたら、要求を出さずに終える。
    if (!stream.isMounted()) {
      stream.release();
      return;
    }
    const tables = fetched.filter((x): x is ImpactTable => x !== null);
    const names = tables.map((x) => x.name);
    const foreignKeys = selectRelatedForeignKeys(
      [...perDb.values()].flat(),
      names,
    );
    const sends = sendsLine(tables.length);
    setState({ kind: "running", sends });
    await stream.start(
      {
        task: "impactAnalysis",
        system: buildImpactAnalysisSystem(locale),
        prompt: buildImpactAnalysisPrompt({
          driver: props.driver,
          sql: props.sql,
          findings: props.findings,
          tables,
          foreignKeys,
          preflight: props.preflight,
          isProduction: props.isProduction,
          maskLiterals: ai.maskLiterals,
          locale,
        }),
        settings: toAiSnapshot(ai),
        format: IMPACT_ANALYSIS_FORMAT,
      },
      {
        parse: parseImpactAnalysisResponse,
        onDone: ({ parsed }) =>
          setState(
            parsed.ok
              ? { kind: "done", sends, value: parsed.value }
              : { kind: "raw", sends, raw: parsed.raw },
          ),
        onError: (f) => setState({ kind: "error", sends, message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled", sends }),
      },
    );
  };

  if (!ai.enabled || !hasKey) return null;
  const running = state.kind === "running";
  const hasResult = state.kind !== "idle" && state.kind !== "running";

  return (
    <Flex
      direction="column"
      gap="2"
      fontSize="sm"
      color="app.text"
      data-testid="ai-impact-analysis"
    >
      <Flex align="center" gap="2" wrap="wrap">
        <Tooltip label={sendsLine(tableRefs.length)}>
          <Button
            ref={buttonRef}
            type="button"
            variant="secondary"
            size="sm"
            // disabled にするとフォーカスを戻せないので aria-disabled のみ (二重実行は useAiStream の acquire が弾く)。
            aria-disabled={running}
            onClick={() => {
              void run();
            }}
          >
            {t("dangerousAiButton")}
          </Button>
        </Tooltip>
        {running && (
          <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
            {t("dangerousAiStop")}
          </Button>
        )}
        {hasResult && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} size={ICON_SIZES.sm} />
            {t("dangerousAiResultToggle")}
          </Button>
        )}
      </Flex>
      {running && (
        <AiStreamProgress stream={stream} fields={["summary"]} waitingLabel={t("dangerousAiRunning")} />
      )}
      {state.kind !== "idle" && (
        <chakra.span color="app.textMuted" fontSize="xs">
          {state.sends}
        </chakra.span>
      )}
      {(running || (hasResult && open)) && (
        <Flex direction="column" gap="2" maxH="260px" overflow="auto" aria-live="polite">
          {state.kind === "done" && <ResultView value={state.value} />}
          {state.kind === "raw" && (
            <Flex direction="column" gap="1">
              <ErrorNote role="alert">{t("dangerousAiParseError")}</ErrorNote>
              <CodePreview wrap maxH="160px">
                {state.raw}
              </CodePreview>
            </Flex>
          )}
          {state.kind === "error" &&
            (state.refused ? (
              <Callout tone="warning" role="alert">
                {t("dangerousAiRefused", { message: state.message })}
              </Callout>
            ) : (
              <ErrorNote role="alert">{t("dangerousAiError", { message: state.message })}</ErrorNote>
            ))}
          {state.kind === "cancelled" && (
            <Callout tone="info" role="status">
              {t("dangerousAiCancelled")}
            </Callout>
          )}
        </Flex>
      )}
      {/* 強制レベルの明示: UX ガードであり権限強制ではない。結果の有無にかかわらず常に出す。 */}
      <Callout tone="info" role="note">
        {t("dangerousAiGuardNote")}
      </Callout>
      {dialog}
    </Flex>
  );
}

function ResultView({ value }: { value: ImpactAnalysisResponse }) {
  const t = useT();
  const tone = riskTone(value.risk);
  const riskLabel: Record<ImpactRisk, string> = {
    high: t("dangerousAiRiskHigh"),
    medium: t("dangerousAiRiskMedium"),
    low: t("dangerousAiRiskLow"),
  };
  return (
    <>
      <Flex align="center" gap="2">
        <FieldLabel as="div">{t("dangerousAiRisk")}</FieldLabel>
        <chakra.span
          px="2"
          py="0.5"
          borderRadius="pill"
          border="1px solid"
          borderColor={semanticColorToken(tone, "border")}
          bg={semanticColorToken(tone, "subtle")}
          color={semanticColorToken(tone, "text")}
          fontWeight={600}
          data-risk={value.risk}
        >
          {riskLabel[value.risk]}
        </chakra.span>
      </Flex>
      <chakra.span whiteSpace="pre-wrap">{value.summary}</chakra.span>
      {value.affected_tables.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("dangerousAiAffected")}</FieldLabel>
          {value.affected_tables.map((a, i) => (
            <Flex key={`${i}-${a.table}`} direction="column" gap="0.5">
              <chakra.span fontFamily="mono" fontWeight={600}>
                {a.table}
                <chakra.span fontWeight={400} color="app.textMuted">
                  {" "}
                  ({t("dangerousAiRows")}: {a.estimated_rows})
                </chakra.span>
              </chakra.span>
              <chakra.span color="app.textMuted">{a.reason}</chakra.span>
            </Flex>
          ))}
        </Flex>
      )}
      {value.cascades.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("dangerousAiCascades")}</FieldLabel>
          <chakra.span color="app.textMuted" fontSize="xs">
            {t("dangerousAiCascadesNote")}
          </chakra.span>
          {value.cascades.map((c, i) => (
            <chakra.span key={`${i}-${c.from}-${c.to}`} fontFamily="mono">
              {c.from} → {c.to} ({c.via})
            </chakra.span>
          ))}
        </Flex>
      )}
      {value.recommendations.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("dangerousAiRecommendations")}</FieldLabel>
          {value.recommendations.map((r, i) => (
            <chakra.span key={`${i}-${r}`}>・{r}</chakra.span>
          ))}
        </Flex>
      )}
    </>
  );
}
