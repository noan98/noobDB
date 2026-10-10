import { useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api } from "../api/tauri";
import type { ConnectionProfile, HistoryEntry } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import { needsSendScopeConfirm } from "../ai/errorExplain";
import {
  buildHistorySearchPrompt,
  buildHistorySearchSystem,
  buildHistorySummaryPrompt,
  buildHistorySummarySystem,
  describeCandidateScope,
  formatCandidates,
  HISTORY_SEARCH_FORMAT,
  HISTORY_SEARCH_MAX_CANDIDATES,
  limitCandidates,
  parseHistorySearchResponse,
  type FormattedCandidates,
  type HistoryCandidate,
  type HistorySearchMatch,
} from "../ai/historySearch";
import { useAiAvailable } from "../ai/useAiAvailable";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { Button, Input } from "./ui";
import { Callout } from "./Callout";
import { CopyButton } from "./CopyButton";
import { useConfirm } from "./ConfirmDialog";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { useCopyFeedback } from "./useCopyFeedback";

/** SQL 全文の取得を同時に走らせる件数。 */
const FETCH_BATCH = 20;

type Mode = "search" | "summary";

/** 結果の 1 行。完了時の候補を写して持つので、後から一覧のフィルタが変わっても消えない。 */
interface MatchRow extends HistorySearchMatch {
  preview: string;
  executedAt: string;
}

/** 候補を取り直すときの履歴フィルタ (`api.listHistory` の引数と同じ意味)。 */
export interface HistoryFilterParams {
  profileId: string | null;
  search: string | null;
  status: string | null;
  from: string | null;
  to: string | null;
}

type State =
  | { kind: "idle" }
  | { kind: "empty" }
  | { kind: "running"; sends: string; mode: Mode }
  | { kind: "matches"; sends: string; matches: MatchRow[]; notes: string[] }
  | { kind: "summary"; sends: string; text: string; notes: string[] }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiHistorySearchProps {
  /** 現在の絞り込み (検索語・期間・ステータス・接続)。送信前にこの条件で候補を取り直す。 */
  filters: HistoryFilterParams;
  /** 期間フィルタの表示名 (確認文とサマリのプロンプトに使う)。 */
  periodLabel: string;
  /** 結果の行を押したときに SQL をエディタへ復元する。 */
  onOpen: (id: number) => void;
}

/**
 * 履歴パネルの AI 検索 (#699)。自然言語で履歴を探す検索と、表示中の履歴の作業サマリ生成。
 * 既存の LIKE 検索 / 期間 / 接続フィルタで絞った候補 (最大 300 件) だけを送り、送信前に
 * 必ず件数・期間・接続を示して確認する。AI が使えない (無効 / キー未設定) ときは何も描かない。
 */
