import { useEffect, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import { dialectLabel, needsSendScopeConfirm } from "../ai/errorExplain";
import {
  buildResultSummaryPrompt,
  buildResultSummarySystem,
  parseResultSummaryResponse,
  RESULT_SUMMARY_FORMAT,
  RESULT_SUMMARY_MAX_COLUMNS,
  RESULT_SUMMARY_MAX_ROWS,
  type ResultSummaryResponse,
} from "../ai/resultSummary";
import type { CellValue, Column } from "../api/tauri";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";

/** 結果グリッドの「AI で要約」が組み立てる依頼。 */
export interface AiResultSummaryRequest {
  /** 依頼ごとに増える ID。親は `key` に使い、別の依頼ではパネルを作り直す。 */
  id: number;
  /** 結果を出したエディタタブ (追加 SQL 案の挿入先)。 */
  tabId: string;
  /** 結果を出したタブの表示名 (パネルに依頼元を示す)。 */
  tabTitle: string;
  /** 結果を出した SQL (マスク前)。 */
  sql: string;
  /** テーブル定義の引き先データベース (挿入先タブの既定にも使う)。 */
  database: string | null;
  columns: Column[];
  /** グリッドに取得済みの行。 */
  rows: CellValue[][];
  /** true の間は表示時に自動送信する (起動自体がユーザ操作)。送信後に親が false にする。 */
  autoRun: boolean;
}

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; value: ResultSummaryResponse }
  | { kind: "raw"; raw: string }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

export interface AiResultSummaryPanelProps {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  isProduction: boolean;
  request: AiResultSummaryRequest | null;
  onRequestConsumed: () => void;
  /** 追加 SQL 案を依頼元のエディタへ挿入する (実行はしない)。`closed` = タブが既に無い。 */
  onInsert: (request: AiResultSummaryRequest, sql: string) => Promise<"inserted" | "closed">;
}

/**
 * 結果グリッドの「AI で要約」(#1476) の結果を表示するボトムパネルの中身 (参照グループ)。
 * 依頼 (`request.autoRun`) が来たら、必要な確認のあとで自動送信する。`allowRowData` がオフなら
 * セルの値は送らず、列統計 (値を含まないもの) と SQL だけを送る。追加 SQL 案はエディタへ
 * 挿入するだけで実行しない。親は `key` に依頼 ID を渡して、別の依頼では状態を作り直すこと。
 */
