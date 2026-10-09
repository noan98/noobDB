import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, listenAiStream } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import {
  buildExplainInterpretPrompt,
  buildExplainInterpretSystem,
  EXPLAIN_INTERPRET_FORMAT,
  parseExplainInterpretResponse,
  type ExplainInterpretResponse,
  type ExplainInterpretTable,
} from "../ai/explainInterpret";
import { dialectLabel, extractTableRefs, needsSendScopeConfirm, resolveTableDatabase } from "../ai/errorExplain";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { SeverityBadge } from "./AdvisorPanel";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

let seq = 0;
function makeStreamId(): string {
  seq += 1;
  return `ai_explain_${Date.now().toString(36)}_${seq.toString(36)}`;
}

type State =
  | { kind: "idle" }
  | { kind: "running"; sends: string }
  | { kind: "done"; sends: string; value: ExplainInterpretResponse; masked: boolean }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiExplainInterpretProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  isProduction: boolean;
  /** 読み取り専用セッションか (DDL 提案の注記に使う)。 */
  readOnly: boolean;
  /** EXPLAIN 出力の生テキスト。まだ無い (読込中・空) ときは null でボタンを無効にする。 */
  plan: string | null;
  /** 実測モード (EXPLAIN ANALYZE) の結果か。 */
  analyze: boolean;
  /** EXPLAIN 対象の元 SQL (プレフィックスなし)。 */
  sql: string;
  /** テーブル定義を引く既定のデータベース。 */
  database: string | null;
  /** 提案 SQL を新しいクエリタブに開く。**実行はしない**。 */
  onInsertSql: (sql: string) => void;
}

/**
 * ExplainViewer のバー直下に置く「AI で解釈」ボタンと結果パネル (#693)。
 * AI 無効 (設定オフ / API キー未設定) のときは何も描かず、ExplainViewer は従来どおり。
 * 提案 DDL / リライトは提示のみで、「エディタに挿入」を押したときだけタブに入れる (自動実行しない)。
 * 親は `key` に計画を渡して、別の計画では状態を作り直すこと。
 */
