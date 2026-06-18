import { chakra, Flex, type HTMLChakraProps } from "@chakra-ui/react";
import { useId } from "react";

/**
 * ブランドビジュアルアイデンティティの単一の出所 (#619)。
 *
 * アプリアイコン (`src-tauri/icons/`) は「noobDB の頭文字 *n* を象ったアーチが
 * データベースのシリンダを抱える」モチーフを青→紫グラデーションで描く。これまで
 * タイトルバーには無関係なマスコット SVG がインラインで埋まっており、インストール
 * 済みアイコンと**ブランドがちぐはぐ**だった。ここに正となるロゴマーク (`BrandMark`)
 * とワードマーク (`Wordmark` / `BrandLockup`) を集約し、タイトルバー・スプラッシュ・
 * 将来のオンボーディングが同じマークを参照できるようにする。
 *
 * ## 配色方針
 *
 * - ブランドカラーはテーマ (light/dark) を跨いで**固定** (`App.css` の `--brand-*`、
 *   下の定数とも一致)。アクセント色 (`--accent`、接続ごとに動的) とは独立で、第一
 *   印象を環境差で揺らさない。
 * - マークは自己完結した塗り (グラデーションのアーチ + 明色のシリンダ) を持つため、
 *   light/dark どちらのサーフェス上でも破綻しない。`tone="mono"` は周囲の文字色
 *   (`currentColor`) 1 色で描き、低彩度な文脈 (ローディングのインライン等) で使う。
 *
 * 依存ライブラリは増やさず SVG を直接持つ (`illustrations.tsx` と同じ方針)。
 */

/** ブランド基調色。`App.css` の `--brand-*` と一致させる (二重定義の検証は
 *  `brand.test.ts`)。フロントの純ロジック/テストから参照できるよう定数化する。 */
export const BRAND_BLUE = "#3b82f6";
export const BRAND_INDIGO = "#4f6bf6";
export const BRAND_VIOLET = "#8b5cf6";

/** ブランドグラデーションの停止色 (青→紫)。`BrandMark` のアーチ塗りに使う。 */
export const BRAND_GRADIENT_STOPS: readonly [string, string] = [BRAND_BLUE, BRAND_VIOLET];

/** マークの描画トーン。 */
export type BrandTone = "brand" | "mono";

export interface BrandMarkProps extends Omit<HTMLChakraProps<"svg">, "css"> {
  /** 一辺のピクセルサイズ (正方形)。既定 24。 */
  size?: number;
  /**
   * `"brand"` (既定): 青→紫グラデーションのアーチ + 明色シリンダのフルカラー。
   * `"mono"`: すべて `currentColor` 1 色 (周囲の文字色を継承)。
   */
  tone?: BrandTone;
}

/**
 * ブランドロゴマーク。noobDB の *n* を象ったアーチがデータベースシリンダを抱える
 * 図像で、アプリアイコンを平面化した正となるベクタ。`size` でスケールし、`tone` で
 * フルカラー / モノクロを切り替える。装飾用途のため既定で `aria-hidden`。
 */
export function BrandMark({ size = 24, tone = "brand", ...rest }: BrandMarkProps) {
  // グラデーション ID はインスタンスごとに一意でないと、同一ページに複数の
  // BrandMark がある場合に SVG の id 衝突で塗りが壊れる。React の useId で隔離する。
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arch = tone === "brand" ? `url(#${gid}-arch)` : "currentColor";
  // シリンダ面。brand は淡い水色面 + 濃紺の輪郭、mono は地を抜いて currentColor の線画。
  const discFill = tone === "brand" ? "#eaf2ff" : "none";
  const discStroke = tone === "brand" ? "#1e3a8a" : "currentColor";

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
      {tone === "brand" && (
        <defs>
          <linearGradient id={`${gid}-arch`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={BRAND_BLUE} />
            <stop offset="100%" stopColor={BRAND_VIOLET} />
          </linearGradient>
        </defs>
      )}
      {/* n のアーチ (∩): 太い丸ストロークの反転 U。左脚=青寄り、右脚=紫寄りへ
          グラデーションが流れる。データベースを「抱える」シルエット。 */}
      <path
        d="M11 41 L11 23 A13 13 0 0 1 37 23 L37 41"
        fill="none"
        stroke={arch}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* アーチが抱えるデータベースシリンダ (3 段)。 */}
      <g stroke={discStroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
        {/* 胴体 (上楕円の縁から下楕円まで) */}
        <path
          d="M17 21 L17 33 A7 3.2 0 0 0 31 33 L31 21"
          fill={discFill}
        />
        {/* 天面の楕円 */}
        <ellipse cx="24" cy="21" rx="7" ry="3.2" fill={discFill} />
        {/* 段の区切り */}
        <path d="M17 25 A7 3.2 0 0 0 31 25" fill="none" />
        <path d="M17 29 A7 3.2 0 0 0 31 29" fill="none" />
      </g>
      {/* 左上のスパーク (アイコンと同じ「きらめき」。brand はブランド青、mono は線色)。 */}
      <path
        d="M12 9 L13.4 12.6 L17 14 L13.4 15.4 L12 19 L10.6 15.4 L7 14 L10.6 12.6 Z"
        fill={tone === "brand" ? BRAND_BLUE : "currentColor"}
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
      letterSpacing="-0.01em"
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
