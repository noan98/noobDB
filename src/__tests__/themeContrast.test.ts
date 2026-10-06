import { describe, it, expect } from "vitest";
// Vite の `?raw` インポートで App.css の中身を文字列として取り込む (node の fs に
// 依存せず、vite build / vitest 双方で同じ経路で読める)。型は vite/client が提供。
import css from "../App.css?raw";
// theme.ts の dark 判定条件 (`conditions.dark`) の実ソースを比較するため。
import themeTsSource from "../theme.ts?raw";
// コントラスト比の計算はアクセント色ロジック (accent.ts) と共有する (#559)。
// 二重実装を避け、accent.test.ts と同じ式で全テーマ/プリセットを検証する。
import { contrastRatio } from "../accent";
// データ可視化パレットのダークテーマ対応 (#1187) の回帰ガード。
import {
  CATEGORICAL,
  CATEGORICAL_DARK,
  DIVERGING_RAMPS,
  SEQUENTIAL_RAMPS,
  isDarkDataTheme,
  rampStops,
  sampleRamp,
} from "../colorScale";

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

/**
 * 追加テーマプリセットを App.css から**自動検出**する (#559)。
 *
 * `:root[data-theme="<name>"]` ブロックを名前ごとに収集し、ベースの `dark`
 * (light/dark の基準テーマで別 describe が検証する) を除いたものをプリセットと
 * みなす。これにより、新しいプリセットを App.css に足すだけで下の AA 検証へ
 * 自動的に乗る (プリセットごとに describe を書き足す必要がない)。
 *
 * light 系プリセット (`hc-light`/`cb-light` のように名前が "light" で終わる) は
 * ベース `:root` (light) を、dark 系はベース `dark` をフォールバックにマージする。
 * 実行時のカスケード (`:root` が常に効き、`[data-theme=...]` が上書き) を再現し、
 * プリセットが一部トークンを省略してもベース値を継ぐ。
 */
function discoverPresets(): { name: string; vars: Record<string, string>; isHighContrast: boolean }[] {
  const re = /:root\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g;
  const out: { name: string; vars: Record<string, string>; isHighContrast: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const name = m[1];
    if (name === "dark") continue; // ベースのダークテーマは別 describe で検証する
    const ownVars = parseVars(
      new RegExp(`:root\\[data-theme="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`),
    );
    const fallback = name.endsWith("light") ? light : dark;
    out.push({
      name,
      vars: { ...fallback, ...ownVars },
      // 高コントラストプリセットは AAA (7:1) を狙う (#558)。
      isHighContrast: name.startsWith("hc-"),
    });
  }
  return out;
}

const presets = discoverPresets();

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

/** `sampleRamp` の `rgb(r, g, b)` 出力を `contrastRatio`/`luminance` が受ける
 *  `#rrggbb` へ変換する (#1187)。 */
function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgb\((\d+), (\d+), (\d+)\)/);
  if (!m) throw new Error(`unexpected color format: ${rgb}`);
  const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
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
  // accent.ts と共有のコントラスト計算 (#559)。
  const ratio = contrastRatio(fg, bg);
  expect(
    ratio,
    `--${fgVar} (${fg}) on --${bgVar} (${bg}) = ${ratio.toFixed(2)}:1, need >= ${min}:1`,
  ).toBeGreaterThanOrEqual(min);
}

const AA_TEXT = 4.5;
const AA_UI = 3;
/** 高コントラストプリセットの主要前景/背景に課す AAA 閾値 (#558)。 */
const AAA_TEXT = 7;

/**
 * `--on-solid` (ベタ塗りの上の文字/アイコン色、#1111) を載せる塗り面の一覧。
 * 意味色ファミリの `*-solid` と、接続状態の `--status-*` のうち実際にバッジの
 * 地として使われるものを対象にする (`--status-idle` はドット表示専用で、文字を
 * 載せないため含めない)。
 */
