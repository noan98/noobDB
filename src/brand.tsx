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
 *
 * ## シグネチャ・アニメーション (#1505)
 *
 * `animate` を付けると、マウント時に 1 回だけ「*n* のストロークが描かれ、ティールの
 * 横線が左からタイルの内側を滑って *n* の右脚を貫き定位置に収まる」動きを再生する。
 * 実装は `App.css` の `.brand-mark-anim` (`@keyframes brand-mark-n-draw` /
 * `brand-mark-bar-slide`、時間は `--dur-med` の倍数。n の描画は線の伸びが見えるよう `--ease`、
 * 横線は `--ease-out`)。CSS に
 * 閉じているので、`prefers-reduced-motion` / アプリ内モーション量設定は末尾の
 * reduced-motion ブロックが即時化し、`hc-*` は `App.css` が静止に上書きする。どちらも
 * 最終フレーム (= 通常の静止ロゴ) で止まるため、再生後や抑制時は他の箇所と同じ見た目。
 * DOM には `clipPath` / `pathLength` などが残るが、再生後の見た目は静的ロゴと同一。
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

export interface BrandMarkProps extends Omit<HTMLChakraProps<"svg">, "css"> {
  /** 一辺のピクセルサイズ (正方形)。既定 24。 */
  size?: number;
  /**
   * マウント時にシグネチャ・アニメーションを 1 回再生する (#1505)。
   * reduced-motion / `hc-*` では再生せず静止表示。既定 false。
   */
  animate?: boolean;
}

/**
 * ブランドロゴマーク「n Tunnel」。アプリアイコンを平面化した正となるベクタで、
 * `size` でスケールする。紺のタイル + 白い *n* + ティールの横線のフルカラー。
 * 装飾用途のため既定で `aria-hidden`。
 */
export function BrandMark({ size = 24, animate = false, className, ...rest }: BrandMarkProps) {
  // マスク ID はインスタンスごとに一意でないと、同一ページに複数の BrandMark が
  // ある場合に SVG の id 衝突で抜きが壊れる。React の useId で隔離する。
  const mid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tile = "var(--brand-mark-tile)";
  const play = animate;

  return (
    <chakra.svg
      viewBox="0 0 48 48"
      width={`${size}px`}
      height={`${size}px`}
      display="block"
      flexShrink={0}
      aria-hidden
      role="img"
      className={play ? [className, "brand-mark-anim"].filter(Boolean).join(" ") : className}
      {...rest}
    >
      <rect x={TILE.x} y={TILE.y} width={TILE.size} height={TILE.size} rx={TILE.rx} fill={tile} />
      {play && (
        <defs>
          {/* 横線がタイルの外へはみ出して見えないよう、滑走中はタイル形で切り抜く。 */}
          <clipPath id={`${mid}-tile`}>
            <rect x={TILE.x} y={TILE.y} width={TILE.size} height={TILE.size} rx={TILE.rx} />
          </clipPath>
        </defs>
      )}
      {/* 小文字 n。animate 時は pathLength=1 に正規化し、ストロークを描き進める。 */}
      <path
        d={N_PATH}
        fill="none"
        stroke="#ffffff"
        strokeWidth={N_STROKE}
        className={play ? "brand-mark-n" : undefined}
        pathLength={play ? 1 : undefined}
      />
      {/* n の右脚を突き抜けるトンネル。縁取りをタイル色にして脚との隙間を見せる。 */}
      <g clipPath={play ? `url(#${mid}-tile)` : undefined}>
        <rect
          x={BAR.x}
          y={BAR.y}
          width={BAR.width}
          height={BAR.height}
          rx={BAR.rx}
          fill="var(--brand-teal)"
          stroke={tile}
          strokeWidth={BAR.stroke}
          className={play ? "brand-mark-bar" : undefined}
        />
      </g>
    </chakra.svg>
  );
}

export type WordmarkProps = Omit<HTMLChakraProps<"span">, "css">;

/**
 * "noobDB" ワードマーク。太さ 650・字間 -0.015em の単色で、文字色は
 * `--brand-wordmark` (明るいテーマで navy、ダーク系で本文色) に従う。
 */
export function Wordmark(props: WordmarkProps) {
  return (
    <chakra.span
      fontWeight="650"
      letterSpacing="var(--brand-wordmark-tracking)"
      lineHeight="1"
      whiteSpace="nowrap"
      color="var(--brand-wordmark)"
      css={{ userSelect: "none" }}
      {...props}
    >
      noobDB
    </chakra.span>
  );
}

export interface BrandLockupProps {
  /** マークのピクセルサイズ。既定 28。 */
  markSize?: number;
  /** ワードマークのフォントサイズ (CSS 長さ)。既定 "var(--text-lg)"。 */
  wordSize?: string;
  /** マークとワードマークの間隔 (Chakra spacing トークン)。既定 "2.5"。 */
  gap?: string;
  /** マウント時にマークのシグネチャ・アニメーションを 1 回再生する (`BrandMark` の `animate`)。既定 false。 */
  animate?: boolean;
}

/**
 * マーク + ワードマークの横並びロックアップ。スプラッシュやヘッダなど、ブランドを
 * まとまりとして見せたい箇所で使う。
 */
export function BrandLockup({
  markSize = 28,
  wordSize = "var(--text-lg)",
  gap = "2.5",
  animate = false,
}: BrandLockupProps) {
  return (
    <Flex align="center" gap={gap}>
      <BrandMark size={markSize} animate={animate} />
      <Wordmark fontSize={wordSize} />
    </Flex>
  );
}
