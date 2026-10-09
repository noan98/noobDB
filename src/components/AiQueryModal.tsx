import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, listenAiStream } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { dialectLabel } from "../ai/errorExplain";
import {
  approxKb,
  buildNl2SqlPrompt,
  buildNl2SqlSystem,
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
import { Spinner } from "./Spinner";

let seq = 0;
function makeStreamId(): string {
  seq += 1;
  return `ai_nl2sql_${Date.now().toString(36)}_${seq.toString(36)}`;
}

type Schema =
  | { kind: "loading" }
  | { kind: "ready"; tables: Nl2SqlTable[]; foreignKeys: Nl2SqlForeignKey[] }
  | { kind: "error"; message: string };

type State =
  | { kind: "idle" }
  | { kind: "running"; chars: number }
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
  onOpenInNewTab: (sql: string) => void;
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
  const busyRef = useRef(false);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const database = resolveNl2SqlDatabase(props.database, props.driver);

  useEffect(() => {
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
  const canGenerate = !!database && schema.kind === "ready" && trimmed !== "" && !running;

  const run = async () => {
    if (schema.kind !== "ready" || trimmed === "") return;
    // 二重実行 (連打・Cmd+Enter の連続) で 2 本のストリームが走らないよう、同期的に弾く。
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await runInner(schema);
    } catch (e) {
      busyRef.current = false;
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  const runInner = async (ready: { tables: Nl2SqlTable[]; foreignKeys: Nl2SqlForeignKey[] }) => {
    if (props.isProduction) {
      const ok = await confirm({
        title: t("aiQueryConfirmTitle"),
        message: `${t("aiQueryConfirmBody")}\n${sendsLine ?? ""}`,
        confirmLabel: t("aiQueryConfirmSend"),
        tone: "warning",
      });
      if (!ok) {
        busyRef.current = false;
        return;
      }
    }
    setDone(null);
    const streamId = makeStreamId();
    streamRef.current = streamId;
    let text = "";
    setState({ kind: "running", chars: 0 });
    try {
      const unlisten = await listenAiStream(streamId, {
        onDelta: (e) => {
          text += e.text;
          if (mountedRef.current) setState({ kind: "running", chars: text.length });
        },
        onDone: () => {
          stopListener(streamId);
          const parsed = parseNl2SqlResponse(text);
          setState(parsed.ok ? { kind: "done", value: parsed.value } : { kind: "raw", raw: parsed.raw });
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
        task: "nl2sql",
        system: buildNl2SqlSystem({
          driver: props.driver,
          database,
          locale,
          readOnly: props.readOnly,
          tables: ready.tables,
          foreignKeys: ready.foreignKeys,
        }),
        prompt: buildNl2SqlPrompt(request),
        settings: toAiSnapshot(ai),
        format: NL2SQL_FORMAT,
      });
    } catch (e) {
      stopListener(streamId);
      setState({ kind: "error", message: String(e), refused: false });
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

  if (!ai.enabled) return null;

  return (
    <>
    <Modal
      width="680px"
      onClose={props.onClose}
      onSubmit={() => {
        void run();
      }}
      submitDisabled={!canGenerate}
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
          <Flex align="center" gap="2" color="app.textMuted" fontSize="sm" aria-live="polite">
            <Spinner size={12} />
            {t("aiQueryRunning", { chars: state.chars })}
            <Button type="button" variant="secondary" size="sm" onClick={cancel}>
              {t("aiQueryCancel")}
            </Button>
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
                    props.onOpenInNewTab(state.value.sql);
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