const ON_SOLID_SURFACES = [
  "info-solid",
  "success-solid",
  "warning-solid",
  "error-solid",
  "status-error",
  "status-warning",
  "status-connected",
  "status-connecting",
] as const;

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

    it("--on-solid meets AA on every filled semantic/status surface (#1111)", () => {
      // ベタ塗りバッジ (本番バッジ・未読カウント・再接続中チップ・EXPLAIN の警告印・
      // セル編集エラーの吹き出し) の文字色。以前は各所で `#fff` を直書きしていたが、
      // ダーク系テーマでは *-solid / status-* が明色になるため白文字が判読できな
      // かった。テーマごとに 1 つの --on-solid へ集約し、塗り面すべてで AA を
      // 満たすことをここで固定する。
      for (const bg of ON_SOLID_SURFACES) check(vars, "on-solid", bg, AA_TEXT);
    });

    it("PK key accent color meets AA on the tree/ER surfaces (#717)", () => {
      // --key-accent は接続ツリー (ConnectionList) と ER 図 (ERDiagramView) の PK
      // アイコン専用トークン。--cell-date からの分離後も見た目 (コントラスト) は
      // 不変であることを固定する。
      check(vars, "key-accent", "bg-elevated", AA_TEXT);
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

describe("WCAG AA contrast for theme presets (#465, #558)", () => {
  // プリセットは追加のフルトークンテーマ。App.css から自動検出した全プリセット
  // (dracula / high-contrast / colorblind / 今後追加されるもの) について、ベース
  // light/dark と同じ主要ペアが AA を満たすことを固定する。新規プリセットは
  // App.css にブロックを足すだけでこの検証へ自動的に乗る (#559)。
  it("at least the known presets are discovered", () => {
    // 退行検知: regex 変更などで自動検出が 0 件になっても素通りしないようにする。
    const names = presets.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "dracula-dark",
        "hc-light",
        "hc-dark",
        "cb-light",
        "cb-dark",
        // 人気コミュニティテーマプリセット (#598)。
        "nord-dark",
        "solarized-light",
        "solarized-dark",
        "one-dark",
        // モダンプリセット (#1237)。
        "catppuccin-dark",
        "tokyo-night-light",
        "tokyo-night-dark",
      ]),
    );
  });

  describe.each(presets.map((p) => [p.name, p] as const))("%s preset", (_name, preset) => {
    const vars = preset.vars;
    // 高コントラストプリセットは主要本文に AAA、それ以外は AA。
    const primaryMin = preset.isHighContrast ? AAA_TEXT : AA_TEXT;

    it(`primary / secondary / muted text meet ${preset.isHighContrast ? "AAA" : "AA"}`, () => {
      check(vars, "text", "bg", primaryMin);
      check(vars, "text", "bg-elevated", primaryMin);
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
    it("--on-solid meets AA on every filled semantic/status surface (#1111)", () => {
      for (const bg of ON_SOLID_SURFACES) check(vars, "on-solid", bg, AA_TEXT);
    });
    it("semantic family text meets AA on default + subtle surfaces (#476/#664)", () => {
      // info/success/warning/error の 4 段階トークンは #664 でこのプリセットにも
      // フル定義した。未定義のまま :root のライト値へフォールバックしないことを
      // 固定する (このチェックは vars が preset own のみを持つ場合に落ちる —
      // discoverPresets はベースへのフォールバックもマージするため、プリセット
      // 側が省略していても直接ここでは検知できない。そのため generic な AA
      // チェックに加え、プリセット自身が全トークンを定義していることも検証する)。
      for (const fam of ["info", "success", "warning", "error"]) {
        check(vars, `${fam}-text`, "bg", AA_TEXT);
        check(vars, `${fam}-text`, "bg-elevated", AA_TEXT);
        check(vars, `${fam}-text`, `${fam}-subtle`, AA_TEXT);
      }
    });
    it("defines its own semantic family tokens instead of falling back to the light default (#664)", () => {
      // フォールバックマージ (discoverPresets) 前の生ブロックだけを見て、
      // info/success/warning/error の 4 段階トークンをプリセット自身が
      // 定義していることを検証する。これが無いと dracula-dark などの暗い
      // プリセットが誤ってライト既定色 (:root) を継いでしまう (#664 で発見した
      // 回帰) — 上のフォールバックマージ後の AA チェックだけでは検知できない。
      const re = new RegExp(
        `:root\\[data-theme="${preset.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`,
      );
      const m = css.match(re);
      expect(m, `preset block not found: ${preset.name}`).toBeTruthy();
      const body = m![1];
      for (const fam of ["info", "success", "warning", "error"]) {
        for (const tier of ["subtle", "border", "solid", "text"]) {
          expect(
            body,
            `--${fam}-${tier} must be defined directly in :root[data-theme="${preset.name}"]`,
          ).toMatch(new RegExp(`--${fam}-${tier}:\\s*#[0-9a-fA-F]{6};`));
        }
      }
    });
    it("typed cell + syntax colors meet AA on their surfaces", () => {
      for (const c of ["cell-number", "cell-bool-true", "cell-date", "cell-json", "cell-binary", "key-accent"]) {
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

describe("data-viz palettes stay dark-theme aware (#1187)", () => {
  // `isDarkDataTheme` は `theme.ts` の Chakra `conditions.dark`
  // (`"[data-theme$=dark] &"`、CSS の属性値末尾一致セレクタ) と同じ「値が
  // "dark" で終わるか」を再利用していることを、実際の theme.ts のソースから
  // 直接検証する (新しい判定方法を発明していないことの回帰ガード)。
  it("isDarkDataTheme matches theme.ts's [data-theme$=dark] suffix rule", () => {
    expect(themeTsSource).toMatch(/dark:\s*"\[data-theme\$=dark\]\s*&"/);
  });

  it("agrees with the suffix rule for every known data-theme value", () => {
    const darkValues = [
      "dark", "dracula-dark", "nord-dark", "hc-dark", "cb-dark", "solarized-dark", "one-dark",
      "catppuccin-dark", "tokyo-night-dark",
    ];
    const lightValues = ["light", "hc-light", "cb-light", "solarized-light", "tokyo-night-light"];
    for (const v of darkValues) expect(isDarkDataTheme(v)).toBe(true);
    for (const v of lightValues) expect(isDarkDataTheme(v)).toBe(false);
    expect(isDarkDataTheme(null)).toBe(false);
    expect(isDarkDataTheme(undefined)).toBe(false);
    expect(isDarkDataTheme("")).toBe(false);
  });

  // すべての「ダーク系」data-theme 値 (base dark + プリセット) の --bg を集める。
  // discoverPresets はライト/ダークどちらのプリセットも含むので isDarkDataTheme で絞る。
  const darkBackgrounds: Record<string, string> = { dark: dark.bg };
  for (const preset of presets) {
    if (isDarkDataTheme(preset.name) && preset.vars.bg) darkBackgrounds[preset.name] = preset.vars.bg;
  }
  const lightBackgrounds: Record<string, string> = { light: light.bg };
  for (const preset of presets) {
    if (!isDarkDataTheme(preset.name) && preset.vars.bg) lightBackgrounds[preset.name] = preset.vars.bg;
  }

  it("discovers at least the known dark-family backgrounds", () => {
    // 退行検知: フィルタ条件の変更などで 0 件になっても素通りしないようにする。
    expect(Object.keys(darkBackgrounds)).toEqual(
      expect.arrayContaining(["dark", "dracula-dark", "nord-dark", "hc-dark", "cb-dark", "solarized-dark", "one-dark"]),
    );
  });

  it("CATEGORICAL (light) meets the UI-component minimum (3:1) on every light-family background", () => {
    for (const [name, bg] of Object.entries(lightBackgrounds)) {
      for (const c of CATEGORICAL) {
        expect(contrastRatio(c, bg), `${c} on ${name} (${bg})`).toBeGreaterThanOrEqual(AA_UI);
      }
    }
  });

  it("CATEGORICAL_DARK meets the UI-component minimum (3:1) on every dark-family background (#1187)", () => {
    // 修正前の `CATEGORICAL` (ライト用) は nord-dark / one-dark / dracula-dark など
    // 複数のダークプリセットで 3:1 を割り込んでいた (紫 #aa3377 は多くのダーク背景で
    // 2 台前半)。ダーク用並行パレットで全ダーク系テーマの背景に対し確保することを固定する。
    for (const [name, bg] of Object.entries(darkBackgrounds)) {
      for (const c of CATEGORICAL_DARK) {
        expect(contrastRatio(c, bg), `${c} on ${name} (${bg})`).toBeGreaterThanOrEqual(AA_UI);
      }
    }
  });

  it("CATEGORICAL_DARK stays CB-safe: same length/order as CATEGORICAL and all distinct", () => {
    expect(CATEGORICAL_DARK.length).toBe(CATEGORICAL.length);
    expect(new Set(CATEGORICAL_DARK).size).toBe(CATEGORICAL_DARK.length);
    for (const hex of CATEGORICAL_DARK) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  describe.each([
    ["blue", SEQUENTIAL_RAMPS.blue],
    ["teal", SEQUENTIAL_RAMPS.teal],
  ] as const)("sequential ramp %s (dark)", (_name, ramp) => {
    it("low value (t=0) stays close in darkness to every dark-family background", () => {
      // 「ヒートマップの低い値の色が背景に近い暗さであること」の回帰ガード。
      // 完全一致は求めず、UI 部品の最低限未満 (< 3:1) に収まることで
      // 「背景から浮き上がって見えない」ことを固定する。
      const low = sampleRamp(0, rampStops(ramp, true));
      for (const [name, bg] of Object.entries(darkBackgrounds)) {
        const lowHex = rgbToHex(low);
        expect(contrastRatio(lowHex, bg), `${ramp.key} low vs ${name} (${bg})`).toBeLessThan(AA_UI);
      }
    });

    it("luminance increases monotonically from low value to high value (明度＝値を保つ)", () => {
      const stops = rampStops(ramp, true);
      const lums = [0, 0.5, 1].map((t) => luminance(rgbToHex(sampleRamp(t, stops))));
      expect(lums[1]).toBeGreaterThan(lums[0]);
      expect(lums[2]).toBeGreaterThan(lums[1]);
    });

    it("high value (t=1) is clearly brighter than the darkest dark-family background", () => {
      const high = rgbToHex(sampleRamp(1, rampStops(ramp, true)));
      for (const [name, bg] of Object.entries(darkBackgrounds)) {
        expect(contrastRatio(high, bg), `${ramp.key} high vs ${name} (${bg})`).toBeGreaterThanOrEqual(AA_UI);
      }
    });
  });

  describe.each([
    ["coolWarm", DIVERGING_RAMPS.coolWarm],
    ["blueOrange", DIVERGING_RAMPS.blueOrange],
  ] as const)("diverging ramp %s (dark)", (_name, ramp) => {
    it("center (t=0.5, low salience) stays close in darkness to every dark-family background", () => {
      const center = rgbToHex(sampleRamp(0.5, rampStops(ramp, true)));
      for (const [name, bg] of Object.entries(darkBackgrounds)) {
        expect(contrastRatio(center, bg), `${ramp.key} center vs ${name} (${bg})`).toBeLessThan(AA_UI);
      }
    });

    it("both ends (t=0 / t=1, high salience) are clearly brighter than the center", () => {
      const stops = rampStops(ramp, true);
      const centerLum = luminance(rgbToHex(sampleRamp(0.5, stops)));
      const loLum = luminance(rgbToHex(sampleRamp(0, stops)));
      const hiLum = luminance(rgbToHex(sampleRamp(1, stops)));
      expect(loLum).toBeGreaterThan(centerLum);
      expect(hiLum).toBeGreaterThan(centerLum);
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
