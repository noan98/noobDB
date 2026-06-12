import { describe, it, expect } from "vitest";
// Vite の `?raw` インポートで App.css の中身を文字列として取り込む (node の fs に
// 依存せず、vite build / vitest 双方で同じ経路で読める)。型は vite/client が提供。
import css from "../App.css?raw";

/**
 * デザイントークンの WCAG AA コントラスト回帰テストと、フォントスケール
 * 追従の余白のガード。
 *
 * App.css の `:root` (ライト) と `:root[data-theme="dark"]` (ダーク) で定義された
 * CSS 変数を実ファイルから読み取り、主要なテキスト/UI 色ペアのコントラスト比を
 * 計算して AA 基準 (通常テキスト 4.5:1、UI 部品 3:1) を満たすことを固定する。
 * 値を将来いじって基準を割り込むと、ここで即座に検知できる。
 */

/** `:root { ... }` / `:root[data-theme="dark"] { ... }` ブロック内の `--var: value;`
 *  を抽出して map にする (16 進カラーのみ対象。calc()/var() などは無視)。 */
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

const light = parseVars(/:root\s*\{([\s\S]*?)\n\}/);
const dark = parseVars(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
// 追加テーマプリセット。プリセットのフルトークンブロックを実ファイルから読む。
const dracula = parseVars(/:root\[data-theme="dracula-dark"\]\s*\{([\s\S]*?)\n\}/);

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg: string, bg: string): number {
  const lf = luminance(fg);
  const lb = luminance(bg);
  const hi = Math.max(lf, lb);
  const lo = Math.min(lf, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function check(
  vars: Record<string, string>,
  fgVar: string,
  bgVar: string,
  min: number,
): void {
  const fg = vars[fgVar];
  const bg = vars[bgVar];
  expect(fg, `--${fgVar} must be a hex color`).toBeTruthy();
  expect(bg, `--${bgVar} must be a hex color`).toBeTruthy();
  const ratio = contrast(fg, bg);
  expect(
    ratio,
    `--${fgVar} (${fg}) on --${bgVar} (${bg}) = ${ratio.toFixed(2)}:1, need >= ${min}:1`,
  ).toBeGreaterThanOrEqual(min);
}

const AA_TEXT = 4.5;
const AA_UI = 3;

describe("WCAG AA contrast for core tokens (#326)", () => {
  describe.each([
    ["light", light],
    ["dark", dark],
  ] as const)("%s theme", (_name, vars) => {
    it("primary text meets AA (4.5:1)", () => {
      check(vars, "text", "bg", AA_TEXT);
      check(vars, "text", "bg-elevated", AA_TEXT);
      check(vars, "text-secondary", "bg", AA_TEXT);
      check(vars, "text-muted", "bg", AA_TEXT);
      check(vars, "text-muted", "bg-header", AA_TEXT);
    });

    it("NULL cell text meets AA on grid row backgrounds", () => {
      check(vars, "text-null", "bg-elevated", AA_TEXT);
      check(vars, "text-null", "bg-stripe", AA_TEXT);
    });

    it("accent text meets AA", () => {
      check(vars, "accent", "bg", AA_TEXT);
    });

    it("text on accent backgrounds (primary button / accent badge) meets AA (#348)", () => {
      // primary ボタン文字・SettingsView のアクセントバッジ文字が --accent 地に
      // 乗る。ダークは紺文字、ライトは白文字で AA を満たす。
      check(vars, "accent-text", "accent", AA_TEXT);
      check(vars, "accent-text", "accent-hover", AA_TEXT);
    });

    it("semantic message text colors meet AA (#348)", () => {
      // text-error/warning/success はエラー/警告/成功メッセージの本文色として
      // 既定背景と専用の淡色背景 (bg-error/bg-warning) の双方で使われる。
      check(vars, "text-error", "bg", AA_TEXT);
      check(vars, "text-error", "bg-error", AA_TEXT);
      check(vars, "text-warning", "bg", AA_TEXT);
      check(vars, "text-warning", "bg-warning", AA_TEXT);
      check(vars, "text-success", "bg", AA_TEXT);
    });

    it("decimal cell color meets AA on the cell surface (#348)", () => {
      check(vars, "cell-decimal", "bg-elevated", AA_TEXT);
      check(vars, "cell-decimal", "bg-stripe", AA_TEXT);
    });

    it("SQL syntax highlight colors meet AA on the editor surface (#348)", () => {
      // QueryEditor (CodeMirror) の既定シンタックス色。入力面 (--bg-input) 上で
      // 通常テキスト基準を満たす。ユーザ設定で上書き可能だが既定値を固定する。
      for (const c of [
        "syntax-keyword",
        "syntax-string",
        "syntax-number",
        "syntax-comment",
        "syntax-function",
        "syntax-operator",
      ]) {
        check(vars, c, "bg-input", AA_TEXT);
      }
    });

    it("preview banner text meets AA on its banner background (#348)", () => {
      // PreviewGrid のドライラン注意バナー本文。
      check(vars, "preview-banner-text", "preview-banner-bg", AA_TEXT);
    });

    it("status colors used as badge text meet AA", () => {
      // connected / connecting / success / error は SchemaCompareView / HelpView で
      // バッジ文字色に使われるため通常テキスト基準。
      check(vars, "status-connected", "bg", AA_TEXT);
      check(vars, "status-connecting", "bg", AA_TEXT);
      check(vars, "status-success", "bg", AA_TEXT);
      check(vars, "status-error", "bg", AA_TEXT);
    });

    it("status dots meet the UI-component minimum (3:1)", () => {
      check(vars, "status-warning", "bg", AA_UI);
      check(vars, "status-idle", "bg", AA_UI);
      check(vars, "status-info", "bg", AA_UI);
    });

    it("typed cell colors meet AA on the cell surface", () => {
      for (const c of [
        "cell-number",
        "cell-bool-true",
        "cell-bool-false",
        "cell-date",
        "cell-json",
        "cell-binary",
      ]) {
        check(vars, c, "bg-elevated", AA_TEXT);
      }
    });

    it("text on the row-selection / row-hover highlight meets AA", () => {
      check(vars, "text", "bg-active", AA_TEXT);
      check(vars, "text", "bg-row-hover", AA_TEXT);
    });

    it("semantic family text meets AA on default + subtle surfaces (#476)", () => {
      for (const fam of ["info", "success", "warning", "error"]) {
        check(vars, `${fam}-text`, "bg", AA_TEXT);
        check(vars, `${fam}-text`, "bg-elevated", AA_TEXT);
        check(vars, `${fam}-text`, `${fam}-subtle`, AA_TEXT);
      }
    });

    it("neutral ramp is monotonic in luminance from 0 to 950 (#476)", () => {
      // 0=地, 950=最も濃い文字。luminance はライト/ダークで向きが逆になるが、
      // どちらも「0 から 950 へ向かって地から単調に離れる」ことを固定する。
      const steps = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
      const lums = steps.map((s) => {
        const hex = vars[`neutral-${s}`];
        expect(hex, `--neutral-${s} must be a hex color`).toBeTruthy();
        return luminance(hex);
      });
      // ライトは 0(白) が最も明るく単調減少、ダークは 0(地) が最も暗く単調増加。
      const decreasing = lums[0] > lums[lums.length - 1];
      for (let i = 1; i < lums.length; i++) {
        if (decreasing) expect(lums[i]).toBeLessThanOrEqual(lums[i - 1]);
        else expect(lums[i]).toBeGreaterThanOrEqual(lums[i - 1]);
      }
    });
  });
});

describe("WCAG AA contrast for theme presets (#465)", () => {
  // プリセットは追加のフルトークンテーマ。ベース light/dark と同じ主要ペアが AA を
  // 満たすことを固定する (ニュートラル/セマンティック拡張トークンは
  // プリセットでは未定義なので、ここでは中核ペアのみ検証する)。
  describe.each([["dracula", dracula]] as const)("%s preset", (_name, vars) => {
    it("primary / secondary / muted text meet AA", () => {
      check(vars, "text", "bg", AA_TEXT);
      check(vars, "text", "bg-elevated", AA_TEXT);
      check(vars, "text-secondary", "bg", AA_TEXT);
      check(vars, "text-muted", "bg", AA_TEXT);
      check(vars, "text-muted", "bg-header", AA_TEXT);
      check(vars, "text-null", "bg-elevated", AA_TEXT);
      check(vars, "text-null", "bg-stripe", AA_TEXT);
    });
    it("accent and accent text meet AA", () => {
      check(vars, "accent", "bg", AA_TEXT);
      check(vars, "accent-text", "accent", AA_TEXT);
      check(vars, "accent-text", "accent-hover", AA_TEXT);
    });
    it("semantic message + status badge text meet AA", () => {
      check(vars, "text-error", "bg", AA_TEXT);
      check(vars, "text-warning", "bg", AA_TEXT);
      check(vars, "text-success", "bg", AA_TEXT);
      check(vars, "status-connected", "bg", AA_TEXT);
      check(vars, "status-error", "bg", AA_TEXT);
    });
    it("status dots meet the UI minimum (3:1)", () => {
      check(vars, "status-warning", "bg", AA_UI);
      check(vars, "status-idle", "bg", AA_UI);
      check(vars, "status-info", "bg", AA_UI);
    });
    it("typed cell + syntax colors meet AA on their surfaces", () => {
      for (const c of ["cell-number", "cell-bool-true", "cell-date", "cell-json", "cell-binary"]) {
        check(vars, c, "bg-elevated", AA_TEXT);
      }
      for (const c of ["syntax-keyword", "syntax-string", "syntax-comment", "syntax-function"]) {
        check(vars, c, "bg-input", AA_TEXT);
      }
    });
    it("text stays legible on row selection / hover", () => {
      check(vars, "text", "bg-active", AA_TEXT);
      check(vars, "text", "bg-row-hover", AA_TEXT);
    });
  });
});

describe("spacing scale tracks the font scale (#327)", () => {
  it("every --space-N is defined as calc(... * var(--font-scale))", () => {
    for (let n = 1; n <= 6; n++) {
      const re = new RegExp(`--space-${n}:\\s*calc\\([^;]*var\\(--font-scale\\)[^;]*\\);`);
      expect(css, `--space-${n} must scale with --font-scale`).toMatch(re);
    }
  });
});
