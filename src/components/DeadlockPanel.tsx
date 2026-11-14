import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";

import {
  api,
  type DeadlockAnalysis,
  type InnodbDeadlockView,
  type InnodbTransaction,
  type PgDeadlockView,
  type SqliteBusyView,
} from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import {
  errorAgeSecs,
  innodbCycle,
  lockSummary,
  pgCycle,
  relationIsMismatch,
  relationNoticeKey,
  sqliteBusyHints,
  unavailableKey,
} from "./deadlock";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { ErrorNote } from "./modalForm";
import { Spinner } from "./Spinner";
import { SqlPreview } from "./SqlPreview";
import { SurfaceRule } from "./SurfaceRule";
import { Button, Heading } from "./ui";

/**
 * デッドロック解析タブ (#2328 / ボトムパネルの診断グループ、プロセス監視の隣)。
 *
 * デッドロックはサーバがすぐ片方を巻き戻すので、エラーを見た時点では待機グラフに何も残らない。
 * ここではサーバが残した記録をあとから読む (`api.analyzeDeadlock`)。
 * - MySQL: `SHOW ENGINE INNODB STATUS` の最新報告 (`PROCESS` 権限が必要)
 * - PostgreSQL: 40P01 のエラー詳細から循環を描き、生きている相手の pid は現在のクエリで補う
 * - SQLite: 行ロックが無くデッドロックは起きない。`SQLITE_BUSY` の切り分け材料を出す
 * エラー本文 (`errorMessage`) はエラー表示の「デッドロックを解析」から渡される。
 * 開いたとき・接続やエラーが変わったときに 1 回だけ読み、ポーリングはしない。
 */

export interface DeadlockPanelProps {
  sessionId: string;
  driver: string;
  /** 解析の手がかりになるエラー本文。メニューから開いたときは `null`。 */
  errorMessage: string | null;
  /** そのエラーが表示された時刻 (ms)。最新の報告が今回のものかの判定に使う。 */
  errorAtMs: number | null;
  /** SQLite で、他の接続のプロファイル id から表示名を引く。 */
  profileNameFor?: (profileId: string | null) => string | null;
}

const cardCss = {
  border: "1px solid",
  borderColor: "app.border",
  borderRadius: "md",
  bg: "app.surface",
  padding: "3",
  display: "flex",
  flexDirection: "column",
  gap: "2",
  minWidth: "0",
  flex: "1 1 18rem",
} as const;

/** 待機の循環を `(1) → (2) → (1)` の並びで見せる帯。 */
function CycleStrip({ items, victim }: { items: { key: string; label: string }[]; victim?: string }) {
  const t = useT();
  if (items.length < 2) return null;
  return (
    <Flex align="center" gap="1.5" flexWrap="wrap" data-testid="deadlock-cycle">
      <chakra.span textStyle="overline" color="app.textSecondary">
        {t("deadlockCycle")}
      </chakra.span>
      {items.map((it, i) => (
        // 末尾は先頭へ戻る位置なので、同じラベルが重複しても位置を含めて一意にする。
        <Fragment key={`${it.key}-${i}`}>
          {i > 0 && <Icon name="chevron-right" size={ICON_SIZES.sm} />}
          <chakra.span
            textStyle="caption"
            fontFamily="var(--font-mono)"
            px="1.5"
            py="0.5"
            borderRadius="sm"
            border="1px solid"
            borderColor={it.key === victim ? "app.textError" : "app.border"}
            color={it.key === victim ? "app.textError" : "app.text"}
          >
            {it.label}
          </chakra.span>
        </Fragment>
      ))}
    </Flex>
  );
}

