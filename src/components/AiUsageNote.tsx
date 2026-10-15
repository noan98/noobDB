import { useEffect, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type AiDoneEvent } from "../api/tauri";
import { summarizeUsage } from "../ai/aiUsage";
import { budgetStatus, formatUsd, type BudgetStatus } from "../ai/aiUsageCost";
import { useT } from "../i18n";
import { useSettings } from "../settings";

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
  const budget = useSettings().ai.monthlyBudgetUsd;
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  // 月次予算 (#1620) が設定されているときだけ、回答のたびに台帳を読み直して「予算の 8 割超」を知らせる
  // (台帳はこの完了の前に更新済み)。予算なしなら何も読まない。
  useEffect(() => {
    if (!event || budget === null) {
      setStatus(null);
      return;
    }
    let alive = true;
    api
      .getAiUsageHistory()
      .then((records) => {
        if (alive) setStatus(budgetStatus(records, budget));
      })
      .catch(() => {
        /* 警告は付加情報。読めなければ出さない */
      });
    return () => {
      alive = false;
    };
  }, [event, budget]);
  if (!event) return null;
  const s = summarizeUsage(event);
  return (
    <chakra.div color="app.textMuted" textStyle="caption" data-testid="ai-usage-note">
      {t("aiUsageLine", { model: s.model, input: s.input, output: s.output })}
      {cacheUsageSuffix(t, s.cacheWrite, s.cacheRead)}
      {status && (status.state === "warning" || status.state === "exceeded") && (
        <chakra.div color="app.textWarning" data-testid="ai-usage-budget-warning">
          {t(status.state === "exceeded" ? "aiBudgetExceeded" : "aiBudgetWarning", {
            spent: formatUsd(status.spent),
            budget: formatUsd(status.budget ?? 0),
            percent: Math.floor(status.ratio * 100),
          })}
        </chakra.div>
      )}
      {s.fallbackFrom !== null && (
        <chakra.div data-testid="ai-usage-fallback">
          {t("aiUsageFallback", { from: s.fallbackFrom, to: s.model })}
        </chakra.div>
      )}
    </chakra.div>
  );
}
