// `src-tauri/src/commands/inspector.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { QueryStatsSupport, LiveQuery, StatementDeltaRow } from "../tauri";

export const inspectorCommands = {
  /** ライブクエリ・インスペクタ (#746) の前提可否プローブ。理由コード付きで縮退情報を返す。 */
  queryStatsSupport: (sessionId: string) =>
    invoke<QueryStatsSupport>("query_stats_support", { sessionId }).then((r) =>
      parseResponse(schemas.queryStatsSupport, r, "query_stats_support"),
    ),
  /** ライブテール 1 サンプル (実行中/直近ステートメント) を取得する。読み取り SELECT のみ。 */
  sampleLiveQueries: (sessionId: string) =>
    invoke<LiveQuery[]>("sample_live_queries", { sessionId }).then((r) =>
      parseResponse(schemas.liveQueryArray, r, "sample_live_queries"),
    ),
  /** ステートメント統計の記録を開始する (#1259)。現在の digest 累積スナップショットを
   *  Rust 側のセッション状態に baseline として保持し、本文の送信済み集合も空にする。
   *  サーバ側カウンタはリセットしない (権限不要)。読み取り SELECT のみ。 */
  startStatementRecording: (sessionId: string) =>
    invoke<void>("start_statement_recording", { sessionId }),
  /**
   * 記録開始 (baseline) からの digest 差分 (calls > 0 の行、総時間降順) を取得する (#1259)。
   * 差分の引き算と N+1 目安 (直近ポーリング間隔の実行レート) は Rust 側で行う。
   * `refresh: true` はサーバの統計を取り直し、`false` は前回取得分を `cumulative`
   * (baseline 無視 = サーバの累積値そのまま) の切替で再計算するだけ。SQL 本文
   * (`fingerprint`) は digest の初出時のみ載るので、呼び出し側は digest キー
   * (`digest` + `database`) でキャッシュする。
   */
  sampleStatementDelta: (
    sessionId: string,
    opts: {
      cumulative: boolean;
      refresh: boolean;
      nPlusOneMinCount: number;
      nPlusOneWindowMs: number;
    },
  ) =>
    invoke<StatementDeltaRow[]>("sample_statement_delta", {
      sessionId,
      cumulative: opts.cumulative,
      refresh: opts.refresh,
      nPlusOneMinCount: opts.nPlusOneMinCount,
      nPlusOneWindowMs: opts.nPlusOneWindowMs,
    }).then((r) => parseResponse(schemas.statementDeltaRowArray, r, "sample_statement_delta")),
};
