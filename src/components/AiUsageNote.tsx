import { chakra } from "@chakra-ui/react";
import type { AiDoneEvent } from "../api/tauri";
import { summarizeUsage } from "../ai/aiUsage";
import { useT } from "../i18n";

/**
 * AI の回答の下に出す小さな使用量表示 (#1474): 応答モデル・入出力トークン数・
 * キャッシュ読み取り分、フォールバックしたときはその旨。`useAiStream` の `done` を渡すだけで使える。
 * `event` が無い (未完了 / 失敗) ときは何も描かない。
 */
export function AiUsageNote({ event }: { event: AiDoneEvent | null | undefined }) {
  const t = useT();
  if (!event) return null;
  const s = summarizeUsage(event);
  const line = t("aiUsageLine", { model: s.model, input: s.input, output: s.output });
  return (
    <chakra.div color="app.textMuted" textStyle="caption" data-testid="ai-usage-note">
      {line}
      {s.cacheRead !== null && ` ${t("aiUsageCacheRead", { count: s.cacheRead })}`}
      {s.fallbackFrom !== null && (
        <chakra.div data-testid="ai-usage-fallback">
          {t("aiUsageFallback", { from: s.fallbackFrom, to: s.model })}
        </chakra.div>
      )}
    </chakra.div>
  );
}
