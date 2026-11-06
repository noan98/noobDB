import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import { renderInBrowser } from "./render";
import { TimelapseScrubber } from "../../components/TimelapseScrubber";
import type { TimelapseGenerationMeta } from "../../api/tauri";

// スクラバーのトラックを実クリックしたあと、矢印キーが効く (フォーカスが range に移る) ことを
// 実ブラウザで固定する (#2095)。jsdom の toHaveFocus は mousedown の既定動作を再現しない。

const gens: TimelapseGenerationMeta[] = [
  { id: 4, captured_at: "2026-01-01T03:00:00Z", row_count: 4, truncated: false, bytes: 0 },
  { id: 3, captured_at: "2026-01-01T02:00:00Z", row_count: 3, truncated: false, bytes: 0 },
  { id: 2, captured_at: "2026-01-01T01:00:00Z", row_count: 2, truncated: true, bytes: 0 },
  { id: 1, captured_at: "2026-01-01T00:00:00Z", row_count: 1, truncated: false, bytes: 0 },
];

function Harness() {
  const [step, setStep] = useState(3);
  return (
    <div style={{ width: 400 }}>
      <TimelapseScrubber generations={gens} step={step} maxStep={3} onSeek={setStep} />
    </div>
  );
}

describe("TimelapseScrubber のフォーカス (#2095, 実ブラウザ)", () => {
  it("トラックを実クリックしたあと、矢印キーで値が進む", async () => {
    await renderInBrowser(<Harness />);
    const track = document.querySelector("[data-testid='timelapse-track']") as HTMLElement;
    const slider = document.querySelector("input[type='range']") as HTMLInputElement;
    await userEvent.click(track, { position: { x: 4, y: 10 } });
    await expect.poll(() => slider.value).toBe("1");
    expect(document.activeElement).toBe(slider);
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => slider.value).toBe("2");
  });
});
