import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Box, Flex, chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { useReturnFocus } from "../keyboardNav";
import { useSettings } from "../settings";
import { semanticColorToken } from "../semanticColors";
import {
  formatTxElapsed,
  isTxStale,
  oneLineSql,
  summarizeTxJournal,
  supportsTxBlockingCount,
  type TxJournalEntry,
  type TxMeta,
} from "../txJournal";
import { ToneChip } from "./ToneChip";
import { Tooltip } from "./Tooltip";
import { useToast } from "./Toast";
import { Button } from "./ui";

/** ブロック中セッション数を取り直す間隔 (ms)。 */
const BLOCKING_POLL_MS = 5000;

/** 放置警告 / ブロック通知を 1 つのトランザクションにつき 1 回だけ出すための既出キー。 */
const notified = new Set<string>();

/** トランザクションが終わった / 破棄されたとき、その接続の既出キーを消す (Set を増やし続けない)。 */
export function forgetTxNotifications(sessionId: string): void {
  for (const k of [...notified]) {
    if (k.startsWith(`stale:${sessionId}:`) || k.startsWith(`blocking:${sessionId}:`)) notified.delete(k);
  }
}

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 記録の一覧。ポップオーバーと COMMIT 確認ダイアログで共有する。新しいものを下に並べる。 */
export function TxJournalList({ entries }: { entries: readonly TxJournalEntry[] }) {
  const t = useT();
  if (entries.length === 0) {
    return (
      <chakra.p textStyle="caption" color="app.textMuted">
        {t("txChangesEmpty")}
      </chakra.p>
    );
  }
  return (
    <chakra.ol listStyleType="none" m="0" p="0" display="flex" flexDirection="column" gap="1">
      {entries.map((e, i) => (
        <Flex key={i} as="li" align="baseline" gap="2" minW="0" data-testid="tx-journal-entry">
          <chakra.span textStyle="caption" color="app.textMuted" flexShrink={0}>
            {clock(e.at)}
          </chakra.span>
          <chakra.code flex="1" minW="0" fontFamily="mono" textStyle="caption" truncate>
            {oneLineSql(e.sql)}
          </chakra.code>
          {e.ok ? (
            <chakra.span textStyle="numeric" color="app.textMuted" flexShrink={0}>
              {e.write
                ? t("txEntryAffected", { rows: e.rows ?? 0 })
                : e.rows === null
                  ? "—"
                  : t("txEntryRead", { rows: e.rows })}
            </chakra.span>
          ) : (
            <ToneChip tone="danger">{t("txEntryFailed")}</ToneChip>
          )}
        </Flex>
      ))}
    </chakra.ol>
  );
}

/** 「N 文 / 合計 M 行」の要約文。 */
export function useTxSummaryLabel(entries: readonly TxJournalEntry[]): string {
  const t = useT();
  const s = summarizeTxJournal(entries);
  return t("txChangesSummary", { statements: s.statements, rows: s.rows });
}

interface Props {
  sessionId: string;
  driver: string | undefined;
  isProduction: boolean;
  meta: TxMeta | undefined;
}

/**
 * ヘッダの明示トランザクション表示 (#2447)。TX バッジ (経過時間・放置警告)、他セッションを
 * ブロックしている数 (MySQL / PostgreSQL。SQLite は対象外)、実行した文の一覧ポップオーバー。
 * 状態は接続ごとに App が保持し、ここは表示中の接続のぶんだけ描画する。
 */
