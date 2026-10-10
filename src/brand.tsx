import { chakra, Flex, type HTMLChakraProps } from "@chakra-ui/react";

/**
 * ブランドビジュアルアイデンティティの単一の出所 (#619)。
 *
 * ロゴマークは「角丸の紺の地に、noobDB の頭文字 *n* を白い太線で描き、右脚に
 * ティールのバーを差し込む」図像。アプリアイコン (`src-tauri/icons/`) ・favicon
 * (`public/brand-icon.svg`) ・画面内のマーク (`BrandMark`) が同じ形と色を持つ。
 * ここに正となるロゴマーク (`BrandMark`) とワードマーク (`Wordmark` /
 * `BrandLockup`) を集約し、タイトルバー・スプラッシュ・ウェルカム画面が同じマークを
 * 参照できるようにする。
 *
 * ## 配色方針
 *
 * - マークの地色 (`--brand-mark-bg`) はライト系で濃紺、ダーク系テーマ
 *   (`data-theme` が "dark" で終わる) では一段明るい紺に切り替え、暗い面に沈ませない。
 *   差し色のティール (`--brand-mark-accent`) はテーマを跨いで固定。
 * - 青→紫のブランドグラデーション (`--brand-*`) はマークとは独立に、ヒーロー背景・
 *   サンドボックス帯などの面の装飾に使い続ける (テーマを跨いで固定)。
 * - `tone="mono"` は周囲の文字色 (`currentColor`) 1 色で描き、低彩度な文脈
 *   (ローディングのインライン等) で使う。
 *
 * 依存ライブラリは増やさず SVG を直接持つ (`illustrations.tsx` と同じ方針)。
 */

/** ブランド基調色。`App.css` の `--brand-*` と一致させる (二重定義の検証は
 *  `brand.test.ts`)。フロントの純ロジック/テストから参照できるよう定数化する。 */
export const BRAND_BLUE = "#3b82f6";
export const BRAND_INDIGO = "#4f6bf6";
export const BRAND_VIOLET = "#8b5cf6";

/** ブランドグラデーションの停止色 (青→紫)。ヒーロー背景などの面の装飾に使う。 */
export const BRAND_GRADIENT_STOPS: readonly [string, string] = [BRAND_BLUE, BRAND_VIOLET];

/** ロゴマークの地色 (ライト系) / ダーク系テーマでの地色 / 差し色 (ティール)。
 *  `App.css` の `--brand-mark-*` と favicon に一致させる (`brand.test.ts`)。 */
export const BRAND_MARK_BG = "#12355b";
export const BRAND_MARK_BG_DARK = "#1d4a7a";
export const BRAND_MARK_ACCENT = "#2dd4bf";

/** マークの描画トーン。 */
export type BrandTone = "brand" | "mono";

export interface BrandMarkProps extends Omit<HTMLChakraProps<"svg">, "css"> {
  /** 一辺のピクセルサイズ (正方形)。既定 24。 */
  size?: number;
  /**
   * `"brand"` (既定): 紺の地 + 白い *n* + ティールのバーのフルカラー。
   * `"mono"`: すべて `currentColor` 1 色 (周囲の文字色を継承)。
   */
  tone?: BrandTone;
}

/**
 * ブランドロゴマーク。アプリアイコンを平面化した正となるベクタで、`size` で
 * スケールし、`tone` でフルカラー / モノクロを切り替える。装飾用途のため既定で
 * `aria-hidden`。
 */
export function BrandMark({ size = 24, tone = "brand", ...rest }: BrandMarkProps) {
  const isBrand = tone === "brand";
  const bg = "var(--brand-mark-bg)";

  return (
    <chakra.svg
      viewBox="0 0 48 48"
      width={`${size}px`}
      height={`${size}px`}
      display="block"
      flexShrink={0}
      aria-hidden
      role="img"
      {...rest}
    >
      {/* 角丸の地。mono は塗らずに輪郭だけ描く。 */}
      <rect
        x={isBrand ? 3 : 4}
        y={isBrand ? 3 : 4}
        width={isBrand ? 42 : 40}
        height={isBrand ? 42 : 40}
        rx="10"
        fill={isBrand ? bg : "none"}
        stroke={isBrand ? "none" : "currentColor"}
        strokeWidth={isBrand ? undefined : 2}
      />
      {/* 頭文字 n のアーチ。 */}
      <path
        d="M14 35 V22 A8 8 0 0 1 30 22 V35"
        fill="none"
        stroke={isBrand ? "#ffffff" : "currentColor"}
        strokeWidth="5.5"
      />
      {/* 右脚に差し込むバー。brand は地色の縁取りで脚から切り離して見せる。 */}
      <rect
        x="19"
        y="24.75"
        width="16"
        height="5"
        rx="2.5"
        fill={isBrand ? "var(--brand-mark-accent)" : "currentColor"}
        stroke={isBrand ? bg : "none"}
        strokeWidth={isBrand ? 2 : undefined}
      />
    </chakra.svg>
  );
}

export interface WordmarkProps extends Omit<HTMLChakraProps<"span">, "css"> {
  /** `true` で "noob" を弱く、"DB" を強く出すツートーン表現にする (既定 true)。 */
  twoTone?: boolean;
}

/**
 * "noobDB" ワードマーク。`twoTone` で "noob"(控えめ) + "DB"(強調) の対比を付ける。
 * 文字色はサーフェスのテキスト色を継承するため light/dark に自動追従する。
 */
export function Wordmark({ twoTone = true, ...rest }: WordmarkProps) {
  return (
    <chakra.span
      fontWeight="700"
      letterSpacing="tight"
      lineHeight="1"
      whiteSpace="nowrap"
      css={{ userSelect: "none" }}
      {...rest}
    >
      <chakra.span color={twoTone ? "app.textSecondary" : undefined}>noob</chakra.span>
      <chakra.span color={twoTone ? "app.text" : undefined}>DB</chakra.span>
    </chakra.span>
  );
}

export interface BrandLockupProps {
  /** マークのピクセルサイズ。既定 28。 */
  markSize?: number;
  /** ワードマークのフォントサイズ (CSS 長さ)。既定 "var(--text-lg)"。 */
  wordSize?: string;
  /** マークのトーン。既定 "brand"。 */
  tone?: BrandTone;
  /** マークとワードマークの間隔 (Chakra spacing トークン)。既定 "2.5"。 */
  gap?: string;
}

/**
 * マーク + ワードマークの横並びロックアップ。スプラッシュやヘッダなど、ブランドを
 * まとまりとして見せたい箇所で使う。
 */
export function BrandLockup({
  markSize = 28,
  wordSize = "var(--text-lg)",
  tone = "brand",
  gap = "2.5",
}: BrandLockupProps) {
  return (
    <Flex align="center" gap={gap}>
      <BrandMark size={markSize} tone={tone} />
      <Wordmark fontSize={wordSize} />
    </Flex>
  );
}
