// 明示トランザクションの経過時間・実行した文の記録・放置警告の純ロジック (#2447)。
// 判定・整形だけを持ち、状態 (接続ごとの保持) と表示は App / TransactionStatus が担う。
import { isTxControlStatement } from "./components/batchMarkers";
import { isReadOnlySql } from "./dangerousSql";

/** トランザクション内で実行した 1 文の記録。 */
export interface TxJournalEntry {
  sql: string;
  /** 書き込み文か (読み取り専用判定に通らないもの)。 */
  write: boolean;
  /** 成功か。失敗した文も残す (どこで止まったかを COMMIT 前に見られるように)。 */
  ok: boolean;
  /** 書き込み = 影響行数、読み取り = 返した行数。失敗は null。 */
  rows: number | null;
  elapsedMs: number | null;
  /** 実行した時刻 (epoch ms)。 */
  at: number;
}

/** 接続ごとに保持するトランザクションのメタ情報。 */
export interface TxMeta {
  /** BEGIN した時刻 (epoch ms)。 */
  startedAt: number;
  /** 表示用の一覧。上限 (`TX_JOURNAL_MAX_ENTRIES`) を超えたら古いものから捨てる。 */
  entries: readonly TxJournalEntry[];
  /** 累計 (捨てた分も含む)。状態表示と COMMIT 確認はこちらを使う。 */
  totals: TxJournalSummary;
  /** 上限を超えて一覧から省いた古い文の数。 */
  omitted: number;
}

/** BEGIN 直後の空の記録。 */
export function newTxMeta(startedAt: number): TxMeta {
  return { startedAt, entries: [], totals: { statements: 0, rows: 0, failed: 0 }, omitted: 0 };
}

/** 1 文を記録へ足す。一覧は上限で切り詰めるが、累計は捨てずに足し込む。 */
export function recordTxMeta(meta: TxMeta, entry: TxJournalEntry): TxMeta {
  const entries = appendTxEntry(meta.entries, entry);
  const delta = summarizeTxJournal([entry]);
  return {
    ...meta,
    entries,
    omitted: meta.omitted + (meta.entries.length + 1 - entries.length),
    totals: {
      statements: meta.totals.statements + delta.statements,
      rows: meta.totals.rows + delta.rows,
      failed: meta.totals.failed + delta.failed,
    },
  };
}

/** 一覧に残す最大件数。超えたら古いものから捨てる (長時間のトランザクションでメモリを増やさない)。 */
export const TX_JOURNAL_MAX_ENTRIES = 200;

/** 放置警告のしきい値 (分)。設定 `txWarnMinutesProduction` / `txWarnMinutesOther` から渡す。 */
export interface TxWarnMinutes {
  production: number;
  other: number;
}

export function txWarnThresholdMs(isProduction: boolean, warn: TxWarnMinutes): number {
  return (isProduction ? warn.production : warn.other) * 60_000;
}

/** 経過時間が警告しきい値に達したか (しきい値ちょうどで警告)。 */
export function isTxStale(elapsedMs: number, isProduction: boolean, warn: TxWarnMinutes): boolean {
  return elapsedMs >= txWarnThresholdMs(isProduction, warn);
}

