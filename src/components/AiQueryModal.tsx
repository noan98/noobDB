import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type TableColumnInfo } from "../api/tauri";
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
  NL2SQL_LARGE_SCHEMA_TABLES,
  parseNl2SqlResponse,
  resolveNl2SqlDatabase,
  restrictSchema,
  selectRelevantTables,
  summarizeSchemaSend,
  type Nl2SqlColumn,
  type Nl2SqlForeignKey,
  type Nl2SqlResponse,
  type Nl2SqlTable,
} from "../ai/nl2sql";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { Button, Checkbox, Input, Textarea } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { Spinner } from "./Spinner";

type Schema =
  | { kind: "loading" }
  | { kind: "ready"; tables: Nl2SqlTable[]; foreignKeys: Nl2SqlForeignKey[]; large: boolean }
  | { kind: "error"; message: string };

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; value: Nl2SqlResponse }
  | { kind: "raw"; raw: string }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

/** 大きい DB で送信時にテーブルごとの詳細 (`describeTable`) を取るときの同時実行数。 */
const DETAIL_CONCURRENCY = 6;

/** `describeTable` の結果を送信用の列表現にする。 */
function toNl2SqlColumns(cols: TableColumnInfo[]): Nl2SqlColumn[] {
  return cols.map((c) => ({
    name: c.name,
    type: c.data_type,
    primaryKey: c.key.toUpperCase() === "PRI",
    nullable: c.nullable,
    comment: c.comment ?? null,
  }));
}

/** テーブルの列を、取得済みの詳細 (型・PK・コメント) で置き換える。詳細が無いテーブルは列名だけのまま。 */
function withDetails(tables: Nl2SqlTable[], details: ReadonlyMap<string, Nl2SqlColumn[]>): Nl2SqlTable[] {
  if (details.size === 0) return tables;
  return tables.map((x) => {
    const cols = details.get(x.name);
    return cols ? { ...x, columns: cols } : x;
  });
}

