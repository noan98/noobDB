import { describe, expect, it } from "vitest";
import { formatCombo, splitComboKeys, canonicalizeCombo, comboMatchesEvent } from "../shortcutKeys";
import { formatRelatedCell } from "../relatedRows";
import { singleLineSql } from "../quickLauncher";
import { truncateReleaseNotes } from "../updaterFormat";
import { takeGraphemes } from "../truncateText";

/** 孤立サロゲートを含むか (表示時に置換文字になる)。 */
const hasLoneSurrogate = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe("書記素単位の切り詰め (#1604)", () => {
  it("takeGraphemes は収まれば null、超えれば書記素で切る", () => {
    expect(takeGraphemes("abc", 3)).toBeNull();
    expect(takeGraphemes("abcd", 3)).toBe("abc");
    expect(takeGraphemes("🇯🇵🇺🇸", 1)).toBe("🇯🇵");
  });

  it("formatRelatedCell はサロゲートペアを割らない", () => {
    const cell = formatRelatedCell("😀".repeat(200), "string", false);
    expect(cell.tone).toBe("value");
    if (cell.tone === "value") {
      expect(cell.truncated).toBe(true);
      expect(hasLoneSurrogate(cell.text)).toBe(false);
      expect(cell.text.endsWith("…")).toBe(true);
    }
  });

  it("singleLineSql はサロゲートペアを割らない", () => {
    const s = singleLineSql(`SELECT '${"😀".repeat(100)}'`, 80);
    expect(hasLoneSurrogate(s)).toBe(false);
    expect(s.endsWith("…")).toBe(true);
    expect(singleLineSql("SELECT 1", 80)).toBe("SELECT 1");
  });

  it("truncateReleaseNotes は旗絵文字を 1 文字目と 2 文字目の間で割らない", () => {
    const body = `${"a".repeat(599)}🇯🇵${"b".repeat(10)}`;
    const out = truncateReleaseNotes(body, 600);
    expect(out).toBe(`${"a".repeat(599)}🇯🇵…`);
  });
});

describe("+ キーを含むショートカットの表示 (#1604)", () => {
  it("Mod+Shift++ は + キーを表示に残す", () => {
    expect(formatCombo("Mod+Shift++")).toBe("Cmd/Ctrl+Shift++");
    expect(canonicalizeCombo("Mod+Shift++")).toBe("Mod+Shift++");
    expect(formatCombo("+")).toBe("+");
  });

  it("splitComboKeys は末尾の + をキーとして返す", () => {
    expect(splitComboKeys("Cmd/Ctrl+Shift++")).toEqual(["Cmd/Ctrl", "Shift", "+"]);
    expect(splitComboKeys("Cmd/Ctrl+K")).toEqual(["Cmd/Ctrl", "K"]);
  });

  it("イベントとの一致判定は変わらない", () => {
    const e = { key: "+", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true } as KeyboardEvent;
    expect(comboMatchesEvent("Mod+Shift++", e)).toBe(true);
  });
});