export function AiResultSummaryPanel(props: AiResultSummaryPanelProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const { request } = props;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [inserted, setInserted] = useState<Record<number, "inserted" | "closed">>({});
  const stream = useAiStream({ idPrefix: "ai_result_summary" });
  const rootRef = useRef<HTMLDivElement | null>(null);

  const sendsLine = (req: AiResultSummaryRequest) =>
    t("aiResultSummarySends", {
      sql: ai.maskLiterals ? t("aiSqlSqlMasked") : t("aiSqlSqlRaw"),
      dialect: dialectLabel(props.driver),
      columns: Math.min(req.columns.length, RESULT_SUMMARY_MAX_COLUMNS),
      rows: ai.allowRowData
        ? t("aiResultSummaryRowsSent", { count: Math.min(req.rows.length, RESULT_SUMMARY_MAX_ROWS) })
        : t("aiResultSummaryRowsNone"),
    });

  const runInner = async (req: AiResultSummaryRequest) => {
    const abort = () => {
      stream.release();
    };
    const sends = sendsLine(req);
    // 行データを送る / SQL を送る範囲に同意していない / 本番接続のときは、送信前に必ず確認する。
    const confirms: { title: string; body: string }[] = [];
    if (ai.allowRowData) {
      confirms.push({ title: t("aiResultSummaryRowsTitle"), body: t("aiResultSummaryRowsBody") });
    }
    if (needsSendScopeConfirm(ai.sendScope)) {
      confirms.push({ title: t("aiSqlScopeTitle"), body: t("aiSqlScopeBody") });
    }
    if (props.isProduction) {
      confirms.push({ title: t("aiSqlProdTitle"), body: t("aiResultSummaryProdBody") });
    }
    for (const c of confirms) {
      const ok = await confirm({
        title: c.title,
        message: `${c.body}\n${sends}`,
        confirmLabel: t("aiSqlConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (!stream.isMounted()) return abort();
    setInserted({});
    setState({ kind: "running" });
    await stream.start(
      {
        task: "resultSummary",
        system: buildResultSummarySystem(locale, ai.allowRowData),
        prompt: buildResultSummaryPrompt({
          driver: props.driver,
          sql: req.sql,
          columns: req.columns,
          rows: req.rows,
          allowRowData: ai.allowRowData,
          maskLiterals: ai.maskLiterals,
        }),
        settings: toAiSnapshot(ai),
        format: RESULT_SUMMARY_FORMAT,
      },
      {
        parse: (text) => parseResultSummaryResponse(text, props.driver),
        onDone: ({ parsed }) =>
          setState(parsed.ok ? { kind: "done", value: parsed.value } : { kind: "raw", raw: parsed.raw }),
        onError: (f) => setState({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled" }),
      },
    );
  };

  const run = async () => {
    if (!request) return;
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner(request);
    } catch (e) {
      stream.release();
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  // 依頼が来たら自動送信する。最新の `run` を ref 経由で呼ぶ (エフェクトは依頼 1 件につき 1 回)。
  const runRef = useRef(run);
  runRef.current = run;
  const consumedRef = useRef(props.onRequestConsumed);
  consumedRef.current = props.onRequestConsumed;
  const autoRun = request?.autoRun === true;
  useEffect(() => {
    if (!autoRun) return;
    consumedRef.current();
    rootRef.current?.focus({ preventScroll: true });
    void runRef.current();
  }, [autoRun]);

  if (!request) {
    return (
      <EmptyState
        compact
        icon="sparkles"
        title={t("aiResultSummaryTitle")}
        description={t("aiResultSummaryEmpty")}
      />
    );
  }
  const running = state.kind === "running";

  return (
    <Flex
      ref={rootRef}
      tabIndex={-1}
      outline="none"
      direction="column"
      gap="2"
      p="3"
      h="100%"
      overflow="auto"
      fontSize="sm"
      color="app.text"
      data-testid="ai-result-summary-panel"
    >
      <chakra.span textStyle="caption" data-testid="ai-result-summary-source">
        {t("aiResultSummarySource", { title: request.tabTitle })}
      </chakra.span>
      <Flex align="center" gap="2" wrap="wrap">
        <Button type="button" variant="secondary" size="sm" disabled={running} onClick={() => void run()}>
          {t("aiResultSummaryButton")}
        </Button>
        {running && (
          <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
            {t("aiSqlCancel")}
          </Button>
        )}
        <chakra.span textStyle="caption" data-testid="ai-result-summary-sends">
          {sendsLine(request)}
        </chakra.span>
      </Flex>
      {running && <AiStreamProgress stream={stream} fields={["summary"]} waitingLabel={t("aiSqlRunning")} />}
      {state.kind === "done" && (
        <Result
          value={state.value}
          inserted={inserted}
          onInsert={(i, sql) => {
            void props
              .onInsert(request, sql)
              .then((r) => setInserted((prev) => ({ ...prev, [i]: r })))
              .catch(() => {
                /* 挿入できなければ何も表示しない (再試行できる) */
              });
          }}
        />
      )}
      {state.kind === "raw" && (
        <Flex direction="column" gap="1">
          <ErrorNote role="alert">{t("aiSqlParseError")}</ErrorNote>
          <CodePreview wrap maxH="240px">
            {state.raw}
          </CodePreview>
        </Flex>
      )}
      {state.kind === "error" &&
        (state.refused ? (
          <Callout tone="warning" role="alert">
            {t("aiSqlRefused", { message: state.message })}
          </Callout>
        ) : (
          <ErrorNote role="alert">{t("aiSqlError", { message: state.message })}</ErrorNote>
        ))}
      {state.kind === "cancelled" && (
        <Callout tone="info" role="status">
          {t("aiSqlCancelled")}
        </Callout>
      )}
      {dialog}
    </Flex>
  );
}

function BulletSection({ label, items }: { label: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Flex direction="column" gap="1">
      <FieldLabel as="div">{label}</FieldLabel>
      {items.map((x, i) => (
        <chakra.span key={`${i}-${x}`} whiteSpace="pre-wrap">
          ・{x}
        </chakra.span>
      ))}
    </Flex>
  );
}

function Result({
  value,
  inserted,
  onInsert,
}: {
  value: ResultSummaryResponse;
  inserted: Record<number, "inserted" | "closed">;
  onInsert: (index: number, sql: string) => void;
}) {
  const t = useT();
  return (
    <Flex direction="column" gap="2" aria-live="polite" data-testid="ai-result-summary-result">
      <chakra.span whiteSpace="pre-wrap">{value.summary}</chakra.span>
      <BulletSection label={t("aiResultSummaryTrends")} items={value.trends} />
      <BulletSection label={t("aiResultSummaryAnomalies")} items={value.anomalies} />
      {value.next_queries.length > 0 && (
        <Flex direction="column" gap="2">
          <FieldLabel as="div">{t("aiResultSummaryNext")}</FieldLabel>
          <chakra.span textStyle="caption">
            {t("aiResultSummaryNextNote")}
          </chakra.span>
          {value.next_queries.map((q, i) => (
            <Flex key={`${i}-${q.title}`} direction="column" gap="1" data-testid="ai-result-summary-query">
              <chakra.span fontWeight="semibold">{q.title}</chakra.span>
              <chakra.span color="app.textSecondary" whiteSpace="pre-wrap">
                {q.reason}
              </chakra.span>
              <CodePreview wrap maxH="160px">
                {q.sql}
              </CodePreview>
              <Flex align="center" gap="2" wrap="wrap">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={inserted[i] === "inserted"}
                  onClick={() => onInsert(i, q.sql)}
                >
                  {t("aiResultSummaryInsert")}
                </Button>
                {inserted[i] === "inserted" && (
                  <chakra.span color="app.textSuccess" role="status">
                    {t("aiResultSummaryInserted")}
                  </chakra.span>
                )}
                {inserted[i] === "closed" && (
                  <chakra.span color="app.textWarning" role="status">
                    {t("aiSqlTabClosed")}
                  </chakra.span>
                )}
              </Flex>
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
