import { DENSITY_ORDER, type Density } from "./settings";

/**
 * UI 密度 (Compact/Normal/Spacious) 切替の遷移演出 (#1023)。
 *
 * `App.css` の `--density-row-h` / `--density-cell-py` / `--density-cell-px` /
 * `--density-control-scale` は `:root[data-density="..."]` で瞬時に上書きされる
 * ため、素のままだとグリッドと全コントロールが一斉に硬くスナップする。CSS
 * カスタムプロパティ自体は `@property` を宣言しない限りアニメーションできない
 * (`App.css` の該当コメント参照) ため、値の変化そのものを補間するのではなく、
 * **値が変わった瞬間だけ** ごく短い scale + opacity の「馴染ませ」アニメーション
 * (`density-settle-grow` / `density-settle-shrink`、`App.css` の keyframes) を
 * 対象要素へ 1 回だけ重ねて、遷移がズームのように読めるようにする。
 *
 * このアニメーションは `transform`/`opacity` のみの compositor アニメーション
 * であり、実レイアウト (行の高さ・パディングなどの box メトリクス) 自体は
 * 従来どおり瞬時に確定させる。そのため結果グリッドの仮想スクロール位置
 * (`ResultGrid` の `rowVirtualizer`)・ピン留め列・`<tfoot>` 集計行の実測サイズと
 * 描画がズレて「ガタつく」ことがない — 見た目の滑らかさは実寸を継続的に
 * 補間することではなく、変化の瞬間に短い視覚的アクセントを重ねることで
 * 演出している。
 *
 * 常時 `transition` を掛けるのではなく、密度が実際に変わった瞬間だけ
 * `<html>` (`document.documentElement`) に一時的な属性
 * (`DENSITY_TRANSITION_ATTR`) を立てて `App.css` / `ResultGrid.tsx` の
 * `GRID_CSS` 側のスコープ付きルールを有効化し、`DENSITY_TRANSITION_MS` 経過後に
 * 自動で外す (`App.tsx` がこのモジュールの `densityTransitionDirection` を
 * 使って実装する)。属性が立っていない通常時は該当セレクタが一切マッチしない
 * ため、数万行のグリッドであっても定常状態のコストは増えない。
 *
 * reduced-motion (`data-motion="reduced"` または OS の
 * `prefers-reduced-motion: reduce`) 時は、`App.css` 既存の
 * `:root:not([data-motion="full"]) *` / `:root[data-motion="reduced"] *`
 * ブロックが `animation-duration` を `!important` で 0.01ms に潰すため、この
 * モジュール・keyframes 側で reduced-motion 専用の分岐を重複定義する必要は
 * ない (既存ブロックがそのまま抑制する)。
 */

/** 遷移演出の間だけ `document.documentElement` に立てる属性名。値は
 *  `DensityTransitionDirection` ("grow" | "shrink")。CSS 側は値を問わず属性の
 *  有無だけで判定するセレクタ (`[data-density-transition]`) と、方向別に
 *  異なる keyframes を選ぶセレクタ (`[data-density-transition="grow"]` 等) の
 *  両方で参照する。 */
export const DENSITY_TRANSITION_ATTR = "data-density-transition";

/** 遷移演出の属性を維持する時間 (ms)。`App.css` 側の keyframes duration
 *  (既定 `--dur-med` = 200ms) より少し長く取り、アニメーションの完了を確実に
 *  属性除去より前に収める。この定数だけを変えればタイムアウト側は追従する
 *  (CSS 側の duration は独立した値なので、大きく変える場合は両方揃えること)。 */
export const DENSITY_TRANSITION_MS = 260;

export type DensityTransitionDirection = "grow" | "shrink";

/**
 * 直前の密度 (`prev`) と次の密度 (`next`) を比較し、遷移演出を発火すべきかと
 * その向きを返す。`null` は「発火しない」を意味し、次の 2 ケースに限る:
 * - 初回マウント (`prev === null`) — 起動時に毎回フラッシュしないため。
 * - 同じ値への再設定 (`prev === next`) — 密度以外の設定変更のたびに誤発火
 *   しないよう、呼び出し側はこの関数の結果だけを見て判定すればよい。
 *
 * 向きは `DENSITY_ORDER` (compact < normal < spacious) 上の位置関係で決まる —
 * より余裕のある (行が高くなる) プリセットへ動くときは "grow"、より詰まった
 * プリセットへ動くときは "shrink"。
 */
export function densityTransitionDirection(
  prev: Density | null,
  next: Density,
): DensityTransitionDirection | null {
  if (prev === null || prev === next) return null;
  return DENSITY_ORDER.indexOf(next) > DENSITY_ORDER.indexOf(prev) ? "grow" : "shrink";
}
