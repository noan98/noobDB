/**
 * 意味色 (semantic color) トークンの解決ロジック (#664)。
 *
 * success / warning / danger / info という 4 つの状態を、UI 全体
 * (トースト・アラート・バッジ・確認ダイアログ・フォームバリデーションなど) が
 * 一貫した名前で参照できるようにするための純粋なマッピング層。
 *
 * ## Source of truth は CSS 変数
 *
 * 実際の色値は `App.css` の `--{info,success,warning,error}-{subtle,border,solid,text}`
 * (#476 で導入、#664 で全テーマプリセットにフル定義) が正であり、このファイルは
 * **色の値を一切持たない**。テーマ切替 (`data-theme` 属性) によるカスケードは
 * ブラウザの CSS エンジンに任せ、ここでは「意味役割 (role) × 段階 (tier) →
 * CSS 変数名 / Chakra トークンパス」という名前解決だけを行う。これにより
 * CSS 変数と TS 定数が二重に色を持つ状態を避ける (乖離検出は
 * `__tests__/semanticColors.test.ts` が `App.css` を `?raw` で読み込み、
 * このモジュールが指す変数名が実在することを確認する形で行う)。
 *
 * ## 命名: danger vs error
 *
 * UI 上の意味役割としては success/warning/danger/info の 4 種 (Issue #664) だが、
 * 既存の CSS 変数・Chakra セマンティックトークン (`theme.ts`) は #476 から
 * `error` という名前を使っている (`--error-*` / `app.error.*`)。ここでは
 * 呼び出し側から見た命名を `danger` に統一しつつ、内部で `error` の変数/
 * トークンへマッピングすることで、既存 CSS 変数の破壊的リネーム (影響範囲が
 * 全プリセット × 全参照箇所に及ぶ) を避けつつ、意味役割としては
 * success/warning/danger/info の 4 語で一貫させる。
 *
 * ## 段階 (tier) の使い分け
 *
 * - `subtle` : 淡い面塗り背景 (バナー/アラート/淡色バッジの地)。
 * - `border` : `subtle` 地と調和する境界線。
 * - `solid`  : 塗りつぶしボタン/ドット等のベタ塗り (白文字が AA を満たす保証は
 *              ライト/ダーク 2 値の `app.{success,warning,danger,info}Bg` /
 *              `*Fg` 側にあり、`solid` 自体は主にボーダー/リング/インジケータ用)。
 * - `text`   : 通常背景 (`--bg` / `--bg-elevated`) の上で AA (>=4.5:1) を満たす
 *              文字色。バッジ/トーストのアイコン・アクセント色にも使える。
 *
 * `subtle` + `text` の組み合わせは、バナー/アラート用途で全テーマプリセットに
 * わたり WCAG AA を満たすことを `__tests__/themeContrast.test.ts` が固定する。
 */

/** UI が伝える状態の意味役割。 */
export type SemanticRole = "success" | "warning" | "danger" | "info";

/** 意味役割ごとの段階 (強調度)。 */
export type SemanticTier = "subtle" | "border" | "solid" | "text";

/** 反復処理の単一ソース。新しい役割/段階を追加するときはここに足す。 */
export const SEMANTIC_ROLES: readonly SemanticRole[] = [
  "success",
  "warning",
  "danger",
  "info",
];

export const SEMANTIC_TIERS: readonly SemanticTier[] = [
  "subtle",
  "border",
  "solid",
  "text",
];

/**
 * role → CSS 変数 / Chakra トークンの名前空間名。
 * `danger` だけ既存の `error` 系トークンへマップする (上記コメント参照)。
 */
const CSS_FAMILY: Record<SemanticRole, string> = {
  success: "success",
  warning: "warning",
  danger: "error",
  info: "info",
};

/**
 * `var(--{family}-{tier})` を返す。inline style や `color-mix()` の引数など、
 * CSS 変数の生の参照が必要な箇所で使う。
 */
export function semanticColorVar(role: SemanticRole, tier: SemanticTier): string {
  return `var(--${CSS_FAMILY[role]}-${tier})`;
}

/**
 * Chakra の `app.*` セマンティックトークンパス (`color="..."` / `bg="..."` に
 * 渡す文字列) を返す。`theme.ts` の `colors.app.{success,warning,error,info}`
 * (#476) をそのまま指す。
 */
export function semanticColorToken(role: SemanticRole, tier: SemanticTier): string {
  return `app.${CSS_FAMILY[role]}.${tier}`;
}