/** 経過時間の表示。1 時間未満は `m:ss`、以上は `h:mm:ss`。負の値は 0 扱い。 */
export function formatTxElapsed(elapsedMs: number): string {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** 他セッションのブロック数を取れるドライバか。SQLite はサーバが無いので対象外 (経過時間のみ)。 */
export function supportsTxBlockingCount(driver: string | undefined): boolean {
  return driver === "mysql" || driver === "postgres";
}

/**
 * 記録を 1 件作る。書き込み文は影響行数、読み取り文は返した行数を `rows` に入れる
 * (`INSERT ... RETURNING` のように行を返す書き込みでも影響行数を採る)。
 */
export function makeTxEntry(
  sql: string,
  driver: string | undefined,
  outcome: { ok: true; returnedRows: number | null; affectedRows: number; elapsedMs: number } | { ok: false },
  at: number,
): TxJournalEntry {
  const write = !isReadOnlySql(sql, driver);
  return outcome.ok
    ? {
        sql,
        write,
        ok: true,
        rows: write ? outcome.affectedRows : outcome.returnedRows,
        elapsedMs: outcome.elapsedMs,
        at,
      }
    : { sql, write, ok: false, rows: null, elapsedMs: null, at };
}

/** バッチ実行 (複数文) の 1 文ぶんの結果。`status: "skipped"` は実行していないので記録しない (null)。 */
export function batchResultToTxOutcome(r: {
  status: "ok" | "error" | "skipped";
  columns?: unknown[];
  rows?: unknown[][];
  rowsAffected?: number;
  elapsedMs?: number;
  totalRows?: number;
  truncated?: boolean;
}): Parameters<typeof makeTxEntry>[2] | null {
  if (r.status === "skipped") return null;
  if (r.status === "error") return { ok: false };
  return {
    ok: true,
    // 切り詰められていて総数も分からないときは、プレビューの件数を行数と偽らず不明 (null) にする。
    returnedRows: r.totalRows ?? (r.truncated ? null : (r.rows?.length ?? 0)),
    affectedRows: Number(r.rowsAffected ?? 0),
    elapsedMs: r.elapsedMs ?? 0,
  };
}

/**
 * バッチ実行の結果を TX の記録へ流す記録器。TX 中でなければ何も記録しない。トランザクション制御文
 * (BEGIN / COMMIT / ROLLBACK など) が現れたら、その文以降は TX の境界が変わるので記録しない。
 */
export function createBatchTxRecorder(
  inTx: boolean,
  record: (sql: string, outcome: NonNullable<ReturnType<typeof batchResultToTxOutcome>>) => void,
): (r: Parameters<typeof batchResultToTxOutcome>[0] & { sql: string }) => void {
  let ended = false;
  return (r) => {
    if (!inTx || ended) return;
    if (isTxControlStatement(r.sql)) {
      ended = true;
      return;
    }
    const outcome = batchResultToTxOutcome(r);
    if (outcome) record(r.sql, outcome);
  };
}

/** 記録を末尾へ足す。上限を超えたら古いものから捨てる。 */
export function appendTxEntry(entries: readonly TxJournalEntry[], entry: TxJournalEntry): TxJournalEntry[] {
  const next = [...entries, entry];
  return next.length > TX_JOURNAL_MAX_ENTRIES ? next.slice(next.length - TX_JOURNAL_MAX_ENTRIES) : next;
}

export interface TxJournalSummary {
  /** 成功した書き込み文の数 (COMMIT で確定する変更)。 */
  statements: number;
  /** その書き込み文の影響行数の合計。 */
  rows: number;
  /** 失敗した文の数。 */
  failed: number;
}

/** 「N 文 / 合計 M 行」の集計。読み取り文と失敗した文は変更に数えない。 */
export function summarizeTxJournal(entries: readonly TxJournalEntry[]): TxJournalSummary {
  let statements = 0;
  let rows = 0;
  let failed = 0;
  for (const e of entries) {
    if (!e.ok) {
      failed += 1;
    } else if (e.write) {
      statements += 1;
      rows += e.rows ?? 0;
    }
  }
  return { statements, rows, failed };
}

/**
 * COMMIT の確認ダイアログに変更一覧を出すか。書き込み承認 (`requireWriteApproval`) と同じ条件
 * (本番 + `confirm_writes`、読み取り専用を除く)。UI レベルの誤操作防止のみ。
 */
export function shouldReviewBeforeCommit(profile: {
  is_production?: boolean;
  confirm_writes?: boolean;
  read_only?: boolean;
}): boolean {
  return !!profile.is_production && !!profile.confirm_writes && !profile.read_only;
}

/** 一覧表示用に SQL を 1 行へ縮める (空白を畳み、長ければ省略記号)。 */
export function oneLineSql(sql: string, max = 120): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * サーバが放置トランザクションを切断したことを示すエラーか (#2464)。PostgreSQL は
 * `idle_in_transaction_session_timeout` に達すると SQLSTATE 25P03 で
 * "terminating connection due to idle-in-transaction timeout" を返してセッションを閉じる。
 */
export function isIdleInTxTimeoutError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /idle-in-transaction timeout|\b25P03\b/i.test(raw);
}

/**
 * トランザクションで最後に動きがあった時刻 (epoch ms)。文を実行していなければ BEGIN の時刻。
 * 失敗した文もサーバのアイドル計時をリセットするので数えるが、末尾の 1 件が失敗なら除く
 * (接続断で失敗した文が「今動いた」ことになり、推定を外すため)。
 */
export function txLastActivityAt(meta: TxMeta): number {
  const entries = meta.entries;
  const last = entries[entries.length - 1];
  const prev = last && !last.ok ? entries[entries.length - 2] : last;
  return prev ? Math.max(meta.startedAt, prev.at) : meta.startedAt;
}

/** `confirmed` = サーバがそう返した (エラー文)、`likely` = 設定と経過時間からの推定。 */
export type IdleTxDisconnectKind = "confirmed" | "likely";

/**
 * 失敗が「放置トランザクションの自動切断」によるものかを分類する (#2464)。エラー文が
 * idle-in-transaction timeout / SQLSTATE 25P03 を示していれば `confirmed`。FATAL を読む前に接続が
 * 閉じて単なる接続断に見える場合は、接続断 (`connectionLost`) で、接続に自動切断が設定済みで、最後の
 * 動きから設定の分数が過ぎているときだけ `likely` と推定する (トランザクション中でなければ該当しない)。
 */
export function idleTxDisconnectKind(args: {
  error?: string | null;
  inTransaction: boolean;
  connectionLost: boolean;
  timeoutMin: number | null | undefined;
  lastActivityAt: number | null;
  now: number;
}): IdleTxDisconnectKind | null {
  if (isIdleInTxTimeoutError(args.error)) return "confirmed";
  if (
    !args.connectionLost ||
    !args.inTransaction ||
    !args.timeoutMin ||
    args.timeoutMin <= 0 ||
    args.lastActivityAt === null
  ) {
    return null;
  }
  return args.now - args.lastActivityAt >= args.timeoutMin * 60_000 ? "likely" : null;
}
