import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, listenAiStream } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import {
  dialectLabel,
  extractTableRefs,
  needsSendScopeConfirm,
  resolveTableDatabase,
  type ExplainTable,
} from "../ai/errorExplain";
import {
  buildSqlAssistPrompt,
  buildSqlAssistSystem,
  countStatements,
  diffLines,
  hasDiffChanges,
  parseSqlExplainResponse,
  parseSqlRewriteResponse,
  restoreMaskedLiterals,
  SQL_ASSIST_TASK,
  sqlAssistFormat,
  type DiffLine,
  type RestoredLiterals,
  type SqlAssistKind,
  type SqlExplainResponse,
  type SqlRewriteResponse,
} from "../ai/sqlAssist";
import { useLocale, useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { Spinner } from "./Spinner";

let seq = 0;
function makeStreamId(): string {
  seq += 1;
  return `ai_sql_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** エディタのアクション (右クリック / パレット) が組み立てる依頼。 */
export interface AiSqlRequest {
  /** 依頼ごとに増える ID。親は `key` に使い、別の依頼ではパネルを作り直す。 */
  id: number;
  kind: SqlAssistKind;
  /** 対象の SQL (選択範囲、無ければエディタ全文)。マスク前の生の文字列。 */
  sql: string;
  /** 起動時の選択範囲。全文が対象なら null。 */
  range: { from: number; to: number } | null;
  tabId: string;
  /** テーブル定義の引き先データベース。 */
  database: string | null;
  /** true の間は表示時に自動送信する (起動自体がユーザ操作)。送信後に親が false にする。 */
  autoRun: boolean;
}

type State =
  | { kind: "idle" }
  | { kind: "running"; chars: number }
  | { kind: "explain"; value: SqlExplainResponse }
  | {
      kind: "rewrite";
      value: SqlRewriteResponse;
      /** diff の左辺と適用の基準になる、マスク前の元 SQL。 */
      original: string;
      /** 適用する提案 SQL (マスクして送ったときはリテラルを差し戻した後)。 */
      proposal: string;
      restore: RestoredLiterals["status"];
      /** 元 SQL と提案で文の数が違う。 */
      statementCounts: { before: number; after: number } | null;
    }
  | { kind: "raw"; raw: string }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

export interface AiSqlPanelProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  isProduction: boolean;
  request: AiSqlRequest | null;
  onRequestConsumed: () => void;
  /**
   * 提案 SQL を依頼元のエディタへ適用する (実行はしない)。元の範囲が変わっていたら親が確認する。
   * `closed` = タブが既に無い / `cancelled` = 確認で取り消された。
   */
  onApply: (request: AiSqlRequest, newSql: string) => Promise<"applied" | "cancelled" | "closed">;
}

/**
 * SQL の AI 解説 / 最適化リライト (#695) を表示するボトムパネルの中身。見出しと閉じるボタンは
 * タブバーが持つので持たない。依頼 (`request.autoRun`) が来たら自動で送信し、解説は構造化表示、
 * リライトは元 SQL との diff を見せて「エディタに適用」を押したときだけ書き換える。
 * 行データは送らない。親は `key` に依頼 ID を渡して、別の依頼では状態を作り直すこと。
 */
export function AiSqlPanel(props: AiSqlPanelProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const { request } = props;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [applied, setApplied] = useState<null | "applied" | "closed" | "cancelled">(null);
  const busyRef = useRef(false);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  // 「エディタに適用」の再入防止。確認ダイアログ中・適用済みの間は 2 回目を受け付けない。
  const applyingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const stopListener = useCallback((streamId: string) => {
    if (streamRef.current !== streamId) return;
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamRef.current = null;
    busyRef.current = false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const sid = streamRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* すでに完了 */
        });
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const tableRefs = useMemo(
    () => (request ? extractTableRefs(request.sql, props.driver) : []),
    [request, props.driver],
  );
  const sendsLine = (tableCount: number) =>
    t("aiSqlSends", {
      sql: ai.maskLiterals ? t("aiSqlSqlMasked") : t("aiSqlSqlRaw"),
      dialect: dialectLabel(props.driver),
      tables: tableCount > 0 ? t("aiSqlTablesSome", { count: tableCount }) : t("aiSqlTablesNone"),
    });

  const runInner = async (req: AiSqlRequest, kind: SqlAssistKind) => {
    // busyRef はストリームの終了 (stopListener) まで保持する。送信前に取りやめた場合は戻す。
    const abort = () => {
      busyRef.current = false;
    };
    if (needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("aiSqlScopeTitle"),
        message: `${t("aiSqlScopeBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("aiSqlConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (props.isProduction) {
      const ok = await confirm({
        title: t("aiSqlProdTitle"),
        message: `${t("aiSqlProdBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("aiSqlConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (!mountedRef.current) return abort();
    setApplied(null);
    applyingRef.current = false;
    // テーブル定義はベストエフォート。取得できないテーブルは黙って落とす。
    const fetched = await Promise.all(
      tableRefs.map(async (ref): Promise<ExplainTable | null> => {
        const db = resolveTableDatabase(ref, req.database, props.driver);
        if (!db) return null;
        try {
          const columns = await api.describeTable(props.sessionId, db, ref.table);
          return { name: ref.table, columns };
        } catch {
          return null;
        }
      }),
    );
    const tables = fetched.filter((x): x is ExplainTable => x !== null);
    const streamId = makeStreamId();
    streamRef.current = streamId;
    let text = "";
    const masked = ai.maskLiterals;
    setState({ kind: "running", chars: 0 });
    try {
      const unlisten = await listenAiStream(streamId, {
        onDelta: (e) => {
          text += e.text;
          // 本文は JSON なので、受信中は文字数だけ見せる。
          setState({ kind: "running", chars: text.length });
        },
        onDone: () => {
          stopListener(streamId);
          if (kind === "explain") {
            const parsed = parseSqlExplainResponse(text);
            setState(parsed.ok ? { kind: "explain", value: parsed.value } : { kind: "raw", raw: parsed.raw });
          } else {
            const parsed = parseSqlRewriteResponse(text);
            if (!parsed.ok) {
              setState({ kind: "raw", raw: parsed.raw });
              return;
            }
            // マスクして送ったときは、提案の空白リテラルを元の値へ差し戻せるか試す。
            const restored: RestoredLiterals = masked
              ? restoreMaskedLiterals(req.sql, parsed.value.rewritten_sql)
              : { sql: parsed.value.rewritten_sql, status: "none" };
            const before = countStatements(req.sql, props.driver);
            const after = countStatements(restored.sql, props.driver);
            setState({
              kind: "rewrite",
              value: parsed.value,
              original: req.sql,
              proposal: restored.sql,
              restore: restored.status,
              statementCounts: before !== after ? { before, after } : null,
            });
          }
        },
        onError: (e) => {
          stopListener(streamId);
          setState({ kind: "error", message: e.error, refused: e.kind === "aiRefused" });
        },
        onCancelled: () => {
          stopListener(streamId);
          setState({ kind: "cancelled" });
        },
      });
      if (!mountedRef.current) {
        unlisten();
        streamRef.current = null;
        busyRef.current = false;
        return;
      }
      unlistenRef.current = unlisten;
      await api.runAiRequest({
        streamId,
        task: SQL_ASSIST_TASK[kind],
        system: buildSqlAssistSystem(kind, locale),
        prompt: buildSqlAssistPrompt({
          kind,
          sql: req.sql,
          driver: props.driver,
          tables,
          maskLiterals: masked,
        }),
        settings: toAiSnapshot(ai),
        format: sqlAssistFormat(kind),
      });
    } catch (e) {
      stopListener(streamId);
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  const run = async (kind: SqlAssistKind) => {
    if (!request) return;
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await runInner(request, kind);
    } catch (e) {
      busyRef.current = false;
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  // 依頼が来たら自動送信する。最新の `run` を ref 経由で呼ぶ (エフェクトは依頼 1 件につき 1 回)。
  const runRef = useRef(run);
  runRef.current = run;
  const consumedRef = useRef(props.onRequestConsumed);
  consumedRef.current = props.onRequestConsumed;
  const autoRun = request?.autoRun === true;
  const autoKind = request?.kind;
  useEffect(() => {
    if (!autoRun || !autoKind) return;
    consumedRef.current();
    // 右クリック / Shift+F10 から起動したときにキーボード操作がパネルへ続くよう、フォーカスを移す。
    rootRef.current?.focus({ preventScroll: true });
    void runRef.current(autoKind);
  }, [autoRun, autoKind]);

  const applyRewrite = async (s: Extract<State, { kind: "rewrite" }>) => {
    if (!request || applyingRef.current) return;
    applyingRef.current = true;
    const giveUp = () => {
      applyingRef.current = false;
      setApplied("cancelled");
    };
    try {
      if (s.restore === "missing") {
        const ok = await confirm({
          title: t("aiSqlMissingTitle"),
          message: t("aiSqlMissingBody"),
          confirmLabel: t("aiSqlApplyAnyway"),
          tone: "warning",
        });
        if (!ok) return giveUp();
      }
      if (s.statementCounts) {
        const ok = await confirm({
          title: t("aiSqlStmtTitle"),
          message: t("aiSqlStmtBody", s.statementCounts),
          confirmLabel: t("aiSqlApplyAnyway"),
          tone: "warning",
        });
        if (!ok) return giveUp();
      }
      const r = await props.onApply(request, s.proposal);
      setApplied(r);
      // 適用済みの間はボタンを無効にする。取りやめ / タブ消失なら再試行できるようにする。
      if (r !== "applied") applyingRef.current = false;
    } catch {
      applyingRef.current = false;
    }
  };

  const cancel = () => {
    const sid = streamRef.current;
    if (sid) {
      void api.cancelStream(sid).catch(() => {
        /* すでに完了 */
      });
    }
  };

  if (!request) {
    return (
      <EmptyState compact icon="sparkles" title={t("aiSqlTitle")} description={t("aiSqlEmpty")} />
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
      data-testid="ai-sql-panel"
    >
      <Flex align="center" gap="2" wrap="wrap">
        <Button type="button" variant="secondary" size="sm" disabled={running} onClick={() => void run("explain")}>
          {t("aiSqlExplainButton")}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={running} onClick={() => void run("rewrite")}>
          {t("aiSqlRewriteButton")}
        </Button>
        {running && (
          <>
            <Spinner size={12} />
            <chakra.span color="app.textMuted" role="status" data-testid="ai-sql-running">
              {t("aiSqlRunning", { chars: state.chars })}
            </chakra.span>
            <Button type="button" variant="secondary" size="sm" onClick={cancel}>
              {t("aiSqlCancel")}
            </Button>
          </>
        )}
        <chakra.span color="app.textMuted" fontSize="xs">
          {sendsLine(tableRefs.length)}
        </chakra.span>
      </Flex>
      <Flex direction="column" gap="1">
        <FieldLabel as="div">{request.range ? t("aiSqlSourceSelection") : t("aiSqlSourceAll")}</FieldLabel>
        <CodePreview wrap maxH="120px">
          {request.sql}
        </CodePreview>
      </Flex>
      {state.kind === "explain" && <ExplainResult value={state.value} />}
      {state.kind === "rewrite" && (
        <RewriteResult
          value={state.value}
          original={state.original}
          proposal={state.proposal}
          restore={state.restore}
          applied={applied}
          onApply={() => {
            void applyRewrite(state);
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

function Section({ label, children }: { label: string; children: string }) {
  return (
    <Flex direction="column" gap="0.5">
      <FieldLabel as="div">{label}</FieldLabel>
      <chakra.span whiteSpace="pre-wrap">{children}</chakra.span>
    </Flex>
  );
}

function CaveatList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Callout tone="warning" title={title} role="status">
      {items.map((n, i) => (
        <chakra.div key={`${i}-${n}`}>{n}</chakra.div>
      ))}
    </Callout>
  );
}

function ExplainResult({ value }: { value: SqlExplainResponse }) {
  const t = useT();
  return (
    <Flex direction="column" gap="2" aria-live="polite" data-testid="ai-sql-explain">
      <Section label={t("aiSqlOverview")}>{value.overview}</Section>
      {value.steps.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("aiSqlSteps")}</FieldLabel>
          <chakra.ol margin="0" paddingInlineStart="var(--space-5)" display="flex" flexDirection="column" gap="1.5">
            {value.steps.map((s, i) => (
              <li key={`${i}-${s.title}`}>
                <chakra.div fontWeight="semibold">{s.title}</chakra.div>
                <chakra.div whiteSpace="pre-wrap" color="app.textSecondary">
                  {s.detail}
                </chakra.div>
              </li>
            ))}
          </chakra.ol>
        </Flex>
      )}
      <CaveatList title={t("aiSqlCaveats")} items={value.caveats} />
    </Flex>
  );
}

const DIFF_BG: Record<DiffLine["type"], string | undefined> = {
  same: undefined,
  add: semanticColorToken("success", "subtle"),
  del: semanticColorToken("danger", "subtle"),
};
const DIFF_MARK: Record<DiffLine["type"], string> = { same: " ", add: "+", del: "-" };

/** 行単位 diff の表示。追加 / 削除は success / danger の subtle 地 + 先頭記号で示す (色だけに頼らない)。 */
function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  const t = useT();
  return (
    <chakra.div
      role="group"
      aria-label={t("aiSqlDiff")}
      data-testid="ai-sql-diff"
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      bg="app.bgInput"
      fontFamily="mono"
      fontSize="sm"
      lineHeight="normal"
      maxH="240px"
      overflow="auto"
    >
      {lines.map((l, i) => (
        <chakra.div
          key={i}
          display="flex"
          gap="2"
          px="2.5"
          bg={DIFF_BG[l.type]}
          data-diff={l.type}
        >
          <chakra.span
            aria-label={l.type === "add" ? t("aiSqlDiffAdded") : l.type === "del" ? t("aiSqlDiffRemoved") : undefined}
            color="app.textMuted"
            userSelect="none"
          >
            {DIFF_MARK[l.type]}
          </chakra.span>
          <chakra.span whiteSpace="pre-wrap" wordBreak="break-word" minW="0">
            {l.text}
          </chakra.span>
        </chakra.div>
      ))}
    </chakra.div>
  );
}

function RewriteResult({
  value,
  original,
  proposal,
  restore,
  applied,
  onApply,
}: {
  value: SqlRewriteResponse;
  original: string;
  proposal: string;
  restore: RestoredLiterals["status"];
  applied: null | "applied" | "closed" | "cancelled";
  onApply: () => void;
}) {
  const t = useT();
  const lines = useMemo(() => diffLines(original, proposal), [original, proposal]);
  const changed = hasDiffChanges(lines);
  return (
    <Flex direction="column" gap="2" aria-live="polite" data-testid="ai-sql-rewrite">
      <Callout tone="warning" role="status">
        {t("aiSqlRewriteWarning")}
      </Callout>
      {restore === "restored" && (
        <Callout tone="info" role="status">
          {t("aiSqlRestoredNote")}
        </Callout>
      )}
      {restore === "missing" && (
        <Callout tone="warning" role="status">
          {t("aiSqlMaskedNote")}
        </Callout>
      )}
      <Flex direction="column" gap="1">
        <FieldLabel as="div">{t("aiSqlDiff")}</FieldLabel>
        {changed ? (
          <DiffView lines={lines} />
        ) : (
          <Callout tone="info" role="status">
            {t("aiSqlNoChange")}
          </Callout>
        )}
      </Flex>
      <Flex align="center" gap="2" wrap="wrap">
        <Button type="button" variant="primary" size="sm" disabled={!changed || applied === "applied"} onClick={onApply}>
          {t("aiSqlApply")}
        </Button>
        {applied === "applied" && (
          <chakra.span color="app.textSuccess" role="status">
            {t("aiSqlApplied")}
          </chakra.span>
        )}
        {applied === "closed" && (
          <chakra.span color="app.textWarning" role="status">
            {t("aiSqlTabClosed")}
          </chakra.span>
        )}
        {applied === "cancelled" && (
          <chakra.span color="app.textMuted" role="status">
            {t("aiSqlApplyCancelled")}
          </chakra.span>
        )}
      </Flex>
      {value.changes.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("aiSqlChanges")}</FieldLabel>
          <chakra.ul margin="0" paddingInlineStart="var(--space-5)" display="flex" flexDirection="column" gap="1">
            {value.changes.map((c, i) => (
              <li key={`${i}-${c.what}`}>
                <chakra.span fontWeight="semibold">{c.what}</chakra.span>
                <chakra.span color="app.textSecondary"> — {c.why}</chakra.span>
              </li>
            ))}
          </chakra.ul>
        </Flex>
      )}
      {value.equivalence_notes.length > 0 && (
        <Flex direction="column" gap="0.5">
          <FieldLabel as="div">{t("aiSqlEquivalence")}</FieldLabel>
          {value.equivalence_notes.map((n, i) => (
            <chakra.div key={`${i}-${n}`} whiteSpace="pre-wrap">
              {n}
            </chakra.div>
          ))}
        </Flex>
      )}
      <CaveatList title={t("aiSqlCaveats")} items={value.caveats} />
    </Flex>
  );
}
