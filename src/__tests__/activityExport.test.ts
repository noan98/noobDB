import { describe, expect, it } from "vitest";
import { activityToMarkdown, activityToText, formatExportTimestamp } from "../activityExport";
import type { MergedLogEntry } from "../activityLog";

const labels = {
  time: "Time",
  severity: "Severity",
  message: "Message",
  severities: { info: "Info", success: "OK", warning: "Warn", error: "Error" },
};
const JST = 540;
// 2026-10-12 03:00:00 UTC = 12:00:00 JST
const base = Date.UTC(2026, 9, 12, 3, 0, 0);
const e = (
  i: number,
  offsetSec: number,
  severity: MergedLogEntry["severity"],
  message: string,
  repeat = 1,
): MergedLogEntry => ({ id: i, key: `a${i}`, severity, message, at: base + offsetSec * 1000, repeat });

// 表示順 (新しい順)
const entries = [
  e(3, 20, "error", "Failed | bad\nsecond line"),
  e(2, 10, "success", "Imported", 3),
  e(1, 0, "info", "Connected"),
];

describe("formatExportTimestamp (#1539)", () => {
  it("オフセット付きで整形する", () => {
    expect(formatExportTimestamp(base, JST)).toBe("2026-10-12 12:00:00 +09:00");
    expect(formatExportTimestamp(base, 0)).toBe("2026-10-12 03:00:00 +00:00");
    expect(formatExportTimestamp(base, -330)).toBe("2026-10-11 21:30:00 -05:30");
  });
});

describe("activityToMarkdown / activityToText (#1539)", () => {
  it("Markdown は古い順の表で、| と改行をエスケープし、畳んだ回数を添える", () => {
    const md = activityToMarkdown(entries, labels, JST).split("\n");
    expect(md[0]).toBe("| Time | Severity | Message |");
    expect(md[2]).toBe("| 2026-10-12 12:00:00 +09:00 | Info | Connected |");
    expect(md[3]).toBe("| 2026-10-12 12:00:10 +09:00 | OK | Imported (×3) |");
    expect(md[4]).toBe("| 2026-10-12 12:00:20 +09:00 | Error | Failed \\| bad<br>second line |");
  });
  it("テキストは複数行の文言を字下げする", () => {
    expect(activityToText(entries, labels, JST)).toBe(
      [
        "[2026-10-12 12:00:00 +09:00] [Info] Connected",
        "[2026-10-12 12:00:10 +09:00] [OK] Imported (×3)",
        "[2026-10-12 12:00:20 +09:00] [Error] Failed | bad",
        "    second line",
        "",
      ].join("\n"),
    );
  });
  it("空なら Markdown は見出しのみ、テキストは空文字", () => {
    expect(activityToText([], labels, JST)).toBe("");
    expect(activityToMarkdown([], labels, JST).split("\n")).toHaveLength(3);
  });
});
