// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyCustomThemeVars,
  findContrastFailures,
  MAX_CUSTOM_THEME_TOKENS,
  parseCustomTheme,
  readBaseThemeToken,
  sanitizeCustomTheme,
} from "../customTheme";
import {
  DEFAULT_SETTINGS,
  deserializeSettingsImport,
  resolveThemePreset,
  serializeSettingsExport,
} from "../settings";

describe("sanitizeCustomTheme / parseCustomTheme (#1631)", () => {
  it("-- の有無を問わず名前を正規化し、16 進色だけ残す", () => {
    expect(
      sanitizeCustomTheme({
        "--accent": "#ABC",
        bg: "#101418",
        "bad name": "#000000",
        text: "red",
        "x;y": "#000000",
        n: 3,
      }),
    ).toEqual({ accent: "#aabbcc", bg: "#101418" });
  });
  it("配列・null・プリミティブは空", () => {
    expect(sanitizeCustomTheme([1])).toEqual({});
    expect(sanitizeCustomTheme(null)).toEqual({});
    expect(sanitizeCustomTheme("x")).toEqual({});
  });
  it("件数に上限がある", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_CUSTOM_THEME_TOKENS + 20; i += 1) many[`t${i}`] = "#000000";
    expect(Object.keys(sanitizeCustomTheme(many))).toHaveLength(MAX_CUSTOM_THEME_TOKENS);
  });
  it("JSON の不正・形の不正・空を区別し、ラップ形式と無視件数を扱う", () => {
    expect(parseCustomTheme("{")).toEqual({ ok: false, reason: "invalid-json" });
    expect(parseCustomTheme("[1]")).toEqual({ ok: false, reason: "not-object" });
    expect(parseCustomTheme('{"a":"zzz"}')).toEqual({ ok: false, reason: "empty" });
    expect(parseCustomTheme('{"tokens":{"accent":"#0b5fff","bad":"x"}}')).toEqual({
      ok: true,
      tokens: { accent: "#0b5fff" },
      ignored: 1,
    });
  });
});

describe("findContrastFailures (#1631)", () => {
  const base: Record<string, string> = {
    text: "#111111",
    bg: "#ffffff",
    "bg-elevated": "#ffffff",
    accent: "#0b5fff",
  };
  const baseOf = (n: string) => base[n] ?? null;

  it("上書きに関係しない組は判定しない", () => {
    expect(findContrastFailures({ "syntax-keyword": "#000000" }, baseOf)).toEqual([]);
  });
  it("背景だけ上書きして文字とのコントラストが足りなければ警告する", () => {
    const f = findContrastFailures({ bg: "#222222" }, baseOf);
    expect(f.map((x) => `${x.fg}/${x.bg}`)).toContain("text/bg");
    expect(f.every((x) => x.ratio < x.min)).toBe(true);
  });
  it("十分なコントラストなら警告なし", () => {
    expect(findContrastFailures({ bg: "#ffffff", text: "#000000" }, baseOf)).toEqual([]);
  });
  it("基準値が分からない組 (16 進でない) は飛ばす", () => {
    expect(findContrastFailures({ accent: "#ffffff" }, () => "var(--x)")).toEqual([]);
  });
});

describe("DOM への適用 (#1631)", () => {
  it("当てて、後片付けで外せる", () => {
    const root = document.createElement("div");
    const undo = applyCustomThemeVars(root, { accent: "#0b5fff" });
    expect(root.style.getPropertyValue("--accent")).toBe("#0b5fff");
    undo();
    expect(root.style.getPropertyValue("--accent")).toBe("");
  });
  it("基準値の読み取りは適用中の上書きを一時的に外し、読んだら戻す", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    applyCustomThemeVars(root, { accent: "#0b5fff" });
    const baseOf = readBaseThemeToken(root, { accent: "#0b5fff" });
    expect(baseOf("accent")).not.toBe("#0b5fff");
    expect(root.style.getPropertyValue("--accent")).toBe("#0b5fff");
  });
});

describe("resolveThemePreset (#1631)", () => {
  it("追従オン・OS が高コントラスト・既定プリセットのときだけ切り替える", () => {
    expect(resolveThemePreset("default", true, true)).toBe("high-contrast");
    expect(resolveThemePreset("default", false, true)).toBe("default");
    expect(resolveThemePreset("default", true, false)).toBe("default");
    expect(resolveThemePreset("nord", true, true)).toBe("nord");
    expect(resolveThemePreset("colorblind", true, true)).toBe("colorblind");
  });
});

describe("設定の保存形式 (#1631)", () => {
  it("既定は追従オン・上書きなしで、エクスポート往復で保たれる", () => {
    expect(DEFAULT_SETTINGS.followOsContrast).toBe(true);
    expect(DEFAULT_SETTINGS.customTheme).toEqual({});
    const withTheme = { ...DEFAULT_SETTINGS, followOsContrast: false, customTheme: { accent: "#0b5fff" } };
    const back = deserializeSettingsImport(serializeSettingsExport(withTheme));
    expect(back.followOsContrast).toBe(false);
    expect(back.customTheme).toEqual({ accent: "#0b5fff" });
  });
});
