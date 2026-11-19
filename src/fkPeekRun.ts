/**
 * FK 参照先カード (#2435) のホバー取得を流す経路 (#2444)。
 *
 * 以前は `run_query` (タイムアウトもサーバ側の中止も無い) を直接呼んでいたため、索引の無い列を指す
 * 論理リレーション (#2356) のセルを続けてなぞると、全表走査が閉じても止まらずプールを塞いだ。
 * ここでは**新しい IPC を作らず**、エディタと同じストリーミング実行 (`run_query_stream`、#2023 の
 * サーバ側タイムアウト / サーバ側停止つき) を使う。
 *
 * - 短いタイムアウト ({@link FK_PEEK_TIMEOUT_SECS}) を掛ける。
 * - 呼び出し側の `signal` が abort されたら (カードを閉じた・別セルへ移った) `cancel_stream` で
 *   サーバ側の文を止める。
 * - 同時に走るのは常に 1 本。新しい取得が来たら前の取得を中止し、その停止要求を出してから走り出す。
 * - `autoRefresh: true` を選んだ理由: 履歴をスキップでき、サーバ側でも READ ONLY で実行される
 *   (#2243。書き込む関数を `SELECT f()` で呼ぶ抜け道を塞ぐ)。参照先カードは SELECT しか流さない。
 */
import { api, listenQueryStream } from "./api/tauri";
import type { CellValue, Column, QueryResult } from "./api/tauri";

/** ホバー取得に掛けるタイムアウト (秒)。サーバ側にも猶予つきで設定される。 */
export const FK_PEEK_TIMEOUT_SECS = 5;

interface InFlight {
  /** 取得を中止する (クライアント側を即座に reject し、サーバ側の停止を要求する)。何度呼んでも同じ Promise。 */
  abort: () => Promise<void>;
}

/** 取得が中止された (カードを閉じた・別の取得に切り替わった)。カードは専用の文言で表示する。 */
export class PeekCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "PeekCancelledError";
  }
}

let current: InFlight | null = null;
let seq = 0;

function abortError(): Error {
  return new PeekCancelledError();
}

export interface RunPeekParams {
  sessionId: string;
  database: string | null;
  sql: string;
  /** abort されると取得を中止する (カードを閉じた・別セルへ移った)。 */
  signal?: AbortSignal;
}

/** ホバー取得を 1 本に絞って流し、結果を `QueryResult` にまとめて返す。失敗・中止は reject。 */
export async function runPeekQuery(p: RunPeekParams): Promise<QueryResult> {
  // 前の取得があれば中止し、サーバ側の停止要求を出し終えてから自分を始める (同時 1 本)。
  // 3 本以上が重なっても追跡外の取得が並走しないよう、枠が空くまで確かめ直し、
  // 空いたら await を挟まずに同期的に枠を取る。
  while (current) await current.abort();
  if (p.signal?.aborted) throw abortError();

  seq += 1;
  const streamId = `fkpeek_${Date.now().toString(36)}_${seq}`;
  let columns: Column[] = [];
  const rows: CellValue[][] = [];
  let aborted = false;
  let settled = false;
  let settle: (r: QueryResult | Error) => void = () => {};
  const done = new Promise<QueryResult | Error>((resolve) => {
    settle = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
  });
  const cancelServer = () =>
    api.cancelStream(streamId).then(
      () => {},
      () => {},
    );
  let abortP: Promise<void> | null = null;
  const entry: InFlight = {
    abort: () => {
      abortP ??= (async () => {
        aborted = true;
        settle(abortError());
        await cancelServer();
        // 停止要求が済んだら枠を空ける (後続の待ち手が進める)。
        if (current === entry) current = null;
      })();
      return abortP;
    },
  };
  current = entry;
  const onAbort = () => void entry.abort();
  p.signal?.addEventListener("abort", onAbort, { once: true });

  const unlisten = await listenQueryStream(streamId, {
    onColumns: (m) => {
      columns = m.columns;
    },
    onRows: (m) => {
      for (const r of m.rows) rows.push(r);
    },
    onDone: (m) =>
      settle({
        columns,
        rows,
        rows_affected: m.rowsAffected,
        elapsed_ms: m.elapsedMs,
        server_messages: m.serverMessages,
      }),
    onError: (m) => settle(new Error(m.error ?? "Unknown error")),
    onCancelled: () => settle(abortError()),
  });
  try {
    // listen を待つ間に中止された場合は、そもそも実行しない。
    if (!aborted) {
      try {
        await api.runQueryStream({
          sessionId: p.sessionId,
          streamId,
          sql: p.sql,
          database: p.database,
          initialBatch: 10,
          chunkSize: 10,
          autoLimit: null,
          queryTimeoutSecs: FK_PEEK_TIMEOUT_SECS,
          // 読み取り専用ガード + 履歴に残さない。
          autoRefresh: true,
          forceReadOnly: false,
          capture: false,
          retainResult: false,
        });
      } catch (e) {
        settle(e instanceof Error ? e : new Error(String(e)));
      }
      // invoke の最中に中止された場合、サーバ側の登録が間に合わず cancel が空振りしうるので撃ち直す。
      if (aborted) await cancelServer();
    }
    const result = await done;
    if (result instanceof Error) throw result;
    return result;
  } finally {
    p.signal?.removeEventListener("abort", onAbort);
    unlisten();
    // 中止の最中なら、枠は中止処理 (cancelStream の完了後) が空ける。ここで先に空けると、
    // 中止が終わる前に次の取得が始まり single-flight が崩れる。
    if (current === entry && abortP === null) current = null;
  }
}
