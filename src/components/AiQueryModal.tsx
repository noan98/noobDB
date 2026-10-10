import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import {
  appendExchange,
  buildHistory,
  historyBudget,
  MAX_HISTORY_EXCHANGES,
  type AiExchange,
} from "../ai/conversation";
import { dialectLabel } from "../ai/errorExplain";
import {
  approxKb,
  buildNl2SqlPrompt,
  buildNl2SqlSystemParts,
  NL2SQL_FORMAT,
  parseNl2SqlResponse,
  resolveNl2SqlDatabase,
  summarizeSchemaSend,
  type Nl2SqlForeignKey,
  type Nl2SqlResponse,
  type Nl2SqlTable,
} from "../ai/nl2sql";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { Button, Textarea } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { Spinner } from "./Spinner";

type Schema =
  | { kind: "loading" }
  | { kind: "ready"; tables: Nl2SqlTable[]; foreignKeys: Nl2SqlForeignKey[] }
  | { kind: "error"; message: string };

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; value: Nl2SqlResponse }
  | { kind: "raw"; raw: string }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

export interface AiQueryModalProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** スキーマを読むデータベース。未指定は SQLite なら `main`。 */
  database: string | null;
  /** 読み取り専用セッションなら SELECT 系のみ生成させる。 */
  readOnly: boolean;
  isProduction: boolean;
  /** 現在のエディタのカーソル位置へ挿入する (実行はしない)。 */
  onInsert: (sql: string) => void;
  /** 新しいクエリタブで開く (実行はしない)。 */
  /** 生成時にスキーマを読んだデータベースも渡す (新しいタブがそのDBを向くように)。 */
  onOpenInNewTab: (sql: string, database: string | null) => void;
  onClose: () => void;
}

/**
 * 自然言語から SQL を下書きする Modal (NL2SQL, #691)。スキーマ (テーブル名・列名・外部キー) と
 * 依頼文だけを送り、行データ・既存の SQL は送らない。生成 SQL は「挿入 / 新しいタブで開く」だけで、
 * 実行は従来の経路 (危険クエリ確認など) に任せる。AI 無効のときは何も描かない。
 */
