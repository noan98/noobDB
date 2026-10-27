import { describe, expect, it } from "vitest";
import {
  displayVersion,
  downloadProgressPercent,
  formatDownloadProgress,
  parseReleaseNotes,
  truncateReleaseNotes,
} from "../updaterFormat";

describe("downloadProgressPercent (#705)", () => {
  it("computes a rounded percentage", () => {
    expect(downloadProgressPercent(50, 100)).toBe(50);
    expect(downloadProgressPercent(1, 3)).toBe(33);
  });

  it("returns null when the total size is unknown", () => {
    expect(downloadProgressPercent(10, undefined)).toBeNull();
    expect(downloadProgressPercent(10, 0)).toBeNull();
    expect(downloadProgressPercent(10, -5)).toBeNull();
    expect(downloadProgressPercent(10, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("clamps to the 0..100 range", () => {
    expect(downloadProgressPercent(-5, 100)).toBe(0);
    expect(downloadProgressPercent(0, 100)).toBe(0);
    expect(downloadProgressPercent(200, 100)).toBe(100);
  });

  it("treats a non-finite downloaded count as zero progress", () => {
    expect(downloadProgressPercent(Number.NaN, 100)).toBe(0);
    expect(downloadProgressPercent(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});

describe("truncateReleaseNotes (#705)", () => {
  it("returns an empty string for missing notes", () => {
    expect(truncateReleaseNotes(undefined)).toBe("");
    expect(truncateReleaseNotes("")).toBe("");
    expect(truncateReleaseNotes("   ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(truncateReleaseNotes("  hello  ")).toBe("hello");
  });

  it("passes short notes through unchanged", () => {
    expect(truncateReleaseNotes("fixed a bug", 600)).toBe("fixed a bug");
  });

  it("does not split a surrogate pair when truncating (#1534)", () => {
    const out = truncateReleaseNotes("ab😀cd", 3);
    expect(out).toBe("ab😀…");
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    // コードポイント数が上限以内なら、コード単位では超えていても切らない。
    expect(truncateReleaseNotes("😀😀😀", 3)).toBe("😀😀😀");
  });

  it("truncates long notes with an ellipsis", () => {
    const body = "x".repeat(1000);
    const out = truncateReleaseNotes(body, 600);
    expect(out).toHaveLength(601); // 600 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("displayVersion (#705)", () => {
  it("strips a leading v and trims", () => {
    expect(displayVersion("v1.2.3")).toBe("1.2.3");
    expect(displayVersion(" V0.1.0 ")).toBe("0.1.0");
    expect(displayVersion("2.0.0")).toBe("2.0.0");
  });

  it("falls back to a placeholder for empty/missing values", () => {
    expect(displayVersion(null)).toBe("?");
    expect(displayVersion(undefined)).toBe("?");
    expect(displayVersion("")).toBe("?");
    expect(displayVersion("   ")).toBe("?");
  });
});

describe("formatDownloadProgress (#1617)", () => {
  const t = ((k: string, v?: Record<string, string | number>) => `${k}:${JSON.stringify(v)}`) as never;
  it("合計サイズが分かるときは割合とサイズを文言にする", () => {
    const out = formatDownloadProgress(
      { percent: 42, downloadedBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 },
      t,
    );
    expect(out).toContain("updateDownloadingProgress");
    expect(out).toContain('"percent":42');
    expect(out).toContain("1.0 MB");
    expect(out).toContain("2.0 MB");
  });
  it("合計サイズ不明 (percent が null) のときは null (不定表示のまま)", () => {
    expect(
      formatDownloadProgress({ percent: null, downloadedBytes: 10, totalBytes: undefined }, t),
    ).toBeNull();
  });
});

describe("parseReleaseNotes (#1864)", () => {
  it("見出し・引用・箇条書き・段落に分解し、行内記法を落とす", () => {
    const body =
      "## 新機能\r\n> **要点** です\r\n- `Kbd` を [改善](http://x)\r\n1. 番号付き\r\n\r\n本文1\r\n本文2";
    expect(parseReleaseNotes(body)).toEqual([
      { kind: "heading", text: "新機能" },
      { kind: "highlight", text: "要点 です" },
      { kind: "bullet", text: "Kbd を 改善" },
      { kind: "bullet", text: "番号付き" },
      { kind: "paragraph", text: "本文1 本文2" },
    ]);
  });
  it("空・空白・記号だけの行は空配列 / 無視", () => {
    expect(parseReleaseNotes(undefined)).toEqual([]);
    expect(parseReleaseNotes("  \n ")).toEqual([]);
    expect(parseReleaseNotes("## \n- ")).toEqual([]);
  });
  it("長すぎる本文は maxLen で切り詰める", () => {
    const blocks = parseReleaseNotes("あ".repeat(50), 10);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text.endsWith("…")).toBe(true);
  });
});