function MysqlTxnCard({ txn, driver }: { txn: InnodbTransaction; driver: string }) {
  const t = useT();
  const who = [txn.user, txn.host].filter(Boolean).join("@");
  return (
    <chakra.section {...cardCss} data-testid="deadlock-txn" data-victim={txn.rolled_back ? "true" : "false"}>
      <Flex align="center" gap="2" flexWrap="wrap">
        <chakra.span textStyle="subheading">{t("deadlockTxnTitle", { n: txn.label })}</chakra.span>
        {txn.rolled_back && (
          <chakra.span textStyle="caption" color="app.textError" fontWeight={600}>
            {t("deadlockVictim")}
          </chakra.span>
        )}
      </Flex>
      {txn.rolled_back && (
        <chakra.span textStyle="caption" color="app.textMuted">
          {t("deadlockVictimNote")}
        </chakra.span>
      )}
      <chakra.span textStyle="caption" color="app.textMuted">
        {[
          txn.thread_id != null ? t("deadlockThread", { id: txn.thread_id }) : null,
          who || null,
          txn.state,
          txn.active_secs != null ? t("deadlockActive", { secs: txn.active_secs }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </chakra.span>
      {txn.sql ? (
        <SqlPreview sql={txn.sql} driver={driver} wrap maxH="40" />
      ) : (
        <chakra.span textStyle="caption" color="app.textMuted">
          {t("deadlockNoSql")}
        </chakra.span>
      )}
      {txn.sql_truncated && (
        <chakra.span textStyle="caption" color="app.textWarning">
          {t("deadlockSqlTruncated")}
        </chakra.span>
      )}
      {txn.holds.length > 0 && (
        <Box>
          <chakra.span textStyle="overline" color="app.textSecondary">
            {t("deadlockHolds")}
          </chakra.span>
          <chakra.ul margin={0} paddingLeft="4" textStyle="caption" fontFamily="var(--font-mono)">
            {txn.holds.map((l, i) => (
              <li key={i}>{t("deadlockLockOn", lockSummary(l))}</li>
            ))}
          </chakra.ul>
        </Box>
      )}
      {txn.waits_for && (
        <Box>
          <chakra.span textStyle="overline" color="app.textSecondary">
            {t("deadlockWaitsFor")}
          </chakra.span>
          <chakra.div textStyle="caption" fontFamily="var(--font-mono)">
            {t("deadlockLockOn", lockSummary(txn.waits_for))}
          </chakra.div>
          {txn.waits_on.length > 0 && (
            <chakra.div textStyle="caption" color="app.textMuted">
              {txn.waits_on.map((n) => t("deadlockWaitsOn", { n })).join(", ")}
            </chakra.div>
          )}
        </Box>
      )}
    </chakra.section>
  );
}

function MysqlView({ view, driver }: { view: InnodbDeadlockView; driver: string }) {
  const t = useT();
  const relKey = relationNoticeKey(view.relation);
  const cycle = innodbCycle(view.transactions);
  const victim = view.transactions.find((x) => x.rolled_back);
  return (
    <>
      {view.detected_at && (
        <chakra.span textStyle="caption" color="app.textMuted" data-testid="deadlock-detected-at">
          {t("deadlockDetectedAt", { time: view.detected_at })}
        </chakra.span>
      )}
      {relKey && (
        <Callout
          tone={relationIsMismatch(view.relation) ? "warning" : "info"}
          role="status"
          data-testid="deadlock-relation"
        >
          {t(relKey)}
        </Callout>
      )}
      {view.incomplete && (
        <Callout tone="warning" role="status" data-testid="deadlock-incomplete">
          {t("deadlockIncomplete")}
        </Callout>
      )}
      <CycleStrip
        items={cycle.map((n) => ({ key: String(n), label: `(${n})` }))}
        victim={victim ? String(victim.label) : undefined}
      />
      <Flex gap="3" flexWrap="wrap" alignItems="stretch">
        {view.transactions.map((txn) => (
          <MysqlTxnCard key={txn.label} txn={txn} driver={driver} />
        ))}
      </Flex>
    </>
  );
}

function PgView({ view }: { view: PgDeadlockView }) {
  const t = useT();
  const cycle = pgCycle(view.edges);
  return (
    <>
      <CycleStrip
        items={cycle.map((pid) => ({ key: String(pid), label: String(pid) }))}
        victim={view.victim_pid != null ? String(view.victim_pid) : undefined}
      />
      <chakra.ul
        margin={0}
        paddingLeft="4"
        textStyle="caption"
        fontFamily="var(--font-mono)"
        data-testid="deadlock-pg-edges"
      >
        {view.edges.map((e) => (
          <li key={`${e.waiter_pid}-${e.blocker_pid}`}>
            {t("deadlockPgEdge", {
              waiter: e.waiter_pid,
              mode: e.lock_mode,
              target: e.target,
              blocker: e.blocker_pid,
            })}
          </li>
        ))}
      </chakra.ul>
      {view.context && (
        <chakra.div textStyle="caption" color="app.textMuted">
          {t("deadlockPgContext")}: <chakra.span fontFamily="var(--font-mono)">{view.context}</chakra.span>
        </chakra.div>
      )}
      <Flex gap="3" flexWrap="wrap" alignItems="stretch">
        {view.processes.map((p) => (
          <chakra.section key={p.pid} {...cardCss} data-testid="deadlock-pg-process">
            <Flex align="center" gap="2" flexWrap="wrap">
              <chakra.span textStyle="subheading">{t("deadlockProcessTitle", { pid: p.pid })}</chakra.span>
              {p.pid === view.victim_pid && (
                <chakra.span textStyle="caption" color="app.textError" fontWeight={600}>
                  {t("deadlockVictim")}
                </chakra.span>
              )}
            </Flex>
            {p.alive ? (
              <>
                <chakra.span textStyle="caption" color="app.textMuted">
                  {[p.user, p.application_name, p.state ? t("deadlockPgState", { state: p.state }) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </chakra.span>
                {p.query && <SqlPreview sql={p.query} driver="postgres" wrap maxH="40" />}
                {p.query_hidden && (
                  <chakra.span textStyle="caption" color="app.textMuted">
                    {t("deadlockPgQueryHidden")}
                  </chakra.span>
                )}
              </>
            ) : (
              <chakra.span textStyle="caption" color="app.textMuted">
                {t("deadlockPgGone")}
              </chakra.span>
            )}
          </chakra.section>
        ))}
      </Flex>
      {view.processes.some((p) => p.alive) && (
        <chakra.span textStyle="caption" color="app.textMuted">
          {t("deadlockPgQueryNote")}
        </chakra.span>
      )}
      <Callout tone="info" role="status" data-testid="deadlock-pg-log-note">
        {t("deadlockPgLogNote", {
          logLockWaits: view.log_lock_waits ?? "?",
          timeout: view.deadlock_timeout ?? "?",
        })}
        {view.log_lock_waits === "off" && ` ${t("deadlockPgLogHint")}`}
      </Callout>
    </>
  );
}

function SqliteView({
  view,
  profileNameFor,
}: {
  view: SqliteBusyView;
  profileNameFor?: (profileId: string | null) => string | null;
}) {
  const t = useT();
  const hints = sqliteBusyHints(view);
  return (
    <>
      <Callout tone="info" role="status" data-testid="deadlock-sqlite-note">
        {t("deadlockSqliteNote")}
      </Callout>
      <chakra.ul margin={0} paddingLeft="4" textStyle="body" display="flex" flexDirection="column" gap="1.5">
        <li data-testid="deadlock-sqlite-journal">
          {t("deadlockSqliteJournal", { mode: view.journal_mode ?? "?" })}
        </li>
        <li data-testid="deadlock-sqlite-timeout">
          {t("deadlockSqliteBusyTimeout", { ms: view.busy_timeout_ms ?? "?" })}
        </li>
      </chakra.ul>
      {hints.includes("journalNotWal") && (
        <Callout tone="warning" role="status">
          {t("deadlockSqliteHintNotWal")}
        </Callout>
      )}
      {hints.includes("noBusyTimeout") && (
        <Callout tone="warning" role="status">
          {t("deadlockSqliteHintNoTimeout")}
        </Callout>
      )}
      {view.holders.length > 0 ? (
        <Box data-testid="deadlock-sqlite-holders">
          <chakra.p margin={0} textStyle="body">
            {t("deadlockSqliteHolders")}
          </chakra.p>
          <chakra.ul margin={0} paddingLeft="4" textStyle="body">
            {view.holders.map((h) => (
              <li key={h.session_id}>
                {profileNameFor?.(h.profile_id) ?? t("deadlockSqliteHolderUnnamed", { id: h.session_id })}
              </li>
            ))}
          </chakra.ul>
        </Box>
      ) : (
        <chakra.p margin={0} textStyle="body" color="app.textMuted" data-testid="deadlock-sqlite-no-holders">
          {t("deadlockSqliteNoHolders")}
        </chakra.p>
      )}
    </>
  );
}

export function DeadlockPanel({
  sessionId,
  driver,
  errorMessage,
  errorAtMs,
  profileNameFor,
}: DeadlockPanelProps) {
  const t = useT();
  const [analysis, setAnalysis] = useState<DeadlockAnalysis | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 古い応答が新しい解析を上書きしないよう、世代で捨てる。
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    setFailure(null);
    try {
      const r = await api.analyzeDeadlock(sessionId, errorMessage, errorAgeSecs(errorAtMs, Date.now()));
      if (mine === gen.current) setAnalysis(r);
    } catch (e) {
      if (mine === gen.current) {
        setAnalysis(null);
        setFailure(String(e));
      }
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [sessionId, errorMessage, errorAtMs]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="3.5">
      <chakra.header
        position="relative"
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <Heading>{t("deadlockTitle")}</Heading>
        <Button type="button" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner size={12} decorative /> : <Icon name="refresh" size={ICON_SIZES.sm} />}
          {t("deadlockRefresh")}
        </Button>
        <SurfaceRule />
      </chakra.header>
      <chakra.p margin={0} textStyle="body" color="app.textMuted">
        {t("deadlockDesc")}
      </chakra.p>

      {failure && <ErrorNote role="alert">{t("deadlockFailed", { error: failure })}</ErrorNote>}
      {loading && !analysis && (
        <chakra.span textStyle="caption" color="app.textMuted">
          {t("deadlockLoading")}
        </chakra.span>
      )}
      {analysis?.unavailable && (
        <Callout tone="warning" role="status" data-testid="deadlock-unavailable">
          {t(unavailableKey(analysis.unavailable))}
        </Callout>
      )}
      {analysis?.mysql && analysis.mysql.print_all_deadlocks === false && (
        <Callout tone="info" role="status" data-testid="deadlock-print-all-off">
          {t("deadlockPrintAllOff")}
        </Callout>
      )}
      {analysis?.mysql && analysis.mysql.transactions.length > 0 && (
        <MysqlView view={analysis.mysql} driver={driver} />
      )}
      {analysis?.postgres && <PgView view={analysis.postgres} />}
      {analysis?.sqlite && <SqliteView view={analysis.sqlite} profileNameFor={profileNameFor} />}
      {!loading && !failure && analysis === null && (
        <EmptyState compact icon="warning" title={t("deadlockTitle")} description={t("deadlockDesc")} />
      )}
    </Box>
  );
}