export function AiQueryModal(props: AiQueryModalProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const [request, setRequest] = useState("");
  const [schema, setSchema] = useState<Schema>({ kind: "loading" });
  const [state, setState] = useState<State>({ kind: "idle" });
  const [done, setDone] = useState<null | "inserted" | "newTab">(null);
  // 追い質問 (#1471): これまでの往復 (送ったプロンプトと回答の本文)。新規の生成で作り直す。
  const [exchanges, setExchanges] = useState<AiExchange[]>([]);
  const [followUp, setFollowUp] = useState("");
  // 最初の生成で送信を確認した宛先。追い質問の本番確認を省けるのは、これと今の値が一致するときだけ。
  const confirmedRef = useRef<{ sessionId: string; database: string | null; isProduction: boolean } | null>(null);
  const stream = useAiStream({ idPrefix: "ai_nl2sql" });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const database = resolveNl2SqlDatabase(props.database, props.driver);

  useEffect(() => {
    // 接続 / データベースが変わったら会話を捨てる (別の宛先・別スキーマに古い履歴を送らない)。
    setExchanges([]);
    setFollowUp("");
    confirmedRef.current = null;
    if (!database) return;
    let alive = true;
    setSchema({ kind: "loading" });
    Promise.all([
      api.schemaOverview(props.sessionId, database),
      // 外部キーは補助情報。取れなくても生成自体は続ける。
      api.foreignKeys(props.sessionId, database).catch(() => []),
    ])
      .then(([tables, fks]) => {
        if (!alive) return;
        setSchema({
          kind: "ready",
          tables: tables.map((x) => ({ name: x.name, columns: x.columns })),
          foreignKeys: fks.map((f) => ({
            table: f.table,
            column: f.column,
            referenced_table: f.referenced_table,
            referenced_column: f.referenced_column,
          })),
        });
      })
      .catch((e) => {
        if (alive) setSchema({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [props.sessionId, database]);

  const summary = useMemo(
    () => (schema.kind === "ready" ? summarizeSchemaSend(schema.tables, schema.foreignKeys) : null),
    [schema],
  );
  const sendsLine = summary
    ? t("aiQuerySends", {
        database: database ?? t("aiQuerySendsDefaultDb"),
        tables: summary.tableCount,
        columns: summary.columnCount,
        kb: approxKb(summary.approxChars),
        dialect: dialectLabel(props.driver),
      })
    : null;

  const running = state.kind === "running";
  const trimmed = request.trim();
  const emptySchema = schema.kind === "ready" && schema.tables.length === 0;
  const canGenerate = !!database && schema.kind === "ready" && !emptySchema && trimmed !== "" && !running;
  const followUpTrimmed = followUp.trim();
  const canFollowUp =
    !!database && schema.kind === "ready" && exchanges.length > 0 && followUpTrimmed !== "" && !running;

  const run = async (followUpText?: string) => {
    const promptText = followUpText ?? trimmed;
    if (schema.kind !== "ready" || promptText === "") return;
    // 二重実行 (連打・Cmd+Enter の連続) で 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner(schema, followUpText);
    } catch (e) {
      stream.release();
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  const runInner = async (
    ready: { tables: Nl2SqlTable[]; foreignKeys: Nl2SqlForeignKey[] },
    followUpText?: string,
  ) => {
    // 追い質問は、最初の送信で確認した宛先と同じときだけ再確認しない。
    const c = confirmedRef.current;
    const sameTarget =
      c !== null &&
      c.sessionId === props.sessionId &&
      c.database === database &&
      c.isProduction === props.isProduction;
    if (props.isProduction && !(followUpText !== undefined && sameTarget)) {
      const ok = await confirm({
        title: t("aiQueryConfirmTitle"),
        message: `${t("aiQueryConfirmBody")}\n${sendsLine ?? ""}`,
        confirmLabel: t("aiQueryConfirmSend"),
        tone: "warning",
      });
      if (!ok) {
        stream.release();
        return;
      }
    }
    confirmedRef.current = { sessionId: props.sessionId, database, isProduction: props.isProduction };
    setDone(null);
    // 新規の生成は新しい会話の始まり。表示中の結果が消えるので、古い往復も持ち越さない。
    if (followUpText === undefined) setExchanges([]);
    setState({ kind: "running" });
    // スキーマを含む固定部分はプロンプトキャッシュの対象にする (#1473)。
    const systemParts = buildNl2SqlSystemParts({
      driver: props.driver,
      database,
      locale,
      readOnly: props.readOnly,
      tables: ready.tables,
      foreignKeys: ready.foreignKeys,
    });
    const isFollowUp = followUpText !== undefined;
    const prompt = buildNl2SqlPrompt(followUpText ?? request);
    // 新規の生成は履歴なし。追い質問は直近の往復を、system / 今回のプロンプトを除いた枠に収めて付ける。
    const history = isFollowUp
      ? buildHistory(exchanges, {
          maxBytes: historyBudget(systemParts.cached, systemParts.variable, prompt),
        })
      : [];
    await stream.start(
      {
        task: "nl2sql",
        systemCached: systemParts.cached,
        system: systemParts.variable || undefined,
        // 新規の生成は `history` を渡さない (単発の呼び出しは従来どおり)。
        history: history.length > 0 ? history : undefined,
        prompt,
        settings: toAiSnapshot(ai),
        format: NL2SQL_FORMAT,
      },
      {
        parse: parseNl2SqlResponse,
        onDone: ({ parsed, text }) => {
          setState(parsed.ok ? { kind: "done", value: parsed.value } : { kind: "raw", raw: parsed.raw });
          // 解釈できた回答だけを会話に積む (壊れた本文を次の依頼に混ぜない)。
          if (parsed.ok) {
            const exchange = { prompt, answer: text };
            setExchanges((prev) => (isFollowUp ? appendExchange(prev, exchange) : [exchange]));
            setFollowUp("");
          }
        },
        onError: (f) => setState({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled" }),
      },
    );
  };

  if (!ai.enabled) return null;

  return (
    <>
    <Modal
      width="680px"
      onClose={props.onClose}
      onSubmit={() => {
        // フォーカス中の欄で振り分ける。メインの依頼欄なら新規生成、それ以外で追い質問の入力があれば追い質問。
        if (document.activeElement === inputRef.current) void run();
        else if (canFollowUp) void run(followUpTrimmed);
        else void run();
      }}
      submitDisabled={!canGenerate && !canFollowUp}
      initialFocusEl={() => inputRef.current}
    >
      <ModalHeader onClose={props.onClose} closeLabel={t("aiQueryClose")}>
        {t("aiQueryTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4" data-testid="ai-query-modal">
        <FormSection>
          <FieldLabel htmlFor="ai-query-request">{t("aiQueryRequestLabel")}</FieldLabel>
          <Textarea
            id="ai-query-request"
            ref={inputRef}
            rows={3}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={t("aiQueryRequestPlaceholder")}
          />
          {database && schema.kind === "loading" && (
            <Flex align="center" gap="2" color="app.textMuted" fontSize="xs">
              <Spinner size={12} />
              {t("aiQuerySchemaLoading")}
            </Flex>
          )}
          {sendsLine && (
            <chakra.span color="app.textMuted" fontSize="xs" data-testid="ai-query-sends">
              {sendsLine}
            </chakra.span>
          )}
        </FormSection>
        {!database && <ErrorNote role="alert">{t("aiQueryNoDatabase")}</ErrorNote>}
        {schema.kind === "error" && (
          <ErrorNote role="alert">{t("aiQuerySchemaError", { message: schema.message })}</ErrorNote>
        )}
        {emptySchema && (
          <Callout tone="warning" role="status">
            {t("aiQueryEmptySchema")}
          </Callout>
        )}
        {summary?.large && (
          <Callout tone="warning" role="status">
            {t("aiQueryLargeSchema", { tables: summary.tableCount, kb: approxKb(summary.approxChars) })}
          </Callout>
        )}
        {props.readOnly && (
          <Callout tone="info" role="status">
            {t("aiQueryReadOnlyNote")}
          </Callout>
        )}
        {running && (
          <Flex direction="column" gap="2" fontSize="sm">
            <AiStreamProgress stream={stream} fields={["sql", "explanation"]} waitingLabel={t("aiQueryRunning")} />
            <Flex>
              <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
                {t("aiQueryCancel")}
              </Button>
            </Flex>
          </Flex>
        )}
        {state.kind === "done" && (
          <Flex direction="column" gap="3" aria-live="polite">
            <FormSection>
              <FieldLabel as="div">{t("aiQueryResultSql")}</FieldLabel>
              <CodePreview wrap maxH="240px">
                {state.value.sql}
              </CodePreview>
              <Flex align="center" gap="2" wrap="wrap">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    props.onInsert(state.value.sql);
                    setDone("inserted");
                  }}
                >
                  {t("aiQueryInsert")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    props.onOpenInNewTab(state.value.sql, database);
                    setDone("newTab");
                  }}
                >
                  {t("aiQueryOpenInNewTab")}
                </Button>
                {done && (
                  <chakra.span color="app.textSuccess" fontSize="sm" role="status">
                    {done === "inserted" ? t("aiQueryInserted") : t("aiQueryOpenedInNewTab")}
                  </chakra.span>
                )}
              </Flex>
            </FormSection>
            {state.value.explanation && (
              <FormSection>
                <FieldLabel as="div">{t("aiQueryExplanation")}</FieldLabel>
                <chakra.span whiteSpace="pre-wrap" fontSize="sm">
                  {state.value.explanation}
                </chakra.span>
              </FormSection>
            )}
            {state.value.warnings.length > 0 && (
              <Callout tone="warning" title={t("aiQueryWarnings")} role="status">
                {state.value.warnings.map((w, i) => (
                  <chakra.div key={`${i}-${w}`}>{w}</chakra.div>
                ))}
              </Callout>
            )}
            {state.value.tables_used.length > 0 && (
              <FormSection>
                <FieldLabel as="div">{t("aiQueryTablesUsed")}</FieldLabel>
                <chakra.span fontSize="sm">{state.value.tables_used.join(", ")}</chakra.span>
              </FormSection>
            )}
          </Flex>
        )}
        <AiUsageNote event={stream.done} />
        {state.kind === "raw" && (
          <Flex direction="column" gap="1">
            <ErrorNote role="alert">{t("aiQueryParseError")}</ErrorNote>
            <CodePreview wrap maxH="200px">
              {state.raw}
            </CodePreview>
          </Flex>
        )}
        {state.kind === "error" &&
          (state.refused ? (
            <Callout tone="warning" role="alert">
              {t("aiQueryRefused", { message: state.message })}
            </Callout>
          ) : (
            <ErrorNote role="alert">{t("aiQueryError", { message: state.message })}</ErrorNote>
          ))}
        {state.kind === "cancelled" && (
          <Callout tone="info" role="status">
            {t("aiQueryCancelled")}
          </Callout>
        )}
        {exchanges.length > 0 && !running && (
          <FormSection data-testid="ai-query-followup">
            <FieldLabel htmlFor="ai-query-followup-input">{t("aiFollowUpLabel")}</FieldLabel>
            <Textarea
              id="ai-query-followup-input"
              rows={2}
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              placeholder={t("aiFollowUpPlaceholder")}
            />
            <Flex align="center" gap="2" wrap="wrap">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canFollowUp}
                onClick={() => {
                  void run(followUpTrimmed);
                }}
              >
                {t("aiFollowUpSend")}
              </Button>
              <chakra.span textStyle="caption" color="app.textMuted">
                {t("aiFollowUpHint", { count: MAX_HISTORY_EXCHANGES })}
              </chakra.span>
            </Flex>
          </FormSection>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={props.onClose}>
          {t("aiQueryClose")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canGenerate}
          onClick={() => {
            void run();
          }}
        >
          {t("aiQueryGenerate")}
        </Button>
      </ModalFooter>
    </Modal>
    {dialog}
    </>
  );
}
