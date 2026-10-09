import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, listenAiStream } from "../api/tauri";
import type { ConnectionProfile, HistoryEntry } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
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
import { Spinner } from "./Spinner";
import { useCopyFeedback } from "./useCopyFeedback";

let seq = 0;
function makeStreamId(): string {
  seq += 1;
  return `ai_hist_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** SQL 全文の取得を同時に走らせる件数。 */
const FETCH_BATCH = 20;

type Mode = "search" | "summary";

type State =
  | { kind: "idle" }
  | { kind: "running"; sends: string }
  | { kind: "matches"; sends: string; matches: HistorySearchMatch[]; notes: string[] }
  | { kind: "summary"; sends: string; text: string; notes: string[] }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiHistorySearchProps {
  /** 現在の絞り込み (検索語・期間・ステータス・接続) を通った履歴。新しい順。 */
  entries: HistoryEntry[];
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
export function AiHistorySearch({ entries, periodLabel, onOpen }: AiHistorySearchProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const available = useAiAvailable();
  const { confirm, dialog } = useConfirm();
  const { copied, copy } = useCopyFeedback();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const streamRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    let alive = true;
    api
      .listProfiles()
      .then((p) => {
        if (alive) setProfiles(p);
      })
      .catch(() => {
        /* 接続名が引けなければ「不明」と表示するだけ */
      });
    return () => {
      alive = false;
    };
  }, []);

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
      stopRef.current = true;
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

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const { items: limited, overflow } = useMemo(() => limitCandidates(entries), [entries]);

  const sendsLine = (count: number) =>
    t("aiHistorySends", {
      count,
      sql: ai.maskLiterals ? t("aiHistoryConfirmSqlMasked") : t("aiHistoryConfirmSqlRaw"),
    });

  const run = async (mode: Mode) => {
    if (busyRef.current) return;
    if (mode === "search" && query.trim() === "") return;
    busyRef.current = true;
    stopRef.current = false;
    try {
      await runInner(mode);
    } catch (e) {
      busyRef.current = false;
      if (mountedRef.current) setState({ kind: "error", sends: "", message: String(e), refused: false });
    }
  };

  const runInner = async (mode: Mode) => {
    const abort = () => {
      busyRef.current = false;
    };
    if (limited.length === 0) {
      setState({ kind: "idle" });
      return abort();
    }
    const connName = (e: HistoryEntry) =>
      (e.profile_id ? profileById.get(e.profile_id)?.name : undefined) ?? "";
    const production = new Set(
      limited.flatMap((e) => {
        const p = e.profile_id ? profileById.get(e.profile_id) : undefined;
        return p?.is_production ? [p.name] : [];
      }),
    );
    const scope = describeCandidateScope(
      limited.map((e) => ({ executedAt: e.executed_at, connection: connName(e) })),
      production,
    );
    const unknown = limited.some((e) => connName(e) === "");
    const connections = [...scope.connections, ...(unknown ? [t("aiHistoryConnUnknown")] : [])].join(", ");
    const period =
      scope.from && scope.to
        ? `${periodLabel} (${t("aiHistoryPeriodRange", {
            from: new Date(scope.from).toLocaleString(),
            to: new Date(scope.to).toLocaleString(),
          })})`
        : periodLabel;
    // 送信前の確認は必ず行う。履歴 SQL にはリテラルとして実データが含まれうる。
    const lines = [
      t("aiHistoryConfirmBody", {
        count: scope.count,
        period,
        connections,
        sql: ai.maskLiterals ? t("aiHistoryConfirmSqlMasked") : t("aiHistoryConfirmSqlRaw"),
      }),
    ];
    if (needsSendScopeConfirm(ai.sendScope)) lines.push(t("aiHistoryConfirmScopeOnly"));
    if (scope.includesProduction) lines.push(t("aiHistoryConfirmProduction"));
    const ok = await confirm({
      title: t("aiHistoryConfirmTitle"),
      message: lines.join("\n"),
      confirmLabel: t("aiHistoryConfirmSend"),
      tone: "warning",
    });
    if (!ok) return abort();
    if (!mountedRef.current) return abort();

    const notes: string[] = [];
    if (overflow) {
      notes.push(
        t("aiHistoryOverflow", { total: entries.length, max: HISTORY_SEARCH_MAX_CANDIDATES }),
      );
    }
    setState({ kind: "running", sends: sendsLine(limited.length) });

    // SQL 全文は一覧に無いので、確認後に必要な分だけ取る。取れない行 (削除済み等) は落とす。
    const candidates: HistoryCandidate[] = [];
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
      for (const c of got) if (c) candidates.push(c);
      if (!mountedRef.current || stopRef.current) {
        busyRef.current = false;
        if (mountedRef.current) setState({ kind: "cancelled", sends: sendsLine(limited.length) });
        return;
      }
    }
    const formatted: FormattedCandidates = formatCandidates(candidates, ai.maskLiterals);
    if (formatted.included.length === 0) {
      busyRef.current = false;
      setState({ kind: "idle" });
      return;
    }
    if (formatted.truncated && !overflow) notes.push(t("aiHistoryTruncated"));
    const allowed = new Set(formatted.included.map((c) => c.id));
    const sends = sendsLine(formatted.included.length);
    const streamId = makeStreamId();
    streamRef.current = streamId;
    let text = "";
    setState({ kind: "running", sends });
    try {
      const unlisten = await listenAiStream(streamId, {
        onDelta: (e) => {
          text += e.text;
        },
        onDone: () => {
          stopListener(streamId);
          if (mode === "summary") {
            setState({ kind: "summary", sends, text: text.trim(), notes });
            return;
          }
          const parsed = parseHistorySearchResponse(text, allowed);
          setState(
            parsed.ok
              ? { kind: "matches", sends, matches: parsed.matches, notes }
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
        void api.cancelStream(streamId).catch(() => {
          /* まだ登録前 / すでに完了 */
        });
        return;
      }
      unlistenRef.current = unlisten;
      await api.runAiRequest({
        streamId,
        task: "historySearch",
        system: mode === "search" ? buildHistorySearchSystem(locale) : buildHistorySummarySystem(locale),
        prompt:
          mode === "search"
            ? buildHistorySearchPrompt({ query, candidates: formatted })
            : buildHistorySummaryPrompt({ periodLabel: period, candidates: formatted }),
        settings: toAiSnapshot(ai),
        ...(mode === "search" ? { format: HISTORY_SEARCH_FORMAT } : {}),
      });
      // 登録前に中止 / アンマウントされた場合は、登録が済んだ今あらためて止める。
      if (stopRef.current || !mountedRef.current) {
        void api.cancelStream(streamId).catch(() => {
          /* すでに完了 */
        });
      }
    } catch (e) {
      stopListener(streamId);
      if (mountedRef.current) setState({ kind: "error", sends, message: String(e), refused: false });
    }
  };

  const cancel = () => {
    stopRef.current = true;
    const sid = streamRef.current;
    if (sid) {
      void api.cancelStream(sid).catch(() => {
        /* すでに完了 */
      });
    }
  };

  if (!available) return null;
  const running = state.kind === "running";
  const rowById = new Map(entries.map((e) => [e.id, e]));

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
          disabled={running || query.trim() === "" || entries.length === 0}
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
          disabled={running || entries.length === 0}
          onClick={() => {
            void run("summary");
          }}
        >
          {t("aiHistorySummaryRun")}
        </Button>
        {running && (
          <>
            <Spinner size={12} />
            <chakra.span color="app.textMuted">{t("aiHistoryRunning")}</chakra.span>
            <Button type="button" variant="secondary" size="sm" onClick={cancel}>
              {t("aiHistoryCancel")}
            </Button>
          </>
        )}
      </Flex>
      {overflow && state.kind === "idle" && (
        <Callout tone="warning" role="status">
          {t("aiHistoryOverflow", { total: entries.length, max: HISTORY_SEARCH_MAX_CANDIDATES })}
        </Callout>
      )}
      {state.kind !== "idle" && state.sends !== "" && (
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
              const row = rowById.get(m.historyId);
              if (!row) return null;
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
                  aria-label={`${t("aiHistoryOpen")}: ${row.sql_preview}`}
                  onClick={() => onOpen(m.historyId)}
                >
                  <Flex gap="2" align="baseline">
                    <chakra.span color="app.accent" fontSize="xs" textStyle="numeric" flexShrink={0}>
                      {t("aiHistoryMatchScore", { score: m.relevance })}
                    </chakra.span>
                    <chakra.span fontFamily="mono" fontSize="xs" truncate>
                      {row.sql_preview}
                    </chakra.span>
                  </Flex>
                  <chakra.div color="app.textMuted" fontSize="xs" whiteSpace="pre-wrap">
                    {m.reason}
                  </chakra.div>
                  <chakra.div color="app.textMuted" fontSize="2xs">
                    {new Date(row.executed_at).toLocaleString()}
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
          <CodePreview wrap maxH="240px">
            {state.text}
          </CodePreview>
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
