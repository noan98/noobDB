import {
  createSystem,
  defaultConfig,
  defineConfig,
  defineRecipe,
} from "@chakra-ui/react";

/**
 * Chakra UI システムの基盤定義。
 *
 * noobDB の見た目は `App.css` の CSS 変数 (`--bg` / `--accent` / `--text` など)
 * を正としており、ダークモードとワークスペースアクセント色はそれらの変数を
 * 差し替えることで実現している。ここでは Chakra のトークンを **その CSS 変数を
 * 指す** だけにすることで、Chakra 製コンポーネントを既存テーマ・ダークモードへ
 * 重複なく自動追従させる (値を二重管理しない)。
 *
 * `preflight: false` で Chakra のグローバル CSS リセットを無効化している。
 * 既存の 4,000 行超の `App.css` と共存させるための必須設定で、これを外すと
 * 全画面のマージン/ボックスモデルがリセットされて表示が崩れる。
 *
 * ## ダークモード方針
 *
 * 色・余白・影などほとんどのトークンは `var(--*)` ブリッジで
 * `:root[data-theme="dark"]` に自動追従するため、Chakra 側でダーク条件を持つ
 * 必要はない。例外は **カラー付きボタン (success/warning/danger/info)** で、
 * これらは `App.css` 上でも CSS 変数を介さずライト/ダークで別々の固定色を使う
 * ため、`semanticTokens` の `_dark` 条件で表現する。その `_dark` をアプリの
 * テーマ切替 (`<html data-theme="...">`、App.tsx 参照) に合わせるため、下の
 * `conditions.dark` を `[data-theme=dark]` セレクタに設定している。
 *
 * 動的に切り替わるアクセント色 (`--accent` / `--ws-accent`) と `--font-scale`
 * は接続ごと・設定ごとに実行時へ書き込まれるため、トークン化せず CSS 変数の
 * まま参照する (フォーカスリングの `color-mix(... var(--accent) ...)` など)。
 */

/** キーボードフォーカス時のリング。`App.css` のフォーカス表現と一致させる。
 *  動的アクセントへ追従させるため CSS 変数を直接参照する。 */
const focusRing = "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)";

