import { describe, it, expect } from "vitest";
// Vite の `?raw` インポートで App.css の中身を文字列として取り込む (themeContrast.test.ts
// / semanticColors.test.ts と同じ経路)。ソースファイルそのものではなく実ファイルの
// テキストを解析することで、themePresetPreview.ts の静的マップが App.css の実際の
// 値からズレていないかを検証する。
import css from "../App.css?raw";
import { THEME_PRESET_ORDER, themePresetDataTheme, type Theme } from "../settings";
import {
  THEME_PREVIEW_CHIP_ORDER,
  themePreviewColors,
  themePreviewGradient,
} from "../themePresetPreview";

/**
 * themePresetPreview.ts の静的カラーマップと App.css の実値との同期を固定する
 * テスト (#789)。
 *
 * `themePresetPreview.ts` は「色値の二重管理を避ける」ため、実行時に DOM から
 * 読み取る案の代わりに静的マップ + このテストによる同期検証を採用している
 * (詳細は themePresetPreview.ts 冒頭のコメントを参照)。App.css 側の色を変更したら
 * このテストが red になり、静的マップの更新漏れを検知する。
 */

/** `:root[data-theme="x"] { ... }` / `:root { ... }` ブロック内の `--var: value;`
 *  を抽出して map にする (16 進カラーのみ対象)。themeContrast.test.ts と同じ方式。 */
function parseVars(blockSelectorRegex: RegExp): Record<string, string> {
  const m = css.match(blockSelectorRegex);
  if (!m) throw new Error(`block not found: ${blockSelectorRegex}`);
  const body = m[1];
  const out: Record<string, string> = {};
  const re = /--([\w-]+):\s*([^;]+);/g;
  let v: RegExpExecArray | null;
  while ((v = re.exec(body))) {
    const name = v[1];
    const value = v[2].trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) out[name] = value.toLowerCase();
  }
  return out;
}

/** `:root[data-theme="<name>"]` ブロックを名前で取り出す。"light" は素の `:root`。 */
function varsForDataTheme(name: string): Record<string, string> {
  if (name === "light") return parseVars(/:root\s*\{([\s\S]*?)\n\}/);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return parseVars(new RegExp(`:root\\[data-theme="${escaped}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
}

// themePresetDataTheme が返しうる data-theme 値を、全プリセット × light/dark の
// 組み合わせから網羅的に収集する。
const ALL_DATA_THEME_VALUES = Array.from(
  new Set(
    THEME_PRESET_ORDER.flatMap((preset) =>
      (["light", "dark"] as Theme[]).map((theme) => themePresetDataTheme(preset, theme)),
    ),
  ),
);

const CHIP_TO_CSS_VAR: Record<(typeof THEME_PREVIEW_CHIP_ORDER)[number], string> = {
  bg: "bg",
  surface: "bg-elevated",
  accent: "accent",
  text: "text",
  keyword: "syntax-keyword",
};

describe("themePresetPreview: 静的マップと App.css の同期", () => {
  it.each(ALL_DATA_THEME_VALUES)("data-theme=%s の代表色が App.css と一致する", (dataTheme) => {
    const cssVars = varsForDataTheme(dataTheme);
    const preview = PREVIEW_LOOKUP[dataTheme];
    expect(preview, `themePresetPreview.ts に data-theme="${dataTheme}" のエントリがない`).toBeDefined();
    for (const chip of THEME_PREVIEW_CHIP_ORDER) {
      const cssVarName = CHIP_TO_CSS_VAR[chip];
      expect(preview![chip], `${dataTheme}.${chip}`).toBe(cssVars[cssVarName]);
    }
  });

  it("themePreviewColors がプリセット × light/dark の全組み合わせで解決できる", () => {
    for (const preset of THEME_PRESET_ORDER) {
      for (const theme of ["light", "dark"] as Theme[]) {
        const colors = themePreviewColors(preset, theme);
        for (const chip of THEME_PREVIEW_CHIP_ORDER) {
          expect(colors[chip]).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("dracula/nord/one-dark はダーク専用として light/dark で同じ色を返す", () => {
    for (const preset of ["dracula", "nord", "one-dark"] as const) {
      expect(themePreviewColors(preset, "light")).toEqual(themePreviewColors(preset, "dark"));
    }
  });

  it("solarized/high-contrast/colorblind は light/dark で異なる色を返す", () => {
    for (const preset of ["solarized", "high-contrast", "colorblind"] as const) {
      expect(themePreviewColors(preset, "light")).not.toEqual(themePreviewColors(preset, "dark"));
    }
  });
});

describe("themePreviewGradient", () => {
  it("チップ順に等分割された linear-gradient 文字列を返す", () => {
    const colors = themePreviewColors("dracula", "dark");
    const gradient = themePreviewGradient(colors);
    expect(gradient).toBe(
      "linear-gradient(90deg, " +
        `${colors.bg} 0% 20%, ${colors.surface} 20% 40%, ${colors.accent} 40% 60%, ` +
        `${colors.text} 60% 80%, ${colors.keyword} 80% 100%)`,
    );
  });

  it("全プリセット × light/dark で有効な linear-gradient 文字列を返す", () => {
    for (const preset of THEME_PRESET_ORDER) {
      for (const theme of ["light", "dark"] as Theme[]) {
        const gradient = themePreviewGradient(themePreviewColors(preset, theme));
        expect(gradient.startsWith("linear-gradient(90deg, ")).toBe(true);
        expect(gradient.match(/#[0-9a-f]{6}/g)).toHaveLength(THEME_PREVIEW_CHIP_ORDER.length);
      }
    }
  });
});

// 上の it.each 内から参照するため、themePreviewColors 経由で全 data-theme 値 →
// 代表色のルックアップを一度だけ構築する (data-theme 文字列がそのままキー)。
const PREVIEW_LOOKUP: Record<string, ReturnType<typeof themePreviewColors>> = Object.fromEntries(
  THEME_PRESET_ORDER.flatMap((preset) =>
    (["light", "dark"] as Theme[]).map((theme) => [
      themePresetDataTheme(preset, theme),
      themePreviewColors(preset, theme),
    ]),
  ),
);
