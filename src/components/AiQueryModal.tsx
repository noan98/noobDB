import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions } from "../motion";
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
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { useCopyFeedback } from "./useCopyFeedback";
import { formatSqlAsync } from "./sqlFormat";
import { SQL_TOKEN_STYLE, sqlHighlightSegments } from "./sqlHighlight";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { Spinner } from "./Spinner";

/** `transition` は Chakra のスタイルプロップ名と衝突するため motion へ明示的に渡す。 */
const MotionFlex = chakra(motion.div, {}, { forwardProps: ["transition", "initial", "animate", "exit"] });

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

/** 左ペインのチャット欄に積む 1 件。AI 側は短い状況だけを出し、本文 (SQL・説明・注意点) は右ペインに出す。 */
type ChatEntry =
  | { role: "user"; text: string }
  | { role: "agent"; outcome: "done"; warnings: number }
  | { role: "agent"; outcome: "raw" | "error" | "cancelled" };

/** 生成 SQL の整形を待つ上限。超えたら AI の出力のまま表示する。 */
const FORMAT_TIMEOUT_MS = 3000;

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
  /**
   * エディタで開いているテーブル (テーブルタブのときだけ。`database` と同じ DB のもの)。
   * 依頼文がテーブルを名指ししないときの対象として AI に伝え、大きい DB でも必ず送る。
   */
  focusTable?: string | null;
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
  const copyFeedback = useCopyFeedback();
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
  // 追い質問 (#1471): これまでの往復 (送ったプロンプトと回答の本文)。新しい会話で作り直す。
  const [exchanges, setExchanges] = useState<AiExchange[]>([]);
  // チャット欄の表示用の履歴 (送信のたびに入力欄は空にする)。会話の中身 (`exchanges`) とは別に持つ。
  const [log, setLog] = useState<ChatEntry[]>([]);
  // 大きい DB の関連テーブル提案の元にする文。入力欄が空になった後 (送信後) は直前に送った文を使う。
  const [lastSent, setLastSent] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);
  // 最初の生成で送信を確認した宛先。追い質問の本番確認を省けるのは、これと今の値が一致するときだけ。
  const confirmedRef = useRef<{ sessionId: string; database: string | null; isProduction: boolean } | null>(null);
  const stream = useAiStream({ idPrefix: "ai_nl2sql" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 接続 / DB が変わるたびに進める世代。詳細取得の途中で宛先が変わったら、古い結果を使わない。
  const schemaGenRef = useRef(0);

  const database = resolveNl2SqlDatabase(props.database, props.driver);

  useEffect(() => {
    // 接続 / データベースが変わったら会話を捨てる (別の宛先・別スキーマに古い履歴を送らない)。
    setExchanges([]);
    setLog([]);
    setPicked(null);
    setPickFilter("");
    setLockedNames(null);
    setDetails(new Map());
    confirmedRef.current = null;
    schemaGenRef.current += 1;
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
  const focusTable = props.focusTable ?? null;
  const suggestBasis = request.trim() !== "" ? request : lastSent;
  const suggested = useMemo(
    () =>
      schema.kind === "ready" && schema.large
        ? new Set(selectRelevantTables(schema.tables, schema.foreignKeys, suggestBasis, focusTable))
        : null,
    [schema, suggestBasis, focusTable],
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
  const canFollowUp =
    !!database && schema.kind === "ready" && exchanges.length > 0 && trimmed !== "" && !running;
  // 入力欄は 1 つ。最初の回答が返った後は、同じ欄からの送信を追い質問として扱う。
  const canSend = exchanges.length > 0 ? canFollowUp : canGenerate;
  const send = () => {
    if (exchanges.length > 0) void run(trimmed);
    else void run();
  };
  /** 会話を捨てて最初の依頼からやり直す (送るテーブルの固定も外す)。 */
  const resetConversation = () => {
    setExchanges([]);
    setLog([]);
    setLastSent("");
    setLockedNames(null);
    setState({ kind: "idle" });
    setDone(null);
    setRequest("");
    inputRef.current?.focus();
  };

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
  const fetchDetails = async (targets: Nl2SqlTable[]): Promise<ReadonlyMap<string, Nl2SqlColumn[]> | null> => {
    const gen = schemaGenRef.current;
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
    // 取得中に接続 / DB が変わった・閉じられたなら、古い DB の詳細を書き戻さず送信もしない。
    if (gen !== schemaGenRef.current || !stream.isMounted()) return null;
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
    // 追い質問は取り直さない (送る内容が変わるとプロンプトキャッシュが外れ、最初に確認した内容ともずれる)。
    const merged = schema.large && followUpText === undefined ? await fetchDetails(target.tables) : details;
    if (merged === null) {
      stream.release();
      return;
    }
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
    const sentText = (followUpText ?? request).trim();
    setLog((prev) => [...prev, { role: "user", text: sentText }]);
    setLastSent(sentText);
    setRequest("");
    setState({ kind: "running" });
    // スキーマを含む固定部分はプロンプトキャッシュの対象にする (#1473)。
    const systemParts = buildNl2SqlSystemParts({
      driver: props.driver,
      database,
      locale,
      readOnly: props.readOnly,
      tables: ready.tables,
      foreignKeys: ready.foreignKeys,
      focusTable,
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
          if (parsed.ok) {
            // 生成 SQL は 1 行に詰まって返ることが多いので、表示・挿入の前に必ず整形する。
            // 整形できない (方言の構文を sql-formatter が読めない等) ときは AI の出力のまま出す。
            const value = parsed.value;
            const gen = schemaGenRef.current;
            // 整形が返ってこない (ワーカーの起動待ちなど) ときに回答を止めないよう、待つのは一定時間まで。
            const timeout = new Promise<string>((resolve) => {
              window.setTimeout(() => resolve(value.sql), FORMAT_TIMEOUT_MS);
            });
            void Promise.race([formatSqlAsync(value.sql, props.driver), timeout])
              .catch(() => value.sql)
              .then((sql) => {
                if (!stream.isMounted()) return;
                // 整形中に接続 / DB が変わったら、古い宛先の結果は出さない。
                if (gen !== schemaGenRef.current) {
                  setState({ kind: "idle" });
                  return;
                }
                setState({ kind: "done", value: { ...value, sql: sql.trim() === "" ? value.sql : sql } });
              });
          } else {
            setState({ kind: "raw", raw: parsed.raw });
          }
          setLog((prev) => [
            ...prev,
            parsed.ok
              ? { role: "agent", outcome: "done", warnings: parsed.value.warnings.length }
              : { role: "agent", outcome: "raw" },
          ]);
          // 解釈できた回答だけを会話に積む (壊れた本文を次の依頼に混ぜない)。
          if (parsed.ok) {
            const exchange = { prompt, answer: text };
            setExchanges((prev) => (isFollowUp ? appendExchange(prev, exchange) : [exchange]));
          }
        },
        onError: (f) => {
          setState({ kind: "error", message: f.message, refused: f.refused });
          setLog((prev) => [...prev, { role: "agent", outcome: "error" }]);
        },
        onCancelled: () => {
          setState({ kind: "cancelled" });
          setLog((prev) => [...prev, { role: "agent", outcome: "cancelled" }]);
        },
      },
    );
  };

  // 新しい発言が積まれたらチャット欄の末尾まで送る。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 発言数と実行中表示の変化をきっかけに末尾へ送るための依存
  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [log.length, running]);

  if (!ai.enabled) return null;

  const result = state.kind === "done" ? state.value : null;
  // 右ペイン (結果) は最初の送信から出す。新しい会話で最初に戻ると閉じる。
  const showResult = log.length > 0 || state.kind !== "idle";
  const inConversation = exchanges.length > 0;

  return (
    <>
    <Modal
      width={showResult ? "1080px" : "640px"}
      onClose={props.onClose}
      onSubmit={send}
      submitDisabled={!canSend}
      initialFocusEl={() => inputRef.current}
    >
      <ModalHeader onClose={props.onClose} closeLabel={t("aiQueryClose")}>
        {t("aiQueryTitle")}
      </ModalHeader>
      <ModalBody
        display="flex"
        gap="4"
        // Body は flex: 1 (basis 0) なので height は効かない。最小の高さで 2 ペインの縦幅を確保する。
        minH={showResult ? "min(560px, 70vh)" : undefined}
        overflow="hidden"
        data-testid="ai-query-modal"
      >
        {/* 左ペイン: エージェントとのチャット (状況の注意・会話・入力欄)。 */}
        <Flex
          direction="column"
          gap="3"
          flex={showResult ? "0 0 42%" : "1"}
          minW="0"
          minH="0"
          data-testid="ai-query-chat"
        >
          <Flex align="center" gap="2">
            <FieldLabel htmlFor="ai-query-request" flex="1" minW="0">
              {t("aiQueryRequestLabel")}
            </FieldLabel>
            {(inConversation || log.length > 0) && (
              <Tooltip label={t("aiQueryNewConversation")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={resetConversation}
                  disabled={running}
                  aria-label={t("aiQueryNewConversation")}
                >
                  <Icon name="plus" size={ICON_SIZES.sm} />
                </Button>
              </Tooltip>
            )}
          </Flex>
          {!database && <ErrorNote role="alert">{t("aiQueryNoDatabase")}</ErrorNote>}
          {schema.kind === "error" && (
            <ErrorNote role="alert">{t("aiQuerySchemaError", { message: schema.message })}</ErrorNote>
          )}
          {emptySchema && (
            <Callout tone="warning" role="status">
              {t("aiQueryEmptySchema")}
            </Callout>
          )}
          {props.readOnly && (
            <Callout tone="info" role="status">
              {t("aiQueryReadOnlyNote")}
            </Callout>
          )}
          {/* チャット欄も右ペインと同じく、最初の送信で出す (それまでは入力欄だけ)。 */}
          <AnimatePresence initial={false}>
          {showResult && (
          <MotionFlex
            key="log"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={transitions.emphasized}
            display="flex"
            flexDirection="column"
            gap="2"
            flex="1"
            minH="0"
            overflowY="auto"
            border="1px solid"
            borderColor="app.border"
            borderRadius="md"
            p="2.5"
            role="log"
            aria-live="polite"
            data-testid="ai-query-log"
          >
            {log.map((entry, i) =>
              entry.role === "user" ? (
                <chakra.div
                  key={i}
                  alignSelf="flex-end"
                  maxW="90%"
                  bg="app.active"
                  borderRadius="md"
                  px="2.5"
                  py="1.5"
                  textStyle="body"
                  whiteSpace="pre-wrap"
                  data-testid="ai-query-log-user"
                >
                  {entry.text}
                </chakra.div>
              ) : (
                <Flex
                  key={i}
                  alignSelf="flex-start"
                  maxW="90%"
                  gap="1.5"
                  align="flex-start"
                  bg="app.surfaceMuted"
                  borderRadius="md"
                  px="2.5"
                  py="1.5"
                  textStyle="body"
                  data-testid="ai-query-log-agent"
                >
                  <chakra.span display="inline-flex" flexShrink={0} pt="0.5" color="app.accent" aria-hidden>
                    <Icon name="sparkles" size={ICON_SIZES.sm} />
                  </chakra.span>
                  <chakra.span>
                    {entry.outcome === "done"
                      ? entry.warnings > 0
                        ? t("aiQueryChatDoneWarnings", { count: entry.warnings })
                        : t("aiQueryChatDone")
                      : entry.outcome === "cancelled"
                        ? t("aiQueryCancelled")
                        : t("aiQueryChatFailed")}
                  </chakra.span>
                </Flex>
              ),
            )}
            {running && (
              <Flex align="center" gap="2" alignSelf="flex-start" color="app.textMuted" textStyle="body">
                <Spinner size={12} />
                {t("aiQueryRunning")}
              </Flex>
            )}
            <div ref={logEndRef} />
          </MotionFlex>
          )}
          </AnimatePresence>
          {summary?.large && !inConversation && (
            <Callout tone="warning" role="status">
              {t("aiQueryLargeSchema", { total: summary.totalTables, tables: summary.tableCount, kb: approxKb(summary.approxChars) })}
            </Callout>
          )}
          {schema.kind === "ready" && schema.large && !emptySchema && !inConversation && (
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
              <Flex direction="column" maxH="120px" overflowY="auto" border="1px solid" borderColor="app.border" borderRadius="md" p="1.5">
                {pickRows.slice(0, PICKER_MAX_ROWS).map((x) => (
                  <chakra.label key={x.name} display="flex" alignItems="center" gap="2" cursor="pointer" fontSize="sm">
                    <Checkbox
                      checked={selectedNames?.has(x.name) ?? false}
                      disabled={running}
                      onChange={(e) => togglePick(x.name, e.target.checked)}
                    />
                    <chakra.span>{x.name}</chakra.span>
                    {x.comment && (
                      <chakra.span textStyle="caption" minW="0" truncate title={x.comment}>
                        {x.comment}
                      </chakra.span>
                    )}
                  </chakra.label>
                ))}
                {pickRows.length > PICKER_MAX_ROWS && (
                  <chakra.span textStyle="caption">
                    {t("aiQueryTablesMore", { count: pickRows.length - PICKER_MAX_ROWS })}
                  </chakra.span>
                )}
              </Flex>
            </FormSection>
          )}
          <Flex direction="column" gap="1.5">
            <Textarea
              id="ai-query-request"
              ref={inputRef}
              rows={3}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder={
                inConversation
                  ? t("aiFollowUpPlaceholder")
                  : focusTable
                    ? t("aiQueryRequestPlaceholderFocus", { table: focusTable })
                    : t("aiQueryRequestPlaceholder")
              }
            />
            <Flex align="flex-start" gap="2">
              <chakra.span textStyle="caption" flex="1" minW="0" data-testid="ai-query-sends">
                {database && schema.kind === "loading" ? (
                  <Flex as="span" align="center" gap="2">
                    <Spinner size={12} />
                    {t("aiQuerySchemaLoading")}
                  </Flex>
                ) : inConversation ? (
                  <>
                    {t("aiFollowUpHint", { count: MAX_HISTORY_EXCHANGES })}
                    {lockedNames ? ` ${t("aiQueryTablesLocked", { count: lockedNames.size })}` : ""}
                  </>
                ) : (
                  sendsLine
                )}
              </chakra.span>
              <Button type="button" variant="primary" size="sm" flexShrink={0} disabled={!canSend} onClick={send}>
                <Icon name="send" size={ICON_SIZES.sm} />
                {t("aiQuerySend")}
              </Button>
            </Flex>
          </Flex>
        </Flex>
        {/* 右ペイン: 提案された SQL・説明・注意点を上から並べる。やりとりが始まるまでは出さず、
            最初の送信で右からスライドインさせる (モーダルの幅も同時に広がる)。 */}
        <AnimatePresence initial={false}>
        {showResult && (
        <MotionFlex
          key="result"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={transitions.emphasized}
          display="flex"
          flexDirection="column"
          gap="3"
          flex="1"
          minW="0"
          minH="0"
          overflowY="auto"
          aria-live="polite"
          data-testid="ai-query-result"
        >
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
          {/* 中止はチャット欄に出すので、右ペインは未回答と同じ表示に戻す。 */}
          {state.kind === "cancelled" && (
            <EmptyState compact icon="query" title={t("aiQueryResultEmpty")} description={t("aiQueryResultEmptyHint")} />
          )}
          {result && (
            <>
              <FormSection>
                <Flex align="center" gap="1">
                  <FieldLabel as="div" flex="1" minW="0">
                    {t("aiQueryResultSql")}
                  </FieldLabel>
                  <Tooltip label={t("aiQueryInsert")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("aiQueryInsert")}
                      onClick={() => {
                        props.onInsert(result.sql);
                        setDone("inserted");
                      }}
                    >
                      <Icon name="insert-sql" size={ICON_SIZES.md} />
                    </Button>
                  </Tooltip>
                  <Tooltip label={t("aiQueryOpenInNewTab")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("aiQueryOpenInNewTab")}
                      onClick={() => {
                        props.onOpenInNewTab(result.sql, database);
                        setDone("newTab");
                      }}
                    >
                      <Icon name="external-link" size={ICON_SIZES.md} />
                    </Button>
                  </Tooltip>
                  <CopyButton
                    copied={copyFeedback.copied}
                    onClick={() => {
                      void copyFeedback.copy(result.sql);
                    }}
                    label={t("aiQueryCopySql")}
                    copiedLabel={t("aiQueryCopiedSql")}
                    display="inline-flex"
                    alignItems="center"
                    justifyContent="center"
                    px="2"
                    py="1"
                    border="none"
                    bg="transparent"
                    borderRadius="sm"
                    cursor="pointer"
                    _hover={{ bg: "app.hover", color: "app.text" }}
                  />
                </Flex>
                <CodePreview wrap maxH="260px" data-testid="ai-query-sql">
                  {sqlHighlightSegments(result.sql, props.driver).map((seg, i) =>
                    seg.kind === null ? (
                      seg.text
                    ) : (
                      <span key={i} style={SQL_TOKEN_STYLE[seg.kind]}>
                        {seg.text}
                      </span>
                    ),
                  )}
                </CodePreview>
                {done && (
                  <chakra.span color="app.textSuccess" fontSize="sm" role="status">
                    {done === "inserted" ? t("aiQueryInserted") : t("aiQueryOpenedInNewTab")}
                  </chakra.span>
                )}
              </FormSection>
              {result.explanation && (
                <FormSection>
                  <FieldLabel as="div">{t("aiQueryExplanation")}</FieldLabel>
                  <chakra.span whiteSpace="pre-wrap" textStyle="body">
                    {result.explanation}
                  </chakra.span>
                </FormSection>
              )}
              {result.warnings.length > 0 && (
                <Callout tone="warning" title={t("aiQueryWarnings")} role="status">
                  {result.warnings.map((w, i) => (
                    <chakra.div key={`${i}-${w}`}>{w}</chakra.div>
                  ))}
                </Callout>
              )}
            </>
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
        </MotionFlex>
        )}
        </AnimatePresence>
      </ModalBody>
      <ModalFooter>
        {/* 補助情報: 使用テーブルとモデル・トークン数。 */}
        <Flex direction="column" gap="0.5" minW="0" data-testid="ai-query-meta">
          {result && result.tables_used.length > 0 && (
            <chakra.span textStyle="caption" truncate>
              {t("aiQueryTablesUsed")}: {result.tables_used.join(", ")}
            </chakra.span>
          )}
          <AiUsageNote event={stream.done} />
        </Flex>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={props.onClose}>
          {t("aiQueryClose")}
        </Button>
      </ModalFooter>
    </Modal>
    {dialog}
    </>
  );
}