export function AiHistorySearch({ filters, periodLabel, onOpen }: AiHistorySearchProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const available = useAiAvailable();
  const { confirm, dialog } = useConfirm();
  const { copied, copy } = useCopyFeedback();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const stream = useAiStream({ idPrefix: "ai_hist" });
  // 履歴の取得 / 確認 / SQL 全文の取得など、ストリーム開始前の準備中か。
  const [preparing, setPreparing] = useState(false);
  const stopRef = useRef(false);

  const releaseBusy = () => {
    stream.release();
    setPreparing(false);
  };

  const sendsLine = (count: number, databases: string) =>
    t("aiHistorySends", {
      count,
      databases,
      sql: ai.maskLiterals ? t("aiHistoryConfirmSqlMasked") : t("aiHistoryConfirmSqlRaw"),
    });

  const run = async (mode: Mode) => {
    if (mode === "search" && query.trim() === "") return;
    if (!stream.acquire()) return;
    setPreparing(true);
    stopRef.current = false;
    try {
      await runInner(mode);
    } catch (e) {
      releaseBusy();
      if (stream.isMounted()) setState({ kind: "error", sends: "", message: String(e), refused: false });
    }
  };

  const runInner = async (mode: Mode) => {
    // 候補は送信前の今のフィルタで取り直す。表示中の一覧は 200 件で切れているため、
    // 301 件目の有無で「上限を超えた」ことを確かめる (一覧の state には触れない)。
    let listed: HistoryEntry[];
    try {
      listed = await api.listHistory({ ...filters, limit: HISTORY_SEARCH_MAX_CANDIDATES + 1 });
    } catch (e) {
      releaseBusy();
      setState({ kind: "error", sends: "", message: String(e), refused: false });
      return;
    }
    if (!stream.isMounted()) return releaseBusy();
    const { items: limited, overflow } = limitCandidates(listed);
    if (limited.length === 0) {
      setState({ kind: "empty" });
      return releaseBusy();
    }
    // 本番判定は確認の直前に最新のプロファイルで行う。取得できなければ安全側 (本番扱い) に倒す。
    let profiles: ConnectionProfile[] = [];
    let profilesFailed = false;
    try {
      profiles = await api.listProfiles();
    } catch {
      profilesFailed = true;
    }
    if (!stream.isMounted()) return releaseBusy();
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const productionIds = new Set(profiles.filter((p) => p.is_production).map((p) => p.id));
    const connName = (e: HistoryEntry) =>
      (e.profile_id ? profileById.get(e.profile_id)?.name : undefined) ?? "";
    const scope = describeCandidateScope(
      limited.map((e) => ({ executedAt: e.executed_at, connection: connName(e) })),
      new Set(),
    );
    const unknown = limited.some((e) => connName(e) === "");
    const connections = [...scope.connections, ...(unknown ? [t("aiHistoryConnUnknown")] : [])].join(", ");
    const databases =
      [...new Set(limited.map((e) => e.database).filter((d): d is string => !!d))].join(", ") ||
      t("aiHistoryConnUnknown");
    const includesProduction =
      profilesFailed || limited.some((e) => e.profile_id !== null && productionIds.has(e.profile_id));
    const period =
      scope.from && scope.to
        ? `${periodLabel} (${t("aiHistoryPeriodRange", {
            from: new Date(scope.from).toLocaleString(),
            to: new Date(scope.to).toLocaleString(),
          })})`
        : periodLabel;
    // プロンプト側の期間は表示用のローカル書式ではなく ISO にそろえる。
    const promptPeriod =
      scope.from && scope.to ? `${periodLabel} (${scope.from} - ${scope.to})` : periodLabel;
    const notes: string[] = [];
    if (overflow) notes.push(t("aiHistoryOverflow", { max: HISTORY_SEARCH_MAX_CANDIDATES }));
    // 送信前の確認は必ず行う。履歴 SQL にはリテラルとして実データが含まれうる。
    const lines = [
      t("aiHistoryConfirmBody", {
        count: scope.count,
        period,
        connections,
        databases,
        sql: ai.maskLiterals ? t("aiHistoryConfirmSqlMasked") : t("aiHistoryConfirmSqlRaw"),
      }),
    ];
    if (needsSendScopeConfirm(ai.sendScope)) lines.push(t("aiHistoryConfirmScopeOnly"));
    if (profilesFailed) lines.push(t("aiHistoryConfirmProductionUnknown"));
    else if (includesProduction) lines.push(t("aiHistoryConfirmProduction"));
    lines.push(...notes);
    const ok = await confirm({
      title: t("aiHistoryConfirmTitle"),
      message: (
        <Flex direction="column" gap="2">
          {lines.map((l) => (
            <chakra.p key={l}>{l}</chakra.p>
          ))}
        </Flex>
      ),
      confirmLabel: t("aiHistoryConfirmSend"),
      tone: "warning",
    });
    if (!ok) return releaseBusy();
    if (!stream.isMounted()) return releaseBusy();

    const sendsPre = sendsLine(limited.length, databases);
    setState({ kind: "running", sends: sendsPre, mode });

    // SQL 全文は一覧に無いので、確認後に必要な分だけ取る。取れない行 (削除済み等) は数えて通知する。
    const candidates: HistoryCandidate[] = [];
    let failedFetch = 0;
    for (let i = 0; i < limited.length; i += FETCH_BATCH) {
      const batch = limited.slice(i, i + FETCH_BATCH);
      const got = await Promise.all(
        batch.map(async (e): Promise<HistoryCandidate | null> => {
          try {
            const sql = await api.getHistorySql(e.id);
            return {
              id: e.id,
              sql,
              executedAt: e.executed_at,
              status: e.status,
              connection: connName(e),
              driver: e.driver,
              database: e.database,
            };
          } catch {
            return null;
          }
        }),
      );
      for (const c of got) {
        if (c) candidates.push(c);
        else failedFetch += 1;
      }
      if (!stream.isMounted() || stopRef.current) {
        releaseBusy();
        if (stream.isMounted()) setState({ kind: "cancelled", sends: sendsPre });
        return;
      }
    }
    if (candidates.length === 0) {
      releaseBusy();
      setState({
        kind: "error",
        sends: sendsPre,
        message: t("aiHistoryFetchAllFailed"),
        refused: false,
      });
      return;
    }
    if (failedFetch > 0) notes.push(t("aiHistoryFetchFailed", { count: failedFetch }));
    const formatted: FormattedCandidates = formatCandidates(candidates, ai.maskLiterals);
    if (formatted.truncated && !overflow) notes.push(t("aiHistoryTruncated"));
    const snapshot = new Map(limited.map((e) => [e.id, e]));
    const allowed = new Set(formatted.included.map((c) => c.id));
    const sends = sendsLine(formatted.included.length, databases);
    setState({ kind: "running", sends, mode });
    // 以降は実行中の判定をフック (stream.running) に引き継ぐ。
    setPreparing(false);
    await stream.start(
      {
      task: "historySearch",
      system: mode === "search" ? buildHistorySearchSystem(locale) : buildHistorySummarySystem(locale),
      prompt:
        mode === "search"
          ? buildHistorySearchPrompt({ query, candidates: formatted })
          : buildHistorySummaryPrompt({ periodLabel: promptPeriod, candidates: formatted }),
      settings: toAiSnapshot(ai),
      ...(mode === "search" ? { format: HISTORY_SEARCH_FORMAT } : {}),
      },
      {
        onDone: ({ text }) => {
          if (mode === "summary") {
            setState({ kind: "summary", sends, text: text.trim(), notes });
            return;
          }
          const parsed = parseHistorySearchResponse(text, allowed);
          if (!parsed.ok) {
            setState({ kind: "raw", sends, raw: parsed.raw });
            return;
          }
          const matches: MatchRow[] = parsed.matches.flatMap((m) => {
            const row = snapshot.get(m.historyId);
            return row ? [{ ...m, preview: row.sql_preview, executedAt: row.executed_at }] : [];
          });
          setState({ kind: "matches", sends, matches, notes });
        },
        onError: (f) => setState({ kind: "error", sends, message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled", sends }),
      },
    );
  };

  // 準備中 (stopRef) もストリーム (フック) も同じ「中止」ボタンから止める。
  const cancel = () => {
    stopRef.current = true;
    stream.cancel();
  };

  if (!available) return null;
  const running = preparing || stream.running;

  return (
    <Flex
      direction="column"
      gap="2"
      px="2.5"
      py="2"
      bg="app.surface"
      borderBottomWidth="1px"
      borderBottomColor="app.borderSubtle"
      fontSize="sm"
      color="app.text"
      role="group"
      aria-label={t("aiHistoryPanelLabel")}
      data-testid="ai-history-search"
    >
      <chakra.span color="app.textMuted" fontSize="xs">
        {t("aiHistoryScopeHint")}
      </chakra.span>
      <FieldLabel htmlFor="ai-history-query">{t("aiHistoryQueryLabel")}</FieldLabel>
      <Input
        id="ai-history-query"
        type="text"
        placeholder={t("aiHistoryQueryPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void run("search");
          }
        }}
      />
      <Flex align="center" gap="2" wrap="wrap">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={running || query.trim() === ""}
          onClick={() => {
            void run("search");
          }}
        >
          {t("aiHistorySearchRun")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={running}
          onClick={() => {
            void run("summary");
          }}
        >
          {t("aiHistorySummaryRun")}
        </Button>
        {running && (
          <Button type="button" variant="secondary" size="sm" onClick={cancel}>
            {t("aiHistoryCancel")}
          </Button>
        )}
      </Flex>
      {running && (
        <AiStreamProgress
          stream={stream}
          previewText={state.kind === "running" && state.mode === "summary"}
          waitingLabel={t("aiHistoryRunning")}
        />
      )}
      {state.kind === "empty" && (
        <Callout tone="info" role="status">
          {t("aiHistoryNoCandidates")}
        </Callout>
      )}
      {state.kind !== "idle" && state.kind !== "empty" && state.sends !== "" && (
        <chakra.span color="app.textMuted" fontSize="xs">
          {state.sends}
        </chakra.span>
      )}
      {(state.kind === "matches" || state.kind === "summary") &&
        state.notes.map((n) => (
          <Callout key={n} tone="warning" role="status">
            {n}
          </Callout>
        ))}
      {state.kind === "matches" &&
        (state.matches.length === 0 ? (
          <Callout tone="info" role="status">
            {t("aiHistoryNoMatches")}
          </Callout>
        ) : (
          <Flex direction="column" gap="1.5" aria-live="polite" maxH="320px" overflow="auto">
            {state.matches.map((m) => {
              return (
                <chakra.button
                  key={m.historyId}
                  type="button"
                  textAlign="left"
                  p="1.5"
                  borderWidth="1px"
                  borderColor="app.border"
                  borderRadius="md"
                  bg="app.bg"
                  cursor="pointer"
                  _hover={{ bg: "app.hover" }}
                  aria-label={`${t("aiHistoryOpen")}: ${m.preview}`}
                  onClick={() => onOpen(m.historyId)}
                >
                  <Flex gap="2" align="baseline">
                    <chakra.span color="app.textMuted" fontSize="xs" textStyle="numeric" flexShrink={0}>
                      {t("aiHistoryMatchScore", { score: m.relevance })}
                    </chakra.span>
                    <chakra.span fontFamily="mono" fontSize="xs" truncate>
                      {m.preview}
                    </chakra.span>
                  </Flex>
                  <chakra.div color="app.textMuted" fontSize="xs" whiteSpace="pre-wrap">
                    {m.reason}
                  </chakra.div>
                  <chakra.div color="app.textMuted" fontSize="2xs">
                    {new Date(m.executedAt).toLocaleString()}
                  </chakra.div>
                </chakra.button>
              );
            })}
          </Flex>
        ))}
      {state.kind === "summary" && (
        <Flex direction="column" gap="1">
          <Flex align="center" gap="2">
            <FieldLabel as="div">{t("aiHistorySummaryTitle")}</FieldLabel>
            <CopyButton
              copied={copied}
              onClick={() => {
                void copy(state.text);
              }}
              label={t("aiHistorySummaryCopy")}
              copiedLabel={t("historyCopied")}
            />
          </Flex>
          <chakra.div
            whiteSpace="pre-wrap"
            maxH="240px"
            overflow="auto"
            p="2"
            borderWidth="1px"
            borderColor="app.border"
            borderRadius="md"
            bg="app.bg"
            fontSize="sm"
          >
            {state.text}
          </chakra.div>
        </Flex>
      )}
      {state.kind === "raw" && (
        <Flex direction="column" gap="1">
          <ErrorNote role="alert">{t("aiHistoryParseError")}</ErrorNote>
          <CodePreview wrap maxH="160px">
            {state.raw}
          </CodePreview>
        </Flex>
      )}
      {state.kind === "error" &&
        (state.refused ? (
          <Callout tone="warning" role="alert">
            {t("aiHistoryRefused", { message: state.message })}
          </Callout>
        ) : (
          <ErrorNote role="alert">{t("aiHistoryError", { message: state.message })}</ErrorNote>
        ))}
      {state.kind === "cancelled" && (
        <Callout tone="info" role="status">
          {t("aiHistoryCancelled")}
        </Callout>
      )}
      {dialog}
    </Flex>
  );
}
