import { chakra, Flex, type HTMLChakraProps } from "@chakra-ui/react";
import { useId } from "react";

/**
 * ブランドビジュアルアイデンティティの単一の出所 (#619)。
 *
 * ロゴマーク「n Tunnel」は、紺の角丸タイルに白い小文字 *n* を置き、ティールの
 * 横線 (トンネル) が *n* の右脚を突き抜ける図像。noobDB の頭文字と、SSH トンネルを
 * ファーストクラスで扱うことを 1 つのマークで表す。アプリアイコン (`src-tauri/icons/`)
 * ・favicon (`public/brand-icon.svg`) ・画面内のマーク (`BrandMark`) は同じ
 * ジオメトリ (viewBox 0 0 48 48) と色を持つ。ここに正となるロゴマーク (`BrandMark`)
 * とワードマーク (`Wordmark` / `BrandLockup`) を集約し、タイトルバー・スプラッシュ・
 * ウェルカム画面が同じマークを参照できるようにする。
 *
 * ## 配色方針
 *
 * - ブランドカラーは navy / navy-raised / teal の 3 色で、テーマを跨いで**固定**
 *   (`App.css` の `--brand-*`、下の定数とも一致)。アクセント色 (`--accent`、接続ごと
 *   に動的) とは独立で、第一印象を環境差で揺らさない。
 * - タイルの色だけはテーマで切り替える: 明るい地では navy、ダーク系プリセットでは
 *   一段明るい navy-raised (`--brand-mark-tile`)。暗い面に沈ませないため。
 * - 横線の縁取りはタイル色と同じにして、*n* の脚との間に隙間を見せる。
 * - teal はロゴの横線やブランド面の小さなアクセント専用で、文字色には使わない。
 * - `tone="mono"` は周囲の文字色 (`currentColor`) 1 色でタイルを塗り、*n* と横線を
 *   マスクで抜く。低彩度な文脈 (ローディングのインライン等) で使う。
 *
 * 依存ライブラリは増やさず SVG を直接持つ (`illustrations.tsx` と同じ方針)。
 */

/** ブランド基調色。`App.css` の `--brand-*` と一致させる (二重定義の検証は
 *  `brand.test.ts`)。フロントの純ロジック/テストから参照できるよう定数化する。 */
export const BRAND_NAVY = "#12355b";
export const BRAND_NAVY_RAISED = "#1d4a7a";
export const BRAND_TEAL = "#2dd4bf";

/** ブランドグラデーションの停止色 (navy-raised → teal)。`--brand-gradient` と一致。 */
export const BRAND_GRADIENT_STOPS: readonly [string, string] = [BRAND_NAVY_RAISED, BRAND_TEAL];

/** ロゴのジオメトリ (viewBox 0 0 48 48)。favicon / アプリアイコンと同じ数値で、
 *  変えるときは素材側も揃えること。 */
const TILE = { x: 3, y: 3, size: 42, rx: 10 } as const;
const N_PATH = "M14 35 V22 A8 8 0 0 1 30 22 V35";
const N_STROKE = 5.5;
const BAR = { x: 19, y: 24.75, width: 16, height: 5, rx: 2.5, stroke: 2 } as const;

/** マークの描画トーン。 */
export type BrandTone = "brand" | "mono";

export interface BrandMarkProps extends Omit<HTMLChakraProps<"svg">, "css"> {
  /** 一辺のピクセルサイズ (正方形)。既定 24。 */
  size?: number;
  /**
   * `"brand"` (既定): 紺のタイル + 白い *n* + ティールの横線のフルカラー。
   * `"mono"`: タイルを `currentColor` で塗り、*n* と横線を抜いた 1 色 (周囲の文字色を継承)。
   */
  tone?: BrandTone;
}

/**
 * ブランドロゴマーク「n Tunnel」。アプリアイコンを平面化した正となるベクタで、
 * `size` でスケールし、`tone` でフルカラー / モノクロを切り替える。装飾用途のため
 * 既定で `aria-hidden`。
 */
export function BrandMark({ size = 24, tone = "brand", ...rest }: BrandMarkProps) {
  // マスク ID はインスタンスごとに一意でないと、同一ページに複数の BrandMark が
  // ある場合に SVG の id 衝突で抜きが壊れる。React の useId で隔離する。
  const mid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tile = "var(--brand-mark-tile)";

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
      {tone === "brand" ? (
        <>
          <rect x={TILE.x} y={TILE.y} width={TILE.size} height={TILE.size} rx={TILE.rx} fill={tile} />
          {/* 小文字 n */}
          <path d={N_PATH} fill="none" stroke="#ffffff" strokeWidth={N_STROKE} />
          {/* n の右脚を突き抜けるトンネル。縁取りをタイル色にして脚との隙間を見せる。 */}
          <rect
            x={BAR.x}
            y={BAR.y}
            width={BAR.width}
            height={BAR.height}
            rx={BAR.rx}
            fill="var(--brand-teal)"
            stroke={tile}
            strokeWidth={BAR.stroke}
          />
        </>
      ) : (
        <>
          <defs>
            {/* 白 = 残す、黒 = 抜く。n と横線の本体を抜き、横線の縁取りだけは白
                (タイル色) で塗り戻して、brand と同じく脚との隙間を見せる。 */}
            <mask id={`${mid}-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
              <rect x={TILE.x} y={TILE.y} width={TILE.size} height={TILE.size} rx={TILE.rx} fill="#ffffff" />
              <path d={N_PATH} fill="none" stroke="#000000" strokeWidth={N_STROKE} />
              <rect
                x={BAR.x}
                y={BAR.y}
                width={BAR.width}
                height={BAR.height}
                rx={BAR.rx}
                fill="#000000"
                stroke="#ffffff"
                strokeWidth={BAR.stroke}
              />
            </mask>
          </defs>
          <rect
            x={TILE.x}
            y={TILE.y}
            width={TILE.size}
            height={TILE.size}
            rx={TILE.rx}
            fill="currentColor"
            mask={`url(#${mid}-cut)`}
          />
        </>
      )}
    </chakra.svg>
  );
}

export interface WordmarkProps extends Omit<HTMLChakraProps<"span">, "css"> {
  /**
   * 旧デザインの "noob"(控えめ) + "DB"(強調) のツートーン表現。互換のため残して
   * いるが、新デザインの既定は単色 (false)。
   */
  twoTone?: boolean;
}

/**
 * "noobDB" ワードマーク。太さ 650・字間 -0.015em の単色で、文字色は
 * `--brand-wordmark` (明るいテーマで navy、ダーク系で本文色) に従う。
 */
export function Wordmark({ twoTone = false, ...rest }: WordmarkProps) {
  return (
    <chakra.span
      fontWeight="650"
      letterSpacing="var(--brand-wordmark-tracking)"
      lineHeight="1"
      whiteSpace="nowrap"
      color="var(--brand-wordmark)"
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