/** 関連テーブルの手動選択欄に一度に描く行数の上限 (残りは絞り込みで探す)。 */
const PICKER_MAX_ROWS = 200;

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
  // 大きい DB (#1472): 送るテーブルの選択。依頼文から自動で提案し、ユーザが触った後は自動で上書きしない。
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [pickFilter, setPickFilter] = useState("");
  // 追い質問は最初の生成で送ったテーブル集合を引き継ぐ (会話の途中でスキーマ = キャッシュ対象を変えない)。
  const [lockedNames, setLockedNames] = useState<ReadonlySet<string> | null>(null);
  // 大きい DB: 送信時に取ったテーブルごとの詳細 (型・PK・コメント)。追い質問で同じ内容を再利用する。
  const [details, setDetails] = useState<ReadonlyMap<string, Nl2SqlColumn[]>>(() => new Map());
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
    setPicked(null);
    setPickFilter("");
    setLockedNames(null);
    setDetails(new Map());
    confirmedRef.current = null;
    if (!database) return;
    let alive = true;
    setSchema({ kind: "loading" });
    Promise.all([
      // テーブル数の判定と候補選択は、キャッシュの効く概要 (テーブル名・列名) で行う。
      api.schemaOverview(props.sessionId, database),
      // 外部キー・テーブルコメントは補助情報。取れなくても生成自体は続ける (SQLite のコメントは常に無い)。
      api.foreignKeys(props.sessionId, database).catch(() => []),
      api.listTableComments(props.sessionId, database).catch(() => []),
    ])
      .then(async ([overview, fks, comments]) => {
        const commentOf = new Map(comments.map((c) => [c.name, c.comment]));
        const large = overview.length > NL2SQL_LARGE_SCHEMA_TABLES;
        let tables: Nl2SqlTable[] = overview.map((x) => ({
          name: x.name,
          comment: commentOf.get(x.name) ?? null,
          columns: x.columns.map((name) => ({ name })),
        }));
        // 閾値以下は全テーブルを送るので、型・PK・コメントまで一括取得する (取れなければ列名だけで続ける)。
        if (!large && tables.length > 0) {
          const described = await api.describeDatabase(props.sessionId, database).catch(() => null);
          if (described) {
            tables = described.map((x) => ({
              name: x.name,
              comment: commentOf.get(x.name) ?? null,
              columns: toNl2SqlColumns(x.columns),
            }));
          }
        }
        if (!alive) return;
        setSchema({
          kind: "ready",
          tables,
          large,
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

  // 送るテーブル: 閾値以下の DB は全テーブル (固定順でキャッシュが効く)。大きい DB は選択した関連テーブルだけ。
  // 追い質問に送る集合 (最初に送った集合に固定) は `runInner` で決める。
  const suggested = useMemo(
    () =>
      schema.kind === "ready" && schema.large ? new Set(selectRelevantTables(schema.tables, schema.foreignKeys, request)) : null,
    [schema, request],
  );
  const selectedNames: ReadonlySet<string> | null = picked ?? suggested;
  // 追い質問の途中 (最初の生成で送った集合が固定されている) は、その集合が実際に送る内容。
  const followingUp = exchanges.length > 0 && lockedNames !== null;
  const sendNames = followingUp ? lockedNames : selectedNames;
  const sending = useMemo(() => {
    if (schema.kind !== "ready") return null;
    const base =
      schema.large && sendNames ? restrictSchema(schema.tables, schema.foreignKeys, sendNames) : schema;
    return { tables: withDetails(base.tables, details), foreignKeys: base.foreignKeys };
  }, [schema, sendNames, details]);
  const summary = useMemo(
    () =>
      schema.kind === "ready" && sending
        ? summarizeSchemaSend(sending.tables, sending.foreignKeys, schema.tables.length)
        : null,
    [schema, sending],
  );
  const sendsLineFor = (sm: NonNullable<typeof summary>) =>
    t(sm.large ? "aiQuerySendsSubset" : "aiQuerySends", {
      database: database ?? t("aiQuerySendsDefaultDb"),
      tables: sm.tableCount,
      total: sm.totalTables,
      columns: sm.columnCount,
      kb: approxKb(sm.approxChars),
      dialect: dialectLabel(props.driver),
    });
  const sendsLine = summary ? sendsLineFor(summary) : null;

  const togglePick = (name: string, on: boolean) => {
    const next = new Set(selectedNames ?? []);
    if (on) next.add(name);
    else next.delete(name);
    setPicked(next);
  };
  const pickRows = useMemo(() => {
    if (schema.kind !== "ready" || !schema.large) return [];
    const f = pickFilter.trim().toLowerCase();
    return schema.tables.filter((x) => f === "" || x.name.toLowerCase().includes(f));
  }, [schema, pickFilter]);

  const running = state.kind === "running";
  const trimmed = request.trim();
  const emptySchema = schema.kind === "ready" && schema.tables.length === 0;
  // 大きい DB は送るテーブルが 1 件以上ないと生成できない (一致が無ければ手動で選んでもらう)。
  const noPick = schema.kind === "ready" && schema.large && (selectedNames?.size ?? 0) === 0;
  const canGenerate =
    !!database && schema.kind === "ready" && !emptySchema && !noPick && trimmed !== "" && !running;
  const followUpTrimmed = followUp.trim();
  const canFollowUp =
    !!database && schema.kind === "ready" && exchanges.length > 0 && followUpTrimmed !== "" && !running;

  const run = async (followUpText?: string) => {
    const promptText = followUpText ?? trimmed;
    if (schema.kind !== "ready" || promptText === "") return;
    // 新規生成は送るテーブルが無いと走らせない (選択 0 件の大きい DB で Cmd+Enter されたとき)。
    if (followUpText === undefined && !canGenerate) return;
    // 二重実行 (連打・Cmd+Enter の連続) で 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner(followUpText);
    } catch (e) {
      stream.release();
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  /** まだ詳細を持っていないテーブルの `describeTable` を取り、取得済みと合わせた Map を返す (失敗した表は列名だけ)。 */
  const fetchDetails = async (targets: Nl2SqlTable[]): Promise<ReadonlyMap<string, Nl2SqlColumn[]>> => {
    const missing = targets.filter((x) => !details.has(x.name));
    if (missing.length === 0 || !database) return details;
    const next = new Map(details);
    for (let i = 0; i < missing.length; i += DETAIL_CONCURRENCY) {
      await Promise.all(
        missing.slice(i, i + DETAIL_CONCURRENCY).map(async (x) => {
          try {
            next.set(x.name, toNl2SqlColumns(await api.describeTable(props.sessionId, database, x.name)));
          } catch {
            /* 詳細が取れない表は概要の列名だけで送る (生成自体は止めない) */
          }
        }),
      );
    }
    setDetails(next);
    return next;
  };

  const runInner = async (followUpText?: string) => {
    // 実際に送る内容を、送信確認の表示にもそのまま使う。
    if (schema.kind !== "ready") return;
    const target =
      followUpText !== undefined && schema.large && lockedNames
        ? restrictSchema(schema.tables, schema.foreignKeys, lockedNames)
        : schema.large && selectedNames
          ? restrictSchema(schema.tables, schema.foreignKeys, selectedNames)
          : schema;
    // 大きい DB は送るテーブルだけ、テーブル単位でキャッシュされる describeTable で型・PK・コメントを取る。
    const merged = schema.large ? await fetchDetails(target.tables) : details;
    const ready = { tables: withDetails(target.tables, merged), foreignKeys: target.foreignKeys };
    const sentSummary = summarizeSchemaSend(ready.tables, ready.foreignKeys, schema.tables.length);
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
        message: `${t("aiQueryConfirmBody")}\n${sendsLineFor(sentSummary)}`,
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
    // 新規の生成で送ったテーブル集合を会話の間は固定する (追い質問は引き継ぐ)。
    if (followUpText === undefined) {
      setLockedNames(schema.kind === "ready" && schema.large ? new Set(ready.tables.map((x) => x.name)) : null);
    }
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
            {t("aiQueryLargeSchema", { total: summary.totalTables, tables: summary.tableCount, kb: approxKb(summary.approxChars) })}
          </Callout>
        )}
        {schema.kind === "ready" && schema.large && !emptySchema && (
          <FormSection data-testid="ai-query-tables">
            <FieldLabel htmlFor="ai-query-table-filter">
              {t("aiQueryTablesPickLabel", { count: selectedNames?.size ?? 0 })}
            </FieldLabel>
            {noPick && (
              <Callout tone="info" role="status">
                {t("aiQueryTablesNone")}
              </Callout>
            )}
            <Input
              id="ai-query-table-filter"
              value={pickFilter}
              onChange={(e) => setPickFilter(e.target.value)}
              placeholder={t("aiQueryTablesFilter")}
              disabled={running}
            />
            <Flex direction="column" maxH="160px" overflowY="auto" border="1px solid" borderColor="app.border" borderRadius="md" p="1.5">
              {pickRows.slice(0, PICKER_MAX_ROWS).map((x) => (
                <chakra.label key={x.name} display="flex" alignItems="center" gap="2" cursor="pointer" fontSize="sm">
                  <Checkbox
                    checked={selectedNames?.has(x.name) ?? false}
                    disabled={running}
                    onChange={(e) => togglePick(x.name, e.target.checked)}
                  />
                  <chakra.span>{x.name}</chakra.span>
                  {x.comment && (
                    <chakra.span textStyle="caption" color="app.textMuted" minW="0" truncate title={x.comment}>
                      {x.comment}
                    </chakra.span>
                  )}
                </chakra.label>
              ))}
              {pickRows.length > PICKER_MAX_ROWS && (
                <chakra.span textStyle="caption" color="app.textMuted">
                  {t("aiQueryTablesMore", { count: pickRows.length - PICKER_MAX_ROWS })}
                </chakra.span>
              )}
            </Flex>
          </FormSection>
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
                {lockedNames ? ` ${t("aiQueryTablesLocked", { count: lockedNames.size })}` : ""}
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
