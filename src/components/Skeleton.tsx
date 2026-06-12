import { chakra } from "@chakra-ui/react";

/**
 * スケルトン UI プリミティブ。
 *
 * ## 使い分けガイド (ローディング / 空 / エラーの 3 状態)
 *
 * ```
 * 状態         コンポーネント       用途
 * ──────────   ────────────────────  ──────────────────────────────────────────
 * ロード中     Skeleton /            構造の予兆を示しつつデータ到着を待つ。
 *              SkeletonRow           初回ロード時・遅延フェッチ中に使う。
 * 空 / エラー  EmptyState            クエリ結果 0 件・DB 接続なし・エラー詳細
 *                                    など「確定した状態」を人間向けに伝える。
 * 操作結果     Toast (useToast)      コピー完了・Apply 成功など短命の通知。
 * ```
 *
 * ## 強制レベル
 * - スケルトンはあくまで **視覚的なプレースホルダ** で、ロード完了後に実データへ
 *   差し替わる。アクセシビリティのため `aria-hidden` で支援技術からは隠す。
 *
 * ## `prefers-reduced-motion` 対応
 * シマーアニメーション (`skeleton-shimmer`) は `App.css` 末尾の
 * `@media (prefers-reduced-motion: reduce)` ルールで `animation-duration: 0.01ms`
 * に上書きされ、実質静止する (他の keyframe と同方式)。
 *
 * @public
 */

/** 1 行スケルトンプリミティブ。幅・高さを props で制御する。
 *
 *  シマーは `skeleton-shimmer` keyframe (App.css) で実装済みで、
 *  `prefers-reduced-motion` では静止する。テーマの `--bg-muted` /
 *  `--bg-elevated` トークンを使うのでライト/ダーク切替に自動追従する。
 */
export const Skeleton = chakra("div", {
  base: {
    borderRadius: "2px",
    background:
      "linear-gradient(90deg, var(--bg-muted) 25%, var(--bg-elevated) 50%, var(--bg-muted) 75%)",
    backgroundSize: "200% 100%",
    animation: "skeleton-shimmer 1.4s ease-in-out infinite",
  },
});

/** ツリーノード行サイズのスケルトン行。ConnectionList の遅延ロード表示に使う。
 *
 *  `Skeleton` と同じシマーアニメーションを持つが、ツリー行の高さ (22px) に
 *  合わせて縦余白を確保し、インデント付きで並べやすい形に整えてある。
 *  `aria-hidden` はレンダリング側で付与すること。
 */
export const SkeletonRow = chakra("div", {
  base: {
    height: "22px",
    mx: "4px",
    my: "3px",
    borderRadius: "var(--radius-sm, 4px)",
    background:
      "linear-gradient(90deg, var(--bg-muted) 25%, var(--bg-elevated) 50%, var(--bg-muted) 75%)",
    backgroundSize: "200% 100%",
    animation: "skeleton-shimmer 1.4s ease-in-out infinite",
  },
});
