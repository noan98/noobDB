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
        xl: { value: "var(--text-xl)" },
      },
      // 縦リズム (#490)。`lineHeight="snug"` / `letterSpacing="wide"` のように
      // 役割名で参照でき、App.css の --leading-* / --tracking-* を正とする。
      lineHeights: {
        tight: { value: "var(--leading-tight)" },
        snug: { value: "var(--leading-snug)" },
        normal: { value: "var(--leading-normal)" },
        relaxed: { value: "var(--leading-relaxed)" },
      },
      letterSpacings: {
        tight: { value: "var(--tracking-tight)" },
        normal: { value: "var(--tracking-normal)" },
        wide: { value: "var(--tracking-wide)" },
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
      // レイヤリング (#500)。`zIndex="popover"` 等の名前で参照でき、App.css の
      // --z-* を正とする。Chakra 既定の zIndex トークン名 (modal/popover/toast/
      // dropdown) を意図的に踏襲し、既存コンポーネントの記述とも揃える。
      zIndex: {
        base: { value: "var(--z-base)" },
        sticky: { value: "var(--z-sticky)" },
        raised: { value: "var(--z-raised)" },
        sidebar: { value: "var(--z-sidebar)" },
        modal: { value: "var(--z-modal)" },
        dropdown: { value: "var(--z-dropdown)" },
        popover: { value: "var(--z-popover)" },
        toast: { value: "var(--z-toast)" },
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
          bgWarning: { value: "var(--bg-warning)" },
          bgInput: { value: "var(--bg-input)" },
          stripe: { value: "var(--bg-stripe)" },
          rowHover: { value: "var(--bg-row-hover)" },
          // テキスト
          text: { value: "var(--text)" },
          textSecondary: { value: "var(--text-secondary)" },
          textMuted: { value: "var(--text-muted)" },
          textNull: { value: "var(--text-null)" },
          textError: { value: "var(--text-error)" },
          textWarning: { value: "var(--text-warning)" },
          textSuccess: { value: "var(--text-success)" },
          // ボーダー
          border: { value: "var(--border)" },
          borderStrong: { value: "var(--border-strong)" },
          borderSubtle: { value: "var(--border-subtle)" },
          // アクセント (接続ごとに動的に変わる)
          accent: { value: "var(--accent)" },
          accentHover: { value: "var(--accent-hover)" },
          accentText: { value: "var(--accent-text)" },
          // 拡張ニュートラル階調 (#476)。0=地, 950=最も濃い文字。テーマ反転は
          // App.css 側で吸収するため、ここは var() ブリッジのみ。
          neutral: {
            0: { value: "var(--neutral-0)" },
            50: { value: "var(--neutral-50)" },
            100: { value: "var(--neutral-100)" },
            200: { value: "var(--neutral-200)" },
            300: { value: "var(--neutral-300)" },
            400: { value: "var(--neutral-400)" },
            500: { value: "var(--neutral-500)" },
            600: { value: "var(--neutral-600)" },
            700: { value: "var(--neutral-700)" },
            800: { value: "var(--neutral-800)" },
            900: { value: "var(--neutral-900)" },
            950: { value: "var(--neutral-950)" },
          },
          // セマンティックカラー体系 (#476)。役割別 (subtle/border/solid/text)。
          //
          // ## カラーブラインド配慮ガイド (赤緑色弱)
          // success(緑) と error(赤) は色相だけでは区別しづらいため、これらを
          // 状態の「唯一の手がかり」にしない。必ず次のいずれかを併用する:
          //   - アイコン (Icon.tsx の check / warning / close など) や形状
          //   - テキストラベル ("成功" / "失敗" / "本番" 等)
          //   - 位置・順序の一貫性
          // 色は強調の補助に留める。info(青) / warning(橙) は緑赤と弁別しやすい
          // ため軸として有効だが、同様にラベル併用を推奨する。
          info: {
            subtle: { value: "var(--info-subtle)" },
            border: { value: "var(--info-border)" },
            solid: { value: "var(--info-solid)" },
            text: { value: "var(--info-text)" },
          },
          success: {
            subtle: { value: "var(--success-subtle)" },
            border: { value: "var(--success-border)" },
            solid: { value: "var(--success-solid)" },
            text: { value: "var(--success-text)" },
          },
          warning: {
            subtle: { value: "var(--warning-subtle)" },
            border: { value: "var(--warning-border)" },
            solid: { value: "var(--warning-solid)" },
            text: { value: "var(--warning-text)" },
          },
          error: {
            subtle: { value: "var(--error-subtle)" },
            border: { value: "var(--error-border)" },
            solid: { value: "var(--error-solid)" },
            text: { value: "var(--error-text)" },
          },
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
            warning: { value: "var(--status-warning)" },
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
        // レイヤ別エレベーション (#500)。`shadow="elevationModal"` のように参照する。
        elevationRaised: { value: "var(--elevation-raised)" },
        elevationPopover: { value: "var(--elevation-popover)" },
        elevationToast: { value: "var(--elevation-toast)" },
        elevationModal: { value: "var(--elevation-modal)" },
      },
      // カラー付きボタンはライト/ダークで別々の固定色を使い (App.css でも CSS 変数を
      // 経由しない)、単純な var() ブリッジでは表現できないため、ここで `_dark` 条件付き
      // の値として定義する。
      //
      // WCAG AA 検証 (#326): ボタン文字 (前景) と背景のコントラストが通常テキスト
      // 基準 (4.5:1) を満たすように調整した。下記コメントの比率は前景/背景の実測値。
      //   - success(light): 旧 #16a34a+白 は 3.30:1 で未達 → 背景を #15803d に暗くして 5.02:1。
      //   - warning(light): #d97706+白 は 3.19:1 で、白では AA に届く暗さにすると琥珀色が
      //     失われるため、前景を濃色 #2a1707 に変更 (琥珀の地色は維持) して 5.39:1。
      //   - danger(dark):   旧 #ef4444+白 は 3.76:1 で未達 → 背景を #dc2626 に暗くして 4.83:1。
      // それ以外 (success dark 6.54 / warning dark 7.99 / danger light 4.83 / info 両 >=5.9) は
      // 既に AA を満たしていたため据え置き。hover 色も同基準を満たす値に揃えた。
      colors: {
        app: {
          successBg: { value: { base: "#15803d", _dark: "#22c55e" } }, // 白文字 5.02:1 / 濃文字側 6.54:1
          successBgHover: { value: { base: "#166534", _dark: "#4ade80" } },
          successFg: { value: { base: "#ffffff", _dark: "#052e16" } },
          warningBg: { value: { base: "#d97706", _dark: "#f59e0b" } },
          warningBgHover: { value: { base: "#cf7008", _dark: "#fbbf24" } }, // 濃文字 4.88:1
          warningFg: { value: { base: "#2a1707", _dark: "#2a1707" } }, // 琥珀地に濃文字 5.39:1
          dangerBg: { value: { base: "#dc2626", _dark: "#dc2626" } }, // 白文字 4.83:1
          dangerBgHover: { value: { base: "#b91c1c", _dark: "#b91c1c" } }, // 白文字 6.47:1
          dangerFg: { value: { base: "#ffffff", _dark: "#ffffff" } },
          infoBg: { value: { base: "#0369a1", _dark: "#38bdf8" } }, // 白 5.93 / 濃 6.48
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
 *  danger / info と、密なツールバー向けの `sm` サイズ。
 *
 *  ## variant 使い分け規約 (#283)
 *
 *  破壊的操作と安全な操作を見た目で区別し、誤操作を視覚的に防ぐためのルール。
 *  新規ボタン追加時もこの表に従う。
 *
 *  | 用途                                       | variant      |
 *  | ------------------------------------------ | ------------ |
 *  | 主要アクション (Save / Connect / Execute)  | `primary`    |
 *  | 破壊的アクション (削除 / Drop / Clear)     | `danger`     |
 *  | 警告付き実行 (危険クエリ承認 / 中断)       | `warning`    |
 *  | 成功確定 (セル編集 Apply など)             | `success`    |
 *  | キャンセル / 閉じる (モーダル・フォーム)   | `secondary`  |
 *  | アイコン専用 (X / メニューの ✕ など)       | `ghost`      |
 *  | 中立 (Test / Refresh / Browse など)        | `default`    |
 *
 *  右クリックメニューの破壊的項目は `ContextMenu` の `danger: true` で同色に揃える。 */
export const buttonRecipe = defineRecipe({
  className: "app-button",
  base: {
    font: "inherit",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    // 余白はフォントスケール (--font-scale) に追従させ、大きいフォント設定でも
    // ラベルがボタンからはみ出さず比率を保つ (#327)。
    gap: "calc(6px * var(--font-scale))",
    px: "calc(12px * var(--font-scale))",
    py: "calc(6px * var(--font-scale))",
    border: "1px solid",
    borderColor: "app.borderStrong",
    bg: "app.surface",
    color: "app.text",
    borderRadius: "md",
    cursor: "pointer",
    // ボタン本文を 1 行で保持し、Flex の主軸が狭くなったときに CJK の
    // 文字単位折り返し (「参照…」が縦書きになる現象) を防ぐ。
    whiteSpace: "nowrap",
    // 同じく、Input (width: 100%) と Flex の中に並んだときに min-content まで
    // 圧縮されないようにし、ボタンは常に内容幅を保つ (Input 側が縮む)。
    flexShrink: 0,
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
      // 密なツールバー / モーダルフッタ向け (App.css の `button.btn-sm`)。余白は #327 で
      // フォントスケール追従に変更。
      sm: {
        px: "calc(8px * var(--font-scale))",
        py: "calc(3px * var(--font-scale))",
        fontSize: "sm",
      },
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
    // 余白はフォントスケール追従 (#327)。
    px: "calc(8px * var(--font-scale))",
    py: "calc(6px * var(--font-scale))",
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
    // 余白はフォントスケール追従 (#327)。
    px: "calc(8px * var(--font-scale))",
    py: "calc(6px * var(--font-scale))",
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
    // 余白はフォントスケール追従 (#327)。
    p: "calc(8px * var(--font-scale))",
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
