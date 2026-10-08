// `src-tauri/src/commands/search.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import { whereUsedChannels, dataSearchChannels } from "../streamChannels";
import type {
  ObjectSearchScope,
  ObjectSearchHit,
  WhereUsedTarget,
  DataSearchRequest,
} from "../tauri";

export const searchCommands = {
  /**
   * スキーマ横断のオブジェクト検索 (#1261)。テーブル名・カラム名を大小無視の部分一致で
   * スコアリングし、上位 `limit` 件だけを返す。全 DB 分の索引は Rust 側の Schema Cache に
   * 保持され、`query` が空なら結果は空で索引の事前構築 (ウォームアップ) だけを行う。
   */
  searchSchemaObjects: (params: {
    sessionId: string;
    scope: ObjectSearchScope;
    query: string;
    limit: number;
  }) =>
    invoke<ObjectSearchHit[]>("search_schema_objects", {
      sessionId: params.sessionId,
      scope: params.scope,
      query: params.query,
      limit: params.limit,
    }).then((r) => parseResponse(schemas.objectSearchHitArray, r, "search_schema_objects")),
  /**
   * Where-used (#1027 / #1261): ビュー・ルーチン・トリガーの定義本文とスニペットを Rust 側で
   * 走査し、`target` への参照位置だけを {@link listenWhereUsedStream} の Channel で返す。
   * 進捗とキャンセル (`cancelStream(streamId)`、途中結果つき) に対応する。
   */
  findWhereUsed: (params: {
    sessionId: string;
    streamId: string;
    database: string;
    target: WhereUsedTarget;
  }) => {
    const channel = whereUsedChannels.get(params.streamId);
    if (!channel) {
      throw new Error(
        `findWhereUsed: listenWhereUsedStream(streamId) must be awaited before invoking (streamId="${params.streamId}")`,
      );
    }
    return invoke<void>("find_where_used", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database,
      target: params.target,
      onEvent: channel,
    });
  },
  /**
   * DB 全体からの値検索 (#748 / #1261)。走査 SQL の生成と並列実行は Rust 側で行い、進捗と
   * テーブルごとの結果を {@link listenDataSearchStream} の Channel へ逐次送る。読み取り専用
   * ガードを通る SELECT だけを発行し、`cancelStream(streamId)` で中断できる。
   */
  dataSearchStream: (params: {
    sessionId: string;
    streamId: string;
    request: DataSearchRequest;
  }) => {
    const channel = dataSearchChannels.get(params.streamId);
    if (!channel) {
      throw new Error(
        `dataSearchStream: listenDataSearchStream(streamId) must be awaited before invoking (streamId="${params.streamId}")`,
      );
    }
    return invoke<void>("data_search_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      request: params.request,
      onEvent: channel,
    });
  },
};