export function TransactionStatus({ sessionId, driver, isProduction, meta }: Props) {
  const t = useT();
  const toast = useToast();
  const startedAt = meta?.startedAt ?? 0;
  const entries = meta?.entries ?? [];
  const [now, setNow] = useState(() => Date.now());
  const settings = useSettings();
  // undefined = 初回の取得待ち (非表示)、null = 取得できない (「不明」と表示)。
  const [blocked, setBlocked] = useState<number | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closePopover = useCallback(() => setOpen(false), []);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const supportsBlocking = supportsTxBlockingCount(driver);
  const key = `${sessionId}:${startedAt}`;

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = startedAt > 0 ? now - startedAt : 0;
  const stale = isTxStale(elapsed, isProduction, {
    production: settings.txWarnMinutesProduction,
    other: settings.txWarnMinutesOther,
  });
  const elapsedLabel = formatTxElapsed(elapsed);

  // 放置の通知は 1 つのトランザクションにつき 1 回。
  useEffect(() => {
    if (!stale) return;
    const k = `stale:${key}`;
    if (notified.has(k)) return;
    notified.add(k);
    toast.notify({
      message: t("txStaleToast", { elapsed: elapsedLabel }),
      tone: "warning",
      severity: "warning",
    });
  }, [stale, key, elapsedLabel, toast, t]);

  // ブロック中セッション数の定期更新。前回の応答を待ってから次を予約する (setTimeout の連鎖)。
  // 接続を切り替えたら取り直す。
  useEffect(() => {
    setBlocked(undefined);
    if (!supportsBlocking) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      api
        .transactionBlockedSessions(sessionId)
        .then((n) => {
          if (!cancelled) setBlocked(n);
        })
        .catch(() => {
          if (!cancelled) setBlocked(null);
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(poll, BLOCKING_POLL_MS);
        });
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, supportsBlocking]);

  useEffect(() => {
    if (blocked == null || blocked <= 0) return;
    const k = `blocking:${key}`;
    if (notified.has(k)) return;
    notified.add(k);
    toast.notify({
      message: t("txBlockingToast", { count: blocked }),
      tone: "warning",
      severity: "warning",
    });
  }, [blocked, key, toast, t]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  const summaryLabel = useTxSummaryLabel(entries);
  const summary = summarizeTxJournal(entries);

  const badgeTone = stale ? ("danger" as const) : ("warning" as const);
  const badgeHelp = [
    t("txActiveHelp"),
    t("txElapsedHelp", { elapsed: elapsedLabel }),
    stale ? t("txStaleHelp") : "",
    driver === "sqlite" ? t("txSqliteLockHelp") : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <Tooltip label={badgeHelp} focusableWrapper>
        <chakra.span
          data-testid="tx-badge"
          data-stale={stale ? "true" : "false"}
          display="inline-flex"
          gap="1.5"
          textStyle="numeric"
          fontSize="2xs"
          fontWeight={700}
          letterSpacing="wider"
          px="1.5"
          py="0.5"
          borderRadius="sm"
          bg={semanticColorToken(badgeTone, "subtle")}
          color={semanticColorToken(badgeTone, "text")}
        >
          {t("txActiveBadge")} {elapsedLabel}
        </chakra.span>
      </Tooltip>
      {supportsBlocking ? (
        blocked === undefined ? null : blocked === null ? (
          <Tooltip label={t("txBlockingUnknownHelp")} focusableWrapper>
            <Box data-testid="tx-blocking">
              <ToneChip tone="muted">{t("txBlockingUnknown")}</ToneChip>
            </Box>
          </Tooltip>
        ) : (
          <Tooltip label={t("txBlockingHelp")} focusableWrapper>
            <Box data-testid="tx-blocking">
              <ToneChip tone={blocked > 0 ? "danger" : "muted"}>
                {blocked > 0 ? t("txBlockingCount", { count: blocked }) : t("txBlockingNone")}
              </ToneChip>
            </Box>
          </Tooltip>
        )
      ) : (
        <Tooltip label={t("txBlockingUnsupportedHelp")} focusableWrapper>
          <Box data-testid="tx-blocking">
            <ToneChip tone="muted">{t("txBlockingUnsupported")}</ToneChip>
          </Box>
        </Tooltip>
      )}
      <Button
        ref={buttonRef}
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="tx-changes-button"
        onClick={toggle}
      >
        {summaryLabel}
      </Button>
      {open && pos && (
        <TxChangesPopover
          pos={pos}
          entries={entries}
          failed={summary.failed}
          anchorRef={buttonRef}
          onClose={closePopover}
        />
      )}
    </>
  );
}

/** 実行した文の一覧ポップオーバー。外側クリック / Esc で閉じ、閉じたら呼び出したボタンへフォーカスを戻す。 */
function TxChangesPopover({
  pos,
  entries,
  failed,
  anchorRef,
  onClose,
}: {
  pos: { top: number; right: number };
  entries: readonly TxJournalEntry[];
  failed: number;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  useReturnFocus();
  // フォーカスは開いたときの 1 回だけ移す (親の毎秒の再描画で奪い直さない)。
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (panelRef.current?.contains(el) || anchorRef.current?.contains(el)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);
  return createPortal(
    <Box
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={t("txChangesTitle")}
      data-testid="tx-changes-popover"
      position="fixed"
      zIndex="popover"
      top={`${pos.top}px`}
      right={`${pos.right}px`}
      w="min(560px, calc(100vw - 16px))"
      maxH="min(420px, 70vh)"
      overflowY="auto"
      bg="app.surface"
      border="1px solid"
      borderColor="app.border"
      borderRadius="lg"
      shadow="elevationPopover"
      p="3"
    >
      <chakra.p textStyle="caption" fontWeight={600} color="app.text" mb="2">
        {t("txChangesTitle")}
      </chakra.p>
      <TxJournalList entries={entries} />
      {failed > 0 && (
        <chakra.p textStyle="caption" color="app.textMuted" mt="2">
          {t("txChangesFailedNote", { count: failed })}
        </chakra.p>
      )}
      <chakra.p textStyle="caption" color="app.textMuted" mt="2">
        {t("txChangesNote")}
      </chakra.p>
    </Box>,
    document.body,
  );
}
