// 明示トランザクションの経過時間・実行した文の記録・放置警告の純ロジック (#2447)。
// 判定・整形だけを持ち、状態 (接続ごとの保持) と表示は App / TransactionStatus が担う。
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
  entries: readonly TxJournalEntry[];
}

/** 一覧に残す最大件数。超えたら古いものから捨てる (長時間のトランザクションでメモリを増やさない)。 */
export const TX_JOURNAL_MAX_ENTRIES = 200;

/** 放置警告のしきい値 (ms)。本番は短め。設定には出さず定数で持つ。 */
export const TX_WARN_AFTER_MS = { production: 3 * 60_000, other: 10 * 60_000 } as const;

export function txWarnThresholdMs(isProduction: boolean): number {
  return isProduction ? TX_WARN_AFTER_MS.production : TX_WARN_AFTER_MS.other;
}

/** 経過時間が警告しきい値に達したか (しきい値ちょうどで警告)。 */
export function isTxStale(elapsedMs: number, isProduction: boolean): boolean {
  return elapsedMs >= txWarnThresholdMs(isProduction);
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
  outcome: { ok: true; returnedRows: number; affectedRows: number; elapsedMs: number } | { ok: false },
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
