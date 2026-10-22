import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderWithProviders, screen } from "./testUtils";
import css from "../App.css?raw";
import { AiStreamProgress } from "../components/AiStreamProgress";

afterEach(cleanup);

describe("AiStreamProgress のキャレット演出 (#1756)", () => {
  it("本文が届いている間は末尾にキャレットが出て、読み上げ対象外 (aria-hidden)", () => {
    renderWithProviders(<AiStreamProgress stream={{ text: "こんにちは" }} />);
    const caret = screen.getByTestId("ai-stream-caret");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
    expect(caret.textContent).toBe("");
    // 本文と同じ aria-live="off" の領域の中、本文の直後にある。
    const preview = screen.getByTestId("ai-stream-preview");
    expect(preview.getAttribute("aria-live")).toBe("off");
    expect(preview.lastElementChild).toBe(caret);
    expect(preview.textContent).toBe("こんにちは");
  });

  it("応答開始前・再試行待ち・完了 (アンマウント) ではキャレットが出ない", () => {
    const { rerender, unmount } = renderWithProviders(<AiStreamProgress stream={{ text: "" }} />);
    expect(screen.queryByTestId("ai-stream-caret")).toBeNull();
    rerender(
      <AiStreamProgress stream={{ text: "abc", retrying: { attempt: 1, maxAttempts: 3, delayMs: 2000 } }} />,
    );
    expect(screen.queryByTestId("ai-stream-caret")).toBeNull();
    rerender(<AiStreamProgress stream={{ text: "abc" }} />);
    expect(screen.getByTestId("ai-stream-caret")).toBeTruthy();
    unmount();
    expect(screen.queryByTestId("ai-stream-caret")).toBeNull();
  });

  it("本文を見せない設定 (previewText=false) ではキャレットも出さない", () => {
    renderWithProviders(<AiStreamProgress stream={{ text: "abc" }} previewText={false} />);
    expect(screen.queryByTestId("ai-stream-caret")).toBeNull();
  });

  it("受信が増えても同じキャレット要素のまま (点滅は CSS のみで再マウントしない)", () => {
    const { rerender } = renderWithProviders(<AiStreamProgress stream={{ text: "a" }} />);
    const first = screen.getByTestId("ai-stream-caret");
    rerender(<AiStreamProgress stream={{ text: "ab" }} />);
    expect(screen.getByTestId("ai-stream-caret")).toBe(first);
  });
});

describe("キャレット点滅の CSS ガード (#1756)", () => {
  it("点滅は CSS アニメで、fill-mode を持たない (reduced-motion の 1 回再生後は点灯のまま静止)", () => {
    expect(css).toMatch(/\.ai-stream-caret\s*\{[^}]*animation:\s*stream-caret-blink/);
    const kf = css.match(/@keyframes stream-caret-blink\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(kf).toMatch(/opacity:\s*0/);
    // reduced-motion の全体ブロックが animation を 1 回・極短に縮めること (静止の根拠)。
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{[^}]*animation-duration:\s*0\.01ms !important;\s*animation-iteration-count:\s*1 !important/,
    );
  });

  it("hc-* テーマでは点滅しない", () => {
    for (const theme of ["hc-light", "hc-dark"]) {
      expect(css).toContain(`:root[data-theme="${theme}"] .ai-stream-caret`);
    }
    expect(css).toMatch(/hc-dark"\] \.ai-stream-caret\s*\{\s*animation:\s*none/);
  });
});
