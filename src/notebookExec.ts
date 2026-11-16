/**
 * SQL ノートブック (#2380) のセル実行。**新しい実行 IPC は作らず**、エディタと同じストリーミング実行
 * (`api.runQueryStream`) を使う。履歴の記録・DML フライトレコーダ (`capture`)・バックエンドの read_only
 * ガード・自動 LIMIT・タイムアウトはすべてバックエンド側 (またはこの呼び出しのパラメータ) が担うので、
 * ここは「結果を Promise にまとめて返す」だけ。
 *
 * 結果は先頭 `rowCap` 行だけ保持し、残りは件数だけ数える (ノートブックはスナップショットしか持たない)。
 * 確認ダイアログ (危険クエリ / 書き込み承認) は呼び出し側 (`App.tsx` の `runGuardedDdl`) が実行前に通す。
 */
import { api, listenQueryStream } from "./api/tauri";
import type { CellValue, Column, ServerMessage } from "./api/tauri";

export interface NotebookRunParams {
  sessionId: string;
  database: string | null;
  sql: string;
  /** 保持する先頭行数 (スナップショットの保存行数)。 */
  rowCap: number;
  initialBatch: number;
  chunkSize: number;
  autoLimit: number | null;
  queryTimeoutSecs: number | null;
  capture: boolean;
  captureRowCap: number | null;
  captureRetentionDays: number | null;
  /** 実行を始めるとき (キャンセル用に streamId を知らせる)。 */
  onStart?: (streamId: string) => void;
}

export interface NotebookRunOutput {
  columns: Column[];
  /** 先頭 `rowCap` 行。 */
  rows: CellValue[][];
  /** サーバから受け取った総行数。 */
  totalRows: number;
  rowsAffected: number;
  hasColumns: boolean;
  elapsedMs: number;
  serverMessages: ServerMessage[] | undefined;
  readOnly: boolean;
  schemaMayChange: boolean;
  /** 自動 LIMIT が掛かった行数 (掛からなければ null)。 */
  appliedAutoLimit: number | null;
}

/** セル実行の要求。 */
export interface NotebookRunRequest {
  /** 保持する先頭行数 (スナップショットの保存行数)。 */
  rowCap: number;
  /** 実行先 DB (PostgreSQL ではスキーマ)。null = 接続の既定。 */
  database: string | null;
  /** 実行中のストリーム ID を受け取る (中止用)。 */
  onStart: (streamId: string) => void;
  /** 中止が押されたか。文と文の間で見る。 */
  isCancelled: () => boolean;
}

/** 実行の失敗。`connectionLost` は接続が使えなくなったことを呼び出し側へ伝える。 */
export class NotebookRunError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    readonly connectionLost: boolean,
    readonly cancelled: boolean,
  ) {
    super(message);
    this.name = "NotebookRunError";
  }
}

