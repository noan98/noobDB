import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { AiUsageNote } from "../components/AiUsageNote";
import { t } from "../i18n";
import type { AiDoneEvent } from "../api/tauri";

const ev = (over: Partial<AiDoneEvent> = {}): AiDoneEvent => ({
  streamId: "s",
  model: "claude-opus-5-5",
  requestedModel: "claude-opus-5-5",
  fallbackUsed: false,
  stopReason: "end_turn",
  usage: { inputTokens: 3200, outputTokens: 800, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  ...over,
});

describe("AiUsageNote (#1474)", () => {
  it("event が無ければ何も描かない", () => {
    renderWithProviders(<AiUsageNote event={null} />);
    expect(screen.queryByTestId("ai-usage-note")).toBeNull();
  });

  it("モデルと入出力トークンを出し、キャッシュ 0 のときは併記しない", () => {
    renderWithProviders(<AiUsageNote event={ev()} />);
    expect(screen.getByTestId("ai-usage-note").textContent).toBe(
      t("aiUsageLine", { model: "Claude Opus 5.5", input: "3.2k", output: "800" }),
    );
  });

  it("キャッシュ書き込み / 読み取りとフォールバックを併記する", () => {
    renderWithProviders(
      <AiUsageNote
        event={ev({
          model: "claude-sonnet-5-5",
          fallbackUsed: true,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2000, cacheCreationInputTokens: 500 },
        })}
      />,
    );
    const text = screen.getByTestId("ai-usage-note").textContent ?? "";
    expect(text).toContain(t("aiUsageCacheWrite", { count: "500" }));
    expect(text).toContain(t("aiUsageCacheRead", { count: "2k" }));
    expect(screen.getByTestId("ai-usage-fallback").textContent).toBe(
      t("aiUsageFallback", { from: "Claude Opus 5.5", to: "Claude Sonnet 5.5" }),
    );
  });
});