const config = defineConfig({
  preflight: false,
  // Chakra の `_dark` 条件をアプリのテーマ属性 (`<html data-theme="dark">`) に
  // 合わせる。既定の `.dark &` ではなく `data-theme` を見るようにする。
  conditions: {
    dark: "[data-theme=dark] &",
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: "var(--font-sans)" },
        heading: { value: "var(--font-sans)" },
        mono: { value: "var(--font-mono)" },
      },
      // フォントサイズは `--font-scale` を内包する `--text-*` をそのまま参照し、
      // UI 全体のフォント拡大設定に追従させる。
      fontSizes: {
        "2xs": { value: "var(--text-2xs)" },
        xs: { value: "var(--text-xs)" },
        sm: { value: "var(--text-sm)" },
        md: { value: "var(--text-md)" },
        base: { value: "var(--text-base)" },
        lg: { value: "var(--text-lg)" },
      },
      // 4px リズムの余白スケール。
      spacing: {
        1: { value: "var(--space-1)" },
        2: { value: "var(--space-2)" },
        3: { value: "var(--space-3)" },
        4: { value: "var(--space-4)" },
        5: { value: "var(--space-5)" },
        6: { value: "var(--space-6)" },
      },
      radii: {
        sm: { value: "var(--radius-sm)" },
        md: { value: "var(--radius-md)" },
        lg: { value: "var(--radius-lg)" },
        pill: { value: "var(--radius-pill)" },
      },
      // 既存デザイントークンへの色ブリッジ。`app.*` 名前空間に隔離して
      // Chakra 既定のセマンティックカラーを壊さないようにしている。
      colors: {
        app: {
          // 背景
          bg: { value: "var(--bg)" },
          surface: { value: "var(--bg-elevated)" },
          surfaceMuted: { value: "var(--bg-muted)" },
          hover: { value: "var(--bg-hover)" },
          active: { value: "var(--bg-active)" },
          activeStrong: { value: "var(--bg-active-strong)" },
          toolbar: { value: "var(--bg-toolbar)" },
          header: { value: "var(--bg-header)" },
          bgError: { value: "var(--bg-error)" },
          bgInput: { value: "var(--bg-input)" },
          stripe: { value: "var(--bg-stripe)" },
          rowHover: { value: "var(--bg-row-hover)" },
          // テキスト
          text: { value: "var(--text)" },
          textSecondary: { value: "var(--text-secondary)" },
          textMuted: { value: "var(--text-muted)" },
          textNull: { value: "var(--text-null)" },
          textError: { value: "var(--text-error)" },
          textSuccess: { value: "var(--text-success)" },
          // ボーダー
          border: { value: "var(--border)" },
          borderStrong: { value: "var(--border-strong)" },
          borderSubtle: { value: "var(--border-subtle)" },
          // アクセント (接続ごとに動的に変わる)
          accent: { value: "var(--accent)" },
          accentHover: { value: "var(--accent-hover)" },
          accentText: { value: "var(--accent-text)" },
          // セル値の型別色
          cell: {
            number: { value: "var(--cell-number)" },
            decimal: { value: "var(--cell-decimal)" },
            boolTrue: { value: "var(--cell-bool-true)" },
            boolFalse: { value: "var(--cell-bool-false)" },
            date: { value: "var(--cell-date)" },
            json: { value: "var(--cell-json)" },
            binary: { value: "var(--cell-binary)" },
          },
          // ステータス色
          status: {
            connected: { value: "var(--status-connected)" },
            connecting: { value: "var(--status-connecting)" },
            error: { value: "var(--status-error)" },
            success: { value: "var(--status-success)" },
            info: { value: "var(--status-info)" },
            idle: { value: "var(--status-idle)" },
          },
          // SQL シンタックスハイライト色
          syntax: {
            keyword: { value: "var(--syntax-keyword)" },
            string: { value: "var(--syntax-string)" },
            number: { value: "var(--syntax-number)" },
            comment: { value: "var(--syntax-comment)" },
            function: { value: "var(--syntax-function)" },
            operator: { value: "var(--syntax-operator)" },
          },
        },
      },
    },
    semanticTokens: {
      // 影は `--shadow-*` ブリッジ。Chakra の既定 shadow スケールは semanticToken
      // として定義されているため、`tokens` 側ではなくここで上書きしないと
      // `shadow="md"` などが既定値のままになる。
      shadows: {
        sm: { value: "var(--shadow-sm)" },
        md: { value: "var(--shadow-md)" },
        lg: { value: "var(--shadow-lg)" },
        xl: { value: "var(--shadow-xl)" },
      },
      // カラー付きボタンはライト/ダークで別々の固定色を使い (App.css でも CSS 変数を
      // 経由しない)、単純な var() ブリッジでは表現できないため、ここで `_dark` 条件付き
      // の値として定義する。値は App.css のボタン色定義と一致させている。
      colors: {
        app: {
          successBg: { value: { base: "#16a34a", _dark: "#22c55e" } },
          successBgHover: { value: { base: "#15803d", _dark: "#4ade80" } },
          successFg: { value: { base: "#ffffff", _dark: "#052e16" } },
          warningBg: { value: { base: "#d97706", _dark: "#f59e0b" } },
          warningBgHover: { value: { base: "#b45309", _dark: "#fbbf24" } },
          warningFg: { value: { base: "#ffffff", _dark: "#2a1707" } },
          dangerBg: { value: { base: "#dc2626", _dark: "#ef4444" } },
          dangerBgHover: { value: { base: "#b91c1c", _dark: "#f87171" } },
          dangerFg: { value: { base: "#ffffff", _dark: "#ffffff" } },
          infoBg: { value: { base: "#0369a1", _dark: "#38bdf8" } },
          infoBgHover: { value: { base: "#075985", _dark: "#7dd3fc" } },
          infoFg: { value: { base: "#ffffff", _dark: "#082f49" } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);

/**
 * 共通コンポーネント recipe。`App.css` の className ベースの見た目
 * (`button` / `input` / `select` / `textarea` など) を Chakra recipe 化したもの。
 * `src/components/ui.tsx` が `chakra(...)` ファクトリでラッパーコンポーネントへ
 * 変換し、後続のコンポーネント移行が `<Button variant="primary">` のように
 * 素の見た目を手書きせず使えるようにする。
 */

/** ボタン。中立 (default) + primary / secondary / ghost / success / warning /
 *  danger / info と、密なツールバー向けの `sm` サイズ。`App.css` の `button` 系
 *  className と一致。 */
export const buttonRecipe = defineRecipe({
  className: "app-button",
  base: {
    font: "inherit",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    px: "12px",
    py: "6px",
    border: "1px solid",
    borderColor: "app.borderStrong",
    bg: "app.surface",
    color: "app.text",
    borderRadius: "md",
    cursor: "pointer",
    transitionProperty: "background, border-color, color, box-shadow, transform",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { bg: "app.hover" },
    "&:active:not(:disabled)": { transform: "translateY(1px)" },
    _focusVisible: { outline: "none", boxShadow: focusRing },
    _disabled: { opacity: 0.5, cursor: "not-allowed" },
  },
  variants: {
    variant: {
      // 中立の浮き出しボタン (App.css の素の `button`)。
      default: {},
      primary: {
        bg: "app.accent",
        color: "app.accentText",
        borderColor: "app.accent",
        _hover: { bg: "app.accentHover", borderColor: "app.accentHover" },
      },
      secondary: {
        bg: "transparent",
        borderColor: "app.borderStrong",
        color: "app.text",
        _hover: { bg: "app.hover" },
      },
      ghost: {
        bg: "transparent",
        borderColor: "transparent",
        color: "app.textSecondary",
        _hover: { bg: "app.hover", color: "app.text" },
      },
      success: {
        bg: "app.successBg",
        color: "app.successFg",
        borderColor: "app.successBg",
        _hover: { bg: "app.successBgHover", borderColor: "app.successBgHover" },
      },
      warning: {
        bg: "app.warningBg",
        color: "app.warningFg",
        borderColor: "app.warningBg",
        _hover: { bg: "app.warningBgHover", borderColor: "app.warningBgHover" },
      },
      danger: {
        bg: "app.dangerBg",
        color: "app.dangerFg",
        borderColor: "app.dangerBg",
        _hover: { bg: "app.dangerBgHover", borderColor: "app.dangerBgHover" },
      },
      info: {
        bg: "app.infoBg",
        color: "app.infoFg",
        borderColor: "app.infoBg",
        _hover: { bg: "app.infoBgHover", borderColor: "app.infoBgHover" },
      },
    },
    size: {
      // 既定サイズは base の padding をそのまま使う。
      md: {},
      // 密なツールバー / モーダルフッタ向け (App.css の `button.btn-sm`)。
      sm: { px: "8px", py: "3px", fontSize: "sm" },
    },
  },
  defaultVariants: {
    variant: "default",
    size: "md",
  },
});

/** テキスト入力。`App.css` の `input` と一致。 */
export const inputRecipe = defineRecipe({
  className: "app-input",
  base: {
    font: "inherit",
    px: "8px",
    py: "6px",
    border: "1px solid",
    borderColor: "app.borderStrong",
    bg: "app.bgInput",
    color: "app.text",
    borderRadius: "md",
    width: "100%",
    _placeholder: { color: "app.textMuted" },
    _focus: { outline: "none", borderColor: "app.accent", boxShadow: focusRing },
  },
});

/** セレクト。`App.css` の `select` と一致 (入力欄と同じ見た目)。 */
export const selectRecipe = defineRecipe({
  className: "app-select",
  base: {
    font: "inherit",
    px: "8px",
    py: "6px",
    border: "1px solid",
    borderColor: "app.borderStrong",
    bg: "app.bgInput",
    color: "app.text",
    borderRadius: "md",
    width: "100%",
    cursor: "pointer",
    _focus: { outline: "none", borderColor: "app.accent", boxShadow: focusRing },
  },
});

/** 複数行テキスト入力。入力系コントロールの見た目を踏襲し、縦リサイズ可能。 */
export const textareaRecipe = defineRecipe({
  className: "app-textarea",
  base: {
    font: "inherit",
    p: "8px",
    border: "1px solid",
    borderColor: "app.borderStrong",
    bg: "app.bgInput",
    color: "app.text",
    borderRadius: "md",
    width: "100%",
    resize: "vertical",
    _placeholder: { color: "app.textMuted" },
    _focus: { outline: "none", borderColor: "app.accent", boxShadow: focusRing },
  },
});

/** チェックボックス。ネイティブ要素を使い、アクセント色へ追従させる。 */
export const checkboxRecipe = defineRecipe({
  className: "app-checkbox",
  base: {
    width: "auto",
    cursor: "pointer",
    accentColor: "app.accent",
    _focusVisible: { outline: "none", boxShadow: focusRing },
  },
});
