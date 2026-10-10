import { chakra } from "@chakra-ui/react";
import type { AiDoneEvent } from "../api/tauri";
import { summarizeUsage } from "../ai/aiUsage";
import { useT } from "../i18n";

/**
 * キャッシュの書き込み / 読み取りトークンの併記部分。0 のもの (`null`) は出さない。
 * 回答ごとの表示・月のモデル別行・合計行で同じ規則を使う。何も無ければ空文字。
 */
export function cacheUsageSuffix(
  t: ReturnType<typeof useT>,
  write: string | null,
  read: string | null,
): string {
  const parts: string[] = [];
  if (write !== null) parts.push(t("aiUsageCacheWrite", { count: write }));
  if (read !== null) parts.push(t("aiUsageCacheRead", { count: read }));
  return parts.map((p) => `${t("aiUsageSep")}${p}`).join("");
}

/**
 * AI の回答の下に出す小さな使用量表示 (#1474): 応答モデル・入出力トークン数・
 * キャッシュ書き込み / 読み取り分、フォールバックしたときはその旨。`useAiStream` の `done` を渡すだけで使える。
 * `event` が無い (未完了 / 失敗) ときは何も描かない。
 */
export function AiUsageNote({ event }: { event: AiDoneEvent | null | undefined }) {
  const t = useT();
  if (!event) return null;
  const s = summarizeUsage(event);
  return (
    <chakra.div color="app.textMuted" textStyle="caption" data-testid="ai-usage-note">
      {t("aiUsageLine", { model: s.model, input: s.input, output: s.output })}
      {cacheUsageSuffix(t, s.cacheWrite, s.cacheRead)}
      {s.fallbackFrom !== null && (
        <chakra.div data-testid="ai-usage-fallback">
          {t("aiUsageFallback", { from: s.fallbackFrom, to: s.model })}
        </chakra.div>
      )}
    </chakra.div>
  );
}
