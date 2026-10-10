// `src-tauri/src/commands/ai.rs` の IPC ラッパー (#690)。`../tauri.ts` の `api` に束ねられる。
import type { AiTaskKind } from "../../ai/aiModels";
import type { AiSettingsSnapshot } from "../../ai/aiSettings";
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { AiConnectionTestResult } from "../tauri";

export const aiCommands = {
  /**
   * Anthropic API キーを keyring へ保存する (#690)。`null` = 変更なし、
   * `""` = 削除、それ以外 = 設定。値は `profiles.json`・ログ・設定ストアに残らない。
   */
  setAiApiKey: (key: string | null) => invoke<void>("set_ai_api_key", { key }),

  /** API キーが保存済みか (値は返らない)。 */
  hasAiApiKey: () => invoke<boolean>("has_ai_api_key"),

  /**
   * 短い非ストリーミング要求で Anthropic API との疎通を確認する (#690)。認証エラー /
   * ネットワークエラー / 成功は戻り値の `status` で区別される。
   */
  testAiConnection: (settings: AiSettingsSnapshot) =>
    invoke<AiConnectionTestResult>("test_ai_connection", { settings }).then((r) =>
      parseResponse(schemas.aiConnectionTestResult, r, "test_ai_connection"),
    ),

  /**
   * AI へのストリーミング要求 (#690)。モデル / エフォートは呼び出し側から渡さず、
   * タスク種別 + 設定スナップショットからバックエンドが解決する。結果は
   * `ai-stream:*` イベント (`listenAiStream`) で届き、`cancelStream` で中断できる。
   */
  runAiRequest: (params: {
    streamId: string;
    task: AiTaskKind;
    system?: string | null;
    prompt: string;
    settings: AiSettingsSnapshot;
    /**
     * 構造化出力 (`output_config.format`)。`{ type: "json_schema", schema }` の形で、
     * 省略すると通常のテキスト応答。
     */
    format?: { type: "json_schema"; schema: Record<string, unknown> } | null;
    /**
     * system のうち繰り返し同じになる固定部分 (スキーマなど、#1473)。`system` より前に置かれ、
     * モデルの最小キャッシュ長以上のときバックエンドが `cache_control` を付けて
     * プロンプトキャッシュに載せる。キャッシュはこれを渡したときだけ (オプトイン)。毎回変わる
     * 値は `system` 側に置く。
     */
    systemCached?: string | null;
    /**
     * 今回の `prompt` より前の会話 (#1471)。user / assistant 交互で user 始まり assistant 終わり。
     * 省略すると従来どおりの単発。組み立ては `ai/conversation.ts`。
     */
    history?: ReadonlyArray<{ role: "user" | "assistant"; content: string }> | null;
  }) =>
    invoke<void>("run_ai_request", {
      streamId: params.streamId,
      task: params.task,
      system: params.system ?? null,
      prompt: params.prompt,
      settings: params.settings,
      format: params.format ?? null,
      systemCached: params.systemCached ?? null,
      history: params.history ?? null,
    }),
};