export function AiExplainInterpret(props: AiExplainInterpretProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const [hasKey, setHasKey] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [collapsed, setCollapsed] = useState(false);
  const [inserted, setInserted] = useState<ReadonlySet<number>>(new Set());
  const busyRef = useRef(false);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  // 中止ボタンが押されたか。ストリーム登録前の中止は cancel_stream が空振りするため、登録後に取り直す。
  const abortRef = useRef(false);

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

  // 別のストリームに置き換わっている場合は触らない (ID が一致するときだけ解除する)。
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

  const tableRefs = useMemo(() => extractTableRefs(props.sql, props.driver), [props.sql, props.driver]);
  const sendsLine = (tableCount: number) =>
    t("explainAiSends", {
      sql: ai.maskLiterals ? t("explainAiSqlMasked") : t("explainAiSqlRaw"),
      dialect: dialectLabel(props.driver),
      tables:
        tableCount === 0
          ? t("explainAiTablesNone")
          : tableCount === 1
            ? t("explainAiTablesOne")
            : t("explainAiTablesSome", { count: tableCount }),
    });

  const run = async () => {
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (busyRef.current || props.plan === null) return;
    busyRef.current = true;
    try {
      await runInner(props.plan);
    } catch (e) {
      busyRef.current = false;
      setState({ kind: "error", sends: "", message: String(e), refused: false });
    }
  };

  const runInner = async (plan: string) => {
    // busyRef はストリームの終了 (stopListener) まで保持する。送信前に取りやめた場合は戻す。
    const abort = () => {
      busyRef.current = false;
    };
    if (needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("explainAiScopeTitle"),
        message: `${t("explainAiScopeBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("explainAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (props.isProduction) {
      const ok = await confirm({
        title: t("explainAiConfirmTitle"),
        message: `${t("explainAiConfirmBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("explainAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    setInserted(new Set());
    setCollapsed(false);
    // インデックス・行数推定はベストエフォート。取得できないテーブルは黙って落とす。
    const fetched = await Promise.all(
      tableRefs.map(async (ref): Promise<ExplainInterpretTable | null> => {
        const db = resolveTableDatabase(ref, props.database, props.driver);
        if (!db) return null;
        try {
          const indexes = await api.listIndexes(props.sessionId, db, ref.table);
          const rowEstimate = await api.tableRowEstimate(props.sessionId, db, ref.table).catch(() => null);
          return { name: ref.table, rowEstimate, indexes };
        } catch {
          return null;
        }
      }),
    );
    const tables = fetched.filter((x): x is ExplainInterpretTable => x !== null);
    const sends = sendsLine(tables.length);
    const streamId = makeStreamId();
    streamRef.current = streamId;
    abortRef.current = false;
    let text = "";
    setState({ kind: "running", sends });
    try {
      const unlisten = await listenAiStream(streamId, {
        onDelta: (e) => {
          text += e.text;
        },
        onDone: () => {
          stopListener(streamId);
          const parsed = parseExplainInterpretResponse(text);
          setState(
            parsed.ok
              ? { kind: "done", sends, value: parsed.value, masked: ai.maskLiterals }
              : { kind: "raw", sends, raw: parsed.raw },
          );
        },
        onError: (e) => {
          stopListener(streamId);
          setState({ kind: "error", sends, message: e.error, refused: e.kind === "aiRefused" });
        },
        onCancelled: () => {
          stopListener(streamId);
          setState({ kind: "cancelled", sends });
        },
      });
      if (!mountedRef.current) {
        unlisten();
        streamRef.current = null;
        busyRef.current = false;
        return;
      }
      unlistenRef.current = unlisten;
      // 購読を待つ間に中止された場合は、リクエストを送らずに終える。
      if (abortRef.current) {
        stopListener(streamId);
        setState({ kind: "cancelled", sends });
        return;
      }
      await api.runAiRequest({
        streamId,
        task: "explainInterpret",
        system: buildExplainInterpretSystem(locale, props.driver),
        prompt: buildExplainInterpretPrompt({
          driver: props.driver,
          plan,
          analyze: props.analyze,
          sql: props.sql,
          tables,
          maskLiterals: ai.maskLiterals,
        }),
        settings: toAiSnapshot(ai),
        format: EXPLAIN_INTERPRET_FORMAT,
      });
      // 登録前の中止 / アンマウントは cancel_stream が空振りするので、登録が済んだ今あらためて取り消す。
      if (abortRef.current || !mountedRef.current) {
        void api.cancelStream(streamId).catch(() => {
          /* すでに完了 */
        });
      }
    } catch (e) {
      stopListener(streamId);
      setState({ kind: "error", sends, message: String(e), refused: false });
    }
  };

  const cancel = () => {
    abortRef.current = true;
    const sid = streamRef.current;
    if (sid) {
      void api.cancelStream(sid).catch(() => {
        /* すでに完了 */
      });
    }
  };

  if (!ai.enabled || !hasKey) return null;
  const running = state.kind === "running";
  const hasDdl = state.kind === "done" && state.value.suggestions.some((s) => s.kind === "ddl");
  const hasResult = state.kind !== "idle" && state.kind !== "running";

  return (
    <Flex
      direction="column"
      gap="2"
      px="3.5"
      py="2"
      bg="app.surface"
      borderBottomWidth="1px"
      borderBottomColor="app.border"
      fontSize="sm"
      color="app.text"
      flexShrink={0}
      data-testid="ai-explain-interpret"
    >
      <Flex align="center" gap="2" wrap="wrap">
        <Tooltip label={sendsLine(tableRefs.length)}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={running || props.plan === null}
            onClick={() => {
              void run();
            }}
          >
            {t("explainAiButton")}
          </Button>
        </Tooltip>
        {running && (
          <>
            <Spinner size={12} />
            <chakra.span color="app.textMuted">{t("explainAiRunning")}</chakra.span>
            <Button type="button" variant="secondary" size="sm" onClick={cancel}>
              {t("explainAiCancel")}
            </Button>
          </>
        )}
        {hasResult && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? t("explainAiExpand") : t("explainAiCollapse")}
          </Button>
        )}
      </Flex>
      {state.kind !== "idle" && (
        <chakra.span color="app.textMuted" fontSize="xs">
          {state.sends}
        </chakra.span>
      )}
      {!collapsed && state.kind === "done" && (
        <Flex direction="column" gap="2" aria-live="polite" maxH="320px" overflow="auto">
          <Flex direction="column" gap="0.5">
            <FieldLabel as="div">{t("explainAiSummary")}</FieldLabel>
            <chakra.span whiteSpace="pre-wrap">{state.value.summary}</chakra.span>
          </Flex>
          <Flex direction="column" gap="1">
            <FieldLabel as="div">{t("explainAiBottlenecks")}</FieldLabel>
            {state.value.bottlenecks.length === 0 ? (
              <chakra.span color="app.textMuted">{t("explainAiNoBottlenecks")}</chakra.span>
            ) : (
              state.value.bottlenecks.map((b, i) => (
                <Flex key={`${i}-${b.node}`} gap="2" align="flex-start" data-testid="ai-explain-bottleneck">
                  <SeverityBadge severity={b.severity} />
                  <chakra.span whiteSpace="pre-wrap">
                    <chakra.span fontWeight="600">{b.node}</chakra.span>
                    {` ${b.reason}`}
                  </chakra.span>
                </Flex>
              ))
            )}
          </Flex>
          {state.value.suggestions.length > 0 && (
            <Flex direction="column" gap="2">
              <FieldLabel as="div">{t("explainAiSuggestions")}</FieldLabel>
              {state.masked && (
                <Callout tone="warning" role="status">
                  {t("explainAiMaskedNote")}
                </Callout>
              )}
              {hasDdl && props.readOnly && (
                <Callout tone="info" role="status">
                  {t("explainAiReadOnlyNote")}
                </Callout>
              )}
              {state.value.suggestions.map((s, i) => (
                <Flex key={`${i}-${s.sql}`} direction="column" gap="1" data-testid="ai-explain-suggestion">
                  <chakra.span color="app.textMuted" fontSize="xs">
                    {s.kind === "ddl" ? t("explainAiKindDdl") : t("explainAiKindRewrite")}
                  </chakra.span>
                  <chakra.span whiteSpace="pre-wrap">{s.rationale}</chakra.span>
                  <CodePreview wrap maxH="160px">
                    {s.sql}
                  </CodePreview>
                  <Flex align="center" gap="2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        props.onInsertSql(s.sql);
                        setInserted((prev) => new Set(prev).add(i));
                      }}
                    >
                      {t("explainAiInsert")}
                    </Button>
                    {inserted.has(i) && (
                      <chakra.span color="app.textSuccess" role="status">
                        {t("explainAiInserted")}
                      </chakra.span>
                    )}
                  </Flex>
                </Flex>
              ))}
            </Flex>
          )}
        </Flex>
      )}
      {!collapsed && state.kind === "raw" && (
        <Flex direction="column" gap="1">
          <ErrorNote role="alert">{t("explainAiParseError")}</ErrorNote>
          <CodePreview wrap maxH="160px">
            {state.raw}
          </CodePreview>
        </Flex>
      )}
      {state.kind === "error" &&
        (state.refused ? (
          <Callout tone="warning" role="alert">
            {t("explainAiRefused", { message: state.message })}
          </Callout>
        ) : (
          <ErrorNote role="alert">{t("explainAiError", { message: state.message })}</ErrorNote>
        ))}
      {state.kind === "cancelled" && (
        <Callout tone="info" role="status">
          {t("explainAiCancelled")}
        </Callout>
      )}
      {dialog}
    </Flex>
  );
}