function newStreamId(): string {
  return `nb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 1 文をストリーミング実行して結果を集める。失敗・キャンセルは `NotebookRunError` で reject。 */
export async function runStatementCollect(p: NotebookRunParams): Promise<NotebookRunOutput> {
  const streamId = newStreamId();
  let columns: Column[] = [];
  const rows: CellValue[][] = [];
  let received = 0;
  let settle: (r: NotebookRunOutput | NotebookRunError) => void = () => {};
  const done = new Promise<NotebookRunOutput | NotebookRunError>((resolve) => {
    settle = resolve;
  });
  const unlisten = await listenQueryStream(streamId, {
    onColumns: (m) => {
      columns = m.columns;
    },
    onRows: (m) => {
      received += m.rows.length;
      const room = p.rowCap - rows.length;
      if (room > 0) for (const r of m.rows.slice(0, room)) rows.push(r);
    },
    onDone: (m) =>
      settle({
        columns,
        rows,
        totalRows: m.hasColumns ? Math.max(m.totalRows, received) : 0,
        rowsAffected: m.rowsAffected,
        hasColumns: m.hasColumns,
        elapsedMs: m.elapsedMs,
        serverMessages: m.serverMessages,
        readOnly: m.readOnly,
        schemaMayChange: m.schemaMayChange,
        appliedAutoLimit: m.appliedAutoLimit ?? null,
      }),
    onError: (m) =>
      settle(new NotebookRunError(m.error ?? "Unknown error", m.timedOut, m.connectionLost, false)),
    onCancelled: () => settle(new NotebookRunError("cancelled", false, false, true)),
  });
  p.onStart?.(streamId);
  try {
    await api.runQueryStream({
      sessionId: p.sessionId,
      streamId,
      sql: p.sql,
      database: p.database,
      initialBatch: p.initialBatch,
      chunkSize: p.chunkSize,
      autoLimit: p.autoLimit,
      queryTimeoutSecs: p.queryTimeoutSecs,
      autoRefresh: false,
      forceReadOnly: false,
      capture: p.capture,
      captureRowCap: p.captureRowCap,
      captureRetentionDays: p.captureRetentionDays,
      retainResult: false,
    });
  } catch (e) {
    settle(new NotebookRunError(String(e), false, false, false));
  }
  try {
    const result = await done;
    if (result instanceof NotebookRunError) throw result;
    return result;
  } finally {
    unlisten();
  }
}

/** 実行中のストリームを止める。 */
export function cancelNotebookStream(streamId: string): void {
  void api.cancelStream(streamId).catch(() => {});
}

/**
 * セルの実行先 DB を決める純関数。ノートブック自身の指定を優先し、空のときだけ接続の既定へ寄せる。
 * PostgreSQL の `database` 引数はスキーマなので、プロファイルの DB 名へは寄せない (null のまま)。
 * MySQL は空だと USE が走らず、別タブの USE を引きずった接続で実行されうるのでプロファイルの DB を使う。
 */
export function resolveNotebookDatabase(
  docDatabase: string | null,
  driver: string | null | undefined,
  profileDatabase: string | null | undefined,
): string | null {
  return docDatabase ?? (driver === "postgres" ? null : (profileDatabase ?? null));
}

/** `runNotebookStatements` が外へ頼る操作。App が実行ゲート・実行・記録を結びつける。 */
export interface NotebookRunIo {
  /** 危険クエリ確認などの実行ゲート。取りやめなら false。 */
  gate: (sql: string) => Promise<boolean>;
  /** 明示トランザクション中か (中なら同じ接続で `runInTransaction`)。 */
  isTransaction: () => boolean;
  runInTransaction: (stmt: string) => Promise<NotebookRunOutput>;
  runStream: (stmt: string, onStart: (streamId: string) => void) => Promise<NotebookRunOutput>;
  /** ゲート通過後、最初の文を流す直前に 1 回呼ぶ (実行中表示用)。 */
  onBegin: () => void;
  /** `onBegin` の後、完了以外 (失敗・中止) で抜けるとき。失敗は `onStatementError` も呼ばれる。 */
  onEnd: (reason: "error" | "cancelled") => void;
  onStatementDone: (stmt: string, out: NotebookRunOutput) => void;
  onStatementError: (stmt: string, err: NotebookRunError, startedAt: number) => void;
}

/**
 * セルの文を 1 文ずつ順に流し、結果セットを返した最後の文 (無ければ最後の文) の結果を返す。
 * ゲートを取りやめたら null。`isCancelled` は文と文の間でも見る (中止ボタン)。
 */
export async function runNotebookStatements(
  sql: string,
  statements: readonly string[],
  opts: { onStart: (streamId: string) => void; isCancelled: () => boolean },
  io: NotebookRunIo,
): Promise<NotebookRunOutput | null> {
  if (!(await io.gate(sql))) return null;
  let last: NotebookRunOutput | null = null;
  let elapsedTotal = 0;
  io.onBegin();
  for (const stmt of statements) {
    if (opts.isCancelled()) {
      io.onEnd("cancelled");
      throw new NotebookRunError("cancelled", false, false, true);
    }
    const startedAt = Date.now();
    try {
      const out = io.isTransaction()
        ? await io.runInTransaction(stmt)
        : await io.runStream(stmt, opts.onStart);
      elapsedTotal += out.elapsedMs;
      io.onStatementDone(stmt, out);
      if (out.hasColumns || !last?.hasColumns) last = out;
    } catch (e) {
      const err = e instanceof NotebookRunError ? e : new NotebookRunError(String(e), false, false, false);
      if (!err.cancelled) io.onStatementError(stmt, err, startedAt);
      io.onEnd(err.cancelled ? "cancelled" : "error");
      throw err;
    }
  }
  return last ? { ...last, elapsedMs: elapsedTotal } : null;
}
